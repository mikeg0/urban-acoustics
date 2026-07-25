from __future__ import annotations

from uuid import UUID

import pytest

from app.contracts import (
    CorrelatedEventCandidatePatch,
    CorrelatedEventSettingsUpdate,
)


OUTSIDE = UUID("00000000-0000-4000-8000-00000000000a")
INSIDE = UUID("9fa8fde4-1e12-5133-8d1c-323a661e78f9")


def _settings(**updates):
    values = {
        "enabled": True,
        "outside_device_id": OUTSIDE,
        "inside_device_id": INSIDE,
        "metric": "lafmax",
        "baseline_window_s": 300,
        "min_baseline_samples": 60,
        "outside_rise_db": 8,
        "inside_rise_db": 6,
        "outside_min_db": 60,
        "inside_min_db": 45,
        "peak_merge_window_s": 5,
        "peak_cooldown_s": 20,
        "correlation_window_s": 10,
        "snapshot_before_s": 15,
        "snapshot_after_s": 15,
        "scan_interval_s": 10,
    }
    values.update(updates)
    return CorrelatedEventSettingsUpdate(**values)


def test_default_pair_settings_accept_ten_second_correlation() -> None:
    settings = _settings()
    assert settings.correlation_window_s == 10
    assert settings.outside_device_id == OUTSIDE
    assert settings.inside_device_id == INSIDE


def test_settings_reject_same_device_pair() -> None:
    with pytest.raises(ValueError, match="must differ"):
        _settings(inside_device_id=OUTSIDE)


def test_settings_reject_min_samples_larger_than_window() -> None:
    with pytest.raises(ValueError, match="cannot exceed"):
        _settings(baseline_window_s=30, min_baseline_samples=31)


@pytest.mark.parametrize("label", ["real", "wind", "unsure"])
def test_candidate_patch_accepts_review_labels(label: str) -> None:
    assert CorrelatedEventCandidatePatch(label=label).label == label


def test_candidate_patch_rejects_empty_body() -> None:
    with pytest.raises(ValueError, match="required"):
        CorrelatedEventCandidatePatch()
