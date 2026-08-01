"""/api/v1/devices/{id}/anomalies — context-aware event-peak scoring.

An event peak is compared with other event peaks from the same device in the
same UTC weekday/hour bucket.  This keeps both sides of the z-score in LAFmax
dB and preserves the weekly/diurnal context without comparing a triggered
peak with hourly LAeq telemetry.

Buckets need at least eight samples and non-zero variance.  Sparse buckets
fall back first to the device's hour-of-day event distribution and then to
its window-wide event distribution.  Results are ranked by classifier
confidence times contextual z-score; missing confidence is neutral so older
or unclassified events remain discoverable.
"""

from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timezone
from statistics import fmean, stdev
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from ...auth.user import require_permission
from ...contracts import AnomaliesResponse, AnomalyPoint
from ...db import get_session
from ...models import Device

router = APIRouter(dependencies=[Depends(require_permission("dashboard.view"))])

_MAX_WINDOW_SECONDS = 366 * 24 * 3600
_MIN_BASELINE_SAMPLES = 8


_EVENTS_SQL = text(
    """
    SELECT
        event_id,
        ts,
        peak_db,
        classification,
        confidence,
        (ts AT TIME ZONE 'UTC')::date AS day,
        EXTRACT(ISODOW FROM ts AT TIME ZONE 'UTC')::int - 1 AS dow,
        EXTRACT(HOUR FROM ts AT TIME ZONE 'UTC')::int AS hod
    FROM events
    WHERE device_id = :device_id
      AND ts >= :from_dt
      AND ts <  :to_dt
    """
)


@dataclass(frozen=True)
class _EventPeak:
    event_id: UUID
    ts: datetime
    day: date
    dow: int
    hour: int
    peak_db: float
    classification: str | None
    confidence: float | None


@dataclass(frozen=True)
class _Baseline:
    mean_db: float
    std_db: float
    n: int


@dataclass(frozen=True)
class _ScoredPeak:
    event: _EventPeak
    baseline: _Baseline
    delta_db: float
    z: float
    rank_score: float


def _baseline(values: list[float]) -> _Baseline | None:
    """Return usable sample statistics, or ``None`` for a weak baseline."""
    finite = [value for value in values if math.isfinite(value)]
    if len(finite) < _MIN_BASELINE_SAMPLES:
        return None
    std_db = stdev(finite)
    if not math.isfinite(std_db) or std_db <= 0.0:
        return None
    return _Baseline(mean_db=fmean(finite), std_db=std_db, n=len(finite))


def _confidence_factor(event: _EventPeak) -> float:
    """Return the class component of the ranking score.

    Confidence is only meaningful alongside a class.  Human/legacy labels
    may not carry confidence, so missing or invalid values are neutral rather
    than making those events rank zero.
    """
    if event.classification is None or event.confidence is None:
        return 1.0
    if not math.isfinite(event.confidence):
        return 1.0
    return min(max(event.confidence, 0.0), 1.0)


def score_event_peaks(events: list[_EventPeak]) -> list[_ScoredPeak]:
    """Score event peaks against device-local weekday/hour peers.

    The endpoint already scopes ``events`` to one device and query window.
    Keeping this calculation pure makes the baseline and ranking semantics
    directly testable without a TimescaleDB fixture.
    """
    context_values: dict[tuple[int, int], list[float]] = defaultdict(list)
    hour_values: dict[int, list[float]] = defaultdict(list)
    device_values: list[float] = []

    for event in events:
        if not math.isfinite(event.peak_db):
            continue
        context_values[(event.dow, event.hour)].append(event.peak_db)
        hour_values[event.hour].append(event.peak_db)
        device_values.append(event.peak_db)

    context_baselines = {
        key: stats
        for key, values in context_values.items()
        if (stats := _baseline(values)) is not None
    }
    hour_baselines = {
        hour: stats
        for hour, values in hour_values.items()
        if (stats := _baseline(values)) is not None
    }
    device_baseline = _baseline(device_values)

    scored: list[_ScoredPeak] = []
    for event in events:
        if not math.isfinite(event.peak_db):
            continue
        baseline = (
            context_baselines.get((event.dow, event.hour))
            or hour_baselines.get(event.hour)
            or device_baseline
        )
        if baseline is None:
            continue
        delta_db = event.peak_db - baseline.mean_db
        zscore = delta_db / baseline.std_db
        if not math.isfinite(zscore):
            continue
        scored.append(
            _ScoredPeak(
                event=event,
                baseline=baseline,
                delta_db=delta_db,
                z=zscore,
                rank_score=zscore * _confidence_factor(event),
            )
        )

    # Contextual surprise is the primary signal.  Class confidence modulates
    # its rank, then raw z and recency provide deterministic tie-breaks.
    scored.sort(
        key=lambda point: (
            point.rank_score,
            point.z,
            point.event.ts,
            str(point.event.event_id),
        ),
        reverse=True,
    )
    return scored


@router.get(
    "/devices/{device_id}/anomalies",
    response_model=AnomaliesResponse,
)
async def get_device_anomalies(
    device_id: UUID,
    from_: float = Query(..., alias="from", description="Unix seconds, inclusive"),
    to: float = Query(..., description="Unix seconds, exclusive"),
    z: float = Query(2.0, ge=0.0, description="minimum contextual z-score"),
    limit: int = Query(500, ge=1, le=2000),
    session: AsyncSession = Depends(get_session),
) -> AnomaliesResponse:
    if to <= from_:
        raise HTTPException(status_code=400, detail="`to` must be greater than `from`")
    if (to - from_) > _MAX_WINDOW_SECONDS:
        raise HTTPException(
            status_code=400,
            detail=f"window too large: max {_MAX_WINDOW_SECONDS}s",
        )
    if await session.get(Device, device_id) is None:
        raise HTTPException(status_code=404, detail="device not found")

    from_dt = datetime.fromtimestamp(from_, tz=timezone.utc)
    to_dt = datetime.fromtimestamp(to, tz=timezone.utc)
    rows = await session.execute(
        _EVENTS_SQL,
        {"device_id": device_id, "from_dt": from_dt, "to_dt": to_dt},
    )
    events = [
        _EventPeak(
            event_id=row.event_id,
            ts=row.ts,
            day=row.day,
            dow=int(row.dow),
            hour=int(row.hod),
            peak_db=float(row.peak_db),
            classification=row.classification,
            confidence=(float(row.confidence) if row.confidence is not None else None),
        )
        for row in rows
    ]

    points = [
        AnomalyPoint(
            event_id=point.event.event_id,
            ts=point.event.ts.timestamp(),
            day_key=point.event.day.isoformat(),
            hour=point.event.hour,
            peak_db=point.event.peak_db,
            baseline_mean_db=point.baseline.mean_db,
            delta_db=point.delta_db,
            baseline_n=point.baseline.n,
            z=point.z,
            rank_score=point.rank_score,
            classification=point.event.classification,
            confidence=point.event.confidence,
        )
        for point in score_event_peaks(events)
        if point.z >= z
    ][:limit]

    return AnomaliesResponse(
        device_id=device_id,
        from_ts=from_,
        to_ts=to,
        points=points,
    )
