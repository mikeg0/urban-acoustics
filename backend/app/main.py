"""FastAPI app — historical noise REST endpoints + live WebSocket."""

from __future__ import annotations

from fastapi import FastAPI, HTTPException, WebSocket
from fastapi.middleware.cors import CORSMiddleware

from . import data as data_lib
from . import seed as seed_mod
from .live import live_ws_handler

app = FastAPI(title="Urban Acoustics API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # dev-only — Vite proxies in prod
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def ensure_seeded() -> None:
    if not data_lib.is_seeded():
        seed_mod.main()


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "seeded": data_lib.is_seeded()}


@app.get("/api/city")
def get_city() -> dict:
    return data_lib.CITY


@app.get("/api/year")
def get_year() -> dict:
    """Bulk year payload — all the historical context the dashboard needs at boot."""
    days = data_lib.load_all_days()
    return {
        "city": data_lib.CITY,
        "days": days,
        "months": data_lib.load_json("months.json"),
        "anomalies": data_lib.load_json("anomalies.json"),
        "forecast": data_lib.load_json("forecast.json"),
        "peakHours": data_lib.load_json("peak_hours.json"),
        "sources": data_lib.load_json("sources.json"),
    }


@app.get("/api/day/{key}")
def get_day(key: str) -> dict:
    d = data_lib.load_day(key)
    if d is None:
        raise HTTPException(status_code=404, detail=f"No data for {key}")
    return d


@app.websocket("/ws/live")
async def ws_live(ws: WebSocket) -> None:
    await live_ws_handler(ws)
