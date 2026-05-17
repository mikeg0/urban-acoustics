# Device tools

## `device_sim.py` — software replacement for the Pi recorder

Phase 1 cloud development and CI run against this simulator instead of real
hardware. It speaks the same wire contracts the firmware will (`app.contracts`),
so anything the cloud accepts from `device_sim.py` will accept from a Pi, and
vice-versa.

### What it does

- Connects to Mosquitto over mTLS using a device cert from `backend/certs/devices/`.
- Publishes telemetry to `dev/{device_id}/tlm` at 1 Hz.
- Publishes health to `dev/{device_id}/health` once a minute.
- Runs the full event flow on a timer (or once on `--once`):
  1. `event/announce` on MQTT.
  2. `POST /api/v1/events/intent` over HTTP with `X-Device-Id`.
  3. `PUT` of the FLAC fixture bytes to the returned presigned URL.
  4. `event/done` on MQTT.
- Models a noisy acoustic baseline with diurnal drift and occasional spikes;
  natural spikes (LAeq ≥ 90 dB) also trigger an event flow on their own.

### Prerequisites

The dev compose stack must be up (`docker compose up`) and the device must
be registered so the API and ingest worker recognise it:

```
docker compose exec backend python -m scripts.register_device \
    --device-id 00000000-0000-4000-8000-00000000000a \
    --cert /app/certs/devices/00000000-0000-4000-8000-00000000000a.crt \
    --name "fixture-device-a" --location "Riverton / Canal & 7th"
```

`backend/certs/gen-dev-certs.sh` already produces fixture device certs for
the two stable UUIDs `…000a` and `…000b`.

### Run inside the compose stack (preferred)

```
docker compose run --rm --entrypoint "" backend \
    python -m tools.device_sim \
        --device-id 00000000-0000-4000-8000-00000000000a \
        --api-base http://backend:8000 \
        --once
```

Default cert paths (`/app/certs/...`) and broker host (`mosquitto:8883`)
already match the compose service names; only the device id is required.

For a long-running simulator (Ctrl-C to stop):

```
docker compose run --rm --entrypoint "" backend \
    python -m tools.device_sim \
        --device-id 00000000-0000-4000-8000-00000000000a \
        --event-interval 60
```

### Run from the host

Mosquitto is exposed on `localhost:8883`; the API is fronted by Traefik
(`https://urban-acoustics.dev.conexed.com`) or whatever you've routed it
to. Point the simulator at the host paths:

```
python -m backend.tools.device_sim \
    --device-id 00000000-0000-4000-8000-00000000000a \
    --broker-host localhost --broker-port 8883 \
    --ca   backend/certs/root-ca.crt \
    --cert backend/certs/devices/00000000-0000-4000-8000-00000000000a.crt \
    --key  backend/certs/devices/00000000-0000-4000-8000-00000000000a.key \
    --api-base http://localhost:8000 \
    --fixture backend/tests/fixtures/event_audio/silence.flac \
    --once
```

(Requires `paho-mqtt`, `httpx`, and `pydantic` from `backend/requirements.txt`.)

### Failure modes

Pass one of these to exercise a negative path on the cloud side:

| Flag                          | Effect                                                                                  |
| ----------------------------- | --------------------------------------------------------------------------------------- |
| `--bad-payload`               | One telemetry message with `laeq` out of range — ingest logs a validation error and increments `validation_errors`. |
| `--dup-announce`              | Sends the same `event/announce` twice — DB row count must remain 1.                     |
| `--dup-done`                  | Sends the same `event/done` twice — second one is a no-op (idempotent).                 |
| `--wrong-topic <other-uuid>`  | Publishes an `event/announce` to *another* device's topic using *this* device's cert. The broker's ACL must deny it; Mosquitto disconnects, paho reconnects. |

### Acceptance criteria (task 05)

After one `--once` run with a registered device the following should hold:

- New rows in `telemetry_db` for the device.
- New rows in `device_health`.
- One object in MinIO at `events/YYYY/MM/DD/{device_id}/{event_id}.flac`.
- `events.status = 'available'` for that event_id (intent → uploaded →
  available; the API marks `available` lazily on the first playback URL
  request, so `GET /api/v1/events/{id}` triggers it).
- `GET /api/v1/events/{id}/playback-url` returns a URL whose contents
  equal the fixture bytes.
- `devices.last_seen` advances.

Run with `--bad-payload`, `--dup-announce`, `--dup-done`, and
`--wrong-topic` separately to confirm the remaining acceptance criteria.

### Fixture

`backend/tests/fixtures/event_audio/silence.flac` is a 42-byte minimal FLAC
file (`fLaC` magic + a single STREAMINFO block declaring 8 kHz mono 16-bit
silence). It's enough for the upload roundtrip and playback URL check; if
you need a real recording, drop it in next to `silence.flac` and pass
`--fixture` explicitly.
