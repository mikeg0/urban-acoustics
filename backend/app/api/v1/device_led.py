"""/api/v1/devices/{id}/led — switch the GPIO4 LED between modes.

By default the Pi drives GPIO4 from the capture loop's breach state
(``auto``). The dashboard can override that with ``on`` / ``off`` for
bring-up smoke tests or to highlight a single sensor on a busy bench;
sending ``auto`` again releases the override and the LED resumes
following the live LAFmax-vs-threshold check.

The envelope is published *non-retained* — a Pi that is offline now
misses this click and a future reboot returns to ``auto``. The
dashboard tracks the intended mode client-side; this endpoint only
pushes the next transition.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from ...auth.user import ResolvedUser, require_user
from ...db import get_session
from ...ingest.mqtt_publish import get_command_publisher
from ...models import Device


log = logging.getLogger(__name__)
router = APIRouter()


LedMode = Literal["auto", "on", "off"]


class LedUpdate(BaseModel):
    mode: LedMode


class LedResponse(BaseModel):
    device_id: UUID
    mode: LedMode


@router.put(
    "/devices/{device_id}/led",
    response_model=LedResponse,
)
async def put_led(
    device_id: UUID,
    body: LedUpdate,
    user: ResolvedUser = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> LedResponse:
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="admin required")
    row = await session.get(Device, device_id)
    if row is None:
        raise HTTPException(status_code=404, detail="device not found")

    publisher = get_command_publisher()
    if publisher is None or not publisher.connected:
        raise HTTPException(
            status_code=503,
            detail="command publisher unavailable; try again shortly",
        )

    try:
        await asyncio.to_thread(
            publisher.publish_command,
            device_id=device_id,
            cmd="led",
            args={"mode": body.mode},
            retain=False,
        )
    except RuntimeError as exc:
        log.warning("led: publish failed for %s: %s", device_id, exc)
        raise HTTPException(
            status_code=503,
            detail=f"command publish failed: {exc}",
        ) from exc

    log.info(
        "led: mode=%s for device=%s (user=%s)",
        body.mode, device_id, user.user_id,
    )
    return LedResponse(device_id=device_id, mode=body.mode)
