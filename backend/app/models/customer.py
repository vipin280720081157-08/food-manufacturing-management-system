"""
Customer master data and assigned Salesman relationships.

Customer records retain billing, shipping, GST, and payment
information. Transaction history must be preserved by
deactivating customers rather than permanently deleting them.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base

if TYPE_CHECKING:
    from app.models.user import User


class Customer(Base):
    """Customer master record used by sales and receivables."""

    __tablename__ = "customers"

    __table_args__ = (
        CheckConstraint(
            "payment_terms_days >= 0",
            name="payment_terms_days_nonnegative",
        ),
        CheckConstraint(
            "length(btrim(customer_name)) > 0",
            name="customer_name_not_blank",
        ),
        Index(
            "ix_customers_customer_name",
            "customer_name",
        ),
        Index(
            "ix_customers_assigned_salesman_id",
            "assigned_salesman_id",
        ),
    )

    customer_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        nullable=False,
    )

    customer_name: Mapped[str] = mapped_column(
        String(200),
        nullable=False,
    )

    customer_type: Mapped[str | None] = mapped_column(
        String(50),
        nullable=True,
    )

    gstin: Mapped[str | None] = mapped_column(
        String(15),
        nullable=True,
    )

    phone: Mapped[str | None] = mapped_column(
        String(30),
        nullable=True,
    )

    email: Mapped[str | None] = mapped_column(
        String(255),
        nullable=True,
    )

    billing_address: Mapped[str | None] = mapped_column(
        Text,
        nullable=True,
    )

    shipping_address: Mapped[str | None] = mapped_column(
        Text,
        nullable=True,
    )

    state: Mapped[str | None] = mapped_column(
        String(100),
        nullable=True,
    )

    payment_terms_days: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        default=0,
        server_default=text("0"),
    )

    assigned_salesman_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "users.user_id",
            ondelete="RESTRICT",
        ),
        nullable=False,
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

    assigned_salesman: Mapped[User] = relationship(
        "User",
        foreign_keys=[assigned_salesman_id],
        lazy="selectin",
    )

    def __repr__(self) -> str:
        return (
            f"Customer(customer_id={self.customer_id!r}, "
            f"customer_name={self.customer_name!r}, "
            f"assigned_salesman_id={self.assigned_salesman_id!r}, "
            f"is_active={self.is_active!r})"
        )