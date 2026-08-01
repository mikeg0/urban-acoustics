from __future__ import annotations

import argparse
import json
from types import SimpleNamespace
from uuid import UUID

import pytest

from urban_acoustics.queue_store import QueueStore
from urban_acoustics import reset_history


DEVICE_ID = UUID("00000000-0000-4000-8000-00000000000a")


@pytest.mark.asyncio
async def test_queue_store_clear_history_removes_both_queues(tmp_path) -> None:
    store = QueueStore(tmp_path / "queue.db", max_bytes=1024 * 1024)
    store.open()
    try:
        store.conn.execute(
            "INSERT INTO mqtt_queue "
            "(topic, payload, qos, priority, created_at, next_attempt_at) "
            "VALUES ('dev/a/tlm', '{}', 0, 0, 1, 1)"
        )
        store.conn.execute(
            "INSERT INTO event_uploads "
            "(event_id, ts, duration_s, peak_db, sha256, size, flac_path, "
            "status, created_at, updated_at) "
            "VALUES ('event-a', 1, 2, 80, 'sha', 99, '/tmp/a.flac', "
            "'pending', 1, 1)"
        )

        removed = await store.clear_history()

        assert removed == (1, 1)
        assert await store.stats() == (0, 0)
        assert store.conn.execute("SELECT COUNT(*) FROM mqtt_queue").fetchone()[0] == 0
        assert store.conn.execute("SELECT COUNT(*) FROM event_uploads").fetchone()[0] == 0
    finally:
        store.close()


@pytest.mark.asyncio
async def test_device_execute_preserves_non_history_files(
    tmp_path, monkeypatch, capsys
) -> None:
    data_dir = tmp_path / "data"
    audio_dir = data_dir / "audio"
    audio_dir.mkdir(parents=True)
    flac = audio_dir / "old.flac"
    flac.write_bytes(b"audio")
    overlay = data_dir / "config-overrides.json"
    overlay.write_text('{"paused":true}')
    config = SimpleNamespace(
        device_id=DEVICE_ID,
        data_dir=data_dir,
        audio_dir=audio_dir,
        queue_db_path=data_dir / "queue.db",
        queue_max_bytes=1024 * 1024,
    )
    monkeypatch.setattr(reset_history, "load_config", lambda _path: config)

    result = await reset_history._run(
        argparse.Namespace(config=None, execute=True, dry_run=False, json=True)
    )

    assert result == 0
    assert not flac.exists()
    assert overlay.read_text() == '{"paused":true}'
    payload = json.loads(capsys.readouterr().out)
    assert payload["device_id"] == str(DEVICE_ID)
    assert all(row["items"] == 0 for row in payload["surfaces"])


@pytest.mark.asyncio
async def test_device_dry_run_does_not_create_queue_database(
    tmp_path, monkeypatch, capsys
) -> None:
    data_dir = tmp_path / "data"
    audio_dir = data_dir / "audio"
    audio_dir.mkdir(parents=True)
    config = SimpleNamespace(
        device_id=DEVICE_ID,
        data_dir=data_dir,
        audio_dir=audio_dir,
        queue_db_path=data_dir / "queue.db",
        queue_max_bytes=1024 * 1024,
    )
    monkeypatch.setattr(reset_history, "load_config", lambda _path: config)

    await reset_history._run(
        argparse.Namespace(config=None, execute=False, dry_run=True, json=True)
    )

    assert not config.queue_db_path.exists()
    payload = json.loads(capsys.readouterr().out)
    assert all(row["items"] == 0 for row in payload["surfaces"])
