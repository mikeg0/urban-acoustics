"""FLAC encoding for event audio.

Pi Zero 2 W can encode 48 kHz mono FLAC at well over real-time using the
``flac`` CLI (libFLAC) shipped in Debian. Doing it in a subprocess keeps
our Python heap small — we hand the encoder a raw PCM stream on stdin
and read the FLAC bytes back from stdout.

The output is bounded by :data:`EVENT_MAX_SIZE_BYTES` (Phase 1 contract):
the supervisor must drop or truncate audio that doesn't fit.
"""

from __future__ import annotations

import hashlib
import logging
import shutil
import struct
import subprocess
from dataclasses import dataclass

import numpy as np


log = logging.getLogger(__name__)


EVENT_MAX_SIZE_BYTES = 8 * 1024 * 1024


class FlacEncoderError(RuntimeError):
    pass


@dataclass(frozen=True)
class EncodedEvent:
    data: bytes
    sha256: str
    size: int
    duration_s: float


def _wav_header(num_samples: int, sample_rate: int, bits_per_sample: int = 32, channels: int = 1) -> bytes:
    byte_rate = sample_rate * channels * bits_per_sample // 8
    block_align = channels * bits_per_sample // 8
    data_size = num_samples * block_align
    return (
        b"RIFF"
        + struct.pack("<I", 36 + data_size)
        + b"WAVE"
        + b"fmt "
        + struct.pack("<IHHIIHH", 16, 1, channels, sample_rate, byte_rate, block_align, bits_per_sample)
        + b"data"
        + struct.pack("<I", data_size)
    )


def encode_flac(samples: np.ndarray, sample_rate: int) -> EncodedEvent:
    """Encode a mono int32 PCM array to FLAC bytes via the ``flac`` CLI.

    Raises :class:`FlacEncoderError` if the encoder is missing, fails, or
    produces output larger than :data:`EVENT_MAX_SIZE_BYTES`.
    """
    if shutil.which("flac") is None:
        raise FlacEncoderError("flac CLI not installed (apt install flac)")
    if samples.dtype != np.int32:
        samples = samples.astype(np.int32, copy=False)
    if samples.ndim != 1:
        raise FlacEncoderError(f"expected mono 1-D samples, got shape {samples.shape}")
    if samples.size == 0:
        raise FlacEncoderError("refusing to encode empty audio")

    wav = _wav_header(samples.size, sample_rate) + samples.tobytes()
    # ``--best`` is overkill for a Pi, but FLAC level 5 (default) is what
    # we'd actually pick if we tuned for CPU. Level 5 is the implicit default
    # when no level flag is passed.
    cmd = ["flac", "--silent", "--force", "--stdout", "-"]
    try:
        proc = subprocess.run(cmd, input=wav, capture_output=True, check=False, timeout=30)
    except subprocess.TimeoutExpired as exc:
        raise FlacEncoderError("flac encoder timed out") from exc
    if proc.returncode != 0:
        raise FlacEncoderError(
            f"flac encoder exited with rc={proc.returncode}: {proc.stderr.decode(errors='replace')[:200]}"
        )

    data = proc.stdout
    if not data:
        raise FlacEncoderError("flac encoder produced no output")
    if len(data) > EVENT_MAX_SIZE_BYTES:
        raise FlacEncoderError(
            f"encoded event {len(data)} B exceeds Phase 1 cap of {EVENT_MAX_SIZE_BYTES} B"
        )

    return EncodedEvent(
        data=data,
        sha256=hashlib.sha256(data).hexdigest(),
        size=len(data),
        duration_s=samples.size / sample_rate,
    )
