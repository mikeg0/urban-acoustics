"""User authentication — cookie + JWT.

Reads the ``access_token`` cookie, decodes the JWT, loads the user row, and
returns an ``AuthenticatedUser`` to the handler. ``require_permission(perm)``
is a factory returning a dependency that 403s when the current user lacks
``perm`` — endpoint guards check permissions, never role strings, so adding
a new role is a one-line edit to :mod:`auth.permissions`.

``ResolvedUser`` is kept as an alias so existing route imports keep working.
"""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from fastapi import Cookie, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..models import User
from .cookies import COOKIE_NAME
from .jwt_tokens import decode_access_token
from .permissions import has_permission, permissions_for


@dataclass(slots=True)
class AuthenticatedUser:
    user_id: str
    email: str
    role: str

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"

    @property
    def permissions(self) -> frozenset[str]:
        return permissions_for(self.role)

    def has_permission(self, permission: str) -> bool:
        return has_permission(self.role, permission)


# Backwards-compat alias for handlers that still import ResolvedUser.
ResolvedUser = AuthenticatedUser


async def get_current_user(
    access_token: str | None = Cookie(default=None, alias=COOKIE_NAME),
    session: AsyncSession = Depends(get_session),
) -> AuthenticatedUser:
    if not access_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="not authenticated")
    payload = decode_access_token(access_token)
    if payload is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid token")
    try:
        user_uuid = UUID(payload.user_id)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid token")
    user = await session.get(User, user_uuid)
    if user is None or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="user inactive")
    return AuthenticatedUser(user_id=str(user.user_id), email=user.email, role=user.role)


async def require_user(
    user: AuthenticatedUser = Depends(get_current_user),
) -> AuthenticatedUser:
    return user


def require_permission(permission: str):
    """Factory: returns a dependency that 403s if the user lacks ``permission``."""

    async def _checker(
        user: AuthenticatedUser = Depends(get_current_user),
    ) -> AuthenticatedUser:
        if not user.has_permission(permission):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"requires permission {permission}",
            )
        return user

    return _checker
