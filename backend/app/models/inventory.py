"""
Inventory batches, stock movements, stock balances, and adjustments.

The stock movement ledger preserves inventory history.
Inventory balances are transactional summaries and must be
updated atomically with posted stock movements.

Production-held inventory is tracked separately from
available warehouse inventory.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import TYPE_CHECKING

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import (
    Base,
    QUANTITY_TYPE,
    UNIT_COST_TYPE,
)

if TYPE_CHECKING:
    from app.models.product import InventoryItem
    from app.models.user import User


class StockBatch(Base):
    """Traceable inventory batch originating from a posted transaction."""

    __tablename__ = "stock_batches"

    __table_args__ = (
        CheckConstraint(
            "length(btrim(batch_number)) > 0",
            name="batch_number_not_blank",
        ),
        CheckConstraint(
            "length(btrim(source_type)) > 0",
            name="source_type_not_blank",
        ),
        CheckConstraint(
            "initial_quantity > 0",
            name="initial_quantity_positive",
        ),
        CheckConstraint(
            "quantity_remaining >= 0",
            name="quantity_remaining_nonnegative",
        ),
        CheckConstraint(
            "quantity_remaining <= initial_quantity",
            name="quantity_remaining_within_initial",
        ),
        CheckConstraint(
            "unit_cost >= 0",
            name="unit_cost_nonnegative",
        ),
        CheckConstraint(
            "expiry_date IS NULL "
            "OR manufacturing_date IS NULL "
            "OR expiry_date >= manufacturing_date",
            name="expiry_date_valid",
        ),
        UniqueConstraint(
            "item_id",
            "batch_number",
            name="uq_stock_batches_item_batch",
        ),
        Index(
            "ix_stock_batches_item_id",
            "item_id",
        ),
        Index(
            "ix_stock_batches_source",
            "source_type",
            "source_id",
        ),
        Index(
            "ix_stock_batches_expiry_date",
            "expiry_date",
        ),
    )

    batch_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
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

    batch_number: Mapped[str] = mapped_column(
        String(100),
        nullable=False,
    )

    source_type: Mapped[str] = mapped_column(
        String(50),
        nullable=False,
    )

    source_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        nullable=False,
    )

    initial_quantity: Mapped[Decimal] = mapped_column(
        QUANTITY_TYPE,
        nullable=False,
    )

    quantity_remaining: Mapped[Decimal] = mapped_column(
        QUANTITY_TYPE,
        nullable=False,
    )

    unit_cost: Mapped[Decimal] = mapped_column(
        UNIT_COST_TYPE,
        nullable=False,
    )

    manufacturing_date: Mapped[date | None] = mapped_column(
        Date,
        nullable=True,
    )

    expiry_date: Mapped[date | None] = mapped_column(
        Date,
        nullable=True,
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )

    inventory_item: Mapped[InventoryItem] = relationship(
        "InventoryItem",
        foreign_keys=[item_id],
        lazy="selectin",
    )

    movements: Mapped[list[StockMovement]] = relationship(
        "StockMovement",
        back_populates="batch",
        passive_deletes=True,
    )

    def __repr__(self) -> str:
        return (
            f"StockBatch(batch_id={self.batch_id!r}, "
            f"item_id={self.item_id!r}, "
            f"batch_number={self.batch_number!r}, "
            f"quantity_remaining={self.quantity_remaining!r})"
        )


class StockMovement(Base):
    """
    Immutable historical record of a posted inventory movement.

    Corrections must be represented by new reversal or
    adjustment movements, not by rewriting posted records.

    The service layer validates source_type and source_id
    against the permitted originating transaction.
    """

    __tablename__ = "stock_movements"

    __table_args__ = (
        CheckConstraint(
            "movement_type IN ("
            "'OPENING_BALANCE', "
            "'PURCHASE_RECEIPT', "
            "'PRODUCTION_ISSUE', "
            "'PRODUCTION_CONSUMPTION', "
            "'UNUSED_MATERIAL_RETURN', "
            "'PRODUCTION_WASTAGE', "
            "'PRODUCTION_OUTPUT', "
            "'DISPATCH', "
            "'STOCK_ADJUSTMENT', "
            "'REVERSAL'"
            ")",
            name="valid_movement_type",
        ),
        CheckConstraint(
            "direction IN ('IN', 'OUT')",
            name="valid_direction",
        ),
        CheckConstraint(
            "quantity > 0",
            name="quantity_positive",
        ),
        CheckConstraint(
            "unit_cost >= 0",
            name="unit_cost_nonnegative",
        ),
        CheckConstraint(
            "length(btrim(source_type)) > 0",
            name="source_type_not_blank",
        ),
        CheckConstraint(
            "length(btrim(location)) > 0",
            name="location_not_blank",
        ),
        CheckConstraint(
            "movement_type <> 'REVERSAL' "
            "OR reversal_of_id IS NOT NULL",
            name="reversal_requires_original",
        ),
        CheckConstraint(
            "reversal_of_id IS NULL "
            "OR reversal_of_id <> movement_id",
            name="cannot_reverse_self",
        ),
        UniqueConstraint(
            "reversal_of_id",
            name="uq_stock_movements_reversal_of_id",
        ),
        UniqueConstraint(
            "source_type",
            "source_id",
            "source_line_id",
            "movement_type",
            "location",
            "direction",
            name="uq_stock_movements_source_line_action",
        ),
        Index(
            "ix_stock_movements_item_created",
            "item_id",
            "created_at",
        ),
        Index(
            "ix_stock_movements_batch_id",
            "batch_id",
        ),
        Index(
            "ix_stock_movements_source",
            "source_type",
            "source_id",
        ),
        Index(
            "ix_stock_movements_movement_type",
            "movement_type",
        ),
    )

    movement_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
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

    batch_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "stock_batches.batch_id",
            ondelete="RESTRICT",
        ),
        nullable=True,
    )

    movement_type: Mapped[str] = mapped_column(
        String(40),
        nullable=False,
    )

    direction: Mapped[str] = mapped_column(
        String(3),
        nullable=False,
    )

    location: Mapped[str] = mapped_column(
        String(50),
        nullable=False,
    )

    quantity: Mapped[Decimal] = mapped_column(
        QUANTITY_TYPE,
        nullable=False,
    )

    unit_cost: Mapped[Decimal] = mapped_column(
        UNIT_COST_TYPE,
        nullable=False,
    )

    source_type: Mapped[str] = mapped_column(
        String(50),
        nullable=False,
    )

    source_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        nullable=False,
    )

    source_line_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        nullable=False,
    )

    reversal_of_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "stock_movements.movement_id",
            ondelete="RESTRICT",
        ),
        nullable=True,
    )

    created_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "users.user_id",
            ondelete="RESTRICT",
        ),
        nullable=False,
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )

    inventory_item: Mapped[InventoryItem] = relationship(
        "InventoryItem",
        foreign_keys=[item_id],
        lazy="selectin",
    )

    batch: Mapped[StockBatch | None] = relationship(
        "StockBatch",
        back_populates="movements",
    )

    creator: Mapped[User] = relationship(
        "User",
        foreign_keys=[created_by],
        lazy="selectin",
    )

    original_movement: Mapped[StockMovement | None] = relationship(
        "StockMovement",
        remote_side=[movement_id],
        foreign_keys=[reversal_of_id],
        uselist=False,
    )

    def __repr__(self) -> str:
        return (
            f"StockMovement(movement_id={self.movement_id!r}, "
            f"item_id={self.item_id!r}, "
            f"movement_type={self.movement_type!r}, "
            f"direction={self.direction!r}, "
            f"quantity={self.quantity!r})"
        )


class InventoryBalance(Base):
    """
    Transactional inventory balance by item and location.

    WAREHOUSE represents available stock.
    PRODUCTION_HELD represents materials issued to production.

    Moving weighted-average cost is maintained per item.
    All balance updates must use row-level locking and occur
    in the same transaction as the related stock movements.
    """

    __tablename__ = "inventory_balances"

    __table_args__ = (
        UniqueConstraint(
            "item_id",
            "location",
            name="uq_inventory_balances_item_location",
        ),
        CheckConstraint(
            "location IN ('WAREHOUSE', 'PRODUCTION_HELD')",
            name="valid_location",
        ),
        CheckConstraint(
            "quantity_on_hand >= 0",
            name="quantity_on_hand_nonnegative",
        ),
        CheckConstraint(
            "average_unit_cost >= 0",
            name="average_unit_cost_nonnegative",
        ),
    )

    balance_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
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

    location: Mapped[str] = mapped_column(
        String(50),
        nullable=False,
        default="WAREHOUSE",
        server_default=text("'WAREHOUSE'"),
    )

    quantity_on_hand: Mapped[Decimal] = mapped_column(
        QUANTITY_TYPE,
        nullable=False,
        default=Decimal("0.000"),
        server_default=text("0"),
    )

    average_unit_cost: Mapped[Decimal] = mapped_column(
        UNIT_COST_TYPE,
        nullable=False,
        default=Decimal("0.000000"),
        server_default=text("0"),
    )

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    inventory_item: Mapped[InventoryItem] = relationship(
        "InventoryItem",
        foreign_keys=[item_id],
        lazy="selectin",
    )

    def __repr__(self) -> str:
        return (
            f"InventoryBalance(balance_id={self.balance_id!r}, "
            f"item_id={self.item_id!r}, "
            f"location={self.location!r}, "
            f"quantity_on_hand={self.quantity_on_hand!r})"
        )


class StockAdjustment(Base):
    """
    Authorized inventory adjustment request.

    Posting creates stock movements rather than directly
    overwriting historical ledger records.
    """

    __tablename__ = "stock_adjustments"

    __table_args__ = (
        CheckConstraint(
            "length(btrim(adjustment_number)) > 0",
            name="adjustment_number_not_blank",
        ),
        CheckConstraint(
            "length(btrim(reason)) > 0",
            name="reason_not_blank",
        ),
        CheckConstraint(
            "status IN ("
            "'DRAFT', "
            "'SUBMITTED', "
            "'APPROVED', "
            "'REJECTED', "
            "'POSTED', "
            "'CANCELLED'"
            ")",
            name="valid_status",
        ),
        CheckConstraint(
            "status <> 'POSTED' OR posted_at IS NOT NULL",
            name="posted_requires_timestamp",
        ),
        CheckConstraint(
            "status NOT IN ('APPROVED', 'POSTED') "
            "OR approved_by IS NOT NULL",
            name="approval_required",
        ),
        Index(
            "ix_stock_adjustments_status",
            "status",
        ),
        Index(
            "ix_stock_adjustments_created_at",
            "created_at",
        ),
    )

    adjustment_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        nullable=False,
    )

    adjustment_number: Mapped[str] = mapped_column(
        String(100),
        nullable=False,
        unique=True,
    )

    reason: Mapped[str] = mapped_column(
        Text,
        nullable=False,
    )

    status: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
        default="DRAFT",
        server_default=text("'DRAFT'"),
    )

    created_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "users.user_id",
            ondelete="RESTRICT",
        ),
        nullable=False,
    )

    approved_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "users.user_id",
            ondelete="RESTRICT",
        ),
        nullable=True,
    )

    approved_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )

    posted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )

    creator: Mapped[User] = relationship(
        "User",
        foreign_keys=[created_by],
        lazy="selectin",
    )

    approver: Mapped[User | None] = relationship(
        "User",
        foreign_keys=[approved_by],
        lazy="selectin",
    )

    items: Mapped[list[StockAdjustmentItem]] = relationship(
        "StockAdjustmentItem",
        back_populates="adjustment",
        cascade="save-update, merge",
        passive_deletes=True,
    )

    def __repr__(self) -> str:
        return (
            f"StockAdjustment(adjustment_id={self.adjustment_id!r}, "
            f"adjustment_number={self.adjustment_number!r}, "
            f"status={self.status!r})"
        )


class StockAdjustmentItem(Base):
    """Individual stock correction against an item and location."""

    __tablename__ = "stock_adjustment_items"

    __table_args__ = (
        CheckConstraint(
            "direction IN ('IN', 'OUT')",
            name="valid_direction",
        ),
        CheckConstraint(
            "quantity > 0",
            name="quantity_positive",
        ),
        CheckConstraint(
            "unit_cost >= 0",
            name="unit_cost_nonnegative",
        ),
        CheckConstraint(
            "location IN ('WAREHOUSE', 'PRODUCTION_HELD')",
            name="valid_location",
        ),
        Index(
            "ix_stock_adjustment_items_item_id",
            "item_id",
        ),
    )

    adjustment_item_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        nullable=False,
    )

    adjustment_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "stock_adjustments.adjustment_id",
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

    batch_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "stock_batches.batch_id",
            ondelete="RESTRICT",
        ),
        nullable=True,
    )

    location: Mapped[str] = mapped_column(
        String(50),
        nullable=False,
        default="WAREHOUSE",
        server_default=text("'WAREHOUSE'"),
    )

    direction: Mapped[str] = mapped_column(
        String(3),
        nullable=False,
    )

    quantity: Mapped[Decimal] = mapped_column(
        QUANTITY_TYPE,
        nullable=False,
    )

    unit_cost: Mapped[Decimal] = mapped_column(
        UNIT_COST_TYPE,
        nullable=False,
        default=Decimal("0.000000"),
        server_default=text("0"),
    )

    adjustment: Mapped[StockAdjustment] = relationship(
        "StockAdjustment",
        back_populates="items",
    )

    inventory_item: Mapped[InventoryItem] = relationship(
        "InventoryItem",
        foreign_keys=[item_id],
        lazy="selectin",
    )

    batch: Mapped[StockBatch | None] = relationship(
        "StockBatch",
        foreign_keys=[batch_id],
        lazy="selectin",
    )

    def __repr__(self) -> str:
        return (
            f"StockAdjustmentItem("
            f"adjustment_item_id={self.adjustment_item_id!r}, "
            f"item_id={self.item_id!r}, "
            f"direction={self.direction!r}, "
            f"quantity={self.quantity!r})"
        )