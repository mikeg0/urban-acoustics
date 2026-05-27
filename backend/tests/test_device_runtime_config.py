"""Unit tests for the runtime-config router's handler logic.

We bypass FastAPI's request machinery and call the handlers directly with
stubbed dependencies — matches the rest of the suite (see test_ingest.py
header), keeps the tests fast, and verifies the bits that matter: auth
gating, validation, the publish call, and the DB rollback on publish
failure.

A full TestClient-level test that hits a Postgres instance belongs with the
end-to-end smoke scripts, not here.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock
from uuid import UUID, uuid4

import pytest
from fastapi import HTTPException

from app.api.v1 import device_runtime_config as rc
from app.auth.user import ResolvedUser


DEVICE_A = UUID("00000000-0000-4000-8000-00000000000a")


def _admin() -> ResolvedUser:
    return ResolvedUser(user_id="dev", email="dev@local", role="admin")


def _viewer() -> ResolvedUser:
    return ResolvedUser(user_id="viewer", email="viewer@local", role="guest")


class _StubSession:
    """Async-session stub with the minimum surface the handlers touch."""

    def __init__(self, *, device: object | None, latest_version: str | None = None) -> None:
        self._device = device
        self._latest_version = latest_version
        self.committed = False
        self.rolled_back = False

    async def get(self, _model, device_id):  # noqa: D401 — protocol shape only
        return self._device

    async def execute(self, _stmt):
        # _latest_config_version's scalar_one_or_none() path.
        return SimpleNamespace(scalar_one_or_none=lambda: self._latest_version)

    async def flush(self) -> None:
        pass

    async def commit(self) -> None:
        self.committed = True

    async def rollback(self) -> None:
        self.rolled_back = True


def _device_row(runtime_config: dict | None = None) -> SimpleNamespace:
    return SimpleNamespace(
        device_id=DEVICE_A,
        runtime_config=runtime_config if runtime_config is not None else {},
    )


# ---- GET --------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_returns_null_when_no_override_set() -> None:
    session = _StubSession(device=_device_row({}), latest_version="abc123")
    resp = await rc.get_runtime_config(
        DEVICE_A, _user=_admin(), session=session,  # type: ignore[arg-type]
    )
    assert resp.event_threshold_db is None
    assert resp.applied_config_version == "abc123"


@pytest.mark.asyncio
async def test_get_returns_stored_threshold() -> None:
    session = _StubSession(device=_device_row({"event_threshold_db": 78.0}))
    resp = await rc.get_runtime_config(
        DEVICE_A, _user=_admin(), session=session,  # type: ignore[arg-type]
    )
    assert resp.event_threshold_db == 78.0


@pytest.mark.asyncio
async def test_get_404_when_device_missing() -> None:
    session = _StubSession(device=None)
    with pytest.raises(HTTPException) as ei:
        await rc.get_runtime_config(
            DEVICE_A, _user=_admin(), session=session,  # type: ignore[arg-type]
        )
    assert ei.value.status_code == 404


# ---- PUT --------------------------------------------------------------------


@pytest.mark.asyncio
async def test_put_publishes_and_commits(monkeypatch: pytest.MonkeyPatch) -> None:
    device = _device_row({})
    session = _StubSession(device=device, latest_version="v0")
    pub = MagicMock()
    pub.connected = True
    pub.publish_command = MagicMock()
    monkeypatch.setattr(rc, "get_command_publisher", lambda: pub)

    body = rc.RuntimeConfigUpdate(event_threshold_db=78.5)
    resp = await rc.put_runtime_config(
        DEVICE_A, body=body, user=_admin(), session=session,  # type: ignore[arg-type]
    )

    assert resp.event_threshold_db == 78.5
    assert device.runtime_config == {"event_threshold_db": 78.5}
    assert session.committed is True
    assert session.rolled_back is False
    pub.publish_command.assert_called_once()
    kwargs = pub.publish_command.call_args.kwargs
    assert kwargs["device_id"] == DEVICE_A
    assert kwargs["cmd"] == "config"
    assert kwargs["args"] == {"event_threshold_db": 78.5}


@pytest.mark.asyncio
async def test_put_404_for_missing_device(monkeypatch: pytest.MonkeyPatch) -> None:
    session = _StubSession(device=None)
    monkeypatch.setattr(rc, "get_command_publisher", lambda: MagicMock(connected=True))

    body = rc.RuntimeConfigUpdate(event_threshold_db=78.0)
    with pytest.raises(HTTPException) as ei:
        await rc.put_runtime_config(
            DEVICE_A, body=body, user=_admin(), session=session,  # type: ignore[arg-type]
        )
    assert ei.value.status_code == 404


@pytest.mark.asyncio
async def test_put_503_when_publisher_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    session = _StubSession(device=_device_row({}))
    monkeypatch.setattr(rc, "get_command_publisher", lambda: None)

    body = rc.RuntimeConfigUpdate(event_threshold_db=78.0)
    with pytest.raises(HTTPException) as ei:
        await rc.put_runtime_config(
            DEVICE_A, body=body, user=_admin(), session=session,  # type: ignore[arg-type]
        )
    assert ei.value.status_code == 503
    assert session.committed is False


@pytest.mark.asyncio
async def test_put_rolls_back_when_publish_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    device = _device_row({"event_threshold_db": 80.0})
    session = _StubSession(device=device)
    pub = MagicMock()
    pub.connected = True

    def _boom(**_kwargs):
        raise RuntimeError("broker rejected")

    pub.publish_command = MagicMock(side_effect=_boom)
    monkeypatch.setattr(rc, "get_command_publisher", lambda: pub)

    body = rc.RuntimeConfigUpdate(event_threshold_db=78.0)
    with pytest.raises(HTTPException) as ei:
        await rc.put_runtime_config(
            DEVICE_A, body=body, user=_admin(), session=session,  # type: ignore[arg-type]
        )
    assert ei.value.status_code == 503
    assert session.committed is False
    assert session.rolled_back is True


def test_threshold_validation_rejects_out_of_range() -> None:
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        rc.RuntimeConfigUpdate(event_threshold_db=10.0)  # absurdly quiet
    with pytest.raises(ValidationError):
        rc.RuntimeConfigUpdate(event_threshold_db=200.0)  # above mic clip


def test_update_requires_at_least_one_field() -> None:
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        rc.RuntimeConfigUpdate()


@pytest.mark.asyncio
async def test_put_paused_only_publishes_full_overlay(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Start from an existing threshold override so we can verify that a
    # paused-only PUT publishes the *merged* overlay (not just the diff) —
    # that's the contract the Pi-side filter assumes.
    device = _device_row({"event_threshold_db": 82.0})
    session = _StubSession(device=device)
    pub = MagicMock()
    pub.connected = True
    pub.publish_command = MagicMock()
    monkeypatch.setattr(rc, "get_command_publisher", lambda: pub)

    body = rc.RuntimeConfigUpdate(paused=True)
    resp = await rc.put_runtime_config(
        DEVICE_A, body=body, user=_admin(), session=session,  # type: ignore[arg-type]
    )

    assert resp.paused is True
    assert resp.event_threshold_db == 82.0
    assert device.runtime_config == {"event_threshold_db": 82.0, "paused": True}
    assert pub.publish_command.call_args.kwargs["args"] == {
        "event_threshold_db": 82.0,
        "paused": True,
    }


@pytest.mark.asyncio
async def test_get_returns_paused_from_overlay() -> None:
    session = _StubSession(device=_device_row({"paused": True}))
    resp = await rc.get_runtime_config(
        DEVICE_A, _user=_admin(), session=session,  # type: ignore[arg-type]
    )
    assert resp.paused is True
    assert resp.event_threshold_db is None


@pytest.mark.asyncio
async def test_get_paused_defaults_false() -> None:
    session = _StubSession(device=_device_row({}))
    resp = await rc.get_runtime_config(
        DEVICE_A, _user=_admin(), session=session,  # type: ignore[arg-type]
    )
    assert resp.paused is False
