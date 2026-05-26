"""FastAPI app — Phase 1 device REST API plus optional demo data.

Routers under ``/api/v1`` are the production surface. ``/api/health`` is kept
for back-compat with anything that probes the legacy path. When
``DEMO_MODE=1`` the synthetic-data routes from the prototype dashboard are
mounted under ``/api/v1/demo`` *and* aliased at their legacy ``/api/...``
paths so the existing Vite frontend keeps working without code changes.
"""

from __future__ import annotations

import asyncio
import logging

from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware

from . import data as data_lib
from . import seed as seed_mod
from .api.v1 import annotations as annotations_router
from .api.v1 import anomalies as anomalies_router
from .api.v1 import cameras as cameras_router
from .api.v1 import demo as demo_router
from .api.v1 import device_health as device_health_router
from .api.v1 import device_led as device_led_router
from .api.v1 import device_runtime_config as device_runtime_config_router
from .api.v1 import devices as devices_router
from .api.v1 import events as events_router
from .api.v1 import forecast as forecast_router
from .api.v1 import health as health_router
from .api.v1 import labels as labels_router
from .api.v1 import live as live_router
from .api.v1 import sources as sources_router
from .api.v1 import spectrogram as spectrogram_router
from .api.v1 import summary as summary_router
from .api.v1 import telemetry as telemetry_router
from .db import get_sessionmaker
from .ingest.mqtt_publish import (
    get_command_publisher,
    init_command_publisher,
    shutdown_command_publisher,
)
from .live import live_ws_handler
from .models import Device
from .settings import get_settings
from .storage import get_storage
from sqlalchemy import select

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

    # Stand up the outbound command publisher. Optional — when the API
    # process has no MQTT_BROKER_URL the publisher stays None and the
    # runtime-config PUT endpoint 503s. The connection is async-by-design
    # so a broker that comes up later still works without a restart.
    init_command_publisher(settings)
    await _replay_retained_commands()


@app.on_event("shutdown")
async def _on_shutdown() -> None:
    shutdown_command_publisher()


async def _replay_retained_commands() -> None:
    """Re-publish each device's current runtime_config as a retained command.

    The broker normally stores the most recent retained command per topic,
    so devices reconnect into the right state without any backend
    involvement. This pass exists to recover from broker-data loss (volume
    wipe, fresh dev stack) — same payload + same topic is idempotent on
    the wire, so it's safe to run on every API startup.
    """
    publisher = get_command_publisher()
    if publisher is None:
        return

    # Wait briefly for the publisher's first connect before we start firing.
    # Don't block startup forever — the publisher will keep reconnecting and
    # admin PUTs will work once it's up. Replay is best-effort.
    for _ in range(20):
        if publisher.connected:
            break
        await asyncio.sleep(0.25)
    if not publisher.connected:
        log.info("startup: publisher not yet connected; skipping retained replay")
        return

    factory = get_sessionmaker()
    async with factory() as session:
        rows = await session.execute(
            select(Device.device_id, Device.runtime_config).where(
                Device.runtime_config != {},
            )
        )
        candidates = list(rows.all())

    replayed = 0
    for device_id, cfg in candidates:
        if not cfg:
            continue
        try:
            await asyncio.to_thread(
                publisher.publish_command,
                device_id=device_id,
                cmd="config",
                args=cfg,
            )
            replayed += 1
        except RuntimeError:
            log.exception("startup: failed to replay retained config for %s", device_id)
    if replayed:
        log.info("startup: replayed retained config for %d device(s)", replayed)


# --- v1 routers --------------------------------------------------------------

V1 = "/api/v1"
app.include_router(health_router.router, prefix=V1, tags=["health"])
app.include_router(devices_router.router, prefix=V1, tags=["devices"])
app.include_router(telemetry_router.router, prefix=V1, tags=["telemetry"])
app.include_router(device_health_router.router, prefix=V1, tags=["device-health"])
app.include_router(spectrogram_router.router, prefix=V1, tags=["spectrogram"])
app.include_router(events_router.router, prefix=V1, tags=["events"])
app.include_router(labels_router.router, prefix=V1, tags=["labels"])
app.include_router(annotations_router.router, prefix=V1, tags=["annotations"])
app.include_router(live_router.router, prefix=V1, tags=["live"])
app.include_router(summary_router.router, prefix=V1, tags=["summary"])
app.include_router(anomalies_router.router, prefix=V1, tags=["anomalies"])
app.include_router(forecast_router.router, prefix=V1, tags=["forecast"])
app.include_router(sources_router.router, prefix=V1, tags=["sources"])
app.include_router(
    device_runtime_config_router.router, prefix=V1, tags=["runtime-config"]
)
app.include_router(device_led_router.router, prefix=V1, tags=["led"])
app.include_router(cameras_router.router, prefix=V1, tags=["cameras"])

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
