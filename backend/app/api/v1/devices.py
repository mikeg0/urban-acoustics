"""/api/v1/devices — dev registration + lookup.

Full claim-code provisioning lands in task 08. This file gives operators
just enough to seed devices into the DB so the rest of the API has
something to talk to.
"""

from __future__ import annotations

from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ...auth.user import ResolvedUser, require_permission
from ...db import get_session
from ...models import Device

router = APIRouter()


class DeviceRegistration(BaseModel):
    device_id: UUID
    name: str | None = None
    location: str | None = None
    lat: float | None = None
    lon: float | None = None


class DeviceResponse(BaseModel):
    device_id: UUID
    name: str | None
    location: str | None
    lat: float | None
    lon: float | None
    created_at: float
    last_seen: float | None


def _to_response(row: Device) -> DeviceResponse:
    return DeviceResponse(
        device_id=row.device_id,
        name=row.name,
        location=row.location,
        lat=row.lat,
        lon=row.lon,
        created_at=row.created_at.timestamp(),
        last_seen=row.last_seen.timestamp() if row.last_seen else None,
    )


@router.post("/devices", status_code=status.HTTP_201_CREATED, response_model=DeviceResponse)
async def register_device(
    body: DeviceRegistration,
    _user: ResolvedUser = Depends(require_permission("device.register")),
    session: AsyncSession = Depends(get_session),
) -> DeviceResponse:
    existing = await session.get(Device, body.device_id)
    if existing is not None:
        # Registration is idempotent — repeated POSTs return the existing row.
        return _to_response(existing)

    row = Device(
        device_id=body.device_id,
        name=body.name,
        location=body.location,
        lat=body.lat,
        lon=body.lon,
        created_at=datetime.now(timezone.utc),
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return _to_response(row)


@router.get("/devices", response_model=list[DeviceResponse])
async def list_devices(
    _user: ResolvedUser = Depends(require_permission("dashboard.view")),
    session: AsyncSession = Depends(get_session),
) -> list[DeviceResponse]:
    result = await session.execute(select(Device).order_by(Device.created_at))
    return [_to_response(r) for r in result.scalars()]


@router.get("/devices/{device_id}", response_model=DeviceResponse)
async def get_device(
    device_id: UUID,
    _user: ResolvedUser = Depends(require_permission("dashboard.view")),
    session: AsyncSession = Depends(get_session),
) -> DeviceResponse:
    row = await session.get(Device, device_id)
    if row is None:
        raise HTTPException(status_code=404, detail="device not found")
    return _to_response(row)
