"""Device-side history report/reset used by the server orchestrator."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import pathlib
import sqlite3
import sys
from dataclasses import asdict, dataclass

from .config import load_config
from .queue_store import QueueStore


@dataclass(frozen=True)
class SurfaceCount:
    name: str
    items: int
    bytes: int


def _audio_files(audio_dir: pathlib.Path) -> list[pathlib.Path]:
    files: list[pathlib.Path] = []
    if not audio_dir.exists():
        return files
    for root, directories, names in os.walk(audio_dir, followlinks=False):
        root_path = pathlib.Path(root)
        directories[:] = [
            name for name in directories if not (root_path / name).is_symlink()
        ]
        for name in names:
            path = root_path / name
            if path.suffix.lower() == ".flac" and not path.is_symlink():
                files.append(path)
    return files


def _total_size(paths: list[pathlib.Path]) -> int:
    total = 0
    for path in paths:
        try:
            total += path.stat().st_size
        except FileNotFoundError:
            pass
    return total


def _table_count(
    conn: sqlite3.Connection, table: str, size_expression: str
) -> tuple[int, int]:
    exists = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)
    ).fetchone()
    if exists is None:
        return 0, 0
    row = conn.execute(
        f"SELECT COUNT(*), COALESCE(SUM({size_expression}), 0) FROM {table}"
    ).fetchone()
    return int(row[0]), int(row[1])


def _readonly_queue_counts(db_path: pathlib.Path) -> list[SurfaceCount]:
    if not db_path.exists():
        mqtt = uploads = (0, 0)
    else:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=10)
        try:
            mqtt = _table_count(conn, "mqtt_queue", "LENGTH(payload)")
            uploads = _table_count(conn, "event_uploads", "size")
        finally:
            conn.close()
    return [
        SurfaceCount("device.mqtt_queue", mqtt[0], mqtt[1]),
        SurfaceCount("device.event_uploads", uploads[0], uploads[1]),
    ]


async def _run(args: argparse.Namespace) -> int:
    cfg = load_config(args.config)
    audio = _audio_files(cfg.audio_dir)
    if not args.execute:
        counts = _readonly_queue_counts(cfg.queue_db_path)
        counts.append(
            SurfaceCount("device.audio_spool", len(audio), _total_size(audio))
        )
    else:
        # Do not create a root-owned queue database on a device that does not
        # have one yet. The supervisor will create it with its service user's
        # ownership when it starts again.
        if cfg.queue_db_path.exists():
            store = QueueStore(cfg.queue_db_path, max_bytes=cfg.queue_max_bytes)
            store.open()
            try:
                await store.clear_history()
            finally:
                store.close()
        for path in audio:
            try:
                path.unlink()
            except FileNotFoundError:
                pass
        counts = _readonly_queue_counts(cfg.queue_db_path)
        remaining_audio = _audio_files(cfg.audio_dir)
        counts.append(
            SurfaceCount(
                "device.audio_spool",
                len(remaining_audio),
                _total_size(remaining_audio),
            )
        )

    payload = {
        "device_id": str(cfg.device_id),
        "mode": "execute" if args.execute else "dry-run",
        "surfaces": [asdict(row) for row in counts],
    }
    if args.json:
        print(json.dumps(payload, sort_keys=True))
    else:
        print(f"Device {cfg.device_id} history:")
        for row in counts:
            print(f"  {row.name:<24} {row.items:>12,} items, {row.bytes:,} bytes")
    return 0


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="reset Pi queue and audio history")
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--dry-run", action="store_true", help="report only (default)")
    action.add_argument("--execute", action="store_true", help="delete device history")
    parser.add_argument("--config", type=pathlib.Path, default=None)
    parser.add_argument("--json", action="store_true", help=argparse.SUPPRESS)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        return asyncio.run(_run(args))
    except (OSError, RuntimeError) as exc:
        print(f"reset_history: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
