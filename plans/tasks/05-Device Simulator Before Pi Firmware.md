# 05 - Device Simulator Before Pi Firmware

## Goal

Build a software device simulator before replacing the Pi recorder. This validates the cloud contracts, MQTT ACLs, event upload flow, and frontend real-data path without requiring hardware.

The simulator milestone is complete when it can produce a full telemetry and event upload cycle using the same auth and contracts expected from the Pi.

## Scope

- Publish 1 Hz telemetry over MQTT.
- Publish periodic health messages.
- Announce an event.
- Request an upload intent from the backend.
- Upload a small FLAC fixture to MinIO using the presigned URL.
- Publish event done.
- Support basic failure-mode testing.

## Deliverables

- `tools/device_sim.py` or `backend/tools/device_sim.py`
- Small FLAC fixture under a test/fixtures directory
- Example device cert/key usage
- README instructions for running one simulated device
- Optional Make target or script wrapper

## Simulator Behavior

Inputs:

- Device ID
- MQTT broker host/port
- CA certificate
- Device certificate
- Device private key
- API base URL
- Event fixture path

Telemetry:

- Publish every second to `dev/{device_id}/tlm`.
- Generate plausible LAeq/LAFmax/LCpeak values.
- Include occasional threshold spikes.

Health:

- Publish every minute to `dev/{device_id}/health`.
- Include queue depth and firmware version fields even if simulated.

Event:

- Trigger on command-line flag, timer, or generated spike.
- Publish announce.
- Call `POST /api/v1/events/intent`.
- PUT fixture bytes to returned URL.
- Publish done.

Failure Modes:

- Bad payload mode.
- Duplicate event announce mode.
- Duplicate done mode.
- Wrong device topic mode to test ACL denial.

## Dependencies

- Task 01 contracts.
- Task 02 cloud foundation.
- Task 03 event intent API.
- Task 04 ingest worker.

## Acceptance Criteria

- Simulator publishes telemetry that appears in the database.
- Simulator publishes health that appears in the database.
- Simulator uploads one event object to MinIO.
- Event row reaches `available` or equivalent final state.
- Playback URL returns the uploaded object.
- Wrong-topic publish is rejected by broker ACLs.
- Duplicate event messages do not duplicate database rows.

## Notes

- The simulator is not throwaway. Keep it as the dev and CI replacement for real Pi hardware.
- Avoid hardware-specific assumptions in shared contract code.
