"""/api/v1/devices/{id}/live — push telemetry over WebSocket.

Each connection gets its own asyncpg connection that ``LISTEN``s on two
channels:

* ``urban_acoustics`` — telemetry batches. Driven by the ingest worker's
  per-flush ``pg_notify``; the handler then ``SELECT``s new rows from
  ``telemetry_db`` and emits one ``tick`` message per row.
* ``ua_spect`` — spectrogram band frames. The ingest worker pushes the
  full ``{device_id, ts, bands}`` JSON directly in the notify payload —
  no DB read is needed because spectrograms are not persisted.

The handler forwards both kinds to the same WebSocket. The frontend's
``DeviceLiveMessage`` discriminated union routes by ``type``.

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
from typing import Any
from uuid import UUID

import asyncpg
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, status

from ...auth.cookies import COOKIE_NAME
from ...auth.jwt_tokens import decode_access_token
from ...auth.permissions import has_permission
from ...contracts import NOTIFY_SPECTROGRAM_CHANNEL
from ...db import get_sessionmaker
from ...models import Device

router = APIRouter()

log = logging.getLogger("urban-acoustics.live-ws")

NOTIFY_CHANNEL = "urban_acoustics"
HEARTBEAT_SECONDS = 30.0
CATCHUP_SECONDS = 5.0
# Bound on the cross-thread queue between asyncpg notify callbacks and
# the WS sender. At ~10 Hz spect this is ~100 s of buffering — plenty of
# headroom if the WS briefly stalls, while still bounding memory.
NOTIFY_QUEUE_MAX = 1024
# Soft cap: when the queue grows past this, shed the oldest items as
# new spect frames arrive. The hard cap above only sheds at 100 s, by
# which point the frontend's scrolling canvas has been multi-second
# stale for a long time — and worse, the lag never recovers because
# producer and consumer run at the same rate once steady-state. The
# soft cap keeps the live canvas within a few seconds of real-time
# regardless of transient backpressure. ~2.7 s at 12 Hz.
SPECT_QUEUE_SOFTCAP = 32

# Sentinel object meaning "telemetry needs a SELECT". Using a dedicated
# object (rather than None) makes the queue's contents self-describing.
_TLM_WAKE = object()


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
    # Auth: require live.realtime via the same JWT cookie used for HTTP.
    # We trust the JWT signature for WS — long-lived connections don't need
    # a per-message DB hit, and revocation will surface on the next HTTP
    # request anyway.
    token = websocket.cookies.get(COOKIE_NAME)
    payload = decode_access_token(token) if token else None
    if payload is None or not has_permission(payload.role, "live.realtime"):
        # 4401 is the conventional app-level "unauthorized" close code.
        await websocket.close(code=4401)
        return

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

    # Bridge asyncpg's callbacks (which run on the event loop but as
    # separate tasks scheduled by the driver) into a queue our main loop
    # drains. Items are either ``_TLM_WAKE`` (telemetry needs a SELECT) or
    # a ``dict`` already in the WS wire shape.
    notify_queue: asyncio.Queue[Any] = asyncio.Queue(maxsize=NOTIFY_QUEUE_MAX)
    device_id_str = str(device_id)

    def on_notify_tlm(_conn, _pid, _channel, payload: str) -> None:
        try:
            data = json.loads(payload)
        except (ValueError, TypeError):
            return
        if data.get("type") != "telemetry":
            return
        if device_id_str not in data.get("device_ids", []):
            return
        try:
            notify_queue.put_nowait(_TLM_WAKE)
        except asyncio.QueueFull:
            # Coalescing means one wake-up batch-SELECTs everything new, so
            # the queue effectively can't fill from telemetry — but if it
            # ever does, dropping a wake-up is safe (next one will sweep).
            pass

    def on_notify_spect(_conn, _pid, _channel, payload: str) -> None:
        try:
            data = json.loads(payload)
        except (ValueError, TypeError):
            return
        if data.get("device_id") != device_id_str:
            return
        ts = data.get("ts")
        bands = data.get("bands")
        if not isinstance(ts, (int, float)) or not isinstance(bands, list):
            return
        # Drop the oldest queued items when the soft cap is exceeded so a
        # transient backpressure spike (slow WS send, asyncpg read pause)
        # can't build a multi-second backlog that the frontend never
        # recovers from — producer and consumer run at the same average
        # rate, so any backlog persists until the queue is forcibly
        # drained. _TLM_WAKE entries are safe to drop since the next
        # NOTIFY will regenerate one and ``_push_new_rows`` uses
        # ``last_ts`` to catch up.
        while notify_queue.qsize() >= SPECT_QUEUE_SOFTCAP:
            try:
                notify_queue.get_nowait()
            except asyncio.QueueEmpty:
                break
        # Mirror the frontend's DeviceLiveMessage shape.
        try:
            notify_queue.put_nowait({"type": "spect", "ts": ts, "bands": bands})
        except asyncio.QueueFull:
            # Should be unreachable given the soft cap above, but keep the
            # guard so a put never raises.
            pass

    try:
        # Register listeners BEFORE the catch-up SELECT so we don't miss
        # rows or band frames that land during startup.
        await conn.add_listener(NOTIFY_CHANNEL, on_notify_tlm)
        await conn.add_listener(NOTIFY_SPECTROGRAM_CHANNEL, on_notify_spect)

        last_ts = datetime.now(timezone.utc) - timedelta(seconds=CATCHUP_SECONDS)
        last_ts = await _push_new_rows(websocket, conn, device_id, last_ts)

        while True:
            try:
                item = await asyncio.wait_for(notify_queue.get(), timeout=HEARTBEAT_SECONDS)
            except asyncio.TimeoutError:
                await websocket.send_json({"type": "ping", "ts": time.time()})
                continue

            # Drain anything queued without blocking. Spect frames are
            # forwarded preserving order; one or more telemetry wake-ups
            # collapse into a single SELECT after the drain.
            pending: list[Any] = [item]
            while True:
                try:
                    pending.append(notify_queue.get_nowait())
                except asyncio.QueueEmpty:
                    break

            needs_select = False
            for p in pending:
                if p is _TLM_WAKE:
                    needs_select = True
                else:
                    await websocket.send_json(p)
            if needs_select:
                last_ts = await _push_new_rows(websocket, conn, device_id, last_ts)
    except WebSocketDisconnect:
        return
    except Exception:
        log.exception("live ws: stream loop error device=%s", device_id)
    finally:
        try:
            await conn.remove_listener(NOTIFY_CHANNEL, on_notify_tlm)
        except Exception:  # noqa: BLE001
            pass
        try:
            await conn.remove_listener(NOTIFY_SPECTROGRAM_CHANNEL, on_notify_spect)
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
