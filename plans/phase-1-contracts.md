# Phase 1 Contracts — Device ↔ Cloud

This is the single source of truth for every wire-level Phase 1 contract between
the Pi sensor, the MQTT broker, the FastAPI backend, the object store, and the
frontend. Anything not documented here is **not** part of Phase 1.

The contract module lives at [backend/app/contracts.py](../backend/app/contracts.py).
Golden payload fixtures live under [backend/tests/fixtures/](../backend/tests/fixtures/).

## Stability rules

- **Required fields are stable.** Removing or renaming any required field below
  is a breaking change and requires bumping the topic/endpoint to a `/v2` form.
- **Unknown fields are tolerated** on inbound device→cloud payloads
  (`extra="ignore"` in Pydantic). This is the forward-compatibility seam.
- **Outbound cloud→device payloads use `extra="forbid"`** so we never ship a
  field the firmware fleet hasn't seen.
- Versioning is *transport-level*, not *envelope-level*: there is no
  `"schema_version"` field. The topic and endpoint path are the version.

## Identifiers

- `device_id` is a UUID4 string. The device's TLS certificate CN equals
  `str(device_id)`. The broker derives `device_id` from the cert CN and
  enforces, via ACL, that the device can only publish on `dev/<that_id>/#`.
- `event_id` is a UUID4 generated **on the device**. Cloud never reassigns it.
- `cert_fingerprint` is the lowercase-hex SHA-256 of the DER-encoded X.509
  certificate. No colons, no uppercase. It is the primary key of `device_certs`.

## Time and units

- All `ts` fields are **Unix epoch seconds as a JSON number**, with millisecond
  precision allowed (e.g. `1745673600.123`). No ISO-8601 strings on the wire.
- All `*_db` / `*_dbm` fields are **floats**, dB referenced to 20 µPa (SPL) for
  acoustic values and to 1 mW for RF (`wifi_rssi_dbm`).
- Sizes are bytes, durations are seconds, temperatures are °C.
- Acoustic dB fields are bounded to `[-20.0, 200.0]` to catch obviously broken
  payloads (clipped mic, sign-flipped value) without rejecting real extremes.

## MQTT topic and endpoint table

| Topic / endpoint                          | Direction       | Cadence       | QoS / retained | Schema             |
|-------------------------------------------|-----------------|---------------|----------------|--------------------|
| `dev/{device_id}/tlm`                     | device → broker | 1 Hz          | QoS 0          | `Telemetry`        |
| `dev/{device_id}/health`                  | device → broker | 1/min         | QoS 1          | `Health`           |
| `dev/{device_id}/event/announce`          | device → broker | per event     | QoS 1          | `EventAnnounce`    |
| `dev/{device_id}/event/done`              | device → broker | per event     | QoS 1          | `EventDone`        |
| `dev/{device_id}/cmd/{cmd_name}`          | broker → device | on demand     | QoS 1          | `CommandEnvelope`  |
| `dev/{device_id}/lwt`                     | broker → fleet  | on disconnect | QoS 1 retained | `LastWill`         |
| `POST /api/v1/events/intent`              | device → API    | per event     | mTLS-derived JWT | `EventIntentRequest` → `EventIntentResponse` |
| `GET  /api/v1/events/{id}`                | client → API    | on demand     | session         | → `EventResponse`  |
| `GET  /api/v1/devices/{id}/telemetry`     | client → API    | on demand     | session         | → `TelemetryReadResponse` |
| `POST /api/v1/events/{id}/labels`         | client → API    | on demand     | session         | `LabelRequest` → `LabelResponse` |

The `cmd/+` wildcard accepts any single-segment command name; the envelope
declares which command was sent. Phase 1 commands: `rotate-cert`, `config`,
`reboot`. New commands are added by publishing under a new name — no schema
migration needed.

## MQTT payload schemas

### `dev/{device_id}/tlm` — Telemetry

```json
{
  "ts": 1745673600.123,
  "laeq": 58.4,
  "lafmax": 67.2,
  "lcpeak": 82.1
}
```

Required: `ts`, `laeq`, `lafmax`, `lcpeak`. `device_id` is taken from the
topic, **never** from the payload. The ingest worker MUST reject any payload
that includes a `device_id` field that disagrees with the topic (silent
mismatch is a footgun we are paying $0 to avoid).

### `dev/{device_id}/health` — Health

Required fields:

| Field             | Type    | Notes                                                  |
|-------------------|---------|--------------------------------------------------------|
| `ts`              | float   | Unix seconds                                           |
| `uptime_s`        | float   | ≥ 0                                                    |
| `cpu_pct`         | float   | 0–100                                                  |
| `cpu_temp_c`      | float   | °C                                                     |
| `mem_used_mb`     | float   | ≥ 0                                                    |
| `disk_free_mb`    | float   | ≥ 0                                                    |
| `wifi_rssi_dbm`   | float   | typical range -100 to 0                                |
| `queue_depth`     | int     | ≥ 0, store-and-forward depth                           |
| `queue_bytes`     | int     | ≥ 0                                                    |
| `mic_gain_db`     | float   | software calibration offset                            |
| `ntp_offset_ms`   | float   | from `chronyc tracking`                                |
| `fw_version`      | string  | semver or git-describe                                 |
| `config_version`  | string  | hash or revision of the active device config           |

### `dev/{device_id}/event/announce` — Event announcement

```json
{
  "event_id": "5b8e9b1c-1c8a-4c3d-9e0a-72c1d2e3f4a5",
  "ts": 1745673612.450,
  "duration_s": 15.0,
  "peak_db": 92.1,
  "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "size": 1572864,
  "content_type": "audio/flac"
}
```

Rules:

- `event_id` is a device-generated UUID4. Backend uses it as the idempotency
  key. Re-announcing the same `event_id` MUST NOT produce a second row.
- `sha256` is lowercase hex (64 chars) of the FLAC file the device will upload.
- `size` is bytes, ≤ `EVENT_MAX_SIZE_BYTES` (8 MiB Phase 1).
- `content_type` is `audio/flac` Phase 1. Anything else is rejected.

### `dev/{device_id}/event/done` — Upload completion

```json
{
  "event_id": "5b8e9b1c-1c8a-4c3d-9e0a-72c1d2e3f4a5",
  "storage_key": "events/2026/05/11/<device_id>/<event_id>.flac",
  "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "size": 1572864,
  "uploaded_at": 1745673618.901
}
```

Rules:

- Backend verifies `(event_id, sha256, size)` matches the announce/intent row.
  On mismatch the event transitions to `failed`; the device is expected to
  retry by re-announcing with the same `event_id`.
- Duplicate `done` messages on an already-`available` event are no-ops
  (idempotent).

### `dev/{device_id}/cmd/{cmd_name}` — Command envelope (broker → device)

```json
{
  "cmd_id": "9c1c8a5b-3d4e-4f5a-8b6c-7d8e9f0a1b2c",
  "cmd": "rotate-cert",
  "issued_at": 1745673600.0,
  "expires_at": 1745677200.0,
  "args": {}
}
```

- `cmd` MUST equal the last topic segment. The device verifies this; if they
  disagree, the command is dropped and logged.
- `expires_at` is optional. Commands without an expiry never expire on the
  device side — keep this for things like `reboot`.
- `args` is command-specific. Phase 1 the only command that uses args is
  `config` (carries a config blob); `rotate-cert` and `reboot` take no args.

### `dev/{device_id}/lwt` — Last will (broker-published, retained)

```json
{
  "device_id": "5b8e9b1c-1c8a-4c3d-9e0a-72c1d2e3f4a5",
  "status": "offline",
  "ts": 1745673600.0
}
```

`status` is exactly `"offline"`. The corresponding "online" signal is the
device's first telemetry publish after reconnect — we deliberately do not
introduce a separate `"online"` LWT, because it would race the broker's
own retained-LWT cleanup.

## REST endpoint schemas

### `POST /api/v1/events/intent`

Auth: device session JWT (issued via `POST /api/v1/devices/token` after mTLS).

Request:

```json
{
  "event_id": "5b8e9b1c-1c8a-4c3d-9e0a-72c1d2e3f4a5",
  "ts": 1745673612.450,
  "duration_s": 15.0,
  "peak_db": 92.1,
  "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "size": 1572864,
  "content_type": "audio/flac",
  "nonce": "f3a9c2b1e4d5"
}
```

Response (HTTP 200):

```json
{
  "event_id": "5b8e9b1c-1c8a-4c3d-9e0a-72c1d2e3f4a5",
  "status": "upload_intent_created",
  "upload_url": "https://audio.urban-acoustics.conexed.com/...",
  "storage_key": "events/2026/05/11/<device_id>/<event_id>.flac",
  "expires_at": 1745673672.0,
  "required_headers": {
    "Content-Type": "audio/flac",
    "x-amz-checksum-sha256": "..."
  }
}
```

Rules:

- The same `(device_id, event_id)` returns the same `storage_key` on retry.
  The `upload_url` itself is fresh (60-second TTL by default) so the device
  can always make progress, but it points at the same key.
- `nonce` is replay-protection: backend rejects re-use of the same
  `(device_id, nonce)` within 24 h. This protects the JWT lifetime, not the
  upload URL (which is already sha256-bound).
- On `(event_id, sha256, size)` mismatch with a prior announce, return 409.

### `GET /api/v1/events/{id}`

Auth: session cookie (Phase 1) or JWT (Phase 2).

Response:

```json
{
  "event_id": "5b8e9b1c-1c8a-4c3d-9e0a-72c1d2e3f4a5",
  "device_id": "1234abcd-...",
  "ts": 1745673612.450,
  "duration_s": 15.0,
  "peak_db": 92.1,
  "sha256": "e3b0c44...",
  "size": 1572864,
  "status": "available",
  "classification": null,
  "confidence": null,
  "model_version": null,
  "playback_url": "https://audio.urban-acoustics.conexed.com/...",
  "playback_url_expires_at": 1745673900.0
}
```

`playback_url` is only present when `status == "available"`. TTL = 300 s.
Classification fields are `null` in Phase 1 (populated in Phase 2).

### `GET /api/v1/devices/{id}/telemetry?from=&to=&res=`

Query params:

- `from`: Unix seconds, inclusive.
- `to`: Unix seconds, exclusive. Must be > `from`.
- `res`: one of `raw`, `1m`, `1h`. Default `1m`.

The backend serves `raw` from `telemetry_db`, `1m` and `1h` from continuous
aggregates. Window cap: 24 h for `raw`, 30 d for `1m`, 1 y for `1h`.

Response:

```json
{
  "device_id": "...",
  "resolution": "1m",
  "from_ts": 1745673600.0,
  "to_ts": 1745677200.0,
  "points": [
    {"ts": 1745673600.0, "laeq": 58.4, "lafmax": 67.2, "lcpeak": 82.1}
  ]
}
```

### `POST /api/v1/events/{id}/labels`

Request:

```json
{"label": "motorcycle"}
```

`label` is one of the fixed 9-class taxonomy: `motorcycle`, `car`,
`construction`, `helicopter`, `airplane`, `siren`, `dog`, `voice`, `other`.
Unknown labels are rejected — adding to the taxonomy is a deliberate, planned
event, not a frontend free-text field.

Response:

```json
{
  "event_id": "...",
  "label": "motorcycle",
  "created_at": 1745677300.0
}
```

## Event lifecycle

State machine for the `events.status` column:

```
           announce
              │
              ▼
       ┌──────────────┐
       │  announced   │
       └──────┬───────┘
              │ POST /events/intent
              ▼
 ┌────────────────────────┐    upload retry
 │ upload_intent_created  │◀──────────────┐
 └──────────┬─────────────┘               │
            │ event/done                  │
            ▼                             │
       ┌──────────┐  verify ok      ┌─────┴────┐
       │ uploaded │────────────────▶│ available│
       └────┬─────┘                 └──────────┘
            │ verify fail
            ▼
       ┌────────┐
       │ failed │
       └────────┘
```

Rules:

- `announce` is idempotent: re-publish of an `event_id` in any state is a
  no-op (state and stored hash/size preserved).
- `failed → upload_intent_created` is allowed on the *next* device retry, so
  a sha256 mismatch from a partial upload doesn't permanently brick the row.
- Only `uploaded` advances to `available`, and only after backend has fetched
  object metadata from MinIO and confirmed the recorded sha256 matches.
- The `available` state is terminal for Phase 1. Classification re-runs in
  Phase 2 don't move the state, they only fill the classification columns.

## Device identity and certificate fingerprints

Schema `DeviceIdentity`:

| Field              | Notes                                                       |
|--------------------|-------------------------------------------------------------|
| `device_id`        | UUID4. Stable for the life of the physical device.          |
| `cert_fingerprint` | SHA-256 of DER cert, lowercase hex, 64 chars. PK of `device_certs`. |
| `cert_subject_cn`  | Equals `str(device_id)`.                                    |
| `cert_not_before`  | Unix seconds.                                               |
| `cert_not_after`   | Unix seconds.                                               |

Rules:

- The MQTT broker, the API, and the ingest worker MUST all derive
  `device_id` from `cert_subject_cn` and reject any mismatch with payload
  contents.
- A device may have multiple non-revoked certs during rotation (24 h grace).
  The fingerprint, not the device_id, is what the cert lookup table is keyed
  by — this is why fingerprint is the PK, not a unique-index sidecar.

## Environment variables

These are the runtime knobs every Phase 1 service expects. The contract
module exports `ENV_VARS` as the authoritative list; settings.py reads them.

Backend / API:

| Variable                          | Required | Default            | Notes                                                |
|-----------------------------------|----------|--------------------|------------------------------------------------------|
| `DATABASE_URL`                    | yes      | —                  | `postgresql+asyncpg://...`                           |
| `MQTT_BROKER_URL`                 | yes      | —                  | `mqtts://mosquitto:8883`                             |
| `MQTT_CA_FILE`                    | yes      | —                  | Path to pinned root CA                               |
| `MQTT_CLIENT_CERT`                | yes      | —                  | Backend's MQTT mTLS cert                             |
| `MQTT_CLIENT_KEY`                 | yes      | —                  | Backend's MQTT mTLS key                              |
| `S3_ENDPOINT`                     | yes      | —                  | `https://minio:9000` internal                        |
| `S3_PUBLIC_ENDPOINT`              | yes      | —                  | `https://audio.urban-acoustics.conexed.com`          |
| `S3_ACCESS_KEY`                   | yes      | —                  |                                                      |
| `S3_SECRET_KEY`                   | yes      | —                  |                                                      |
| `S3_BUCKET`                       | yes      | —                  | e.g. `events`                                        |
| `S3_REGION`                       | no       | `us-east-1`        |                                                      |
| `JWT_SECRET`                      | yes      | —                  | HS256 in Phase 1, swap to RS256 in Phase 2           |
| `JWT_TTL_SECONDS`                 | no       | `3600`             |                                                      |
| `DEVICE_CERT_TTL_DAYS`            | no       | `365`              | First-cert TTL is 1 d, rotated to this on first refresh |
| `EVENT_MAX_SIZE_BYTES`            | no       | `8388608`          | 8 MiB                                                |
| `EVENT_INTENT_TTL_SECONDS`        | no       | `60`               | Presigned PUT TTL                                    |
| `EVENT_PLAYBACK_URL_TTL_SECONDS`  | no       | `300`              |                                                      |
| `DEMO_MODE`                       | no       | `0`                | `1` enables `/api/v1/demo/*` synthetic endpoints     |
| `ALLOWED_ORIGINS`                 | yes      | —                  | Comma-separated. **Never `*` in prod.**              |
| `LOG_LEVEL`                       | no       | `INFO`             |                                                      |

Device firmware reads its broker URL, MQTT mTLS material, and per-device
config from disk after provisioning — not from env vars — so the device side
of this table is intentionally empty.

## Acceptance

The `contracts.py` module and the fixtures in `backend/tests/fixtures/` are
the executable form of this document. CI runs the contract tests; if a
fixture and the schema disagree, the build fails before any other test
runs.
