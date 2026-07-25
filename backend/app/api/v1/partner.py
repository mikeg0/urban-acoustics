"""/api/v1/partner — machine-to-machine reads for partner integrations.

Authenticated by an ``X-API-Key`` / ``X-API-Secret`` header pair
(``auth.api_key``), not the dashboard cookie session — the whole router is gated
by ``require_api_key``. Built for sleep-atlas, which overlays a device's measured
dB curve on its sleep timeline, but the contract is generic: a device list for
discovery, and a per-device noise curve for a time window.

The noise curve is the same telemetry the dashboard reads (shared
``fetch_telemetry_points`` helper), serialized with ISO-8601 timestamps so the
consumer does zero timestamp conversion. The same response embeds the discrete
acoustic ``events`` (threshold-crossing clips) in the window, so a consumer gets
both the curve and the disturbance markers in one call.
"""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ...auth.api_key import require_api_key
from ...contracts import (
    NoiseCurvePoint,
    NoiseCurveResponse,
    NoiseEvent,
    TelemetryResolution,
)
from ...db import get_session
from ...models import Device
from ...queries import fetch_events, fetch_telemetry_points
from .devices import DeviceResponse, _to_response

router = APIRouter(dependencies=[Depends(require_api_key)])


@router.get("/partner/devices", response_model=list[DeviceResponse])
async def list_partner_devices(
    session: AsyncSession = Depends(get_session),
) -> list[DeviceResponse]:
    """Device discovery — same shape as the dashboard's ``GET /devices`` so a
    partner can resolve and label a ``device_id``."""
    result = await session.execute(select(Device).order_by(Device.created_at))
    return [_to_response(r) for r in result.scalars()]


@router.get("/partner/devices/{device_id}/noise", response_model=NoiseCurveResponse)
async def get_device_noise(
    device_id: UUID,
    from_: datetime = Query(..., alias="from", description="ISO-8601, tz-aware, inclusive"),
    to: datetime = Query(..., description="ISO-8601, tz-aware, exclusive"),
    res: TelemetryResolution = Query(TelemetryResolution.ONE_MINUTE),
    session: AsyncSession = Depends(get_session),
) -> NoiseCurveResponse:
    # Require an explicit offset: a naive datetime breaks the window-cap
    # subtraction in the shared helper and asyncpg's TIMESTAMPTZ binding.
    if from_.tzinfo is None or to.tzinfo is None:
        raise HTTPException(
            status_code=400,
            detail="`from` and `to` must be timezone-aware ISO-8601 (include an offset, e.g. Z)",
        )
    rows = await fetch_telemetry_points(session, device_id, from_, to, res)
    events = await fetch_events(session, device_id, from_, to)
    return NoiseCurveResponse(
        device_id=device_id,
        resolution=res,
        from_ts=from_,
        to_ts=to,
        points=[
            NoiseCurvePoint(ts=r.ts, laeq=r.laeq, lafmax=r.lafmax, lcpeak=r.lcpeak)
            for r in rows
        ],
        events=[
            NoiseEvent(
                ts=e.ts,
                peak_db=e.peak_db,
                duration_s=e.duration_s,
                classification=e.classification,
            )
            for e in events
        ],
    )
