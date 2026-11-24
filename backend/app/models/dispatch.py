"""
Dispatch records and batch-level dispatch allocations.

A dispatch belongs to a posted invoice and may contain multiple
invoice lines or finished-goods batch allocations.

Posting must atomically deduct stock, create stock movements,
update batch balances, and maintain sales-order fulfillment status.
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
    String,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, QUANTITY_TYPE

if TYPE_CHECKING:
    from app.models.inventory import StockBatch
    from app.models.invoicing import Invoice, InvoiceItem
    from app.models.product import Product


class Dispatch(Base):
    """
    Dispatch document linked to a customer invoice.

    Draft dispatches do not affect inventory. Posting requires
    an approved sales order, a posted invoice, sufficient
    authorized quantities, and eligible finished-goods stock.

    Posted dispatches must not be deleted or silently modified.
    """

    __tablename__ = "dispatches"

    __table_args__ = (
        CheckConstraint(
            "length(btrim(dispatch_number)) > 0",
            name="dispatch_number_not_blank",
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
            "ix_dispatches_invoice_id",
            "invoice_id",
        ),
        Index(
            "ix_dispatches_dispatch_date",
            "dispatch_date",
        ),
        Index(
            "ix_dispatches_status",
            "status",
        ),
    )

    dispatch_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        nullable=False,
    )

    invoice_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "invoices.invoice_id",
            ondelete="RESTRICT",
        ),
        nullable=False,
    )

    dispatch_number: Mapped[str] = mapped_column(
        String(100),
        nullable=False,
        unique=True,
    )

    dispatch_date: Mapped[date] = mapped_column(
        Date,
        nullable=False,
    )

    delivery_reference: Mapped[str | None] = mapped_column(
        String(150),
        nullable=True,
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

    invoice: Mapped[Invoice] = relationship(
        "Invoice",
        foreign_keys=[invoice_id],
        lazy="selectin",
    )

    items: Mapped[list[DispatchItem]] = relationship(
        "DispatchItem",
        back_populates="dispatch",
        cascade="save-update, merge",
        passive_deletes=True,
        order_by="DispatchItem.dispatch_item_id",
    )

    def __repr__(self) -> str:
        return (
            f"Dispatch(dispatch_id={self.dispatch_id!r}, "
            f"dispatch_number={self.dispatch_number!r}, "
            f"invoice_id={self.invoice_id!r}, "
            f"status={self.status!r})"
        )


class DispatchItem(Base):
    """
    Finished-goods quantity allocated from a specific stock batch.

    Multiple dispatch items may reference the same invoice line
    when stock is allocated across multiple batches.

    The service layer must validate that:
    - The product matches the referenced invoice line.
    - The batch contains the referenced finished product.
    - The batch is eligible under applicable FEFO rules.
    - Total dispatched quantity does not exceed the invoice
      line or its approved sales-order authorization.
    - The batch and warehouse balance have sufficient stock.
    - Posting creates exactly one corresponding stock-out
      movement per dispatch item.
    """

    __tablename__ = "dispatch_items"

    __table_args__ = (
        UniqueConstraint(
            "dispatch_id",
            "invoice_item_id",
            "batch_id",
            name="uq_dispatch_items_invoice_line_batch",
        ),
        CheckConstraint(
            "quantity > 0",
            name="quantity_positive",
        ),
        Index(
            "ix_dispatch_items_invoice_item_id",
            "invoice_item_id",
        ),
        Index(
            "ix_dispatch_items_product_id",
            "product_id",
        ),
        Index(
            "ix_dispatch_items_batch_id",
            "batch_id",
        ),
    )

    dispatch_item_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        nullable=False,
    )

    dispatch_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "dispatches.dispatch_id",
            ondelete="RESTRICT",
        ),
        nullable=False,
    )

    invoice_item_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "invoice_items.invoice_item_id",
            ondelete="RESTRICT",
        ),
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

    batch_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "stock_batches.batch_id",
            ondelete="RESTRICT",
        ),
        nullable=False,
    )

    quantity: Mapped[Decimal] = mapped_column(
        QUANTITY_TYPE,
        nullable=False,
    )

    dispatch: Mapped[Dispatch] = relationship(
        "Dispatch",
        back_populates="items",
    )

    invoice_item: Mapped[InvoiceItem] = relationship(
        "InvoiceItem",
        foreign_keys=[invoice_item_id],
        lazy="selectin",
    )

    product: Mapped[Product] = relationship(
        "Product",
        foreign_keys=[product_id],
        lazy="selectin",
    )

    batch: Mapped[StockBatch] = relationship(
        "StockBatch",
        foreign_keys=[batch_id],
        lazy="selectin",
    )

    def __repr__(self) -> str:
        return (
            f"DispatchItem("
            f"dispatch_item_id={self.dispatch_item_id!r}, "
            f"dispatch_id={self.dispatch_id!r}, "
            f"invoice_item_id={self.invoice_item_id!r}, "
            f"batch_id={self.batch_id!r}, "
            f"quantity={self.quantity!r})"
        )