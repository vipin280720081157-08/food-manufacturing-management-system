"""
Pydantic v2 schemas for customer payments and invoice allocations.

The persisted response schemas follow the Development 03A SQLAlchemy
models Payment and PaymentAllocation in app.models.payment.

Payments support partial settlement, allocation across multiple
invoices, and unapplied customer balances.

The service layer must verify customer ownership, invoice eligibility,
payment authorization, available unallocated amounts, outstanding
invoice balances, and concurrent allocation safety.

Posting, allocation changes, and reversals must preserve financial
history and be performed within appropriate database transactions.
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Literal
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    model_validator,
)


PositiveMoney = Annotated[
    Decimal,
    Field(
        gt=0,
        max_digits=18,
        decimal_places=2,
        allow_inf_nan=False,
    ),
]

NonnegativeMoney = Annotated[
    Decimal,
    Field(
        ge=0,
        max_digits=18,
        decimal_places=2,
        allow_inf_nan=False,
    ),
]

PaymentMethod = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        min_length=1,
        max_length=50,
    ),
]

ReferenceNumber = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        min_length=1,
        max_length=150,
    ),
]

RequiredReason = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        min_length=1,
    ),
]

PaymentStatus = Literal[
    "DRAFT",
    "POSTED",
    "REVERSED",
]


class PaymentSchema(BaseModel):
    """Shared configuration for payment request schemas."""

    model_config = ConfigDict(
        extra="forbid",
        str_strip_whitespace=True,
    )


class PaymentResponseSchema(PaymentSchema):
    """Shared configuration for ORM-backed payment responses."""

    model_config = ConfigDict(
        from_attributes=True,
        extra="forbid",
        str_strip_whitespace=True,
    )


class PaymentAllocationCreate(PaymentSchema):
    """
    Allocate part of a customer payment to one invoice.

    The service must verify that the invoice belongs to the
    payment's customer, is eligible for settlement, and has
    sufficient outstanding balance.
    """

    invoice_id: UUID
    allocated_amount: PositiveMoney


class PaymentCreate(PaymentSchema):
    """
    Create a draft customer payment with optional allocations.

    The authenticated user determines recorded_by. The backend
    must validate the customer, enforce reference uniqueness,
    and calculate the unapplied amount.

    Draft creation does not constitute a posted settlement.
    """

    customer_id: UUID
    payment_date: date
    amount: PositiveMoney
    payment_method: PaymentMethod
    reference_number: ReferenceNumber | None = None
    notes: str | None = None
    allocations: list[PaymentAllocationCreate] = Field(
        default_factory=list,
    )

    @model_validator(mode="after")
    def validate_allocations(self) -> PaymentCreate:
        invoice_ids = [
            allocation.invoice_id
            for allocation in self.allocations
        ]

        if len(invoice_ids) != len(set(invoice_ids)):
            raise ValueError(
                "A payment cannot contain duplicate allocations "
                "to the same invoice."
            )

        allocated_total = sum(
            (
                allocation.allocated_amount
                for allocation in self.allocations
            ),
            Decimal("0.00"),
        )

        if allocated_total > self.amount:
            raise ValueError(
                "Total allocations cannot exceed the payment amount."
            )

        return self


class PaymentUpdate(PaymentSchema):
    """
    Partial update of editable draft payment attributes.

    Allocation changes use their dedicated request schemas.
    The service must reject edits to posted or reversed payments.
    """

    payment_date: date | None = None
    amount: PositiveMoney | None = None
    payment_method: PaymentMethod | None = None
    reference_number: ReferenceNumber | None = None
    notes: str | None = None

    @model_validator(mode="after")
    def validate_update(self) -> PaymentUpdate:
        if not self.model_fields_set:
            raise ValueError(
                "At least one payment field must be provided."
            )

        for field_name in (
            "payment_date",
            "amount",
            "payment_method",
        ):
            if (
                field_name in self.model_fields_set
                and getattr(self, field_name) is None
            ):
                raise ValueError(
                    f"{field_name} cannot be null."
                )

        return self


class PaymentAllocationResponse(PaymentResponseSchema):
    """Persisted allocation between a payment and an invoice."""

    allocation_id: UUID
    payment_id: UUID
    invoice_id: UUID
    allocated_amount: Decimal


class PaymentResponse(PaymentResponseSchema):
    """Persisted payment header and allocation records."""

    payment_id: UUID
    customer_id: UUID
    payment_date: date
    amount: Decimal
    payment_method: str
    reference_number: str | None
    notes: str | None
    recorded_by: UUID
    status: PaymentStatus
    posted_at: datetime | None
    reversed_at: datetime | None
    created_at: datetime
    allocations: list[PaymentAllocationResponse]


class PaymentListResponse(PaymentSchema):
    """Paginated customer payment listing."""

    items: list[PaymentResponse]
    total: int = Field(ge=0)
    page: int = Field(ge=1)
    page_size: int = Field(ge=1)


class PaymentAllocationReplaceRequest(PaymentSchema):
    """
    Replace allocations on an editable draft payment.

    The service must validate the complete replacement against
    the payment amount and each invoice's current outstanding
    balance in one database transaction.
    """

    allocations: list[PaymentAllocationCreate]

    @model_validator(mode="after")
    def validate_unique_invoices(
        self,
    ) -> PaymentAllocationReplaceRequest:
        invoice_ids = [
            allocation.invoice_id
            for allocation in self.allocations
        ]

        if len(invoice_ids) != len(set(invoice_ids)):
            raise ValueError(
                "A payment may have only one allocation "
                "per invoice."
            )

        return self


class PaymentAllocationAddRequest(PaymentSchema):
    """
    Add an allocation to a payment where the service permits it.

    The service must lock the relevant payment and invoice records,
    reject duplicate payment-invoice pairs, and ensure that the
    allocation does not exceed either available payment funds
    or the invoice's outstanding amount.
    """

    invoice_id: UUID
    allocated_amount: PositiveMoney


class PaymentAllocationUpdateRequest(PaymentSchema):
    """Update an existing allocation while the payment is editable."""

    allocated_amount: PositiveMoney


class PaymentPostRequest(PaymentSchema):
    """
    Request posting of an existing draft payment.

    The backend must revalidate customer and invoice ownership,
    allocation limits, financial status, and idempotency before
    changing the payment to POSTED.
    """


class PaymentPostResponse(PaymentSchema):
    """Result of posting a payment."""

    payment_id: UUID
    customer_id: UUID
    status: Literal["POSTED"]
    posted_at: datetime
    amount: PositiveMoney
    allocated_amount: NonnegativeMoney
    unallocated_amount: NonnegativeMoney

    @model_validator(mode="after")
    def validate_posted_amounts(self) -> PaymentPostResponse:
        if self.allocated_amount > self.amount:
            raise ValueError(
                "Allocated amount cannot exceed payment amount."
            )

        if self.unallocated_amount != (
            self.amount - self.allocated_amount
        ):
            raise ValueError(
                "Unallocated amount does not reconcile "
                "with the payment and allocations."
            )

        return self


class PaymentReversalRequest(PaymentSchema):
    """
    Request an authorized reversal of a posted payment.

    The original payment and allocation records must remain
    available for audit. Reversed payments must be excluded
    from effective invoice settlement calculations.
    """

    reason: RequiredReason


class PaymentStatusResponse(PaymentSchema):
    """Compact response after an authorized payment transition."""

    payment_id: UUID
    customer_id: UUID
    status: PaymentStatus
    posted_at: datetime | None
    reversed_at: datetime | None


class PaymentBalanceResponse(PaymentSchema):
    """
    Payment amount and its allocated and unapplied balances.

    These amounts must be calculated from authoritative payment
    and allocation records rather than supplied by the client.
    """

    payment_id: UUID
    customer_id: UUID
    status: PaymentStatus
    amount: PositiveMoney
    allocated_amount: NonnegativeMoney
    unallocated_amount: NonnegativeMoney

    @model_validator(mode="after")
    def validate_balance(self) -> PaymentBalanceResponse:
        if self.allocated_amount > self.amount:
            raise ValueError(
                "Allocated amount cannot exceed payment amount."
            )

        expected_unallocated = (
            self.amount - self.allocated_amount
        )

        if self.unallocated_amount != expected_unallocated:
            raise ValueError(
                "Unallocated payment balance does not reconcile."
            )

        return self


class InvoicePaymentAllocationResponse(PaymentSchema):
    """Payment allocation contributing to an invoice's settlement."""

    allocation_id: UUID
    payment_id: UUID
    invoice_id: UUID
    payment_date: date
    payment_status: PaymentStatus
    allocated_amount: PositiveMoney


class InvoicePaymentSummaryResponse(PaymentSchema):
    """
    Effective payment settlement of a customer invoice.

    Only allocations from posted, non-reversed payments count
    toward the effective paid amount.
    """

    invoice_id: UUID
    customer_id: UUID
    invoice_total: NonnegativeMoney
    credited_amount: NonnegativeMoney
    paid_amount: NonnegativeMoney
    outstanding_amount: NonnegativeMoney
    allocations: list[InvoicePaymentAllocationResponse]

    @model_validator(mode="after")
    def validate_invoice_balance(
        self,
    ) -> InvoicePaymentSummaryResponse:
        effective_allocations = sum(
            (
                allocation.allocated_amount
                for allocation in self.allocations
                if allocation.payment_status == "POSTED"
            ),
            Decimal("0.00"),
        )

        if self.paid_amount != effective_allocations:
            raise ValueError(
                "Paid amount must equal effective posted "
                "payment allocations."
            )

        expected_outstanding = (
            self.invoice_total
            - self.credited_amount
            - self.paid_amount
        )

        if expected_outstanding < Decimal("0"):
            raise ValueError(
                "Payments and credits cannot exceed invoice total."
            )

        if self.outstanding_amount != expected_outstanding:
            raise ValueError(
                "Invoice outstanding amount does not reconcile "
                "with payments and credits."
            )

        return self


class CustomerPaymentSummaryResponse(PaymentSchema):
    """Aggregated posted payment and unapplied balance for a customer."""

    customer_id: UUID
    posted_payment_count: int = Field(ge=0)
    total_posted_payments: NonnegativeMoney
    total_allocated_payments: NonnegativeMoney
    total_unallocated_payments: NonnegativeMoney

    @model_validator(mode="after")
    def validate_totals(self) -> CustomerPaymentSummaryResponse:
        if self.total_allocated_payments > self.total_posted_payments:
            raise ValueError(
                "Allocated payments cannot exceed posted payments."
            )

        if self.total_unallocated_payments != (
            self.total_posted_payments
            - self.total_allocated_payments
        ):
            raise ValueError(
                "Customer unapplied payment balance "
                "does not reconcile."
            )

        return self


class PaymentSummaryResponse(PaymentSchema):
    """Aggregated payment statuses and effective posted amounts."""

    payment_count: int = Field(ge=0)
    draft_count: int = Field(ge=0)
    posted_count: int = Field(ge=0)
    reversed_count: int = Field(ge=0)
    total_posted_amount: NonnegativeMoney
    total_allocated_amount: NonnegativeMoney
    total_unallocated_amount: NonnegativeMoney

    @model_validator(mode="after")
    def validate_summary(self) -> PaymentSummaryResponse:
        status_count = (
            self.draft_count
            + self.posted_count
            + self.reversed_count
        )

        if status_count != self.payment_count:
            raise ValueError(
                "Payment status counts must equal payment count."
            )

        if self.total_allocated_amount > self.total_posted_amount:
            raise ValueError(
                "Total allocations cannot exceed posted payments."
            )

        if self.total_unallocated_amount != (
            self.total_posted_amount
            - self.total_allocated_amount
        ):
            raise ValueError(
                "Unallocated payment total does not reconcile."
            )

        return self