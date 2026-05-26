"""Pi-side classifier round-trip tests.

The Pi loads ``pi_head.npz`` with pure numpy. These tests confirm:

* The backend training feature vector matches what the Pi computes from
  the same bands. Train/serve skew here would silently mis-classify
  everything in prod.
* The classifier's ``load_classifier`` degrades to ``None`` on missing /
  corrupt files instead of raising — failing open is what keeps the
  supervisor uploading data when the model is broken.
* A round-trip ``save → load → predict`` produces the expected label
  with a sensible confidence.

Imports the Pi module by path because it lives outside the backend
package; this matches how the deployed firmware uses it.
"""

from __future__ import annotations

import importlib.util
import pathlib
import sys
import types

import numpy as np
import pytest

from app.training.features import (
    FEATURE_DIM,
    N_BANDS,
    compute_pi_features,
)


def _find_pi_classifier_path() -> pathlib.Path | None:
    """Locate ``raspberry-pi-zero-2w/urban_acoustics/classifier.py``.

    Resolves on the host (where parents[2] is the repo root) and in the
    backend container when the Pi tree is mounted at ``/raspberry-pi-zero-2w``.
    Returns ``None`` so tests can be skipped instead of failing when the
    Pi tree isn't reachable from the current test runner.
    """
    candidates = [
        pathlib.Path(__file__).resolve().parents[2]
        / "raspberry-pi-zero-2w"
        / "urban_acoustics"
        / "classifier.py",
        pathlib.Path("/raspberry-pi-zero-2w/urban_acoustics/classifier.py"),
    ]
    for p in candidates:
        if p.exists():
            return p
    return None


PI_CLASSIFIER_PATH = _find_pi_classifier_path()

pytestmark = pytest.mark.skipif(
    PI_CLASSIFIER_PATH is None,
    reason="Pi tree not reachable from this test runner (mount it into the container to enable).",
)


def _load_pi_classifier_module() -> types.ModuleType:
    """Load raspberry-pi-zero-2w/urban_acoustics/classifier.py as a module.

    The Pi tree isn't installable as a package from the backend, so we
    import it by file path. Cached on ``sys.modules`` so the spec only
    runs once per test session.
    """
    name = "_pi_classifier_under_test"
    if name in sys.modules:
        return sys.modules[name]
    assert PI_CLASSIFIER_PATH is not None  # guarded by pytestmark
    spec = importlib.util.spec_from_file_location(name, PI_CLASSIFIER_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _make_bands(n_frames: int = 20, seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    return rng.uniform(20.0, 80.0, size=(n_frames, N_BANDS)).astype(np.float32)


def test_pi_features_match_backend_features() -> None:
    """The Pi's _compute_features must produce the same vector as the
    backend training pipeline. Any drift would corrupt the model."""
    pi = _load_pi_classifier_module()
    bands = _make_bands()
    backend_v = compute_pi_features(bands)
    pi_v = pi._compute_features(bands)
    assert backend_v.shape == pi_v.shape == (FEATURE_DIM,)
    np.testing.assert_allclose(backend_v, pi_v, rtol=1e-6, atol=1e-6)


def test_features_handle_single_frame_input() -> None:
    """Slopes are undefined for n=1 — both sides must agree to return 0."""
    pi = _load_pi_classifier_module()
    bands = _make_bands(n_frames=1)
    backend_v = compute_pi_features(bands)
    pi_v = pi._compute_features(bands)
    np.testing.assert_allclose(backend_v, pi_v, rtol=1e-6, atol=1e-6)
    # The last 30 dims are slopes; for a single frame they should be 0.
    assert np.all(pi_v[-30:] == 0.0)


def test_features_handle_empty_input() -> None:
    pi = _load_pi_classifier_module()
    bands = np.empty((0, N_BANDS), dtype=np.float32)
    pi_v = pi._compute_features(bands)
    backend_v = compute_pi_features(bands)
    np.testing.assert_allclose(backend_v, pi_v)
    assert pi_v.shape == (FEATURE_DIM,)
    assert np.all(pi_v == 0.0)


def test_features_reject_wrong_band_count() -> None:
    pi = _load_pi_classifier_module()
    bands = np.zeros((10, N_BANDS - 1), dtype=np.float32)
    with pytest.raises(ValueError):
        pi._compute_features(bands)
    with pytest.raises(ValueError):
        compute_pi_features(bands)


def test_classifier_round_trip(tmp_path: pathlib.Path) -> None:
    """Hand-build a trivial two-class model, save it in the same format
    train.py would, and verify the Pi loads + predicts correctly."""
    pi = _load_pi_classifier_module()
    classes = ["car", "wind"]
    # Pick coefs that strongly weight the first feature so the prediction
    # is determined by ``features[0]``. Standardiser is identity.
    coef = np.zeros((2, FEATURE_DIM), dtype=np.float32)
    coef[0, 0] = +5.0  # "car" if features[0] is high
    coef[1, 0] = -5.0  # "wind" if features[0] is low
    intercept = np.zeros(2, dtype=np.float32)
    scaler_mean = np.zeros(FEATURE_DIM, dtype=np.float32)
    scaler_scale = np.ones(FEATURE_DIM, dtype=np.float32)

    head_path = tmp_path / "pi_head.npz"
    np.savez(
        head_path,
        coef=coef,
        intercept=intercept,
        classes=np.asarray(classes, dtype=object),
        scaler_mean=scaler_mean,
        scaler_scale=scaler_scale,
        model_version=np.asarray("pi-v1"),
    )

    clf = pi.load_classifier(head_path)
    assert clf is not None
    assert clf.model_version == "pi-v1"
    assert clf.classes == ("car", "wind")

    # Hand-craft band data whose mean of band-0 is high — should yield car.
    bands_car = _make_bands()
    bands_car[:, 0] = 100.0
    pred_car = clf.predict(bands_car)
    assert pred_car.label == "car"
    assert 0.0 <= pred_car.confidence <= 1.0
    assert pred_car.confidence > 0.5

    # Low band-0 → wind.
    bands_wind = _make_bands()
    bands_wind[:, 0] = -100.0
    pred_wind = clf.predict(bands_wind)
    assert pred_wind.label == "wind"


def test_classifier_missing_file_returns_none(tmp_path: pathlib.Path) -> None:
    pi = _load_pi_classifier_module()
    assert pi.load_classifier(tmp_path / "does_not_exist.npz") is None


def test_classifier_corrupt_file_returns_none(tmp_path: pathlib.Path) -> None:
    pi = _load_pi_classifier_module()
    bad = tmp_path / "pi_head.npz"
    bad.write_bytes(b"not a real npz")
    assert pi.load_classifier(bad) is None


def test_classifier_inconsistent_shapes_returns_none(tmp_path: pathlib.Path) -> None:
    pi = _load_pi_classifier_module()
    bad = tmp_path / "pi_head.npz"
    # 2 classes but only 1 intercept row — load should reject.
    np.savez(
        bad,
        coef=np.zeros((2, FEATURE_DIM), dtype=np.float32),
        intercept=np.zeros(1, dtype=np.float32),
        classes=np.asarray(["car", "wind"], dtype=object),
        scaler_mean=np.zeros(FEATURE_DIM, dtype=np.float32),
        scaler_scale=np.ones(FEATURE_DIM, dtype=np.float32),
        model_version=np.asarray("pi-v1"),
    )
    assert pi.load_classifier(bad) is None


def test_classifier_zero_scale_does_not_nan(tmp_path: pathlib.Path) -> None:
    """A zero entry in scaler_scale shouldn't produce NaN predictions."""
    pi = _load_pi_classifier_module()
    scaler_scale = np.ones(FEATURE_DIM, dtype=np.float32)
    scaler_scale[0] = 0.0  # train-time pathology: constant feature
    head_path = tmp_path / "pi_head.npz"
    np.savez(
        head_path,
        coef=np.zeros((2, FEATURE_DIM), dtype=np.float32),
        intercept=np.asarray([1.0, 0.0], dtype=np.float32),
        classes=np.asarray(["car", "wind"], dtype=object),
        scaler_mean=np.zeros(FEATURE_DIM, dtype=np.float32),
        scaler_scale=scaler_scale,
        model_version=np.asarray("pi-v1"),
    )
    clf = pi.load_classifier(head_path)
    assert clf is not None
    pred = clf.predict(_make_bands())
    assert pred.label == "car"  # intercept tiebreaker
    assert not np.isnan(pred.confidence)
