"""DSP for 1 Hz acoustic telemetry.

Phase 1 sticks to numpy only — scipy is too heavy for the Pi Zero 2 W memory
budget (the import alone costs ~50 MiB resident). We approximate A- and C-
weighting in the frequency domain on a one-second window:

* take the FFT of the block
* multiply by the IEC 61672 frequency-response magnitude
* read off LAeq / LAFmax from the inverse-transformed block, LCpeak from the
  C-weighted block's peak absolute value

This is not a true causal IIR weighting filter, but at the 1 Hz output rate
the difference from the standard reference is well below the per-device
calibration uncertainty. The Phase 2 path is to swap this for a cascade of
biquads (still numpy-only, just a small native ring of state).

All public helpers return values in dB SPL after the calibration offset has
been applied. Callers should not add an offset themselves.
"""

from __future__ import annotations

import math
from typing import Sequence

import numpy as np

from .calibration import Calibration


_EPS = 1e-30  # keep log10 from blowing up on a fully silent block

# Contract bounds — values outside this range fail Pydantic validation on
# the cloud side. Silence produces ~ -480 dB without the floor; we clamp
# rather than reject so a quiet block still publishes valid telemetry.
_DB_MIN = -20.0
_DB_MAX = 200.0

# ISO 266 nominal centre frequencies (Hz), 1/3-octave, 20 Hz → 16 kHz.
# Thirty bands — covers the audible range comfortably, fits in a single
# JSON line over MQTT, and stays well below Nyquist at 48 kHz.
ISO_THIRD_OCTAVE_HZ: tuple[float, ...] = (
    20.0, 25.0, 31.5, 40.0, 50.0, 63.0, 80.0, 100.0,
    125.0, 160.0, 200.0, 250.0, 315.0, 400.0, 500.0, 630.0,
    800.0, 1000.0, 1250.0, 1600.0, 2000.0, 2500.0, 3150.0, 4000.0,
    5000.0, 6300.0, 8000.0, 10000.0, 12500.0, 16000.0,
)

# Bin spacing of 125 ms windows inside the 1 s integration block, used to
# estimate LAFmax. This is coarser than the 125 ms exponential time constant
# the spec calls for, but at the 1 Hz output rate the difference is well
# inside the per-device calibration uncertainty.
_LAFMAX_SUBBLOCKS = 8


# IEC 61672 reference frequencies and normalisation constants.
_F_A1 = 20.598997
_F_A2 = 107.65265
_F_A3 = 737.86223
_F_A4 = 12194.217
_A_NORM_DB = 2.00       # 0 dB at 1 kHz
_C_NORM_DB = 0.0619     # 0 dB at 1 kHz


def _pcm_to_float(samples: np.ndarray) -> np.ndarray:
    """Convert S32_LE samples to a float32 signal in roughly ``[-1, 1]``.

    INMP441 packs 24 valid bits in the high bits of a 32-bit word; the LSBs
    are zero. Dividing by 2**31 keeps the same numerical convention as a
    true 32-bit signed sample so the calibration constants don't change if
    the mic is replaced.
    """
    if samples.dtype != np.int32:
        samples = samples.astype(np.int32, copy=False)
    return samples.astype(np.float32, copy=False) * (1.0 / (1 << 31))


def _a_weight_response(freqs: np.ndarray) -> np.ndarray:
    f2 = freqs * freqs
    num = (_F_A4 ** 2) * (f2 ** 2)
    den = (
        (f2 + _F_A1 ** 2)
        * np.sqrt((f2 + _F_A2 ** 2) * (f2 + _F_A3 ** 2))
        * (f2 + _F_A4 ** 2)
    )
    h = num / np.maximum(den, _EPS)
    # +2.00 dB normalisation → multiply by 10^(2/20).
    return h * (10.0 ** (_A_NORM_DB / 20.0))


def _c_weight_response(freqs: np.ndarray) -> np.ndarray:
    f2 = freqs * freqs
    num = (_F_A4 ** 2) * f2
    den = (f2 + _F_A1 ** 2) * (f2 + _F_A4 ** 2)
    h = num / np.maximum(den, _EPS)
    return h * (10.0 ** (_C_NORM_DB / 20.0))


class WeightedBlock:
    """Cached A- and C-weighted versions of a 1 s block.

    Computing the FFT twice for one block was the obvious wart in the first
    pass — we now do a single forward FFT and apply each magnitude response
    in-place before the inverse transform.
    """

    __slots__ = ("_a_weighted", "_c_weighted")

    def __init__(self, signal_a: np.ndarray, signal_c: np.ndarray) -> None:
        self._a_weighted = signal_a
        self._c_weighted = signal_c

    @property
    def a(self) -> np.ndarray:
        return self._a_weighted

    @property
    def c(self) -> np.ndarray:
        return self._c_weighted


def weight_block(samples: np.ndarray, sample_rate: int) -> WeightedBlock:
    x = _pcm_to_float(samples)
    n = len(x)
    if n == 0:
        empty = np.empty(0, dtype=np.float32)
        return WeightedBlock(empty, empty)
    spec = np.fft.rfft(x)
    freqs = np.fft.rfftfreq(n, d=1.0 / sample_rate)
    a_h = _a_weight_response(freqs)
    c_h = _c_weight_response(freqs)
    sig_a = np.fft.irfft(spec * a_h, n=n).astype(np.float32, copy=False)
    sig_c = np.fft.irfft(spec * c_h, n=n).astype(np.float32, copy=False)
    return WeightedBlock(sig_a, sig_c)


def _db_from_amplitude(x: float, calib: Calibration) -> float:
    db = 20.0 * math.log10(max(x, _EPS)) + calib.total_offset_db
    if db < _DB_MIN:
        return _DB_MIN
    if db > _DB_MAX:
        return _DB_MAX
    return db


def laeq(weighted: WeightedBlock, calib: Calibration) -> float:
    a = weighted.a
    if a.size == 0:
        return _DB_MIN
    rms = float(np.sqrt(np.mean(a.astype(np.float64) ** 2)))
    return _db_from_amplitude(rms, calib)


def lafmax(weighted: WeightedBlock, calib: Calibration) -> float:
    a = weighted.a
    if a.size == 0:
        return _DB_MIN
    sub_n = max(1, a.size // _LAFMAX_SUBBLOCKS)
    chunks = a[: sub_n * _LAFMAX_SUBBLOCKS].reshape(_LAFMAX_SUBBLOCKS, sub_n).astype(np.float64)
    sub_rms = np.sqrt(np.mean(chunks ** 2, axis=1))
    return _db_from_amplitude(float(sub_rms.max()), calib)


def lcpeak(weighted: WeightedBlock, calib: Calibration) -> float:
    c = weighted.c
    if c.size == 0:
        return _DB_MIN
    peak = float(np.max(np.abs(c)))
    return _db_from_amplitude(peak, calib)


def compute_telemetry(samples: np.ndarray, sample_rate: int, calib: Calibration) -> tuple[float, float, float]:
    """Return ``(laeq, lafmax, lcpeak)`` for a single 1 s PCM block."""
    weighted = weight_block(samples, sample_rate)
    return laeq(weighted, calib), lafmax(weighted, calib), lcpeak(weighted, calib)


class STFTBander:
    """Rolling STFT → 1/3-octave dB-SPL bands.

    Maintains an internal sliding sample buffer. Each call to :meth:`feed`
    appends new PCM samples and emits zero or more band frames (one per
    completed STFT hop). At ``window_size=4096`` / ``hop_size=2048`` on a
    48 kHz signal that yields ~23 frames/sec — we throttle the publisher
    downstream so the actual emit rate matches the contract (~10 Hz).

    Bands are unweighted (LZ-like) dB SPL — the calibration offset is
    applied so the *sum across all bands* is comparable to ``laeq``.
    Clients can apply A-weighting cosmetically by multiplying each band
    by the A-weight response at its centre frequency.
    """

    __slots__ = (
        "_sr", "_calib", "_window_size", "_hop_size",
        "_buffer", "_buffer_start_ts",
        "_window", "_scale_factor", "_band_slices",
    )

    def __init__(
        self,
        *,
        sample_rate: int,
        calib: Calibration,
        window_size: int = 4096,
        hop_size: int = 2048,
        band_centers_hz: Sequence[float] = ISO_THIRD_OCTAVE_HZ,
    ) -> None:
        if window_size <= 0 or hop_size <= 0 or hop_size > window_size:
            raise ValueError("window_size and hop_size must be positive; hop ≤ window")
        self._sr = sample_rate
        self._calib = calib
        self._window_size = window_size
        self._hop_size = hop_size
        self._buffer = np.empty(0, dtype=np.float32)
        self._buffer_start_ts: float | None = None

        w = np.hanning(window_size).astype(np.float64)
        self._window = w.astype(np.float32)
        # Pre-bake the conversion factor that turns "sum of one-sided
        # |Y[k]|^2 inside a band" into mean-square of the un-windowed signal
        # contained in that band. Broadband-noise approximation; for a pure
        # tone the level reads ~1.5 dB low which is the standard cost of
        # Hann-windowed band power.
        w_norm = float(np.mean(w ** 2))
        self._scale_factor = 2.0 / (window_size ** 2 * w_norm)

        # Map each 1/3-octave band to a contiguous slice of FFT bins.
        bin_width = sample_rate / window_size
        nyquist = sample_rate / 2.0
        max_bin = window_size // 2
        slices: list[tuple[int, int]] = []
        for fc in band_centers_hz:
            lo = fc * (2.0 ** (-1.0 / 6))  # 1/3-octave lower edge
            hi = fc * (2.0 ** (1.0 / 6))   # 1/3-octave upper edge
            if hi > nyquist:
                hi = nyquist
            k_lo = max(1, int(math.ceil(lo / bin_width)))
            k_hi = min(max_bin, int(math.floor(hi / bin_width)))
            if k_hi < k_lo:
                # Band narrower than the FFT bin width — happens for low
                # bands at small window sizes (e.g. 20 Hz at 4096-pt FFT
                # on 48 kHz, bin width ≈ 11.7 Hz). Snap to the nearest
                # bin so the visual still shows *something* there.
                snap = max(1, min(max_bin, int(round(fc / bin_width))))
                k_lo = k_hi = snap
            slices.append((k_lo, k_hi))
        self._band_slices = slices

    @property
    def frame_rate_hz(self) -> float:
        return self._sr / self._hop_size

    @property
    def n_bands(self) -> int:
        return len(self._band_slices)

    def reset(self) -> None:
        """Drop the internal buffer (call on capture restart / discontinuity)."""
        self._buffer = np.empty(0, dtype=np.float32)
        self._buffer_start_ts = None

    def feed(self, samples: np.ndarray, block_ts: float) -> list[tuple[float, np.ndarray]]:
        """Append a PCM block and return any completed frames.

        ``block_ts`` is the wall-clock time of ``samples[0]``. Returned
        frame timestamps are at the *centre* of the STFT window — that's
        the natural "now" for a spectrogram cell.
        """
        x = _pcm_to_float(samples)
        if self._buffer.size == 0:
            self._buffer_start_ts = block_ts
        self._buffer = np.concatenate([self._buffer, x])

        frames: list[tuple[float, np.ndarray]] = []
        half_window_s = (self._window_size / 2) / self._sr
        while self._buffer.size >= self._window_size and self._buffer_start_ts is not None:
            chunk = self._buffer[: self._window_size]
            bands_db = self._compute_frame(chunk)
            centre_ts = self._buffer_start_ts + half_window_s
            frames.append((centre_ts, bands_db))
            self._buffer = self._buffer[self._hop_size:]
            self._buffer_start_ts += self._hop_size / self._sr
        return frames

    def _compute_frame(self, chunk: np.ndarray) -> np.ndarray:
        y = chunk * self._window
        spec = np.fft.rfft(y.astype(np.float64))
        # |Y[k]|^2 over the one-sided spectrum, with the doubling that
        # accounts for the negative-frequency mirror baked into the
        # pre-computed scale factor.
        psd = (spec.real * spec.real + spec.imag * spec.imag)
        bands = np.empty(len(self._band_slices), dtype=np.float64)
        for i, (k_lo, k_hi) in enumerate(self._band_slices):
            bands[i] = psd[k_lo : k_hi + 1].sum()
        bands *= self._scale_factor
        db = 10.0 * np.log10(np.maximum(bands, _EPS)) + self._calib.total_offset_db
        return np.clip(db, _DB_MIN, _DB_MAX).astype(np.float32)
