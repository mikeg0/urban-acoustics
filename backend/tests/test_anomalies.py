"""Unit coverage for like-for-like event anomaly scoring."""

from __future__ import annotations

from datetime import date, datetime, timezone
from statistics import stdev
from uuid import UUID

import pytest

from app.api.v1.anomalies import _EventPeak, score_event_peaks


def _event(
    index: int,
    peak_db: float,
    *,
    dow: int = 0,
    hour: int = 9,
    classification: str | None = "motorcycle",
    confidence: float | None = 1.0,
) -> _EventPeak:
    return _EventPeak(
        event_id=UUID(int=index + 1),
        ts=datetime(2026, 5, index + 1, hour, tzinfo=timezone.utc),
        day=date(2026, 5, index + 1),
        dow=dow,
        hour=hour,
        peak_db=peak_db,
        classification=classification,
        confidence=confidence,
    )


def test_scores_peak_against_same_weekday_hour_event_peaks() -> None:
    values = [70.0, 72.0, 74.0, 76.0, 78.0, 80.0, 82.0, 92.0]
    scored = score_event_peaks([_event(i, value) for i, value in enumerate(values)])

    loudest = next(point for point in scored if point.event.peak_db == 92.0)
    expected_mean = sum(values) / len(values)
    assert loudest.baseline.n == 8
    assert loudest.baseline.mean_db == pytest.approx(expected_mean)
    assert loudest.baseline.std_db == pytest.approx(stdev(values))
    assert loudest.delta_db == pytest.approx(92.0 - expected_mean)
    assert loudest.z == pytest.approx((92.0 - expected_mean) / stdev(values))


def test_sparse_weekday_bucket_falls_back_to_same_hour() -> None:
    events = [
        _event(i, 70.0 + i, dow=i % 4, hour=9)
        for i in range(8)
    ]

    scored = score_event_peaks(events)

    assert len(scored) == 8
    assert {point.baseline.n for point in scored} == {8}
    assert all(point.baseline.mean_db == pytest.approx(73.5) for point in scored)


def test_sparse_hour_falls_back_to_device_event_peaks() -> None:
    events = [
        _event(i, 68.0 + i, dow=i % 4, hour=i)
        for i in range(8)
    ]

    scored = score_event_peaks(events)

    assert len(scored) == 8
    assert {point.baseline.n for point in scored} == {8}
    assert all(point.baseline.mean_db == pytest.approx(71.5) for point in scored)


def test_fewer_than_eight_device_events_has_no_baseline() -> None:
    assert score_event_peaks([_event(i, 70.0 + i) for i in range(7)]) == []


def test_class_confidence_modulates_context_rank() -> None:
    values = [60.0, 65.0, 70.0, 75.0, 80.0, 85.0, 90.0, 95.0]
    events = [
        _event(i, value, confidence=0.1 if value == 95.0 else 1.0)
        for i, value in enumerate(values)
    ]

    scored = score_event_peaks(events)
    loudest = next(point for point in scored if point.event.peak_db == 95.0)
    second_loudest = next(point for point in scored if point.event.peak_db == 90.0)

    assert loudest.rank_score == pytest.approx(loudest.z * 0.1)
    assert second_loudest.rank_score == pytest.approx(second_loudest.z)
    assert scored.index(second_loudest) < scored.index(loudest)


def test_missing_class_confidence_is_neutral() -> None:
    events = [
        _event(i, 70.0 + i, classification=None, confidence=None)
        for i in range(8)
    ]

    scored = score_event_peaks(events)

    assert all(point.rank_score == pytest.approx(point.z) for point in scored)


def test_zero_variance_baseline_is_not_scored() -> None:
    assert score_event_peaks([_event(i, 75.0) for i in range(8)]) == []
