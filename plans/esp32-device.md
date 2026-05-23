# Urban Acoustics — ESP32 + INMP441 as a Second Device Type

## Context

Today the only sensor in the fleet is the Raspberry Pi Zero 2 W, running the
single-process Python supervisor under [raspberry-pi-zero-2w/urban_acoustics/](../raspberry-pi-zero-2w/urban_acoustics/).
The cloud-side contracts in [plans/phase-1-contracts.md](phase-1-contracts.md)
are deliberately wire-level: an MQTT topic tree, a small REST surface, and an
mTLS identity whose cert CN equals `device_id`. Any device that can speak
those contracts is a valid sensor. This plan adds an ESP32-S3 + INMP441
implementation as a second, cheaper, lower-power class of device.

**Why bother:**

- BOM is ~$10 vs. ~$35 for a Pi Zero 2 W + SD card + PSU.
- Power draw is ~150 mW idle vs. ~1.5 W for the Pi — opens up PoE-splitter
  and solar deployments.
- No filesystem to corrupt on power loss; NVS + littlefs are designed for it.
- A second hardware target forces us to keep the contracts honest and catches
  any Pi-specific assumptions that have leaked into the cloud.

**Non-goals for this plan:**

- Continuous Opus streaming (Phase 2 of the cloud roadmap, deferred for all
  device types).
- Replacing the Pi. Both device types coexist; the Pi remains the
  reference / high-fidelity unit.

## Hardware

ESP32-S3 with **≥ 2 MB PSRAM** (e.g. ESP32-S3-DevKitC-1-N8R8, or any
WROOM-1U module with the `-R8` PSRAM suffix). Plain ESP32 without PSRAM
will not fit the pre-roll ring buffer + TLS + MQTT working sets and is
explicitly out of scope.

| INMP441 Pin | ESP32-S3 Pin    | Notes                              |
|-------------|-----------------|------------------------------------|
| VDD         | 3.3 V           |                                    |
| GND         | GND             |                                    |
| WS (LRCLK)  | GPIO 4 (any)    | Configured in `i2s_std_gpio_config_t` |
| SCK (BCLK)  | GPIO 5 (any)    |                                    |
| SD (DOUT)   | GPIO 6 (any)    |                                    |
| L/R         | GND             | Left-channel only (same as Pi)     |

Pin choices above are illustrative — the ESP32-S3 GPIO matrix lets you route
I2S to almost any pin. Avoid the strapping pins (0, 3, 45, 46) and anything
the USB-JTAG bridge needs (19, 20).

## What's stable vs. what changes

### Stable (no contract changes)

Every cloud-facing surface in [plans/phase-1-contracts.md](phase-1-contracts.md)
stays exactly as-is:

- MQTT topic tree (`dev/{device_id}/tlm`, `/health`, `/event/announce`,
  `/event/done`, `/cmd/{cmd_name}`, `/lwt`).
- mTLS identity model (cert CN = `device_id`, fingerprint as cert PK).
- REST: `POST /api/v1/events/intent` → presigned PUT → `event/done`.
- Telemetry units, dB references, time format (Unix epoch seconds, ms
  precision), schema field names and types.
- `EVENT_MAX_SIZE_BYTES = 8 MiB` and `EVENT_INTENT_TTL_SECONDS = 60`.

If a contract change is needed to ship the ESP32 firmware, it goes in the
"Contract delta" section below and gets PR'd to `contracts.py` and the
fixtures **before** the firmware work starts.

### Contract delta — one decision required

The only sticking point is event audio encoding. Today
[backend/app/contracts.py:97](../backend/app/contracts.py#L97) and
[backend/app/contracts.py:173](../backend/app/contracts.py#L173) pin
`content_type` to `Literal["audio/flac"]`. FLAC on an ESP32-S3 is doable
(libFLAC will link, ~70 KB code, heap-hungry) but it's the single biggest
risk in the firmware port. Three options:

| Option | Contract change | Cloud change | Firmware change | Tradeoff |
|---|---|---|---|---|
| **A. Opus** | Widen `content_type` to `Literal["audio/flac", "audio/ogg; codecs=opus"]` | `intent` handler accepts both; storage_key suffix follows content_type | Use ESP-ADF Opus encoder (~30 KB heap, well-supported on ESP32-S3) | Lossy. ~16–24 kbps for our use case is fine and ~10× smaller than FLAC. |
| **B. WAV + cloud transcode** | Widen to include `audio/wav` | Add a small worker that transcodes WAV → FLAC on ingest before flipping state to `available` | Just write the PCM header; no encoder | Simplest device side, more cloud moving parts. WAV during upload is ~5× FLAC bytes. |
| **C. FLAC on device** | None | None | Cross-compile libFLAC for Xtensa, manage heap carefully | No contract churn. Highest device-side risk. |

**Recommendation: A (Opus).** It's the most honest about what a small
device should be doing, the encoder is already part of ESP-ADF, and widening
the `Literal` is a one-line, backwards-compatible contract change (Pi
firmware keeps shipping FLAC).

## Firmware architecture

The ESP32 firmware mirrors the Pi supervisor's component shape so the two
implementations can be reasoned about side-by-side. Same boxes, different
language and runtime.

```
esp32/
├── main/
│   ├── app_main.c            # boot, NVS init, WiFi up, start tasks
│   ├── capture.c             # I2S DMA → 1 s PCM blocks
│   ├── ringbuffer.c          # PSRAM pre-roll
│   ├── dsp.c                 # IIR A/C weighting, LAeq/LAFmax/LCpeak
│   ├── detector.c            # threshold + hysteresis (port of detector.py)
│   ├── encoder_opus.c        # libopus via ESP-ADF
│   ├── telemetry.c           # MQTT publish at 1 Hz
│   ├── health.c              # MQTT publish at 1/min
│   ├── uploader.c            # intent → PUT → done
│   ├── transport_mqtt.c      # ESP-MQTT + mTLS
│   ├── transport_http.c      # esp_http_client + mTLS
│   ├── queue_store.c         # littlefs ring of pending payloads
│   ├── config.c              # NVS config blob
│   └── calibration.c         # mic sensitivity + per-device trim
├── components/
│   └── (vendored as needed)
├── partitions.csv            # factory, ota_0, ota_1, nvs, nvs_keys, littlefs
└── sdkconfig.defaults
```

### Task graph (FreeRTOS)

| Task | Priority | Stack | Purpose |
|---|---|---|---|
| `i2s_capture` | high | 4 KB | DMA descriptor service, push PCM into ringbuffer queue |
| `dsp_telemetry` | high | 8 KB | Consume 1 s blocks, compute weighted dB, publish to `tlm` |
| `detector` | mid | 4 KB | Feed on LAFmax, open/close events |
| `encoder` | mid | 8 KB | Pull window from ringbuffer, encode Opus, hand to uploader |
| `uploader` | mid | 6 KB | intent → PUT → done state machine, retry with backoff |
| `health` | low | 4 KB | 1/min sysinfo publish |
| `mqtt_event` | (ESP-MQTT internal) | 6 KB | paho equivalent |
| `wifi_event` | (system) | — | connect / reconnect, NTP kick on connect |

A single bounded queue (FreeRTOS queue or RingBuf) sits between
`i2s_capture` and `dsp_telemetry`. The detector reads from the DSP
output, not the raw stream, so it sees the same LAFmax values the cloud
sees — important for being able to reproduce a "why didn't this trigger"
investigation.

### DSP parity with the Pi

The Pi uses an FFT-based weighting in [dsp.py](../raspberry-pi-zero-2w/urban_acoustics/dsp.py)
because numpy makes it free. On a 240 MHz Xtensa LX7 with no FPU vector
unit, FFT is wasteful for this. Use **second-order IIR biquads** instead:

- A-weighting: standard IEC 61672 biquad cascade (4 biquads in series).
- C-weighting: same family, simpler (2 biquads).
- LAFmax: 125 ms exponential envelope on the A-weighted signal.
- LCpeak: instantaneous peak on the C-weighted signal, per-second max.

Calibration constants must match the Pi exactly: the INMP441 datasheet
gives -26 dBFS at 94 dB SPL @ 1 kHz, so `sensitivity_offset_db = 120 dB`
is identical regardless of host MCU. The per-device `mic_gain_db` trim
still applies. Unit tests should feed the same WAV through both
implementations and require `|LAeq_pi - LAeq_esp| < 0.1 dB`.

### Provisioning

The Pi flow puts cert + key + config at `/etc/urban-acoustics/`. The
ESP32 equivalent:

- `device.crt`, `device.key`, `root-ca.crt` → encrypted NVS partition
  (`nvs_keys` + flash encryption enabled).
- `config.json` → NVS as a single blob, schema mirrors
  [config.py](../raspberry-pi-zero-2w/urban_acoustics/config.py).
- `device_id` is derivable from the cert CN at runtime — do not store it
  separately, same rule as the Pi.

Initial provisioning is via the same out-of-band channel we already use
for the Pi (the cert-issuing CA is the source of identity). Field
flashing happens over USB-CDC the first time and over OTA after that.

### OTA

ESP-IDF's `esp_https_ota` over the existing API host with two `ota_0` /
`ota_1` slots, gated by a `cmd/ota` command published over MQTT
(broker → device). This is a **new command name** in the
`dev/{device_id}/cmd/{cmd_name}` tree, not a contract change — per
[plans/phase-1-contracts.md:55-58](phase-1-contracts.md#L55-L58), new
commands are added by publishing under a new name, no schema migration.
Args: `{"url": "...", "sha256": "...", "fw_version": "..."}`.

The Pi has no equivalent today (it's `git pull` + `systemctl restart`),
so OTA is genuinely new surface area, not a per-device-type concern. We
can leave Pi OTA out of scope and only wire it for ESP32 in this round.

### Health payload

Same schema as the Pi ([phase-1-contracts.md:80-96](phase-1-contracts.md#L80-L96)).
ESP32-specific sourcing:

| Field | Pi source | ESP32 source |
|---|---|---|
| `cpu_pct` | `/proc/stat` | FreeRTOS runtime stats (`uxTaskGetSystemState`) |
| `cpu_temp_c` | `/sys/class/thermal` | `temperature_sensor_get_celsius` (on-die) |
| `mem_used_mb` | `psutil.virtual_memory` | `esp_get_free_heap_size` inverted |
| `disk_free_mb` | `os.statvfs` | littlefs free-blocks |
| `wifi_rssi_dbm` | `iw dev`             | `esp_wifi_sta_get_ap_info` |
| `ntp_offset_ms` | `chronyc tracking`    | last SNTP step magnitude |
| `queue_depth/bytes` | sqlite queue | littlefs queue file count + size |

No new fields, no missing fields — the schema is identical on the wire.

## Cloud-side work

Small. The only required cloud change is the Opus content-type widening
under "Contract delta" above. Everything else already routes by
`device_id`.

Nice-to-have (not blocking):

- Add a `device_class` column to the `devices` table (`pi-zero-2w` |
  `esp32-s3`). Populated from a one-time `cmd/identify` round-trip or
  from a new optional `device_class` field in `Health`. Useful for
  dashboards but not required for ingest.
- Frontend: tag historical event clips with their source device class in
  the inspector. Pure UI; nothing about the data path changes.

## Task list

The order matters — contract and simulator come **before** firmware,
mirroring [plans/tasks/05-Device Simulator Before Pi Firmware.md](tasks/05-Device%20Simulator%20Before%20Pi%20Firmware.md).

1. **Contract delta PR.** Widen `EventAnnounce.content_type` and
   `EventIntentRequest.content_type` to also accept
   `"audio/ogg; codecs=opus"`. Add Opus fixture under
   `backend/tests/fixtures/`. Cloud `intent` handler routes
   `storage_key` suffix off `content_type`.
2. **Cloud transcode-on-ingest decision.** Either store Opus as-is
   (simpler) or transcode to FLAC in the ingest worker for archival
   parity with the Pi. Recommend store-as-is; the device class is
   recorded on the event row.
3. **`device_class` column** (optional, can defer).
4. **Bench-test INMP441 on a dev board.** Get clean 48 kHz S32_LE I2S
   into a host buffer and confirm a tone at 1 kHz, 94 dB SPL gives
   -26 dBFS RMS. This is the calibration gate — fix it before writing
   anything else.
5. **DSP port + parity test.** Translate
   [dsp.py](../raspberry-pi-zero-2w/urban_acoustics/dsp.py) to C
   biquads. Run both implementations on the same WAV corpus, require
   < 0.1 dB LAeq deviation.
6. **Detector port.** Direct translation of
   [detector.py](../raspberry-pi-zero-2w/urban_acoustics/detector.py)
   plus a unit test that feeds it the same LAFmax sequences the Pi
   tests use.
7. **Transport + MQTT skeleton.** `transport_mqtt.c` connects with
   mTLS, publishes hand-crafted telemetry every second. Verify against
   the existing devlab Mosquitto.
8. **Health task.**
9. **Encoder + uploader.** Opus encode a fixed-length window, run the
   intent → PUT → done state machine end-to-end against staging.
10. **Store-and-forward queue.** Pull WiFi for 5 minutes, confirm the
    drain on reconnect matches the Pi's behaviour (telemetry replays
    in order, events replay in order, queue caps don't OOM).
11. **OTA.** New `cmd/ota` command name, two-slot flash, signature
    check.
12. **Field unit.** One device on PoE on the same pole as the Pi for
    a week. Diff their telemetry; investigate any per-minute LAeq
    deviation > 0.5 dB.

## Risks and unknowns

- **TLS heap pressure.** mbedTLS handshake on ESP32-S3 needs ~32 KB of
  heap during the handshake itself. Combined with MQTT keepalive and a
  parallel HTTPS upload, it's tight. Mitigate with session resumption
  (`MBEDTLS_SSL_SESSION_TICKETS`) and serialising "MQTT handshake" vs.
  "uploader handshake" through a mutex.
- **Clock discipline.** SNTP on a flaky WiFi link can step the clock
  by several seconds. The `ts` field on telemetry must monotonically
  advance — buffer briefly across a step, or drop the affected
  second's payload rather than publishing an out-of-order `ts`.
- **PSRAM bandwidth.** Pre-roll lives in PSRAM (slower than SRAM).
  Confirm DSP can keep up at 48 kHz — if not, downsample to 24 kHz for
  ringbuffer storage and keep the LCpeak path on the 48 kHz live
  signal.
- **Calibration drift across two mic batches.** INMP441 datasheet
  tolerance is ±1 dB. The per-device `mic_gain_db` trim already handles
  this on the Pi, but we should re-check the calibration procedure
  works for a unit we never SSH into.

## Acceptance

The ESP32 device class is "done" when:

- A field unit publishes 1 Hz telemetry and 1/min health to the same
  Mosquitto the Pi uses, indistinguishable on the wire.
- An event triggered on the Pi and an event triggered on the colocated
  ESP32, within ±0.5 dB of the same source, both reach `available`
  state in the backend.
- A `cmd/ota` round-trip upgrades the firmware without manual
  intervention.
- The contract test suite still passes — the contract delta is the
  *only* difference, and it's covered by a fixture.
