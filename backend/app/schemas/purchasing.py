"""
Pydantic v2 schemas for purchase orders and goods receipts.

These schemas follow the Development 03A SQLAlchemy models:

- PurchaseOrder
- PurchaseOrderItem
- GoodsReceipt
- GoodsReceiptItem

Purchase orders represent commercial commitments. Inventory increases
only when a goods receipt is posted.

The service layer is responsible for authorization, supplier and item
validation, purchase-order status transitions, receipt quantity limits,
transactional stock posting, idempotency, and audit logging.

All monetary and quantity inputs use Decimal-compatible validation.
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

DocumentNumber = Annotated[
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

PurchaseOrderStatus = Literal[
    "DRAFT",
    "SUBMITTED",
    "APPROVED",
    "REJECTED",
    "PARTIALLY_RECEIVED",
    "RECEIVED",
    "CANCELLED",
]

GoodsReceiptStatus = Literal[
    "DRAFT",
    "POSTED",
    "CANCELLED",
]


class PurchasingSchema(BaseModel):
    """Shared configuration for purchasing request schemas."""

    model_config = ConfigDict(
        extra="forbid",
        str_strip_whitespace=True,
    )


class PurchasingResponseSchema(PurchasingSchema):
    """Shared configuration for ORM-backed purchasing responses."""

    model_config = ConfigDict(
        from_attributes=True,
        extra="forbid",
        str_strip_whitespace=True,
    )


class PurchaseOrderItemCreate(PurchasingSchema):
    """
    Purchase-order line for a raw or packaging inventory item.

    The backend calculates line_total from quantity, unit_price,
    and applicable tax. Client-calculated totals are not accepted.
    """

    item_id: UUID
    quantity: Quantity
    unit_price: Money
    tax_rate: TaxRate = Decimal("0.0000")


class PurchaseOrderItemUpdate(PurchasingSchema):
    """Partial update of an editable purchase-order line."""

    quantity: Quantity | None = None
    unit_price: Money | None = None
    tax_rate: TaxRate | None = None

    @model_validator(mode="after")
    def validate_update(self) -> PurchaseOrderItemUpdate:
        if not self.model_fields_set:
            raise ValueError(
                "At least one purchase-order item field must be provided."
            )

        for field_name in self.model_fields_set:
            if getattr(self, field_name) is None:
                raise ValueError(
                    f"{field_name} cannot be null."
                )

        return self


class PurchaseOrderCreate(PurchasingSchema):
    """
    Request to create a supplier purchase order.

    The backend generates the purchase-order number and assigns
    created_by from the authenticated user.

    Creating a purchase order must not create stock movements.
    """

    supplier_id: UUID
    order_date: date
    expected_date: date | None = None
    items: list[PurchaseOrderItemCreate] = Field(
        ...,
        min_length=1,
    )

    @model_validator(mode="after")
    def validate_purchase_order(self) -> PurchaseOrderCreate:
        if (
            self.expected_date is not None
            and self.expected_date < self.order_date
        ):
            raise ValueError(
                "Expected date cannot precede order date."
            )

        item_ids = [
            item.item_id
            for item in self.items
        ]

        if len(item_ids) != len(set(item_ids)):
            raise ValueError(
                "A purchase order cannot contain duplicate inventory items."
            )

        return self


class PurchaseOrderUpdate(PurchasingSchema):
    """
    Partial update of an editable purchase-order header.

    The service must reject changes to purchase orders whose
    current status does not permit editing.
    """

    supplier_id: UUID | None = None
    order_date: date | None = None
    expected_date: date | None = None

    @model_validator(mode="after")
    def validate_update(self) -> PurchaseOrderUpdate:
        if not self.model_fields_set:
            raise ValueError(
                "At least one purchase-order field must be provided."
            )

        for field_name in (
            "supplier_id",
            "order_date",
        ):
            if (
                field_name in self.model_fields_set
                and getattr(self, field_name) is None
            ):
                raise ValueError(
                    f"{field_name} cannot be null."
                )

        if (
            self.order_date is not None
            and self.expected_date is not None
            and self.expected_date < self.order_date
        ):
            raise ValueError(
                "Expected date cannot precede order date."
            )

        return self


class PurchaseOrderItemResponse(PurchasingResponseSchema):
    """Persisted purchase-order item."""

    po_item_id: UUID
    purchase_order_id: UUID
    item_id: UUID
    quantity: Decimal
    unit_price: Decimal
    tax_rate: Decimal
    line_total: Decimal


class PurchaseOrderResponse(PurchasingResponseSchema):
    """Purchase-order header with its persisted items."""

    purchase_order_id: UUID
    supplier_id: UUID
    po_number: str
    order_date: date
    expected_date: date | None
    status: PurchaseOrderStatus
    created_by: UUID
    items: list[PurchaseOrderItemResponse]


class PurchaseOrderListResponse(PurchasingSchema):
    """Paginated purchase-order listing."""

    items: list[PurchaseOrderResponse]
    total: int = Field(ge=0)
    page: int = Field(ge=1)
    page_size: int = Field(ge=1)


class PurchaseOrderStatusUpdateRequest(PurchasingSchema):
    """
    Request an authorized purchase-order status transition.

    Receipt-related statuses must be derived from posted goods
    receipts rather than directly assigned by an API client.
    """

    status: Literal[
        "SUBMITTED",
        "APPROVED",
        "REJECTED",
        "CANCELLED",
    ]
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
    def validate_status_change(
        self,
    ) -> PurchaseOrderStatusUpdateRequest:
        if (
            self.status in ("REJECTED", "CANCELLED")
            and not self.reason
        ):
            raise ValueError(
                "A reason is required for rejection or cancellation."
            )

        return self


class PurchaseOrderStatusResponse(PurchasingSchema):
    """Result of a purchase-order status transition."""

    purchase_order_id: UUID
    po_number: str
    status: PurchaseOrderStatus


class GoodsReceiptItemCreate(PurchasingSchema):
    """
    Physical quantities received against a purchase-order line.

    Accepted and rejected quantities must reconcile exactly
    with the total received quantity.

    Only accepted quantities may increase available inventory.
    """

    po_item_id: UUID
    received_quantity: Quantity
    accepted_quantity: NonnegativeQuantity
    rejected_quantity: NonnegativeQuantity = Decimal("0.000")

    @model_validator(mode="after")
    def validate_received_quantities(
        self,
    ) -> GoodsReceiptItemCreate:
        if (
            self.accepted_quantity + self.rejected_quantity
            != self.received_quantity
        ):
            raise ValueError(
                "Accepted and rejected quantities must equal "
                "the received quantity."
            )

        return self


class GoodsReceiptItemUpdate(PurchasingSchema):
    """Editable quantities for a draft goods-receipt line."""

    received_quantity: Quantity
    accepted_quantity: NonnegativeQuantity
    rejected_quantity: NonnegativeQuantity = Decimal("0.000")

    @model_validator(mode="after")
    def validate_received_quantities(
        self,
    ) -> GoodsReceiptItemUpdate:
        if (
            self.accepted_quantity + self.rejected_quantity
            != self.received_quantity
        ):
            raise ValueError(
                "Accepted and rejected quantities must equal "
                "the received quantity."
            )

        return self


class GoodsReceiptCreate(PurchasingSchema):
    """
    Request to record a physical goods receipt.

    The receipt is initially a draft. Posting is a separate,
    authorized operation that must atomically update inventory.

    The backend generates receipt_number and obtains received_by
    from the authenticated user.
    """

    purchase_order_id: UUID
    received_date: date
    items: list[GoodsReceiptItemCreate] = Field(
        ...,
        min_length=1,
    )

    @model_validator(mode="after")
    def validate_receipt(self) -> GoodsReceiptCreate:
        po_item_ids = [
            item.po_item_id
            for item in self.items
        ]

        if len(po_item_ids) != len(set(po_item_ids)):
            raise ValueError(
                "A goods receipt cannot contain duplicate "
                "purchase-order lines."
            )

        return self


class GoodsReceiptUpdate(PurchasingSchema):
    """
    Partial update of a draft goods-receipt header.

    The backend must prohibit modifications to posted receipts.
    """

    received_date: date | None = None

    @model_validator(mode="after")
    def validate_update(self) -> GoodsReceiptUpdate:
        if "received_date" not in self.model_fields_set:
            raise ValueError(
                "A received date must be provided."
            )

        if self.received_date is None:
            raise ValueError(
                "Received date cannot be null."
            )

        return self


class GoodsReceiptItemResponse(PurchasingResponseSchema):
    """Persisted physical receipt quantities."""

    receipt_item_id: UUID
    receipt_id: UUID
    po_item_id: UUID
    received_quantity: Decimal
    accepted_quantity: Decimal
    rejected_quantity: Decimal


class GoodsReceiptResponse(PurchasingResponseSchema):
    """Goods-receipt header and its physical receipt lines."""

    receipt_id: UUID
    purchase_order_id: UUID
    receipt_number: str
    received_date: date
    received_by: UUID
    status: GoodsReceiptStatus
    posted_at: datetime | None
    items: list[GoodsReceiptItemResponse]


class GoodsReceiptListResponse(PurchasingSchema):
    """Paginated goods-receipt listing."""

    items: list[GoodsReceiptResponse]
    total: int = Field(ge=0)
    page: int = Field(ge=1)
    page_size: int = Field(ge=1)


class GoodsReceiptPostResponse(PurchasingSchema):
    """
    Result of posting an existing goods receipt.

    The inventory service must ensure that the posting is
    atomic and idempotent, including creation of stock
    batches, stock movements, and updated stock balances.
    """

    receipt_id: UUID
    receipt_number: str
    status: Literal["POSTED"]
    posted_at: datetime
    accepted_total_quantity: NonnegativeQuantity
    rejected_total_quantity: NonnegativeQuantity


class GoodsReceiptCancellationRequest(PurchasingSchema):
    """
    Request to cancel an eligible draft goods receipt.

    Posted receipts cannot be cancelled by deleting or
    silently reversing their historical stock movements.
    """

    reason: RequiredReason


class PurchaseOrderReceiptLineStatus(PurchasingSchema):
    """Receipt progress for one purchase-order item."""

    po_item_id: UUID
    item_id: UUID
    ordered_quantity: Quantity
    accepted_quantity: NonnegativeQuantity
    remaining_quantity: NonnegativeQuantity

    @model_validator(mode="after")
    def validate_remaining_quantity(
        self,
    ) -> PurchaseOrderReceiptLineStatus:
        expected_remaining = (
            self.ordered_quantity - self.accepted_quantity
        )

        if expected_remaining < Decimal("0"):
            raise ValueError(
                "Accepted quantity cannot exceed ordered quantity."
            )

        if self.remaining_quantity != expected_remaining:
            raise ValueError(
                "Remaining quantity does not reconcile with "
                "ordered and accepted quantities."
            )

        return self


class PurchaseOrderReceiptStatusResponse(PurchasingSchema):
    """Aggregated receipt progress for a purchase order."""

    purchase_order_id: UUID
    po_number: str
    status: PurchaseOrderStatus
    lines: list[PurchaseOrderReceiptLineStatus]
    is_fully_received: bool

    @model_validator(mode="after")
    def validate_receipt_status(
        self,
    ) -> PurchaseOrderReceiptStatusResponse:
        expected_fully_received = bool(self.lines) and all(
            line.remaining_quantity == Decimal("0")
            for line in self.lines
        )

        if self.is_fully_received != expected_fully_received:
            raise ValueError(
                "Purchase-order receipt summary does not "
                "match its item quantities."
            )

        return self