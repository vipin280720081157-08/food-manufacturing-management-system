"""
GST invoices, invoice line items, and invoice correction references.

Invoices preserve transaction-time prices, tax rates, and totals.
Posted invoices must not be silently edited or deleted.

Invoice posting does not deduct inventory. Finished-goods stock
is deducted only when the corresponding dispatch is posted.
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
    from app.models.sales import SalesOrder, SalesOrderItem


class Invoice(Base):
    """GST invoice linked to an approved customer sales order."""

    __tablename__ = "invoices"

    __table_args__ = (
        UniqueConstraint(
            "financial_year",
            "invoice_number",
            name="uq_invoices_financial_year_number",
        ),
        CheckConstraint(
            "length(btrim(invoice_number)) > 0",
            name="invoice_number_not_blank",
        ),
        CheckConstraint(
            "length(btrim(financial_year)) > 0",
            name="financial_year_not_blank",
        ),
        CheckConstraint(
            "length(btrim(place_of_supply_state)) > 0",
            name="place_of_supply_state_not_blank",
        ),
        CheckConstraint(
            "invoice_type IN ("
            "'TAX_INVOICE', "
            "'CREDIT_NOTE'"
            ")",
            name="valid_invoice_type",
        ),
        CheckConstraint(
            "status IN ("
            "'DRAFT', "
            "'POSTED', "
            "'CANCELLED', "
            "'CREDITED'"
            ")",
            name="valid_status",
        ),
        CheckConstraint(
            "taxable_amount >= 0",
            name="taxable_amount_nonnegative",
        ),
        CheckConstraint(
            "cgst_amount >= 0",
            name="cgst_amount_nonnegative",
        ),
        CheckConstraint(
            "sgst_amount >= 0",
            name="sgst_amount_nonnegative",
        ),
        CheckConstraint(
            "igst_amount >= 0",
            name="igst_amount_nonnegative",
        ),
        CheckConstraint(
            "total_amount >= 0",
            name="total_amount_nonnegative",
        ),
        CheckConstraint(
            "total_amount = taxable_amount + "
            "cgst_amount + sgst_amount + igst_amount",
            name="total_amount_reconciled",
        ),
        CheckConstraint(
            "(igst_amount = 0) OR "
            "(cgst_amount = 0 AND sgst_amount = 0)",
            name="gst_components_exclusive",
        ),
        CheckConstraint(
            "cgst_amount = sgst_amount",
            name="cgst_sgst_equal",
        ),
        CheckConstraint(
            "due_date >= invoice_date",
            name="due_date_valid",
        ),
        CheckConstraint(
            "status NOT IN ('POSTED', 'CREDITED') "
            "OR posted_at IS NOT NULL",
            name="posted_status_requires_timestamp",
        ),
        CheckConstraint(
            "invoice_type <> 'CREDIT_NOTE' "
            "OR original_invoice_id IS NOT NULL",
            name="credit_note_requires_original",
        ),
        CheckConstraint(
            "original_invoice_id IS NULL "
            "OR original_invoice_id <> invoice_id",
            name="cannot_reference_self",
        ),
        Index(
            "ix_invoices_order_id",
            "order_id",
        ),
        Index(
            "ix_invoices_customer_id",
            "customer_id",
        ),
        Index(
            "ix_invoices_invoice_date",
            "invoice_date",
        ),
        Index(
            "ix_invoices_due_date",
            "due_date",
        ),
        Index(
            "ix_invoices_status",
            "status",
        ),
        Index(
            "ix_invoices_original_invoice_id",
            "original_invoice_id",
        ),
    )

    invoice_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        nullable=False,
    )

    order_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "sales_orders.sales_order_id",
            ondelete="RESTRICT",
        ),
        nullable=False,
    )

    customer_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "customers.customer_id",
            ondelete="RESTRICT",
        ),
        nullable=False,
    )

    invoice_number: Mapped[str] = mapped_column(
        String(100),
        nullable=False,
    )

    financial_year: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
    )

    invoice_date: Mapped[date] = mapped_column(
        Date,
        nullable=False,
    )

    invoice_type: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
        default="TAX_INVOICE",
        server_default=text("'TAX_INVOICE'"),
    )

    place_of_supply_state: Mapped[str] = mapped_column(
        String(100),
        nullable=False,
    )

    taxable_amount: Mapped[Decimal] = mapped_column(
        MONEY_TYPE,
        nullable=False,
        default=Decimal("0.00"),
        server_default=text("0"),
    )

    cgst_amount: Mapped[Decimal] = mapped_column(
        MONEY_TYPE,
        nullable=False,
        default=Decimal("0.00"),
        server_default=text("0"),
    )

    sgst_amount: Mapped[Decimal] = mapped_column(
        MONEY_TYPE,
        nullable=False,
        default=Decimal("0.00"),
        server_default=text("0"),
    )

    igst_amount: Mapped[Decimal] = mapped_column(
        MONEY_TYPE,
        nullable=False,
        default=Decimal("0.00"),
        server_default=text("0"),
    )

    total_amount: Mapped[Decimal] = mapped_column(
        MONEY_TYPE,
        nullable=False,
        default=Decimal("0.00"),
        server_default=text("0"),
    )

    due_date: Mapped[date] = mapped_column(
        Date,
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

    original_invoice_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "invoices.invoice_id",
            ondelete="RESTRICT",
        ),
        nullable=True,
    )

    sales_order: Mapped[SalesOrder] = relationship(
        "SalesOrder",
        foreign_keys=[order_id],
        lazy="selectin",
    )

    customer: Mapped[Customer] = relationship(
        "Customer",
        foreign_keys=[customer_id],
        lazy="selectin",
    )

    original_invoice: Mapped[Invoice | None] = relationship(
        "Invoice",
        back_populates="correction_invoices",
        remote_side=[invoice_id],
        foreign_keys=[original_invoice_id],
    )

    correction_invoices: Mapped[list[Invoice]] = relationship(
        "Invoice",
        back_populates="original_invoice",
        foreign_keys=[original_invoice_id],
        passive_deletes=True,
    )

    items: Mapped[list[InvoiceItem]] = relationship(
        "InvoiceItem",
        back_populates="invoice",
        cascade="save-update, merge",
        passive_deletes=True,
        order_by="InvoiceItem.line_number",
    )

    def __repr__(self) -> str:
        return (
            f"Invoice(invoice_id={self.invoice_id!r}, "
            f"invoice_number={self.invoice_number!r}, "
            f"financial_year={self.financial_year!r}, "
            f"invoice_type={self.invoice_type!r}, "
            f"status={self.status!r})"
        )


class InvoiceItem(Base):
    """
    Invoice line with historical product, price, and GST values.

    GST components are calculated using Decimal arithmetic
    and the applicable intra-state or inter-state tax rules.
    """

    __tablename__ = "invoice_items"

    __table_args__ = (
        UniqueConstraint(
            "invoice_id",
            "line_number",
            name="uq_invoice_items_invoice_line",
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
            "discount >= 0",
            name="discount_nonnegative",
        ),
        CheckConstraint(
            "tax_rate >= 0 AND tax_rate <= 100",
            name="tax_rate_valid",
        ),
        CheckConstraint(
            "taxable_amount >= 0",
            name="taxable_amount_nonnegative",
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
            "line_total = taxable_amount + tax_amount",
            name="line_total_reconciled",
        ),
        Index(
            "ix_invoice_items_order_item_id",
            "order_item_id",
        ),
        Index(
            "ix_invoice_items_product_id",
            "product_id",
        ),
    )

    invoice_item_id: Mapped[uuid.UUID] = mapped_column(
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

    line_number: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
    )

    order_item_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "sales_order_items.sales_order_item_id",
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

    hsn_code: Mapped[str | None] = mapped_column(
        String(20),
        nullable=True,
    )

    quantity: Mapped[Decimal] = mapped_column(
        QUANTITY_TYPE,
        nullable=False,
    )

    unit_price: Mapped[Decimal] = mapped_column(
        MONEY_TYPE,
        nullable=False,
    )

    discount: Mapped[Decimal] = mapped_column(
        MONEY_TYPE,
        nullable=False,
        default=Decimal("0.00"),
        server_default=text("0"),
    )

    tax_rate: Mapped[Decimal] = mapped_column(
        TAX_RATE_TYPE,
        nullable=False,
    )

    taxable_amount: Mapped[Decimal] = mapped_column(
        MONEY_TYPE,
        nullable=False,
    )

    tax_amount: Mapped[Decimal] = mapped_column(
        MONEY_TYPE,
        nullable=False,
    )

    line_total: Mapped[Decimal] = mapped_column(
        MONEY_TYPE,
        nullable=False,
    )

    invoice: Mapped[Invoice] = relationship(
        "Invoice",
        back_populates="items",
    )

    sales_order_item: Mapped[SalesOrderItem] = relationship(
        "SalesOrderItem",
        foreign_keys=[order_item_id],
        lazy="selectin",
    )

    product: Mapped[Product] = relationship(
        "Product",
        foreign_keys=[product_id],
        lazy="selectin",
    )

    def __repr__(self) -> str:
        return (
            f"InvoiceItem("
            f"invoice_item_id={self.invoice_item_id!r}, "
            f"invoice_id={self.invoice_id!r}, "
            f"product_id={self.product_id!r}, "
            f"quantity={self.quantity!r}, "
            f"line_total={self.line_total!r})"
        )