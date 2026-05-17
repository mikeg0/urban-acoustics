"""/api/v1/devices/{id}/telemetry — historical reads.

Phase 1 acceptance requires ``raw`` and ``1m`` resolutions. ``1h`` is served by
the same ``time_bucket`` path; Timescale continuous aggregates are an
optimisation we'll wire up if/when the query is too slow, not a correctness
prerequisite. Window caps (24 h / 30 d / 1 y) match plans/phase-1-contracts.md.
"""

from __future__ import annotations

from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from ...contracts import TelemetryPoint, TelemetryReadResponse, TelemetryResolution
from ...db import get_session
from ...models import Device

router = APIRouter()

# Resolution → (Postgres interval literal, max window in seconds).
# `raw` has no bucket; the cap stays so a careless `from=0` doesn't fetch
# years of points.
_RESOLUTIONS: dict[TelemetryResolution, tuple[str | None, int]] = {
    TelemetryResolution.RAW: (None, 24 * 3600),
    TelemetryResolution.ONE_MINUTE: ("1 minute", 30 * 24 * 3600),
    TelemetryResolution.ONE_HOUR: ("1 hour", 365 * 24 * 3600),
}


@router.get("/devices/{device_id}/telemetry", response_model=TelemetryReadResponse)
async def get_device_telemetry(
    device_id: UUID,
    from_: float = Query(..., alias="from", description="Unix seconds, inclusive"),
    to: float = Query(..., description="Unix seconds, exclusive"),
    res: TelemetryResolution = Query(TelemetryResolution.ONE_MINUTE),
    session: AsyncSession = Depends(get_session),
) -> TelemetryReadResponse:
    if to <= from_:
        raise HTTPException(status_code=400, detail="`to` must be greater than `from`")
    bucket, max_window = _RESOLUTIONS[res]
    if (to - from_) > max_window:
        raise HTTPException(
            status_code=400,
            detail=f"window too large for resolution {res.value}: max {max_window}s",
        )

    if await session.get(Device, device_id) is None:
        raise HTTPException(status_code=404, detail="device not found")

    from_dt = datetime.fromtimestamp(from_, tz=timezone.utc)
    to_dt = datetime.fromtimestamp(to, tz=timezone.utc)

    if bucket is None:
        sql = text(
            """
            SELECT ts, laeq, lafmax, lcpeak
            FROM telemetry_db
            WHERE device_id = :device_id AND ts >= :from_dt AND ts < :to_dt
            ORDER BY ts
            """
        )
    else:
        # AVG for laeq (energy-weighted in practice, but mean is fine at 1m+)
        # and MAX for the peak/exceedance fields — those are the questions
        # operators actually ask of aggregated buckets. The bucket literal is
        # interpolated rather than parametrised because `time_bucket` takes an
        # interval, and the value comes from a closed enum so there is no
        # injection surface.
        sql = text(
            f"""
            SELECT
              time_bucket(INTERVAL '{bucket}', ts) AS ts,
              AVG(laeq)::float8     AS laeq,
              MAX(lafmax)::float8   AS lafmax,
              MAX(lcpeak)::float8   AS lcpeak
            FROM telemetry_db
            WHERE device_id = :device_id AND ts >= :from_dt AND ts < :to_dt
            GROUP BY 1
            ORDER BY 1
            """
        )

    params = {"device_id": device_id, "from_dt": from_dt, "to_dt": to_dt}
    result = await session.execute(sql, params)
    points = [
        TelemetryPoint(
            ts=row.ts.timestamp(),
            laeq=row.laeq,
            lafmax=row.lafmax,
            lcpeak=row.lcpeak,
        )
        for row in result
    ]
    return TelemetryReadResponse(
        device_id=device_id,
        resolution=res,
        from_ts=from_,
        to_ts=to,
        points=points,
    )
