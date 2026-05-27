"""/api/v1/auth/* — signup, login, logout, me.

Sessions are JWTs delivered as HttpOnly cookies. Self-signup creates a
``guest`` account; admins promote roles via /api/v1/users/{id}.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ...auth.cookies import clear_access_cookie, set_access_cookie
from ...auth.jwt_tokens import encode_access_token
from ...auth.password import hash_password, verify_password
from ...auth.permissions import permissions_for
from ...auth.user import AuthenticatedUser, get_current_user
from ...db import get_session
from ...models import User

router = APIRouter()

# Pragmatic email regex — full RFC 5322 compliance isn't worth the dep cost
# for an internal dashboard. Rejects obvious garbage but allows short
# single-label hosts like 'admin@local' for in-network deployments; the
# password and server-side uniqueness do the rest.
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+$")


def _validate_email_str(v: str) -> str:
    v = v.strip().lower()
    if not _EMAIL_RE.match(v) or len(v) > 254:
        raise ValueError("invalid email")
    return v


class SignupRequest(BaseModel):
    email: str
    password: str = Field(min_length=8, max_length=128)

    @field_validator("email")
    @classmethod
    def _email(cls, v: str) -> str:
        return _validate_email_str(v)


class LoginRequest(BaseModel):
    email: str
    password: str = Field(min_length=1, max_length=128)

    @field_validator("email")
    @classmethod
    def _email(cls, v: str) -> str:
        return _validate_email_str(v)


class UserResponse(BaseModel):
    user_id: str
    email: str
    role: str
    permissions: list[str]


def _to_response(user: User) -> UserResponse:
    return UserResponse(
        user_id=str(user.user_id),
        email=user.email,
        role=user.role,
        permissions=sorted(permissions_for(user.role)),
    )


@router.post("/auth/signup", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
async def signup(
    body: SignupRequest,
    response: Response,
    session: AsyncSession = Depends(get_session),
) -> UserResponse:
    email = body.email  # already normalized by validator
    now = datetime.now(timezone.utc)
    user = User(
        user_id=uuid4(),
        email=email,
        password_hash=hash_password(body.password),
        role="guest",
        is_active=True,
        created_at=now,
        updated_at=now,
        last_login_at=now,
    )
    session.add(user)
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="email already registered")
    await session.refresh(user)

    token = encode_access_token(user_id=str(user.user_id), role=user.role)
    set_access_cookie(response, token)
    return _to_response(user)


@router.post("/auth/login", response_model=UserResponse)
async def login(
    body: LoginRequest,
    response: Response,
    session: AsyncSession = Depends(get_session),
) -> UserResponse:
    email = body.email
    result = await session.execute(select(User).where(User.email == email))
    user = result.scalar_one_or_none()
    if user is None or not verify_password(body.password, user.password_hash):
        # Same error for missing-user and bad-password to avoid user enumeration.
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid credentials")
    if not user.is_active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="account disabled")

    user.last_login_at = datetime.now(timezone.utc)
    user.updated_at = user.last_login_at
    await session.commit()
    await session.refresh(user)

    token = encode_access_token(user_id=str(user.user_id), role=user.role)
    set_access_cookie(response, token)
    return _to_response(user)


@router.post("/auth/logout", status_code=status.HTTP_204_NO_CONTENT, response_class=Response)
def logout(response: Response) -> Response:
    clear_access_cookie(response)
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@router.get("/auth/me", response_model=UserResponse)
async def me(
    user: AuthenticatedUser = Depends(get_current_user),
) -> UserResponse:
    return UserResponse(
        user_id=user.user_id,
        email=user.email,
        role=user.role,
        permissions=sorted(user.permissions),
    )
