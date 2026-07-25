"""Tests for the role → permission map.

These exercises pin the wire-level permission strings so the frontend
mirror in ``frontend/src/permissions.ts`` stays in lockstep. Adding a new
permission or role should require adding a case here.
"""

from __future__ import annotations

import pytest

from app.auth.permissions import (
    ALL_PERMISSIONS,
    KNOWN_ROLES,
    ROLE_PERMISSIONS,
    has_permission,
    permissions_for,
)


def test_known_roles_match_role_permissions() -> None:
    assert set(KNOWN_ROLES) == set(ROLE_PERMISSIONS.keys())
    # Roles in the documented order: guest, member, contributor, admin.
    assert KNOWN_ROLES == ("guest", "member", "contributor", "admin")


def test_every_role_uses_only_known_permissions() -> None:
    for role, perms in ROLE_PERMISSIONS.items():
        assert perms <= ALL_PERMISSIONS, f"{role} grants unknown permissions"


@pytest.mark.parametrize(
    "role,permission,expected",
    [
        # Guest: only the preview.
        ("guest", "dashboard.preview", True),
        ("guest", "dashboard.view", False),
        ("guest", "live.realtime", False),
        ("guest", "event.delete", False),
        ("guest", "user.manage", False),
        ("guest", "event.candidate.manage", False),
        # Member: real data + live, no writes.
        ("member", "dashboard.preview", False),
        ("member", "dashboard.view", True),
        ("member", "live.realtime", True),
        ("member", "event.label.write", False),
        ("member", "event.delete", False),
        ("member", "event.candidate.manage", False),
        # Contributor: + label and delete events.
        ("contributor", "dashboard.view", True),
        ("contributor", "event.label.write", True),
        ("contributor", "event.delete", True),
        ("contributor", "device.config.write", False),
        ("contributor", "user.manage", False),
        ("contributor", "event.candidate.manage", False),
        # Admin: everything except dashboard.preview (preview is a guest-only feature).
        ("admin", "device.config.write", True),
        ("admin", "device.register", True),
        ("admin", "user.manage", True),
        ("admin", "event.delete", True),
        ("admin", "live.realtime", True),
        ("admin", "dashboard.preview", False),
        ("admin", "event.candidate.manage", True),
    ],
)
def test_has_permission_matrix(role: str, permission: str, expected: bool) -> None:
    assert has_permission(role, permission) is expected


def test_unknown_role_grants_nothing() -> None:
    assert permissions_for("nonexistent") == frozenset()
    assert not has_permission("nonexistent", "dashboard.view")


def test_preview_is_guest_only() -> None:
    """Preview is intentionally not inherited up the hierarchy — members
    see real data, not the simulated stream."""
    for role in ("member", "contributor", "admin"):
        assert not has_permission(role, "dashboard.preview")
