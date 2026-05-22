"""/api/v1/devices/{id}/runtime-config — push tunables to a device.

The dashboard owns "what the device's detector threshold should be", but the
device process is what actually triggers events. This endpoint bridges the
two: an admin PUTs a new value, we persist it to ``Device.runtime_config``,
publish a retained ``config`` command to ``dev/{id}/cmd/config``, and the Pi
applies + persists it locally. The retained flag means a Pi that is offline
right now will converge on next reconnect.

Tunables exposed today: ``event_threshold_db`` and ``paused`` (the latter
suspends event encode + upload on windy days while leaving spectrogram +
telemetry untouched). The JSONB column and the whitelist below are
structured so adding more fields later is mechanical — no schema or
contract changes required.
"""

from __future__ import annotations

import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ...auth.user import ResolvedUser, require_user
from ...db import get_session
from ...ingest.mqtt_publish import get_command_publisher
from ...models import Device, DeviceHealth


log = logging.getLogger(__name__)
router = APIRouter()


# Widen a touch beyond the UI slider's 65–100 dB range so an operator who
# wants quiet-room tuning isn't forced to edit the JSON file by hand. Values
# outside the physically plausible range (e.g. <40 dB ambient is uncommon
# even at night, >115 dB approaches the mic's clip ceiling) are rejected.
_THRESHOLD_MIN_DB = 50.0
_THRESHOLD_MAX_DB = 110.0


class RuntimeConfigResponse(BaseModel):
    device_id: UUID
    # ``None`` means "no override — device uses its bootstrap default".
    event_threshold_db: float | None
    # When true the device skips event encode + upload; spectrogram and
    # telemetry continue. Defaults to false when no override has been set.
    paused: bool = False
    # SHA-derived hash from the most recent Health message. Lets the UI show
    # "Applied" once the device's reported version matches the value we
    # pushed; before then the UI displays "Pending…".
    applied_config_version: str | None


class RuntimeConfigUpdate(BaseModel):
    event_threshold_db: float | None = Field(
        default=None,
        ge=_THRESHOLD_MIN_DB,
        le=_THRESHOLD_MAX_DB,
        description="LAFmax dB above which the device opens an event",
    )
    paused: bool | None = Field(
        default=None,
        description="Suspend audio clip recording + upload while keeping spectrogram + telemetry live",
    )

    @model_validator(mode="after")
    def _at_least_one(self) -> "RuntimeConfigUpdate":
        if self.event_threshold_db is None and self.paused is None:
            raise ValueError(
                "at least one of event_threshold_db or paused must be provided"
            )
        return self


async def _latest_config_version(session: AsyncSession, device_id: UUID) -> str | None:
    stmt = (
        select(DeviceHealth.config_version)
        .where(DeviceHealth.device_id == device_id)
        .order_by(DeviceHealth.ts.desc())
        .limit(1)
    )
    result = await session.execute(stmt)
    return result.scalar_one_or_none()


@router.get(
    "/devices/{device_id}/runtime-config",
    response_model=RuntimeConfigResponse,
)
async def get_runtime_config(
    device_id: UUID,
    _user: ResolvedUser = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> RuntimeConfigResponse:
    row = await session.get(Device, device_id)
    if row is None:
        raise HTTPException(status_code=404, detail="device not found")
    cfg = row.runtime_config or {}
    threshold = cfg.get("event_threshold_db")
    return RuntimeConfigResponse(
        device_id=device_id,
        event_threshold_db=float(threshold) if threshold is not None else None,
        paused=bool(cfg.get("paused", False)),
        applied_config_version=await _latest_config_version(session, device_id),
    )


@router.put(
    "/devices/{device_id}/runtime-config",
    response_model=RuntimeConfigResponse,
)
async def put_runtime_config(
    device_id: UUID,
    body: RuntimeConfigUpdate,
    user: ResolvedUser = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> RuntimeConfigResponse:
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="admin required")
    row = await session.get(Device, device_id)
    if row is None:
        raise HTTPException(status_code=404, detail="device not found")

    publisher = get_command_publisher()
    if publisher is None or not publisher.connected:
        # Don't write the DB if we can't publish — that would leave the
        # dashboard claiming a value the device will never see. The admin
        # can retry once the broker comes back.
        raise HTTPException(
            status_code=503,
            detail="command publisher unavailable; try again shortly",
        )

    new_cfg = dict(row.runtime_config or {})
    if body.event_threshold_db is not None:
        new_cfg["event_threshold_db"] = float(body.event_threshold_db)
    if body.paused is not None:
        new_cfg["paused"] = bool(body.paused)
    row.runtime_config = new_cfg
    # Flag the JSONB mutation so SQLAlchemy treats it as a change. (Mapped
    # dict columns don't auto-detect in-place mutation; replacing the value
    # above already does the job, but be explicit for future fields.)
    await session.flush()

    try:
        await _publish_to_pi(publisher, device_id, new_cfg)
    except RuntimeError as exc:
        # Roll back the DB write so DB and broker stay consistent.
        await session.rollback()
        log.warning("runtime-config: publish failed for %s: %s", device_id, exc)
        raise HTTPException(
            status_code=503,
            detail=f"command publish failed: {exc}",
        ) from exc

    await session.commit()
    log.info(
        "runtime-config: applied %s for device=%s (user=%s)",
        {k: new_cfg[k] for k in ("event_threshold_db", "paused") if k in new_cfg},
        device_id,
        user.user_id,
    )
    threshold = new_cfg.get("event_threshold_db")
    return RuntimeConfigResponse(
        device_id=device_id,
        event_threshold_db=float(threshold) if threshold is not None else None,
        paused=bool(new_cfg.get("paused", False)),
        applied_config_version=await _latest_config_version(session, device_id),
    )


async def _publish_to_pi(publisher, device_id: UUID, cfg: dict) -> None:
    """Publish a retained ``config`` command carrying the full current overlay.

    Publishing the full overlay (not just the diff) means a fresh-broker
    replay applies the same state as the most recent edit — the Pi doesn't
    need to remember which keys were ever overridden. The Pi's ``MUTABLE_FIELDS``
    whitelist filters out anything it doesn't recognise.
    """
    # paho's publish call is sync; run it in a thread so we don't block the
    # event loop while waiting for the PUBACK.
    import asyncio

    await asyncio.to_thread(
        publisher.publish_command,
        device_id=device_id,
        cmd="config",
        args=cfg,
    )
