"""/api/v1/devices/{id}/forecast — seasonal-naive day-level forecast.

For each future date ``d``, find the last ``N`` occurrences of the same
weekday in the prior 28 days, then return their mean/peak averaged across
occurrences. The 95% CI is built from the std of those occurrences; for
``peak_hour`` we take the mode (ties broken by earliest hour).

This is a baseline, not a model. It exists so the dashboard's forecast
panel has honest data — better than synthetic noise, less misleading than
shipping a real model that hasn't been trained.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from statistics import mean, pstdev
from typing import Iterable
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from ...auth.user import require_permission
from ...contracts import ForecastPoint, ForecastResponse
from ...db import get_session
from ...models import Device

router = APIRouter(dependencies=[Depends(require_permission("dashboard.view"))])

_LOOKBACK_DAYS = 28


@dataclass(frozen=True)
class _HistoricalDay:
    day: date
    day_mean: float
    day_peak: float
    peak_hour: int


def compute_naive_seasonal_forecast(
    history: Iterable[_HistoricalDay],
    today: date,
    days_ahead: int,
) -> list[ForecastPoint]:
    """Pure helper — same algorithm the endpoint runs, but no DB.

    For each target date ``today + offset`` (1 ≤ offset ≤ days_ahead), find
    all history rows with the same weekday and average their mean/peak.
    Missing-weekday history yields no point (the dashboard treats fewer
    than ``days_ahead`` results as "incomplete history"). ``low``/``high``
    is a 95 % CI built from the population std of the means; with n=1 the
    band degenerates to a line.
    """
    by_dow: dict[int, list[_HistoricalDay]] = defaultdict(list)
    for h in history:
        by_dow[h.day.weekday()].append(h)

    points: list[ForecastPoint] = []
    for offset in range(1, days_ahead + 1):
        target = today + timedelta(days=offset)
        dow = target.weekday()
        samples = by_dow.get(dow, [])
        if not samples:
            continue
        means = [s.day_mean for s in samples]
        peaks = [s.day_peak for s in samples]
        peak_hours = [s.peak_hour for s in samples]
        m = mean(means)
        p = mean(peaks)
        s = pstdev(means) if len(means) > 1 else 0.0
        peak_hour = Counter(peak_hours).most_common(1)[0][0]
        points.append(
            ForecastPoint(
                date=target.isoformat(),
                dow=dow,
                mean=m,
                peak=p,
                low=m - 1.96 * s,
                high=m + 1.96 * s,
                peak_hour=peak_hour,
            )
        )
    return points


_DAILY_SQL = text(
    """
    SELECT
        (bucket AT TIME ZONE 'UTC')::date AS day,
        AVG(laeq)::float8                 AS day_mean,
        MAX(lafmax)::float8               AS day_peak
    FROM telemetry_1h
    WHERE device_id = :device_id
      AND bucket >= :from_dt
      AND bucket <  :to_dt
    GROUP BY 1
    """
)


_PEAK_HOUR_SQL = text(
    """
    SELECT day, hod FROM (
        SELECT
            (bucket AT TIME ZONE 'UTC')::date          AS day,
            EXTRACT(HOUR FROM bucket AT TIME ZONE 'UTC')::int AS hod,
            ROW_NUMBER() OVER (
                PARTITION BY (bucket AT TIME ZONE 'UTC')::date
                -- Refer to the underlying column/expression, not the `hod`
                -- alias: Postgres window-ORDER BY runs against the input
                -- relation, where aliases aren't visible yet.
                ORDER BY laeq DESC,
                         EXTRACT(HOUR FROM bucket AT TIME ZONE 'UTC') ASC
            ) AS rk
        FROM telemetry_1h
        WHERE device_id = :device_id
          AND bucket >= :from_dt
          AND bucket <  :to_dt
    ) ranked
    WHERE rk = 1
    """
)


@router.get(
    "/devices/{device_id}/forecast",
    response_model=ForecastResponse,
)
async def get_device_forecast(
    device_id: UUID,
    days: int = Query(7, ge=1, le=14),
    threshold: float = Query(85.0, ge=0.0, le=200.0),
    session: AsyncSession = Depends(get_session),
) -> ForecastResponse:
    if await session.get(Device, device_id) is None:
        raise HTTPException(status_code=404, detail="device not found")

    now = datetime.now(timezone.utc)
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    from_dt = today - timedelta(days=_LOOKBACK_DAYS)
    to_dt = today
    params = {"device_id": device_id, "from_dt": from_dt, "to_dt": to_dt}

    daily_rows = list(await session.execute(_DAILY_SQL, params))
    peak_rows = list(await session.execute(_PEAK_HOUR_SQL, params))
    peak_hour_by_day: dict[date, int] = {r.day: int(r.hod) for r in peak_rows}

    history = [
        _HistoricalDay(
            day=r.day,
            day_mean=float(r.day_mean),
            day_peak=float(r.day_peak),
            peak_hour=peak_hour_by_day.get(r.day, 0),
        )
        for r in daily_rows
    ]

    points = compute_naive_seasonal_forecast(history, today.date(), days)

    return ForecastResponse(
        device_id=device_id,
        generated_at=now.timestamp(),
        threshold=threshold,
        points=points,
    )
