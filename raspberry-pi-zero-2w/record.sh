#!/bin/bash
# record.sh — Continuously record 1-minute WAV files from an I2S MEMS mic
#
# Each file is named with a timestamp: rec_20260412_143022.wav
# Runs until killed (by systemd stop, power off, etc.)

# --- Configuration -----------------------------------------------------------
OUTPUT_DIR="/home/pi/recordings"
DEVICE="dmic_sv"           # ALSA device name (matches .asoundrc)
SAMPLE_RATE=48000           # 48 kHz (INMP441 max). Use 16000 for smaller files.
FORMAT="S32_LE"             # 32-bit (INMP441 outputs 24-bit packed in 32)
CHANNELS=1                  # Mono
DURATION=60                 # Seconds per file
# -----------------------------------------------------------------------------

mkdir -p "$OUTPUT_DIR"

echo "$(date): Recorder starting — writing ${DURATION}s chunks to ${OUTPUT_DIR}"
echo "  Device: ${DEVICE}  Rate: ${SAMPLE_RATE}  Format: ${FORMAT}"

cleanup() {
    echo "$(date): Recorder stopping"
    exit 0
}
trap cleanup SIGTERM SIGINT

while true; do
    FILENAME="${OUTPUT_DIR}/rec_$(date +%Y%m%d_%H%M%S).wav"
    arecord -D "$DEVICE" \
            -c "$CHANNELS" \
            -r "$SAMPLE_RATE" \
            -f "$FORMAT" \
            -t wav \
            --duration="$DURATION" \
            "$FILENAME" 2>&1

    EXIT_CODE=$?
    if [ $EXIT_CODE -ne 0 ]; then
        echo "$(date): arecord exited with code ${EXIT_CODE}, retrying in 5s..."
        sleep 5
    fi
done
