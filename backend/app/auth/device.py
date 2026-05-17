"""Device authentication.

Phase 1 dev path: an upstream mTLS terminator (Traefik passthrough today, the
backend's own mTLS once task 08 lands) puts the device's UUID in a trusted
header. The dependency below reads it, looks up the device row, and returns
a :class:`ResolvedDevice` for the handler.

Task 08 will replace ``X-Device-Id`` with a JWT issued from ``POST
/api/v1/devices/token`` after mTLS verification, but the dependency surface
stays the same — handlers just call ``Depends(require_device)`` either way.
"""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..models import Device


@dataclass(slots=True)
class ResolvedDevice:
    device_id: UUID
    name: str | None
    location: str | None


async def require_device(
    x_device_id: str | None = Header(default=None, alias="X-Device-Id"),
    session: AsyncSession = Depends(get_session),
) -> ResolvedDevice:
    if not x_device_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="missing X-Device-Id header",
        )
    try:
        device_id = UUID(x_device_id)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="X-Device-Id is not a valid UUID",
        ) from exc

    row = await session.get(Device, device_id)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="device is not registered",
        )

    return ResolvedDevice(device_id=row.device_id, name=row.name, location=row.location)
