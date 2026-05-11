# 06 - Pi Zero Firmware Minimal First

## Goal

Replace the current `record.sh` WAV-loop recorder with a single Python supervisor that captures audio, computes 1 Hz acoustic telemetry, detects events, encodes event FLACs, and uploads them through the Phase 1 cloud path.

The Pi milestone is complete when one real Pi runs for 24 hours, survives WiFi loss, and publishes telemetry plus event uploads without manual intervention.

## Scope

- Keep `arecord` as the capture mechanism.
- Implement a single Python supervisor process.
- Use static config and pre-issued certs for the first milestone.
- Add SQLite store-and-forward.
- Add systemd service and cleanup timer.
- Add chrony configuration.
- Defer AP-mode/captive-portal provisioning to Task 08.

## Deliverables

Under `raspberry-pi-zero-2w/`:

- `pyproject.toml`
- `urban_acoustics/__main__.py`
- `urban_acoustics/supervisor.py`
- `urban_acoustics/capture.py`
- `urban_acoustics/ringbuffer.py`
- `urban_acoustics/dsp.py`
- `urban_acoustics/detector.py`
- `urban_acoustics/encoder.py`
- `urban_acoustics/telemetry.py`
- `urban_acoustics/uploader.py`
- `urban_acoustics/transport.py`
- `urban_acoustics/queue_store.py`
- `urban_acoustics/config.py`
- `urban_acoustics/calibration.py`
- `urban_acoustics/health.py`
- `systemd/urban-acoustics.service`
- `systemd/urban-acoustics-cleanup.timer`
- `chrony/chrony.conf`
- updated `README.md`

## Implementation Order

1. Capture raw PCM from `arecord` stdout.
2. Add ringbuffer and block timing.
3. Compute basic RMS-derived telemetry.
4. Publish telemetry over MQTT.
5. Add health publishing.
6. Add SQLite queue for store-and-forward.
7. Add event detection and pre/post-roll extraction.
8. Encode FLAC events.
9. Add upload intent, PUT, and event done flow.
10. Add systemd hardening and memory limits.

## DSP Requirements

- Use numpy only for Phase 1 DSP.
- Avoid scipy on the Pi Zero 2 W memory budget.
- Compute:
  - LAeq
  - LAFmax
  - LCpeak
- Apply calibration offset.
- Make thresholds configurable.

## Store-And-Forward

SQLite WAL database at `/var/lib/urban-acoustics/queue.db`.

Minimum tables:

- queued MQTT messages
- pending event uploads

Required behavior:

- Survive power loss.
- Retry with exponential backoff.
- Cap local disk use.
- Drop oldest non-event data first under pressure.

## Dependencies

- Task 01 contracts.
- Task 05 simulator path should pass before hardware work becomes the critical path.

## Acceptance Criteria

- Pi publishes 1 Hz telemetry for 24 hours.
- Pi publishes health every minute.
- Event FLAC uploads appear in MinIO and backend event rows.
- WiFi outage queues telemetry/events and drains on reconnect.
- Supervisor RSS remains below configured memory cap.
- `arecord` crash is detected and restarted.
- `journalctl -u urban-acoustics.service` logs enough context to debug failures.

## Risks

- Audio format conversion from INMP441 S32_LE to analysis samples must be tested carefully.
- A-weighting and calibration should be validated against known tones or a reference meter when available.
- Do not introduce multiple Python services on the Pi; memory headroom is limited.
