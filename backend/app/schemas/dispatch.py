"""
Pydantic v2 schemas for finished-goods dispatch management.

The persisted response schemas correspond to the Development 03A
SQLAlchemy Dispatch and DispatchItem models.

A dispatch belongs to a posted invoice. Each dispatch item allocates
a positive quantity from a specific finished-goods stock batch to an
invoice line.

Draft dispatches do not affect inventory. Posting must atomically
validate authorized quantities, apply FEFO where required, deduct
warehouse inventory, update stock batches and balances, create
immutable stock movements, and update sales-order fulfillment status.

Posted dispatches must not be silently modified, deleted, or posted
again. The service layer enforces authorization and idempotency.
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


PositiveQuantity = Annotated[
    Decimal,
    Field(
        gt=0,
        max_digits=18,
        decimal_places=3,
        allow_inf_nan=False,
    ),
]

NonnegativeQuantity = Annotated[
    Decimal,
    Field(
        ge=0,
        max_digits=18,
        decimal_places=3,
        allow_inf_nan=False,
    ),
]

RequiredReason = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        min_length=1,
    ),
]

DeliveryReference = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        min_length=1,
        max_length=150,
    ),
]

DispatchStatus = Literal[
    "DRAFT",
    "POSTED",
    "CANCELLED",
]

FulfillmentStatus = Literal[
    "NOT_DISPATCHED",
    "PARTIALLY_DISPATCHED",
    "DISPATCHED",
]


class DispatchSchema(BaseModel):
    """Shared validation configuration for dispatch request schemas."""

    model_config = ConfigDict(
        extra="forbid",
        str_strip_whitespace=True,
    )


class DispatchResponseSchema(DispatchSchema):
    """Shared configuration for ORM-backed dispatch responses."""

    model_config = ConfigDict(
        from_attributes=True,
        extra="forbid",
        str_strip_whitespace=True,
    )


class DispatchItemCreate(DispatchSchema):
    """
    Batch-level allocation of finished goods to an invoice line.

    The service verifies that the product belongs to the invoice
    line, the batch belongs to the product, and the requested
    quantity is authorized and available.

    Multiple batches may fulfill the same invoice line.
    """

    invoice_item_id: UUID
    product_id: UUID
    batch_id: UUID
    quantity: PositiveQuantity


class DispatchCreate(DispatchSchema):
    """
    Create a draft dispatch against an existing posted invoice.

    The backend generates dispatch_number and validates the invoice,
    its approved sales order, batch allocations, and quantities.

    Draft creation must not deduct inventory.
    """

    invoice_id: UUID
    dispatch_date: date
    delivery_reference: DeliveryReference | None = None
    items: list[DispatchItemCreate] = Field(
        ...,
        min_length=1,
    )

    @model_validator(mode="after")
    def validate_allocations(self) -> DispatchCreate:
        allocation_keys = [
            (item.invoice_item_id, item.batch_id)
            for item in self.items
        ]

        if len(allocation_keys) != len(set(allocation_keys)):
            raise ValueError(
                "An invoice line and stock batch may appear "
                "only once in a dispatch."
            )

        product_by_invoice_line: dict[UUID, UUID] = {}

        for item in self.items:
            previous_product = product_by_invoice_line.get(
                item.invoice_item_id
            )

            if (
                previous_product is not None
                and previous_product != item.product_id
            ):
                raise ValueError(
                    "All batch allocations for an invoice line "
                    "must reference the same product."
                )

            product_by_invoice_line[item.invoice_item_id] = (
                item.product_id
            )

        return self


class DispatchUpdate(DispatchSchema):
    """
    Partial update of a draft dispatch header.

    Dispatch item changes must be validated against the invoice
    and current batch availability by the service layer.
    """

    dispatch_date: date | None = None
    delivery_reference: DeliveryReference | None = None

    @model_validator(mode="after")
    def validate_update(self) -> DispatchUpdate:
        if not self.model_fields_set:
            raise ValueError(
                "At least one dispatch field must be provided."
            )

        if (
            "dispatch_date" in self.model_fields_set
            and self.dispatch_date is None
        ):
            raise ValueError(
                "Dispatch date cannot be null."
            )

        return self


class DispatchItemUpdate(DispatchSchema):
    """
    Replacement batch allocation for an editable draft dispatch.

    The service must reject modifications to posted or cancelled
    dispatches and validate the referenced invoice line and batch.
    """

    invoice_item_id: UUID
    product_id: UUID
    batch_id: UUID
    quantity: PositiveQuantity


class DispatchItemsReplaceRequest(DispatchSchema):
    """
    Replace all allocations in an editable draft dispatch.

    The replacement must be performed transactionally so an
    invalid allocation cannot leave a partially updated draft.
    """

    items: list[DispatchItemUpdate] = Field(
        ...,
        min_length=1,
    )

    @model_validator(mode="after")
    def validate_allocations(self) -> DispatchItemsReplaceRequest:
        allocation_keys = [
            (item.invoice_item_id, item.batch_id)
            for item in self.items
        ]

        if len(allocation_keys) != len(set(allocation_keys)):
            raise ValueError(
                "Duplicate invoice-line and batch allocations "
                "are not permitted."
            )

        product_by_invoice_line: dict[UUID, UUID] = {}

        for item in self.items:
            previous_product = product_by_invoice_line.get(
                item.invoice_item_id
            )

            if (
                previous_product is not None
                and previous_product != item.product_id
            ):
                raise ValueError(
                    "An invoice line cannot reference different "
                    "products within one dispatch."
                )

            product_by_invoice_line[item.invoice_item_id] = (
                item.product_id
            )

        return self


class DispatchItemResponse(DispatchResponseSchema):
    """Persisted dispatch allocation for one invoice line and batch."""

    dispatch_item_id: UUID
    dispatch_id: UUID
    invoice_item_id: UUID
    product_id: UUID
    batch_id: UUID
    quantity: Decimal


class DispatchResponse(DispatchResponseSchema):
    """Persisted dispatch header with batch-level allocations."""

    dispatch_id: UUID
    invoice_id: UUID
    dispatch_number: str
    dispatch_date: date
    delivery_reference: str | None
    status: DispatchStatus
    posted_at: datetime | None
    items: list[DispatchItemResponse]


class DispatchListResponse(DispatchSchema):
    """Paginated dispatch listing."""

    items: list[DispatchResponse]
    total: int = Field(ge=0)
    page: int = Field(ge=1)
    page_size: int = Field(ge=1)


class DispatchPostRequest(DispatchSchema):
    """
    Request to post an existing draft dispatch.

    The backend must validate the posted invoice and approved
    order, lock relevant inventory rows, recheck quantities,
    apply batch eligibility and FEFO rules, and commit all stock
    and fulfillment changes in one transaction.

    A repeated posting request must not deduct stock twice.
    """


class DispatchPostResponse(DispatchSchema):
    """Result of successful transactional dispatch posting."""

    dispatch_id: UUID
    dispatch_number: str
    invoice_id: UUID
    status: Literal["POSTED"]
    posted_at: datetime
    dispatched_quantity: PositiveQuantity


class DispatchCancellationRequest(DispatchSchema):
    """
    Request to cancel an eligible draft dispatch.

    A posted dispatch must not be cancelled by deleting stock
    movements or silently restoring inventory. Any authorized
    correction requires a traceable reversal workflow.
    """

    reason: RequiredReason


class DispatchStatusResponse(DispatchSchema):
    """Compact response after a dispatch status transition."""

    dispatch_id: UUID
    dispatch_number: str
    invoice_id: UUID
    status: DispatchStatus
    posted_at: datetime | None


class DispatchInvoiceLineAvailability(DispatchSchema):
    """
    Remaining authorized dispatch quantity for an invoice line.

    Previously posted dispatch quantities are deducted from
    the invoice quantity to prevent over-dispatch.
    """

    invoice_item_id: UUID
    product_id: UUID
    invoiced_quantity: PositiveQuantity
    previously_dispatched_quantity: NonnegativeQuantity
    remaining_quantity: NonnegativeQuantity

    @model_validator(mode="after")
    def validate_remaining_quantity(
        self,
    ) -> DispatchInvoiceLineAvailability:
        expected_remaining = (
            self.invoiced_quantity
            - self.previously_dispatched_quantity
        )

        if expected_remaining < Decimal("0"):
            raise ValueError(
                "Previously dispatched quantity cannot exceed "
                "the invoiced quantity."
            )

        if self.remaining_quantity != expected_remaining:
            raise ValueError(
                "Remaining dispatch quantity does not reconcile "
                "with invoiced and previously dispatched quantities."
            )

        return self


class DispatchInvoiceAvailabilityResponse(DispatchSchema):
    """Dispatch authorization remaining for an invoice."""

    invoice_id: UUID
    lines: list[DispatchInvoiceLineAvailability]
    is_fully_dispatched: bool

    @model_validator(mode="after")
    def validate_summary(
        self,
    ) -> DispatchInvoiceAvailabilityResponse:
        expected_fully_dispatched = bool(self.lines) and all(
            line.remaining_quantity == Decimal("0")
            for line in self.lines
        )

        if self.is_fully_dispatched != expected_fully_dispatched:
            raise ValueError(
                "Invoice dispatch summary does not match "
                "the remaining line quantities."
            )

        return self


class DispatchBatchAvailability(DispatchSchema):
    """
    Eligible finished-goods stock for a batch.

    The backend calculates eligible_quantity after applying
    batch status, expiry, and applicable FEFO restrictions.
    """

    batch_id: UUID
    product_id: UUID
    batch_number: str
    manufacturing_date: date | None
    expiry_date: date | None
    quantity_remaining: NonnegativeQuantity
    eligible_quantity: NonnegativeQuantity

    @model_validator(mode="after")
    def validate_eligible_quantity(
        self,
    ) -> DispatchBatchAvailability:
        if self.eligible_quantity > self.quantity_remaining:
            raise ValueError(
                "Eligible batch quantity cannot exceed "
                "the remaining batch quantity."
            )

        return self


class DispatchAllocationPreviewLine(DispatchSchema):
    """
    Proposed batch allocation before posting.

    Preview allocations do not reserve inventory. Posting must
    revalidate stock under database locks.
    """

    invoice_item_id: UUID
    product_id: UUID
    batch_id: UUID
    batch_number: str
    expiry_date: date | None
    allocated_quantity: PositiveQuantity


class DispatchAllocationPreviewResponse(DispatchSchema):
    """Preview of batch allocations and any unfulfilled quantity."""

    invoice_item_id: UUID
    product_id: UUID
    requested_quantity: PositiveQuantity
    allocated_quantity: NonnegativeQuantity
    shortage_quantity: NonnegativeQuantity
    allocations: list[DispatchAllocationPreviewLine]

    @model_validator(mode="after")
    def validate_allocation_totals(
        self,
    ) -> DispatchAllocationPreviewResponse:
        expected_allocated = sum(
            (
                allocation.allocated_quantity
                for allocation in self.allocations
            ),
            Decimal("0.000"),
        )

        if self.allocated_quantity != expected_allocated:
            raise ValueError(
                "Allocated quantity does not match "
                "the batch allocation lines."
            )

        if self.allocated_quantity > self.requested_quantity:
            raise ValueError(
                "Allocated quantity cannot exceed "
                "the requested quantity."
            )

        expected_shortage = (
            self.requested_quantity - self.allocated_quantity
        )

        if self.shortage_quantity != expected_shortage:
            raise ValueError(
                "Shortage quantity does not reconcile "
                "with the allocation preview."
            )

        for allocation in self.allocations:
            if allocation.invoice_item_id != self.invoice_item_id:
                raise ValueError(
                    "Allocation references a different invoice line."
                )

            if allocation.product_id != self.product_id:
                raise ValueError(
                    "Allocation references a different product."
                )

        batch_ids = [
            allocation.batch_id
            for allocation in self.allocations
        ]

        if len(batch_ids) != len(set(batch_ids)):
            raise ValueError(
                "An allocation preview cannot repeat a stock batch."
            )

        return self


class DispatchFulfillmentLineResponse(DispatchSchema):
    """Fulfillment progress for a sales-order product line."""

    sales_order_item_id: UUID
    product_id: UUID
    ordered_quantity: PositiveQuantity
    dispatched_quantity: NonnegativeQuantity
    remaining_quantity: NonnegativeQuantity

    @model_validator(mode="after")
    def validate_fulfillment(
        self,
    ) -> DispatchFulfillmentLineResponse:
        expected_remaining = (
            self.ordered_quantity - self.dispatched_quantity
        )

        if expected_remaining < Decimal("0"):
            raise ValueError(
                "Dispatched quantity cannot exceed "
                "the authorized order quantity."
            )

        if self.remaining_quantity != expected_remaining:
            raise ValueError(
                "Remaining order quantity does not reconcile "
                "with dispatched quantity."
            )

        return self


class DispatchFulfillmentResponse(DispatchSchema):
    """Sales-order fulfillment after posted dispatch transactions."""

    sales_order_id: UUID
    fulfillment_status: FulfillmentStatus
    lines: list[DispatchFulfillmentLineResponse]

    @model_validator(mode="after")
    def validate_fulfillment_status(
        self,
    ) -> DispatchFulfillmentResponse:
        if not self.lines:
            raise ValueError(
                "Fulfillment status requires at least one order line."
            )

        total_dispatched = sum(
            (
                line.dispatched_quantity
                for line in self.lines
            ),
            Decimal("0.000"),
        )

        fully_dispatched = all(
            line.remaining_quantity == Decimal("0")
            for line in self.lines
        )

        if fully_dispatched:
            expected_status = "DISPATCHED"
        elif total_dispatched > Decimal("0"):
            expected_status = "PARTIALLY_DISPATCHED"
        else:
            expected_status = "NOT_DISPATCHED"

        if self.fulfillment_status != expected_status:
            raise ValueError(
                "Sales-order fulfillment status does not "
                "match posted dispatch quantities."
            )

        return self