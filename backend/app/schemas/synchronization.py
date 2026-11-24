"""
Pydantic v2 schemas for offline sales-order synchronization.

The server-side synchronization record is defined by the existing
app.models.audit.SyncRecord SQLAlchemy model.

Offline sales orders use stable client-generated UUIDs and idempotency
keys. A successful synchronization creates an authoritative sales order
and its synchronization record within the same database transaction.

Synchronization status is independent of sales-order approval status.
A synchronized order is not automatically approved.

The service layer enforces authentication, customer assignments,
product validity, payload consistency, duplicate prevention,
transaction integrity, and conflict reporting.
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

IdempotencyKey = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        min_length=1,
        max_length=255,
    ),
]

SyncStatus = Literal[
    "PENDING",
    "SYNCED",
    "FAILED",
    "CONFLICT",
]

ClientSyncStatus = Literal[
    "LOCAL_DRAFT",
    "PENDING_SYNC",
    "SYNCING",
    "SYNCED",
    "SYNC_FAILED",
    "CONFLICT",
]

OrderApprovalStatus = Literal[
    "DRAFT",
    "SUBMITTED",
    "APPROVED",
    "REJECTED",
    "CANCELLED",
]


class SynchronizationSchema(BaseModel):
    """Shared configuration for synchronization request schemas."""

    model_config = ConfigDict(
        extra="forbid",
        str_strip_whitespace=True,
    )


class SynchronizationResponseSchema(SynchronizationSchema):
    """Shared configuration for ORM-backed synchronization responses."""

    model_config = ConfigDict(
        from_attributes=True,
        extra="forbid",
        str_strip_whitespace=True,
    )


class OfflineSalesOrderItem(SynchronizationSchema):
    """
    Product and quantity captured while offline.

    Product prices and GST rates are resolved or validated against
    authoritative server records during synchronization.
    """

    product_id: UUID
    quantity: PositiveQuantity


class OfflineSalesOrder(SynchronizationSchema):
    """
    Locally captured sales order submitted for synchronization.

    The local_order_id and idempotency_key must remain unchanged
    across retries, including retries following a lost response.

    The authenticated server session determines the Salesman
    identity. A client-supplied user identity is not trusted.
    """

    local_order_id: UUID
    idempotency_key: IdempotencyKey
    customer_id: UUID
    order_date: date
    required_date: date | None = None
    notes: str | None = None
    items: list[OfflineSalesOrderItem] = Field(
        ...,
        min_length=1,
    )

    @model_validator(mode="after")
    def validate_order(self) -> OfflineSalesOrder:
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
                "An offline order cannot contain duplicate products."
            )

        return self


class OfflineSalesOrderSyncRequest(OfflineSalesOrder):
    """Submit one offline sales order for authoritative synchronization."""


class OfflineSalesOrderBatchSyncRequest(SynchronizationSchema):
    """
    Submit multiple offline sales orders.

    The synchronization service must process each order with
    transaction isolation appropriate to its idempotency key.
    A failure in one order must not falsely mark another as synced.
    """

    orders: list[OfflineSalesOrder] = Field(
        ...,
        min_length=1,
        max_length=100,
    )

    @model_validator(mode="after")
    def validate_unique_identifiers(
        self,
    ) -> OfflineSalesOrderBatchSyncRequest:
        local_order_ids = [
            order.local_order_id
            for order in self.orders
        ]

        idempotency_keys = [
            order.idempotency_key
            for order in self.orders
        ]

        if len(local_order_ids) != len(set(local_order_ids)):
            raise ValueError(
                "A synchronization batch cannot contain "
                "duplicate local order identifiers."
            )

        if len(idempotency_keys) != len(set(idempotency_keys)):
            raise ValueError(
                "A synchronization batch cannot contain "
                "duplicate idempotency keys."
            )

        return self


class SyncRecordResponse(SynchronizationResponseSchema):
    """
    Persisted authoritative synchronization record.

    Fields correspond to app.models.audit.SyncRecord.
    """

    sync_id: UUID
    user_id: UUID
    order_id: UUID | None
    local_order_id: UUID
    idempotency_key: str
    sync_status: SyncStatus
    synced_at: datetime | None
    error_message: str | None

    @model_validator(mode="after")
    def validate_record(self) -> SyncRecordResponse:
        if self.sync_status == "SYNCED":
            if self.order_id is None or self.synced_at is None:
                raise ValueError(
                    "A synchronized record must contain "
                    "a server order ID and synchronization timestamp."
                )
        elif self.synced_at is not None:
            raise ValueError(
                "Only synchronized records may have "
                "a synchronization timestamp."
            )

        return self


class OfflineSalesOrderSyncResult(SynchronizationSchema):
    """
    Authoritative result for one offline order.

    Repeated identical submissions return the existing accepted
    order reference. Conflicting payloads must not overwrite
    previously accepted transactions.
    """

    local_order_id: UUID
    idempotency_key: IdempotencyKey
    sync_status: SyncStatus
    sync_id: UUID | None = None
    order_id: UUID | None = None
    order_number: str | None = None
    approval_status: OrderApprovalStatus | None = None
    synced_at: datetime | None = None
    error_message: str | None = None

    @model_validator(mode="after")
    def validate_result(self) -> OfflineSalesOrderSyncResult:
        if self.sync_status == "SYNCED":
            if (
                self.sync_id is None
                or self.order_id is None
                or self.order_number is None
                or self.synced_at is None
                or self.approval_status is None
            ):
                raise ValueError(
                    "Successful synchronization requires "
                    "the persisted synchronization reference, "
                    "official order reference, approval status, "
                    "and synchronization timestamp."
                )

            if self.error_message is not None:
                raise ValueError(
                    "Successful synchronization cannot contain "
                    "an error message."
                )

        elif self.synced_at is not None:
            raise ValueError(
                "Unsuccessful or pending synchronization "
                "cannot have a synchronization timestamp."
            )

        return self


class OfflineSalesOrderBatchSyncResponse(SynchronizationSchema):
    """Per-order outcomes for a synchronization batch."""

    results: list[OfflineSalesOrderSyncResult]
    total: int = Field(ge=0)
    synced_count: int = Field(ge=0)
    pending_count: int = Field(ge=0)
    failed_count: int = Field(ge=0)
    conflict_count: int = Field(ge=0)

    @model_validator(mode="after")
    def validate_counts(
        self,
    ) -> OfflineSalesOrderBatchSyncResponse:
        if self.total != len(self.results):
            raise ValueError(
                "Synchronization total must match result count."
            )

        actual_counts = {
            "SYNCED": 0,
            "PENDING": 0,
            "FAILED": 0,
            "CONFLICT": 0,
        }

        for result in self.results:
            actual_counts[result.sync_status] += 1

        if (
            self.synced_count != actual_counts["SYNCED"]
            or self.pending_count != actual_counts["PENDING"]
            or self.failed_count != actual_counts["FAILED"]
            or self.conflict_count != actual_counts["CONFLICT"]
        ):
            raise ValueError(
                "Synchronization status counts do not "
                "match the individual results."
            )

        return self


class SyncRecordListResponse(SynchronizationSchema):
    """Paginated synchronization history."""

    items: list[SyncRecordResponse]
    total: int = Field(ge=0)
    page: int = Field(ge=1)
    page_size: int = Field(ge=1)


class SyncStatusQuery(SynchronizationSchema):
    """
    Look up an offline order's authoritative synchronization state.

    The service must scope the lookup to the authenticated user.
    """

    local_order_id: UUID


class SyncStatusResponse(SynchronizationSchema):
    """Server-side synchronization status and linked order reference."""

    local_order_id: UUID
    sync_status: SyncStatus
    sync_id: UUID | None
    order_id: UUID | None
    order_number: str | None
    approval_status: OrderApprovalStatus | None
    synced_at: datetime | None
    error_message: str | None

    @model_validator(mode="after")
    def validate_status(self) -> SyncStatusResponse:
        if self.sync_status == "SYNCED":
            if (
                self.sync_id is None
                or self.order_id is None
                or self.order_number is None
                or self.approval_status is None
                or self.synced_at is None
            ):
                raise ValueError(
                    "A synchronized order must have "
                    "its official server references."
                )

        elif self.synced_at is not None:
            raise ValueError(
                "Only synchronized orders may have "
                "a synchronization timestamp."
            )

        return self


class SyncConflictResponse(SynchronizationSchema):
    """
    Conflict details for an offline submission requiring review.

    The server does not automatically overwrite existing records
    or alter a previously accepted order.
    """

    local_order_id: UUID
    idempotency_key: IdempotencyKey
    sync_status: Literal["CONFLICT"] = "CONFLICT"
    error_message: str = Field(min_length=1)
    existing_order_id: UUID | None = None
    requires_user_action: bool = True


class SyncRetryRequest(SynchronizationSchema):
    """
    Retry an offline order using its original identifiers.

    The complete order payload is required so the backend can
    verify that the retry matches the original submission.
    """

    order: OfflineSalesOrder


class OfflineSyncQueueItem(SynchronizationSchema):
    """
    Client-side queue representation for an offline sales order.

    This is a transport schema, not an additional database table.
    Local drafts and pending orders remain stored in IndexedDB
    until successful synchronization or authorized removal.
    """

    local_order_id: UUID
    idempotency_key: IdempotencyKey
    customer_id: UUID
    created_at: datetime
    updated_at: datetime
    client_status: ClientSyncStatus
    retry_count: int = Field(default=0, ge=0)
    last_attempt_at: datetime | None = None
    server_order_id: UUID | None = None
    server_order_number: str | None = None
    error_message: str | None = None

    @model_validator(mode="after")
    def validate_queue_item(self) -> OfflineSyncQueueItem:
        if self.updated_at < self.created_at:
            raise ValueError(
                "Queue update time cannot precede creation time."
            )

        if self.client_status == "SYNCED":
            if (
                self.server_order_id is None
                or self.server_order_number is None
            ):
                raise ValueError(
                    "A synchronized local order must retain "
                    "its official server reference."
                )

        return self


class OfflineSyncQueueSummary(SynchronizationSchema):
    """Client-side synchronization queue status counts."""

    total: int = Field(ge=0)
    local_draft_count: int = Field(ge=0)
    pending_count: int = Field(ge=0)
    syncing_count: int = Field(ge=0)
    synced_count: int = Field(ge=0)
    failed_count: int = Field(ge=0)
    conflict_count: int = Field(ge=0)
    last_successful_sync_at: datetime | None = None

    @model_validator(mode="after")
    def validate_queue_counts(
        self,
    ) -> OfflineSyncQueueSummary:
        expected_total = (
            self.local_draft_count
            + self.pending_count
            + self.syncing_count
            + self.synced_count
            + self.failed_count
            + self.conflict_count
        )

        if self.total != expected_total:
            raise ValueError(
                "Offline queue total does not match "
                "the synchronization status counts."
            )

        return self