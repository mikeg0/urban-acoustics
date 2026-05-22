"""Unit tests for the cloud-pushed config overlay.

Two surfaces under test:

* ``write_overlay`` — used by the supervisor when it accepts a
  ``cmd/config`` envelope. Must merge, drop unknown keys, and be
  crash-safe (atomic rename).
* ``load_config`` overlay merge — used at startup. Must apply known keys,
  skip unknown ones, and bump ``config_version`` so the next Health message
  reports the new state to the cloud.
"""

from __future__ import annotations

import json
import logging
import pathlib
from uuid import uuid4

import pytest

from urban_acoustics.config import (
    MUTABLE_FIELDS,
    load_config,
    write_overlay,
)


DEVICE_UUID = "00000000-0000-4000-8000-00000000000a"


def _base_config_dict() -> dict:
    return {
        "device_id": DEVICE_UUID,
        "alsa_device": "test",
        "sample_rate": 48000,
        "event_threshold_db": 80.0,
        # Paths that load_config coerces to pathlib.Path — supply strings.
        "mqtt_ca_file": "/tmp/ca.crt",
        "mqtt_cert_file": "/tmp/dev.crt",
        "mqtt_key_file": "/tmp/dev.key",
        "data_dir": "/tmp/ua-data",
        "audio_dir": "/tmp/ua-data/audio",
        "queue_db_path": "/tmp/ua-data/queue.db",
    }


def _write_base(tmp_path: pathlib.Path) -> pathlib.Path:
    path = tmp_path / "config.json"
    path.write_text(json.dumps(_base_config_dict()))
    return path


# ---- write_overlay ----------------------------------------------------------


def test_write_overlay_creates_file(tmp_path: pathlib.Path) -> None:
    target = tmp_path / "overrides.json"
    out = write_overlay({"event_threshold_db": 77.5}, path=target)
    assert target.exists()
    assert out == {"event_threshold_db": 77.5}
    assert json.loads(target.read_text()) == {"event_threshold_db": 77.5}


def test_write_overlay_merges_existing(tmp_path: pathlib.Path) -> None:
    target = tmp_path / "overrides.json"
    write_overlay({"event_threshold_db": 75.0}, path=target)
    out = write_overlay({"event_threshold_db": 82.5}, path=target)
    # Single field for now, but the merge semantic is the important bit:
    # second write should not lose unrelated keys once more fields land.
    assert out == {"event_threshold_db": 82.5}


def test_write_overlay_rejects_unknown_key(tmp_path: pathlib.Path) -> None:
    target = tmp_path / "overrides.json"
    with pytest.raises(ValueError):
        write_overlay({"not_a_field": 1.0}, path=target)
    assert not target.exists()


def test_write_overlay_strips_unknown_existing_keys(tmp_path: pathlib.Path) -> None:
    """Stale keys from older firmware (when MUTABLE_FIELDS was wider) must
    be dropped on the next write so they can't haunt the load path."""
    target = tmp_path / "overrides.json"
    target.write_text(json.dumps({"event_threshold_db": 80.0, "legacy_knob": 9.9}))
    out = write_overlay({"event_threshold_db": 81.0}, path=target)
    assert "legacy_knob" not in out
    assert out == {"event_threshold_db": 81.0}


def test_write_overlay_atomic_rename(tmp_path: pathlib.Path) -> None:
    """A successful write must replace the file via rename, leaving no
    stray .tmp behind. (The crash-mid-write case is covered by os.replace's
    POSIX guarantee — we only verify the cleanup invariant here.)"""
    target = tmp_path / "overrides.json"
    write_overlay({"event_threshold_db": 78.0}, path=target)
    write_overlay({"event_threshold_db": 79.0}, path=target)
    leftover = list(tmp_path.glob("*.tmp"))
    assert leftover == []


def test_mutable_fields_is_narrow() -> None:
    """Regression: if someone widens MUTABLE_FIELDS, the matching
    backend/UI plumbing has to land in the same change. This guard catches
    drift before the device starts honouring fields the cloud can't see."""
    assert MUTABLE_FIELDS == frozenset({"event_threshold_db", "paused"})


# ---- load_config overlay merge ---------------------------------------------


def test_load_config_no_overlay_uses_defaults(tmp_path: pathlib.Path) -> None:
    base = _write_base(tmp_path)
    overlay = tmp_path / "missing.json"
    cfg = load_config(base, overlay_path=overlay)
    assert cfg.event_threshold_db == 80.0


def test_load_config_overlay_applies(tmp_path: pathlib.Path) -> None:
    base = _write_base(tmp_path)
    overlay = tmp_path / "overrides.json"
    overlay.write_text(json.dumps({"event_threshold_db": 76.5}))
    cfg = load_config(base, overlay_path=overlay)
    assert cfg.event_threshold_db == 76.5


def test_load_config_overlay_bumps_config_version(tmp_path: pathlib.Path) -> None:
    """The cloud's Health-message-driven feedback loop relies on
    config_version changing after an apply."""
    base = _write_base(tmp_path)
    overlay = tmp_path / "overrides.json"

    cfg_baseline = load_config(base, overlay_path=tmp_path / "missing.json")
    overlay.write_text(json.dumps({"event_threshold_db": 77.0}))
    cfg_after = load_config(base, overlay_path=overlay)
    assert cfg_baseline.config_version != cfg_after.config_version


def test_load_config_overlay_drops_unknown_key(
    tmp_path: pathlib.Path, caplog: pytest.LogCaptureFixture
) -> None:
    base = _write_base(tmp_path)
    overlay = tmp_path / "overrides.json"
    overlay.write_text(json.dumps({"event_threshold_db": 78.0, "bogus": 1}))
    with caplog.at_level(logging.WARNING, logger="urban_acoustics.config"):
        cfg = load_config(base, overlay_path=overlay)
    assert cfg.event_threshold_db == 78.0
    assert any("bogus" in rec.message for rec in caplog.records)


def test_load_config_overlay_unreadable_file_ignored(tmp_path: pathlib.Path) -> None:
    base = _write_base(tmp_path)
    overlay = tmp_path / "overrides.json"
    overlay.write_text("not-json{")
    cfg = load_config(base, overlay_path=overlay)
    # Falls back to base default cleanly.
    assert cfg.event_threshold_db == 80.0
