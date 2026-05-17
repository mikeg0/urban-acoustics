"""/api/v1/devices/{id}/summary/daily — dashboard year-view rollup.

Reads ``telemetry_1h`` (continuous aggregate, see migration 0003) for the
``hours[24]`` pivot, ``mean``, ``peak``, ``breaches``, and ``peak_hour``
per UTC day, then left-joins ``events`` to attach the most-common
classification name of the day (the dashboard's "event label").

Single query, one row per (day, hour-of-day) — at the 366-day window cap
that's at most 366 × 24 = 8,784 rows. Pivot and aggregation happen in
Python so the SQL stays simple and the CA can be indexed straightforwardly.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from ...contracts import DailySummaryPoint, DailySummaryResponse
from ...db import get_session
from ...models import Device

router = APIRouter()

_MAX_WINDOW_SECONDS = 366 * 24 * 3600


_HOURLY_SQL = text(
    """
    SELECT
        (bucket AT TIME ZONE 'UTC')::date          AS day,
        EXTRACT(HOUR FROM bucket AT TIME ZONE 'UTC')::int AS hod,
        laeq                                       AS mean_h,
        lafmax                                     AS peak_h
    FROM telemetry_1h
    WHERE device_id = :device_id
      AND bucket >= :from_dt
      AND bucket <  :to_dt
    ORDER BY day, hod
    """
)


_TOP_CLASS_SQL = text(
    """
    SELECT day, classification FROM (
        SELECT
            (ts AT TIME ZONE 'UTC')::date AS day,
            classification,
            ROW_NUMBER() OVER (
                PARTITION BY (ts AT TIME ZONE 'UTC')::date
                ORDER BY COUNT(*) DESC, classification ASC
            ) AS rk
        FROM events
        WHERE device_id = :device_id
          AND ts >= :from_dt
          AND ts <  :to_dt
          AND classification IS NOT NULL
        GROUP BY 1, 2
    ) ranked
    WHERE rk = 1
    """
)


@router.get(
    "/devices/{device_id}/summary/daily",
    response_model=DailySummaryResponse,
)
async def get_device_daily_summary(
    device_id: UUID,
    from_: float = Query(..., alias="from", description="Unix seconds, inclusive"),
    to: float = Query(..., description="Unix seconds, exclusive"),
    threshold: float = Query(
        85.0,
        ge=0.0,
        le=200.0,
        description="dB threshold for hourly breach counting",
    ),
    session: AsyncSession = Depends(get_session),
) -> DailySummaryResponse:
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
    params = {"device_id": device_id, "from_dt": from_dt, "to_dt": to_dt}

    hourly_result = await session.execute(_HOURLY_SQL, params)

    # day-date -> (hours[24] of mean_h, max(peak_h) seen)
    hours_by_day: dict[str, list[float | None]] = defaultdict(lambda: [None] * 24)
    peak_by_day: dict[str, float] = {}
    for row in hourly_result:
        day_key = row.day.isoformat()
        hours_by_day[day_key][row.hod] = float(row.mean_h)
        prev = peak_by_day.get(day_key)
        peak = float(row.peak_h)
        if prev is None or peak > prev:
            peak_by_day[day_key] = peak

    class_result = await session.execute(_TOP_CLASS_SQL, params)
    event_by_day: dict[str, str] = {
        row.day.isoformat(): row.classification for row in class_result
    }

    days_out: list[DailySummaryPoint] = []
    for day_key in sorted(hours_by_day.keys()):
        hours = hours_by_day[day_key]
        present = [(h, v) for h, v in enumerate(hours) if v is not None]
        if not present:
            continue
        mean = sum(v for _, v in present) / len(present)
        breaches = sum(1 for _, v in present if v >= threshold)
        peak_hour = max(present, key=lambda hv: hv[1])[0]
        dow = datetime.strptime(day_key, "%Y-%m-%d").weekday()
        days_out.append(
            DailySummaryPoint(
                date=day_key,
                dow=dow,
                mean=mean,
                peak=peak_by_day.get(day_key, mean),
                breaches=breaches,
                peak_hour=peak_hour,
                hours=hours,
                event=event_by_day.get(day_key),
            )
        )

    return DailySummaryResponse(
        device_id=device_id,
        from_ts=from_,
        to_ts=to,
        threshold=threshold,
        days=days_out,
    )
