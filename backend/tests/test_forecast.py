"""Pure-Python unit tests for the dashboard forecast's seasonal-naive math.

DB-backed integration is verified by the compose-stack smoke run; here we
exercise the algorithm directly so weekday alignment, n=1 collapse, and
missing-weekday gaps are pinned down without needing Timescale.
"""

from __future__ import annotations

from datetime import date

import pytest

from app.api.v1.forecast import _HistoricalDay, compute_naive_seasonal_forecast


def _mk(day: date, mean: float, peak: float, peak_hour: int = 12) -> _HistoricalDay:
    return _HistoricalDay(day=day, day_mean=mean, day_peak=peak, peak_hour=peak_hour)


def test_aligns_targets_to_same_weekday() -> None:
    # 2026-05-04 is a Monday. Seed Mondays with 60dB means, Tuesdays with 70dB.
    history = [
        _mk(date(2026, 4, 27), 60.0, 80.0, 8),   # Mon
        _mk(date(2026, 5, 4),  60.0, 80.0, 8),   # Mon
        _mk(date(2026, 4, 28), 70.0, 90.0, 18),  # Tue
        _mk(date(2026, 5, 5),  70.0, 90.0, 18),  # Tue
    ]
    today = date(2026, 5, 10)  # Sunday → next Mon=11, Tue=12, ...
    points = compute_naive_seasonal_forecast(history, today, days_ahead=2)

    assert [p.date for p in points] == ["2026-05-11", "2026-05-12"]
    assert points[0].mean == pytest.approx(60.0)
    assert points[0].peak == pytest.approx(80.0)
    assert points[1].mean == pytest.approx(70.0)
    assert points[1].peak == pytest.approx(90.0)


def test_ci_band_collapses_with_single_sample() -> None:
    history = [_mk(date(2026, 5, 4), 65.0, 88.0)]  # one Monday only
    today = date(2026, 5, 10)
    points = compute_naive_seasonal_forecast(history, today, days_ahead=1)

    assert len(points) == 1
    p = points[0]
    assert p.mean == pytest.approx(65.0)
    assert p.low == pytest.approx(65.0)
    assert p.high == pytest.approx(65.0)


def test_missing_weekday_is_skipped() -> None:
    # History only has a single Tuesday — Monday and Wednesday targets get no
    # forecast point. Caller treats fewer-than-`days_ahead` as incomplete.
    history = [_mk(date(2026, 5, 5), 70.0, 95.0)]  # Tue
    today = date(2026, 5, 10)  # next Mon=11, Tue=12, Wed=13
    points = compute_naive_seasonal_forecast(history, today, days_ahead=3)

    assert [p.date for p in points] == ["2026-05-12"]


def test_peak_hour_is_mode() -> None:
    history = [
        _mk(date(2026, 4, 27), 60.0, 80.0, peak_hour=8),
        _mk(date(2026, 5, 4),  60.0, 80.0, peak_hour=8),
        _mk(date(2026, 5, 11), 60.0, 80.0, peak_hour=18),
    ]
    today = date(2026, 5, 17)  # Sun → next Mon=18
    points = compute_naive_seasonal_forecast(history, today, days_ahead=1)

    assert points[0].peak_hour == 8


def test_ci_band_widens_with_variance() -> None:
    # Two samples 10 dB apart → pstdev = 5, 95% half-width = 9.8.
    history = [
        _mk(date(2026, 4, 27), 60.0, 80.0),
        _mk(date(2026, 5, 4),  70.0, 90.0),
    ]
    today = date(2026, 5, 10)
    points = compute_naive_seasonal_forecast(history, today, days_ahead=1)

    assert points[0].mean == pytest.approx(65.0)
    assert points[0].low == pytest.approx(55.2, abs=0.05)
    assert points[0].high == pytest.approx(74.8, abs=0.05)


def test_empty_history_returns_no_points() -> None:
    points = compute_naive_seasonal_forecast([], date(2026, 5, 17), days_ahead=7)
    assert points == []
