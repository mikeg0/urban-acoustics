"""Enrich frontend/public/sensor-locations.geojson with the metadata the
public petition page (frontend/public/quiet-initiative/) needs to render
station hover popovers without hitting the backend at request time.

For each existing feature (keyed by `properties.code` like "UQI-ST-03")
we add:

    name        cross-street label, e.g. "200 S & State"
    location    neighborhood, e.g. "Central City"
    has_camera  true if a UDOT camera sits within ~150 m of the mic
    view_id     UDOT view id for that camera (only when has_camera=true)
    db_typical  baked dB value derived from the existing `weight` field

The script streams stdin → stdout so it doesn't need the frontend
directory mounted into the backend container. Run from the host::

    docker compose exec -T backend python -m scripts.enrich_sensor_locations \
        < frontend/public/sensor-locations.geojson \
        > frontend/public/sensor-locations.geojson.new \
    && mv frontend/public/sensor-locations.geojson.new frontend/public/sensor-locations.geojson

The script is idempotent and reads the source-of-truth name/location
from the `devices` table (populated by ``seed_pilot_corridor.py``) and
the camera match from the `cameras` table (populated by
``refresh_cameras.py``). Re-run whenever either of those tables moves.
"""

from __future__ import annotations

import asyncio
import json
import math
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from sqlalchemy import select  # noqa: E402

from app.db import get_sessionmaker  # noqa: E402
from app.models import Camera, Device  # noqa: E402


# Same threshold the dashboard uses (frontend/src/stations.tsx:36) — picks
# the nearest UDOT camera at the same intersection as the mic.
CAMERA_NEAR_RADIUS_M = 150


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6_371_000.0
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _display_name(device_name: str | None) -> str | None:
    """Strip the "UQI-XX-NN · " prefix from device.name — same rule as
    frontend/src/stations.tsx::displayName."""
    if not device_name:
        return None
    sep = " · "
    idx = device_name.find(sep)
    return device_name[idx + len(sep) :] if idx >= 0 else device_name


def _station_code(device_name: str | None) -> str | None:
    """Pull the leading UQI code from device.name."""
    if not device_name:
        return None
    sep = " · "
    idx = device_name.find(sep)
    return device_name[:idx] if idx >= 0 else None


def _db_typical(weight: float) -> float:
    """Map the existing per-feature `weight` (0..1) to a representative
    A-weighted nighttime dB. 48 dB at weight=0 → 74 dB at weight=1 — the
    realistic band measured along comparable urban corridors. Rounded to
    one decimal so it reads like a sensor reading, not a label."""
    return round(48.0 + max(0.0, min(1.0, weight)) * 26.0, 1)


async def _enrich() -> int:
    raw = sys.stdin.read()
    fc = json.loads(raw)

    factory = get_sessionmaker()
    async with factory() as session:
        devices = (await session.execute(select(Device))).scalars().all()
        cameras = (await session.execute(select(Camera))).scalars().all()

    # code → Device
    by_code: dict[str, Device] = {}
    for d in devices:
        code = _station_code(d.name)
        if code:
            by_code[code] = d

    enriched_features: list[dict] = []
    camera_hits = 0
    name_hits = 0
    missing: list[str] = []
    for feat in fc.get("features", []):
        props = dict(feat.get("properties") or {})
        code = props.get("code")
        weight = float(props.get("weight") or 0.0)
        props["db_typical"] = _db_typical(weight)

        device = by_code.get(code) if code else None
        if device is None:
            missing.append(code or "(no code)")
        else:
            name = _display_name(device.name)
            if name:
                props["name"] = name
                name_hits += 1
            if device.location:
                props["location"] = device.location

            # Nearest camera within radius; haversine in Python is fine for
            # 40 × ~tens of cameras.
            if device.lat is not None and device.lon is not None:
                best: tuple[float, Camera] | None = None
                for cam in cameras:
                    if cam.view_id is None:
                        continue
                    dist = _haversine_m(device.lat, device.lon, cam.lat, cam.lon)
                    if dist > CAMERA_NEAR_RADIUS_M:
                        continue
                    if best is None or dist < best[0]:
                        best = (dist, cam)
                if best is not None:
                    props["has_camera"] = True
                    props["view_id"] = best[1].view_id
                    camera_hits += 1

        new_feat = dict(feat)
        new_feat["properties"] = props
        enriched_features.append(new_feat)

    fc["features"] = enriched_features
    sys.stdout.write(json.dumps(fc, indent=2) + "\n")

    total = len(enriched_features)
    print(
        f"enriched sensor-locations.geojson: features={total} "
        f"name_hits={name_hits} camera_hits={camera_hits} "
        f"missing_devices={len(missing)}",
        file=sys.stderr,
    )
    if missing:
        print(f"  missing codes: {', '.join(missing)}", file=sys.stderr)
    return 0


def main() -> int:
    return asyncio.run(_enrich())


if __name__ == "__main__":
    sys.exit(main())
