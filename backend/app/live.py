"""Live noise stream — simulated minute-resolution dB readings over WebSocket.

The server maintains a single shared "today" stream. Each connection receives a
snapshot followed by tick messages. Time advances 1 minute every ``TICK_SECONDS``
seconds (4s by default, matching the prototype's accelerated demo cadence).
"""

from __future__ import annotations

import asyncio
import math
from datetime import date
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from .data import mulberry32

TICK_SECONDS = 4.0
MINUTES_PER_DAY = 24 * 60
LIVE_DATE_KEY = date.today().isoformat()

GAPS = [
    {"start": 6 * 60 + 12, "end": 6 * 60 + 38, "reason": "Sensor restart"},
    {"start": 14 * 60 + 5, "end": 14 * 60 + 11, "reason": "Network blip"},
]


def _build_today_minutes(seed: int = 0x42C1A417) -> list[float | None]:
    rng = mulberry32(seed)
    minutes: list[float | None] = [None] * MINUTES_PER_DAY
    for i in range(MINUTES_PER_DAY):
        h = i / 60.0
        base = (
            48
            + 18 * math.exp(-((h - 8) / 2.4) ** 2)
            + 12 * math.exp(-((h - 12) / 3.0) ** 2)
            + 22 * math.exp(-((h - 18) / 1.8) ** 2)
            + 14 * math.exp(-((h - 22) / 1.5) ** 2)
        )
        wobble = (rng() - 0.5) * 4
        transient = 8 + rng() * 14 if rng() > 0.985 else 0
        minutes[i] = round(base + wobble + transient, 1)
    for g in GAPS:
        for i in range(g["start"], g["end"]):
            minutes[i] = None
    return minutes


class LiveState:
    """Module-level singleton. One process = one stream (fine for a prototype)."""

    def __init__(self) -> None:
        self.minutes = _build_today_minutes()
        self.now_min = 15 * 60 + 47   # demo starts at 15:47
        self.gaps = GAPS
        self.date_key = LIVE_DATE_KEY
        self._lock = asyncio.Lock()

    async def advance(self) -> None:
        async with self._lock:
            if self.now_min < MINUTES_PER_DAY - 1:
                self.now_min += 1


STATE = LiveState()


def _snapshot() -> dict[str, Any]:
    return {
        "type": "snapshot",
        "date": STATE.date_key,
        "now_min": STATE.now_min,
        "minutes": STATE.minutes[: STATE.now_min + 1],
        "gaps": STATE.gaps,
        "tick_seconds": TICK_SECONDS,
    }


def _tick_payload() -> dict[str, Any]:
    return {
        "type": "tick",
        "now_min": STATE.now_min,
        "db": STATE.minutes[STATE.now_min],
    }


async def live_ws_handler(ws: WebSocket) -> None:
    await ws.accept()
    await ws.send_json(_snapshot())
    try:
        while True:
            await asyncio.sleep(TICK_SECONDS)
            await STATE.advance()
            await ws.send_json(_tick_payload())
    except WebSocketDisconnect:
        return
    except Exception:
        # Don't kill uvicorn on send failure — just hang up.
        try:
            await ws.close()
        except Exception:
            pass
