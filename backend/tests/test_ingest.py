"""Unit tests for the MQTT ingest worker's pure-logic surface.

DB-dependent paths (telemetry/health writes, NOTIFY, last_seen) are covered
by the end-to-end ``scripts/ingest_publish_demo.py`` smoke script that runs
inside the compose stack — they need a real Postgres+Timescale.
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import MagicMock
from uuid import UUID

import pytest

from app.ingest.mqtt import _parse_topic, _summarize_errors
from pydantic import ValidationError

from app.contracts import Telemetry


DEVICE_A = UUID("00000000-0000-4000-8000-00000000000a")


def test_parse_topic_telemetry() -> None:
    assert _parse_topic(f"dev/{DEVICE_A}/tlm") == ("tlm", DEVICE_A)


def test_parse_topic_health() -> None:
    assert _parse_topic(f"dev/{DEVICE_A}/health") == ("health", DEVICE_A)


def test_parse_topic_event_announce() -> None:
    assert _parse_topic(f"dev/{DEVICE_A}/event/announce") == ("event_announce", DEVICE_A)


def test_parse_topic_event_done() -> None:
    assert _parse_topic(f"dev/{DEVICE_A}/event/done") == ("event_done", DEVICE_A)


def test_parse_topic_lwt() -> None:
    assert _parse_topic(f"dev/{DEVICE_A}/lwt") == ("lwt", DEVICE_A)


def test_parse_topic_unknown_returns_none() -> None:
    assert _parse_topic("garbage") is None
    assert _parse_topic(f"dev/{DEVICE_A}/cmd/rotate-cert") is None  # cmd is outbound
    assert _parse_topic(f"dev/{DEVICE_A}/event/unknown") is None
    assert _parse_topic("dev/not-a-uuid/tlm") is None
    assert _parse_topic("") is None


def test_summarize_errors_compacts_validation_errors() -> None:
    with pytest.raises(ValidationError) as ei:
        Telemetry.model_validate({"ts": -1, "laeq": "x"})
    summary = _summarize_errors(ei.value)
    # The exact pydantic error types can shift between versions; just make
    # sure we got a non-empty, comma-separated list and the offending fields
    # are present.
    assert summary
    assert "ts" in summary
    assert "laeq" in summary
    assert summary.count(":") >= 2


# ---- callback-thread payload routing ---------------------------------------


def _make_worker_for_callbacks(monkeypatch: pytest.MonkeyPatch):
    """Build an IngestWorker without firing __init__ side-effects.

    The worker creates a real async engine and MQTT client in __init__; for
    these callback-thread tests we want a bare instance whose ``_loop`` and
    ``_queue`` we can replace with mocks.
    """
    from app.ingest.mqtt import IngestWorker

    worker = IngestWorker.__new__(IngestWorker)
    worker._loop = MagicMock()
    worker._queue = MagicMock()
    worker._dropped_messages = 0

    def _direct_call(fn, *args):  # call_soon_threadsafe shim
        fn(*args)

    worker._loop.call_soon_threadsafe.side_effect = _direct_call

    enqueued: list = []

    def _enqueue(item):
        enqueued.append(item)

    worker._enqueue_or_drop = _enqueue  # type: ignore[method-assign]
    return worker, enqueued


def _mqtt_msg(topic: str, payload: dict | bytes) -> SimpleNamespace:
    body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
    return SimpleNamespace(topic=topic, payload=body)


def test_on_message_routes_valid_telemetry(monkeypatch: pytest.MonkeyPatch) -> None:
    worker, enqueued = _make_worker_for_callbacks(monkeypatch)
    msg = _mqtt_msg(
        f"dev/{DEVICE_A}/tlm",
        {"ts": 1745673600.5, "laeq": 58.4, "lafmax": 67.2, "lcpeak": 82.1},
    )
    worker._on_message(None, None, msg)
    assert len(enqueued) == 1
    item = enqueued[0]
    assert item.kind == "tlm"
    assert item.device_id == DEVICE_A
    assert item.payload["laeq"] == 58.4


def test_on_message_drops_malformed_json(monkeypatch: pytest.MonkeyPatch) -> None:
    worker, enqueued = _make_worker_for_callbacks(monkeypatch)
    msg = _mqtt_msg(f"dev/{DEVICE_A}/tlm", b"not json")
    worker._on_message(None, None, msg)
    assert enqueued == []


def test_on_message_drops_unknown_topic(monkeypatch: pytest.MonkeyPatch) -> None:
    worker, enqueued = _make_worker_for_callbacks(monkeypatch)
    msg = _mqtt_msg(f"dev/{DEVICE_A}/cmd/reboot", {"cmd": "reboot"})
    worker._on_message(None, None, msg)
    assert enqueued == []


def test_on_message_rejects_payload_device_id_mismatch(monkeypatch: pytest.MonkeyPatch) -> None:
    worker, enqueued = _make_worker_for_callbacks(monkeypatch)
    other = "11111111-1111-4111-8111-111111111111"
    msg = _mqtt_msg(
        f"dev/{DEVICE_A}/tlm",
        {
            "device_id": other,  # disagrees with the topic — must be dropped per contract
            "ts": 1745673600.5,
            "laeq": 58.4,
            "lafmax": 67.2,
            "lcpeak": 82.1,
        },
    )
    worker._on_message(None, None, msg)
    assert enqueued == []


def test_on_message_accepts_matching_payload_device_id(monkeypatch: pytest.MonkeyPatch) -> None:
    worker, enqueued = _make_worker_for_callbacks(monkeypatch)
    msg = _mqtt_msg(
        f"dev/{DEVICE_A}/tlm",
        {
            "device_id": str(DEVICE_A),
            "ts": 1745673600.5,
            "laeq": 58.4,
            "lafmax": 67.2,
            "lcpeak": 82.1,
        },
    )
    worker._on_message(None, None, msg)
    assert len(enqueued) == 1


def test_on_message_drops_non_object_json(monkeypatch: pytest.MonkeyPatch) -> None:
    worker, enqueued = _make_worker_for_callbacks(monkeypatch)
    msg = _mqtt_msg(f"dev/{DEVICE_A}/tlm", b"[1,2,3]")
    worker._on_message(None, None, msg)
    assert enqueued == []
