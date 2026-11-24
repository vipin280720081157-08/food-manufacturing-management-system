"""Authentication and account management endpoints."""

from __future__ import annotations

from typing import Any
from uuid import UUID
import re
import ipaddress

from fastapi import APIRouter, HTTPException, Query, Request, Response, status
from urllib.parse import parse_qs

from app.api.dependencies import CurrentUser, DBSession, FactoryAdminUser, TransactionalDBSession
from app.core.config import settings
from app.core.demo_accounts import DEMO_ACCOUNTS, DEMO_ACCOUNT_BY_USERNAME, DEMO_PASSWORD
from app.models.user import User
from app.schemas.auth import LoginRequest, UserCreate, UserUpdate, UserRoleAssignmentRequest
from app.services import auth_service

router = APIRouter(prefix="/auth", tags=["Authentication"])
users_router = APIRouter(prefix="/users", tags=["Users"])


def _role_code(role_name: str | None) -> str:
    """Return the stable frontend role identifier for a DB role label."""
    return re.sub(r"[^a-z0-9]+", "_", (role_name or "").casefold()).strip("_")


def _loopback_client(request: Request) -> bool:
    host = request.client.host if request.client else ""
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return host.casefold() == "localhost"


def _demo_enabled_for_request(request: Request) -> bool:
    return settings.DEMO_MODE and settings.ENVIRONMENT != "production" and _loopback_client(request)


@router.get("/demo-options")
def demo_login_options(request: Request, response: Response) -> dict[str, Any]:
    """Expose evaluator credentials only to a loopback demo session."""
    response.headers["Cache-Control"] = "no-store"
    response.headers["Pragma"] = "no-cache"
    enabled = _demo_enabled_for_request(request)
    return {
        "enabled": enabled,
        "password": DEMO_PASSWORD if enabled else None,
        "accounts": (
            [{"username": account.username, "label": account.label, "role": account.role_code} for account in DEMO_ACCOUNTS]
            if enabled else []
        ),
    }


def _user_payload(user: User) -> dict[str, Any]:
    role = user.primary_role
    return {
        "id": str(user.user_id),
        "user_id": str(user.user_id),
        "username": user.email,
        "email": user.email,
        "full_name": user.full_name,
        "phone": user.phone,
        "role": _role_code(role.role_name if role else None),
        "role_id": str(role.role_id) if role else None,
        "is_active": user.is_active,
        "created_at": user.created_at,
    }


@router.post("/login")
async def login(
    db: DBSession,
    request: Request,
) -> dict[str, Any]:
    """Authenticate the username/email and return an access token."""
    form = parse_qs((await request.body()).decode())
    identifier = (form.get("username") or [""])[0].strip()
    account = DEMO_ACCOUNT_BY_USERNAME.get(identifier.casefold()) if _demo_enabled_for_request(request) else None
    # OAuth2PasswordRequestForm is used by the existing browser client.
    user, token = auth_service.login(
        db,
        email=account.email if account else identifier,
        password=(form.get("password") or [""])[0],
    )
    return {
        "access_token": token,
        "token_type": "bearer",
        "expires_in": settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        "user": _user_payload(user),
    }


@router.post("/login-json")
def login_json(payload: LoginRequest, db: DBSession) -> dict[str, Any]:
    user, token = auth_service.login(
        db,
        email=str(payload.email),
        password=payload.password.get_secret_value(),
    )
    return {
        "access_token": token,
        "token_type": "bearer",
        "expires_in": settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        "user": _user_payload(user),
    }


@router.get("/me")
def current_user(user: CurrentUser) -> dict[str, Any]:
    return _user_payload(user)


@router.post("/logout")
def logout(_user: CurrentUser) -> dict[str, str]:
    # Tokens are short-lived and held only in frontend memory. Logout
    # clears the client session; server-side credentials are unchanged.
    return {"message": "Logged out successfully."}


@router.post("/change-password")
def change_password(payload: dict[str, str], user: CurrentUser, db: TransactionalDBSession):
    auth_service.change_password(
        db,
        user_id=user.user_id,
        current_password=payload.get("current_password", ""),
        new_password=payload.get("new_password", ""),
    )
    return {"message": "Password changed successfully."}


@users_router.get("")
def list_users(
    _admin: FactoryAdminUser,
    db: DBSession,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    role: str | None = None,
    is_active: bool | None = None,
) -> dict[str, Any]:
    users, total = auth_service.list_users(
        db,
        actor_id=_admin.user_id,
        page=page,
        page_size=page_size,
        include_inactive=is_active is not True,
    )
    filtered = [u for u in users if role is None or _role_code(u.primary_role.role_name if u.primary_role else None) == role.casefold()]
    return {"items": [_user_payload(u) for u in filtered], "total": total, "page": page, "page_size": page_size}


@users_router.get("/roles")
def list_roles(_admin: FactoryAdminUser, db: DBSession) -> dict[str, Any]:
    return {"items": [{"role_id": str(r.role_id), "role_name": r.role_name, "description": r.description} for r in auth_service.list_roles(db)]}


@users_router.post("", status_code=status.HTTP_201_CREATED)
def create_user(payload: UserCreate, admin: FactoryAdminUser, db: TransactionalDBSession):
    user = auth_service.create_user(
        db,
        actor_id=admin.user_id,
        full_name=payload.full_name,
        email=str(payload.email),
        password=payload.password.get_secret_value(),
        role_id=payload.role_id,
        phone=payload.phone,
    )
    return _user_payload(user)


@users_router.get("/{user_id}")
def get_user(user_id: UUID, _admin: FactoryAdminUser, db: DBSession):
    user = auth_service.get_user(db, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found.")
    return _user_payload(user)


@users_router.patch("/{user_id}")
def update_user(user_id: UUID, payload: UserUpdate, admin: FactoryAdminUser, db: TransactionalDBSession):
    values = payload.model_dump(exclude_unset=True)
    user = auth_service.update_user(
        db,
        actor_id=admin.user_id,
        user_id=user_id,
        full_name=values.get("full_name"),
        email=str(values["email"]) if values.get("email") else None,
        phone=values.get("phone"),
        update_phone="phone" in values,
    )
    if "is_active" in values:
        user = auth_service.set_user_active_status(db, admin.user_id, user_id, values["is_active"])
    return _user_payload(user)


@users_router.put("/{user_id}/role")
def assign_role(user_id: UUID, payload: UserRoleAssignmentRequest, admin: FactoryAdminUser, db: TransactionalDBSession):
    user = auth_service.assign_user_role(db, admin.user_id, user_id, payload.role_id)
    return _user_payload(user)
