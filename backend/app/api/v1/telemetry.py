"""/api/v1/devices/{id}/telemetry — historical reads.

``raw`` hits the ``telemetry_db`` hypertable directly. The aggregated
resolutions read from Timescale continuous aggregates (``telemetry_1m`` /
``telemetry_1h``) created in migration 0003 — real-time aggregation fills
the gap between the last materialisation and ``now()`` automatically.
Window caps (24 h / 30 d / 1 y) match plans/phase-1-contracts.md.
"""

from __future__ import annotations

from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from ...auth.user import require_permission
from ...contracts import TelemetryPoint, TelemetryReadResponse, TelemetryResolution
from ...db import get_session
from ...queries import fetch_telemetry_points

router = APIRouter(dependencies=[Depends(require_permission("dashboard.view"))])


@router.get("/devices/{device_id}/telemetry", response_model=TelemetryReadResponse)
async def get_device_telemetry(
    device_id: UUID,
    from_: float = Query(..., alias="from", description="Unix seconds, inclusive"),
    to: float = Query(..., description="Unix seconds, exclusive"),
    res: TelemetryResolution = Query(TelemetryResolution.ONE_MINUTE),
    session: AsyncSession = Depends(get_session),
) -> TelemetryReadResponse:
    try:
        from_dt = datetime.fromtimestamp(from_, tz=timezone.utc)
        to_dt = datetime.fromtimestamp(to, tz=timezone.utc)
    except (OverflowError, OSError, ValueError) as exc:
        raise HTTPException(status_code=400, detail="timestamp out of range") from exc

    # Window validation, device 404, and the point query all live in the shared
    # helper so this and the partner noise endpoint can't drift apart.
    rows = await fetch_telemetry_points(session, device_id, from_dt, to_dt, res)
    points = [
        TelemetryPoint(
            ts=row.ts.timestamp(),
            laeq=row.laeq,
            lafmax=row.lafmax,
            lcpeak=row.lcpeak,
        )
        for row in rows
    ]
    return TelemetryReadResponse(
        device_id=device_id,
        resolution=res,
        from_ts=from_,
        to_ts=to,
        points=points,
    )
