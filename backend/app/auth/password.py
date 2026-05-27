"""Password hashing — bcrypt (direct, no passlib wrapper).

passlib's bcrypt adapter has compatibility problems with bcrypt >=4.1
(its version-probing routine throws on the 72-byte length check). Using
the bcrypt library directly avoids that headache entirely.
"""

from __future__ import annotations

import bcrypt

# bcrypt silently truncates anything past 72 bytes, which lets very long
# passwords collide. Reject them up front so the caller knows.
_MAX_PASSWORD_BYTES = 72


def hash_password(password: str) -> str:
    pw = password.encode("utf-8")
    if len(pw) > _MAX_PASSWORD_BYTES:
        raise ValueError(f"password is longer than {_MAX_PASSWORD_BYTES} bytes")
    return bcrypt.hashpw(pw, bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    pw = password.encode("utf-8")
    if len(pw) > _MAX_PASSWORD_BYTES:
        return False
    try:
        return bcrypt.checkpw(pw, password_hash.encode("utf-8"))
    except (ValueError, TypeError):
        return False
