
"""
Pydantic v2 schemas for sales orders, order lines, approval decisions,
fulfillment status, and stock-availability checks.

Field names and status values correspond to the Development 03A
SQLAlchemy models in app.models.sales.

Sales order approval, fulfillment, and offline synchronization are
distinct concerns. Synchronization state is not an order approval
status and is handled by the synchronization module.

The service layer is responsible for authorization, customer
assignments, price verification, stock checks, database transactions,
and audit history.
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
    field_validator,
    model_validator,
)


Quantity = Annotated[
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

Money = Annotated[
    Decimal,
    Field(
        ge=0,
        max_digits=18,
        decimal_places=2,
        allow_inf_nan=False,
    ),
]

TaxRate = Annotated[
    Decimal,
    Field(
        ge=0,
        le=100,
        max_digits=7,
        decimal_places=4,
        allow_inf_nan=False,
    ),
]

OrderNumber = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        min_length=1,
        max_length=100,
    ),
]

RequiredReason = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        min_length=1,
    ),
]

ApprovalStatus = Literal[
    "DRAFT",
    "SUBMITTED",
    "APPROVED",
    "REJECTED",
    "CANCELLED",
]

FulfillmentStatus = Literal[
    "NOT_DISPATCHED",
    "PARTIALLY_DISPATCHED",
    "DISPATCHED",
]


class SalesSchema(BaseModel):
    """Shared configuration for sales request schemas."""

    model_config = ConfigDict(
        extra="forbid",
        str_strip_whitespace=True,
    )


class SalesResponseSchema(SalesSchema):
    """Shared configuration for ORM-backed sales responses."""

    model_config = ConfigDict(
        from_attributes=True,
        extra="forbid",
        str_strip_whitespace=True,
    )


class SalesOrderItemCreate(SalesSchema):
    """
    Product line submitted with a sales order.

    Selling prices and GST rates are resolved from approved
    product or customer pricing by the backend service.
    """

    product_id: UUID
    quantity: Quantity


class SalesOrderItemUpdate(SalesSchema):
    """
    Editable order-line values for authorized administrative review.

    A supplied unit price or tax rate is subject to backend
    authorization and business-rule validation.
    """

    quantity: Quantity | None = None
    unit_price: Money | None = None
    tax_rate: TaxRate | None = None

    @model_validator(mode="after")
    def validate_update(self) -> SalesOrderItemUpdate:
        if not self.model_fields_set:
            raise ValueError(
                "At least one order-line field must be provided."
            )

        for field_name in self.model_fields_set:
            if getattr(self, field_name) is None:
                raise ValueError(
                    f"{field_name} cannot be null."
                )

        return self


class SalesOrderCreate(SalesSchema):
    """
    Request to create a sales order.

    The authenticated user's identity determines the salesman
    unless an authorized administrative workflow explicitly
    assigns another user.

    Order numbers, totals, and posting states are generated
    or calculated by the backend.
    """

    customer_id: UUID
    order_date: date
    required_date: date | None = None
    notes: str | None = None
    items: list[SalesOrderItemCreate] = Field(
        ...,
        min_length=1,
    )

    @model_validator(mode="after")
    def validate_order(self) -> SalesOrderCreate:
        if (
            self.required_date is not None
            and self.required_date < self.order_date
        ):
            raise ValueError(
                "Required date cannot precede order date."
            )

        product_ids = [
            item.product_id
            for item in self.items
        ]

        if len(product_ids) != len(set(product_ids)):
            raise ValueError(
                "A product may appear only once in a sales order."
            )

        return self


class SalesOrderUpdate(SalesSchema):
    """
    Partial update of an editable sales order.

    The service must verify the current approval status
    before allowing modifications.
    """

    customer_id: UUID | None = None
    required_date: date | None = None
    notes: str | None = None

    @model_validator(mode="after")
    def validate_update(self) -> SalesOrderUpdate:
        if not self.model_fields_set:
            raise ValueError(
                "At least one sales-order field must be provided."
            )

        if (
            "customer_id" in self.model_fields_set
            and self.customer_id is None
        ):
            raise ValueError(
                "Customer ID cannot be null."
            )

        return self


class SalesOrderItemResponse(SalesResponseSchema):
    """Persisted sales order line with transaction-time prices."""

    sales_order_item_id: UUID
    sales_order_id: UUID
    line_number: int = Field(gt=0)
    product_id: UUID
    quantity: Decimal
    unit_price: Decimal
    tax_rate: Decimal
    line_subtotal: Decimal
    tax_amount: Decimal
    line_total: Decimal


class OrderApprovalHistoryResponse(SalesResponseSchema):
    """Immutable record of an order approval-status transition."""

    approval_history_id: UUID
    sales_order_id: UUID
    previous_status: ApprovalStatus
    new_status: ApprovalStatus
    decided_by: UUID
    reason: str | None
    decided_at: datetime


class SalesOrderResponse(SalesResponseSchema):
    """Sales order header and its persisted item lines."""

    sales_order_id: UUID
    order_number: str
    customer_id: UUID
    salesman_id: UUID
    order_date: date
    required_date: date | None
    approval_status: ApprovalStatus
    fulfillment_status: FulfillmentStatus
    subtotal: Decimal
    tax_total: Decimal
    grand_total: Decimal
    notes: str | None
    created_at: datetime
    updated_at: datetime
    items: list[SalesOrderItemResponse]


class SalesOrderDetailResponse(SalesOrderResponse):
    """Sales order with its append-only approval history."""

    approval_history: list[OrderApprovalHistoryResponse]


class SalesOrderListResponse(SalesSchema):
    """Paginated sales order listing."""

    items: list[SalesOrderResponse]
    total: int = Field(ge=0)
    page: int = Field(ge=1)
    page_size: int = Field(ge=1)


class SalesOrderSubmitRequest(SalesSchema):
    """
    Request to submit a draft sales order.

    The backend must validate ownership, customer assignment,
    item prices, and the current approval status.
    """

    @classmethod
    def for_submission(cls) -> SalesOrderSubmitRequest:
        return cls()


class SalesOrderApprovalRequest(SalesSchema):
    """
    Administrative approval or rejection decision.

    Only authorized Factory Admin users may make these decisions.
    The backend must create an OrderApprovalHistory record
    whenever the approval status changes.
    """

    decision: Literal["APPROVED", "REJECTED"]
    reason: str | None = None

    @field_validator("reason")
    @classmethod
    def normalize_reason(
        cls,
        value: str | None,
    ) -> str | None:
        if value is None:
            return None

        normalized = value.strip()
        return normalized or None

    @model_validator(mode="after")
    def validate_decision(self) -> SalesOrderApprovalRequest:
        if (
            self.decision == "REJECTED"
            and not self.reason
        ):
            raise ValueError(
                "A rejection reason is required."
            )

        return self


class SalesOrderCancellationRequest(SalesSchema):
    """Request to cancel an eligible order with an auditable reason."""

    reason: RequiredReason


class SalesOrderDecisionResponse(SalesSchema):
    """Order approval result and the recorded decision history."""

    sales_order_id: UUID
    approval_status: ApprovalStatus
    fulfillment_status: FulfillmentStatus
    decision_history: OrderApprovalHistoryResponse


class SalesOrderStatusResponse(SalesSchema):
    """Compact order status for the salesman workspace."""

    sales_order_id: UUID
    order_number: str
    approval_status: ApprovalStatus
    fulfillment_status: FulfillmentStatus
    updated_at: datetime


class StockAvailabilityLine(SalesSchema):
    """Available stock and shortage for a requested product."""

    product_id: UUID
    requested_quantity: Quantity
    available_quantity: NonnegativeQuantity
    shortage_quantity: NonnegativeQuantity
    is_available: bool

    @model_validator(mode="after")
    def validate_availability(self) -> StockAvailabilityLine:
        expected_shortage = max(
            Decimal("0"),
            self.requested_quantity - self.available_quantity,
        )

        if self.shortage_quantity != expected_shortage:
            raise ValueError(
                "Shortage quantity does not reconcile with "
                "requested and available quantities."
            )

        if self.is_available != (expected_shortage == 0):
            raise ValueError(
                "Availability status does not match "
                "the calculated stock shortage."
            )

        return self


class SalesOrderAvailabilityResponse(SalesSchema):
    """
    Order-level stock availability.

    Stock shortages are reported independently of approval status.
    Actual dispatch posting must recheck stock transactionally.
    """

    sales_order_id: UUID
    is_fully_available: bool
    lines: list[StockAvailabilityLine]

    @model_validator(mode="after")
    def validate_summary(self) -> SalesOrderAvailabilityResponse:
        expected = all(
            line.is_available
            for line in self.lines
        )

        if self.is_fully_available != expected:
            raise ValueError(
                "Order availability does not match its line results."
            )

        return self


class SalesOrderSummaryResponse(SalesSchema):
    """Aggregated order totals for a sales dashboard."""

    order_count: int = Field(ge=0)
    draft_count: int = Field(ge=0)
    submitted_count: int = Field(ge=0)
    approved_count: int = Field(ge=0)
    rejected_count: int = Field(ge=0)
    cancelled_count: int = Field(ge=0)
    total_order_value: Money

    @model_validator(mode="after")
    def validate_counts(self) -> SalesOrderSummaryResponse:
        status_total = (
            self.draft_count
            + self.submitted_count
            + self.approved_count
            + self.rejected_count
            + self.cancelled_count
        )

        if status_total != self.order_count:
            raise ValueError(
                "Approval-status counts must equal total order count."
            )

        return self
