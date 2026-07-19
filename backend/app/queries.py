"""Shared read queries used by more than one router.

``fetch_telemetry_points`` backs both the dashboard telemetry read
(``/api/v1/devices/{id}/telemetry``) and the partner noise-curve read
(``/api/v1/partner/devices/{id}/noise``). Keeping the resolution→view mapping,
window caps, device-existence check, and the hypertable / continuous-aggregate
SQL in one place stops the two endpoints' semantics from drifting.

Callers pass tz-aware datetimes and format the returned ``ts`` however their
wire contract needs (Unix seconds for telemetry, ISO-8601 for partner).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from .contracts import TelemetryResolution
from .models import Device

# Resolution → (continuous-aggregate view name or None for raw, max window secs).
# `raw` reads the hypertable directly; the cap stays so a careless wide window
# doesn't fetch years of points. Window caps match plans/phase-1-contracts.md.
_RESOLUTIONS: dict[TelemetryResolution, tuple[str | None, int]] = {
    TelemetryResolution.RAW: (None, 24 * 3600),
    TelemetryResolution.ONE_MINUTE: ("telemetry_1m", 30 * 24 * 3600),
    TelemetryResolution.ONE_HOUR: ("telemetry_1h", 365 * 24 * 3600),
}


@dataclass(slots=True)
class TelemetryRow:
    ts: datetime
    laeq: float
    lafmax: float
    lcpeak: float


async def fetch_telemetry_points(
    session: AsyncSession,
    device_id: UUID,
    from_dt: datetime,
    to_dt: datetime,
    res: TelemetryResolution,
) -> list[TelemetryRow]:
    """Validate the window, confirm the device exists, and return ordered rows
    for ``[from_dt, to_dt)`` at resolution ``res``.

    Raises ``HTTPException`` — 400 on a bad/oversized window, 404 on an unknown
    device — so both callers surface identical errors.
    """
    if to_dt <= from_dt:
        raise HTTPException(status_code=400, detail="`to` must be greater than `from`")
    view, max_window = _RESOLUTIONS[res]
    if (to_dt - from_dt).total_seconds() > max_window:
        raise HTTPException(
            status_code=400,
            detail=f"window too large for resolution {res.value}: max {max_window}s",
        )

    if await session.get(Device, device_id) is None:
        raise HTTPException(status_code=404, detail="device not found")

    if view is None:
        sql = text(
            """
            SELECT ts, laeq, lafmax, lcpeak
            FROM telemetry_db
            WHERE device_id = :device_id AND ts >= :from_dt AND ts < :to_dt
            ORDER BY ts
            """
        )
    else:
        # View name comes from a closed enum mapping, so the f-string is safe.
        sql = text(
            f"""
            SELECT bucket AS ts, laeq, lafmax, lcpeak
            FROM {view}
            WHERE device_id = :device_id AND bucket >= :from_dt AND bucket < :to_dt
            ORDER BY bucket
            """
        )

    params = {"device_id": device_id, "from_dt": from_dt, "to_dt": to_dt}
    result = await session.execute(sql, params)
    return [
        TelemetryRow(ts=row.ts, laeq=row.laeq, lafmax=row.lafmax, lcpeak=row.lcpeak)
        for row in result
    ]
