"""/api/v1/devices/{id}/spectrogram — historical band frames.

Backs the "1-hour ribbon" beneath the live scrolling spectrogram on the
dashboard. Frames are persisted by the ingest worker into
``spectrogram_frames`` (Timescale hypertable); this route just serves them
in a bounded window. No bucketing yet — at the ~10 Hz wire rate, a 1 h
window is ~36 k rows / device, ~14 MB on the wire. If we later raise the
window cap the right move is to add ``time_bucket`` MAX aggregation here.
"""

from __future__ import annotations

from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from ...contracts import SpectrogramFrameOut, SpectrogramReadResponse
from ...db import get_session
from ...models import Device

router = APIRouter()

# Cap matches the dashboard ribbon's design window (1 hour). Raising
# requires adding aggregation — see module docstring.
_MAX_WINDOW_SECONDS = 3600


@router.get(
    "/devices/{device_id}/spectrogram",
    response_model=SpectrogramReadResponse,
)
async def get_device_spectrogram(
    device_id: UUID,
    from_: float = Query(..., alias="from", description="Unix seconds, inclusive"),
    to: float = Query(..., description="Unix seconds, exclusive"),
    session: AsyncSession = Depends(get_session),
) -> SpectrogramReadResponse:
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

    sql = text(
        """
        SELECT ts, bands
        FROM spectrogram_frames
        WHERE device_id = :device_id AND ts >= :from_dt AND ts < :to_dt
        ORDER BY ts
        """
    )
    result = await session.execute(
        sql, {"device_id": device_id, "from_dt": from_dt, "to_dt": to_dt}
    )
    frames = [
        SpectrogramFrameOut(ts=row.ts.timestamp(), bands=list(row.bands))
        for row in result
    ]
    return SpectrogramReadResponse(
        device_id=device_id,
        from_ts=from_,
        to_ts=to,
        frames=frames,
    )
