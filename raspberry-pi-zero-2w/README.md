# Urban Acoustics — Pi Zero 2 W firmware

Single-process Python supervisor that captures audio from an INMP441 I2S
microphone, computes 1 Hz acoustic telemetry, detects events, encodes them
to FLAC, and publishes everything to the Phase 1 cloud (MQTT + REST + S3).

Replaces the original `record.sh` WAV-loop recorder. The legacy
recorder files (`record.sh`, `pi-recorder.service`) are kept in this
directory during the migration so an in-the-field unit can be rolled
back. `asoundrc` is still used by the new firmware (installed to
`/etc/asound.conf` — see step 2).

## Hardware

| INMP441 Pin | Pi Zero 2 W Pin    |
|-------------|--------------------|
| VDD         | 3.3 V (pin 1)      |
| GND         | GND (pin 6)        |
| WS (LRCLK)  | GPIO 19 (pin 35)   |
| SCK (BCLK)  | GPIO 18 (pin 12)   |
| SD (DOUT)   | GPIO 20 (pin 38)   |
| L/R         | GND (left channel) |

## What the firmware does

`urban_acoustics/` is a single Python package. The supervisor spawns:

- one `arecord` subprocess on `dmic_sv` (48 kHz mono S32_LE),
- five async tasks: capture/DSP, health, MQTT drain, uploader, watchdog,
- and one paho MQTT thread (the `loop_start()` thread).

For each 1 s PCM block we:

1. push it into the in-memory ring buffer (pre-roll),
2. compute LAeq / LAFmax / LCpeak via FFT-based A- and C-weighting,
3. publish `dev/{device_id}/tlm` over MQTT (QoS 0),
4. feed LAFmax into the detector.

If LAFmax crosses the configured threshold the detector opens an event,
waits for it to close (hysteresis + min/max duration), then extracts the
pre-roll + post-roll window from the ring buffer, encodes it to FLAC, and
hands it to the uploader: `POST /api/v1/events/intent` → `PUT` to the
presigned URL → `event/done` on MQTT.

Anything that fails to publish is parked in a SQLite WAL queue at
`/var/lib/urban-acoustics/queue.db` and replayed when the broker / API
come back. Event FLACs spool to `/var/lib/urban-acoustics/audio/` so they
survive a power loss mid-upload.

## Layout

```
raspberry-pi-zero-2w/
├── pyproject.toml
├── urban_acoustics/
│   ├── __main__.py           # ExecStart entry
│   ├── supervisor.py         # orchestrator
│   ├── capture.py            # arecord subprocess
│   ├── ringbuffer.py         # PCM pre-roll buffer
│   ├── dsp.py                # numpy A/C-weighting + LAeq/LAFmax/LCpeak
│   ├── detector.py           # threshold + hysteresis event detector
│   ├── encoder.py            # FLAC encode via libFLAC CLI
│   ├── telemetry.py          # MQTT telemetry publisher
│   ├── health.py             # MQTT health publisher
│   ├── uploader.py           # intent → PUT → done
│   ├── transport.py          # paho-mqtt + httpx clients
│   ├── queue_store.py        # SQLite store-and-forward
│   ├── config.py             # JSON config loader
│   └── calibration.py        # mic sensitivity + per-device trim
├── systemd/
│   ├── urban-acoustics.service
│   ├── urban-acoustics-cleanup.service
│   └── urban-acoustics-cleanup.timer
├── chrony/
│   └── chrony.conf
└── README.md
```

## One-time setup on a fresh Pi

The steps below assume a recent Raspberry Pi OS Lite (Bookworm 64-bit).

### 1. Enable I2S

Edit `/boot/firmware/config.txt`:

```bash
sudo nano /boot/firmware/config.txt
```

Add:

```
dtparam=i2s=on
dtoverlay=googlevoicehat-soundcard
```

Reboot. After reboot `arecord -l` must show
`card 0: sndrpigooglevoi [snd_rpi_googlevoicehat_soundcard]`.

### 2. ALSA capture device

Install the asoundrc as a system-wide config so ALSA can find the
`dmic_*` definitions regardless of which user runs `arecord` — the
service user is `urban-acoustics`, not `pi`, and its unit sets
`ProtectHome=true` so any `~/.asoundrc` would be invisible to it.

```bash
sudo install -m 0644 asoundrc /etc/asound.conf
arecord -D dmic_mono -c1 -r 48000 -f S32_LE -t wav -v test.wav --duration=5
```

Tune capture volume in `alsamixer` (F6 → I2S card, F4 → Capture, ~70 %).

`dmic_mono` is a route plug that downmixes the 2-channel I2S stream to
the single left channel (the INMP441's `L/R` pin is tied to GND, so the
right channel is silence). The firmware records from `dmic_mono`.

### 3. Install packages

```bash
sudo apt update
sudo apt install -y alsa-utils flac chrony python3-venv python3-pip git
```

### 4. Get the source onto the Pi

Pick whichever fits the deployment workflow.

**Option A — clone the repo on the Pi** (simplest for a one-off bring-up):

```bash
sudo git clone https://github.com/conexed/urban-acoustics.git /opt/urban-acoustics/src
cd /opt/urban-acoustics/src/raspberry-pi-zero-2w
```

**Option B — tarball + scp** (no GitHub access, no rsync on the Pi):

From your workstation, in the repo root:

```bash
tar --exclude __pycache__ --exclude '*.pyc' \
    -czf urban-acoustics-pi.tar.gz -C raspberry-pi-zero-2w .
scp urban-acoustics-pi.tar.gz pi@<pi-ip>:/tmp/
```

Then on the Pi:

```bash
sudo mkdir -p /opt/urban-acoustics/src/raspberry-pi-zero-2w
sudo tar -xzf /tmp/urban-acoustics-pi.tar.gz -C /opt/urban-acoustics/src/raspberry-pi-zero-2w
rm /tmp/urban-acoustics-pi.tar.gz
cd /opt/urban-acoustics/src/raspberry-pi-zero-2w
```

The `-C raspberry-pi-zero-2w .` flag makes the archive root be the *contents*
of that directory (no leading path inside the tarball), so the extract path
on the Pi matches the layout the rest of the README expects.

**Option C — rsync from a dev machine** (fastest for iterating during dev):

```bash
rsync -av --exclude __pycache__ raspberry-pi-zero-2w/ pi@<pi-ip>:/tmp/urban-acoustics-src/
ssh pi@<pi-ip> 'sudo mkdir -p /opt/urban-acoustics/src && sudo cp -r /tmp/urban-acoustics-src /opt/urban-acoustics/src/raspberry-pi-zero-2w'
```

Then on the Pi:

```bash
cd /opt/urban-acoustics/src/raspberry-pi-zero-2w
```

All subsequent steps assume you are in this directory.

### 5. Create a service user

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin urban-acoustics
sudo usermod -aG audio urban-acoustics
sudo install -d -o urban-acoustics -g urban-acoustics /var/lib/urban-acoustics
sudo install -d -o urban-acoustics -g urban-acoustics /var/lib/urban-acoustics/audio
sudo install -d -o root -g root /etc/urban-acoustics
sudo install -d -o root -g root /etc/urban-acoustics/certs
```

### 6. Install the firmware into a venv

From `/opt/urban-acoustics/src/raspberry-pi-zero-2w` (the directory you
checked out in step 4):

```bash
sudo python3 -m venv /opt/urban-acoustics/venv
sudo /opt/urban-acoustics/venv/bin/pip install --upgrade pip
sudo /opt/urban-acoustics/venv/bin/pip install .
```

`pip install .` reads `pyproject.toml` and installs the `urban_acoustics`
package plus its dependencies (numpy, paho-mqtt, httpx). To upgrade later,
`git pull` (or rsync) inside the source dir and re-run the `pip install .`
line — the venv path stays put.

### 7. Drop in certs + config

Place the device's mTLS material at the paths referenced by the config:

```
/etc/urban-acoustics/certs/root-ca.crt
/etc/urban-acoustics/certs/device.crt
/etc/urban-acoustics/certs/device.key
```

⚠️ `root-ca.crt` must be a **bundle of two CAs** concatenated into one PEM
file: the urban-acoustics dev root CA (`backend/certs/root-ca.crt`) *and*
the CA that signs the REST API's TLS certificate (for the dev stack that is
the "ConexED Development" CA behind `*.dev.conexed.com` — copy
`/usr/local/share/ca-certificates/wildcard-dev-conexed.crt` from an existing
node). The firmware verifies both the MQTT broker and the HTTPS API against
this single file (`transport.py`), so with only the MQTT CA present,
telemetry works but every event upload fails TLS and spools to the local
queue until the bundle is fixed.

Also drop in the trained classifier weights:

```
/etc/urban-acoustics/pi_head.npz
```

They are not in the repo — copy them from an existing node or the training
pipeline output. A missing file simply disables on-device auto-labeling
(see `classifier_path` in `urban_acoustics/config.py`).

Create `/etc/urban-acoustics/config.json` (only `device_id` is required;
every other key has a sensible default — see `urban_acoustics/config.py`):

```json
{
  "device_id": "00000000-0000-4000-8000-00000000000a",
  "fw_version": "0.1.0",
  "mqtt_broker_host": "mqtt.urban-acoustics.conexed.com",
  "api_base": "https://api.urban-acoustics.conexed.com",
  "mic_gain_db": 0.0,
  "event_threshold_db": 80.0
}
```

### 8. Install systemd units + chrony

```bash
sudo install -m 0644 systemd/urban-acoustics.service          /etc/systemd/system/
sudo install -m 0644 systemd/urban-acoustics-cleanup.service  /etc/systemd/system/
sudo install -m 0644 systemd/urban-acoustics-cleanup.timer    /etc/systemd/system/
sudo install -m 0644 chrony/chrony.conf                       /etc/chrony/chrony.conf

sudo systemctl daemon-reload
sudo systemctl enable --now chrony
sudo systemctl enable --now urban-acoustics.service
sudo systemctl enable --now urban-acoustics-cleanup.timer
```

## Verifying

Telemetry should hit the broker once per second:

```bash
journalctl -u urban-acoustics.service -f
```

You should see lines like:

```
INFO supervisor running (device=… fw=0.1.0 …)
INFO mqtt: connected
INFO health: emit uptime=5s queue_depth=0
```

…and, when something triggers the detector:

```
INFO detector: event opened …
INFO event <id>: spooled 1.4 MB (sha=…)
INFO uploader: event <id> complete
```

Test a WiFi outage with `sudo nmcli radio wifi off` for a few minutes —
queued telemetry / events should drain on reconnect, and `journalctl`
should show no unhandled exceptions.

## Calibration

`dsp.py` converts each sample to a floating-point value in `[-1, 1]` and
then adds `sensitivity_offset_db + mic_gain_db` to get dB SPL.

- `sensitivity_offset_db` (default **120 dB**) is the INMP441 datasheet
  value: -26 dBFS at 94 dB SPL @ 1 kHz, so full scale ≡ 120 dB SPL.
- `mic_gain_db` is a per-device trim. With a reference meter at a known
  source (e.g. a 94 dB SPL pistonphone or a calibrated speaker playing
  pink noise), set `mic_gain_db` so reported LAeq matches the reference.

## Managing the service

```bash
sudo systemctl restart urban-acoustics.service
sudo systemctl stop    urban-acoustics.service
sudo journalctl -u urban-acoustics.service -n 200
```

The unit has a `MemoryMax=256M` cap so a leak cannot OOM the kernel; the
supervisor logs a warning above `memory_soft_cap_mb` (default 192 MB)
well before this.

## Legacy

`record.sh` and `pi-recorder.service` are the old WAV-loop recorder.
They are kept in this directory for one release so a unit can be
reverted with:

```bash
sudo systemctl disable --now urban-acoustics.service
sudo systemctl enable  --now pi-recorder.service
```

Plan: remove once every deployed device has been upgraded.
