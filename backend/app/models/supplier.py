"""
Supplier master data for purchasing and goods receipt workflows.

Supplier records are deactivated rather than deleted to preserve
historical purchasing references and auditability.
"""

from __future__ import annotations

import uuid

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Index,
    String,
    Text,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class Supplier(Base):
    """Supplier master record used by purchase orders."""

    __tablename__ = "suppliers"

    __table_args__ = (
        CheckConstraint(
            "length(btrim(supplier_name)) > 0",
            name="supplier_name_not_blank",
        ),
        Index(
            "ix_suppliers_supplier_name",
            "supplier_name",
        ),
    )

    supplier_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        nullable=False,
    )

    supplier_name: Mapped[str] = mapped_column(
        String(200),
        nullable=False,
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

    address: Mapped[str | None] = mapped_column(
        Text,
        nullable=True,
    )

    is_active: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=True,
        server_default=text("true"),
    )

    def __repr__(self) -> str:
        return (
            f"Supplier(supplier_id={self.supplier_id!r}, "
            f"supplier_name={self.supplier_name!r}, "
            f"is_active={self.is_active!r})"
        )