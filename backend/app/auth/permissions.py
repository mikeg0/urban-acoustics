"""Role-permission map for the dashboard.

Endpoint guards check *permissions*, never role strings, so adding a new
role is a one-line edit to ROLE_PERMISSIONS. The role column in the
``users`` table also has a CHECK constraint listing known roles; if you
add a role here you also need to extend that constraint in a new
migration.
"""

from __future__ import annotations

from typing import Final

# --- permission constants ----------------------------------------------------
# Strings are stable identifiers — the frontend mirror in
# frontend/src/permissions.ts must use the exact same values.

DASHBOARD_PREVIEW: Final = "dashboard.preview"
DASHBOARD_VIEW: Final = "dashboard.view"
LIVE_REALTIME: Final = "live.realtime"
EVENT_LABEL_WRITE: Final = "event.label.write"
EVENT_DELETE: Final = "event.delete"
DEVICE_CONFIG_WRITE: Final = "device.config.write"
DEVICE_REGISTER: Final = "device.register"
USER_MANAGE: Final = "user.manage"

ALL_PERMISSIONS: Final[frozenset[str]] = frozenset(
    {
        DASHBOARD_PREVIEW,
        DASHBOARD_VIEW,
        LIVE_REALTIME,
        EVENT_LABEL_WRITE,
        EVENT_DELETE,
        DEVICE_CONFIG_WRITE,
        DEVICE_REGISTER,
        USER_MANAGE,
    }
)


# --- role → permission map ---------------------------------------------------
# Intentionally not cumulative across the whole hierarchy: guests see mock
# data (dashboard.preview), members see real data (dashboard.view) — those
# two don't bleed into each other. Higher tiers do inherit from the tier
# immediately below.

ROLE_PERMISSIONS: Final[dict[str, frozenset[str]]] = {
    "guest": frozenset({DASHBOARD_PREVIEW}),
    "member": frozenset({DASHBOARD_VIEW, LIVE_REALTIME}),
    "contributor": frozenset(
        {DASHBOARD_VIEW, LIVE_REALTIME, EVENT_LABEL_WRITE, EVENT_DELETE}
    ),
    "admin": frozenset(
        {
            DASHBOARD_VIEW,
            LIVE_REALTIME,
            EVENT_LABEL_WRITE,
            EVENT_DELETE,
            DEVICE_CONFIG_WRITE,
            DEVICE_REGISTER,
            USER_MANAGE,
        }
    ),
}

KNOWN_ROLES: Final[tuple[str, ...]] = tuple(ROLE_PERMISSIONS.keys())


def has_permission(role: str, permission: str) -> bool:
    return permission in ROLE_PERMISSIONS.get(role, frozenset())


def permissions_for(role: str) -> frozenset[str]:
    return ROLE_PERMISSIONS.get(role, frozenset())
