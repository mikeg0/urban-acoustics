"""/api/v1/preview/* — procedurally-generated mock data for guest users.

All routes require ``dashboard.preview`` (guest-only). The live WebSocket
streams a 90-second loop of ticks and spectrogram frames; the dashboard
rollups (summary/daily, anomalies, forecast, sources) use a fixed seed so
the heatmap is stable across reloads.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Annotated

from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect, status

from ...auth.cookies import COOKIE_NAME
from ...auth.jwt_tokens import decode_access_token
from ...auth.permissions import has_permission
from ...auth.user import AuthenticatedUser, require_permission
from ...preview import (
    PREVIEW_DEVICE_ID,
    THRESHOLD_DB,
    preview_anomalies,
    preview_forecast,
    preview_sources,
    preview_spect,
    preview_summary_daily,
    preview_tick,
)

router = APIRouter()
log = logging.getLogger("urban-acoustics.preview")

TICK_INTERVAL_S = 1.0  # one tick + one spect per second
PREVIEW_PERM = "dashboard.preview"


@router.get("/preview/device")
async def preview_device(
    _user: Annotated[AuthenticatedUser, Depends(require_permission(PREVIEW_PERM))],
) -> dict:
    """Single fake device exposed so the frontend's device selector has
    something to render in guest mode."""
    return {
        "device_id": PREVIEW_DEVICE_ID,
        "name": "Riverton Demo",
        "location": "demo",
        "lat": None,
        "lon": None,
        "created_at": time.time(),
        "last_seen": time.time(),
    }


@router.get("/preview/summary/daily")
async def preview_summary_daily_route(
    _user: Annotated[AuthenticatedUser, Depends(require_permission(PREVIEW_PERM))],
) -> dict:
    return preview_summary_daily()


@router.get("/preview/anomalies")
async def preview_anomalies_route(
    _user: Annotated[AuthenticatedUser, Depends(require_permission(PREVIEW_PERM))],
) -> dict:
    return preview_anomalies()


@router.get("/preview/forecast")
async def preview_forecast_route(
    _user: Annotated[AuthenticatedUser, Depends(require_permission(PREVIEW_PERM))],
) -> dict:
    return preview_forecast()


@router.get("/preview/sources")
async def preview_sources_route(
    _user: Annotated[AuthenticatedUser, Depends(require_permission(PREVIEW_PERM))],
) -> dict:
    return preview_sources()


@router.get("/preview/threshold")
async def preview_threshold_route(
    _user: Annotated[AuthenticatedUser, Depends(require_permission(PREVIEW_PERM))],
) -> dict:
    return {"threshold_db": THRESHOLD_DB}


# --- WebSocket: live preview stream -----------------------------------------


def _ws_user_from_cookie(websocket: WebSocket) -> AuthenticatedUser | None:
    """Decode the access-token cookie from the WS handshake.

    Returns None if the cookie is missing/invalid. We trust the JWT here
    instead of hitting the DB on every connect — for the preview WS this
    is fine because revocation in mid-stream isn't a concern (the next
    HTTP request will fail and the client will redirect to login).
    """
    token = websocket.cookies.get(COOKIE_NAME)
    if not token:
        return None
    payload = decode_access_token(token)
    if payload is None:
        return None
    return AuthenticatedUser(user_id=payload.user_id, email="", role=payload.role)


@router.websocket("/preview/live")
async def preview_live_ws(websocket: WebSocket) -> None:
    user = _ws_user_from_cookie(websocket)
    if user is None or not has_permission(user.role, PREVIEW_PERM):
        # 4401: app-level "unauthorized" close code.
        await websocket.close(code=4401)
        return

    await websocket.accept()
    try:
        next_tick = time.monotonic()
        while True:
            now = time.time()
            await websocket.send_json(preview_tick(now))
            await websocket.send_json(preview_spect(now))
            next_tick += TICK_INTERVAL_S
            sleep_for = max(0.0, next_tick - time.monotonic())
            await asyncio.sleep(sleep_for)
    except WebSocketDisconnect:
        return
    except Exception:  # noqa: BLE001
        log.exception("preview ws: stream loop error")
        try:
            await websocket.close(code=status.WS_1011_INTERNAL_ERROR)
        except Exception:  # noqa: BLE001
            pass
