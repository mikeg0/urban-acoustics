"""Idempotently seed the 40 Urban Quiet Initiative pilot-corridor stations.

The Urban Quiet Initiative coalition (urban-quiet-initiative.geo-tt.app)
proposes a 40-sensor pilot along State Street from North Temple to 900
South: 10 sensors on State Street itself plus 30 standard sensors on the
six parallel north-south streets through the corridor footprint.

Run from inside the backend container:

    python -m scripts.seed_pilot_corridor

Reruns are safe: UUIDs are derived from station_id via uuid5(NAMESPACE_DNS,
...) so each station maps to a stable device_id and existing rows are
left untouched (lat/lon refreshed in case the layout moves).
"""

from __future__ import annotations

import asyncio
import pathlib
import sys
from datetime import datetime, timezone
from uuid import NAMESPACE_DNS, UUID, uuid5

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from sqlalchemy import select  # noqa: E402

from app.db import get_sessionmaker  # noqa: E402
from app.models import Device  # noqa: E402

# Real intersection coordinates sourced from OpenStreetMap (Overpass API,
# 2026-05-26) — each station sits on the actual node where the two named
# streets cross, not a synthetic grid point. Where OSM has multiple nodes
# at an intersection (separate turn lanes / bike paths), the mean is used.
#
# (prefix, ns_street_label, [(cross_name, lat, lon), ...])
_CORRIDOR: list[tuple[str, str, list[tuple[str, float, float]]]] = [
    # State Street thoroughfare: 10 sensors at every cross from N Temple
    # through 900 South.
    ("ST", "State", [
        ("N Temple", 40.771538, -111.888264),
        ("100 S",    40.767176, -111.888238),
        ("200 S",    40.765028, -111.888230),
        ("300 S",    40.762822, -111.888245),
        ("400 S",    40.760645, -111.888244),
        ("500 S",    40.758475, -111.888247),
        ("600 S",    40.756300, -111.888232),
        ("700 S",    40.754128, -111.888233),
        ("800 S",    40.751948, -111.888239),
        ("900 S",    40.749812, -111.888232),
    ]),
    # Six parallel N-S streets, 5 standard sensors each at every other
    # cross-street (100 / 300 / 500 / 700 / 900 South).
    ("300W", "300 West", [
        ("100 S", 40.767185, -111.899689),
        ("300 S", 40.762820, -111.899693),
        ("500 S", 40.758480, -111.899685),
        ("700 S", 40.754122, -111.899684),
        ("900 S", 40.749763, -111.899685),
    ]),
    ("WT", "West Temple", [
        ("100 S", 40.767175, -111.893955),
        ("300 S", 40.762822, -111.893954),
        ("500 S", 40.758480, -111.893948),
        ("700 S", 40.754120, -111.893958),
        ("900 S", 40.749787, -111.894013),
    ]),
    ("MAIN", "Main", [
        ("100 S", 40.767172, -111.891107),
        ("300 S", 40.762816, -111.891097),
        ("500 S", 40.758483, -111.891088),
        ("700 S", 40.754130, -111.891090),
        ("900 S", 40.749813, -111.891083),
    ]),
    ("200E", "200 East", [
        ("100 S", 40.767170, -111.885373),
        ("300 S", 40.762815, -111.885370),
        ("500 S", 40.758464, -111.885368),
        ("700 S", 40.754130, -111.885386),
        ("900 S", 40.749812, -111.885375),
    ]),
    ("300E", "300 East", [
        ("100 S", 40.767174, -111.882512),
        ("300 S", 40.762828, -111.882509),
        ("500 S", 40.758483, -111.882531),
        ("700 S", 40.754131, -111.882503),
        ("900 S", 40.749798, -111.882508),
    ]),
    ("400E", "400 East", [
        ("100 S", 40.767169, -111.879647),
        ("300 S", 40.762835, -111.879637),
        ("500 S", 40.758487, -111.879646),
        ("700 S", 40.754138, -111.879640),
        ("900 S", 40.749801, -111.879636),
    ]),
]


# Lat band -> council-district stand-in label for the `location` field.
# Matches neighborhood names called out on the UQI site. Thresholds are
# midpoints between adjacent cross-street rows in real OSM lat space.
def _district_for(lat: float) -> str:
    if lat >= 40.7661:
        return "Downtown"
    if lat >= 40.7596:
        return "Central City"
    if lat >= 40.7530:
        return "Granary"
    return "Ballpark"


def _build_stations() -> list[dict]:
    stations: list[dict] = []
    for prefix, label, crosses in _CORRIDOR:
        for i, (cross, lat, lon) in enumerate(crosses, start=1):
            station_id = f"UQI-{prefix}-{i:02d}"
            stations.append(
                {
                    "station_id": station_id,
                    "name": f"{cross} & {label}",
                    "location": _district_for(lat),
                    "lat": lat,
                    "lon": lon,
                }
            )
    return stations


# Stations whose device_id is pinned to a pre-existing dev UUID rather than
# the uuid5-derived default. UQI-ST-03 was originally the "Downtown" dev
# sensor and carries ~10M historical rows + a pinned client cert; we keep
# its UUID so docker-compose, certs, sim, and tests stay intact.
_DEVICE_ID_OVERRIDES: dict[str, UUID] = {
    "UQI-ST-03": UUID("00000000-0000-4000-8000-00000000000a"),
}


def _device_id_for(station_id: str) -> UUID:
    if station_id in _DEVICE_ID_OVERRIDES:
        return _DEVICE_ID_OVERRIDES[station_id]
    return uuid5(NAMESPACE_DNS, f"urban-acoustics/{station_id}")


async def _seed() -> None:
    stations = _build_stations()
    assert len(stations) == 40, f"expected 40 stations, got {len(stations)}"

    now = datetime.now(timezone.utc)
    factory = get_sessionmaker()
    inserted = 0
    refreshed = 0
    async with factory() as session:
        # Drop any legacy row sitting at the uuid5-derived UUID for a station
        # that's been pinned to an override. Safe because override targets are
        # known to predate the seed; the uuid5-keyed row has no FK rows
        # attached (the override target carries the history).
        for station_id in _DEVICE_ID_OVERRIDES:
            legacy_id = uuid5(NAMESPACE_DNS, f"urban-acoustics/{station_id}")
            legacy = await session.get(Device, legacy_id)
            if legacy is not None:
                await session.delete(legacy)

        for s in stations:
            device_id = _device_id_for(s["station_id"])
            existing = await session.get(Device, device_id)
            if existing is None:
                session.add(
                    Device(
                        device_id=device_id,
                        name=f"{s['station_id']} · {s['name']}",
                        location=s["location"],
                        lat=s["lat"],
                        lon=s["lon"],
                        created_at=now,
                    )
                )
                inserted += 1
            else:
                existing.name = f"{s['station_id']} · {s['name']}"
                existing.location = s["location"]
                existing.lat = s["lat"]
                existing.lon = s["lon"]
                refreshed += 1
        await session.commit()

        result = await session.execute(select(Device))
        total = len(result.scalars().all())

    print(f"seeded pilot corridor: inserted={inserted} refreshed={refreshed} total_devices={total}")


def main() -> int:
    asyncio.run(_seed())
    return 0


if __name__ == "__main__":
    sys.exit(main())
