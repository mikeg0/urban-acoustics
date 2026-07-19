"""Partner API-key auth dependency — pure-logic checks with a stub session.

Mirrors test_device_runtime_config.py: call the dependency directly with a
stubbed async session, no Postgres. The DB-backed round-trip belongs with the
end-to-end smoke scripts.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.auth import api_key as ak
from app.auth.password import hash_password


class _StubSession:
    """Async-session stub exposing only what require_api_key touches."""

    def __init__(self, client: object | None) -> None:
        self._client = client
        self.committed = False

    async def get(self, _model, _key):
        return self._client

    async def commit(self) -> None:
        self.committed = True


def _client(secret: str, *, is_active: bool = True) -> SimpleNamespace:
    return SimpleNamespace(
        api_key="ak_test",
        secret_hash=hash_password(secret),
        label="sleep-atlas",
        is_active=is_active,
        last_used_at=None,
    )


@pytest.mark.asyncio
async def test_valid_credentials_return_client() -> None:
    session = _StubSession(_client("s3cret"))
    resolved = await ak.require_api_key(
        x_api_key="ak_test", x_api_secret="s3cret", session=session,  # type: ignore[arg-type]
    )
    assert resolved.api_key == "ak_test"
    assert resolved.label == "sleep-atlas"
    assert session.committed is True  # last_used_at stamped


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "key,secret",
    [(None, None), ("ak_test", None), (None, "s3cret"), ("", "s3cret"), ("ak_test", "")],
)
async def test_missing_headers_401(key, secret) -> None:
    session = _StubSession(_client("s3cret"))
    with pytest.raises(HTTPException) as ei:
        await ak.require_api_key(x_api_key=key, x_api_secret=secret, session=session)  # type: ignore[arg-type]
    assert ei.value.status_code == 401
    assert session.committed is False


@pytest.mark.asyncio
async def test_wrong_secret_401() -> None:
    session = _StubSession(_client("s3cret"))
    with pytest.raises(HTTPException) as ei:
        await ak.require_api_key(
            x_api_key="ak_test", x_api_secret="wrong", session=session,  # type: ignore[arg-type]
        )
    assert ei.value.status_code == 401
    assert session.committed is False


@pytest.mark.asyncio
async def test_unknown_key_401() -> None:
    session = _StubSession(None)
    with pytest.raises(HTTPException) as ei:
        await ak.require_api_key(
            x_api_key="ak_missing", x_api_secret="whatever", session=session,  # type: ignore[arg-type]
        )
    assert ei.value.status_code == 401


@pytest.mark.asyncio
async def test_inactive_client_401() -> None:
    """A revoked client (is_active=false) is rejected even with the right secret."""
    session = _StubSession(_client("s3cret", is_active=False))
    with pytest.raises(HTTPException) as ei:
        await ak.require_api_key(
            x_api_key="ak_test", x_api_secret="s3cret", session=session,  # type: ignore[arg-type]
        )
    assert ei.value.status_code == 401
    assert session.committed is False
