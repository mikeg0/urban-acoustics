# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A city noise-monitoring platform: solar/mic sensor nodes (Raspberry Pi Zero 2 W, or a software simulator) stream live acoustic telemetry to a cloud backend that powers a resident-facing dashboard. Currently a Salt Lake City beta along the State Street corridor; a public petition site lives at https://slcquiet.org/.

> Heads-up: `README.md` is partly stale. It describes an early flat-JSON / "Riverton" / `docker compose up` → `localhost:5173` prototype. The real system is Postgres/TimescaleDB + MinIO + MQTT, fronted by Traefik on `*.dev.conexed.com` (see below). The flat-JSON path still exists but only as the **demo mode** fallback. Trust the code over the README for architecture.

## Repository structure

Four largely independent codebases:

- **`backend/`** — FastAPI API + a separate MQTT ingest worker (both run from one image). Python 3.12.
- **`frontend/`** — Vite 6 / React 18 / TypeScript dashboard SPA, plus static petition/demo pages under `public/<slug>/`.
- **`raspberry-pi-zero-2w/`** — On-device sensor firmware (`urban_acoustics` package). Separate `pyproject.toml`, separate tests.
- **`deploy/quiet-initiative/`** — AWS SAM/CloudFormation + Amplify deploy for the standalone petition site (unrelated to the dashboard stack).

`plans/` holds the phased design docs and per-task specs; `plans/phase-1-contracts.md` is the authoritative design rationale behind `backend/app/contracts.py`.

## Architecture

### Data flow (the core pipeline)
```
sensor / device_sim ──mTLS MQTT──> Mosquitto ──> ingest worker ──> TimescaleDB
                                                       │
                                                       └─ pg NOTIFY ─> FastAPI WebSocket ─> dashboard (live)
```
1. Devices publish telemetry (1 Hz), 1/3-octave spectrogram frames (~10 Hz), and health (1/min) over mTLS to Mosquitto on topics `dev/{device_id}/...`.
2. The **ingest worker** (`app/ingest/mqtt.py`, run as `python -m app.ingest.mqtt`) validates every payload against `app.contracts`, batches writes into Timescale, and emits Postgres `NOTIFY` so the API can fan data out live. Spectrogram frames are both persisted (to `spectrogram_frames`, a hypertable with a 7-day retention policy — see below) **and** pushed live via `NOTIFY`; they aren't kept long-term.
3. The **FastAPI API** (`app/main.py`) serves REST + WebSocket. The live WS subscribes to the `NOTIFY` channel and fans frames out to browsers.
4. **Event audio**: device announces an event over MQTT → `POST /api/v1/events/intent` returns a presigned MinIO URL → device PUTs FLAC bytes → `event/done`. Status machine is `announced → upload_intent_created → uploaded → available` (`available` is marked lazily on first playback-URL request). See `EVENT_STATE_TRANSITIONS` in contracts.

### `app/contracts.py` — the contract spine
Single source of truth for **all** wire schemas (MQTT payloads, REST request/response bodies), MQTT topic templates, event-status transitions, and the authoritative `ENV_VARS` list. Imported by the API, the ingest worker, **and** the device simulator, so any change here ripples across all three. Inbound device→cloud models tolerate unknown fields (`extra="ignore"`); outbound cloud→device models reject them (`extra="forbid"`). When changing a payload or topic, edit this file — don't redefine shapes locally.

### Auth & permissions
- Cookie-based JWT sessions (HttpOnly `access_token`). All frontend fetches use `credentials: 'include'`.
- Authorization checks **permissions, never role strings** (`app/auth/permissions.py`). Roles: `guest` (sees synthetic preview data only) → `member`/`contributor`/`admin` (real data). The permission *string constants* are mirrored in `frontend/src/permissions.ts` — keep the two in lockstep.
- Adding a role requires editing `ROLE_PERMISSIONS` **and** the `users.role` CHECK constraint via a new migration.
- First admin is bootstrapped on startup from `ADMIN_EMAIL`/`ADMIN_PASSWORD` if no admin exists; new signups land as `guest`.

### Database
TimescaleDB (Postgres 16). Tables: `devices`, `device_certs`, `device_health`, `telemetry_db`, `spectrogram_frames`, `spectrogram_annotations`, `events`, `labels`, `cameras`, `users`, plus Alembic's `alembic_version`. `telemetry_db` and `spectrogram_frames` are hypertables (`timescaledb_information.hypertables`) with continuous aggregates for the `1m`/`1h` resolutions exposed by the read APIs. `spectrogram_frames` additionally has a TimescaleDB retention job (`drop_after: 7 days`) — it's short-lived storage for recent playback/annotation, not a permanent archive; older frames only ever existed transiently via the live `NOTIFY` fan-out. Migrations are Alembic (`backend/app/migrations/`, `script_location = app/migrations`) and run automatically via `alembic upgrade head` before uvicorn starts in the compose `command`. Internal storage is `TIMESTAMPTZ`; the API converts to Unix seconds at the wire boundary.

### Demo mode
When `DEMO_MODE=1`, synthetic-data routes mount under `/api/v1/demo` **and** are aliased at legacy `/api/...` paths (`/api/year`, `/api/day/...`, `/ws/live`) so the original prototype frontend keeps working. The synthetic year is generated by `app/seed.py` + `app/data.py` (deterministic mulberry32 PRNG) into `backend/data/`.

### Frontend
`App.tsx` is the top-level router/layout and switches between `preview` (synthetic, guests) and `real` (live device) data modes. `dashboard_adapter.ts` maps backend response shapes to the UI's view models. Spectrograms render via WebAudio/FFT and `react-map-gl`/`maplibre-gl` drive the station map. Settings (palette/threshold/anomaly-sensitivity) persist to `localStorage` via `tweaks.ts`.

## Running & developing

The stack joins an **external** Traefik network (`dev_conexed_com_default`) and is routed at `*.dev.conexed.com`. Only Mosquitto (`8883`) and MinIO (`9000`) publish host ports — the API and frontend are *not* on `localhost:8000`/`5173` under the committed compose file; they're behind Traefik.

```sh
docker compose up            # full stack (backend, ingest, frontend, postgres, mosquitto, minio)
```

Both backend and frontend hot-reload from bind-mounted source (uvicorn `--reload`, Vite HMR).

### Python runs in Docker
Local venvs in the repo are stale. Run backend Python through the container:
```sh
docker compose exec backend pytest                      # backend unit tests
docker compose exec backend pytest tests/test_ingest.py # single file
docker compose exec backend alembic upgrade head        # migrations
docker compose exec backend alembic revision -m "..."   # new migration
```
Backend tests (`pytest-asyncio`, `@pytest.mark.asyncio`) cover **pure logic only** — payload validation, topic parsing, permissions, forecasting math. DB/MQTT/S3-dependent paths are exercised by smoke scripts that need the live stack (e.g. `scripts/ingest_publish_demo.py`, `tools/device_sim.py`).

### Device simulator (stand-in for Pi hardware)
`backend/tools/device_sim.py` speaks the same `app.contracts` wire protocol as real firmware — anything the cloud accepts from it, it accepts from a Pi. Register a fixture device first, then run the sim. Fixture device certs for UUIDs `…000a`/`…000b` are pre-generated by `backend/certs/gen-dev-certs.sh`. See `backend/tools/README.md` for the exact `docker compose run` invocations and failure-mode flags (`--bad-payload`, `--dup-announce`, `--wrong-topic`, …).

⚠️ `…000a` is **not** a sim-only identity: it's also the live field Pi (station `UQI-ST-03` — see `_DEVICE_ID_OVERRIDES` in `backend/scripts/seed_pilot_corridor.py`). Running the sim as `…000a` while that node is up means two clients on one cert/client-id publishing to the same `dev/{id}/...` topics, so synthetic frames land in real history. Use `…000b` for sim work.

### Frontend (host)
```sh
cd frontend && npm install && npm run dev    # Vite, proxies /api and /ws to VITE_API_HOST
npm run build                                # tsc + vite build → dist/
```
There is no separate lint/test step configured for the frontend; `npm run build` runs `tsc` and is the type-check gate.

### Pi firmware
```sh
cd raspberry-pi-zero-2w && python -m pytest    # firmware unit tests (DSP, config overlay, supervisor)
```
The backend container mounts this tree read-only so `tests/test_pi_classifier.py` can import the on-device classifier and verify train/serve parity against the cloud.

The deployed field node is `pi-audio.openclaw` (tailnet; `ssh mikeg@pi-audio.openclaw`), running as device `00000000-0000-4000-8000-00000000000a` per `/etc/urban-acoustics/config.json`. Note the bare name `pi-audio` resolves to an **unrelated public host** — always use the `.openclaw` suffix.

## Environment & secrets

Backend config is Pydantic `Settings` (`app/settings.py`); the canonical env-var list is `ENV_VARS` in `contracts.py`. Untracked secrets (e.g. `UDOT_API_KEY`) live in `backend/.env` (gitignored). `ALLOWED_ORIGINS` rejects `*` at startup so a misconfigured prod fails fast.

⚠️ `README.md` currently has a plaintext "Utah DOT password" committed at the bottom — treat it as a leaked secret (rotate it; don't propagate it). Do not add real secrets to tracked files.

## Conventions

- This host has a Docker bridge-networking issue — `docker compose up` may fail with an iptables error; the workaround is host networking (image builds already use `network: host` for pip DNS).
- mTLS everywhere device-facing: the device's TLS cert CN must equal `str(device_id)` (`DeviceIdentity` validator); the Mosquitto ACL (`backend/mosquitto/aclfile`) scopes each device to its own `dev/{id}/...` topics.
- Spectrograms emit exactly `SPECTROGRAM_N_BANDS` (30) ISO 1/3-octave bands — this count is shared between firmware DSP and the cloud contract.
