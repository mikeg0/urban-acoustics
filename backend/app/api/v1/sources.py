"""/api/v1/devices/{id}/sources — classification breakdown for the dashboard.

Counts ML-assigned (and human-relabelled, eventually) classifications on
``events`` over a window, returns them with their share-of-total. Colour
assignment lives on the frontend.
"""

from __future__ import annotations

from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from ...auth.user import require_permission
from ...contracts import SourceCount, SourcesResponse
from ...db import get_session
from ...models import Device

router = APIRouter(dependencies=[Depends(require_permission("dashboard.view"))])

_MAX_WINDOW_SECONDS = 366 * 24 * 3600


_SOURCES_SQL = text(
    """
    SELECT classification, COUNT(*) AS n
    FROM events
    WHERE device_id = :device_id
      AND ts >= :from_dt
      AND ts <  :to_dt
      AND classification IS NOT NULL
    GROUP BY classification
    ORDER BY n DESC, classification ASC
    """
)


@router.get(
    "/devices/{device_id}/sources",
    response_model=SourcesResponse,
)
async def get_device_sources(
    device_id: UUID,
    from_: float = Query(..., alias="from", description="Unix seconds, inclusive"),
    to: float = Query(..., description="Unix seconds, exclusive"),
    session: AsyncSession = Depends(get_session),
) -> SourcesResponse:
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
    rows = list(
        await session.execute(
            _SOURCES_SQL,
            {"device_id": device_id, "from_dt": from_dt, "to_dt": to_dt},
        )
    )

    total = sum(int(r.n) for r in rows)
    sources: list[SourceCount] = []
    if total > 0:
        for r in rows:
            n = int(r.n)
            sources.append(
                SourceCount(
                    name=r.classification,
                    pct=100.0 * n / total,
                    count=n,
                )
            )

    return SourcesResponse(
        device_id=device_id,
        from_ts=from_,
        to_ts=to,
        total=total,
        sources=sources,
    )
