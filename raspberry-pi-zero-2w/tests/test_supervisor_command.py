"""Unit tests for the supervisor's cmd/config handler.

The full Supervisor.__init__ builds a queue, ring buffer, capture, etc. —
none of that is needed to verify command routing. We instantiate the class
via ``__new__`` and attach the minimum surface the handler touches: a fake
detector with mutable threshold attributes, a fake health publisher whose
``_cfg`` we can read, and the live config loaded from a temp directory.

The handler is async (it runs on the asyncio loop in production), but the
tests drive it via ``asyncio.run`` so we don't take a pytest-asyncio
dependency just for these — the Pi venv is intentionally lean.
"""

from __future__ import annotations

import asyncio
import json
import pathlib
from types import SimpleNamespace
from uuid import uuid4

import pytest

from urban_acoustics.config import load_config
from urban_acoustics.supervisor import Supervisor


DEVICE_UUID = "00000000-0000-4000-8000-00000000000a"


def _base_config_dict() -> dict:
    return {
        "device_id": DEVICE_UUID,
        "alsa_device": "test",
        "sample_rate": 48000,
        "event_threshold_db": 80.0,
        "event_hysteresis_db": 6.0,
        "mqtt_ca_file": "/tmp/ca.crt",
        "mqtt_cert_file": "/tmp/dev.crt",
        "mqtt_key_file": "/tmp/dev.key",
    }


def _make_supervisor(tmp_path: pathlib.Path, monkeypatch: pytest.MonkeyPatch) -> Supervisor:
    base = tmp_path / "config.json"
    base.write_text(json.dumps(_base_config_dict()))
    overlay = tmp_path / "overrides.json"

    # The handler calls write_overlay() and load_config() with no args,
    # targeting the real /var/lib path. Redirect both to our tempdir.
    from urban_acoustics.config import write_overlay as real_write_overlay

    monkeypatch.setattr(
        "urban_acoustics.supervisor.write_overlay",
        lambda updates: real_write_overlay(updates, path=overlay),
    )
    monkeypatch.setattr(
        "urban_acoustics.supervisor.load_config",
        lambda: load_config(base, overlay_path=overlay),
    )

    cfg = load_config(base, overlay_path=overlay)

    sup = Supervisor.__new__(Supervisor)
    sup.cfg = cfg
    sup.detector = SimpleNamespace(threshold_db=80.0, close_db=74.0)
    sup.health = SimpleNamespace(_cfg=cfg)
    return sup


def _run(coro):
    return asyncio.run(coro)


# ---- _on_command (parsing / dispatch) --------------------------------------


def test_on_command_applies_config(tmp_path: pathlib.Path, monkeypatch: pytest.MonkeyPatch) -> None:
    sup = _make_supervisor(tmp_path, monkeypatch)
    payload = json.dumps({
        "cmd_id": str(uuid4()),
        "cmd": "config",
        "issued_at": 1_700_000_000.0,
        "args": {"event_threshold_db": 76.5},
    }).encode()

    before_version = sup.cfg.config_version
    _run(sup._on_command(f"dev/{DEVICE_UUID}/cmd/config", payload))

    assert sup.detector.threshold_db == 76.5
    assert sup.detector.close_db == pytest.approx(76.5 - sup.cfg.event_hysteresis_db)
    assert sup.cfg.event_threshold_db == 76.5
    assert sup.cfg.config_version != before_version
    assert sup.health._cfg is sup.cfg


def test_on_command_ignores_topic_verb_mismatch(
    tmp_path: pathlib.Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    sup = _make_supervisor(tmp_path, monkeypatch)
    payload = json.dumps({
        "cmd_id": str(uuid4()),
        "cmd": "reboot",  # topic says config; envelope says reboot
        "issued_at": 1_700_000_000.0,
        "args": {"event_threshold_db": 76.5},
    }).encode()

    _run(sup._on_command(f"dev/{DEVICE_UUID}/cmd/config", payload))
    assert sup.detector.threshold_db == 80.0  # unchanged


def test_on_command_malformed_json_dropped(
    tmp_path: pathlib.Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    sup = _make_supervisor(tmp_path, monkeypatch)
    _run(sup._on_command(f"dev/{DEVICE_UUID}/cmd/config", b"not-json{"))
    assert sup.detector.threshold_db == 80.0


def test_on_command_unsupported_verb_dropped(
    tmp_path: pathlib.Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    sup = _make_supervisor(tmp_path, monkeypatch)
    payload = json.dumps({
        "cmd_id": str(uuid4()),
        "cmd": "reboot",
        "issued_at": 1_700_000_000.0,
        "args": {},
    }).encode()
    _run(sup._on_command(f"dev/{DEVICE_UUID}/cmd/reboot", payload))
    # Nothing should have changed; the verb is logged-and-dropped in v1.
    assert sup.detector.threshold_db == 80.0


# ---- _apply_config_command (filtering / validation) ------------------------


def test_apply_config_drops_unknown_keys(
    tmp_path: pathlib.Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    sup = _make_supervisor(tmp_path, monkeypatch)
    _run(sup._apply_config_command({"event_threshold_db": 78.0, "legacy": 1.0}))
    assert sup.detector.threshold_db == 78.0  # known field applied
    # Unknown one silently dropped; would have raised in write_overlay otherwise.


def test_apply_config_rejects_out_of_range(
    tmp_path: pathlib.Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    sup = _make_supervisor(tmp_path, monkeypatch)
    _run(sup._apply_config_command({"event_threshold_db": 10.0}))  # absurdly low
    assert sup.detector.threshold_db == 80.0
    _run(sup._apply_config_command({"event_threshold_db": 999.0}))  # impossible
    assert sup.detector.threshold_db == 80.0


def test_apply_config_rejects_non_numeric(
    tmp_path: pathlib.Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    sup = _make_supervisor(tmp_path, monkeypatch)
    _run(sup._apply_config_command({"event_threshold_db": "loud"}))
    assert sup.detector.threshold_db == 80.0


def test_apply_config_empty_args_noop(
    tmp_path: pathlib.Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    sup = _make_supervisor(tmp_path, monkeypatch)
    before = sup.cfg.config_version
    _run(sup._apply_config_command({}))
    assert sup.cfg.config_version == before
    assert sup.detector.threshold_db == 80.0


def test_apply_config_paused_persists_and_propagates(
    tmp_path: pathlib.Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    sup = _make_supervisor(tmp_path, monkeypatch)
    assert sup.cfg.paused is False
    before_version = sup.cfg.config_version

    _run(sup._apply_config_command({"paused": True}))

    assert sup.cfg.paused is True
    assert sup.cfg.config_version != before_version
    # Detector untouched: paused only gates downstream event materialisation.
    assert sup.detector.threshold_db == 80.0

    _run(sup._apply_config_command({"paused": False}))
    assert sup.cfg.paused is False


def test_apply_config_paused_rejects_non_boolean(
    tmp_path: pathlib.Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    sup = _make_supervisor(tmp_path, monkeypatch)
    # Strings, ints, and other truthy values must not flip paused — the
    # backend always sends a real bool, so anything else is a wire bug.
    for bad in ("true", 1, "yes", None):
        _run(sup._apply_config_command({"paused": bad}))
        assert sup.cfg.paused is False
