# Urban Acoustics — BLE-Only Sensor as a Third Device Type

## Context

The fleet has two WiFi-connected device classes today: the reference
Raspberry Pi Zero 2 W in [raspberry-pi-zero-2w/urban_acoustics/](../raspberry-pi-zero-2w/urban_acoustics/)
and the planned ESP32-S3 in [plans/esp32-device.md](esp32-device.md). Both
speak the wire-level contracts in [plans/phase-1-contracts.md](phase-1-contracts.md)
directly: MQTT/mTLS to Mosquitto, HTTPS PUT to MinIO, identity tied to a
per-device certificate whose CN equals `device_id`.

This plan adds a **third device class with no WiFi radio at all** — a
Bluetooth-Low-Energy-only sensor that pairs an INMP441 I2S microphone with a
sub-$5 BLE SoC and relies on a separate BLE gateway to bridge to the cloud.

**Why this is worth doing:**

- ~$5 module BOM and ~5× lower active radio current than the ESP32-S3.
- 2.4 GHz BLE 2M PHY radio coexists with WiFi without sharing channels with
  the gateway's uplink.
- Forces the cloud-side identity model to grow a gateway-attestation seam,
  which Phase 2 will need regardless (for fanout to lower-cost endpoints).

**Why it might not be:**

- BLE is structurally weak for bulk event-clip transfer (see § BLE bandwidth
  reality check below). The math only works if a gateway is in range and the
  link stays clean for 10–60 s.
- The gateway itself has roughly the BOM and power draw of an ESP32-S3 — so
  the cost win only materialises at **≥ 5 sensors per gateway**. Below that
  density, the BLE class is more expensive end-to-end than just shipping
  more ESP32-S3 units.

**Non-goals:**

- Replacing either existing device class. All three coexist.
- Designing the gateway. This plan assumes a gateway exists; its
  implementation is a separate work item (likely a stripped-down Pi or
  ESP32-S3 running a BLE↔MQTT proxy).
- Continuous live-audio streaming over LE Audio (CIS/BIS). The chosen module
  does not have a real audio PLL and our use case is sporadic event bursts,
  not continuous streams.

## Module selection

Six candidate families were surveyed: Nordic nRF52 / nRF53 / nRF54,
Espressif ESP32-H2 / ESP32-C6, Silicon Labs EFR32BG2x, Renesas DA1469x,
TI CC2652. The full comparison lives in research notes; the headline:

| Part | I2S | RAM/Flash | BLE / PHYs | TX @ 0 dBm | Sleep (RAM-ret) | Module BOM (qty-100) |
|---|---|---|---|---|---|---|
| **Nordic nRF54L15** | ✅ 1 block, MCK ≤ 32 MHz | 256 KB / 1.5 MB | 6.0, 1M/2M/Coded | 4.8 mA | 0.5–0.8 µA | ~$4–5 (Fanstel BM15M, Ezurio BL54L15) |
| Nordic nRF52840 | ✅ 1 block, awkward ratio table at 48 kHz | 256 KB / 1 MB | 5.0, 1M/2M/Coded | 4.8 mA | 1.4 µA | ~$8 (Fanstel BC840M) |
| Espressif ESP32-H2 | ✅ 16–48 kHz | 320 KB / 2–4 MB | 5.0 + 802.15.4 | ~25–35 mA class | ~8 µA | ~$3–4 |
| Silicon Labs EFR32BG27 | ✅ via USART-I2S | 64 KB / 768 KB | 5.3 | 3.6 mA | 0.5 µA | ~$4 |

**Pick: Nordic nRF54L15.** Justification against priority criteria from the
brief:

- **(a) I2S quality for INMP441 at 48 kHz / 24-bit.** The L15 has a
  dedicated I2S block with an MCK up to 32 MHz, the same MCK/RATIO/SWIDTH
  model as the nRF52840, and more clock headroom. INMP441 needs BCLK =
  64 × Fs = 3.072 MHz at 48 kHz; all candidates can hit that. The L15
  doesn't have a true audio PLL (a strike against future LE Audio source
  work) but for our event-buffered model it's fine.
- **(b) Low-power as a fixed sensor.** L15 is the lowest-power Nordic part
  shipping — roughly half the RX current of the nRF52840 at 1.8 V,
  sub-1 µA System OFF, ~2–3× efficiency per BLE event vs. the 52840.
  Beats ESP32-H2/C6 by 3–5× on active radio current.
- **(c) BOM cost.** ~$2.36 die at LCSC; pre-certified modules under $5 in
  qty-100. Same ballpark as ESP32-H2, cheaper than nRF52840.
- **(d) Toolchain.** Nordic nRF Connect SDK on Zephyr. Mature, same tooling
  as a future nRF52840 fallback, large community.

**Fallback: Nordic nRF52840.** Same SDK, well-understood power numbers, no
new-silicon errata risk. Keep the PCB layout footprint-compatible with
either part. Note one minor gotcha: nRF52840's integer I2S divisors land at
47.619 kHz instead of exactly 48 kHz; budget a software resampler or accept
the 0.8 % offset (well below INMP441's own tolerance).

**Why not the ESP32-H2/C6:** their I2S and toolchain are perfectly capable,
but active radio current is 3–5× the nRF54L15, which dominates the budget
in a sensor that has to stay connected. They are the better choice if you
expect to share firmware with the existing [plans/esp32-device.md](esp32-device.md)
codebase, at the cost of battery/PoE-budget margin.

## Hardware

Recommended module: **Fanstel BM15M** (nRF54L15, integrated antenna,
8 Mbit QSPI flash on-module, FCC/CE pre-cert). External QSPI flash matters
— see § Bandwidth below; we cannot stage a 2 MB event clip in 256 KB of
internal SRAM.

| INMP441 Pin | nRF54L15 Pin (any free GPIO) | Notes |
|-------------|------------------------------|-------|
| VDD         | 3.3 V                        |       |
| GND         | GND                          |       |
| WS (LRCLK)  | e.g. P0.04                   | configured in `nrfx_i2s_config_t.lrck_pin` |
| SCK (BCLK)  | e.g. P0.05                   |       |
| SD (DOUT)   | e.g. P0.06                   |       |
| L/R         | GND                          | left-channel only, same as Pi/ESP32 |

## What's stable vs. what changes

### Stable

Every topic, REST endpoint, and acoustic field in
[plans/phase-1-contracts.md](phase-1-contracts.md) stays as-is **on the
cloud side of the gateway**. The gateway republishes traffic on behalf of
the BLE sensor, so the broker and API don't know — or care — that the
device is on the other side of a BLE link.

### Contract delta — three required changes

Listed in order of how invasive they are. All three must land before
firmware starts; they go in a single PR against
[backend/app/contracts.py](../backend/app/contracts.py) and the fixtures
under `backend/tests/fixtures/`.

1. **Widen `content_type` to include `audio/lc3`.** Currently pinned to
   `Literal["audio/flac"]` at [backend/app/contracts.py:97](../backend/app/contracts.py#L97)
   and [backend/app/contracts.py:173](../backend/app/contracts.py#L173).
   Becomes `Literal["audio/flac", "audio/ogg; codecs=opus", "audio/lc3"]`
   (folding in the ESP32 Opus delta from [plans/esp32-device.md](esp32-device.md)).
   `storage_key` suffix routes off `content_type`. No transcode on ingest —
   archive in the as-received codec, tag the row with the codec, decode at
   playback time if needed.

2. **Add optional `gateway_id` and `gateway_fingerprint` fields to
   `Telemetry`, `Health`, and `EventAnnounce`.** Both optional and ignored
   when absent — WiFi-direct devices keep working unchanged. When present,
   they record which gateway relayed the message. This is the audit trail
   for the new authority layer; the cloud should reject inconsistencies
   (e.g. two gateways claiming the same `device_id` within a short window)
   but not require the field. Use `extra="ignore"` semantics — already the
   default for inbound device→cloud payloads.

3. **Allow the gateway to authenticate as the device.** The mTLS cert
   model still applies, but the cert CN remains `str(device_id)` and the
   *gateway* holds the cert on the BLE-only device's behalf (see Identity
   bridging below). This is a policy/operational change, not a schema
   change — but it deserves a paragraph in `phase-1-contracts.md` so future
   readers understand why a gateway terminating TLS for a device is in
   scope.

## BLE bandwidth reality check

Real-world numbers from the BLE community, measured on Nordic Soft Device /
Zephyr with 2M PHY, DLE on, ATT MTU 247:

- Practical sustained app-layer throughput: **~150 kB/s (1.2 Mbps)** at a
  15 ms connection interval. Shorter intervals (7.5 ms) are often *worse*
  because the radio can't fit a full burst of packets per event.
- 2 MB event payload at 150 kB/s: **~13 s best case**. At 12 kB/s on a
  congested link: ~170 s, unacceptable.
- 1 Hz telemetry at ~80 B/sec: **trivial**, ~640 bps, one notification per
  second, ~3 ms of radio per second.

**Implications for firmware:**

- The encoded event clip must be **buffered in QSPI flash, not SRAM**
  (256 KB internal SRAM doesn't fit even a 2 MB clip). Module choice of
  BM15M with on-module flash handles this.
- We need a chunked, resumable GATT transfer protocol — re-uploading 2 MB
  from byte 0 because the link dropped at byte 1.9 MB is not acceptable
  with 1–60 s transfer windows.
- We do **not** use LE Audio CIS/BIS for this. Isochronous channels are for
  continuous low-latency streams (headphones); our case is sporadic bursts
  and GATT notifications are the right tool.

## Audio codec

**Use LC3 at 32 kbps mono, 10 ms frames**, via [google/liblc3](https://github.com/google/liblc3).

- BSD-licensed, `no_std`-clean, well-tested on Cortex-M33 (the L15's core).
- Per Packetcraft's reference, ~18 MHz of M33 to encode 48 kHz/80 kbps in
  real time; flash ~120 KB; encoder stack < 1 KB. At our 32 kbps target the
  CPU bound drops further.
- 10 s clip → 40 KB encoded → ~270 ms on a healthy BLE link, ~3 s in the
  worst case.

Opus was considered and rejected: STM's reference Opus encoder needs ~100 KB
of heap, and the ESP32 community has documented that the Opus encoder
"doesn't work well above 24 kHz at complexity 2." Not a great fit on a
256 KB SRAM device that's already spending budget on TLS context (via the
gateway).

Keep raw PCM as a debug fallback path, gated by a config flag, so the
end-to-end pipeline can be validated without trusting the codec on day one.

## Architecture

```
[INMP441] --I2S--> [nRF54L15 sensor] --BLE 2M PHY--> [gateway] --MQTT/HTTPS--> [cloud]
                        (LC3 encode, chunked GATT)         (mTLS, existing contracts)
```

### GATT services exposed by the sensor

Three custom 128-bit UUID services:

- **Acoustic Telemetry Service**
  - `tlm_notify` (notify, ≤80 B): payload shape identical to MQTT
    `dev/{id}/tlm`. CBOR-encoded to save bytes over the air; gateway
    re-emits as JSON.
  - `health_notify` (notify, 1/min): mirrors `/health`.
  - `lwt` (read): last-known LWT body the gateway publishes if the BLE link
    drops.
- **Event Transfer Service**
  - `event_announce` (notify): mirrors `event/announce` — duration, peak
    dB, content_type (`audio/lc3`), sha256, size.
  - `event_chunk` (notify, MTU-1 = 244 B): LC3 frames in 244-byte chunks.
    First 2 bytes are sequence number, MSB of byte 0 is the FIN bit.
    Gateway reassembles and computes sha256 to verify against announce.
  - `event_done` (notify): triggers gateway's `POST /api/v1/events/intent`
    flow.
- **Device Info / Config Service**
  - Standard DIS (0x180A): model, firmware rev, serial = `str(device_id)`.
  - Config writes: thresholds, sample rate, calibration trim, mirror of the
    existing `/cmd/*` MQTT topics.

### Routing on the gateway

The gateway is a stateful translator. Per connected sensor it:

1. Maintains an MQTT session on behalf of that `device_id`, **using the
   device's mTLS cert** stored on the gateway (see Identity below).
2. Subscribes to all three notify characteristics.
3. Forwards `tlm_notify` → `dev/{id}/tlm`, `health_notify` →
   `dev/{id}/health`, etc. byte-for-byte where the payload shape matches.
4. On `event_done`: verifies sha256 of the reassembled stream, calls
   `POST /api/v1/events/intent`, performs the PUT, publishes `event/done`.
5. Publishes the LWT body on behalf of the device when BLE supervision
   timeout fires.
6. Stamps every forwarded payload with `gateway_id` and `gateway_fingerprint`
   (the new fields in the contract delta).

### Identity bridging — the load-bearing decision

Two options:

- **(A) Gateway holds the cert.** Sensors don't authenticate end-to-end.
  Cloud trusts the gateway; gateway vouches for sensors by `device_id`.
  Simple. Sensor BOM minimal. **Risk:** a compromised gateway can forge
  telemetry from any of its sensors.
- **(B) Device signs each payload.** Per-device key pair in the nRF54L15's
  KMU; signs telemetry and event payloads. Gateway is a dumb relay. Cloud
  verifies signatures. Schema grows a `sig` field. End-to-end attestation
  preserved.

**Recommend (A) for v1, with the migration path to (B) explicit in the
plan.** Reasons:

- (A) is shippable in the time we'd spend designing (B)'s key-distribution
  story.
- The new `gateway_id` audit field already lets us scope the blast radius
  of a compromised gateway (you can see which devices it touched).
- (B) is a real Phase 2 ask — but only when we have multiple gateway
  operators, which we don't.

## Power budget

Assume nRF54L15 + INMP441 + 3.0 V supply, no acoustic duty-cycling, steady
state with 1 Hz telemetry + 1/min health + 3 events/hour × 15 s.

| Block | Avg current |
|---|---|
| INMP441 active | **1,400 µA** (dominant — 90% of budget) |
| nRF54L15 CPU (I2S read + DSP) at ~5% duty | 100 µA |
| nRF54L15 sleep w/ RAM retention at 95% duty | < 1 µA |
| BLE connection event (1 s interval, 2M PHY, 1 notify) | ~15 µA |
| LC3 encode (3 events/h × 15 s) | ~38 µA averaged |
| BLE event burst (3 events/h × 60 KB) | ~2 µA averaged |
| **Total** | **~1.56 mA** |

| Battery | Runtime |
|---|---|
| 18650, 3000 mAh | **~80 days (2.7 months)** |
| 2 × AA alkaline, ~2000 mAh effective | ~53 days |
| 2 × AA lithium, ~3000 mAh | ~80 days |

**The microphone dominates the budget.** No amount of MCU tuning gets past
2–3 months on a single 18650 — getting to a year would require duty-cycling
the mic itself (~150 µA averaged), which means accepting that we might miss
the start of events. Not acceptable for noise monitoring.

**Practical conclusion: this device class should be PoE-splitter powered,
not battery powered.** Battery is a backup mode (~weeks of runtime through
a power cut), not the steady-state plan.

## Firmware architecture

Mirrors the Pi supervisor structure so all three device types can be reasoned
about side-by-side. C / Zephyr instead of Python or ESP-IDF.

```
ble-sensor/
├── src/
│   ├── main.c               # boot, NVS init, BLE up, start threads
│   ├── capture.c            # I2S DMA → 1 s PCM blocks
│   ├── ringbuffer.c         # SRAM pre-roll (small) + QSPI staging (large)
│   ├── dsp.c                # IIR A/C weighting, LAeq/LAFmax/LCpeak
│   ├── detector.c           # threshold + hysteresis (port of detector.py)
│   ├── encoder_lc3.c        # liblc3 wrapper
│   ├── telemetry.c          # GATT tlm_notify at 1 Hz
│   ├── health.c             # GATT health_notify at 1/min
│   ├── event_xfer.c         # chunked GATT event_chunk transfer
│   ├── gatt_services.c      # service/characteristic registration
│   └── config.c             # NVS config + KMU keys
├── boards/
│   └── fanstel_bm15m.overlay
├── prj.conf
└── CMakeLists.txt
```

Zephyr thread budget (rough — Zephyr threads instead of FreeRTOS tasks):

| Thread | Priority | Stack | Purpose |
|---|---|---|---|
| `i2s_capture` | high (coop) | 2 KB | DMA descriptor handling |
| `dsp_telemetry` | high | 4 KB | 1 s blocks → weighted dB → notify |
| `detector` | mid | 2 KB | open/close events on LAFmax |
| `encoder` | mid | 4 KB | LC3 frame production, stage to QSPI |
| `event_xfer` | mid | 4 KB | chunked GATT transfer state machine |
| `health` | low | 2 KB | 1/min publish |
| BT host (Zephyr) | system | 2 KB | (internal) |

## Cloud-side work

Small, all in the contract delta above. Optional add-ons that aren't
blocking:

- `device_class` column in `devices` table (`pi-zero-2w` | `esp32-s3` |
  `nrf54l15-ble`). Populated from a new optional `device_class` field in
  `Health`, or from a one-time `cmd/identify` round-trip. Pure
  diagnostics; ingest doesn't need it.
- Frontend: surface `gateway_id` and `device_class` on the event inspector
  panel so an operator can tell at a glance which device path delivered a
  given event.

## Task list

Order matters — contract + simulator + gateway stub before any firmware.

1. **Contract delta PR.** Widen `content_type`, add `gateway_id` /
   `gateway_fingerprint` optionals, add fixtures, update
   [plans/phase-1-contracts.md](phase-1-contracts.md) with the new
   identity-bridging paragraph.
2. **Gateway stub.** A small Python script on a dev laptop with a Nordic
   USB dongle (nRF52840-dongle running Zephyr's central role) that
   speaks the GATT services and re-emits to the existing Mosquitto. This
   is the dev harness; production gateway design is out of scope here.
3. **Bench test INMP441 on a Fanstel BM15M devkit.** Get clean
   48 kHz / 24-bit I2S into an SRAM buffer. Confirm a 1 kHz / 94 dB SPL
   reference gives -26 dBFS RMS — same calibration gate as the ESP32 plan.
4. **DSP + detector port.** Port [dsp.py](../raspberry-pi-zero-2w/urban_acoustics/dsp.py)
   and [detector.py](../raspberry-pi-zero-2w/urban_acoustics/detector.py)
   to C. Reuse the same biquad coefficient table the ESP32 port will use.
   Unit test against the Pi's WAV corpus, require `|LAeq_pi − LAeq_ble| <
   0.1 dB`.
5. **LC3 integration.** Build `liblc3` as a Zephyr submodule. Round-trip
   a known PCM clip through encode → decode → confirm SNR.
6. **GATT services.** Register Telemetry, Event, DIS services. Push live
   telemetry notifications to the gateway stub.
7. **Chunked event transfer.** Sequence-number protocol with resume
   support. Tear down the BLE link mid-transfer and confirm resume.
8. **Power validation.** Coulomb-counter measurement of average current
   under the steady-state assumptions in § Power budget above. Require
   measurement within 15 % of the 1.56 mA estimate.
9. **OTA via gateway.** New `cmd/ota` command name (same as the ESP32
   plan), gateway downloads the image and pushes it via SMP /
   MCUBoot over BLE.
10. **Colocated field unit.** One BLE sensor + one ESP32-S3 + the Pi on
    the same pole for a week. Diff their telemetry; investigate any
    per-minute LAeq deviation > 0.5 dB.

## Risks and unknowns

1. **BLE for bulk event transfer is structurally weak.** 13 s best-case to
   ship a 2 MB clip; expect 30–60 s in real urban 2.4 GHz environments and
   occasional failures requiring resume. Mitigate with the chunked
   protocol; accept some lost-event-clip rate.
2. **The gateway is a critical-path device.** A BLE sensor out of gateway
   range is dead. The "cheap, low-power" win is offset by needing to
   deploy and power gateways. Honest framing: BLE class only wins at
   ≥ 5 sensors per gateway. Below that density, ship more ESP32-S3 units.
3. **mTLS identity model breaks at the edge.** Option (A) (gateway holds
   cert) lets a compromised gateway forge sensor traffic. The
   `gateway_id` audit field scopes the blast radius but doesn't prevent
   the attack. Option (B) (device signs) is the real fix; treat it as
   Phase 2 work and don't pretend (A) is end-to-end secure.
4. **Battery life isn't there without acoustic duty-cycling.** INMP441
   dominates the budget; 2–3 months on an 18650 is the realistic ceiling.
   PoE-splitter is the honest deployment model. Battery is a corner case.
5. **nRF54L15 is new silicon (early-2025 production).** Active errata
   list (v1.0 dated 2025-03-18). Treat the L15 as a 12-month bet; keep
   nRF52840 footprint-compatibility in the PCB layout as an explicit
   fallback. Expect first-year firmware bugs in nRF Connect SDK to
   surface — Seeed forum reports already show the L15 underperforming
   the 52840 in some connected workloads, attributed to SDK immaturity.

## Acceptance

The BLE device class is "done" when:

- A field sensor + gateway pair publishes 1 Hz telemetry and 1/min health
  to the same Mosquitto the WiFi devices use, with `gateway_id` set on
  every payload.
- An event triggered on the BLE sensor and an event triggered on a
  colocated ESP32-S3, within ±0.5 dB of the same source, both reach
  `available` state in the backend within 60 s of each other.
- The chunked event transfer correctly resumes after a forced BLE link
  drop mid-upload.
- A `cmd/ota` round-trip upgrades the firmware over BLE without manual
  intervention.
- Measured average current is within 15 % of the 1.56 mA estimate.
- The contract test suite passes — the contract delta is the *only*
  cloud-side difference, and it's covered by fixtures.
