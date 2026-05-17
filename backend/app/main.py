"""FastAPI app — Phase 1 device REST API plus optional demo data.

Routers under ``/api/v1`` are the production surface. ``/api/health`` is kept
for back-compat with anything that probes the legacy path. When
``DEMO_MODE=1`` the synthetic-data routes from the prototype dashboard are
mounted under ``/api/v1/demo`` *and* aliased at their legacy ``/api/...``
paths so the existing Vite frontend keeps working without code changes.
"""

from __future__ import annotations

import logging

from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware

from . import data as data_lib
from . import seed as seed_mod
from .api.v1 import demo as demo_router
from .api.v1 import devices as devices_router
from .api.v1 import events as events_router
from .api.v1 import health as health_router
from .api.v1 import labels as labels_router
from .api.v1 import live as live_router
from .api.v1 import telemetry as telemetry_router
from .live import live_ws_handler
from .settings import get_settings
from .storage import get_storage

settings = get_settings()
logging.basicConfig(level=settings.LOG_LEVEL)
log = logging.getLogger("urban-acoustics")

app = FastAPI(title="Urban Acoustics API", version="1.0.0")

# CORS: explicit origin list only. ``ALLOWED_ORIGINS`` validation rejects '*'
# in settings.py so a misconfigured prod deployment fails fast at startup.
if settings.allowed_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )


@app.on_event("startup")
async def _on_startup() -> None:
    # The bucket also gets created by minio-init, but the backend owns its
    # own ensure-bucket so a fresh dev box without the init container still
    # works.
    try:
        await get_storage().ensure_bucket()
    except Exception:  # noqa: BLE001 — health endpoint will surface the issue
        log.exception("ensure_bucket failed at startup")

    if settings.DEMO_MODE and not data_lib.is_seeded():
        log.info("DEMO_MODE=1: seeding synthetic dashboard data")
        seed_mod.main()


# --- v1 routers --------------------------------------------------------------

V1 = "/api/v1"
app.include_router(health_router.router, prefix=V1, tags=["health"])
app.include_router(devices_router.router, prefix=V1, tags=["devices"])
app.include_router(telemetry_router.router, prefix=V1, tags=["telemetry"])
app.include_router(events_router.router, prefix=V1, tags=["events"])
app.include_router(labels_router.router, prefix=V1, tags=["labels"])
app.include_router(live_router.router, prefix=V1, tags=["live"])

# --- legacy /api/health (kept per acceptance criteria) ----------------------


@app.get("/api/health")
def legacy_health() -> dict:
    return {"ok": True, "seeded": data_lib.is_seeded()}


# --- demo (only when DEMO_MODE=1) -------------------------------------------

if settings.DEMO_MODE:
    app.include_router(demo_router.router, prefix=f"{V1}/demo", tags=["demo"])
    # Legacy aliases so frontend/src/api.ts ('/api/year', '/api/day/...') works.
    app.include_router(demo_router.router, prefix="/api", tags=["demo-legacy"])

    @app.websocket("/ws/live")
    async def ws_live(ws: WebSocket) -> None:
        await live_ws_handler(ws)
