"""Partner API-key authentication (machine-to-machine).

Server-to-server callers (e.g. sleep-atlas pulling a device's noise curve)
authenticate with an ``X-API-Key`` / ``X-API-Secret`` header pair instead of a
cookie session. The key identifies an ``api_clients`` row; the secret is checked
against its bcrypt hash. This is deliberately separate from the cookie+JWT user
auth (``auth.user``) and the device mTLS path (``auth.device``) — a partner
client is neither a dashboard user nor a device.

Every auth failure returns 401 with a generic message: partners shouldn't be
able to distinguish "unknown key" from "wrong secret" from "revoked".
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..models import ApiClient
from .password import hash_password, verify_password

# A throwaway bcrypt hash used when no active client matches, so we still run one
# verify_password and the response time doesn't leak whether a given api_key
# exists (timing-based key enumeration). Computed once at import.
_DUMMY_HASH = hash_password("api-key-enumeration-guard")


@dataclass(slots=True)
class ResolvedApiClient:
    api_key: str
    label: str


async def require_api_key(
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
    x_api_secret: str | None = Header(default=None, alias="X-API-Secret"),
    session: AsyncSession = Depends(get_session),
) -> ResolvedApiClient:
    if not x_api_key or not x_api_secret:
        # Burn one verify on the missing-header path too, so it isn't
        # measurably faster than the wrong-secret path.
        verify_password(x_api_secret or "", _DUMMY_HASH)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="missing API credentials",
        )

    client = await session.get(ApiClient, x_api_key)
    active = client is not None and client.is_active
    # Always run exactly one verify — against the real hash when the client is
    # active, the dummy otherwise — so timing doesn't reveal a valid key.
    secret_hash = client.secret_hash if active else _DUMMY_HASH
    secret_ok = verify_password(x_api_secret, secret_hash)
    if not (active and secret_ok):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid API credentials",
        )

    client.last_used_at = datetime.now(timezone.utc)
    await session.commit()
    return ResolvedApiClient(api_key=client.api_key, label=client.label)
