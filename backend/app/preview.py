"""Procedural mock data for the guest preview.

Pure functions of ``t`` — no I/O, no random module state. The live stream
loops on a 90-second window: ``preview_tick(t)`` and
``preview_tick(t + 90)`` return identical values, so a sharp-eyed user
watching the spectrogram will see the same pattern repeat.

Dashboard rollups (year, day, anomalies, forecast, sources) use a fixed
seed so the year heatmap is stable across page reloads.
"""

from __future__ import annotations

import hashlib
import math
import random
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

LIVE_LOOP_SECONDS = 90.0
SPECT_BANDS = 64
THRESHOLD_DB = 80.0
PREVIEW_DEVICE_ID = "00000000-0000-0000-0000-000000000000"
HISTORY_DAYS = 365


# --- live stream -------------------------------------------------------------


def preview_tick(t: float) -> dict[str, float | str]:
    """One LAeq/LAFmax sample. Wraps on a 90-second loop."""
    tau = t % LIVE_LOOP_SECONDS
    # Slow swell over the full window + faster wobble.
    laeq = (
        56.0
        + 14.0 * math.sin(2 * math.pi * tau / LIVE_LOOP_SECONDS)
        + 4.5 * math.sin(2 * math.pi * tau / 9.0)
        + 2.0 * math.sin(2 * math.pi * tau / 2.5)
    )
    # LAFmax sits above LAeq with short transient bumps that look like
    # individual vehicle passes.
    bump = 3.0 * max(0.0, math.sin(2 * math.pi * tau / 6.0)) ** 4
    lafmax = laeq + 4.5 + bump
    # Synthetic "C peak" — a hair above LAFmax.
    lcpeak = lafmax + 6.0
    return {
        "type": "tick",
        "ts": t,
        "laeq": round(laeq, 2),
        "lafmax": round(lafmax, 2),
        "lcpeak": round(lcpeak, 2),
    }


def preview_spect(t: float) -> dict:
    """64-band magnitude vector. Wraps on a 90-second loop."""
    tau = t % LIVE_LOOP_SECONDS
    overall = 56.0 + 14.0 * math.sin(2 * math.pi * tau / LIVE_LOOP_SECONDS)

    # Vehicle-pass bursts: deterministic events at fixed offsets within the
    # 90-second loop. Each burst rises and falls over ~3 seconds, mostly
    # affecting low-mid bands.
    burst_centers = (8.0, 27.0, 41.0, 58.0, 74.0)
    burst_amp = 0.0
    for c in burst_centers:
        d = (tau - c) / 1.5
        burst_amp += 14.0 * math.exp(-d * d)

    bands: list[float] = []
    for i in range(SPECT_BANDS):
        # Each band is a function of (i, tau). Low bands carry the rumble;
        # mid bands pulse on a 9-s cycle; high bands stay quiet except
        # during bursts.
        x = i / (SPECT_BANDS - 1)  # 0..1 across bands
        rumble = (1.0 - x) * 8.0
        mid = 6.0 * math.exp(-((x - 0.45) ** 2) / 0.04) * (
            0.6 + 0.4 * math.sin(2 * math.pi * tau / 9.0)
        )
        high_burst = burst_amp * math.exp(-((x - 0.55) ** 2) / 0.12)
        v = overall + rumble + mid + high_burst - 14.0
        bands.append(round(v, 2))

    return {"type": "spect", "ts": t, "bands": bands}


# --- dashboard rollups (stable across reloads) -------------------------------


def _seeded(salt: str, seed: int = 0xA0C0571C5) -> random.Random:
    h = hashlib.sha256(f"{salt}:{seed}".encode()).digest()
    return random.Random(int.from_bytes(h[:8], "big"))


@dataclass
class _DayStats:
    date: str
    dow: int
    mean: float
    peak: float
    breaches: int
    peak_hour: int
    hours: list[float | None]
    top_event: str | None


_EVENT_LABELS = (
    "motorcycle",
    "car",
    "truck",
    "siren",
    "construction",
    "horn",
    "music",
    "shouting",
    "barking",
    "other",
)


def _generate_day(d: datetime, rng: random.Random) -> _DayStats:
    # Per-day deterministic stats: anchored to date so reloading the page
    # returns the same numbers.
    day_rng = _seeded(d.strftime("%Y-%m-%d"))
    base = 56.0 + 4.0 * math.sin(2 * math.pi * d.timetuple().tm_yday / 365.0)
    weekend = d.weekday() >= 5
    weekend_bias = -2.0 if weekend else 0.0

    hours: list[float | None] = []
    for h in range(24):
        # Diurnal pattern — quiet at night, peaks in afternoon rush.
        diurnal = -10.0 * math.cos(2 * math.pi * (h - 4) / 24.0)
        if h < 5:
            diurnal -= 3.0
        noise = day_rng.gauss(0, 1.5)
        v = base + diurnal + weekend_bias + noise
        # 4% chance an hour has no data (gives the heatmap some sparsity).
        if day_rng.random() < 0.04:
            hours.append(None)
        else:
            hours.append(round(v, 2))

    real_hours = [h for h in hours if h is not None]
    mean = sum(real_hours) / len(real_hours) if real_hours else 0.0
    peak = max(real_hours) if real_hours else 0.0
    peak_hour = max(range(24), key=lambda i: hours[i] if hours[i] is not None else -1e9)
    # Breaches: count hours above threshold, then add a few bursts.
    breaches = sum(1 for h in real_hours if h >= THRESHOLD_DB - 12.0)
    # Top event: weighted toward the most common urban sources.
    top_event = day_rng.choices(_EVENT_LABELS, weights=[3, 8, 5, 1, 2, 2, 1, 1, 1, 2])[0]

    return _DayStats(
        date=d.strftime("%Y-%m-%d"),
        dow=d.weekday(),
        mean=round(mean, 2),
        peak=round(peak, 2),
        breaches=breaches,
        peak_hour=peak_hour,
        hours=hours,
        top_event=top_event,
    )


def _date_range(end: datetime, days: int) -> list[datetime]:
    return [end - timedelta(days=i) for i in range(days - 1, -1, -1)]


def _now_utc_midnight() -> datetime:
    now = datetime.now(timezone.utc)
    return datetime(now.year, now.month, now.day, tzinfo=timezone.utc)


def preview_summary_daily() -> dict:
    end = _now_utc_midnight()
    days_dt = _date_range(end, HISTORY_DAYS)
    rng = _seeded("summary")
    days = [_generate_day(d, rng) for d in days_dt]
    return {
        "device_id": PREVIEW_DEVICE_ID,
        "from_ts": days_dt[0].timestamp(),
        "to_ts": (end + timedelta(days=1)).timestamp(),
        "threshold": THRESHOLD_DB,
        "days": [
            {
                "date": d.date,
                "dow": d.dow,
                "mean": d.mean,
                "peak": d.peak,
                "breaches": d.breaches,
                "peak_hour": d.peak_hour,
                "hours": d.hours,
                "event": d.top_event,
            }
            for d in days
        ],
    }


def preview_anomalies() -> dict:
    """Recent flagged events — top peaks from the synthetic day generator."""
    end = _now_utc_midnight()
    rng = _seeded("anomalies")
    points = []
    for offset in range(0, 30):
        d = end - timedelta(days=offset)
        stats = _generate_day(d, rng)
        if stats.peak < 70.0:
            continue
        ts = d.replace(hour=stats.peak_hour, minute=rng.randint(0, 59)).timestamp()
        eid = hashlib.sha256(f"anom:{d.isoformat()}".encode()).hexdigest()
        # Preview events are synthetic, but keep their wire semantics aligned
        # with real-device anomalies: peak versus an event-peak baseline, not
        # an hourly LAeq mean.  The arithmetic is deliberately exposed so the
        # UI always displays the measured delta rather than deriving one from z.
        baseline_mean = max(55.0, stats.peak - rng.uniform(7.0, 15.0))
        delta_db = stats.peak - baseline_mean
        baseline_std = rng.uniform(2.5, 4.5)
        zscore = delta_db / baseline_std
        confidence = rng.uniform(0.82, 0.99) if stats.top_event else None
        points.append(
            {
                "event_id": f"{eid[:8]}-{eid[8:12]}-{eid[12:16]}-{eid[16:20]}-{eid[20:32]}",
                "ts": ts,
                "day_key": stats.date,
                "hour": stats.peak_hour,
                "peak_db": stats.peak,
                "baseline_mean_db": round(baseline_mean, 1),
                "delta_db": round(delta_db, 1),
                "baseline_n": rng.randint(8, 36),
                "z": round(zscore, 2),
                "rank_score": round(zscore * (confidence or 1.0), 2),
                "classification": stats.top_event,
                "confidence": round(confidence, 2) if confidence is not None else None,
            }
        )
    points.sort(
        key=lambda point: (point["rank_score"], point["z"], point["ts"]),
        reverse=True,
    )
    return {
        "device_id": PREVIEW_DEVICE_ID,
        "from_ts": (end - timedelta(days=30)).timestamp(),
        "to_ts": (end + timedelta(days=1)).timestamp(),
        "points": points,
    }


def preview_forecast() -> dict:
    end = _now_utc_midnight()
    rng = _seeded("forecast")
    points = []
    for offset in range(1, 8):
        d = end + timedelta(days=offset)
        stats = _generate_day(d, rng)
        spread = 3.0 + rng.random() * 1.5
        points.append(
            {
                "date": stats.date,
                "dow": stats.dow,
                "mean": stats.mean,
                "peak": stats.peak,
                "low": round(stats.mean - spread, 2),
                "high": round(stats.mean + spread, 2),
                "peak_hour": stats.peak_hour,
            }
        )
    return {
        "device_id": PREVIEW_DEVICE_ID,
        "generated_at": datetime.now(timezone.utc).timestamp(),
        "threshold": THRESHOLD_DB,
        "points": points,
    }


def preview_sources() -> dict:
    end = _now_utc_midnight()
    rng = _seeded("sources")
    weights = [rng.randint(20, 120) for _ in _EVENT_LABELS]
    total = sum(weights)
    sources = [
        {"name": name, "count": w, "pct": round(100.0 * w / total, 2)}
        for name, w in sorted(zip(_EVENT_LABELS, weights), key=lambda p: -p[1])
    ]
    return {
        "device_id": PREVIEW_DEVICE_ID,
        "from_ts": (end - timedelta(days=30)).timestamp(),
        "to_ts": (end + timedelta(days=1)).timestamp(),
        "total": total,
        "sources": sources,
    }
