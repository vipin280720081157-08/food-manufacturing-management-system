
"""
Authentication, password hashing, JWT handling, and role authorization.

Passwords are hashed using Argon2.
Access tokens are signed using the verified application settings.
Authorization decisions use the user's assigned database role.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Iterable
from uuid import UUID

import jwt
from fastapi import HTTPException, status
from jwt.exceptions import InvalidTokenError
from pwdlib import PasswordHash

from app.core.config import settings
from app.models.user import User


_password_hasher = PasswordHash.recommended()

_CREDENTIALS_EXCEPTION_DETAIL = "Could not validate credentials."
_PERMISSION_EXCEPTION_DETAIL = "Insufficient permissions."


def hash_password(password: str) -> str:
    """Hash a plaintext password using Argon2."""

    if not isinstance(password, str) or not password:
        raise ValueError("Password must be a non-empty string.")

    return _password_hasher.hash(password)


def verify_password(
    plain_password: str,
    hashed_password: str,
) -> bool:
    """Verify a plaintext password against a stored password hash."""

    if (
        not isinstance(plain_password, str)
        or not isinstance(hashed_password, str)
        or not plain_password
        or not hashed_password
    ):
        return False

    try:
        return _password_hasher.verify(
            plain_password,
            hashed_password,
        )
    except (ValueError, TypeError):
        return False


def create_access_token(
    subject: UUID | str,
    expires_delta: timedelta | None = None,
) -> str:
    """
    Create a signed JWT access token for a user.

    The subject is the user's UUID primary key.
    The token contains an issued-at time, expiration time,
    and an explicit access-token type.
    """

    try:
        user_id = UUID(str(subject))
    except (ValueError, TypeError, AttributeError) as exc:
        raise ValueError(
            "Token subject must be a valid user UUID."
        ) from exc

    now = datetime.now(timezone.utc)

    lifetime = (
        expires_delta
        if expires_delta is not None
        else timedelta(
            minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES
        )
    )

    if lifetime <= timedelta(0):
        raise ValueError(
            "Access token lifetime must be positive."
        )

    payload = {
        "sub": str(user_id),
        "type": "access",
        "iat": now,
        "exp": now + lifetime,
    }

    return jwt.encode(
        payload,
        settings.SECRET_KEY.get_secret_value(),
        algorithm=settings.ALGORITHM,
    )


def decode_access_token(token: str) -> UUID:
    """
    Validate a JWT access token and return its user UUID.

    Reject expired, malformed, incorrectly signed, or
    incorrectly typed tokens.
    """

    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=_CREDENTIALS_EXCEPTION_DETAIL,
        headers={"WWW-Authenticate": "Bearer"},
    )

    if not isinstance(token, str) or not token.strip():
        raise credentials_exception

    try:
        payload = jwt.decode(
            token,
            settings.SECRET_KEY.get_secret_value(),
            algorithms=[settings.ALGORITHM],
            options={
                "require": ["sub", "exp", "iat", "type"],
                "verify_signature": True,
                "verify_exp": True,
                "verify_iat": True,
            },
            leeway=0,
        )

        if payload.get("type") != "access":
            raise credentials_exception

        subject = payload.get("sub")

        if not isinstance(subject, str):
            raise credentials_exception

        return UUID(subject)

    except (
        InvalidTokenError,
        ValueError,
        TypeError,
        AttributeError,
    ) as exc:
        raise credentials_exception from exc


def require_active_user(user: User | None) -> User:
    """
    Ensure that an authenticated user exists and is active.

    Inactive users are denied access even when their
    previously issued JWT has not expired.
    """

    if user is None or not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User account is inactive or unavailable.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    return user


def get_user_role_name(user: User) -> str | None:
    """Return the role name from the user's primary role."""

    active_user = require_active_user(user)

    role = active_user.primary_role

    if role is None:
        return None

    return role.role_name


def require_roles(
    user: User,
    allowed_roles: Iterable[str],
) -> User:
    """
    Authorize an active user against explicitly allowed roles.

    Role names must match the names stored in the roles table.
    Authorization is denied when no role is assigned or when
    the assigned role is not permitted.
    """

    active_user = require_active_user(user)

    permitted_roles = frozenset(allowed_roles)

    if not permitted_roles:
        raise ValueError(
            "At least one permitted role must be specified."
        )

    role_name = get_user_role_name(active_user)

    if role_name is None or role_name not in permitted_roles:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=_PERMISSION_EXCEPTION_DETAIL,
        )

    return active_user


def require_read_only_role(
    user: User,
    read_only_roles: Iterable[str],
) -> User:
    """
    Validate membership in a specified read-only role set.

    This helper establishes role membership only.
    Write operations must separately enforce their own
    allowed-role policies through require_roles().
    """

    return require_roles(
        user=user,
        allowed_roles=read_only_roles,
    )
