"""
Customer payments and invoice payment allocations.

Payments support partial settlement, allocation across multiple
invoices, and unapplied customer payment balances.

Payment posting and allocation changes must be performed
atomically by the service layer. Posted financial records
must be preserved for audit and reconciliation.
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
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, MONEY_TYPE

if TYPE_CHECKING:
    from app.models.customer import Customer
    from app.models.invoicing import Invoice
    from app.models.user import User


class Payment(Base):
    """
    Customer payment recorded against one or more invoices.

    An unallocated balance is permitted. The service layer
    must prevent duplicate posting, over-allocation, and
    allocation to invoices belonging to another customer.

    Reversals must preserve the original payment record.
    """

    __tablename__ = "payments"

    __table_args__ = (
        CheckConstraint(
            "amount > 0",
            name="amount_positive",
        ),
        CheckConstraint(
            "length(btrim(payment_method)) > 0",
            name="payment_method_not_blank",
        ),
        CheckConstraint(
            "status IN ('DRAFT', 'POSTED', 'REVERSED')",
            name="valid_status",
        ),
        CheckConstraint(
            "status <> 'REVERSED' "
            "OR reversed_at IS NOT NULL",
            name="reversed_requires_timestamp",
        ),
        CheckConstraint(
            "status = 'REVERSED' "
            "OR reversed_at IS NULL",
            name="reversal_timestamp_matches_status",
        ),
        CheckConstraint(
            "reversed_at IS NULL OR posted_at IS NOT NULL",
            name="reversal_requires_posting",
        ),
        CheckConstraint(
            "status = 'DRAFT' OR posted_at IS NOT NULL",
            name="posted_status_requires_timestamp",
        ),
        Index(
            "ix_payments_customer_id",
            "customer_id",
        ),
        Index(
            "ix_payments_payment_date",
            "payment_date",
        ),
        Index(
            "ix_payments_status",
            "status",
        ),
        Index(
            "ix_payments_recorded_by",
            "recorded_by",
        ),
        Index(
            "ix_payments_customer_status_date",
            "customer_id",
            "status",
            "payment_date",
        ),
        Index(
            "uq_payments_customer_reference",
            "customer_id",
            "reference_number",
            unique=True,
            postgresql_where=text(
                "reference_number IS NOT NULL "
                "AND btrim(reference_number) <> ''"
            ),
        ),
    )

    payment_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
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

    payment_date: Mapped[date] = mapped_column(
        Date,
        nullable=False,
    )

    amount: Mapped[Decimal] = mapped_column(
        MONEY_TYPE,
        nullable=False,
    )

    payment_method: Mapped[str] = mapped_column(
        String(50),
        nullable=False,
    )

    reference_number: Mapped[str | None] = mapped_column(
        String(150),
        nullable=True,
    )

    notes: Mapped[str | None] = mapped_column(
        Text,
        nullable=True,
    )

    recorded_by: Mapped[uuid.UUID] = mapped_column(
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

    reversed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )

    customer: Mapped[Customer] = relationship(
        "Customer",
        foreign_keys=[customer_id],
        lazy="selectin",
    )

    recorder: Mapped[User] = relationship(
        "User",
        foreign_keys=[recorded_by],
        lazy="selectin",
    )

    allocations: Mapped[list[PaymentAllocation]] = relationship(
        "PaymentAllocation",
        back_populates="payment",
        cascade="save-update, merge",
        passive_deletes=True,
    )

    @property
    def allocated_amount(self) -> Decimal:
        """
        Return the sum of this payment's recorded allocations.

        This is an in-memory calculation. The service layer
        must use database queries and locking when validating
        concurrent allocation transactions.
        """

        return sum(
            (
                allocation.allocated_amount
                for allocation in self.allocations
            ),
            Decimal("0.00"),
        )

    @property
    def unallocated_amount(self) -> Decimal:
        """Return the amount not assigned to invoices."""

        return self.amount - self.allocated_amount

    def __repr__(self) -> str:
        return (
            f"Payment(payment_id={self.payment_id!r}, "
            f"customer_id={self.customer_id!r}, "
            f"amount={self.amount!r}, "
            f"status={self.status!r})"
        )


class PaymentAllocation(Base):
    """
    Amount of a customer payment applied to an invoice.

    One payment can settle multiple invoices, and one invoice
    can receive allocations from multiple payments.

    Only allocations belonging to valid posted payments count
    toward outstanding receivables. Reversed payments must
    be excluded from effective settlement calculations.
    """

    __tablename__ = "payment_allocations"

    __table_args__ = (
        UniqueConstraint(
            "payment_id",
            "invoice_id",
            name="uq_payment_allocations_payment_invoice",
        ),
        CheckConstraint(
            "allocated_amount > 0",
            name="allocated_amount_positive",
        ),
        Index(
            "ix_payment_allocations_invoice_id",
            "invoice_id",
        ),
    )

    allocation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        nullable=False,
    )

    payment_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "payments.payment_id",
            ondelete="RESTRICT",
        ),
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

    allocated_amount: Mapped[Decimal] = mapped_column(
        MONEY_TYPE,
        nullable=False,
    )

    payment: Mapped[Payment] = relationship(
        "Payment",
        back_populates="allocations",
    )

    invoice: Mapped[Invoice] = relationship(
        "Invoice",
        foreign_keys=[invoice_id],
        lazy="selectin",
    )

    def __repr__(self) -> str:
        return (
            f"PaymentAllocation("
            f"allocation_id={self.allocation_id!r}, "
            f"payment_id={self.payment_id!r}, "
            f"invoice_id={self.invoice_id!r}, "
            f"allocated_amount={self.allocated_amount!r})"
        )