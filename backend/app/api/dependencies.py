"""
Shared FastAPI dependencies for database access, authentication,
role-based authorization, and transaction management.

JWT creation and decoding are centralized in app.core.security.
The database remains authoritative for account activation and roles.

Business services perform validation, stock posting, financial
calculations, and audit logging. Request handlers are responsible
for committing successful write transactions.

No database schema changes are performed by this module.
"""

from __future__ import annotations

from collections.abc import Callable, Generator, Sequence
from typing import Annotated
from uuid import UUID

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import decode_access_token
from app.models.user import User
from app.services.auth_service import get_current_user


# ---------------------------------------------------------------------------
# Database dependency
# ---------------------------------------------------------------------------

DBSession = Annotated[Session, Depends(get_db)]


def get_transactional_db() -> Generator[Session, None, None]:
    """
    Provide a request-scoped session that commits on success.

    If the request handler or a business service raises an exception,
    all uncommitted changes are rolled back.

    The commit occurs before the dependency finishes. Database errors
    therefore propagate rather than being silently ignored.

    Use this dependency for endpoints that modify business records.
    Read-only endpoints should use DBSession instead.

    Do not combine this dependency with another independent database
    session in the same business transaction.
    """

    session_generator = get_db()
    db = next(session_generator)

    try:
        yield db
        db.commit()
    except BaseException:
        db.rollback()
        raise
    finally:
        session_generator.close()


TransactionalDBSession = Annotated[
    Session,
    Depends(get_transactional_db),
]


# ---------------------------------------------------------------------------
# Authentication
# ---------------------------------------------------------------------------

bearer_scheme = HTTPBearer(
    scheme_name="BearerAuthentication",
    description="JWT access token issued by the login endpoint.",
    auto_error=False,
)


def _authentication_error() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate authentication credentials.",
        headers={"WWW-Authenticate": "Bearer"},
    )


def _authorization_error(
    detail: str = "Insufficient permissions.",
) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail=detail,
    )


def get_authenticated_user(
    db: DBSession,
    credentials: Annotated[
        HTTPAuthorizationCredentials | None,
        Depends(bearer_scheme),
    ],
) -> User:
    """
    Resolve the active user represented by a valid bearer token.

    JWT signature, expiration, issued-at time, token type, and
    subject are validated by app.core.security.decode_access_token.

    Inactive users, deleted users, and users without an assigned
    role are denied access even when their JWT has not expired.
    """

    if credentials is None:
        raise _authentication_error()

    if credentials.scheme.lower() != "bearer":
        raise _authentication_error()

    user_id = decode_access_token(credentials.credentials)

    try:
        user = get_current_user(db, user_id)
    except HTTPException as exc:
        if exc.status_code in (
            status.HTTP_401_UNAUTHORIZED,
            status.HTTP_403_FORBIDDEN,
            status.HTTP_404_NOT_FOUND,
        ):
            raise _authentication_error() from exc

        raise

    if user is None or not user.is_active:
        raise _authentication_error()

    if user.primary_role is None:
        raise _authentication_error()

    return user


CurrentUser = Annotated[
    User,
    Depends(get_authenticated_user),
]


def get_current_user_id(
    current_user: CurrentUser,
) -> UUID:
    """Return the verified user ID for business-service calls."""

    return current_user.user_id


CurrentUserId = Annotated[
    UUID,
    Depends(get_current_user_id),
]


# ---------------------------------------------------------------------------
# Role authorization
# ---------------------------------------------------------------------------

ROLE_SALESMAN = "Salesman"
ROLE_FACTORY_ADMIN = "Factory Admin"
ROLE_PRODUCTION_SUPERVISOR = "Production Supervisor"
ROLE_ACCOUNTANT_AUDITOR = "Accountant/Auditor"
ROLE_OWNER = "Owner"

ALL_APPLICATION_ROLES = frozenset(
    {
        ROLE_SALESMAN,
        ROLE_FACTORY_ADMIN,
        ROLE_PRODUCTION_SUPERVISOR,
        ROLE_ACCOUNTANT_AUDITOR,
        ROLE_OWNER,
    }
)

READ_ONLY_ROLES = frozenset(
    {
        ROLE_ACCOUNTANT_AUDITOR,
        ROLE_OWNER,
    }
)


def get_user_role_name(user: User) -> str:
    """
    Return the role name from the current database-backed assignment.

    A missing or unrecognized role is not treated as an administrator.
    """

    role = user.primary_role

    if role is None:
        raise _authorization_error(
            "The user does not have an assigned role."
        )

    role_name = role.role_name

    if role_name not in ALL_APPLICATION_ROLES:
        raise _authorization_error(
            "The user has an unsupported application role."
        )

    return role_name


def require_roles(
    *allowed_roles: str,
) -> Callable[..., User]:
    """
    Construct a reusable FastAPI role dependency.

    Example:
        admin_user: Annotated[
            User,
            Depends(require_roles("Factory Admin")),
        ]

    The returned dependency validates the current database role
    on every request.
    """

    if not allowed_roles:
        raise ValueError(
            "At least one permitted role must be specified."
        )

    invalid_roles = set(allowed_roles) - ALL_APPLICATION_ROLES

    if invalid_roles:
        raise ValueError(
            "Unsupported role names: "
            + ", ".join(sorted(invalid_roles))
        )

    permitted = frozenset(allowed_roles)

    def role_dependency(
        current_user: CurrentUser,
    ) -> User:
        role_name = get_user_role_name(current_user)

        if role_name not in permitted:
            raise _authorization_error(
                "Your role does not permit this operation."
            )

        return current_user

    return role_dependency


def require_any_role(
    current_user: CurrentUser,
) -> User:
    """Allow any recognized, active application user."""

    get_user_role_name(current_user)
    return current_user


def require_write_access(
    current_user: CurrentUser,
) -> User:
    """
    Deny general write access to Accountant/Auditor and Owner.

    Individual business endpoints must additionally enforce their
    specific role permissions. This dependency alone does not
    authorize a particular inventory or financial operation.
    """

    role_name = get_user_role_name(current_user)

    if role_name in READ_ONLY_ROLES:
        raise _authorization_error(
            "This role has read-only access."
        )

    return current_user


def require_factory_admin(
    current_user: CurrentUser,
) -> User:
    """Authorize operations reserved for the Factory Admin."""

    if get_user_role_name(current_user) != ROLE_FACTORY_ADMIN:
        raise _authorization_error(
            "Factory Admin permission is required."
        )

    return current_user


def require_salesman(
    current_user: CurrentUser,
) -> User:
    """Authorize Salesman-only operations, including offline sync."""

    if get_user_role_name(current_user) != ROLE_SALESMAN:
        raise _authorization_error(
            "Salesman permission is required."
        )

    return current_user


def require_production_operator(
    current_user: CurrentUser,
) -> User:
    """Authorize Factory Admin and Production Supervisor operations."""

    if get_user_role_name(current_user) not in {
        ROLE_FACTORY_ADMIN,
        ROLE_PRODUCTION_SUPERVISOR,
    }:
        raise _authorization_error(
            "Production operation permission is required."
        )

    return current_user


def require_reporting_access(
    current_user: CurrentUser,
) -> User:
    """Authorize Factory Admin, Accountant/Auditor, and Owner reports."""

    if get_user_role_name(current_user) not in {
        ROLE_FACTORY_ADMIN,
        ROLE_ACCOUNTANT_AUDITOR,
        ROLE_OWNER,
    }:
        raise _authorization_error(
            "Reporting permission is required."
        )

    return current_user


def ensure_role(
    user: User,
    allowed_roles: Sequence[str],
) -> User:
    """
    Perform role validation inside a route or helper.

    This is useful when permission requirements depend on an
    operation's runtime context rather than a static dependency.
    """

    if not allowed_roles:
        raise ValueError(
            "At least one allowed role is required."
        )

    role_name = get_user_role_name(user)

    if role_name not in allowed_roles:
        raise _authorization_error(
            "Your role does not permit this operation."
        )

    return user


# ---------------------------------------------------------------------------
# Common typed dependencies
# ---------------------------------------------------------------------------

FactoryAdminUser = Annotated[
    User,
    Depends(require_factory_admin),
]

SalesmanUser = Annotated[
    User,
    Depends(require_salesman),
]

ProductionOperatorUser = Annotated[
    User,
    Depends(require_production_operator),
]

ReportingUser = Annotated[
    User,
    Depends(require_reporting_access),
]

WriteAccessUser = Annotated[
    User,
    Depends(require_write_access),
]

AnyRoleUser = Annotated[
    User,
    Depends(require_any_role),
]