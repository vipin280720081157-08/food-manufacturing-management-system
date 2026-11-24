
"""
Pydantic request and response schemas for authentication and user accounts.

These schemas correspond to the verified Development 03A User, Role,
and UserRole SQLAlchemy models.

Passwords and password hashes are excluded from public user responses.
Role information is derived from the authenticated user's assigned
primary role rather than accepted as a login-time selection.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    EmailStr,
    Field,
    SecretStr,
    StringConstraints,
    field_validator,
    model_validator,
)


EmailValue = Annotated[
    EmailStr,
    Field(max_length=255),
]

PasswordValue = Annotated[
    SecretStr,
    Field(min_length=8, max_length=128),
]

FullNameValue = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        min_length=1,
        max_length=150,
    ),
]

PhoneValue = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        min_length=1,
        max_length=30,
    ),
]

RoleNameValue = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        min_length=1,
        max_length=100,
    ),
]


class AuthSchema(BaseModel):
    """Base configuration for authentication schemas."""

    model_config = ConfigDict(
        extra="forbid",
        str_strip_whitespace=True,
    )


class LoginRequest(AuthSchema):
    """Credentials submitted to the backend login endpoint."""

    email: EmailValue
    password: SecretStr = Field(
        ...,
        min_length=1,
    )

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        """Normalize email addresses for case-insensitive lookup."""

        return value.strip().lower()


class TokenResponse(AuthSchema):
    """Bearer access token returned after successful authentication."""

    access_token: str = Field(
        ...,
        min_length=1,
    )
    token_type: Literal["bearer"] = "bearer"
    expires_in: int = Field(
        ...,
        gt=0,
        description="Access-token lifetime in seconds.",
    )


class TokenPayload(AuthSchema):
    """Validated claims expected in an application access token."""

    sub: UUID
    type: Literal["access"] = "access"
    iat: int = Field(
        ...,
        ge=0,
    )
    exp: int = Field(
        ...,
        gt=0,
    )

    @model_validator(mode="after")
    def validate_expiration_order(self) -> TokenPayload:
        """Ensure expiration occurs after token issuance."""

        if self.exp <= self.iat:
            raise ValueError(
                "Token expiration must be later than issuance."
            )

        return self


class RoleResponse(AuthSchema):
    """Public representation of a system role."""

    model_config = ConfigDict(
        from_attributes=True,
        extra="forbid",
    )

    role_id: UUID
    role_name: RoleNameValue
    description: str | None = None


class UserResponse(AuthSchema):
    """Public user information without authentication secrets."""

    model_config = ConfigDict(
        from_attributes=True,
        extra="forbid",
    )

    user_id: UUID
    full_name: str
    email: EmailStr
    phone: str | None
    is_active: bool
    created_at: datetime


class AuthenticatedUserResponse(UserResponse):
    """
    User identity and assigned primary role.

    The role name must be obtained from User.primary_role
    by the authentication service.
    """

    role_id: UUID | None = None
    role_name: str | None = None


class LoginResponse(TokenResponse):
    """Successful login response containing a token and user identity."""

    user: AuthenticatedUserResponse


class CurrentUserResponse(AuthSchema):
    """Response returned when retrieving the authenticated session user."""

    user: AuthenticatedUserResponse


class UserCreate(AuthSchema):
    """
    Request to create an application user.

    The backend must authorize the operation, hash the password,
    and create the User and UserRole records transactionally.

    The requested role must refer to an existing Role record.
    """

    full_name: FullNameValue
    email: EmailValue
    password: PasswordValue
    phone: PhoneValue | None = None
    role_id: UUID
    is_active: bool = True

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        """Normalize email before duplicate-account validation."""

        return value.strip().lower()


class UserUpdate(AuthSchema):
    """
    Request to update editable user profile and account fields.

    Omitted fields are unchanged. Role assignment and password
    changes use their dedicated request schemas.
    """

    full_name: FullNameValue | None = None
    email: EmailValue | None = None
    phone: PhoneValue | None = None
    is_active: bool | None = None

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str | None) -> str | None:
        """Normalize an updated email address."""

        if value is None:
            return None

        return value.strip().lower()

    @model_validator(mode="after")
    def validate_update_fields(self) -> UserUpdate:
        """Reject explicit nulls for nonnullable user attributes."""

        for field_name in (
            "full_name",
            "email",
            "is_active",
        ):
            if (
                field_name in self.model_fields_set
                and getattr(self, field_name) is None
            ):
                raise ValueError(
                    f"{field_name} cannot be null."
                )

        if not self.model_fields_set:
            raise ValueError(
                "At least one user field must be provided."
            )

        return self


class UserRoleAssignmentRequest(AuthSchema):
    """Request to replace a user's single assigned primary role."""

    role_id: UUID


class UserStatusUpdateRequest(AuthSchema):
    """Request to activate or deactivate an existing account."""

    is_active: bool


class PasswordChangeRequest(AuthSchema):
    """Authenticated request to change the user's password."""

    current_password: SecretStr = Field(
        ...,
        min_length=1,
    )

    new_password: PasswordValue

    @model_validator(mode="after")
    def validate_password_change(self) -> PasswordChangeRequest:
        """Reject reuse of the supplied current password."""

        if (
            self.current_password.get_secret_value()
            == self.new_password.get_secret_value()
        ):
            raise ValueError(
                "New password must differ from current password."
            )

        return self


class PasswordResetRequest(AuthSchema):
    """
    Administrative request to set a new password for a user.

    The backend must verify administrative authorization and
    record the credential change in the audit trail.
    """

    new_password: PasswordValue


class PasswordOperationResponse(AuthSchema):
    """Generic response for a completed password operation."""

    message: str = Field(
        ...,
        min_length=1,
    )


class LogoutResponse(AuthSchema):
    """Response confirming termination of the current client session."""

    message: str = Field(
        default="Logged out successfully.",
        min_length=1,
    )


class UserListResponse(AuthSchema):
    """Paginated user listing for authorized administration screens."""

    items: list[AuthenticatedUserResponse]
    total: int = Field(
        ...,
        ge=0,
    )
    page: int = Field(
        ...,
        ge=1,
    )
    page_size: int = Field(
        ...,
        ge=1,
    )


class RoleListResponse(AuthSchema):
    """List of configured system roles."""

    items: list[RoleResponse]
