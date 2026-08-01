"""Report or reset historical server data while preserving configuration.

This is the server-side implementation used by ``scripts/reset_history.py``.
Run it in the backend container so it uses the same database and object-store
settings as the application.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import pathlib
import sys
from dataclasses import asdict, dataclass
from datetime import datetime
from uuid import UUID

from sqlalchemy import text

# Keep direct execution (``python scripts/reset_history.py``) useful as well
# as the normal ``python -m scripts.reset_history`` invocation.
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.db import get_engine  # noqa: E402
from app.storage import Storage, get_storage  # noqa: E402


CAGGS: tuple[tuple[str, str], ...] = (
    ("telemetry_1m", "1 minute"),
    ("telemetry_1h", "1 hour"),
    ("telemetry_1d", "1 day"),
)
S3_PREFIXES = ("events/", "spectrograms/")


@dataclass(frozen=True)
class SurfaceCount:
    name: str
    items: int
    bytes: int | None = None


def _device_predicate(column: str, selected: tuple[UUID, ...]) -> str:
    if not selected:
        return ""
    return f" WHERE {column} = ANY(CAST(:device_ids AS uuid[]))"


def _candidate_predicate(selected: tuple[UUID, ...]) -> str:
    if not selected:
        return ""
    return (
        " WHERE outside_device_id = ANY(CAST(:device_ids AS uuid[]))"
        " OR inside_device_id = ANY(CAST(:device_ids AS uuid[]))"
    )


def _params(selected: tuple[UUID, ...]) -> dict[str, object]:
    return {"device_ids": list(selected)} if selected else {}


async def list_devices() -> list[dict[str, object]]:
    engine = get_engine()
    async with engine.connect() as conn:
        rows = (
            await conn.execute(
                text(
                    "SELECT device_id, name, location, last_seen "
                    "FROM devices ORDER BY name NULLS LAST, device_id"
                )
            )
        ).mappings()
        return [
            {
                "device_id": str(row["device_id"]),
                "name": row["name"],
                "location": row["location"],
                "last_seen": (
                    row["last_seen"].isoformat()
                    if isinstance(row["last_seen"], datetime)
                    else None
                ),
            }
            for row in rows
        ]


async def _validate_devices(selected: tuple[UUID, ...]) -> None:
    if not selected:
        return
    engine = get_engine()
    async with engine.connect() as conn:
        registered = set(
            (
                await conn.execute(
                    text(
                        "SELECT device_id FROM devices "
                        "WHERE device_id = ANY(CAST(:device_ids AS uuid[]))"
                    ),
                    _params(selected),
                )
            ).scalars()
        )
    missing = set(selected) - registered
    if missing:
        values = ", ".join(str(value) for value in sorted(missing, key=str))
        raise ValueError(f"unknown device ID(s): {values}")


async def _postgres_report(selected: tuple[UUID, ...]) -> list[SurfaceCount]:
    params = _params(selected)
    device = _device_predicate("device_id", selected)
    candidate = _candidate_predicate(selected)
    event = _device_predicate("device_id", selected)
    label = (
        " WHERE event_id IN (SELECT event_id FROM events"
        + _device_predicate("device_id", selected)
        + ")"
        if selected
        else ""
    )
    candidate_frames = (
        " WHERE device_id = ANY(CAST(:device_ids AS uuid[]))"
        " OR candidate_id IN (SELECT candidate_id FROM correlated_event_candidates"
        + candidate
        + ")"
        if selected
        else ""
    )
    watermark = (
        " WHERE last_processed_at IS NOT NULL AND "
        "(outside_device_id = ANY(CAST(:device_ids AS uuid[])) OR "
        "inside_device_id = ANY(CAST(:device_ids AS uuid[])))"
        if selected
        else " WHERE last_processed_at IS NOT NULL"
    )

    queries = (
        ("postgres.telemetry_db", "SELECT COUNT(*) FROM telemetry_db" + device),
        *(
            (f"postgres.{name}", f"SELECT COUNT(*) FROM {name}" + device)
            for name, _bucket in CAGGS
        ),
        ("postgres.device_health", "SELECT COUNT(*) FROM device_health" + device),
        (
            "postgres.spectrogram_frames",
            "SELECT COUNT(*) FROM spectrogram_frames" + device,
        ),
        (
            "postgres.spectrogram_annotations",
            "SELECT COUNT(*) FROM spectrogram_annotations" + device,
        ),
        ("postgres.events", "SELECT COUNT(*) FROM events" + event),
        ("postgres.labels", "SELECT COUNT(*) FROM labels" + label),
        (
            "postgres.correlated_event_candidates",
            "SELECT COUNT(*) FROM correlated_event_candidates" + candidate,
        ),
        (
            "postgres.correlated_event_frames",
            "SELECT COUNT(*) FROM correlated_event_frames" + candidate_frames,
        ),
        (
            "postgres.devices.last_seen",
            "SELECT COUNT(*) FROM devices WHERE last_seen IS NOT NULL"
            + (
                " AND device_id = ANY(CAST(:device_ids AS uuid[]))"
                if selected
                else ""
            ),
        ),
        (
            "postgres.detector_watermark",
            "SELECT COUNT(*) FROM correlated_event_settings" + watermark,
        ),
    )

    counts: list[SurfaceCount] = []
    engine = get_engine()
    async with engine.connect() as conn:
        for name, sql in queries:
            count = (await conn.execute(text(sql), params)).scalar_one()
            counts.append(SurfaceCount(name=name, items=int(count)))
    return counts


def _belongs_to_device(key: str, selected: frozenset[str]) -> bool:
    return not selected or any(part in selected for part in key.split("/"))


async def _s3_objects(
    storage: Storage, selected: tuple[UUID, ...]
) -> tuple[list[SurfaceCount], list[str]]:
    selected_text = frozenset(str(value) for value in selected)
    counts: list[SurfaceCount] = []
    keys: list[str] = []
    for prefix in S3_PREFIXES:
        objects = [
            obj
            for obj in await storage.list_objects(prefix)
            if _belongs_to_device(str(obj["Key"]), selected_text)
        ]
        keys.extend(str(obj["Key"]) for obj in objects)
        counts.append(
            SurfaceCount(
                name=f"s3.{prefix.rstrip('/')}",
                items=len(objects),
                bytes=sum(int(obj.get("Size", 0)) for obj in objects),
            )
        )
    return counts, keys


async def report_server(
    selected: tuple[UUID, ...], storage: Storage | None = None
) -> list[SurfaceCount]:
    await _validate_devices(selected)
    storage = storage or get_storage()
    postgres = await _postgres_report(selected)
    objects, _keys = await _s3_objects(storage, selected)
    return postgres + objects


async def _cagg_windows(
    selected: tuple[UUID, ...],
) -> dict[str, tuple[datetime, datetime]]:
    params = _params(selected)
    scope = _device_predicate("device_id", selected)
    windows: dict[str, tuple[datetime, datetime]] = {}
    engine = get_engine()
    async with engine.connect() as conn:
        for name, bucket in CAGGS:
            row = (
                await conn.execute(
                    text(
                        f"SELECT MIN(bucket), MAX(bucket) + INTERVAL '{bucket}' "
                        f"FROM {name}{scope}"
                    ),
                    params,
                )
            ).one()
            if row[0] is not None and row[1] is not None:
                windows[name] = (row[0], row[1])
    return windows


async def _delete_postgres(selected: tuple[UUID, ...]) -> None:
    params = _params(selected)
    engine = get_engine()
    windows = await _cagg_windows(selected)

    async with engine.begin() as conn:
        if not selected:
            await conn.execute(
                text(
                    "TRUNCATE TABLE telemetry_db, device_health, "
                    "spectrogram_frames, spectrogram_annotations, labels, "
                    "correlated_event_frames, correlated_event_candidates, events "
                    "RESTART IDENTITY"
                )
            )
            await conn.execute(text("UPDATE devices SET last_seen = NULL"))
            await conn.execute(
                text("UPDATE correlated_event_settings SET last_processed_at = NULL")
            )
        else:
            candidate = _candidate_predicate(selected)
            await conn.execute(
                text(
                    "DELETE FROM correlated_event_frames "
                    "WHERE device_id = ANY(CAST(:device_ids AS uuid[]))"
                ),
                params,
            )
            await conn.execute(
                text("DELETE FROM correlated_event_candidates" + candidate), params
            )
            for table in (
                "events",
                "spectrogram_annotations",
                "spectrogram_frames",
                "device_health",
                "telemetry_db",
            ):
                await conn.execute(
                    text("DELETE FROM " + table + _device_predicate("device_id", selected)),
                    params,
                )
            await conn.execute(
                text(
                    "UPDATE devices SET last_seen = NULL "
                    "WHERE device_id = ANY(CAST(:device_ids AS uuid[]))"
                ),
                params,
            )
            await conn.execute(
                text(
                    "UPDATE correlated_event_settings SET last_processed_at = NULL "
                    "WHERE outside_device_id = ANY(CAST(:device_ids AS uuid[])) "
                    "OR inside_device_id = ANY(CAST(:device_ids AS uuid[]))"
                ),
                params,
            )

    # The bounded policies will never revisit old buckets. Refresh every
    # materialized bucket that existed before the delete, forcing Timescale to
    # remove deleted devices while rebuilding any unselected devices sharing
    # those buckets. Procedures must run outside a transaction.
    async with engine.connect() as conn:
        conn = await conn.execution_options(isolation_level="AUTOCOMMIT")
        for name, _bucket in CAGGS:
            window = windows.get(name)
            if window is None:
                continue
            await conn.execute(
                text(
                    f"CALL refresh_continuous_aggregate('{name}', "
                    "CAST(:window_start AS timestamptz), "
                    "CAST(:window_end AS timestamptz), force => TRUE)"
                ),
                {"window_start": window[0], "window_end": window[1]},
            )


async def reset_server(
    selected: tuple[UUID, ...], storage: Storage | None = None
) -> list[SurfaceCount]:
    await _validate_devices(selected)
    storage = storage or get_storage()
    _object_counts, keys = await _s3_objects(storage, selected)
    await _delete_postgres(selected)
    await storage.delete_objects(keys)
    return await report_server(selected, storage)


def _print_counts(counts: list[SurfaceCount]) -> None:
    if not counts:
        print("  (none)")
        return
    width = max(len(row.name) for row in counts)
    for row in counts:
        suffix = f", {row.bytes:,} bytes" if row.bytes is not None else ""
        print(f"  {row.name:<{width}}  {row.items:>12,} items{suffix}")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="reset server-side history")
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--dry-run", action="store_true", help="report only (default)")
    action.add_argument("--execute", action="store_true", help="delete selected history")
    action.add_argument(
        "--list-devices", action="store_true", help="list registered devices and exit"
    )
    parser.add_argument(
        "--device-id",
        action="append",
        type=UUID,
        default=[],
        help="limit the operation to this device; repeatable",
    )
    parser.add_argument("--json", action="store_true", help=argparse.SUPPRESS)
    return parser


async def _run(args: argparse.Namespace) -> int:
    if args.list_devices:
        devices = await list_devices()
        if args.json:
            print(json.dumps({"devices": devices}, sort_keys=True))
        else:
            if not devices:
                print("No registered devices.")
            for device in devices:
                print(
                    f"{device['device_id']}\t{device['name'] or '-'}\t"
                    f"{device['location'] or '-'}\t{device['last_seen'] or 'never'}"
                )
        return 0

    selected = tuple(dict.fromkeys(args.device_id))
    counts = (
        await reset_server(selected) if args.execute else await report_server(selected)
    )
    payload = {
        "mode": "execute" if args.execute else "dry-run",
        "scope": [str(value) for value in selected] or "all",
        "surfaces": [asdict(row) for row in counts],
    }
    if args.json:
        print(json.dumps(payload, sort_keys=True))
    else:
        print("Server history after reset:" if args.execute else "Server history selected:")
        _print_counts(counts)
    return 0


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        return asyncio.run(_run(args))
    except (OSError, RuntimeError, ValueError) as exc:
        print(f"reset_history: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
