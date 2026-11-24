"""
Purchase orders, purchase order items, goods receipts,
and goods receipt items.

Purchase orders record commercial commitments. Inventory
increases only when a goods receipt is posted through the
inventory service with corresponding stock movements.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    CheckConstraint,
    Date,
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
from app.models.product import InventoryItem
from app.models.supplier import Supplier
from app.models.user import User


class PurchaseOrder(Base):
    """Supplier purchase order and its approval status."""

    __tablename__ = "purchase_orders"

    __table_args__ = (
        CheckConstraint(
            "length(btrim(po_number)) > 0",
            name="po_number_not_blank",
        ),
        CheckConstraint(
            "status IN ("
            "'DRAFT', "
            "'SUBMITTED', "
            "'APPROVED', "
            "'REJECTED', "
            "'PARTIALLY_RECEIVED', "
            "'RECEIVED', "
            "'CANCELLED'"
            ")",
            name="valid_status",
        ),
        CheckConstraint(
            "expected_date IS NULL OR expected_date >= order_date",
            name="expected_date_valid",
        ),
        Index(
            "ix_purchase_orders_supplier_id",
            "supplier_id",
        ),
        Index(
            "ix_purchase_orders_status",
            "status",
        ),
        Index(
            "ix_purchase_orders_order_date",
            "order_date",
        ),
    )

    purchase_order_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        nullable=False,
    )

    supplier_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "suppliers.supplier_id",
            ondelete="RESTRICT",
        ),
        nullable=False,
    )

    po_number: Mapped[str] = mapped_column(
        String(100),
        nullable=False,
        unique=True,
    )

    order_date: Mapped[date] = mapped_column(
        Date,
        nullable=False,
    )

    expected_date: Mapped[date | None] = mapped_column(
        Date,
        nullable=True,
    )

    status: Mapped[str] = mapped_column(
        String(30),
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

    supplier: Mapped[Supplier] = relationship(
        "Supplier",
        foreign_keys=[supplier_id],
        lazy="selectin",
    )

    creator: Mapped[User] = relationship(
        "User",
        foreign_keys=[created_by],
        lazy="selectin",
    )

    items: Mapped[list[PurchaseOrderItem]] = relationship(
        "PurchaseOrderItem",
        back_populates="purchase_order",
        cascade="save-update, merge",
        passive_deletes=True,
    )

    goods_receipts: Mapped[list[GoodsReceipt]] = relationship(
        "GoodsReceipt",
        back_populates="purchase_order",
        cascade="save-update, merge",
        passive_deletes=True,
    )

    def __repr__(self) -> str:
        return (
            f"PurchaseOrder("
            f"purchase_order_id={self.purchase_order_id!r}, "
            f"po_number={self.po_number!r}, "
            f"status={self.status!r})"
        )


class PurchaseOrderItem(Base):
    """Ordered inventory item with agreed price and tax rate."""

    __tablename__ = "purchase_order_items"

    __table_args__ = (
        UniqueConstraint(
            "purchase_order_id",
            "item_id",
            name="uq_purchase_order_items_order_item",
        ),
        CheckConstraint(
            "quantity > 0",
            name="quantity_positive",
        ),
        CheckConstraint(
            "unit_price >= 0",
            name="unit_price_nonnegative",
        ),
        CheckConstraint(
            "tax_rate >= 0 AND tax_rate <= 100",
            name="tax_rate_valid",
        ),
        CheckConstraint(
            "line_total >= 0",
            name="line_total_nonnegative",
        ),
        Index(
            "ix_purchase_order_items_item_id",
            "item_id",
        ),
    )

    po_item_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        nullable=False,
    )

    purchase_order_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "purchase_orders.purchase_order_id",
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

    quantity: Mapped[Decimal] = mapped_column(
        QUANTITY_TYPE,
        nullable=False,
    )

    unit_price: Mapped[Decimal] = mapped_column(
        MONEY_TYPE,
        nullable=False,
    )

    tax_rate: Mapped[Decimal] = mapped_column(
        TAX_RATE_TYPE,
        nullable=False,
        default=Decimal("0.0000"),
        server_default=text("0"),
    )

    line_total: Mapped[Decimal] = mapped_column(
        MONEY_TYPE,
        nullable=False,
    )

    purchase_order: Mapped[PurchaseOrder] = relationship(
        "PurchaseOrder",
        back_populates="items",
    )

    inventory_item: Mapped[InventoryItem] = relationship(
        "InventoryItem",
        foreign_keys=[item_id],
        lazy="selectin",
    )

    receipt_items: Mapped[list[GoodsReceiptItem]] = relationship(
        "GoodsReceiptItem",
        back_populates="purchase_order_item",
        cascade="save-update, merge",
        passive_deletes=True,
    )

    def __repr__(self) -> str:
        return (
            f"PurchaseOrderItem("
            f"po_item_id={self.po_item_id!r}, "
            f"purchase_order_id={self.purchase_order_id!r}, "
            f"item_id={self.item_id!r}, "
            f"quantity={self.quantity!r})"
        )


class GoodsReceipt(Base):
    """
    Physical receipt of goods against a purchase order.

    Posting must atomically create stock batches and stock
    movements, update inventory balances, and prevent
    duplicate posting.
    """

    __tablename__ = "goods_receipts"

    __table_args__ = (
        CheckConstraint(
            "length(btrim(receipt_number)) > 0",
            name="receipt_number_not_blank",
        ),
        CheckConstraint(
            "status IN ('DRAFT', 'POSTED', 'CANCELLED')",
            name="valid_status",
        ),
        CheckConstraint(
            "(status = 'POSTED' AND posted_at IS NOT NULL) "
            "OR (status <> 'POSTED' AND posted_at IS NULL)",
            name="posted_at_matches_status",
        ),
        Index(
            "ix_goods_receipts_purchase_order_id",
            "purchase_order_id",
        ),
        Index(
            "ix_goods_receipts_received_date",
            "received_date",
        ),
        Index(
            "ix_goods_receipts_status",
            "status",
        ),
    )

    receipt_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        nullable=False,
    )

    purchase_order_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "purchase_orders.purchase_order_id",
            ondelete="RESTRICT",
        ),
        nullable=False,
    )

    receipt_number: Mapped[str] = mapped_column(
        String(100),
        nullable=False,
        unique=True,
    )

    received_date: Mapped[date] = mapped_column(
        Date,
        nullable=False,
    )

    received_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "users.user_id",
            ondelete="RESTRICT",
        ),
        nullable=False,
    )

    status: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
        default="DRAFT",
        server_default=text("'DRAFT'"),
    )

    posted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )

    purchase_order: Mapped[PurchaseOrder] = relationship(
        "PurchaseOrder",
        back_populates="goods_receipts",
    )

    receiver: Mapped[User] = relationship(
        "User",
        foreign_keys=[received_by],
        lazy="selectin",
    )

    items: Mapped[list[GoodsReceiptItem]] = relationship(
        "GoodsReceiptItem",
        back_populates="goods_receipt",
        cascade="save-update, merge",
        passive_deletes=True,
    )

    def __repr__(self) -> str:
        return (
            f"GoodsReceipt("
            f"receipt_id={self.receipt_id!r}, "
            f"receipt_number={self.receipt_number!r}, "
            f"status={self.status!r})"
        )


class GoodsReceiptItem(Base):
    """Received, accepted, and rejected quantities for a PO line."""

    __tablename__ = "goods_receipt_items"

    __table_args__ = (
        UniqueConstraint(
            "receipt_id",
            "po_item_id",
            name="uq_goods_receipt_items_receipt_po_item",
        ),
        CheckConstraint(
            "received_quantity > 0",
            name="received_quantity_positive",
        ),
        CheckConstraint(
            "accepted_quantity >= 0",
            name="accepted_quantity_nonnegative",
        ),
        CheckConstraint(
            "rejected_quantity >= 0",
            name="rejected_quantity_nonnegative",
        ),
        CheckConstraint(
            "accepted_quantity + rejected_quantity "
            "= received_quantity",
            name="received_quantity_reconciled",
        ),
        Index(
            "ix_goods_receipt_items_po_item_id",
            "po_item_id",
        ),
    )

    receipt_item_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        nullable=False,
    )

    receipt_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "goods_receipts.receipt_id",
            ondelete="RESTRICT",
        ),
        nullable=False,
    )

    po_item_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "purchase_order_items.po_item_id",
            ondelete="RESTRICT",
        ),
        nullable=False,
    )

    received_quantity: Mapped[Decimal] = mapped_column(
        QUANTITY_TYPE,
        nullable=False,
    )

    accepted_quantity: Mapped[Decimal] = mapped_column(
        QUANTITY_TYPE,
        nullable=False,
    )

    rejected_quantity: Mapped[Decimal] = mapped_column(
        QUANTITY_TYPE,
        nullable=False,
        default=Decimal("0.000"),
        server_default=text("0"),
    )

    goods_receipt: Mapped[GoodsReceipt] = relationship(
        "GoodsReceipt",
        back_populates="items",
    )

    purchase_order_item: Mapped[PurchaseOrderItem] = relationship(
        "PurchaseOrderItem",
        back_populates="receipt_items",
        lazy="selectin",
    )

    def __repr__(self) -> str:
        return (
            f"GoodsReceiptItem("
            f"receipt_item_id={self.receipt_item_id!r}, "
            f"receipt_id={self.receipt_id!r}, "
            f"po_item_id={self.po_item_id!r}, "
            f"accepted_quantity={self.accepted_quantity!r})"
        )