"""/api/v1/devices/{id}/live — push telemetry over WebSocket.

Each connection gets its own asyncpg connection that ``LISTEN``s on the
``urban_acoustics`` channel (the same one ``app.ingest.mqtt`` already
notifies on after each telemetry flush). When a notify lands referencing
this device, we ``SELECT`` rows with ``ts > last_sent`` and stream each
as a ``tick`` matching the frontend's ``DeviceLiveMessage`` shape.

LISTEN connections shouldn't share a pool (UNLISTEN-on-release is fragile
and the connection's notification queue is per-connection state), so we
bypass SQLAlchemy's pool here and open a dedicated ``asyncpg.connect`` per
client.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import datetime, timedelta, timezone
from uuid import UUID

import asyncpg
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, status

from ...db import get_sessionmaker
from ...models import Device

router = APIRouter()

log = logging.getLogger("urban-acoustics.live-ws")

NOTIFY_CHANNEL = "urban_acoustics"
HEARTBEAT_SECONDS = 30.0
CATCHUP_SECONDS = 5.0


def _asyncpg_dsn(database_url: str) -> str:
    """Strip SQLAlchemy's dialect prefix so ``asyncpg.connect`` accepts it."""
    if database_url.startswith("postgresql+asyncpg://"):
        return "postgresql://" + database_url[len("postgresql+asyncpg://"):]
    return database_url


async def _device_exists(device_id: UUID) -> bool:
    async with get_sessionmaker()() as session:
        return await session.get(Device, device_id) is not None


@router.websocket("/devices/{device_id}/live")
async def live_telemetry_ws(websocket: WebSocket, device_id: UUID) -> None:
    if not await _device_exists(device_id):
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    await websocket.accept()

    from ...settings import get_settings
    dsn = _asyncpg_dsn(get_settings().DATABASE_URL)

    try:
        conn = await asyncpg.connect(dsn)
    except Exception:
        log.exception("live ws: asyncpg connect failed device=%s", device_id)
        await websocket.close(code=status.WS_1011_INTERNAL_ERROR)
        return

    # Bridge asyncpg's callback (runs on the same event loop, but as a
    # separate task scheduled by the driver) into a queue our main loop
    # awaits.
    notify_queue: asyncio.Queue[None] = asyncio.Queue()
    device_id_str = str(device_id)

    def on_notify(_conn, _pid, _channel, payload: str) -> None:
        try:
            data = json.loads(payload)
        except (ValueError, TypeError):
            return
        if data.get("type") != "telemetry":
            return
        if device_id_str not in data.get("device_ids", []):
            return
        try:
            notify_queue.put_nowait(None)
        except asyncio.QueueFull:
            # We coalesce notifies (one queued entry triggers a SELECT that
            # picks up all new rows), so the queue can't really fill — but
            # if it ever does, dropping is the right move.
            pass

    try:
        # Register listener BEFORE the catch-up SELECT so we don't miss rows
        # committed between the SELECT and add_listener.
        await conn.add_listener(NOTIFY_CHANNEL, on_notify)

        last_ts = datetime.now(timezone.utc) - timedelta(seconds=CATCHUP_SECONDS)
        last_ts = await _push_new_rows(websocket, conn, device_id, last_ts)

        while True:
            try:
                await asyncio.wait_for(notify_queue.get(), timeout=HEARTBEAT_SECONDS)
            except asyncio.TimeoutError:
                await websocket.send_json({"type": "ping", "ts": time.time()})
                continue

            # Drain coalesced notifies — one SELECT picks them all up.
            while not notify_queue.empty():
                notify_queue.get_nowait()

            last_ts = await _push_new_rows(websocket, conn, device_id, last_ts)
    except WebSocketDisconnect:
        return
    except Exception:
        log.exception("live ws: stream loop error device=%s", device_id)
    finally:
        try:
            await conn.remove_listener(NOTIFY_CHANNEL, on_notify)
        except Exception:  # noqa: BLE001
            pass
        try:
            await conn.close()
        except Exception:  # noqa: BLE001
            pass
        try:
            await websocket.close()
        except Exception:  # noqa: BLE001
            pass


async def _push_new_rows(
    websocket: WebSocket,
    conn: asyncpg.Connection,
    device_id: UUID,
    last_ts: datetime,
) -> datetime:
    """Fetch rows newer than ``last_ts`` and push each as a tick. Returns the new high-water mark."""
    rows = await conn.fetch(
        """
        SELECT ts, laeq, lafmax, lcpeak
        FROM telemetry_db
        WHERE device_id = $1 AND ts > $2
        ORDER BY ts
        """,
        device_id,
        last_ts,
    )
    for r in rows:
        await websocket.send_json(
            {
                "type": "tick",
                "ts": r["ts"].timestamp(),
                "laeq": r["laeq"],
                "lafmax": r["lafmax"],
                "lcpeak": r["lcpeak"],
            }
        )
        last_ts = r["ts"]
    return last_ts
