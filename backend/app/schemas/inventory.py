"""
Pydantic v2 schemas for inventory balances, stock batches,
stock movements, stock adjustments, and stock availability.

Field names and status values correspond to the Development 03A
SQLAlchemy inventory models.

Stock movements are immutable records of posted transactions.
Inventory balances are maintained transactionally by the inventory
service, not directly edited through API request schemas.

The service layer enforces authorization, batch eligibility, FEFO,
stock availability, row-level locking, movement idempotency,
valuation consistency, and auditability.
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

NonnegativeUnitCost = Annotated[
    Decimal,
    Field(
        ge=0,
        max_digits=18,
        decimal_places=6,
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

BatchNumber = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        min_length=1,
        max_length=100,
    ),
]

SourceType = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        min_length=1,
        max_length=50,
    ),
]

InventoryLocation = Literal[
    "WAREHOUSE",
    "PRODUCTION_HELD",
]

MovementDirection = Literal[
    "IN",
    "OUT",
]

MovementType = Literal[
    "OPENING_BALANCE",
    "PURCHASE_RECEIPT",
    "PRODUCTION_ISSUE",
    "PRODUCTION_CONSUMPTION",
    "UNUSED_MATERIAL_RETURN",
    "PRODUCTION_WASTAGE",
    "PRODUCTION_OUTPUT",
    "DISPATCH",
    "STOCK_ADJUSTMENT",
    "REVERSAL",
]

StockAdjustmentStatus = Literal[
    "DRAFT",
    "SUBMITTED",
    "APPROVED",
    "REJECTED",
    "POSTED",
    "CANCELLED",
]


class InventorySchema(BaseModel):
    """Shared configuration for inventory request schemas."""

    model_config = ConfigDict(
        extra="forbid",
        str_strip_whitespace=True,
    )


class InventoryResponseSchema(InventorySchema):
    """Shared configuration for ORM-backed inventory responses."""

    model_config = ConfigDict(
        from_attributes=True,
        extra="forbid",
        str_strip_whitespace=True,
    )


class StockBatchResponse(InventoryResponseSchema):
    """Persisted, traceable inventory batch."""

    batch_id: UUID
    item_id: UUID
    batch_number: str
    source_type: str
    source_id: UUID
    initial_quantity: Decimal
    quantity_remaining: Decimal
    unit_cost: Decimal
    manufacturing_date: date | None
    expiry_date: date | None
    created_at: datetime


class StockBatchListResponse(InventorySchema):
    """Paginated inventory batch listing."""

    items: list[StockBatchResponse]
    total: int = Field(ge=0)
    page: int = Field(ge=1)
    page_size: int = Field(ge=1)


class StockMovementResponse(InventoryResponseSchema):
    """Immutable stock-ledger movement."""

    movement_id: UUID
    item_id: UUID
    batch_id: UUID | None
    movement_type: MovementType
    direction: MovementDirection
    location: InventoryLocation
    quantity: Decimal
    unit_cost: Decimal
    source_type: str
    source_id: UUID
    source_line_id: UUID
    reversal_of_id: UUID | None
    created_by: UUID
    created_at: datetime


class StockMovementListResponse(InventorySchema):
    """Paginated stock-ledger movements."""

    items: list[StockMovementResponse]
    total: int = Field(ge=0)
    page: int = Field(ge=1)
    page_size: int = Field(ge=1)


class InventoryBalanceResponse(InventoryResponseSchema):
    """Transactional inventory balance for one item and location."""

    balance_id: UUID
    item_id: UUID
    location: InventoryLocation
    quantity_on_hand: Decimal
    average_unit_cost: Decimal
    updated_at: datetime


class InventoryBalanceListResponse(InventorySchema):
    """Paginated item-and-location inventory balances."""

    items: list[InventoryBalanceResponse]
    total: int = Field(ge=0)
    page: int = Field(ge=1)
    page_size: int = Field(ge=1)


class StockAdjustmentItemCreate(InventorySchema):
    """Proposed stock adjustment for an item, batch, and location."""

    item_id: UUID
    batch_id: UUID | None = None
    location: InventoryLocation = "WAREHOUSE"
    direction: MovementDirection
    quantity: PositiveQuantity
    unit_cost: NonnegativeUnitCost = Decimal("0.000000")


class StockAdjustmentCreate(InventorySchema):
    """
    Create a draft stock adjustment.

    The adjustment number and creator are assigned by the backend.
    Creating the draft does not change stock.
    """

    reason: RequiredReason
    items: list[StockAdjustmentItemCreate] = Field(
        ...,
        min_length=1,
    )


class StockAdjustmentItemUpdate(InventorySchema):
    """Replacement values for an item in an editable draft adjustment."""

    item_id: UUID
    batch_id: UUID | None = None
    location: InventoryLocation = "WAREHOUSE"
    direction: MovementDirection
    quantity: PositiveQuantity
    unit_cost: NonnegativeUnitCost = Decimal("0.000000")


class StockAdjustmentUpdate(InventorySchema):
    """Editable draft adjustment reason and/or item list."""

    reason: RequiredReason | None = None
    items: list[StockAdjustmentItemUpdate] | None = Field(
        default=None,
        min_length=1,
    )

    @model_validator(mode="after")
    def validate_update(self) -> StockAdjustmentUpdate:
        if not self.model_fields_set:
            raise ValueError(
                "At least one stock-adjustment field must be provided."
            )

        if (
            "reason" in self.model_fields_set
            and self.reason is None
        ):
            raise ValueError(
                "Adjustment reason cannot be null."
            )

        if (
            "items" in self.model_fields_set
            and self.items is None
        ):
            raise ValueError(
                "Adjustment items cannot be null."
            )

        return self


class StockAdjustmentItemResponse(InventoryResponseSchema):
    """Persisted stock-adjustment line."""

    adjustment_item_id: UUID
    adjustment_id: UUID
    item_id: UUID
    batch_id: UUID | None
    location: InventoryLocation
    direction: MovementDirection
    quantity: Decimal
    unit_cost: Decimal


class StockAdjustmentResponse(InventoryResponseSchema):
    """Stock-adjustment header with its proposed or posted items."""

    adjustment_id: UUID
    adjustment_number: str
    reason: str
    status: StockAdjustmentStatus
    created_by: UUID
    approved_by: UUID | None
    approved_at: datetime | None
    posted_at: datetime | None
    created_at: datetime
    items: list[StockAdjustmentItemResponse]


class StockAdjustmentListResponse(InventorySchema):
    """Paginated stock-adjustment records."""

    items: list[StockAdjustmentResponse]
    total: int = Field(ge=0)
    page: int = Field(ge=1)
    page_size: int = Field(ge=1)


class StockAdjustmentDecisionRequest(InventorySchema):
    """Authorized approval or rejection of a submitted adjustment."""

    decision: Literal["APPROVED", "REJECTED"]
    reason: RequiredReason | None = None

    @model_validator(mode="after")
    def validate_decision(self) -> StockAdjustmentDecisionRequest:
        if (
            self.decision == "REJECTED"
            and self.reason is None
        ):
            raise ValueError(
                "A reason is required to reject a stock adjustment."
            )

        return self


class StockAdjustmentCancellationRequest(InventorySchema):
    """Request to cancel an eligible, unposted stock adjustment."""

    reason: RequiredReason


class StockAdjustmentStatusResponse(InventorySchema):
    """Result of an adjustment status transition."""

    adjustment_id: UUID
    adjustment_number: str
    status: StockAdjustmentStatus
    approved_by: UUID | None
    approved_at: datetime | None
    posted_at: datetime | None


class StockMovementReversalRequest(InventorySchema):
    """
    Request to reverse a posted movement.

    The service must validate reversal eligibility, ensure the
    original movement has not already been reversed, and post
    the reversing movement in the same transaction as the
    corresponding inventory balance and batch updates.
    """

    reason: RequiredReason


class StockAvailabilityRequest(InventorySchema):
    """Request available warehouse stock for an inventory item."""

    item_id: UUID
    requested_quantity: PositiveQuantity


class StockAvailabilityResponse(InventorySchema):
    """Warehouse stock availability and shortage."""

    item_id: UUID
    location: Literal["WAREHOUSE"] = "WAREHOUSE"
    requested_quantity: PositiveQuantity
    available_quantity: NonnegativeQuantity
    shortage_quantity: NonnegativeQuantity
    is_available: bool

    @model_validator(mode="after")
    def validate_availability(self) -> StockAvailabilityResponse:
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
                "Availability flag does not match the shortage."
            )

        return self


class StockSummaryResponse(InventorySchema):
    """Inventory summary calculated from posted movements and balances."""

    item_id: UUID
    item_name: str
    item_code: str
    item_type: str
    base_unit: str
    opening_quantity: NonnegativeQuantity
    receipts_quantity: NonnegativeQuantity
    issues_quantity: NonnegativeQuantity
    adjustments_quantity: Decimal = Field(
        max_digits=18,
        decimal_places=3,
        allow_inf_nan=False,
    )
    closing_quantity: NonnegativeQuantity
    average_unit_cost: NonnegativeUnitCost
    stock_value: Decimal = Field(
        ge=0,
        max_digits=18,
        decimal_places=2,
        allow_inf_nan=False,
    )

    @model_validator(mode="after")
    def validate_stock_reconciliation(self) -> StockSummaryResponse:
        expected_closing = (
            self.opening_quantity
            + self.receipts_quantity
            - self.issues_quantity
            + self.adjustments_quantity
        )

        if self.closing_quantity != expected_closing:
            raise ValueError(
                "Closing stock does not reconcile with "
                "opening stock and posted movements."
            )

        return self


class StockSummaryListResponse(InventorySchema):
    """Paginated inventory stock summary."""

    items: list[StockSummaryResponse]
    total: int = Field(ge=0)
    page: int = Field(ge=1)
    page_size: int = Field(ge=1)


class StockLedgerEntryResponse(InventorySchema):
    """Stock movement with its running quantity balance."""

    movement: StockMovementResponse
    quantity_in: NonnegativeQuantity
    quantity_out: NonnegativeQuantity
    running_balance: NonnegativeQuantity

    @model_validator(mode="after")
    def validate_direction(self) -> StockLedgerEntryResponse:
        quantity = self.movement.quantity

        if self.movement.direction == "IN":
            if (
                self.quantity_in != quantity
                or self.quantity_out != Decimal("0")
            ):
                raise ValueError(
                    "Incoming ledger quantity does not match "
                    "the stock movement."
                )
        else:
            if (
                self.quantity_out != quantity
                or self.quantity_in != Decimal("0")
            ):
                raise ValueError(
                    "Outgoing ledger quantity does not match "
                    "the stock movement."
                )

        return self


class StockLedgerResponse(InventorySchema):
    """Chronological stock ledger for one item and location."""

    item_id: UUID
    location: InventoryLocation
    opening_balance: NonnegativeQuantity
    closing_balance: NonnegativeQuantity
    entries: list[StockLedgerEntryResponse]

    @model_validator(mode="after")
    def validate_ledger(self) -> StockLedgerResponse:
        running = self.opening_balance

        for entry in self.entries:
            if entry.movement.item_id != self.item_id:
                raise ValueError(
                    "Ledger entry references a different inventory item."
                )

            if entry.movement.location != self.location:
                raise ValueError(
                    "Ledger entry references a different location."
                )

            running += (
                entry.quantity_in - entry.quantity_out
            )

            if running < Decimal("0"):
                raise ValueError(
                    "Ledger movement produces negative stock."
                )

            if entry.running_balance != running:
                raise ValueError(
                    "Ledger running balance does not reconcile."
                )

        if self.closing_balance != running:
            raise ValueError(
                "Ledger closing balance does not reconcile."
            )

        return self


class BatchAvailabilityResponse(InventorySchema):
    """Dispatch-eligible quantity for a traceable stock batch."""

    batch_id: UUID
    item_id: UUID
    batch_number: str
    expiry_date: date | None
    quantity_remaining: NonnegativeQuantity
    eligible_quantity: NonnegativeQuantity

    @model_validator(mode="after")
    def validate_eligible_quantity(self) -> BatchAvailabilityResponse:
        if self.eligible_quantity > self.quantity_remaining:
            raise ValueError(
                "Eligible quantity cannot exceed remaining batch stock."
            )

        return self


class InventoryValuationResponse(InventorySchema):
    """Inventory valuation for an item at a specified location."""

    item_id: UUID
    location: InventoryLocation
    quantity_on_hand: NonnegativeQuantity
    average_unit_cost: NonnegativeUnitCost
    stock_value: Decimal = Field(
        ge=0,
        max_digits=18,
        decimal_places=2,
        allow_inf_nan=False,
    )
    as_of: datetime