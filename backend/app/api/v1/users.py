"""/api/v1/users — admin user management.

All routes require ``user.manage``. Admins can list users, change a user's
role, deactivate/reactivate, and delete. Admins cannot delete or
deactivate themselves (the bootstrap admin should always be reachable).
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ...auth.permissions import KNOWN_ROLES
from ...auth.user import AuthenticatedUser, require_permission
from ...db import get_session
from ...models import User

router = APIRouter()


class UserSummary(BaseModel):
    user_id: str
    email: str
    role: str
    is_active: bool
    created_at: float
    last_login_at: float | None


class UserPatch(BaseModel):
    role: str | None = Field(default=None)
    is_active: bool | None = None

    def is_empty(self) -> bool:
        return self.role is None and self.is_active is None


def _to_summary(user: User) -> UserSummary:
    return UserSummary(
        user_id=str(user.user_id),
        email=user.email,
        role=user.role,
        is_active=user.is_active,
        created_at=user.created_at.timestamp(),
        last_login_at=user.last_login_at.timestamp() if user.last_login_at else None,
    )


@router.get("/users", response_model=list[UserSummary])
async def list_users(
    _admin: Annotated[AuthenticatedUser, Depends(require_permission("user.manage"))],
    session: AsyncSession = Depends(get_session),
) -> list[UserSummary]:
    result = await session.execute(select(User).order_by(User.created_at.desc()))
    return [_to_summary(u) for u in result.scalars().all()]


@router.patch("/users/{user_id}", response_model=UserSummary)
async def patch_user(
    user_id: UUID,
    body: UserPatch,
    admin: Annotated[AuthenticatedUser, Depends(require_permission("user.manage"))],
    session: AsyncSession = Depends(get_session),
) -> UserSummary:
    if body.is_empty():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="no fields to update")

    user = await session.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="user not found")

    if body.role is not None:
        if body.role not in KNOWN_ROLES:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"unknown role; must be one of {list(KNOWN_ROLES)}",
            )
        user.role = body.role

    if body.is_active is not None:
        if not body.is_active and str(user.user_id) == admin.user_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="cannot deactivate yourself",
            )
        user.is_active = body.is_active

    user.updated_at = datetime.now(timezone.utc)
    await session.commit()
    await session.refresh(user)
    return _to_summary(user)


@router.delete("/users/{user_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
async def delete_user(
    user_id: UUID,
    admin: Annotated[AuthenticatedUser, Depends(require_permission("user.manage"))],
    session: AsyncSession = Depends(get_session),
) -> None:
    if str(user_id) == admin.user_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="cannot delete yourself",
        )
    user = await session.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="user not found")
    await session.delete(user)
    await session.commit()
