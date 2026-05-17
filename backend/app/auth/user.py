"""User authentication — Phase 1 stub.

Phase 1 has no user accounts; the dashboard is open inside the dev VLAN. This
module exists so handlers that *will* eventually require a user (labels,
playback URLs) can already declare the dependency and switch to real auth
without changing the call sites. Phase 2 lands real session cookies / JWT.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True)
class ResolvedUser:
    user_id: str
    is_admin: bool = False


async def require_user() -> ResolvedUser:
    # Dev-only: every caller is the same anonymous "dev" user. Real auth lands
    # in Phase 2; the dependency signature is the seam that won't change.
    return ResolvedUser(user_id="dev", is_admin=True)
