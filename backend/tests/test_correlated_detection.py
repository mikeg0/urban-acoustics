from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.detection.peaks import Sample, adaptive_peaks, correlate_peak


START = datetime(2026, 7, 25, tzinfo=timezone.utc)


def _series(values: list[float]) -> list[Sample]:
    return [Sample(START + timedelta(seconds=i), value) for i, value in enumerate(values)]


def test_adaptive_peak_uses_trailing_median_and_merges_event() -> None:
    samples = _series([50.0] * 10 + [59.0, 65.0, 61.0] + [50.0] * 5)
    peaks = adaptive_peaks(
        samples,
        baseline_window_s=30,
        min_baseline_samples=5,
        rise_db=8,
        min_db=55,
        merge_window_s=3,
        cooldown_s=5,
    )
    assert len(peaks) == 1
    assert peaks[0].ts == START + timedelta(seconds=11)
    assert peaks[0].value == 65.0
    assert peaks[0].baseline == 50.0
    assert peaks[0].rise == 15.0


def test_adaptive_peak_requires_enough_baseline_samples() -> None:
    peaks = adaptive_peaks(
        _series([80.0, 50.0, 50.0, 50.0]),
        baseline_window_s=30,
        min_baseline_samples=3,
        rise_db=8,
        min_db=55,
        merge_window_s=2,
        cooldown_s=0,
    )
    assert peaks == []


def test_correlation_defaults_to_symmetric_window() -> None:
    outside = adaptive_peaks(
        _series([50.0] * 10 + [70.0]),
        baseline_window_s=30,
        min_baseline_samples=5,
        rise_db=8,
        min_db=55,
        merge_window_s=2,
        cooldown_s=0,
    )[0]
    inside = [
        type(outside)(outside.ts - timedelta(seconds=9), 60, 50, 10),
        type(outside)(outside.ts + timedelta(seconds=4), 58, 50, 8),
        type(outside)(outside.ts + timedelta(seconds=11), 70, 50, 20),
    ]
    assert correlate_peak(outside, inside, window_s=10) == inside[1]


def test_no_inside_peak_means_outside_only() -> None:
    outside = adaptive_peaks(
        _series([50.0] * 10 + [70.0]),
        baseline_window_s=30,
        min_baseline_samples=5,
        rise_db=8,
        min_db=55,
        merge_window_s=2,
        cooldown_s=0,
    )[0]
    assert correlate_peak(outside, [], window_s=10) is None


def test_cooldown_keeps_first_peak_across_polling_boundaries() -> None:
    samples = _series([50.0] * 10 + [65.0] + [50.0] * 4 + [75.0])
    peaks = adaptive_peaks(
        samples,
        baseline_window_s=30,
        min_baseline_samples=5,
        rise_db=8,
        min_db=55,
        merge_window_s=2,
        cooldown_s=20,
    )
    assert len(peaks) == 1
    assert peaks[0].ts == START + timedelta(seconds=10)
