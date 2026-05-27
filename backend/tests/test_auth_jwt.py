"""JWT encode/decode round-trip + password hashing checks.

Hits the same JWT_SECRET the production code uses (read from settings),
so a build that flips the algorithm or rejects unsigned tokens breaks
here first.
"""

from __future__ import annotations

import time

import jwt
import pytest

from app.auth.jwt_tokens import decode_access_token, encode_access_token
from app.auth.password import hash_password, verify_password


def test_encode_decode_roundtrip() -> None:
    token = encode_access_token(user_id="abc", role="contributor", ttl_seconds=60)
    payload = decode_access_token(token)
    assert payload is not None
    assert payload.user_id == "abc"
    assert payload.role == "contributor"
    assert payload.exp - payload.iat == 60


def test_decode_rejects_garbage() -> None:
    assert decode_access_token("not-a-jwt") is None
    assert decode_access_token("") is None


def test_decode_rejects_expired() -> None:
    token = encode_access_token(user_id="u", role="guest", ttl_seconds=-5)
    assert decode_access_token(token) is None


def test_decode_rejects_bad_signature() -> None:
    # Sign with a different secret and confirm it's rejected.
    bad = jwt.encode({"sub": "u", "role": "guest", "iat": int(time.time()), "exp": int(time.time()) + 60}, "wrong-secret", algorithm="HS256")
    assert decode_access_token(bad) is None


def test_password_hash_verify() -> None:
    h = hash_password("hunter2-correct")
    assert h != "hunter2-correct"
    assert verify_password("hunter2-correct", h) is True
    assert verify_password("wrong", h) is False


def test_password_verify_handles_malformed_hash() -> None:
    assert verify_password("anything", "not-a-bcrypt-hash") is False
