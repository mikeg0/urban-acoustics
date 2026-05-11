# 03 - Backend Persistence And API

## Goal

Replace the current synthetic-only FastAPI backend with a real Phase 1 API backed by Timescale/Postgres and MinIO, while keeping the existing demo path available behind `DEMO_MODE=1`.

The backend milestone is complete when devices, telemetry, events, labels, and signed playback/upload flows are persisted and queryable through `/api/v1/*`.

## Scope

- Add application settings.
- Add async database access.
- Add ORM models and Alembic migrations.
- Add MinIO/S3 storage abstraction.
- Add `/api/v1` routers.
- Preserve current seeded JSON endpoints when demo mode is enabled.
- Replace wildcard CORS with explicit allowed origins.

## Deliverables

New or modified backend files:

- `backend/app/settings.py`
- `backend/app/db.py`
- `backend/app/models.py`
- `backend/app/storage.py`
- `backend/app/api/v1/devices.py`
- `backend/app/api/v1/telemetry.py`
- `backend/app/api/v1/events.py`
- `backend/app/api/v1/labels.py`
- `backend/app/api/v1/health.py`
- `backend/app/auth/device.py`
- `backend/app/auth/user.py`, stubbed for Phase 1
- `backend/alembic.ini`
- `backend/app/migrations/`
- updated `backend/app/main.py`
- updated `backend/requirements.txt`

## Database Schema

Minimum tables:

- `devices`
- `device_certs`
- `telemetry_db`
- `device_health`
- `events`
- `labels`

Minimum Timescale behavior:

- `telemetry_db` is a hypertable partitioned by `ts`.
- Raw telemetry retention is documented.
- Continuous aggregates for 1 minute and 1 hour are either implemented or explicitly deferred behind an API-compatible query layer.

## API Endpoints

### Devices

- Register a dev Phase 1 device.
- Fetch one device.
- List devices visible to the current user or dev environment.

For first delivery, use a dev/admin registration script or endpoint. Full claim-code factory provisioning belongs in Task 08.

### Telemetry

- `GET /api/v1/devices/{id}/telemetry?from&to&res`
- Return database telemetry, not synthetic data.
- Support at least raw and 1 minute resolution.

### Events

- `POST /api/v1/events/intent`
- `GET /api/v1/events`
- `GET /api/v1/events/{id}`
- `GET /api/v1/events/{id}/playback-url`

Intent behavior:

- Validate device identity.
- Validate event metadata.
- Allocate stable object key.
- Return short-lived presigned PUT URL.
- Store `upload_intent_created` state.

### Labels

- `POST /api/v1/events/{id}/labels`
- Store one of the Phase 1 taxonomy labels:
  - `motorcycle`
  - `car`
  - `construction`
  - `helicopter`
  - `airplane`
  - `siren`
  - `dog`
  - `voice`
  - `other`

## Dependencies

- Task 01 contracts.
- Task 02 cloud foundation.

## Acceptance Criteria

- Migrations create all required tables from an empty database.
- `GET /api/health` still works.
- `/api/v1/health` reports database and storage connectivity.
- `POST /api/v1/events/intent` creates an event row and returns a bounded presigned URL.
- `GET /api/v1/devices/{id}/telemetry` returns rows inserted by tests or the simulator.
- Demo endpoints remain available when `DEMO_MODE=1`.
- Wildcard CORS is removed from non-demo configuration.

## Risks

- Do not block this task on perfect auth. Use a narrow dev identity path first, then harden in Task 08.
- Keep storage access behind `storage.py` so Phase 3 can swap MinIO for R2 without API changes.
