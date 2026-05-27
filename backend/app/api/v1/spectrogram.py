"""/api/v1/devices/{id}/spectrogram — historical band frames + hour-tiles.

Two access paths into ``spectrogram_frames`` (Timescale hypertable):

* ``GET .../spectrogram``        — raw 1h JSON window for the 1h live ribbon.
* ``GET .../spectrogram/history``+ ``.../spectrogram/tile`` — 24h ribbon via
  precomputed 8-bit grayscale PNG tiles (one per device-hour). Closed-hour
  tiles are cached in S3; the current in-progress hour is regenerated each
  request. See ``app/spectrogram_tiles.py``.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from ...auth.user import require_permission
from ...contracts import (
    SpectrogramFrameOut,
    SpectrogramHistoryResponse,
    SpectrogramReadResponse,
    SpectrogramTileRef,
)
from ...db import get_session
from ...models import Device
from ...spectrogram_tiles import (
    TILE_COLS,
    TILE_DB_MAX,
    TILE_DB_MIN,
    TILE_ROWS,
    floor_hour_utc,
    get_or_generate_tile,
)
from ...storage import Storage, get_storage

router = APIRouter(dependencies=[Depends(require_permission("dashboard.view"))])

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


def _tile_url(device_id: UUID, hour_epoch: int) -> str:
    return f"/api/v1/devices/{device_id}/spectrogram/tile?hour={hour_epoch}"


@router.get(
    "/devices/{device_id}/spectrogram/history",
    response_model=SpectrogramHistoryResponse,
)
async def get_device_spectrogram_history(
    device_id: UUID,
    session: AsyncSession = Depends(get_session),
) -> SpectrogramHistoryResponse:
    """Return a manifest of 24 hour-tile URLs covering the rolling last 24h."""
    if await session.get(Device, device_id) is None:
        raise HTTPException(status_code=404, detail="device not found")

    now = datetime.now(timezone.utc)
    current_hour = floor_hour_utc(now)
    # Ascending: 23 closed hours then the current (in-progress) hour.
    hours = [current_hour - timedelta(hours=23 - i) for i in range(24)]
    refs = [
        SpectrogramTileRef(
            hour=h.timestamp(),
            tile_url=_tile_url(device_id, int(h.timestamp())),
        )
        for h in hours
    ]
    return SpectrogramHistoryResponse(
        device_id=device_id,
        generated_at=now.timestamp(),
        tile_db_min=TILE_DB_MIN,
        tile_db_max=TILE_DB_MAX,
        tile_rows=TILE_ROWS,
        tile_cols=TILE_COLS,
        hours=refs,
    )


@router.get("/devices/{device_id}/spectrogram/tile")
async def get_device_spectrogram_tile(
    device_id: UUID,
    hour: int = Query(..., description="UTC hour boundary, unix seconds"),
    session: AsyncSession = Depends(get_session),
    storage: Storage = Depends(get_storage),
) -> Response:
    """Return a single device-hour spectrogram tile as PNG.

    Closed hours are served from S3 with an immutable 1-year cache; the
    current in-progress hour is regenerated each request with a 30s cache.
    """
    if hour % 3600 != 0:
        raise HTTPException(status_code=400, detail="`hour` must be on an hour boundary")

    hour_dt = datetime.fromtimestamp(hour, tz=timezone.utc)
    now = datetime.now(timezone.utc)
    current_hour = floor_hour_utc(now)

    if hour_dt > current_hour:
        raise HTTPException(status_code=400, detail="`hour` is in the future")

    if await session.get(Device, device_id) is None:
        raise HTTPException(status_code=404, detail="device not found")

    is_current_hour = hour_dt == current_hour
    # Hours with no frames render as all-"no data" pixels (value 0); clients
    # already treat that as the palette floor. We do not 404 for missing
    # history because gaps and outages are part of the data.
    png = await get_or_generate_tile(
        session,
        storage,
        device_id,
        hour_dt,
        is_current_hour=is_current_hour,
    )
    cache_control = (
        "public, max-age=30"
        if is_current_hour
        else "public, max-age=31536000, immutable"
    )
    return Response(
        content=png,
        media_type="image/png",
        headers={"Cache-Control": cache_control},
    )
