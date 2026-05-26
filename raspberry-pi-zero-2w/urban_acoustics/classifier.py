"""Pi-side noise-class classifier.

Pure-numpy logistic regression inference over the 30-band 1/3-octave
spectrogram envelopes the supervisor already has. The model weights are
trained off-device by ``backend/app/training`` and shipped to the Pi as
a ``pi_head.npz`` file containing scaler + LR weights.

The features computed here MUST stay byte-identical to those produced
by ``backend/app/training/features.compute_pi_features``. The training
pipeline pulls bands from ``spectrogram_frames`` (which is exactly what
the Pi's ``STFTBander`` emits live), so as long as both sides use the
same aggregation, there is no train/serve skew.
"""

from __future__ import annotations

import dataclasses
import logging
import pathlib
from typing import Optional

import numpy as np


log = logging.getLogger(__name__)


N_BANDS = 30
FEATURE_DIM = 150  # mirror backend/app/training/features.FEATURE_DIM


@dataclasses.dataclass(frozen=True)
class Prediction:
    label: str
    confidence: float
    model_version: str


@dataclasses.dataclass(frozen=True)
class _ModelArrays:
    coef: np.ndarray         # (n_classes, FEATURE_DIM), float32
    intercept: np.ndarray    # (n_classes,), float32
    classes: tuple[str, ...]
    scaler_mean: np.ndarray  # (FEATURE_DIM,), float32
    scaler_scale: np.ndarray  # (FEATURE_DIM,), float32
    model_version: str


def _compute_features(bands: np.ndarray) -> np.ndarray:
    """Pi-side feature extraction. Must match backend training exactly.

    ``bands`` shape: ``(n_frames, N_BANDS)``. Returns a 1-D float32
    vector of length :data:`FEATURE_DIM`.
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
    return out


def _per_band_slope(bands: np.ndarray) -> np.ndarray:
    n = bands.shape[0]
    if n < 2:
        return np.zeros(N_BANDS, dtype=np.float64)
    t = np.arange(n, dtype=np.float64)
    t_centered = t - t.mean()
    var_t = float((t_centered * t_centered).sum())
    if var_t == 0.0:
        return np.zeros(N_BANDS, dtype=np.float64)
    y_centered = bands - bands.mean(axis=0, keepdims=True)
    cov = (t_centered[:, None] * y_centered).sum(axis=0)
    return cov / var_t


def _softmax(z: np.ndarray) -> np.ndarray:
    z = z - z.max()
    e = np.exp(z)
    return e / e.sum()


class Classifier:
    """Loads ``pi_head.npz`` once and predicts on demand.

    On any load failure the classifier degrades gracefully: ``predict``
    returns ``None`` so the supervisor can fall back to uploading the
    event with no preliminary label rather than crashing. This is the
    "fail open" property the plan depends on — a broken classifier must
    never cause data loss.
    """

    def __init__(self, weights: _ModelArrays) -> None:
        self._w = weights

    @property
    def model_version(self) -> str:
        return self._w.model_version

    @property
    def classes(self) -> tuple[str, ...]:
        return self._w.classes

    def predict(self, bands: np.ndarray) -> Prediction:
        """Predict from a ``(n_frames, N_BANDS)`` band slice.

        ``bands`` should cover the event's full duration. The result's
        ``confidence`` is the softmax probability of the top class —
        useful for thresholding and as a sort key in the UI.
        """
        features = _compute_features(bands)
        x = (features - self._w.scaler_mean) / self._w.scaler_scale
        # Guard against zero-variance features that produced scale==0 at
        # training time — np.divide would have produced NaN/inf, which
        # would then poison the logits.
        x = np.nan_to_num(x, nan=0.0, posinf=0.0, neginf=0.0)
        logits = self._w.coef @ x + self._w.intercept
        probs = _softmax(logits)
        idx = int(probs.argmax())
        return Prediction(
            label=self._w.classes[idx],
            confidence=float(probs[idx]),
            model_version=self._w.model_version,
        )


def load_classifier(path: pathlib.Path) -> Optional[Classifier]:
    """Load a classifier from disk. Returns ``None`` on any failure.

    Reasons the file might be missing or unreadable: first boot before a
    model has been trained, a deploy that forgot to ship the weights,
    a corrupted SD card. None of these should crash the supervisor;
    the absence of a model just disables auto-labeling.
    """
    if not path.exists():
        log.warning("classifier: weights file %s not found — disabling", path)
        return None
    try:
        with np.load(path, allow_pickle=True) as data:
            coef = np.asarray(data["coef"], dtype=np.float32)
            intercept = np.asarray(data["intercept"], dtype=np.float32)
            classes_obj = data["classes"]
            scaler_mean = np.asarray(data["scaler_mean"], dtype=np.float32)
            scaler_scale = np.asarray(data["scaler_scale"], dtype=np.float32)
            model_version = str(data["model_version"])
    except Exception as exc:  # noqa: BLE001 - any load failure must fail open
        # np.load raises UnpicklingError, ValueError, EOFError, or OSError
        # depending on how the file is mangled. We need ALL of these to
        # degrade to "no classifier" rather than crash the supervisor —
        # losing audio because the weights file is corrupt would be
        # worse than just not auto-labeling.
        log.warning("classifier: failed to load %s (%s) — disabling", path, exc)
        return None

    classes = tuple(str(c) for c in np.asarray(classes_obj).tolist())
    if (
        coef.ndim != 2
        or coef.shape[0] != len(classes)
        or coef.shape[1] != FEATURE_DIM
        or intercept.shape != (len(classes),)
        or scaler_mean.shape != (FEATURE_DIM,)
        or scaler_scale.shape != (FEATURE_DIM,)
    ):
        log.warning(
            "classifier: %s has inconsistent shapes — disabling "
            "(coef=%s intercept=%s mean=%s scale=%s classes=%d)",
            path, coef.shape, intercept.shape, scaler_mean.shape,
            scaler_scale.shape, len(classes),
        )
        return None
    # Replace any zero scales with 1.0 so divide-by-zero doesn't blow up.
    # A zero-scale feature carries no info; setting scale to 1 makes the
    # standardised value equal to (raw - mean), which is fine to feed
    # into a logit with a near-zero corresponding coefficient.
    if (scaler_scale == 0.0).any():
        scaler_scale = scaler_scale.copy()
        scaler_scale[scaler_scale == 0.0] = 1.0

    weights = _ModelArrays(
        coef=coef,
        intercept=intercept,
        classes=classes,
        scaler_mean=scaler_mean,
        scaler_scale=scaler_scale,
        model_version=model_version,
    )
    log.info(
        "classifier: loaded %s (model_version=%s, %d classes)",
        path, model_version, len(classes),
    )
    return Classifier(weights)
