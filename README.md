# Urban Acoustics

A city noise-monitoring platform. Solar/mic sensor nodes (Raspberry Pi Zero 2 W, or a software simulator) stream live acoustic telemetry to a cloud backend that powers a resident-facing dashboard:

> Live stream + rolling spectrogram, plus historical drill-down: Year → Month → Day → Hour, with breach/anomaly detection, a seasonal-naive forecast, peak-hour analysis, and event audio playback.

Currently a **Salt Lake City** beta along the State Street corridor. The public petition site is at **https://slcquiet.org/** (deployed separately — see [`deploy/quiet-initiative/`](deploy/quiet-initiative/)).

## Stack

| Layer        | Tech                                                          |
| ------------ | ------------------------------------------------------------ |
| Frontend     | Vite 6 · React 18 · TypeScript · MapLibre                    |
| Backend API  | FastAPI · Uvicorn (Python 3.12)                              |
| Ingest       | Standalone MQTT worker (paho-mqtt) — same image, own process |
| Live         | MQTT → Postgres `NOTIFY` → WebSocket fan-out                 |
| Database     | TimescaleDB (Postgres 16) — hypertables + continuous aggregates |
| Object store | MinIO (S3-compatible) — event audio (FLAC)                  |
| Broker       | Mosquitto 2 — mTLS, per-device topic ACLs                   |
| Routing      | Traefik (shared devlab network), `*.dev.conexed.com`        |
| Dev loop     | Docker Compose — uvicorn `--reload` + Vite HMR              |

## Architecture

```
sensor / device_sim ──mTLS MQTT──> Mosquitto ──> ingest worker ──> TimescaleDB
                                                       │
                                                       └─ pg NOTIFY ─> FastAPI WebSocket ─> dashboard (live)

event audio:  device announce ──> POST /events/intent (presigned URL) ──> PUT FLAC to MinIO ──> event/done
```

- **Devices** publish telemetry (1 Hz), 1/3-octave spectrogram frames (~10 Hz), and health (1/min) over mTLS to Mosquitto on `dev/{device_id}/...` topics.
- The **ingest worker** (`app/ingest/mqtt.py`) validates every payload against `app/contracts.py`, batches writes into Timescale, and emits Postgres `NOTIFY` for ephemeral live data. Spectrogram frames are **not** persisted — they fan out live and are dropped.
- The **API** (`app/main.py`) serves REST + WebSocket under `/api/v1`. The live WebSocket subscribes to the `NOTIFY` channel and pushes frames to browsers.
- **Event audio** follows a status machine: `announced → upload_intent_created → uploaded → available` (`available` is marked lazily on first playback-URL request).

`app/contracts.py` is the single source of truth for every wire schema, MQTT topic template, the event-status state machine, and the authoritative env-var list. It's imported by the API, the ingest worker, and the device simulator — change shapes there, not locally.

## Quick start

Requires Docker (Compose v2) and the shared devlab Traefik stack running (the app joins the external `dev_conexed_com_default` network and is routed at `*.dev.conexed.com`).

```sh
docker compose up
```

This starts the backend API, the ingest worker, the frontend, Postgres/Timescale, Mosquitto, and MinIO. On first boot the backend runs `alembic upgrade head`, ensures the MinIO bucket exists, bootstraps the admin user, and (with `DEMO_MODE=1`) seeds synthetic dashboard data.

Then open the dashboard:

- **Dashboard** — https://urban-acoustics.dev.conexed.com/
- **MinIO console** — https://urban-acoustics-minio.dev.conexed.com/
- **Petition / demo pages** — https://urban-acoustics.dev.conexed.com/quiet-initiative/ , `/enforcement-map/`

Only **Mosquitto** (`8883`) and **MinIO** (`9000`) publish host ports; the API and frontend are reachable only through Traefik (no `localhost:8000`/`5173` mapping in the committed compose file).

## Local dev credentials

All of the following are baked into [`docker-compose.yml`](docker-compose.yml) and are **dev-only**. Do not reuse in any deployed environment.

| Service                         | Username / key      | Password                           |
| ------------------------------- | ------------------- | ---------------------------------- |
| Dashboard (admin user)          | `admin@local`       | `devpass1234`                      |
| Postgres (db `urban_acoustics`) | `urban_acoustics`   | `urban_acoustics_dev`              |
| MinIO root                      | `urban_acoustics`   | `urban_acoustics_dev_secret_12345` |

The admin user is bootstrapped from `ADMIN_EMAIL` / `ADMIN_PASSWORD` on first backend startup; rotate it via the UI and clear the env vars afterwards. New self-signups land as `guest` (synthetic preview data only) and must be promoted via `PATCH /api/v1/users/{id}`. Authorization is permission-based (`app/auth/permissions.py`), mirrored on the client in `frontend/src/permissions.ts`.

## Project layout

```
.
├── backend/
│   ├── app/
│   │   ├── main.py          # FastAPI app, startup hooks, router wiring
│   │   ├── contracts.py     # wire schemas, MQTT topics, env vars (source of truth)
│   │   ├── settings.py      # Pydantic settings
│   │   ├── db.py            # async SQLAlchemy engine / session
│   │   ├── models.py        # ORM models (Timescale hypertables)
│   │   ├── api/v1/          # REST + WS routers (devices, telemetry, events, …)
│   │   ├── auth/            # JWT cookies, password hashing, permissions
│   │   ├── ingest/          # MQTT worker (`python -m app.ingest.mqtt`) + command publisher
│   │   ├── integrations/    # UDOT traffic-camera import
│   │   ├── migrations/      # Alembic (script_location = app/migrations)
│   │   ├── seed.py, data.py # synthetic demo-mode data (mulberry32 PRNG)
│   │   └── live.py          # legacy demo-mode WebSocket
│   ├── tests/               # pure-logic unit tests (pytest-asyncio)
│   ├── tools/device_sim.py  # software stand-in for Pi firmware
│   ├── scripts/             # register_device, refresh_cameras, backfill_caggs, …
│   ├── certs/               # dev mTLS CA + device/ingest/broker certs
│   ├── mosquitto/           # broker config + per-device topic ACL
│   └── data/                # generated demo data (gitignored)
├── frontend/
│   └── src/                 # App.tsx, drills/panels/live/spectrogram, api.ts, …
├── raspberry-pi-zero-2w/    # on-device sensor firmware (separate package)
├── deploy/quiet-initiative/ # AWS SAM/Amplify deploy for the petition site
├── plans/                   # phased design docs + per-task specs
└── docker-compose.yml
```

## API

REST and WebSocket live under `/api/v1` (the routers are wired in `app/main.py`): `auth`, `users`, `devices`, `telemetry`, `device-health`, `spectrogram`, `events`, `labels`, `annotations`, `live`, `summary`, `anomalies`, `forecast`, `sources`, `runtime-config`, `led`, `cameras`, `preview`, `health`.

Request/response shapes are defined in `app/contracts.py`. Internal storage is `TIMESTAMPTZ`; the API converts to Unix seconds at the wire boundary. Telemetry/health/spectrogram reads accept a `resolution` of `raw` / `1m` / `1h`, served from Timescale continuous aggregates.

### Demo mode

With `DEMO_MODE=1` (the default in dev compose), synthetic-data routes mount under `/api/v1/demo` **and** are aliased at legacy `/api/...` paths (`/api/year`, `/api/day/{YYYY-MM-DD}`, `/ws/live`) so the original prototype dashboard keeps working. `GET /api/health` returns `{ok, seeded}`. Guests (role `guest`) see this synthetic data via the `preview` routes; members and above see real device data.

## Devices & the simulator

`backend/tools/device_sim.py` speaks the same `app.contracts` wire protocol as real firmware — anything the cloud accepts from it, it accepts from a Pi. Fixture device certs for the stable UUIDs `…000a` / `…000b` are pre-generated by `backend/certs/gen-dev-certs.sh`.

Register a device, then run the simulator (full details and failure-mode flags in [`backend/tools/README.md`](backend/tools/README.md)):

```sh
# register the fixture device against a migrated DB
docker compose exec backend python -m scripts.register_device \
    --device-id 00000000-0000-4000-8000-00000000000a \
    --cert /app/certs/devices/00000000-0000-4000-8000-00000000000a.crt \
    --name "fixture-device-a" --location "State St & 2100 S"

# run one full telemetry + event cycle
docker compose run --rm --entrypoint "" backend \
    python -m tools.device_sim \
        --device-id 00000000-0000-4000-8000-00000000000a \
        --api-base http://backend:8000 --once
```

The on-device firmware lives in [`raspberry-pi-zero-2w/`](raspberry-pi-zero-2w/) as the `urban_acoustics` package (DSP, capture, encoder, uploader, supervisor). It has its own `pyproject.toml` and tests.

## Tests & migrations

Python runs inside the backend container.

```sh
docker compose exec backend pytest                       # backend unit tests
docker compose exec backend pytest tests/test_ingest.py  # a single file
docker compose exec backend alembic upgrade head         # apply migrations
docker compose exec backend alembic revision -m "..."    # new migration

cd raspberry-pi-zero-2w && python -m pytest              # firmware tests
```

Backend tests cover **pure logic** — payload validation, topic parsing, permissions, forecasting math. DB/MQTT/S3-dependent paths are exercised by smoke scripts that need the live stack (e.g. `scripts/ingest_publish_demo.py`, `tools/device_sim.py`).

## Hot reload

Both services reload on source changes — no container restart needed.

- **Backend** — uvicorn watches `backend/app/`; edit a `.py` and watch for `WatchFiles detected changes`. The ingest worker is a separate process and does **not** auto-reload — restart it with `docker compose restart ingest`.
- **Frontend** — Vite HMR updates the running page instantly.

`backend/data/`, Postgres, MinIO, and Mosquitto state persist via named volumes; `frontend/node_modules/` is kept in an anonymous volume.

## Settings

Click the gear in the top-right to open the settings dialog. Three tweaks persist to `localStorage` and apply live across every spectrogram, ribbon, and feed:

- **Spectrogram palette** — Heat / Ice / Mono / Neon
- **Event threshold** — 30–100 dB (device default 80)
- **Anomaly sensitivity** — z-score cutoff 1.5–4.0 (default 2.9)

## Configuration

Backend config is Pydantic `Settings` (`app/settings.py`); the canonical env-var list is `ENV_VARS` in `app/contracts.py`. Inline `environment:` values in `docker-compose.yml` cover the dev defaults. Untracked secrets (e.g. `UDOT_API_KEY` for the traffic-camera import) go in `backend/.env`, which is gitignored — never commit real secrets. `ALLOWED_ORIGINS` rejects `*` at startup so a misconfigured production deployment fails fast.

## Production build

The Compose setup runs the **dev** servers (uvicorn `--reload`, Vite). For a production frontend bundle:

```sh
cd frontend && npm run build   # tsc + vite build → frontend/dist/
```

Serve `frontend/dist/` from any static host and point it at the FastAPI backend behind a reverse proxy. Don't ship the dev Dockerfiles to production.

## Troubleshooting

**`Failed to Setup IP tables` on `docker compose up`**
The Docker daemon's bridge chain is missing — usually after a host firewall reset. Fix with `sudo systemctl restart docker`. Without sudo, run containers with `--network=host` (image builds already use host networking for pip DNS).

**`network dev_conexed_com_default not found`**
The shared devlab Traefik stack isn't up. Start it first — this compose joins that external network rather than creating its own.

**`permission denied` connecting to `/var/run/docker.sock`**
Your shell predates your `docker` group membership. Log out and back in, or prefix commands with `sg docker -c "..."`.

**Dashboard or live page is blank**
Check `docker compose logs backend` for `Application startup complete.`, confirm migrations ran, and that the ingest worker is connected (`docker compose logs ingest`). With no devices publishing, run the simulator to generate live data.

## Origin

Bootstrapped from a [Claude Design](https://claude.ai/design) HTML/JSX prototype (flat-JSON, synthetic data), then migrated to this Vite + FastAPI + Timescale + MQTT + Docker platform. The synthetic-data path survives as **demo mode**.
