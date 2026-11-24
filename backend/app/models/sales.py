"""
Sales orders, sales order items, and approval history.

Approval and fulfillment statuses are maintained separately.
Order items retain historical selling prices and tax rates.
Approval decisions are recorded in an append-only history.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import TYPE_CHECKING

from sqlalchemy import (
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
    MONEY_TYPE,
    QUANTITY_TYPE,
    TAX_RATE_TYPE,
)

if TYPE_CHECKING:
    from app.models.customer import Customer
    from app.models.product import Product
    from app.models.user import User


class SalesOrder(Base):
    """Customer sales order with independent approval and fulfillment states."""

    __tablename__ = "sales_orders"

    __table_args__ = (
        CheckConstraint(
            "length(btrim(order_number)) > 0",
            name="order_number_not_blank",
        ),
        CheckConstraint(
            "approval_status IN ("
            "'DRAFT', "
            "'SUBMITTED', "
            "'APPROVED', "
            "'REJECTED', "
            "'CANCELLED'"
            ")",
            name="valid_approval_status",
        ),
        CheckConstraint(
            "fulfillment_status IN ("
            "'NOT_DISPATCHED', "
            "'PARTIALLY_DISPATCHED', "
            "'DISPATCHED'"
            ")",
            name="valid_fulfillment_status",
        ),
        CheckConstraint(
            "approval_status = 'APPROVED' "
            "OR fulfillment_status = 'NOT_DISPATCHED'",
            name="dispatch_requires_approval",
        ),
        CheckConstraint(
            "required_date IS NULL OR required_date >= order_date",
            name="required_date_valid",
        ),
        CheckConstraint(
            "subtotal >= 0",
            name="subtotal_nonnegative",
        ),
        CheckConstraint(
            "tax_total >= 0",
            name="tax_total_nonnegative",
        ),
        CheckConstraint(
            "grand_total >= 0",
            name="grand_total_nonnegative",
        ),
        CheckConstraint(
            "grand_total = subtotal + tax_total",
            name="grand_total_reconciled",
        ),
        Index(
            "ix_sales_orders_customer_id",
            "customer_id",
        ),
        Index(
            "ix_sales_orders_salesman_id",
            "salesman_id",
        ),
        Index(
            "ix_sales_orders_approval_status",
            "approval_status",
        ),
        Index(
            "ix_sales_orders_fulfillment_status",
            "fulfillment_status",
        ),
        Index(
            "ix_sales_orders_order_date",
            "order_date",
        ),
    )

    sales_order_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        nullable=False,
    )

    order_number: Mapped[str] = mapped_column(
        String(100),
        nullable=False,
        unique=True,
    )

    customer_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "customers.customer_id",
            ondelete="RESTRICT",
        ),
        nullable=False,
    )

    salesman_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "users.user_id",
            ondelete="RESTRICT",
        ),
        nullable=False,
    )

    order_date: Mapped[date] = mapped_column(
        Date,
        nullable=False,
    )

    required_date: Mapped[date | None] = mapped_column(
        Date,
        nullable=True,
    )

    approval_status: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
        default="DRAFT",
        server_default=text("'DRAFT'"),
    )

    fulfillment_status: Mapped[str] = mapped_column(
        String(30),
        nullable=False,
        default="NOT_DISPATCHED",
        server_default=text("'NOT_DISPATCHED'"),
    )

    subtotal: Mapped[Decimal] = mapped_column(
        MONEY_TYPE,
        nullable=False,
        default=Decimal("0.00"),
        server_default=text("0"),
    )

    tax_total: Mapped[Decimal] = mapped_column(
        MONEY_TYPE,
        nullable=False,
        default=Decimal("0.00"),
        server_default=text("0"),
    )

    grand_total: Mapped[Decimal] = mapped_column(
        MONEY_TYPE,
        nullable=False,
        default=Decimal("0.00"),
        server_default=text("0"),
    )

    notes: Mapped[str | None] = mapped_column(
        Text,
        nullable=True,
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    customer: Mapped[Customer] = relationship(
        "Customer",
        foreign_keys=[customer_id],
        lazy="selectin",
    )

    salesman: Mapped[User] = relationship(
        "User",
        foreign_keys=[salesman_id],
        lazy="selectin",
    )

    items: Mapped[list[SalesOrderItem]] = relationship(
        "SalesOrderItem",
        back_populates="sales_order",
        cascade="save-update, merge",
        passive_deletes=True,
        order_by="SalesOrderItem.line_number",
    )

    approval_history: Mapped[list[OrderApprovalHistory]] = relationship(
        "OrderApprovalHistory",
        back_populates="sales_order",
        cascade="save-update, merge",
        passive_deletes=True,
        order_by="OrderApprovalHistory.decided_at",
    )

    def __repr__(self) -> str:
        return (
            f"SalesOrder(sales_order_id={self.sales_order_id!r}, "
            f"order_number={self.order_number!r}, "
            f"approval_status={self.approval_status!r}, "
            f"fulfillment_status={self.fulfillment_status!r})"
        )


class SalesOrderItem(Base):
    """
    Product line with transaction-time pricing and GST snapshots.

    Quantities are expressed in the product's base unit.
    The service layer validates product availability and
    calculates monetary amounts using Decimal arithmetic.
    """

    __tablename__ = "sales_order_items"

    __table_args__ = (
        UniqueConstraint(
            "sales_order_id",
            "line_number",
            name="uq_sales_order_items_order_line",
        ),
        CheckConstraint(
            "line_number > 0",
            name="line_number_positive",
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
            "line_subtotal >= 0",
            name="line_subtotal_nonnegative",
        ),
        CheckConstraint(
            "tax_amount >= 0",
            name="tax_amount_nonnegative",
        ),
        CheckConstraint(
            "line_total >= 0",
            name="line_total_nonnegative",
        ),
        CheckConstraint(
            "line_total = line_subtotal + tax_amount",
            name="line_total_reconciled",
        ),
        Index(
            "ix_sales_order_items_product_id",
            "product_id",
        ),
    )

    sales_order_item_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        nullable=False,
    )

    sales_order_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "sales_orders.sales_order_id",
            ondelete="RESTRICT",
        ),
        nullable=False,
    )

    line_number: Mapped[int] = mapped_column(
        Integer,
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

    line_subtotal: Mapped[Decimal] = mapped_column(
        MONEY_TYPE,
        nullable=False,
    )

    tax_amount: Mapped[Decimal] = mapped_column(
        MONEY_TYPE,
        nullable=False,
        default=Decimal("0.00"),
        server_default=text("0"),
    )

    line_total: Mapped[Decimal] = mapped_column(
        MONEY_TYPE,
        nullable=False,
    )

    sales_order: Mapped[SalesOrder] = relationship(
        "SalesOrder",
        back_populates="items",
    )

    product: Mapped[Product] = relationship(
        "Product",
        foreign_keys=[product_id],
        lazy="selectin",
    )

    def __repr__(self) -> str:
        return (
            f"SalesOrderItem("
            f"sales_order_item_id={self.sales_order_item_id!r}, "
            f"sales_order_id={self.sales_order_id!r}, "
            f"product_id={self.product_id!r}, "
            f"quantity={self.quantity!r})"
        )


class OrderApprovalHistory(Base):
    """
    Historical record of a sales order approval decision.

    Decision records must be inserted, never overwritten.
    The authorization layer verifies the decision-maker's role.
    """

    __tablename__ = "order_approval_history"

    __table_args__ = (
        CheckConstraint(
            "previous_status IN ("
            "'DRAFT', "
            "'SUBMITTED', "
            "'APPROVED', "
            "'REJECTED', "
            "'CANCELLED'"
            ")",
            name="valid_previous_status",
        ),
        CheckConstraint(
            "new_status IN ("
            "'DRAFT', "
            "'SUBMITTED', "
            "'APPROVED', "
            "'REJECTED', "
            "'CANCELLED'"
            ")",
            name="valid_new_status",
        ),
        CheckConstraint(
            "previous_status <> new_status",
            name="status_must_change",
        ),
        CheckConstraint(
            "new_status <> 'REJECTED' "
            "OR (reason IS NOT NULL "
            "AND length(btrim(reason)) > 0)",
            name="rejection_requires_reason",
        ),
        Index(
            "ix_order_approval_history_order_decided",
            "sales_order_id",
            "decided_at",
        ),
        Index(
            "ix_order_approval_history_decided_by",
            "decided_by",
        ),
    )

    approval_history_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        nullable=False,
    )

    sales_order_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "sales_orders.sales_order_id",
            ondelete="RESTRICT",
        ),
        nullable=False,
    )

    previous_status: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
    )

    new_status: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
    )

    decided_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "users.user_id",
            ondelete="RESTRICT",
        ),
        nullable=False,
    )

    reason: Mapped[str | None] = mapped_column(
        Text,
        nullable=True,
    )

    decided_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )

    sales_order: Mapped[SalesOrder] = relationship(
        "SalesOrder",
        back_populates="approval_history",
    )

    decision_maker: Mapped[User] = relationship(
        "User",
        foreign_keys=[decided_by],
        lazy="selectin",
    )

    def __repr__(self) -> str:
        return (
            f"OrderApprovalHistory("
            f"approval_history_id={self.approval_history_id!r}, "
            f"sales_order_id={self.sales_order_id!r}, "
            f"previous_status={self.previous_status!r}, "
            f"new_status={self.new_status!r})"
        )