# 02 - Devlab Cloud Foundation

## Goal

Stand up the Phase 1 cloud substrate in the existing devlab environment: Timescale/Postgres for telemetry and relational state, Mosquitto for MQTT, MinIO for event audio, and Traefik routes for device-facing services.

The foundation is complete when containers boot reliably and a cert-authenticated test client can publish MQTT telemetry, request an event upload intent, and upload an object to MinIO.

## Scope

- Extend the app-local `docker-compose.yml`.
- Do not edit `/home/mikeg/dev/devlab/docker-compose.yml`.
- Join all routed app services to `dev_conexed_com_default`.
- Add Traefik dynamic config files under `/home/mikeg/dev/devlab/traefik/dynamic/`.
- Add Mosquitto configuration, persistence, TLS, and ACL files.
- Add MinIO bucket initialization.
- Add Postgres/Timescale storage volumes.

## Deliverables

- Updated `docker-compose.yml` services:
  - `backend`
  - `ingest`
  - `postgres`
  - `mosquitto`
  - `minio`
  - optional `minio-init`
- `backend/mosquitto/mosquitto.conf`
- `backend/mosquitto/aclfile`
- `backend/certs/` dev certificate generation script or documented process
- Traefik dynamic files:
  - `urban-acoustics-api.yml`
  - `urban-acoustics-minio.yml`
  - `urban-acoustics-mqtt.yml`, if MQTT is exposed through Traefik TCP routing

## Implementation Notes

### Compose

The `backend` container should continue serving FastAPI. The MQTT consumer should run as a separate `ingest` process using the same image with a different command. This isolates ingestion from Uvicorn reloads and API crashes.

Postgres and MinIO should use named volumes. Mosquitto should persist sessions and QoS 1 state.

### Mosquitto

Phase 1 broker config should include:

- TLS listener on `8883`
- `require_certificate true`
- CA file, server cert, and server key paths
- persistence enabled
- ACL file limiting devices to their own topic namespace

Minimum ACL behavior:

- Device certificate for `device-a` can publish `dev/device-a/#`.
- Same certificate cannot publish `dev/device-b/#`.
- Bootstrap/provisioning ACLs must be narrow if provisioning is included later.

### Traefik

Follow the current devlab file-provider pattern:

- HTTP router redirects to HTTPS.
- HTTPS router uses wildcard certs from `tls-certificates.yml`.
- Service points to the container hostname on `dev_conexed_com_default`.

Existing `urban-acoustics.yml` routes the frontend. Add separate service files for API and MinIO to avoid mixing frontend Vite routing with device API routing.

## Dependencies

- Task 01 contracts should be at least drafted.

## Acceptance Criteria

- `docker compose up` starts all Phase 1 cloud services.
- Backend can connect to Postgres.
- Backend can create or verify the MinIO event bucket.
- A TLS MQTT client can connect to Mosquitto.
- A valid device cert can publish to its own topic.
- The same cert is denied when publishing to another device topic.
- MinIO presigned PUT works from outside the backend container.
- Traefik routes API and MinIO over HTTPS.

## Risks

- MQTT over Traefik TCP with mTLS passthrough is more sensitive than HTTP routing. Validate early.
- Wildcard devlab certs cover HTTPS hosts, but Mosquitto mTLS still needs broker-side CA and server certificates.
- Avoid mounting private keys into more containers than necessary.
