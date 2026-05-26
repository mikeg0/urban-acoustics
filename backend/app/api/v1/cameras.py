"""/api/v1/cameras — read-only views of the UDOT-imported roster.

Population happens out-of-band via ``scripts/refresh_cameras.py``. The
API does not call UDOT itself; if the table is empty (no key configured,
script not yet run) the list endpoint just returns ``[]``.
"""

from __future__ import annotations

import math
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ...auth.user import ResolvedUser, require_user
from ...db import get_session
from ...models import Camera, Device

router = APIRouter()


# Slightly looser than the 100 m import radius — UDOT geocodes camera
# positions to street centerlines, our mics are tied to the OSM
# intersection node, so 150 m forgives the occasional ~100 m drift.
NEAR_RADIUS_M = 150
SNAPSHOT_URL_BASE = "https://www.udottraffic.utah.gov/map/Cctv"


class CameraResponse(BaseModel):
    camera_id: int
    roadway: str | None
    direction: str | None
    location: str | None
    lat: float
    lon: float
    view_id: int | None
    description: str | None
    snapshot_url: str
    fetched_at: float


def _to_response(row: Camera) -> CameraResponse:
    snapshot = f"{SNAPSHOT_URL_BASE}/{row.view_id}" if row.view_id is not None else ""
    return CameraResponse(
        camera_id=row.camera_id,
        roadway=row.roadway,
        direction=row.direction,
        location=row.location,
        lat=row.lat,
        lon=row.lon,
        view_id=row.view_id,
        description=row.view_description,
        snapshot_url=snapshot,
        fetched_at=row.fetched_at.timestamp(),
    )


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6_371_000.0
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


@router.get("/cameras", response_model=list[CameraResponse])
async def list_cameras(
    _user: ResolvedUser = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> list[CameraResponse]:
    result = await session.execute(select(Camera).order_by(Camera.camera_id))
    return [_to_response(r) for r in result.scalars()]


@router.get(
    "/devices/{device_id}/nearest-camera",
    response_model=CameraResponse | None,
)
async def nearest_camera_for_device(
    device_id: UUID,
    _user: ResolvedUser = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> CameraResponse | None:
    device = await session.get(Device, device_id)
    if device is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="device not found")
    if device.lat is None or device.lon is None:
        return None

    rows = (await session.execute(select(Camera))).scalars().all()
    best: tuple[float, Camera] | None = None
    for cam in rows:
        d = _haversine_m(device.lat, device.lon, cam.lat, cam.lon)
        if d > NEAR_RADIUS_M:
            continue
        if best is None or d < best[0]:
            best = (d, cam)
    if best is None:
        return None
    return _to_response(best[1])
