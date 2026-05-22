"""/api/v1/events — upload intent, listing, single event, playback URL."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from ...auth.device import ResolvedDevice, require_device
from ...auth.user import ResolvedUser, require_user
from ...contracts import (
    EventIndexEntry,
    EventIndexResponse,
    EventIntentRequest,
    EventIntentResponse,
    EventResponse,
    EventStatus,
    is_valid_event_transition,
)
from ...db import get_session
from ...models import Event, Label
from ...settings import Settings, get_settings
from ...storage import Storage, get_storage

router = APIRouter()
log = logging.getLogger("urban-acoustics.events")


async def _verify_uploaded(row: Event, storage: Storage, session: AsyncSession) -> None:
    """If the event is ``uploaded`` and the object is present in storage,
    transition to ``available``. The MQTT worker can only confirm the
    device claimed to upload; we confirm it landed in MinIO before
    handing out playback URLs, per phase-1-contracts state machine.
    """
    if row.status != EventStatus.UPLOADED.value or not row.storage_key:
        return
    head = await storage.head_object(row.storage_key)
    if head is None:
        return
    # Size mismatch is treated as a hard failure: MinIO already enforces the
    # signed sha256, so a wrong size means something else is going on.
    content_length = head.get("ContentLength")
    if content_length is not None and content_length != row.size:
        log.warning(
            "events: size mismatch for event_id=%s storage=%s db=%s",
            row.event_id, content_length, row.size,
        )
        row.status = EventStatus.FAILED.value
        row.updated_at = datetime.now(timezone.utc)
        await session.commit()
        return
    row.status = EventStatus.AVAILABLE.value
    row.updated_at = datetime.now(timezone.utc)
    await session.commit()


def _to_response(
    row: Event,
    *,
    playback: tuple[str, float] | None = None,
    label: str | None = None,
) -> EventResponse:
    return EventResponse(
        event_id=row.event_id,
        device_id=row.device_id,
        ts=row.ts.timestamp(),
        duration_s=row.duration_s,
        peak_db=row.peak_db,
        sha256=row.sha256,
        size=row.size,
        status=EventStatus(row.status),
        classification=row.classification,
        confidence=row.confidence,
        model_version=row.model_version,
        label=label,
        playback_url=playback[0] if playback else None,
        playback_url_expires_at=playback[1] if playback else None,
    )


async def _latest_labels(
    session: AsyncSession, event_ids: list[UUID]
) -> dict[UUID, str]:
    """Return the most recent user label per event id."""
    if not event_ids:
        return {}
    stmt = (
        select(Label.event_id, Label.label)
        .where(Label.event_id.in_(event_ids))
        .order_by(Label.event_id, desc(Label.created_at))
    )
    out: dict[UUID, str] = {}
    for event_id, label in (await session.execute(stmt)).all():
        out.setdefault(event_id, label)
    return out


@router.post(
    "/events/intent",
    response_model=EventIntentResponse,
    status_code=status.HTTP_200_OK,
)
async def create_event_intent(
    body: EventIntentRequest,
    device: ResolvedDevice = Depends(require_device),
    session: AsyncSession = Depends(get_session),
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
) -> EventIntentResponse:
    """Allocate a stable object key and return a short-lived presigned PUT.

    Idempotent on ``event_id``: the same ``(device_id, event_id)`` always
    returns the same ``storage_key``. The URL itself is fresh on every call
    (default 60 s TTL) so devices can always make progress.
    """
    now = datetime.now(timezone.utc)
    event_ts = datetime.fromtimestamp(body.ts, tz=timezone.utc)

    existing = await session.get(Event, body.event_id)
    if existing is not None:
        if existing.device_id != device.device_id:
            # Another device's event id — refuse rather than leak signed URLs.
            raise HTTPException(status_code=403, detail="event belongs to another device")
        if (existing.sha256, existing.size) != (body.sha256, body.size):
            raise HTTPException(
                status_code=409,
                detail="event metadata (sha256/size) does not match prior announce",
            )
        storage_key = existing.storage_key or storage.event_key(
            device.device_id, body.event_id, event_ts
        )
        if existing.storage_key is None:
            existing.storage_key = storage_key
        if is_valid_event_transition(EventStatus(existing.status), EventStatus.UPLOAD_INTENT_CREATED):
            existing.status = EventStatus.UPLOAD_INTENT_CREATED.value
        existing.updated_at = now
    else:
        storage_key = storage.event_key(device.device_id, body.event_id, event_ts)
        existing = Event(
            event_id=body.event_id,
            device_id=device.device_id,
            ts=event_ts,
            duration_s=body.duration_s,
            peak_db=body.peak_db,
            sha256=body.sha256,
            size=body.size,
            content_type=body.content_type,
            storage_key=storage_key,
            status=EventStatus.UPLOAD_INTENT_CREATED.value,
            created_at=now,
            updated_at=now,
        )
        session.add(existing)

    await session.commit()
    await session.refresh(existing)

    signed = storage.presign_put(
        storage_key,
        sha256_hex=body.sha256,
        size=body.size,
        ttl_seconds=settings.EVENT_INTENT_TTL_SECONDS,
        content_type=body.content_type,
    )
    return EventIntentResponse(
        event_id=existing.event_id,
        status=EventStatus(existing.status),
        upload_url=signed.url,
        storage_key=signed.storage_key,
        expires_at=signed.expires_at,
        required_headers=signed.required_headers,
    )


@router.get("/events", response_model=list[EventResponse])
async def list_events(
    device_id: UUID | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=500),
    from_ts: float | None = Query(default=None, alias="from"),
    to_ts: float | None = Query(default=None, alias="to"),
    _user: ResolvedUser = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> list[EventResponse]:
    stmt = select(Event).order_by(desc(Event.ts)).limit(limit)
    if device_id is not None:
        stmt = stmt.where(Event.device_id == device_id)
    if from_ts is not None:
        stmt = stmt.where(Event.ts >= datetime.fromtimestamp(from_ts, tz=timezone.utc))
    if to_ts is not None:
        stmt = stmt.where(Event.ts < datetime.fromtimestamp(to_ts, tz=timezone.utc))
    result = await session.execute(stmt)
    rows = list(result.scalars())
    labels = await _latest_labels(session, [r.event_id for r in rows])
    return [_to_response(r, label=labels.get(r.event_id)) for r in rows]


@router.get("/events/index", response_model=EventIndexResponse)
async def list_event_index(
    device_id: UUID | None = Query(default=None),
    limit: int = Query(default=5000, ge=1, le=10000),
    from_ts: float | None = Query(default=None, alias="from"),
    to_ts: float | None = Query(default=None, alias="to"),
    _user: ResolvedUser = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> EventIndexResponse:
    """Lightweight (ts, duration_s) listing for visual indicators.

    Strips the full ``EventResponse`` envelope so a 24h ribbon overlay can
    afford a much larger window — no labels lookup, no playback URLs, no
    UUID/sha256 fields. Same auth + filter semantics as ``GET /events``.
    """
    stmt = (
        select(Event.event_id, Event.ts, Event.duration_s)
        .order_by(desc(Event.ts))
        .limit(limit)
    )
    if device_id is not None:
        stmt = stmt.where(Event.device_id == device_id)
    if from_ts is not None:
        stmt = stmt.where(Event.ts >= datetime.fromtimestamp(from_ts, tz=timezone.utc))
    if to_ts is not None:
        stmt = stmt.where(Event.ts < datetime.fromtimestamp(to_ts, tz=timezone.utc))
    rows = (await session.execute(stmt)).all()
    event_ids = [event_id for event_id, _ts, _duration in rows]
    labeled_ids: set[UUID] = set()
    if event_ids:
        labeled_stmt = select(Label.event_id).where(Label.event_id.in_(event_ids)).distinct()
        labeled_ids = {row for (row,) in (await session.execute(labeled_stmt)).all()}
    return EventIndexResponse(
        device_id=device_id,
        from_ts=from_ts,
        to_ts=to_ts,
        events=[
            EventIndexEntry(
                ts=ts.timestamp(),
                duration_s=duration_s,
                labeled=event_id in labeled_ids,
            )
            for event_id, ts, duration_s in rows
        ],
    )


@router.get("/events/{event_id}", response_model=EventResponse)
async def get_event(
    event_id: UUID,
    _user: ResolvedUser = Depends(require_user),
    session: AsyncSession = Depends(get_session),
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
) -> EventResponse:
    row = await session.get(Event, event_id)
    if row is None:
        raise HTTPException(status_code=404, detail="event not found")

    await _verify_uploaded(row, storage, session)

    playback = None
    if row.status == EventStatus.AVAILABLE.value and row.storage_key:
        signed = storage.presign_get(
            row.storage_key, ttl_seconds=settings.EVENT_PLAYBACK_URL_TTL_SECONDS
        )
        playback = (signed.url, signed.expires_at)
    labels = await _latest_labels(session, [row.event_id])
    return _to_response(row, playback=playback, label=labels.get(row.event_id))


class PlaybackUrlResponse(BaseModel):
    event_id: UUID
    url: str
    expires_at: float


@router.get("/events/{event_id}/playback-url", response_model=PlaybackUrlResponse)
async def get_event_playback_url(
    event_id: UUID,
    _user: ResolvedUser = Depends(require_user),
    session: AsyncSession = Depends(get_session),
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
) -> PlaybackUrlResponse:
    row = await session.get(Event, event_id)
    if row is None:
        raise HTTPException(status_code=404, detail="event not found")
    await _verify_uploaded(row, storage, session)
    if row.status != EventStatus.AVAILABLE.value or not row.storage_key:
        raise HTTPException(status_code=409, detail=f"event is not available (status={row.status})")
    signed = storage.presign_get(
        row.storage_key, ttl_seconds=settings.EVENT_PLAYBACK_URL_TTL_SECONDS
    )
    return PlaybackUrlResponse(event_id=event_id, url=signed.url, expires_at=signed.expires_at)


@router.delete("/events/{event_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_event(
    event_id: UUID,
    _user: ResolvedUser = Depends(require_user),
    session: AsyncSession = Depends(get_session),
    storage: Storage = Depends(get_storage),
) -> Response:
    """Delete an event row and its uploaded FLAC.

    Storage delete runs before the DB delete so a failure there leaves the
    row intact and the operation is retryable. Labels cascade off the FK.
    """
    row = await session.get(Event, event_id)
    if row is None:
        raise HTTPException(status_code=404, detail="event not found")
    if row.storage_key:
        await storage.delete_object(row.storage_key)
    await session.delete(row)
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
