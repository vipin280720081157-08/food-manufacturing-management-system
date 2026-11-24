"""
Authentication and user-account management services.

This module uses the existing Development 03A User, Role, and UserRole
models and the authentication helpers defined in app.core.security.

Authentication failures use generic responses to avoid disclosing
whether an account exists. User-management operations require an
active Factory Admin account and preserve audit history.

Database writes are flushed but not committed by this service.
The caller owns the transaction and must commit business changes
and their audit entries atomically.
"""

from __future__ import annotations

from collections.abc import Sequence
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.core.security import (
    create_access_token,
    hash_password,
    verify_password,
)
from app.models.user import Role, User, UserRole
from app.services.audit_service import create_audit_log


FACTORY_ADMIN_ROLE = "Factory Admin"

AUTHENTICATION_ERROR = "Invalid email or password."

VALIDATION_ERROR_STATUS = status.HTTP_422_UNPROCESSABLE_ENTITY

USER_ROLE_NAMES = frozenset(
    {
        "Salesman",
        "Factory Admin",
        "Production Supervisor",
        "Accountant/Auditor",
        "Owner",
    }
)


def _http_error(
    status_code: int,
    detail: str,
) -> HTTPException:
    return HTTPException(
        status_code=status_code,
        detail=detail,
    )


def _normalize_email(email: str) -> str:
    if not isinstance(email, str):
        raise _http_error(
            VALIDATION_ERROR_STATUS,
            "Email must be a string.",
        )

    normalized = email.strip().lower()

    if (
        not normalized
        or len(normalized) > 255
        or "@" not in normalized
        or normalized.startswith("@")
        or normalized.endswith("@")
    ):
        raise _http_error(
            VALIDATION_ERROR_STATUS,
            "A valid email address is required.",
        )

    return normalized


def _normalize_name(name: str) -> str:
    if not isinstance(name, str):
        raise _http_error(
            VALIDATION_ERROR_STATUS,
            "Full name must be a string.",
        )

    normalized = " ".join(name.split())

    if not normalized or len(normalized) > 150:
        raise _http_error(
            VALIDATION_ERROR_STATUS,
            "Full name must contain between 1 and 150 characters.",
        )

    return normalized


def _normalize_phone(phone: str | None) -> str | None:
    if phone is None:
        return None

    if not isinstance(phone, str):
        raise _http_error(
            VALIDATION_ERROR_STATUS,
            "Phone number must be a string.",
        )

    normalized = phone.strip()

    if len(normalized) > 30:
        raise _http_error(
            VALIDATION_ERROR_STATUS,
            "Phone number cannot exceed 30 characters.",
        )

    return normalized or None


def _validate_password(password: str, *, allow_demo_password: bool = False) -> str:
    if not isinstance(password, str):
        raise _http_error(
            VALIDATION_ERROR_STATUS,
            "Password must be a string.",
        )

    from app.core.config import settings
    from app.core.demo_accounts import DEMO_PASSWORD

    allowed_demo_password = (
        allow_demo_password
        and settings.DEMO_MODE
        and settings.ENVIRONMENT != "production"
        and password == DEMO_PASSWORD
    )

    if not allowed_demo_password and not 12 <= len(password) <= 128:
        raise _http_error(
            VALIDATION_ERROR_STATUS,
            "Password must contain between 12 and 128 characters.",
        )

    if password.isspace():
        raise _http_error(
            VALIDATION_ERROR_STATUS,
            "Password cannot consist only of whitespace.",
        )

    return password


def _user_query():
    return select(User).options(
        selectinload(User.role_assignment).selectinload(
            UserRole.role
        )
    )


def _require_active_user(
    db: Session,
    user_id: UUID,
) -> User:
    user = db.scalar(
        _user_query().where(User.user_id == user_id)
    )

    if user is None or not user.is_active:
        raise _http_error(
            status.HTTP_403_FORBIDDEN,
            "An active user account is required.",
        )

    return user


def _require_factory_admin(
    db: Session,
    actor_id: UUID,
) -> User:
    actor = _require_active_user(db, actor_id)
    role = actor.primary_role

    if role is None or role.role_name != FACTORY_ADMIN_ROLE:
        raise _http_error(
            status.HTTP_403_FORBIDDEN,
            "Factory Admin permission is required.",
        )

    return actor


def _require_existing_user(
    db: Session,
    user_id: UUID,
    *,
    lock: bool = False,
) -> User:
    statement = _user_query().where(
        User.user_id == user_id
    )

    if lock:
        statement = statement.with_for_update(of=User)

    user = db.scalar(statement)

    if user is None:
        raise _http_error(
            status.HTTP_404_NOT_FOUND,
            "User not found.",
        )

    return user


def _require_role(
    db: Session,
    role_id: UUID,
) -> Role:
    role = db.get(Role, role_id)

    if role is None:
        raise _http_error(
            status.HTTP_404_NOT_FOUND,
            "Role not found.",
        )

    if role.role_name not in USER_ROLE_NAMES:
        raise _http_error(
            status.HTTP_409_CONFLICT,
            "The selected role is not an approved application role.",
        )

    return role


def get_user(
    db: Session,
    user_id: UUID,
) -> User:
    """Return an existing user with their assigned role loaded."""

    return _require_existing_user(db, user_id)


def get_current_user(
    db: Session,
    user_id: UUID,
) -> User:
    """Return an active authenticated user with a valid role."""

    user = _require_active_user(db, user_id)

    if user.primary_role is None:
        raise _http_error(
            status.HTTP_403_FORBIDDEN,
            "The account has no assigned role.",
        )

    return user


def get_user_by_email(
    db: Session,
    email: str,
) -> User | None:
    """Find a user by case-insensitive email address."""

    normalized = _normalize_email(email)

    return db.scalar(
        _user_query().where(
            func.lower(User.email) == normalized
        )
    )


def authenticate_user(
    db: Session,
    *,
    email: str,
    password: str,
) -> User:
    """
    Verify credentials and return an active user.

    Incorrect credentials, inactive accounts, and accounts without
    a valid assigned role receive the same generic failure message.
    """

    if not isinstance(email, str) or not isinstance(password, str):
        raise _http_error(
            status.HTTP_401_UNAUTHORIZED,
            AUTHENTICATION_ERROR,
        )

    normalized_email = email.strip().lower()

    user = db.scalar(
        _user_query().where(
            func.lower(User.email) == normalized_email
        )
    )

    if user is None:
        raise _http_error(
            status.HTTP_401_UNAUTHORIZED,
            AUTHENTICATION_ERROR,
        )

    if not verify_password(
        password,
        user.password_hash,
    ):
        raise _http_error(
            status.HTTP_401_UNAUTHORIZED,
            AUTHENTICATION_ERROR,
        )

    if not user.is_active or user.primary_role is None:
        raise _http_error(
            status.HTTP_401_UNAUTHORIZED,
            AUTHENTICATION_ERROR,
        )

    if user.primary_role.role_name not in USER_ROLE_NAMES:
        raise _http_error(
            status.HTTP_401_UNAUTHORIZED,
            AUTHENTICATION_ERROR,
        )

    return user


def login(
    db: Session,
    *,
    email: str,
    password: str,
) -> tuple[User, str]:
    """
    Authenticate credentials and issue a signed access token.

    Token verification and expiry enforcement are performed by
    the existing security dependency on subsequent requests.
    """

    user = authenticate_user(
        db,
        email=email,
        password=password,
    )

    access_token = create_access_token(
        subject=user.user_id
    )

    return user, access_token


def list_roles(db: Session) -> list[Role]:
    """Return the approved application roles."""

    return list(
        db.scalars(
            select(Role)
            .where(Role.role_name.in_(USER_ROLE_NAMES))
            .order_by(Role.role_name)
        ).all()
    )


def list_users(
    db: Session,
    *,
    actor_id: UUID,
    page: int = 1,
    page_size: int = 50,
    include_inactive: bool = True,
) -> tuple[list[User], int]:
    """
    List user accounts for an authorized Factory Admin.

    Returns the selected page and the total matching record count.
    """

    _require_factory_admin(db, actor_id)

    if (
        isinstance(page, bool)
        or not isinstance(page, int)
        or page < 1
    ):
        raise _http_error(
            VALIDATION_ERROR_STATUS,
            "Page must be a positive integer.",
        )

    if (
        isinstance(page_size, bool)
        or not isinstance(page_size, int)
        or not 1 <= page_size <= 500
    ):
        raise _http_error(
            VALIDATION_ERROR_STATUS,
            "Page size must be between 1 and 500.",
        )

    filters = []

    if not include_inactive:
        filters.append(User.is_active.is_(True))

    total = db.scalar(
        select(func.count())
        .select_from(User)
        .where(*filters)
    ) or 0

    users = list(
        db.scalars(
            _user_query()
            .where(*filters)
            .order_by(
                User.full_name,
                User.user_id,
            )
            .offset((page - 1) * page_size)
            .limit(page_size)
        ).all()
    )

    return users, total


def create_user(
    db: Session,
    *,
    actor_id: UUID,
    full_name: str,
    email: str,
    password: str,
    role_id: UUID,
    phone: str | None = None,
) -> User:
    """
    Create a user and their primary role assignment.

    The caller must commit the new account, role assignment, and
    audit entry in one transaction.
    """

    _require_factory_admin(db, actor_id)

    normalized_name = _normalize_name(full_name)
    normalized_email = _normalize_email(email)
    normalized_phone = _normalize_phone(phone)
    validated_password = _validate_password(password)
    role = _require_role(db, role_id)

    existing_user_id = db.scalar(
        select(User.user_id).where(
            func.lower(User.email) == normalized_email
        )
    )

    if existing_user_id is not None:
        raise _http_error(
            status.HTTP_409_CONFLICT,
            "An account with this email already exists.",
        )

    user = User(
        full_name=normalized_name,
        email=normalized_email,
        password_hash=hash_password(validated_password),
        phone=normalized_phone,
        is_active=True,
    )

    user.role_assignment = UserRole(role=role)

    db.add(user)
    db.flush()

    create_audit_log(
        db,
        user_id=actor_id,
        entity_type="User",
        entity_id=user.user_id,
        action="USER_CREATED",
        new_values={
            "full_name": user.full_name,
            "email": user.email,
            "phone": user.phone,
            "is_active": user.is_active,
            "role_id": str(role.role_id),
            "role_name": role.role_name,
        },
    )

    return user


def update_user(
    db: Session,
    *,
    actor_id: UUID,
    user_id: UUID,
    full_name: str | None = None,
    email: str | None = None,
    phone: str | None = None,
    update_phone: bool = False,
) -> User:
    """
    Update permitted user profile fields.

    Set update_phone=True to explicitly update or clear the phone.
    Passwords, roles, and account status use separate operations.
    """

    _require_factory_admin(db, actor_id)

    user = _require_existing_user(
        db,
        user_id,
        lock=True,
    )

    if (
        full_name is None
        and email is None
        and not update_phone
    ):
        raise _http_error(
            VALIDATION_ERROR_STATUS,
            "At least one user field must be provided.",
        )

    old_values = {
        "full_name": user.full_name,
        "email": user.email,
        "phone": user.phone,
    }

    if full_name is not None:
        user.full_name = _normalize_name(full_name)

    if email is not None:
        normalized_email = _normalize_email(email)

        duplicate_id = db.scalar(
            select(User.user_id).where(
                func.lower(User.email) == normalized_email,
                User.user_id != user.user_id,
            )
        )

        if duplicate_id is not None:
            raise _http_error(
                status.HTTP_409_CONFLICT,
                "An account with this email already exists.",
            )

        user.email = normalized_email

    if update_phone:
        user.phone = _normalize_phone(phone)

    new_values = {
        "full_name": user.full_name,
        "email": user.email,
        "phone": user.phone,
    }

    if old_values != new_values:
        create_audit_log(
            db,
            user_id=actor_id,
            entity_type="User",
            entity_id=user.user_id,
            action="USER_UPDATED",
            old_values=old_values,
            new_values=new_values,
        )

    db.flush()

    return user


def assign_user_role(
    db: Session,
    *,
    actor_id: UUID,
    user_id: UUID,
    role_id: UUID,
) -> User:
    """
    Replace a user's single primary role assignment.

    The operation preserves the existing UserRole record when
    present and records the previous and new role identifiers.
    """

    _require_factory_admin(db, actor_id)

    user = _require_existing_user(
        db,
        user_id,
        lock=True,
    )
    role = _require_role(db, role_id)

    assignment = user.role_assignment

    previous_role_id = (
        assignment.role_id
        if assignment is not None
        else None
    )

    if previous_role_id == role.role_id:
        return user

    if user.user_id == actor_id:
        if role.role_name != FACTORY_ADMIN_ROLE:
            raise _http_error(
                status.HTTP_409_CONFLICT,
                "An administrator cannot remove their own "
                "Factory Admin role.",
            )

    if assignment is None:
        assignment = UserRole(
            user_id=user.user_id,
            role_id=role.role_id,
        )
        db.add(assignment)
        user.role_assignment = assignment
    else:
        assignment.role_id = role.role_id
        assignment.role = role

    db.flush()

    create_audit_log(
        db,
        user_id=actor_id,
        entity_type="User",
        entity_id=user.user_id,
        action="USER_ROLE_CHANGED",
        old_values={
            "role_id": (
                str(previous_role_id)
                if previous_role_id is not None
                else None
            ),
        },
        new_values={
            "role_id": str(role.role_id),
            "role_name": role.role_name,
        },
    )

    return user


def set_user_active_status(
    db: Session,
    *,
    actor_id: UUID,
    user_id: UUID,
    is_active: bool,
) -> User:
    """
    Activate or deactivate a user without deleting their history.

    A Factory Admin cannot deactivate their own account.
    """

    _require_factory_admin(db, actor_id)

    user = _require_existing_user(
        db,
        user_id,
        lock=True,
    )

    if not isinstance(is_active, bool):
        raise _http_error(
            VALIDATION_ERROR_STATUS,
            "is_active must be a boolean.",
        )

    if user.user_id == actor_id and not is_active:
        raise _http_error(
            status.HTTP_409_CONFLICT,
            "An administrator cannot deactivate their own account.",
        )

    if user.is_active == is_active:
        return user

    previous_status = user.is_active
    user.is_active = is_active

    create_audit_log(
        db,
        user_id=actor_id,
        entity_type="User",
        entity_id=user.user_id,
        action=(
            "USER_ACTIVATED"
            if is_active
            else "USER_DEACTIVATED"
        ),
        old_values={
            "is_active": previous_status,
        },
        new_values={
            "is_active": is_active,
        },
    )

    db.flush()

    return user


def change_password(
    db: Session,
    *,
    user_id: UUID,
    current_password: str,
    new_password: str,
) -> None:
    """
    Change the authenticated user's password.

    The current password is mandatory. Neither plaintext
    passwords nor password hashes are included in audit data.
    """

    user = _require_active_user(db, user_id)

    if not verify_password(
        current_password,
        user.password_hash,
    ):
        raise _http_error(
            status.HTTP_400_BAD_REQUEST,
            "Current password is incorrect.",
        )

    validated_password = _validate_password(new_password)

    if verify_password(
        validated_password,
        user.password_hash,
    ):
        raise _http_error(
            status.HTTP_400_BAD_REQUEST,
            "The new password must differ from the current password.",
        )

    user.password_hash = hash_password(validated_password)

    create_audit_log(
        db,
        user_id=user.user_id,
        entity_type="User",
        entity_id=user.user_id,
        action="PASSWORD_CHANGED",
        new_values={
            "password_changed": True,
        },
    )

    db.flush()


def reset_user_password(
    db: Session,
    *,
    actor_id: UUID,
    user_id: UUID,
    new_password: str,
    allow_demo_password: bool = False,
) -> None:
    """
    Perform an authorized administrative password reset.

    The password itself and its hash are never written to the
    audit record.
    """

    _require_factory_admin(db, actor_id)

    user = _require_existing_user(
        db,
        user_id,
        lock=True,
    )

    from app.core.demo_accounts import DEMO_ACCOUNTS

    is_demo_account = any(
        user.email.casefold() == account.email.casefold()
        for account in DEMO_ACCOUNTS
    )
    validated_password = _validate_password(
        new_password,
        allow_demo_password=(allow_demo_password and is_demo_account),
    )

    if verify_password(
        validated_password,
        user.password_hash,
    ):
        raise _http_error(
            status.HTTP_400_BAD_REQUEST,
            "The replacement password must differ "
            "from the current password.",
        )

    user.password_hash = hash_password(validated_password)

    create_audit_log(
        db,
        user_id=actor_id,
        entity_type="User",
        entity_id=user.user_id,
        action="PASSWORD_RESET",
        new_values={
            "password_reset": True,
        },
    )

    db.flush()


def require_user_role(
    db: Session,
    *,
    user_id: UUID,
    allowed_roles: Sequence[str],
) -> User:
    """
    Enforce an explicit allowlist of application roles.

    This helper is suitable for service-level authorization.
    Resource ownership and transaction-specific permissions must
    additionally be checked by the relevant business service.
    """

    user = _require_active_user(db, user_id)
    role = user.primary_role

    if not allowed_roles:
        raise _http_error(
            status.HTTP_403_FORBIDDEN,
            "Access denied.",
        )

    if (
        role is None
        or role.role_name not in USER_ROLE_NAMES
        or role.role_name not in allowed_roles
    ):
        raise _http_error(
            status.HTTP_403_FORBIDDEN,
            "You do not have permission to perform this operation.",
        )

    return user
