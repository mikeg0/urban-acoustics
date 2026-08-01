"""Round-trip contracts for the dashboard rollup endpoints.

These are not full golden-fixture tests (those live in test_contracts.py for
the wire-level Phase 1 schemas); they exist so accidental field renames on
the new dashboard models break a fast unit test rather than only the
end-to-end compose smoke.
"""

from __future__ import annotations

from uuid import UUID

import pytest

from app.contracts import (
    AnomaliesResponse,
    AnomalyPoint,
    DailySummaryPoint,
    DailySummaryResponse,
    ForecastPoint,
    ForecastResponse,
    SourceCount,
    SourcesResponse,
)


_DEVICE = UUID("00000000-0000-4000-8000-00000000000a")
_EVENT = UUID("00000000-0000-4000-8000-00000000000b")


def test_daily_summary_round_trip() -> None:
    point = DailySummaryPoint(
        date="2026-05-17",
        dow=6,
        mean=58.4,
        peak=84.1,
        breaches=3,
        peak_hour=18,
        hours=[55.0] * 24,
        event="motorcycle",
    )
    resp = DailySummaryResponse(
        device_id=_DEVICE, from_ts=1_700_000_000, to_ts=1_700_001_000,
        threshold=85.0, days=[point],
    )
    assert resp.model_dump()["days"][0]["peak_hour"] == 18


def test_daily_summary_rejects_short_hours() -> None:
    with pytest.raises(ValueError):
        DailySummaryPoint(
            date="2026-05-17", dow=0, mean=50, peak=60,
            breaches=0, peak_hour=0,
            hours=[50.0] * 12,  # too short
        )


def test_anomalies_response_round_trip() -> None:
    p = AnomalyPoint(
        event_id=_EVENT, ts=1_700_000_000.0, day_key="2026-05-17",
        hour=9, peak_db=98.4, baseline_mean_db=78.2, delta_db=20.2,
        baseline_n=31, z=3.7, rank_score=3.33,
        classification="motorcycle", confidence=0.9,
    )
    resp = AnomaliesResponse(
        device_id=_DEVICE, from_ts=1_700_000_000, to_ts=1_700_001_000,
        points=[p],
    )
    dumped = resp.model_dump()
    assert dumped["points"][0]["z"] == pytest.approx(3.7)
    assert dumped["points"][0]["delta_db"] == pytest.approx(20.2)
    assert dumped["points"][0]["baseline_n"] == 31
    assert dumped["points"][0]["classification"] == "motorcycle"


def test_forecast_response_round_trip() -> None:
    p = ForecastPoint(
        date="2026-05-18", dow=0, mean=62.0, peak=84.0,
        low=58.5, high=65.5, peak_hour=18,
    )
    resp = ForecastResponse(
        device_id=_DEVICE, generated_at=1_700_000_000.0,
        threshold=85.0, points=[p],
    )
    assert resp.points[0].peak_hour == 18


def test_sources_response_round_trip() -> None:
    resp = SourcesResponse(
        device_id=_DEVICE, from_ts=1_700_000_000, to_ts=1_700_001_000,
        total=42,
        sources=[
            SourceCount(name="motorcycle", pct=66.7, count=28),
            SourceCount(name="car", pct=33.3, count=14),
        ],
    )
    assert sum(s.count for s in resp.sources) == resp.total
    assert resp.sources[0].pct + resp.sources[1].pct == pytest.approx(100.0)
