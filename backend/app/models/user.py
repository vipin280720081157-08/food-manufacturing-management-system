"""
User accounts, system roles, and user-role assignments.

Each user has one assigned primary role. Role-based permissions
are enforced by the backend authorization layer.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base

if TYPE_CHECKING:
    pass


class User(Base):
    """Application user account."""

    __tablename__ = "users"

    __table_args__ = (
        Index(
            "ix_users_email_lower",
            text("lower(email)"),
            unique=True,
        ),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        nullable=False,
    )

    full_name: Mapped[str] = mapped_column(
        String(150),
        nullable=False,
    )

    email: Mapped[str] = mapped_column(
        String(255),
        nullable=False,
    )

    password_hash: Mapped[str] = mapped_column(
        String(255),
        nullable=False,
    )

    phone: Mapped[str | None] = mapped_column(
        String(30),
        nullable=True,
    )

    is_active: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=True,
        server_default=text("true"),
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )

    role_assignment: Mapped[UserRole | None] = relationship(
        "UserRole",
        back_populates="user",
        uselist=False,
        cascade="save-update, merge",
        passive_deletes=True,
    )

    @property
    def primary_role(self) -> Role | None:
        """Return the user's assigned role, if available."""

        if self.role_assignment is None:
            return None

        return self.role_assignment.role

    def __repr__(self) -> str:
        return (
            f"User(user_id={self.user_id!r}, "
            f"email={self.email!r}, "
            f"is_active={self.is_active!r})"
        )


class Role(Base):
    """System role used for backend authorization."""

    __tablename__ = "roles"

    role_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        nullable=False,
    )

    role_name: Mapped[str] = mapped_column(
        String(100),
        nullable=False,
        unique=True,
    )

    description: Mapped[str | None] = mapped_column(
        Text,
        nullable=True,
    )

    user_assignments: Mapped[list[UserRole]] = relationship(
        "UserRole",
        back_populates="role",
        passive_deletes=True,
    )

    def __repr__(self) -> str:
        return (
            f"Role(role_id={self.role_id!r}, "
            f"role_name={self.role_name!r})"
        )


class UserRole(Base):
    """
    Assignment of one primary role to one user.

    The unique constraint on user_id enforces the initial
    single-role policy at the database level.
    """

    __tablename__ = "user_roles"

    __table_args__ = (
        UniqueConstraint(
            "user_id",
            name="uq_user_roles_user_id",
        ),
    )

    user_role_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        nullable=False,
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "users.user_id",
            ondelete="RESTRICT",
        ),
        nullable=False,
    )

    role_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "roles.role_id",
            ondelete="RESTRICT",
        ),
        nullable=False,
        index=True,
    )

    user: Mapped[User] = relationship(
        "User",
        back_populates="role_assignment",
    )

    role: Mapped[Role] = relationship(
        "Role",
        back_populates="user_assignments",
    )

    def __repr__(self) -> str:
        return (
            f"UserRole(user_role_id={self.user_role_id!r}, "
            f"user_id={self.user_id!r}, "
            f"role_id={self.role_id!r})"
        )
