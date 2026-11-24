"""
Versioned bills of materials for finished-product manufacturing.

Each BOM defines standard material requirements, batch size,
and expected output. Historical BOM versions must be retained
for production costing and traceability.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, QUANTITY_TYPE
from app.models.product import InventoryItem, Product


class ProductBOM(Base):
    """Versioned manufacturing recipe for a finished product."""

    __tablename__ = "product_boms"

    __table_args__ = (
        UniqueConstraint(
            "product_id",
            "version",
            name="uq_product_boms_product_version",
        ),
        CheckConstraint(
            "version > 0",
            name="version_positive",
        ),
        CheckConstraint(
            "standard_batch_size > 0",
            name="standard_batch_size_positive",
        ),
        CheckConstraint(
            "expected_output > 0",
            name="expected_output_positive",
        ),
        CheckConstraint(
            "effective_to IS NULL "
            "OR effective_to >= effective_from",
            name="effective_dates_valid",
        ),
        Index(
            "ix_product_boms_product_active",
            "product_id",
            "is_active",
        ),
    )

    bom_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        nullable=False,
    )

    product_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "products.product_id",
            ondelete="RESTRICT",
        ),
        nullable=False,
    )

    version: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
    )

    standard_batch_size: Mapped[Decimal] = mapped_column(
        QUANTITY_TYPE,
        nullable=False,
    )

    expected_output: Mapped[Decimal] = mapped_column(
        QUANTITY_TYPE,
        nullable=False,
    )

    effective_from: Mapped[date] = mapped_column(
        Date,
        nullable=False,
    )

    effective_to: Mapped[date | None] = mapped_column(
        Date,
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

    product: Mapped[Product] = relationship(
        "Product",
        foreign_keys=[product_id],
        lazy="selectin",
    )

    items: Mapped[list[BOMItem]] = relationship(
        "BOMItem",
        back_populates="bom",
        cascade="save-update, merge",
        passive_deletes=True,
        order_by="BOMItem.bom_item_id",
    )

    def __repr__(self) -> str:
        return (
            f"ProductBOM(bom_id={self.bom_id!r}, "
            f"product_id={self.product_id!r}, "
            f"version={self.version!r}, "
            f"is_active={self.is_active!r})"
        )


class BOMItem(Base):
    """Standard raw-material or packaging requirement in a BOM."""

    __tablename__ = "bom_items"

    __table_args__ = (
        UniqueConstraint(
            "bom_id",
            "item_id",
            name="uq_bom_items_bom_item",
        ),
        CheckConstraint(
            "quantity_required > 0",
            name="quantity_required_positive",
        ),
        CheckConstraint(
            "length(btrim(unit)) > 0",
            name="unit_not_blank",
        ),
        Index(
            "ix_bom_items_item_id",
            "item_id",
        ),
    )

    bom_item_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        nullable=False,
    )

    bom_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "product_boms.bom_id",
            ondelete="RESTRICT",
        ),
        nullable=False,
    )

    item_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "inventory_items.item_id",
            ondelete="RESTRICT",
        ),
        nullable=False,
    )

    quantity_required: Mapped[Decimal] = mapped_column(
        QUANTITY_TYPE,
        nullable=False,
    )

    unit: Mapped[str] = mapped_column(
        String(30),
        nullable=False,
    )

    bom: Mapped[ProductBOM] = relationship(
        "ProductBOM",
        back_populates="items",
    )

    inventory_item: Mapped[InventoryItem] = relationship(
        "InventoryItem",
        foreign_keys=[item_id],
        lazy="selectin",
    )

    def __repr__(self) -> str:
        return (
            f"BOMItem(bom_item_id={self.bom_item_id!r}, "
            f"bom_id={self.bom_id!r}, "
            f"item_id={self.item_id!r}, "
            f"quantity_required={self.quantity_required!r})"
        )