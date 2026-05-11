# 04 - MQTT Ingest Worker

## Goal

Implement a dedicated MQTT ingest worker that consumes device telemetry, health, and event lifecycle messages from Mosquitto and writes them to Timescale/Postgres.

The ingest milestone is complete when simulator-published data lands in the database continuously and invalid messages do not stop the worker.

## Scope

- Add an ingest worker entrypoint separate from FastAPI.
- Subscribe to Phase 1 MQTT topics.
- Validate incoming payloads against shared contracts.
- Batch telemetry writes.
- Persist health rows and update device liveness.
- Persist event announce/done messages idempotently.
- Emit Postgres `NOTIFY` messages for live dashboard updates.

## Deliverables

- `backend/app/ingest/__init__.py`
- `backend/app/ingest/mqtt.py`
- Worker command in Compose, for example `python -m app.ingest.mqtt`
- Structured logging for message validation failures and reconnects
- Tests or simulator scripts proving insert behavior

## Topic Handling

### `dev/{device_id}/tlm`

- QoS 0.
- Validate telemetry payload.
- Batch insert into `telemetry_db`.
- Update in-memory last-seen state and periodically persist `devices.last_seen_at`.

### `dev/{device_id}/health`

- QoS 1.
- Validate health payload.
- Insert into `device_health`.
- Update `devices.last_seen_at`.

### `dev/{device_id}/event/announce`

- QoS 1.
- Validate event metadata.
- Insert or update event row.
- Preserve idempotency by `event_id`.

### `dev/{device_id}/event/done`

- QoS 1.
- Validate upload completion payload.
- Mark event uploaded or available.
- Do not duplicate rows on repeated messages.

### `dev/{device_id}/lwt`

- QoS 1 retained.
- Record disconnected status if enabled in broker config.

## Batching

Start with one of these simple policies:

- Flush telemetry once per second.
- Flush earlier if batch size reaches a configured threshold.

Do not prematurely introduce Vector in Phase 1. The worker can be replaced by Vector in Phase 2 after contracts and database semantics are proven.

## Dependencies

- Task 01 contracts.
- Task 02 cloud foundation.
- Task 03 database schema.

## Acceptance Criteria

- Simulator can publish telemetry at 1 Hz for 10 minutes with no worker crash.
- Telemetry rows appear in `telemetry_db`.
- Health rows appear in `device_health`.
- `devices.last_seen_at` updates.
- Duplicate event announce and done messages are idempotent.
- Invalid payloads are logged and skipped.
- Mosquitto restart triggers reconnect with backoff.
- Worker restart does not corrupt event state.

## Risks

- Paho callbacks must not block on slow database writes. Use an internal queue or async handoff.
- Backpressure should be visible in logs and health metrics.
- Do not hide validation failures; field issues on devices must be easy to diagnose.
