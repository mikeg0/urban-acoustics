# Urban Acoustics — Refactor the Pi Zero 2 W into a Cloud-Streaming Sensor

## Context

Today the Pi Zero 2 W is a one-off: [record.sh](dev/urban-acoustics/raspberry-pi-zero-2w/record.sh) loops `arecord` writing 1-minute 48 kHz S32_LE WAV files (~11.5 MB each, ~13.8 GB/day) into `/home/pi/recordings/`. Files are retrieved manually by SCP. The cloud side ([backend/app/main.py](dev/urban-acoustics/backend/app/main.py), [backend/app/data.py](dev/urban-acoustics/backend/app/data.py)) is a FastAPI demo serving **synthetic** PRNG data with no auth, no DB, no ingestion path. The frontend is hard-coded to one city/sensor.

The goal is a "Weather Underground for traffic noise": a distributed network of devices that publishes verifiable noise hotspots to support municipal noise-abatement programs (modified mufflers, loud motorcycles). Bandwidth, privacy, and per-device cost all matter at scale.

**Three data planes, three transports** — never mix them:

| Plane | Cadence | Volume | Transport |
|---|---|---|---|
| dB telemetry (LAeq, LAFmax, LCpeak) | 1 Hz | ~80 B/sec | MQTT/TLS |
| Event audio clips (spike-triggered FLAC) | bursty | ~1–2 MB/clip | Presigned PUT to object store |
| Continuous Opus stream (deferred to Phase 2) | 24 kbps | ~10 MB/hr | WHIP → MediaMTX → HLS |

**User decisions (from clarification):**
- Full Phase 1→3 roadmap; Phase 1 implementation-ready.
- Self-hosted on existing devlab (Traefik file-provider; apps join `dev_conexed_com_default`).
- Live "tune in" audio deferred to Phase 2.
- MQTT (Mosquitto Phase 1, EMQX Phase 2+) from day one.

## Phase 1 — One Pi, devlab cloud, real telemetry + event uploads

### 1.1 New cloud services (devlab compose)

Add to [docker-compose.yml](dev/urban-acoustics/docker-compose.yml) — keep app-side compose; do **not** edit `/home/mikeg/dev/devlab/docker-compose.yml` per the [devlab Traefik layout](.claude/projects/-home-mikeg/memory/devlab_layout.md):

| Service | Image | Purpose | Port |
|---|---|---|---|
| `mosquitto` | `eclipse-mosquitto:2` | MQTT broker, TLS-only on 8883 | 8883 |
| `postgres` | `timescale/timescaledb-ha:pg16` | Telemetry hypertables + relational | 5432 (internal) |
| `minio` | `minio/minio:latest` | S3-compatible object store for event FLACs | 9000/9001 |

New Traefik dynamic configs in `/home/mikeg/dev/devlab/traefik/dynamic/`:
- `urban-acoustics-mqtt.yml` — TCP router on 8883 → `mosquitto:8883` (TLS passthrough; broker terminates TLS itself, no Traefik cert needed for mTLS)
- `urban-acoustics-api.yml` — already-routed FastAPI; ensure routes for `/api/v1/*` and `/api/v1/devices/intent`
- `urban-acoustics-minio.yml` — HTTPS router for the device-facing presigned-URL host (e.g., `audio.urban-acoustics.conexed.com`)

Mosquitto config (`backend/mosquitto/mosquitto.conf`):
- `listener 8883`, `cafile`, `certfile`, `keyfile`, `require_certificate true` (mTLS)
- `acl_file` restricting `dev/<device_id>/#` to that device's CN
- `persistence true` for QoS-1 buffering across restarts

### 1.2 Backend changes

New / modified files under [backend/app/](dev/urban-acoustics/backend/app/):

| File | Status | Purpose |
|---|---|---|
| `settings.py` | new | pydantic-settings: DB URL, MQTT broker, MinIO creds, JWT secret |
| `db.py` | new | async SQLAlchemy engine + Timescale helpers |
| `models.py` | new | ORM: `devices`, `device_certs`, `events`, `labels`, `tenants` |
| `migrations/` (alembic) | new | initial schema + hypertables (`telemetry_db`, `device_health`) |
| `ingest/mqtt.py` | new | Paho MQTT consumer; subscribes to `dev/+/tlm`, `dev/+/health`, `dev/+/event/announce`; batches into Timescale via `COPY` every 1 s |
| `api/v1/devices.py` | new | `POST /provision` (factory cert → per-device cert), `POST /renew`, `POST /token` (mTLS → 1-h JWT) |
| `api/v1/events.py` | new | `POST /events/intent` (sha256 + size → presigned MinIO PUT URL, 60 s TTL, content-length-bound), `GET /events/{id}` (signed playback URL, 5 min) |
| `api/v1/telemetry.py` | new | `GET /devices/{id}/telemetry?from&to&res` reads from continuous aggregates |
| `api/v1/hotspots.py` | new (stub Phase 1) | placeholder; H3 logic in Phase 2 |
| `auth/device.py` | new | mTLS validation, JWT issuance |
| `auth/user.py` | new (stub Phase 1) | session cookie; OIDC swap-in lands Phase 2 |
| `storage.py` | new | MinIO/S3/R2 abstraction (boto3) — Phase 3 swaps endpoint, code unchanged |
| `live.py` | modify | keep WS for dashboard; Phase 1 reads from Postgres `LISTEN/NOTIFY` (Vector/Centrifugo Phase 2) |
| `data.py` / `seed.py` | keep | demo path behind `DEMO_MODE=1` env flag |
| `main.py` | modify | mount `/api/v1/*` routers; remove `allow_origins=["*"]`, replace with explicit list |

**Schema highlights** (alembic migration):
```sql
CREATE TABLE devices (id uuid PK, owner_id uuid, tenant_id uuid, name text,
                      lat float, lon float, geohash text, visibility text,
                      created_at timestamptz, last_seen_at timestamptz);
CREATE TABLE device_certs (device_id uuid FK, fingerprint text PK,
                           issued_at timestamptz, expires_at timestamptz, revoked bool);
CREATE TABLE telemetry_db (ts timestamptz, device_id uuid, laeq numeric(5,2),
                           lafmax numeric(5,2), lcpeak numeric(5,2), geohash text);
SELECT create_hypertable('telemetry_db', 'ts', chunk_time_interval => '1 day');
-- continuous aggregates: telemetry_1m, telemetry_1h
-- retention: raw 7 d, 1m 90 d, 1h forever
CREATE TABLE events (id uuid PK, device_id uuid, ts timestamptz, peak_db numeric,
                     duration_s numeric, sha256 text, storage_key text,
                     status text, classification text, confidence numeric,
                     model_version text);
CREATE TABLE labels (event_id uuid FK, user_id uuid, label text, created_at timestamptz);
```

### 1.3 Pi Zero 2 W refactor

Retire `record.sh` and `pi-recorder.service`. New layout under [raspberry-pi-zero-2w/](dev/urban-acoustics/raspberry-pi-zero-2w/):

```
raspberry-pi-zero-2w/
├── README.md                          (updated install guide)
├── asoundrc                           (unchanged — INMP441 dmic_sv config)
├── pyproject.toml                     paho-mqtt, numpy, soundfile, flask
├── urban_acoustics/
│   ├── __main__.py                    python -m urban_acoustics
│   ├── supervisor.py                  asyncio orchestrator + watchdog
│   ├── capture.py                     arecord subprocess → ringbuffer
│   ├── ringbuffer.py                  numpy SPSC circular buffer
│   ├── dsp.py                         A/C-weighting biquads, LAeq/LAFmax/LCpeak (numpy only — no scipy)
│   ├── detector.py                    threshold + hysteresis + pre/post-roll
│   ├── encoder.py                     soundfile FLAC writer for events
│   ├── telemetry.py                   1 Hz publish to MQTT
│   ├── uploader.py                    intent → presigned PUT → done
│   ├── transport.py                   paho wrapper, reconnect, backoff
│   ├── queue_store.py                 SQLite store-and-forward (WAL mode)
│   ├── provisioning.py                claim-code → CSR → cert install
│   ├── config.py                      cached config, cmd/config subscriber
│   ├── calibration.py                 mic gain offset
│   ├── health.py                      cpu/temp/mem/RSSI/queue
│   └── localapi/                      Flask diag UI on 127.0.0.1:8080
├── systemd/
│   ├── urban-acoustics.service        replaces pi-recorder.service
│   ├── urban-acoustics-setup.service  AP-mode provisioning oneshot
│   └── urban-acoustics-cleanup.timer  daily cleanup
├── chrony/chrony.conf                 sub-100 ms NTP, aggressive resync
├── ca/root-ca.pem                     pinned cloud root CA
└── boot/firstboot.sh                  generates claim-code, sets hostname
```

**Why one supervisor (not microservices):** Pi Zero has 512 MB RAM (~350 MB usable). Each Python interpreter is ~25–40 MB before imports — five units = no headroom. One asyncio supervisor owns one shared in-RAM ringbuffer; DSP/uploader/streamer run as tasks. Hard cap `MemoryMax=300M` in the unit file; supervisor self-restarts above 250 MB RSS.

**Why keep `arecord` (not switch to sounddevice/PyAudio):** GIL-free C process, survives Python pauses without dropping frames. Pipe raw PCM to stdout, supervisor reads 100 ms blocks. PortAudio has historically been finicky on ARM under load.

**DSP — `numpy` only:** A-weighting via 4th-order IIR biquad cascade per IEC 61672 (precomputed coeffs for 16 kHz, applied with manual `lfilter` in numpy). LAeq = RMS over 1 s of A-weighted samples; LAFmax = exponential averager τ=125 ms peak; LCpeak = `20*log10(max(|x|))` on C-weighted signal. CPU cost ~0.5–1% of one core. Reject scipy (adds ~80 MB RSS) and torch/tflite (massive overkill for IIR).

**Event detection:** trigger LAeq > 75 dBA (configurable), reset at 70 dBA (hysteresis), 5 s pre-roll from ringbuffer + 8 s post-roll, 48 kHz / 24-bit FLAC via `soundfile`. ~1.5 MB per 15-s clip.

**Memory budget target:**
| Component | RSS |
|---|---|
| Python supervisor + numpy | ~60 MB |
| Ringbuffer (30 s @ 48 kHz S16) | ~6 MB |
| Pre-roll buffer | ~2 MB |
| paho-mqtt + TLS state | ~8 MB |
| chrony, dhcpcd, sshd, systemd | ~80 MB |
| SQLite queue cache | ~10 MB |
| **Total** | **~170 MB** (170 MB headroom) |

### 1.4 Authentication — mTLS provisioning flow (Phase 1, vendor-neutral)

Inspired by AWS IoT Fleet-Provisioning-by-Claim, but runs entirely in our stack. **Why mTLS over API keys / JWT alone:** leaked cert is useless without the on-device private key; revocation is per-device; broker offloads auth to TLS so backend isn't in the per-message hot path.

**Factory image ships:**
- A *bootstrap claim certificate* (shared by all devices in this image; perms = `connect` + `publish dev/+/provision/request` only)
- `ca/root-ca.pem` (pinned cloud root CA)
- A unique 16-char human-readable claim code, generated at flash time, printed on a sticker

**First-boot flow** (driven by `provisioning.py`):
1. No `device.crt` exists → supervisor enters provisioning mode.
2. AP-mode (`urban-acoustics-setup-XXXX`) brought up, captive portal at `192.168.4.1` for WiFi creds + claim-code confirm + location pin + friendly name.
3. Operator submits → device joins WiFi, drops AP.
4. Device generates Ed25519 keypair on-device. Connects to broker with bootstrap cert. Publishes `dev/+/provision/request` with `{claim_code, csr, cpu_serial, mac, location}`.
5. Backend validates claim_code (one-shot, unredeemed), signs CSR (24 h validity for first cert; rotated to 12 mo on first refresh), returns `{device_id, cert_pem, broker_url, config}`.
6. Device writes cert + key with mode 0600, shreds bootstrap cert, reconnects as `device_id`.
7. Subscribes to `dev/{device_id}/cmd/#`. First telemetry publishes within ~15 s.

**Cert rotation:** at 75% TTL the device requests `cmd/rotate-cert`, gets a new cert, atomically swaps. Old cert valid 24 h grace.

### 1.5 Device → Cloud transports

| Topic / endpoint | Direction | Cadence | QoS / Auth |
|---|---|---|---|
| `dev/{id}/tlm` | device → broker | 1 Hz | QoS 0, mTLS |
| `dev/{id}/health` | device → broker | 1/min | QoS 1, mTLS |
| `dev/{id}/event/announce` | device → broker | per event | QoS 1, mTLS |
| `dev/{id}/event/done` | device → broker | per event | QoS 1, mTLS |
| `dev/{id}/cmd/+` | broker → device | on demand | QoS 1, mTLS |
| `dev/{id}/lwt` | broker (Last-Will) | on disconnect | QoS 1, retained |
| `POST /api/v1/events/intent` | device → API | per event | mTLS-derived JWT |
| `PUT <presigned>` | device → MinIO | per event | URL-bound, sha256-bound |

**Telemetry payload** (~80 bytes JSON):
```json
{"ts": 1745673600.123, "laeq": 58.4, "lafmax": 67.2, "lcpeak": 82.1}
```
**Health payload** (~300 B): `ts, uptime_s, cpu_pct, cpu_temp_c, mem_used_mb, disk_free_mb, wifi_rssi_dbm, queue_depth, queue_bytes, mic_gain_db, ntp_offset_ms, fw_version, config_version`.

**Event upload (presigned):** intent body is `{event_id, device_id, ts, duration_s, peak_db, sha256, size}` signed with the device's session JWT. Backend allocates `events/<yyyy>/<mm>/<dd>/<device_id>/<event_id>.flac`, returns presigned URL with strict policy (max content-length 8 MB, content-type `audio/flac`, exact key, sha256-bound). Device PUTs directly to MinIO over HTTPS — bytes never traverse FastAPI.

### 1.6 Resilience

- **Store-and-forward:** SQLite WAL at `/var/lib/urban-acoustics/queue.db`. Tables: `queue(id, topic, payload, qos, attempts, next_retry_at)`, `events(id, started_at, peak_db, flac_path, status, attempts)`. Atomic INSERT/UPDATE survives power loss.
- **Caps:** telemetry 24 h, health 7 d, events 7 d or until uploaded; hard 1 GB ceiling drops oldest non-event records first.
- **Backoff:** exponential (1, 2, 4, … capped at 5 min); device retries event uploads up to 7 days.
- **chrony** (not systemd-timesyncd) for sub-100 ms NTP that resyncs aggressively after WiFi drops; `chronyc tracking` exposes offset for health telemetry.

### 1.7 Frontend changes (Phase 1, minimal)

Just enough to display real data from one device:
- [frontend/src/api.ts](dev/urban-acoustics/frontend/src/api.ts) — accept `deviceId` parameter; switch endpoints to `/api/v1/*`.
- [frontend/src/App.tsx](dev/urban-acoustics/frontend/src/App.tsx) — replace Riverton/SNS-0412 hard-codes with the single Phase-1 device's UUID (env or config).
- New `frontend/src/events/EventsList.tsx` and `EventPlayer.tsx` — fetch event rows + signed playback URL, play FLAC via `<audio>` (browsers play FLAC natively in 2026).
- New `frontend/src/events/LabelPicker.tsx` — 9-class taxonomy buttons (motorcycle, car, construction, helicopter, airplane, siren, dog, voice, other) → `POST /api/v1/events/{id}/labels`.
- [frontend/src/wavplayer.tsx](dev/urban-acoustics/frontend/src/wavplayer.tsx) — keep synthesizer behind `demoMode` flag; real playback goes through `EventPlayer`.
- [frontend/src/live.tsx](dev/urban-acoustics/frontend/src/live.tsx) — keep WebSocket; backend pushes real Postgres `NOTIFY` data.

### 1.8 Phase 1 cost / footprint

Existing devlab VM. Adds: Mosquitto (~30 MB RAM), Timescale (~300 MB), MinIO (~100 MB), backend +~100 MB. Total <1 GB additional. Storage: 1 device × 1 Hz × 30 days = ~8 M telemetry rows (~500 MB compressed); ~50 events/day × 1.5 MB × 30 d = ~2 GB FLACs. Trivial.

---

## Phase 2 — Multi-device, classification queue, live audio (3 months)

**Triggers:** when more than ~10 devices, or when "tune in and listen" becomes a feature ask.

- **Mosquitto → EMQX:** for clustering, HTTP auth hooks (Postgres allow-list), Kafka egress later.
- **Vector** replaces the FastAPI MQTT consumer: MQTT input → transforms (geohash enrich, tenant lookup) → Postgres `COPY` sink. Backend stops being in the ingest hot path.
- **Centrifugo** for dashboard fan-out: Redis Streams backplane (Vector publishes deltas), browser subscribes via JWT-scoped channels (`tlm:device:{id}`, `tlm:hex:{h3}`, `events:tenant:{slug}`). Replaces the current `/ws/live` for production.
- **Async ML pipeline:** R2/MinIO event-bridge → SQS-like queue → Python worker pool (ONNX Runtime CPU, YAMNet baseline → fine-tuned 9-class head). Writes back `classification`, `confidence`, `model_version` on `events`. Surfaces in dashboard within ~2 s p99.
- **Active learning loop:** crowd labels → `gold` after 3 concurring or 1 municipal-admin → nightly training set sample → weekly retraining → shadow deploy → promote.
- **Live audio (WHIP → MediaMTX → LL-HLS):** Pi runs `ffmpeg -c:a libopus -application voip -b:a 24k -frame_duration 20`; mandatory low-pass at 3.5 kHz + high-pass at 80 Hz **on-device, firmware-enforced** (kills speech intelligibility while preserving traffic-noise character — primary privacy guarantee). MediaMTX repackages to LL-HLS; `hls.js` plays in browser. Toggleable per device; encoder spins up only when listeners present (MediaMTX publisher hook).
- **Auth upgrades:** OIDC via self-hosted Keycloak; roles `viewer | registered | device_owner | municipal_admin | researcher | superadmin`; row-level filters on `visibility ∈ {public, tenant, private}`.
- **Privacy posture (private-by-default):** owner explicitly opts in to publish. "Donate to research" path = anonymized contribution to public hex aggregates with location jittered ~50 m. **Region policy** table — devices in BIPA/two-party-consent jurisdictions get events-only by default.
- **Geographic / hotspot features:** H3 (resolutions 7/8/9) + PostGIS in same Timescale Postgres. Nightly job computes per-hex per-hour-of-week baseline + EWMA; flags hexes ≥6 dB above 6-neighbor mean as hotspots.
- **Frontend additions:** `frontend/src/atlas/` (MapLibre GL + H3 layer), `frontend/src/audio/HlsPlayer.tsx` + `TuneInToggle.tsx`, `frontend/src/auth/` (OIDC), `frontend/src/admin/` (owner views).
- **Top-level `ml/` directory:** `ml/train/`, `ml/serve/`, `ml/models/`, `ml/labels/`. Keeps ML deps out of the API image.

---

## Phase 3 — Global scale (9–12 months)

**Triggers:** approaching 100K devices or first cross-region tenant.

- **Move to k3s** (Hetzner) or managed k8s; Helm charts per component; ArgoCD; HPA on queue depth for ML workers.
- **Storage migration:** MinIO → Cloudflare R2 for event archives and live segments. **R2's free egress is the single biggest financial lever** — at 1 M devices and 1% live-audio concurrency, AWS egress alone is $5–10 M/mo; on R2 it's effectively the storage cost. The `storage.py` abstraction makes this a config swap.
- **Telemetry hot path:** at ~3 M rows/sec (1 M devices × 3 metrics) Timescale's single-primary write ceiling is the cliff. Add **ClickHouse** as a parallel Vector sink, validate against Timescale, then promote ClickHouse for telemetry analytics; Timescale keeps relational + 24-hour hot tier.
- **EMQX multi-region cluster**, Centrifugo regional shards.
- **TPM-attested device signatures** (where hardware supports) — recordings carry hardware-rooted signatures owners can't forge.
- **On-device VAD-mute** (Phase 3): tiny TFLite voice-activity detector; live stream silences 30 s on speech detection. Belt-and-suspenders on top of the 3.5 kHz low-pass.
- **Researcher API** (`/research/v1/*`, OAuth2 scoped, rate-limited, daily Parquet export to R2 with signed URLs).
- **Multi-tenant billing, audit logging (SOC2-ready), public hex-aggregate dataset.**

**Cost projection** (rough, Hetzner + R2):
- 100 devices: ~$60/mo (Phase 1 footprint).
- 10K devices: ~$800–1000/mo (full k3s stack on R2).
- 1M devices: ~$25–40K/mo (ClickHouse sharding, multi-region; killer line-item is live-audio bandwidth, free on R2).

---

## Threat model (called out explicitly)

| Threat | Mitigation |
|---|---|
| Rogue device flooding telemetry | EMQX per-client rate limit; auto-quarantine over 5× expected publish rate |
| Replay on event uploads | Intent payload nonce + ts; server rejects nonce reuse 24 h via Redis; presigned URL is sha256-bound |
| Audio tampering for false hotspots | Devices sign payloads; hotspot algorithm requires N≥3 corroborating devices for "verified" pin |
| Stolen device cert | Short-lived (90 d) certs + 1 h JWTs; suspicious geo jumps trip auto-revoke |
| Bot scraping researcher API | Cloudflare bot-mode + sliding-window per-token rate limit + captcha for unauth bulk |
| Owner uploads fake recordings | Phase 3 TPM-attested hardware signatures |
| Compromised bootstrap cert | Bootstrap cert can only publish `provision/request` (no other perms); already-provisioned devices unaffected |

## Critical files to create / modify

**New (Phase 1):**
- [backend/app/ingest/mqtt.py](dev/urban-acoustics/backend/app/ingest/mqtt.py)
- [backend/app/api/v1/devices.py](dev/urban-acoustics/backend/app/api/v1/devices.py)
- [backend/app/api/v1/events.py](dev/urban-acoustics/backend/app/api/v1/events.py)
- [backend/app/api/v1/telemetry.py](dev/urban-acoustics/backend/app/api/v1/telemetry.py)
- [backend/app/auth/device.py](dev/urban-acoustics/backend/app/auth/device.py)
- [backend/app/storage.py](dev/urban-acoustics/backend/app/storage.py)
- [backend/app/db.py](dev/urban-acoustics/backend/app/db.py), [models.py](dev/urban-acoustics/backend/app/models.py), [settings.py](dev/urban-acoustics/backend/app/settings.py)
- [backend/migrations/](dev/urban-acoustics/backend/migrations/) (alembic)
- [backend/mosquitto/mosquitto.conf](dev/urban-acoustics/backend/mosquitto/mosquitto.conf)
- [raspberry-pi-zero-2w/urban_acoustics/](dev/urban-acoustics/raspberry-pi-zero-2w/urban_acoustics/) (full Python package, structure above)
- [raspberry-pi-zero-2w/systemd/urban-acoustics.service](dev/urban-acoustics/raspberry-pi-zero-2w/systemd/urban-acoustics.service)
- `/home/mikeg/dev/devlab/traefik/dynamic/urban-acoustics-mqtt.yml` (TCP 8883 passthrough)
- `/home/mikeg/dev/devlab/traefik/dynamic/urban-acoustics-minio.yml` (HTTPS for presigned-URL host)

**Modify:**
- [docker-compose.yml](dev/urban-acoustics/docker-compose.yml) — add `mosquitto`, `postgres` (Timescale), `minio`
- [backend/app/main.py](dev/urban-acoustics/backend/app/main.py) — mount `/api/v1/*`, replace `allow_origins=["*"]`
- [backend/app/live.py](dev/urban-acoustics/backend/app/live.py) — feed from real Postgres `LISTEN/NOTIFY` (Phase 1) instead of synthetic ticks; gated by `DEMO_MODE`
- [backend/requirements.txt](dev/urban-acoustics/backend/requirements.txt) — add paho-mqtt, sqlalchemy, asyncpg, alembic, boto3, pydantic-settings, python-jose
- [frontend/src/api.ts](dev/urban-acoustics/frontend/src/api.ts), [frontend/src/App.tsx](dev/urban-acoustics/frontend/src/App.tsx) — accept deviceId; switch to `/api/v1/*`
- [raspberry-pi-zero-2w/README.md](dev/urban-acoustics/raspberry-pi-zero-2w/README.md) — replace install guide

**Retire:**
- [raspberry-pi-zero-2w/record.sh](dev/urban-acoustics/raspberry-pi-zero-2w/record.sh)
- [raspberry-pi-zero-2w/pi-recorder.service](dev/urban-acoustics/raspberry-pi-zero-2w/pi-recorder.service)

## Verification (Phase 1 end-to-end)

1. `docker compose up -d` brings up mosquitto + postgres + minio + backend + frontend.
2. Run alembic migration; confirm `\d+ telemetry_db` shows hypertable in Timescale.
3. Generate factory + per-device certs locally; confirm `mosquitto_sub -h localhost -p 8883 --cafile root-ca.pem --cert dev1.crt --key dev1.key -t 'dev/+/tlm' -v` connects.
4. On Pi: install `urban_acoustics` package, run `python -m urban_acoustics --provision`; confirm AP comes up, web form completes, device cert lands at `/var/lib/urban-acoustics/device.crt`.
5. Start `urban-acoustics.service`; within 15 s confirm 1 Hz JSON publishes appear on `dev/{id}/tlm`.
6. Confirm `SELECT count(*) FROM telemetry_db WHERE device_id=$1 AND ts > now()-interval '1 minute'` returns ~60.
7. Tap or play loud audio at the mic; confirm event_announce → presigned URL response → FLAC lands in MinIO bucket → `events` row populated.
8. Open frontend at `https://urban-acoustics.conexed.com`; live page shows real dB values; events tab lists the spike; click → FLAC plays.
9. Disconnect Pi from WiFi for 5 min; reconnect; confirm queued telemetry drains and events upload (check `queue_depth=0` in next health ping).
10. `journalctl -u urban-acoustics -f` shows no errors; `cpu_temp_c < 70`, `mem_used_mb < 250`.

## Tradeoffs explicitly accepted

- **Single supervisor process** (RAM efficiency) over separate units (crash isolation). Mitigated by aggressive watchdog + systemd auto-restart.
- **MQTT introduces a stateful broker** to operate. Worth it for offline buffering, last-will, topic routing — rolling those into HTTP is its own multi-month project.
- **Cloud-side classification** (faster iteration, no fleet OTA) over edge classification (better privacy story for restrictive regions). Architecture leaves a `Classifier` interface as no-op v1, TFLite v2.
- **Manual location** at provisioning, no GPS. A noise sensor is fixed-position; GPS adds $15+, drains power, fails indoors.
- **Privacy: private-by-default with explicit opt-in publish.** Slower public-data growth than Weather Underground, but the only legally-sane posture for audio. Public hex-aggregate map (no reverse-identification possible) carries the public-data narrative.
- **`numpy` only on device, no scipy/torch/tflite Phase 1.** Saves ~100 MB RSS. Hand-rolled biquads are ~30 lines.
- **Demo-mode (`DEMO_MODE=1`) keeps `data.py`/`seed.py` alive** so frontend dev works without a Pi. Gated to `/api/v1/demo/*`, never enabled in CI integration tests.
