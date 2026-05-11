"""Generator + on-disk loader for synthetic city-noise data.

Deterministic seeded RNG (mulberry32, ported from the original JS prototype) so
the same seed produces the same year of fake dB readings every run. The seed
script writes one JSON file per day under ``data/days/`` plus a few aggregate
files; the FastAPI app reads them at startup.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, asdict
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Iterable

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DAYS_DIR = DATA_DIR / "days"

# ---- Deterministic PRNG ----------------------------------------------------

def mulberry32(seed: int):
    """Port of the JS mulberry32 PRNG. Returns a callable yielding floats in [0, 1)."""
    state = [seed & 0xFFFFFFFF]

    def rng() -> float:
        state[0] = (state[0] + 0x6D2B79F5) & 0xFFFFFFFF
        t = state[0]
        t = ((t ^ (t >> 15)) * (t | 1)) & 0xFFFFFFFF
        t = (t ^ ((t + (((t ^ (t >> 7)) * (t | 61)) & 0xFFFFFFFF)) & 0xFFFFFFFF)) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296.0

    return rng


def rand_between(rng, a: float, b: float) -> float:
    return a + rng() * (b - a)


# ---- Static config ---------------------------------------------------------

CITY = {
    "name": "Riverton",
    "district": "Midtown / Canal District",
    "sensor": "SNS-0412",
    "sensorPos": "Canal & 7th",
    "year": 2025,
}

WEEKDAY_BASE = [48, 46, 44, 43, 44, 48, 58, 68, 72, 71, 69, 70,
                71, 70, 69, 70, 73, 76, 74, 70, 66, 62, 58, 53]
WEEKEND_BASE = [58, 56, 54, 50, 47, 46, 48, 54, 60, 64, 66, 68,
                70, 71, 71, 71, 72, 74, 76, 77, 76, 74, 70, 65]
SEASONAL = [-3, -3, -1, 1, 3, 5, 6, 5, 3, 1, -1, -2]

EVENTS = {
    "2025-01-01": {"tag": "New Year",                  "bump": 14, "hours": [0, 1, 2]},
    "2025-03-17": {"tag": "Parade",                    "bump": 10, "hours": [11, 12, 13, 14]},
    "2025-04-12": {"tag": "Construction start · 7th Ave", "bump": 9, "hours": list(range(7, 17))},
    "2025-06-21": {"tag": "Music festival",            "bump": 18, "hours": [18, 19, 20, 21, 22, 23]},
    "2025-07-04": {"tag": "Fireworks",                 "bump": 22, "hours": [21, 22, 23]},
    "2025-09-14": {"tag": "Marathon",                  "bump":  8, "hours": [7, 8, 9, 10, 11]},
    "2025-10-31": {"tag": "Halloween nightlife",       "bump": 12, "hours": [20, 21, 22, 23]},
    "2025-12-31": {"tag": "NYE countdown",             "bump": 16, "hours": [22, 23]},
}

SOURCES = [
    {"name": "Motorcycles / modified muffler", "pct": 26, "color": "oklch(78% 0.18 35)"},
    {"name": "Cars / modified muffler",        "pct": 32, "color": "oklch(70% 0.12 230)"},
    {"name": "Construction / transient",       "pct": 18, "color": "oklch(75% 0.14 60)"},
    {"name": "Sirens / transient",             "pct": 12, "color": "oklch(78% 0.16 310)"},
    {"name": "Weather / ambient",              "pct": 12, "color": "oklch(60% 0.04 180)"},
]


# ---- Year builder ----------------------------------------------------------

def build_year(year: int = 2025, seed: int = 20260419) -> list[dict]:
    """Generate a full year of synthetic hourly dB readings, one entry per day."""
    rng = mulberry32(seed)
    cursor = date(year, 1, 1)
    end = date(year + 1, 1, 1)
    days: list[dict] = []

    while cursor < end:
        # Python weekday(): 0=Mon..6=Sun. JS getDay(): 0=Sun..6=Sat. Convert.
        js_dow = (cursor.weekday() + 1) % 7
        is_weekend = js_dow == 0 or js_dow == 6
        base = WEEKEND_BASE if is_weekend else WEEKDAY_BASE
        seasonal = SEASONAL[cursor.month - 1]
        key = cursor.isoformat()
        event = EVENTS.get(key)

        r = rng()
        if r < 0.1:
            day_bump = rand_between(rng, 6, 12)
        elif r < 0.2:
            day_bump = rand_between(rng, -8, -5)
        else:
            day_bump = rand_between(rng, -3, 3)
        if js_dow == 5 or js_dow == 6:
            day_bump += rand_between(rng, 0, 2.5)

        hours: list[float] = []
        for h in range(24):
            db = base[h] + seasonal + day_bump + rand_between(rng, -2.5, 2.5)
            if event and h in event["hours"]:
                db += event["bump"] + rand_between(rng, -1, 2)
            if rng() < 0.008:
                db += rand_between(rng, 8, 18)
            db = max(34, min(108, db))
            hours.append(round(db, 1))

        peak = max(hours)
        peak_hour = hours.index(peak)
        mean = round(sum(hours) / 24, 1)
        breaches = sum(1 for v in hours if v >= 85)

        days.append({
            "key": key,
            "date": key,
            "dow": js_dow,
            "isWeekend": is_weekend,
            "hours": hours,
            "peak": round(peak, 1),
            "peakHour": peak_hour,
            "mean": mean,
            "breaches": breaches,
            "event": event["tag"] if event else None,
        })
        cursor += timedelta(days=1)

    return days


# ---- Aggregates ------------------------------------------------------------

MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
               "July", "August", "September", "October", "November", "December"]
MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
               "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def compute_months(year: list[dict]) -> list[dict]:
    months = []
    for m in range(12):
        mdays = [d for d in year if int(d["key"][5:7]) - 1 == m]
        mean = round(sum(d["mean"] for d in mdays) / len(mdays), 1)
        peak = max(d["peak"] for d in mdays)
        breaches = sum(d["breaches"] for d in mdays)
        months.append({
            "index": m,
            "name": MONTH_NAMES[m],
            "short": MONTH_SHORT[m],
            "days": [d["key"] for d in mdays],   # reference by key, not full payload
            "mean": mean,
            "peak": peak,
            "breaches": breaches,
        })
    return months


def detect_anomalies(year: list[dict]) -> list[dict]:
    """Z-score per (dow, hour-of-day) bucket; collapse to one row per day at peak z."""
    buckets: dict[str, list[float]] = {}
    for d in year:
        for h, db in enumerate(d["hours"]):
            buckets.setdefault(f"{d['dow']}-{h}", []).append(db)
    stats = {}
    for k, arr in buckets.items():
        m = sum(arr) / len(arr)
        v = sum((x - m) ** 2 for x in arr) / len(arr)
        stats[k] = (m, math.sqrt(v))

    rows: list[dict] = []
    for d in year:
        for h, db in enumerate(d["hours"]):
            mean, sd = stats[f"{d['dow']}-{h}"]
            z = (db - mean) / (sd or 1)
            if z > 2.3:
                rows.append({
                    "key": d["key"],
                    "date": d["key"],
                    "hour": h,
                    "db": db,
                    "z": round(z, 2),
                    "event": d["event"],
                })

    # collapse same-day to peak-z row
    by_day: dict[str, dict] = {}
    for a in rows:
        if a["key"] not in by_day or a["z"] > by_day[a["key"]]["z"]:
            by_day[a["key"]] = a
    return sorted(by_day.values(), key=lambda x: -x["z"])


def compute_forecast(year: list[dict], from_key: str = "2025-12-31", days: int = 7) -> list[dict]:
    """Naive next-7-days forecast: weekly seasonality + small CI band."""
    rng = mulberry32(0xF00D)
    start = date.fromisoformat(from_key)
    out: list[dict] = []
    for i in range(1, days + 1):
        d = start + timedelta(days=i)
        js_dow = (d.weekday() + 1) % 7
        same_dow = [x for x in year if x["dow"] == js_dow]
        mean = sum(x["mean"] for x in same_dow) / len(same_dow)
        peak = sum(x["peak"] for x in same_dow) / len(same_dow)
        ci = 3 + rng() * 2
        out.append({
            "date": d.isoformat(),
            "dow": js_dow,
            "mean": round(mean, 1),
            "peak": round(peak, 1),
            "low": round(mean - ci, 1),
            "high": round(mean + ci, 1),
            "peakHour": 19 if js_dow in (0, 6) else 17,
        })
    return out


def compute_peak_hours(year: list[dict]) -> list[float]:
    sums = [0.0] * 24
    counts = [0] * 24
    for d in year:
        for h, db in enumerate(d["hours"]):
            sums[h] += db
            counts[h] += 1
    return [round(sums[h] / max(counts[h], 1), 2) for h in range(24)]


# ---- Disk I/O --------------------------------------------------------------

def write_year_to_disk(year: list[dict]) -> None:
    """Write one JSON file per day plus aggregates."""
    DAYS_DIR.mkdir(parents=True, exist_ok=True)
    for d in year:
        with (DAYS_DIR / f"{d['key']}.json").open("w") as f:
            json.dump(d, f, separators=(",", ":"))

    with (DATA_DIR / "city.json").open("w") as f:
        json.dump(CITY, f, indent=2)
    with (DATA_DIR / "months.json").open("w") as f:
        json.dump(compute_months(year), f, indent=2)
    with (DATA_DIR / "anomalies.json").open("w") as f:
        json.dump(detect_anomalies(year), f, indent=2)
    with (DATA_DIR / "forecast.json").open("w") as f:
        json.dump(compute_forecast(year), f, indent=2)
    with (DATA_DIR / "peak_hours.json").open("w") as f:
        json.dump(compute_peak_hours(year), f, indent=2)
    with (DATA_DIR / "sources.json").open("w") as f:
        json.dump(SOURCES, f, indent=2)


def load_all_days() -> list[dict]:
    files = sorted(DAYS_DIR.glob("*.json"))
    out: list[dict] = []
    for f in files:
        with f.open() as fh:
            out.append(json.load(fh))
    return out


def load_day(key: str) -> dict | None:
    f = DAYS_DIR / f"{key}.json"
    if not f.exists():
        return None
    with f.open() as fh:
        return json.load(fh)


def load_json(name: str):
    f = DATA_DIR / name
    with f.open() as fh:
        return json.load(fh)


def is_seeded() -> bool:
    return (DATA_DIR / "months.json").exists() and any(DAYS_DIR.glob("*.json"))
