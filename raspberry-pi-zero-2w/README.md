# Pi Zero INMP441 Audio Recorder

Records audio on boot in 1-minute WAV chunks using a Raspberry Pi Zero and INMP441 I2S MEMS microphone.

## Wiring

| INMP441 Pin | Pi Zero Pin         |
|-------------|---------------------|
| VDD         | 3.3V (pin 1)        |
| GND         | GND (pin 6)         |
| WS (LRCLK) | GPIO 19 (pin 35)    |
| SCK (BCLK)  | GPIO 18 (pin 12)    |
| SD (DOUT)   | GPIO 20 (pin 38)    |
| L/R         | GND (for left ch)   |

## Setup Steps

### 1. Enable I2S

Edit `/boot/firmware/config.txt` (or `/boot/config.txt` on older OS versions):

```bash
sudo nano /boot/firmware/config.txt
```

Add these lines:

```
dtparam=i2s=on
dtoverlay=googlevoicehat-soundcard
```

> **Note:** The `googlevoicehat-soundcard` overlay is the standard way to get
> a simple I2S input device on the Pi. Despite the name, it works with any I2S
> mic including the INMP441. If you prefer, you can use the Adafruit i2smic.py
> script from the pi-pin repo instead — it does the same thing with a guided
> installer.

Reboot:

```bash
sudo reboot
```

### 2. Install the ALSA config

Copy `asoundrc` to your home directory:

```bash
cp asoundrc ~/.asoundrc
```

### 3. Test the mic

```bash
arecord -D dmic_sv -c1 -r 48000 -f S32_LE -t wav -V mono -v test.wav --duration=5
```

Play it back (copy to another machine, or use `aplay test.wav` if you have speakers attached).

If you get silence, check:
- `arecord -l` shows a card (likely card 0, `snd_rpi_googlevoicehat_soundcard`)
- The L/R pin on the INMP441 is tied to GND (not floating)
- Wiring is correct (WS/SCK/SD to the right GPIO pins)

### 4. Set capture volume

Run `arecord` once with the `dmic_sv` device (step 3 above) to initialize the
software volume control, then:

```bash
alsamixer
```

Press **F6** to select the I2S sound card, then **F4** for Capture. Adjust to
~70% as a starting point.

### 5. Install the recorder

```bash
sudo cp record.sh /usr/local/bin/pi-recorder.sh
sudo chmod +x /usr/local/bin/pi-recorder.sh
sudo cp pi-recorder.service /lib/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable pi-recorder.service
sudo systemctl start pi-recorder.service
```

### 6. Verify

```bash
sudo systemctl status pi-recorder.service
ls -la /home/pi/recordings/
```

You should see WAV files appearing every 60 seconds.

## Managing the service

```bash
sudo systemctl stop pi-recorder.service    # stop recording
sudo systemctl start pi-recorder.service   # start recording
sudo systemctl disable pi-recorder.service # don't start on boot
journalctl -u pi-recorder.service -f       # live logs
```

## Retrieving recordings

Over the network (if using Pi Zero W / W2):

```bash
scp pi@<pi-ip>:~/recordings/*.wav ./
```

Or pull the SD card and mount it on another machine.

## Storage estimates

At 48 kHz / 32-bit mono, each 1-minute WAV is ~11.5 MB.
A 32 GB SD card holds roughly 40+ hours of continuous recording.

To reduce file size, you can lower the sample rate to 16 kHz in `record.sh`
(~3.8 MB/min) — plenty for speech recording.
