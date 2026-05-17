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

import numpy as np

from .calibration import Calibration


_EPS = 1e-30  # keep log10 from blowing up on a fully silent block

# Contract bounds — values outside this range fail Pydantic validation on
# the cloud side. Silence produces ~ -480 dB without the floor; we clamp
# rather than reject so a quiet block still publishes valid telemetry.
_DB_MIN = -20.0
_DB_MAX = 200.0

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
