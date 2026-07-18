"""Unit tests for the STFT band decomposition.

Runs under plain ``python -m pytest`` (no scipy / no real audio hardware).
The bander is pure numpy, so a synthetic sine sweep is enough to confirm
the band edges and the calibration offset are wired up correctly.
"""

from __future__ import annotations

import numpy as np

from urban_acoustics.calibration import Calibration
from urban_acoustics.dsp import ISO_THIRD_OCTAVE_HZ, STFTBander


SR = 48000


def _calib() -> Calibration:
    return Calibration(sensitivity_offset_db=120.0, mic_gain_db=0.0)


def _tone(freq: float, n: int, amp: float = 0.1) -> np.ndarray:
    """Generate ``n`` samples of a sine at ``freq`` Hz as S32_LE PCM."""
    t = np.arange(n) / SR
    sig = amp * np.sin(2 * np.pi * freq * t)
    # _pcm_to_float divides by 2**31, so multiply here by 2**31 to round-trip.
    return (sig * (1 << 31)).astype(np.int32)


def _band_index(freq: float) -> int:
    return min(
        range(len(ISO_THIRD_OCTAVE_HZ)),
        key=lambda i: abs(ISO_THIRD_OCTAVE_HZ[i] - freq),
    )


def test_band_count_and_frame_rate() -> None:
    bander = STFTBander(sample_rate=SR, calib=_calib())
    assert bander.n_bands == 30
    # window=4096, hop=2048 → 23.4 Hz on 48 kHz.
    assert abs(bander.frame_rate_hz - SR / 2048) < 1e-6


def test_tone_peaks_in_correct_band() -> None:
    """A pure tone at 1 kHz should peak in the 1000 Hz band, ditto for
    500 Hz / 4 kHz. Adjacent bands should be at least 10 dB lower."""
    bander = STFTBander(sample_rate=SR, calib=_calib())
    for freq in (500.0, 1000.0, 4000.0):
        bander.reset()
        frames = bander.feed(_tone(freq, SR), block_ts=0.0)
        assert frames, f"no frames produced for {freq} Hz"
        bands = frames[-1][1]
        peak = int(np.argmax(bands))
        expected = _band_index(freq)
        assert peak == expected, (
            f"{freq} Hz peaked in band {peak} ({ISO_THIRD_OCTAVE_HZ[peak]} Hz), "
            f"expected {expected} ({ISO_THIRD_OCTAVE_HZ[expected]} Hz)"
        )
        if peak >= 1:
            assert bands[peak] - bands[peak - 1] >= 10.0
        if peak < len(bands) - 1:
            assert bands[peak] - bands[peak + 1] >= 10.0


def test_calibration_offset_lifts_levels() -> None:
    """Doubling the calibration offset should add ~6 dB to every band."""
    a = STFTBander(sample_rate=SR, calib=Calibration(sensitivity_offset_db=100.0, mic_gain_db=0.0))
    b = STFTBander(sample_rate=SR, calib=Calibration(sensitivity_offset_db=106.0, mic_gain_db=0.0))
    samples = _tone(1000.0, SR)
    bands_a = a.feed(samples, 0.0)[-1][1]
    bands_b = b.feed(samples, 0.0)[-1][1]
    diff = bands_b - bands_a
    # Only check bands that aren't clipped at the noise floor.
    live = bands_a > -19.0
    assert live.any()
    assert np.all(np.abs(diff[live] - 6.0) < 0.5)


def test_frame_timestamps_monotonic_and_centred() -> None:
    bander = STFTBander(sample_rate=SR, calib=_calib())
    samples = _tone(1000.0, SR, amp=0.05)
    frames = bander.feed(samples, block_ts=100.0)
    tss = [f[0] for f in frames]
    assert tss == sorted(tss)
    # First frame is at the centre of the first window.
    first_centre = 100.0 + (4096 / 2) / SR
    assert abs(tss[0] - first_centre) < 1e-6
    # Successive frames step by hop_size / sample_rate.
    deltas = np.diff(tss)
    assert np.allclose(deltas, 2048 / SR)


def test_frame_timestamps_resync_only_past_drift_threshold() -> None:
    bander = STFTBander(
        sample_rate=8,
        calib=_calib(),
        window_size=4,
        hop_size=2,
        band_centers_hz=(1.0,),
    )
    samples = np.zeros(4, dtype=np.int32)  # 0.5 s capture block

    first = bander.feed(samples, block_ts=100.0)
    assert first[0][0] == 100.25

    # The sample-count clock expects this block at 100.5. A 0.6 s skew is
    # beyond the threshold, so the buffered tail jumps forward with it.
    resynced = bander.feed(samples, block_ts=101.1)
    assert resynced[0][0] == 101.1

    # The clock now expects 101.6. A 0.4 s skew is tolerated as timestamp
    # jitter, so frame time continues from the sample-count clock unchanged.
    steady = bander.feed(samples, block_ts=102.0)
    assert steady[0][0] == 101.6


def test_silence_is_clipped_to_floor() -> None:
    bander = STFTBander(sample_rate=SR, calib=_calib())
    silent = np.zeros(SR, dtype=np.int32)
    frames = bander.feed(silent, 0.0)
    assert frames
    bands = frames[-1][1]
    # _DB_MIN is -20.0; silent input ends up there after the noise floor clamp.
    assert np.all(bands <= -19.99)


def test_reset_clears_buffer() -> None:
    bander = STFTBander(sample_rate=SR, calib=_calib())
    # Feed half a window — no frames yet.
    half = _tone(1000.0, 2048)
    frames = bander.feed(half, 0.0)
    assert frames == []
    bander.reset()
    # After reset, an incomplete buffer should not silently complete.
    frames = bander.feed(half, 5.0)
    assert frames == []
