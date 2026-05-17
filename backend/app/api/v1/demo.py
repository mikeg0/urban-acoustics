"""/api/v1/demo/* — synthetic dashboard data, gated behind DEMO_MODE.

Wraps the original ``data``/``seed`` modules from the pre-Phase-1 dashboard so
the Vite frontend keeps working in dev. These endpoints are wired only when
``DEMO_MODE=1`` (see main.py). The legacy ``/api/year``, ``/api/day``,
``/api/city`` paths are also re-exposed as aliases under the same gate so the
existing frontend code in ``frontend/src/api.ts`` doesn't need a rewrite yet.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from ... import data as data_lib

router = APIRouter()


@router.get("/city")
def get_city() -> dict:
    return data_lib.CITY


@router.get("/year")
def get_year() -> dict:
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


@router.get("/day/{key}")
def get_day(key: str) -> dict:
    d = data_lib.load_day(key)
    if d is None:
        raise HTTPException(status_code=404, detail=f"No data for {key}")
    return d
