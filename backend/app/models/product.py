"""
Inventory item masters, finished products, raw materials,
packaging materials, and unit conversions.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    String,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import (
    Base,
    MONEY_TYPE,
    QUANTITY_TYPE,
    TAX_RATE_TYPE,
)


class InventoryItem(Base):
    """Shared master record for every stockable item."""

    __tablename__ = "inventory_items"

    __table_args__ = (
        CheckConstraint(
            "length(btrim(item_name)) > 0",
            name="item_name_not_blank",
        ),
        CheckConstraint(
            "length(btrim(item_code)) > 0",
            name="item_code_not_blank",
        ),
        CheckConstraint(
            "length(btrim(base_unit)) > 0",
            name="base_unit_not_blank",
        ),
        CheckConstraint(
            "item_type IN ("
            "'FINISHED_PRODUCT', "
            "'RAW_MATERIAL', "
            "'PACKAGING_MATERIAL'"
            ")",
            name="valid_item_type",
        ),
        CheckConstraint(
            "reorder_level >= 0",
            name="reorder_level_nonnegative",
        ),
        Index(
            "ix_inventory_items_item_name",
            "item_name",
        ),
    )

    item_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        nullable=False,
    )

    item_name: Mapped[str] = mapped_column(
        String(200),
        nullable=False,
    )

    item_code: Mapped[str] = mapped_column(
        String(100),
        nullable=False,
        unique=True,
    )

    item_type: Mapped[str] = mapped_column(
        String(30),
        nullable=False,
    )

    base_unit: Mapped[str] = mapped_column(
        String(30),
        nullable=False,
    )

    reorder_level: Mapped[Decimal] = mapped_column(
        QUANTITY_TYPE,
        nullable=False,
        default=Decimal("0.000"),
        server_default=text("0"),
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

    product: Mapped[Product | None] = relationship(
        "Product",
        back_populates="inventory_item",
        uselist=False,
        cascade="save-update, merge",
        passive_deletes=True,
    )

    raw_material: Mapped[RawMaterial | None] = relationship(
        "RawMaterial",
        back_populates="inventory_item",
        uselist=False,
        cascade="save-update, merge",
        passive_deletes=True,
    )

    packaging_material: Mapped[PackagingMaterial | None] = relationship(
        "PackagingMaterial",
        back_populates="inventory_item",
        uselist=False,
        cascade="save-update, merge",
        passive_deletes=True,
    )

    def __repr__(self) -> str:
        return (
            f"InventoryItem(item_id={self.item_id!r}, "
            f"item_code={self.item_code!r}, "
            f"item_type={self.item_type!r})"
        )


class Product(Base):
    """Finished-product details and selling-price master."""

    __tablename__ = "products"

    __table_args__ = (
        CheckConstraint(
            "selling_price >= 0",
            name="selling_price_nonnegative",
        ),
        CheckConstraint(
            "gst_rate >= 0 AND gst_rate <= 100",
            name="gst_rate_valid",
        ),
        CheckConstraint(
            "pack_size > 0",
            name="pack_size_positive",
        ),
        CheckConstraint(
            "shelf_life_days IS NULL OR shelf_life_days >= 0",
            name="shelf_life_days_nonnegative",
        ),
        CheckConstraint(
            "length(btrim(pack_unit)) > 0",
            name="pack_unit_not_blank",
        ),
    )

    product_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "inventory_items.item_id",
            ondelete="RESTRICT",
        ),
        primary_key=True,
        nullable=False,
    )

    category: Mapped[str | None] = mapped_column(
        String(100),
        nullable=True,
    )

    selling_price: Mapped[Decimal] = mapped_column(
        MONEY_TYPE,
        nullable=False,
        default=Decimal("0.00"),
        server_default=text("0"),
    )

    gst_rate: Mapped[Decimal] = mapped_column(
        TAX_RATE_TYPE,
        nullable=False,
        default=Decimal("0.0000"),
        server_default=text("0"),
    )

    hsn_code: Mapped[str | None] = mapped_column(
        String(20),
        nullable=True,
    )

    pack_size: Mapped[Decimal] = mapped_column(
        QUANTITY_TYPE,
        nullable=False,
    )

    pack_unit: Mapped[str] = mapped_column(
        String(30),
        nullable=False,
    )

    shelf_life_days: Mapped[int | None] = mapped_column(
        nullable=True,
    )

    inventory_item: Mapped[InventoryItem] = relationship(
        "InventoryItem",
        back_populates="product",
    )

    def __repr__(self) -> str:
        return (
            f"Product(product_id={self.product_id!r}, "
            f"selling_price={self.selling_price!r}, "
            f"gst_rate={self.gst_rate!r})"
        )


class RawMaterial(Base):
    """Raw-material-specific classification and storage details."""

    __tablename__ = "raw_materials"

    material_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "inventory_items.item_id",
            ondelete="RESTRICT",
        ),
        primary_key=True,
        nullable=False,
    )

    material_category: Mapped[str | None] = mapped_column(
        String(100),
        nullable=True,
    )

    storage_type: Mapped[str | None] = mapped_column(
        String(100),
        nullable=True,
    )

    inventory_item: Mapped[InventoryItem] = relationship(
        "InventoryItem",
        back_populates="raw_material",
    )

    def __repr__(self) -> str:
        return (
            f"RawMaterial(material_id={self.material_id!r}, "
            f"material_category={self.material_category!r})"
        )


class PackagingMaterial(Base):
    """Packaging-material details and optional packet capacity."""

    __tablename__ = "packaging_materials"

    __table_args__ = (
        CheckConstraint(
            "capacity_packets IS NULL OR capacity_packets > 0",
            name="capacity_packets_positive",
        ),
    )

    packaging_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "inventory_items.item_id",
            ondelete="RESTRICT",
        ),
        primary_key=True,
        nullable=False,
    )

    packaging_type: Mapped[str | None] = mapped_column(
        String(100),
        nullable=True,
    )

    dimensions: Mapped[str | None] = mapped_column(
        String(150),
        nullable=True,
    )

    capacity_packets: Mapped[Decimal | None] = mapped_column(
        QUANTITY_TYPE,
        nullable=True,
    )

    inventory_item: Mapped[InventoryItem] = relationship(
        "InventoryItem",
        back_populates="packaging_material",
    )

    def __repr__(self) -> str:
        return (
            f"PackagingMaterial(packaging_id={self.packaging_id!r}, "
            f"packaging_type={self.packaging_type!r})"
        )


class UnitConversion(Base):
    """
    Approved conversion factor between compatible units.

    Conversion factors multiply a quantity expressed in
    from_unit to obtain the equivalent quantity in to_unit.
    """

    __tablename__ = "unit_conversions"

    __table_args__ = (
        UniqueConstraint(
            "from_unit",
            "to_unit",
            name="uq_unit_conversions_from_to",
        ),
        CheckConstraint(
            "conversion_factor > 0",
            name="conversion_factor_positive",
        ),
        CheckConstraint(
            "length(btrim(from_unit)) > 0",
            name="from_unit_not_blank",
        ),
        CheckConstraint(
            "length(btrim(to_unit)) > 0",
            name="to_unit_not_blank",
        ),
        CheckConstraint(
            "from_unit <> to_unit",
            name="different_units",
        ),
    )

    conversion_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        nullable=False,
    )

    from_unit: Mapped[str] = mapped_column(
        String(30),
        nullable=False,
    )

    to_unit: Mapped[str] = mapped_column(
        String(30),
        nullable=False,
    )

    conversion_factor: Mapped[Decimal] = mapped_column(
        QUANTITY_TYPE,
        nullable=False,
    )

    def __repr__(self) -> str:
        return (
            f"UnitConversion(from_unit={self.from_unit!r}, "
            f"to_unit={self.to_unit!r}, "
            f"conversion_factor={self.conversion_factor!r})"
        )