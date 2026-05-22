"""/api/v1/devices/{device_id}/annotations — user-drawn spectrogram annotations.

Annotations are time-range + label rows the user paints onto the live
spectrogram for sub-threshold patterns that never trigger the audio
capture path. They're consumed downstream by the Pi-head training
pipeline; this module is responsible only for persisting them.
"""

from __future__ import annotations

from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ...auth.user import ResolvedUser, require_user
from ...contracts import AnnotationRequest, AnnotationResponse
from ...db import get_session
from ...models import Device, Event, SpectrogramAnnotation, SpectrogramFrame

router = APIRouter()


def _to_response(row: SpectrogramAnnotation) -> AnnotationResponse:
    return AnnotationResponse(
        id=row.id,
        device_id=row.device_id,
        ts_start=row.ts_start.timestamp(),
        ts_end=row.ts_end.timestamp(),
        label=row.label,  # type: ignore[arg-type]
        created_at=row.created_at.timestamp(),
    )


@router.post(
    "/devices/{device_id}/annotations",
    response_model=AnnotationResponse,
    status_code=status.HTTP_200_OK,
)
async def create_annotation(
    device_id: UUID,
    body: AnnotationRequest,
    _user: ResolvedUser = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> AnnotationResponse:
    if await session.get(Device, device_id) is None:
        raise HTTPException(status_code=404, detail="device not found")

    ts_start = datetime.fromtimestamp(body.ts_start, tz=timezone.utc)
    ts_end = datetime.fromtimestamp(body.ts_end, tz=timezone.utc)

    # The range must overlap stored spectrogram data; labeling a window
    # where the Pi was offline isn't useful training material.
    has_frames = await session.execute(
        select(SpectrogramFrame.ts)
        .where(SpectrogramFrame.device_id == device_id)
        .where(SpectrogramFrame.ts >= ts_start)
        .where(SpectrogramFrame.ts < ts_end)
        .limit(1)
    )
    if has_frames.first() is None:
        raise HTTPException(
            status_code=400, detail="no spectrogram data in range"
        )

    # An audio-backed event in the same range already has its own label
    # mechanism via the Labels table — refuse to shadow it. Overlap test:
    # events.ts < ts_end AND events.ts + duration_s > ts_start. Postgres'
    # ``make_interval`` lets us express ``duration_s`` seconds as a real
    # interval inline instead of pulling rows back to compare in Python.
    overlap = await session.execute(
        select(Event.event_id)
        .where(Event.device_id == device_id)
        .where(Event.ts < ts_end)
        .where(
            Event.ts + func.make_interval(0, 0, 0, 0, 0, 0, Event.duration_s)
            > ts_start
        )
        .limit(1)
    )
    conflict = overlap.first()
    if conflict is not None:
        raise HTTPException(
            status_code=409,
            detail={
                "message": "range overlaps an existing event",
                "event_id": str(conflict[0]),
            },
        )

    now = datetime.now(timezone.utc)
    row = SpectrogramAnnotation(
        device_id=device_id,
        ts_start=ts_start,
        ts_end=ts_end,
        label=body.label,
        created_at=now,
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return _to_response(row)


@router.get(
    "/devices/{device_id}/annotations",
    response_model=list[AnnotationResponse],
)
async def list_annotations(
    device_id: UUID,
    from_ts: float | None = Query(default=None, alias="from"),
    to_ts: float | None = Query(default=None, alias="to"),
    limit: int = Query(default=500, ge=1, le=5000),
    _user: ResolvedUser = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> list[AnnotationResponse]:
    stmt = (
        select(SpectrogramAnnotation)
        .where(SpectrogramAnnotation.device_id == device_id)
        .order_by(SpectrogramAnnotation.ts_start.desc())
        .limit(limit)
    )
    # Overlap test: a row whose [ts_start, ts_end) intersects [from_ts, to_ts).
    if from_ts is not None:
        stmt = stmt.where(
            SpectrogramAnnotation.ts_end
            > datetime.fromtimestamp(from_ts, tz=timezone.utc)
        )
    if to_ts is not None:
        stmt = stmt.where(
            SpectrogramAnnotation.ts_start
            < datetime.fromtimestamp(to_ts, tz=timezone.utc)
        )
    result = await session.execute(stmt)
    return [_to_response(r) for r in result.scalars()]


@router.delete(
    "/annotations/{annotation_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def delete_annotation(
    annotation_id: int,
    _user: ResolvedUser = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> Response:
    row = await session.get(SpectrogramAnnotation, annotation_id)
    if row is None:
        raise HTTPException(status_code=404, detail="annotation not found")
    await session.delete(row)
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
