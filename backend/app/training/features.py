"""Pi-side feature pipeline: (frames × 30 bands) → 150-d vector.

The Pi sees only the 30 ISO 1/3-octave band envelopes its STFTBander
emits live (see ``raspberry-pi-zero-2w/urban_acoustics/dsp.py``). Training
mirrors that exactly: we build features from rows of the
``spectrogram_frames`` hypertable, never from raw audio. This keeps
train and serve in lockstep — the same numbers go in either way.

The 150 dims split into two blocks:

* 120 per-band aggregates: (mean, max, std, p95) over time, per band.
* 30 per-band energy slopes: linear regression of band-energy-vs-time,
  per band. This is the Pi-accessible analogue of the "rev sweep"
  signature the user identified for motorcycles/cars — the Pi can't
  see harmonic structure or fine frequency trajectory, but it can see
  high bands rising faster than low bands.
"""

from __future__ import annotations

import numpy as np


N_BANDS = 30
FEATURE_DIM = 150  # 4*30 aggregates + 30 slopes


def compute_pi_features(bands: np.ndarray) -> np.ndarray:
    """Build the Pi feature vector from a single event's band frames.

    ``bands`` has shape ``(n_frames, N_BANDS)`` with values in dB SPL.
    Returns a 1-D ``float32`` vector of length :data:`FEATURE_DIM`.

    A single-frame event still produces a valid vector: std collapses to
    0 and the slope is undefined (we return 0 in that case). The Pi
    classifier code computes the same thing, so test data with N=1
    behaves consistently end-to-end.
    """
    if bands.ndim != 2 or bands.shape[1] != N_BANDS:
        raise ValueError(
            f"bands must have shape (n_frames, {N_BANDS}); got {bands.shape!r}"
        )
    if bands.shape[0] == 0:
        return np.zeros(FEATURE_DIM, dtype=np.float32)

    x = bands.astype(np.float64, copy=False)

    means = x.mean(axis=0)
    maxs = x.max(axis=0)
    stds = x.std(axis=0)
    p95s = np.percentile(x, 95.0, axis=0)
    slopes = _per_band_slope(x)

    out = np.concatenate([means, maxs, stds, p95s, slopes]).astype(np.float32)
    assert out.shape == (FEATURE_DIM,)
    return out


def _per_band_slope(bands: np.ndarray) -> np.ndarray:
    """Linear-regression slope of band energy vs time index, per band.

    ``bands`` shape: ``(n_frames, N_BANDS)``. Returns ``(N_BANDS,)`` in
    dB per frame-index. Frame-index (not seconds) is fine — the
    classifier sees the same units at inference.
    """
    n = bands.shape[0]
    if n < 2:
        return np.zeros(N_BANDS, dtype=np.float64)
    t = np.arange(n, dtype=np.float64)
    t_mean = t.mean()
    t_centered = t - t_mean
    # Closed-form slope: cov(t, y) / var(t), broadcast over bands.
    var_t = float((t_centered * t_centered).sum())
    if var_t == 0.0:
        return np.zeros(N_BANDS, dtype=np.float64)
    y_centered = bands - bands.mean(axis=0, keepdims=True)
    cov = (t_centered[:, None] * y_centered).sum(axis=0)
    return cov / var_t
