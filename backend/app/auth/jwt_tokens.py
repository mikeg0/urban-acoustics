"""JWT encode/decode for the dashboard session cookie.

Tokens are signed with ``JWT_SECRET`` and carry ``sub`` (user_id), ``role``,
``iat``, ``exp``. TTL is ``JWT_TTL_SECONDS``. The cookie is HttpOnly and
SameSite=Lax (see auth routes); this module just handles encode/decode.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

import jwt

from ..settings import get_settings

ALGORITHM = "HS256"


@dataclass(slots=True)
class TokenPayload:
    user_id: str
    role: str
    exp: int
    iat: int


def encode_access_token(user_id: str, role: str, ttl_seconds: int | None = None) -> str:
    settings = get_settings()
    now = int(time.time())
    exp = now + (ttl_seconds if ttl_seconds is not None else settings.JWT_TTL_SECONDS)
    payload: dict[str, Any] = {"sub": user_id, "role": role, "iat": now, "exp": exp}
    return jwt.encode(payload, settings.JWT_SECRET, algorithm=ALGORITHM)


def should_reissue(payload: TokenPayload, now: int | None = None) -> bool:
    """Sliding-session threshold: True once the token is past half its lifetime.

    Half is early enough that a browser polling at any reasonable interval
    keeps its session alive indefinitely, while capping re-issue churn at
    roughly two cookies per TTL for an active client.
    """
    if now is None:
        now = int(time.time())
    lifetime = payload.exp - payload.iat
    if lifetime <= 0:
        return True
    return (now - payload.iat) * 2 >= lifetime


def decode_access_token(token: str) -> TokenPayload | None:
    settings = get_settings()
    try:
        data = jwt.decode(token, settings.JWT_SECRET, algorithms=[ALGORITHM])
    except jwt.PyJWTError:
        return None
    user_id = data.get("sub")
    role = data.get("role")
    exp = data.get("exp")
    iat = data.get("iat")
    if not isinstance(user_id, str) or not isinstance(role, str):
        return None
    if not isinstance(exp, int) or not isinstance(iat, int):
        return None
    return TokenPayload(user_id=user_id, role=role, exp=exp, iat=iat)
