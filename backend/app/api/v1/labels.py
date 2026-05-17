"""/api/v1/events/{id}/labels — record a Phase 1 taxonomy label."""

from __future__ import annotations

from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from ...auth.user import ResolvedUser, require_user
from ...contracts import LabelRequest, LabelResponse
from ...db import get_session
from ...models import Event, Label

router = APIRouter()


@router.post("/events/{event_id}/labels", response_model=LabelResponse)
async def add_label(
    event_id: UUID,
    body: LabelRequest,
    _user: ResolvedUser = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> LabelResponse:
    if await session.get(Event, event_id) is None:
        raise HTTPException(status_code=404, detail="event not found")

    now = datetime.now(timezone.utc)
    row = Label(event_id=event_id, label=body.label, created_at=now)
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return LabelResponse(event_id=event_id, label=body.label, created_at=row.created_at.timestamp())
