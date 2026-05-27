"""/api/v1/devices/{id}/anomalies — events scored against hourly baseline.

For each event in the window, compute a z-score of its ``peak_db`` against
the LAeq stats of all hours on the *same UTC day*: ``z = (peak_db -
day_mean) / day_std``. Events whose ``z`` exceeds the query parameter are
returned, newest first.

The hourly baseline comes from ``telemetry_1h`` (continuous aggregate, see
migration 0003). One SQL fetches the day-level mean/std for every day that
has at least one event in the window; the per-event z-scoring is done in
Python.
"""

from __future__ import annotations

import math
from datetime import datetime, timezone
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


_EVENTS_SQL = text(
    """
    SELECT
        event_id,
        ts,
        peak_db,
        classification,
        (ts AT TIME ZONE 'UTC')::date     AS day,
        EXTRACT(HOUR FROM ts AT TIME ZONE 'UTC')::int AS hod
    FROM events
    WHERE device_id = :device_id
      AND ts >= :from_dt
      AND ts <  :to_dt
    ORDER BY ts DESC
    LIMIT :limit
    """
)


_DAY_STATS_SQL = text(
    """
    SELECT
        (bucket AT TIME ZONE 'UTC')::date AS day,
        AVG(laeq)::float8                 AS day_mean,
        STDDEV_SAMP(laeq)::float8         AS day_std
    FROM telemetry_1h
    WHERE device_id = :device_id
      AND bucket >= :from_dt
      AND bucket <  :to_dt
    GROUP BY 1
    """
)


_HOUR_MEAN_SQL = text(
    """
    SELECT
        (bucket AT TIME ZONE 'UTC')::date AS day,
        EXTRACT(HOUR FROM bucket AT TIME ZONE 'UTC')::int AS hod,
        laeq                              AS hour_mean
    FROM telemetry_1h
    WHERE device_id = :device_id
      AND bucket >= :from_dt
      AND bucket <  :to_dt
    """
)


@router.get(
    "/devices/{device_id}/anomalies",
    response_model=AnomaliesResponse,
)
async def get_device_anomalies(
    device_id: UUID,
    from_: float = Query(..., alias="from", description="Unix seconds, inclusive"),
    to: float = Query(..., description="Unix seconds, exclusive"),
    z: float = Query(2.0, ge=0.0, description="minimum z-score"),
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
    params = {"device_id": device_id, "from_dt": from_dt, "to_dt": to_dt}

    # We pull `limit * 4` candidate events to leave room for z-score filtering
    # while still capping work. The final return is capped at `limit`.
    candidates = await session.execute(_EVENTS_SQL, {**params, "limit": limit * 4})
    events = list(candidates)
    if not events:
        return AnomaliesResponse(
            device_id=device_id, from_ts=from_, to_ts=to, points=[]
        )

    day_stats_rows = await session.execute(_DAY_STATS_SQL, params)
    day_stats: dict[str, tuple[float, float]] = {
        r.day.isoformat(): (
            float(r.day_mean),
            float(r.day_std) if r.day_std is not None else 0.0,
        )
        for r in day_stats_rows
    }

    hour_mean_rows = await session.execute(_HOUR_MEAN_SQL, params)
    hour_mean: dict[tuple[str, int], float] = {
        (r.day.isoformat(), int(r.hod)): float(r.hour_mean) for r in hour_mean_rows
    }

    points: list[AnomalyPoint] = []
    for row in events:
        day_key = row.day.isoformat()
        hour = int(row.hod)
        day = day_stats.get(day_key)
        if day is None:
            continue
        day_mean, day_std = day
        # Without variance, no z-score is meaningful — skip rather than emit
        # a misleading infinity.
        if day_std <= 0.0 or not math.isfinite(day_std):
            continue
        peak_db = float(row.peak_db)
        zscore = (peak_db - day_mean) / day_std
        if zscore < z:
            continue
        points.append(
            AnomalyPoint(
                event_id=row.event_id,
                ts=row.ts.timestamp(),
                day_key=day_key,
                hour=hour,
                peak_db=peak_db,
                hour_mean_db=hour_mean.get((day_key, hour), day_mean),
                z=zscore,
                classification=row.classification,
            )
        )
        if len(points) >= limit:
            break

    return AnomaliesResponse(
        device_id=device_id,
        from_ts=from_,
        to_ts=to,
        points=points,
    )
