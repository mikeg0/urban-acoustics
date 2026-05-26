"""UDOT cameras roster import.

We do **not** persist all of UDOT's statewide camera roster (thousands of
units). Instead we keep only the ones co-located with an active mic
device (within ~100 m — same intersection). The library here is called
from ``scripts/refresh_cameras.py``; the request path never touches it.

UDOT docs: https://prod-ut.ibi511.com/help/endpoint/cameras
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timezone

import httpx
from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Camera, Device


# Downtown SLC bounding box, matched to the corridor the dashboard map clamps
# to (see frontend/src/stations.tsx). Used as a cheap pre-filter before the
# O(cameras * devices) haversine — UDOT serves the whole state, and we only
# ever care about a few square kilometers.
CORRIDOR_BBOX = {
    "lat_min": 40.74,
    "lat_max": 40.785,
    "lon_min": -111.93,
    "lon_max": -111.85,
}

DEFAULT_RADIUS_M = 100  # intersection-scale — a typical urban intersection is 30-60 m across
UDOT_ENDPOINT = "https://www.udottraffic.utah.gov/api/v2/get/cameras"


@dataclass(frozen=True)
class UdotCamera:
    """Subset of UDOT's response we care about, one row per camera."""

    camera_id: int
    source: str | None
    roadway: str | None
    direction: str | None
    location: str | None
    lat: float
    lon: float
    view_id: int | None
    view_description: str | None


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6_371_000.0
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _pick_view(views: list[dict] | None) -> tuple[int | None, str | None]:
    if not views:
        return None, None
    # Prefer the first view that isn't explicitly disabled. UDOT's `Status`
    # is a free-form string in practice ("Enabled" / "Disabled" / "Unknown");
    # we treat anything other than "Disabled" as usable so a stale status
    # field doesn't cost us a perfectly-working snapshot URL.
    for v in views:
        status = (v.get("Status") or "").strip().lower()
        if status == "disabled":
            continue
        vid = v.get("Id")
        if isinstance(vid, int):
            return vid, v.get("Description")
    return None, None


def _parse_camera(raw: dict) -> UdotCamera | None:
    cid = raw.get("Id")
    lat = raw.get("Latitude")
    lon = raw.get("Longitude")
    if not isinstance(cid, int) or not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
        return None
    view_id, view_desc = _pick_view(raw.get("Views"))
    return UdotCamera(
        camera_id=cid,
        source=raw.get("Source"),
        roadway=raw.get("Roadway"),
        direction=raw.get("Direction"),
        location=raw.get("Location"),
        lat=float(lat),
        lon=float(lon),
        view_id=view_id,
        view_description=view_desc,
    )


def _in_bbox(cam: UdotCamera) -> bool:
    return (
        CORRIDOR_BBOX["lat_min"] <= cam.lat <= CORRIDOR_BBOX["lat_max"]
        and CORRIDOR_BBOX["lon_min"] <= cam.lon <= CORRIDOR_BBOX["lon_max"]
    )


async def fetch_roster(api_key: str, *, client: httpx.AsyncClient | None = None) -> list[UdotCamera]:
    """Pull the full UDOT roster, parse, and prune to the downtown bbox."""

    owns_client = client is None
    if owns_client:
        client = httpx.AsyncClient(timeout=30.0)
    try:
        resp = await client.get(UDOT_ENDPOINT, params={"key": api_key, "format": "json"})
        resp.raise_for_status()
        payload = resp.json()
    finally:
        if owns_client:
            await client.aclose()

    parsed: list[UdotCamera] = []
    for raw in payload or []:
        cam = _parse_camera(raw)
        if cam is None:
            continue
        if not _in_bbox(cam):
            continue
        parsed.append(cam)
    return parsed


def filter_to_device_intersections(
    cameras: list[UdotCamera],
    devices: list[tuple[float, float]],
    radius_m: int = DEFAULT_RADIUS_M,
) -> list[UdotCamera]:
    """Keep cameras within ``radius_m`` of at least one (lat, lon) device.

    Pure function — no DB, no network — so it's trivial to unit-test.
    """

    if not devices:
        return []
    keep: list[UdotCamera] = []
    for cam in cameras:
        for dlat, dlon in devices:
            if _haversine_m(cam.lat, cam.lon, dlat, dlon) <= radius_m:
                keep.append(cam)
                break
    return keep


async def _placed_devices(session: AsyncSession) -> list[tuple[float, float]]:
    rows = await session.execute(
        select(Device.lat, Device.lon).where(Device.lat.is_not(None), Device.lon.is_not(None))
    )
    return [(lat, lon) for lat, lon in rows.all()]


async def refresh_cameras(
    session: AsyncSession,
    api_key: str,
    *,
    radius_m: int = DEFAULT_RADIUS_M,
) -> int:
    """Pull the UDOT roster, filter to mic intersections, replace table contents.

    Returns the number of cameras written. Rows for cameras that no
    longer match any device are deleted on the same commit so removing /
    moving a mic prunes its old camera.
    """

    devices = await _placed_devices(session)
    roster = await fetch_roster(api_key)
    matched = filter_to_device_intersections(roster, devices, radius_m=radius_m)

    now = datetime.now(timezone.utc)
    keep_ids = {c.camera_id for c in matched}

    # Delete orphans first so the row count returned matches what's in the table.
    if keep_ids:
        await session.execute(delete(Camera).where(Camera.camera_id.notin_(keep_ids)))
    else:
        await session.execute(delete(Camera))

    if matched:
        values = [
            {
                "camera_id": c.camera_id,
                "source": c.source,
                "roadway": c.roadway,
                "direction": c.direction,
                "location": c.location,
                "lat": c.lat,
                "lon": c.lon,
                "view_id": c.view_id,
                "view_description": c.view_description,
                "fetched_at": now,
            }
            for c in matched
        ]
        stmt = pg_insert(Camera).values(values)
        stmt = stmt.on_conflict_do_update(
            index_elements=[Camera.camera_id],
            set_={
                "source": stmt.excluded.source,
                "roadway": stmt.excluded.roadway,
                "direction": stmt.excluded.direction,
                "location": stmt.excluded.location,
                "lat": stmt.excluded.lat,
                "lon": stmt.excluded.lon,
                "view_id": stmt.excluded.view_id,
                "view_description": stmt.excluded.view_description,
                "fetched_at": stmt.excluded.fetched_at,
            },
        )
        await session.execute(stmt)
    await session.commit()
    return len(matched)
