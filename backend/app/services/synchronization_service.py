"""
Offline sales-order synchronization service.

The server is authoritative for customer assignments, products,
prices, sales orders, and synchronization outcomes.

Each offline order is identified by:
- The authenticated Salesman's user ID.
- A stable client-generated local order UUID.
- A stable idempotency key.

Successful synchronization creates the sales order, its items,
the synchronization record, and audit history in the same
database transaction.

A repeated identical request returns the existing order.
A conflicting request never overwrites an accepted order.

Synchronization does not approve orders, dispatch inventory,
post invoices, or perform any other official business action.

The caller owns the database transaction and must commit it
before reporting synchronization success to the client.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import or_, select, text
from sqlalchemy.orm import Session

from app.models.audit import AuditLog, SyncRecord
from app.models.sales import SalesOrder
from app.models.user import User
from app.services.audit_service import create_audit_log
from app.services.sales_service import (
    create_sales_order,
    submit_sales_order,
)


SALESMAN_ROLE = "Salesman"
FACTORY_ADMIN_ROLE = "Factory Admin"

SYNC_STATUSES = frozenset(
    {
        "PENDING",
        "SYNCED",
        "FAILED",
        "CONFLICT",
    }
)

MAX_IDEMPOTENCY_KEY_LENGTH = 255
MAX_SYNC_ITEMS = 100
MAX_NOTES_LENGTH = 5000

AUDIT_ENTITY_TYPE = "OfflineSalesOrderSync"
AUDIT_ACTION_ACCEPTED = "OFFLINE_ORDER_SYNCED"
AUDIT_ACTION_FAILED = "OFFLINE_ORDER_SYNC_FAILED"
AUDIT_ACTION_CONFLICT = "OFFLINE_ORDER_SYNC_CONFLICT"


def _error(code: int, detail: str) -> HTTPException:
    return HTTPException(status_code=code, detail=detail)


def _actor(
    db: Session,
    actor_id: UUID,
    *,
    allow_admin: bool = False,
) -> User:
    user = db.get(User, actor_id)

    if user is None or not user.is_active:
        raise _error(
            status.HTTP_403_FORBIDDEN,
            "An active user account is required.",
        )

    role = user.primary_role

    allowed = (
        {SALESMAN_ROLE, FACTORY_ADMIN_ROLE}
        if allow_admin
        else {SALESMAN_ROLE}
    )

    if role is None or role.role_name not in allowed:
        raise _error(
            status.HTTP_403_FORBIDDEN,
            "Offline order synchronization is restricted "
            "to authorized Salesmen.",
        )

    return user


def _validate_uuid(value: UUID, field: str) -> UUID:
    if not isinstance(value, UUID):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"{field} must be a valid UUID.",
        )

    return value


def _validate_key(value: str) -> str:
    if not isinstance(value, str):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Idempotency key must be a string.",
        )

    key = value.strip()

    if (
        not key
        or key != value
        or len(key) > MAX_IDEMPOTENCY_KEY_LENGTH
    ):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Idempotency key must be nonblank, unchanged, "
            "and at most 255 characters.",
        )

    return key


def _decimal(value: object, field: str) -> Decimal:
    if isinstance(value, (bool, float)):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"{field} must use an exact decimal value.",
        )

    try:
        number = Decimal(value)
    except (TypeError, ValueError, InvalidOperation):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"{field} must be a valid decimal.",
        ) from None

    if not number.is_finite():
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"{field} must be finite.",
        )

    return number


def _date(value: object, field: str) -> date:
    if (
        not isinstance(value, date)
        or isinstance(value, datetime)
    ):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"{field} must be a calendar date.",
        )

    return value


def _canonical_items(
    items: Sequence[Mapping[str, object]],
) -> list[dict[str, object]]:
    if (
        isinstance(items, (str, bytes))
        or not isinstance(items, Sequence)
        or not 1 <= len(items) <= MAX_SYNC_ITEMS
    ):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "An offline order must contain between 1 and "
            f"{MAX_SYNC_ITEMS} items.",
        )

    result: list[dict[str, object]] = []
    seen_products: set[UUID] = set()

    for index, item in enumerate(items, start=1):
        if not isinstance(item, Mapping):
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                f"Order item {index} must be an object.",
            )

        product_id = _validate_uuid(
            item.get("product_id"),
            f"Item {index} product_id",
        )

        if product_id in seen_products:
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Duplicate products must be combined into "
                "a single order line.",
            )

        seen_products.add(product_id)

        quantity = _decimal(
            item.get("quantity"),
            f"Item {index} quantity",
        )

        if quantity <= 0:
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                f"Item {index} quantity must be positive.",
            )

        normalized: dict[str, object] = {
            "product_id": product_id,
            "quantity": quantity,
        }

        if "unit_price" in item:
            price = _decimal(
                item["unit_price"],
                f"Item {index} unit_price",
            )

            if price < 0:
                raise _error(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    f"Item {index} unit_price cannot be negative.",
                )

            normalized["unit_price"] = price

        result.append(normalized)

    return result


def _canonical_payload(
    *,
    customer_id: UUID,
    order_date: date,
    required_date: date | None,
    notes: str | None,
    items: Sequence[Mapping[str, object]],
) -> dict[str, object]:
    _validate_uuid(customer_id, "customer_id")
    _date(order_date, "order_date")

    if required_date is not None:
        _date(required_date, "required_date")

        if required_date < order_date:
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Required date cannot precede order date.",
            )

    if notes is not None:
        if not isinstance(notes, str):
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Order notes must be a string.",
            )

        if len(notes) > MAX_NOTES_LENGTH:
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Order notes exceed the supported length.",
            )

    normalized_items = _canonical_items(items)

    return {
        "customer_id": customer_id,
        "order_date": order_date,
        "required_date": required_date,
        "notes": notes,
        "items": normalized_items,
    }


def _json_value(value: object) -> Any:
    if value is None or isinstance(value, (str, bool, int)):
        return value

    if isinstance(value, Decimal):
        return format(value, "f")

    if isinstance(value, UUID):
        return str(value)

    if isinstance(value, (date, datetime)):
        return value.isoformat()

    if isinstance(value, Mapping):
        return {
            str(key): _json_value(item)
            for key, item in value.items()
        }

    if isinstance(value, (list, tuple)):
        return [_json_value(item) for item in value]

    raise _error(
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "Unsupported offline order payload value.",
    )


def _payload_hash(payload: Mapping[str, object]) -> str:
    canonical = json.dumps(
        _json_value(payload),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        allow_nan=False,
    )

    return hashlib.sha256(
        canonical.encode("utf-8")
    ).hexdigest()


def _lock_submission(
    db: Session,
    *,
    user_id: UUID,
    local_order_id: UUID,
    idempotency_key: str,
) -> None:
    """
    Serialize submissions sharing either client identity.

    PostgreSQL transaction-scoped advisory locks prevent two
    concurrent requests from creating duplicate orders before
    either transaction inserts its synchronization record.

    Locks are acquired in sorted order to avoid deadlocks.
    """

    identifiers = (
        f"offline-local:{user_id}:{local_order_id}",
        f"offline-key:{user_id}:{idempotency_key}",
    )

    lock_numbers = sorted(
        {
            int.from_bytes(
                hashlib.sha256(
                    identifier.encode("utf-8")
                ).digest()[:8],
                byteorder="big",
                signed=True,
            )
            for identifier in identifiers
        }
    )

    for lock_number in lock_numbers:
        db.execute(
            text(
                "SELECT pg_advisory_xact_lock(:lock_number)"
            ),
            {"lock_number": lock_number},
        )


def _existing_records(
    db: Session,
    *,
    user_id: UUID,
    local_order_id: UUID,
    idempotency_key: str,
) -> list[SyncRecord]:
    return list(
        db.scalars(
            select(SyncRecord)
            .where(
                SyncRecord.user_id == user_id,
                or_(
                    SyncRecord.local_order_id == local_order_id,
                    SyncRecord.idempotency_key == idempotency_key,
                ),
            )
            .with_for_update()
        ).all()
    )


def _record_hash(
    db: Session,
    *,
    sync_id: UUID,
) -> str | None:
    entries = db.scalars(
        select(AuditLog)
        .where(
            AuditLog.entity_type == AUDIT_ENTITY_TYPE,
            AuditLog.entity_id == sync_id,
        )
        .order_by(
            AuditLog.timestamp.desc(),
            AuditLog.audit_id.desc(),
        )
    ).all()

    for entry in entries:
        values = entry.new_values

        if not isinstance(values, dict):
            continue

        fingerprint = values.get("payload_hash")

        if isinstance(fingerprint, str):
            return fingerprint

    return None


def _audit_sync(
    db: Session,
    *,
    actor_id: UUID,
    record: SyncRecord,
    action: str,
    payload_hash: str,
    error_message: str | None = None,
) -> None:
    create_audit_log(
        db,
        user_id=actor_id,
        entity_type=AUDIT_ENTITY_TYPE,
        entity_id=record.sync_id,
        action=action,
        new_values={
            "user_id": str(record.user_id),
            "local_order_id": str(record.local_order_id),
            "idempotency_key": record.idempotency_key,
            "order_id": (
                str(record.order_id)
                if record.order_id is not None
                else None
            ),
            "sync_status": record.sync_status,
            "payload_hash": payload_hash,
            "error_message": error_message,
        },
    )


def _sync_result(
    record: SyncRecord,
    *,
    duplicate: bool = False,
) -> dict[str, object]:
    return {
        "sync_id": record.sync_id,
        "local_order_id": record.local_order_id,
        "idempotency_key": record.idempotency_key,
        "sync_status": record.sync_status,
        "order_id": record.order_id,
        "synced_at": record.synced_at,
        "error_message": record.error_message,
        "duplicate": duplicate,
        "approval_status": (
            "SUBMITTED"
            if record.sync_status == "SYNCED"
            else None
        ),
    }


def _conflict(
    detail: str,
) -> HTTPException:
    return _error(
        status.HTTP_409_CONFLICT,
        detail,
    )


def synchronize_sales_order(
    db: Session,
    *,
    actor_id: UUID,
    local_order_id: UUID,
    idempotency_key: str,
    customer_id: UUID,
    order_date: date,
    items: Sequence[Mapping[str, object]],
    required_date: date | None = None,
    notes: str | None = None,
) -> dict[str, object]:
    """
    Synchronize one offline sales order.

    The caller must commit the transaction before returning a
    successful response to the device.

    Rejected business validations are retained in SyncRecord as
    FAILED or CONFLICT, with their payload fingerprints in AuditLog.

    Database failures propagate so the caller can roll back.
    """

    _actor(db, actor_id)

    _validate_uuid(local_order_id, "local_order_id")
    key = _validate_key(idempotency_key)

    payload = _canonical_payload(
        customer_id=customer_id,
        order_date=order_date,
        required_date=required_date,
        notes=notes,
        items=items,
    )

    fingerprint = _payload_hash(payload)

    _lock_submission(
        db,
        user_id=actor_id,
        local_order_id=local_order_id,
        idempotency_key=key,
    )

    existing = _existing_records(
        db,
        user_id=actor_id,
        local_order_id=local_order_id,
        idempotency_key=key,
    )

    if len(existing) > 1:
        raise _conflict(
            "Local order ID and idempotency key refer to "
            "different synchronization records."
        )

    record = existing[0] if existing else None

    if record is not None:
        if (
            record.local_order_id != local_order_id
            or record.idempotency_key != key
        ):
            raise _conflict(
                "The local order ID or idempotency key has "
                "already been used for a different submission."
            )

        previous_hash = _record_hash(
            db,
            sync_id=record.sync_id,
        )

        if previous_hash is None:
            raise _conflict(
                "Existing synchronization record has no "
                "verifiable payload fingerprint."
            )

        if previous_hash != fingerprint:
            raise _conflict(
                "This offline order was previously submitted "
                "with different contents. Preserve the local "
                "order for review; do not overwrite it."
            )

        if record.sync_status == "SYNCED":
            if record.order_id is None or record.synced_at is None:
                raise _conflict(
                    "Stored synchronization confirmation "
                    "is incomplete."
                )

            order = db.get(SalesOrder, record.order_id)

            if (
                order is None
                or order.salesman_id != actor_id
            ):
                raise _conflict(
                    "The synchronized sales order is unavailable "
                    "or does not belong to this Salesman."
                )

            result = _sync_result(
                record,
                duplicate=True,
            )
            result["order_number"] = order.order_number
            result["approval_status"] = order.approval_status
            result["fulfillment_status"] = (
                order.fulfillment_status
            )

            return result

        if record.sync_status == "CONFLICT":
            return _sync_result(
                record,
                duplicate=True,
            )

    else:
        record = SyncRecord(
            user_id=actor_id,
            local_order_id=local_order_id,
            idempotency_key=key,
            sync_status="PENDING",
            order_id=None,
            synced_at=None,
            error_message=None,
        )

        db.add(record)
        db.flush()

    try:
        with db.begin_nested():
            sales_items = [
                {
                    "product_id": item["product_id"],
                    "quantity": item["quantity"],
                    **(
                        {"unit_price": item["unit_price"]}
                        if "unit_price" in item
                        else {}
                    ),
                }
                for item in payload["items"]
            ]

            order = create_sales_order(
                db,
                actor_id=actor_id,
                customer_id=payload["customer_id"],
                order_date=payload["order_date"],
                required_date=payload["required_date"],
                notes=payload["notes"],
                items=sales_items,
            )

            submit_sales_order(
                db,
                sales_order_id=order.sales_order_id,
                actor_id=actor_id,
            )

            db.flush()

    except HTTPException as exc:
        if exc.status_code >= 500:
            raise

        if exc.status_code in (
            status.HTTP_403_FORBIDDEN,
            status.HTTP_404_NOT_FOUND,
            status.HTTP_409_CONFLICT,
        ):
            failure_status = "CONFLICT"
            action = AUDIT_ACTION_CONFLICT
        else:
            failure_status = "FAILED"
            action = AUDIT_ACTION_FAILED

        detail = (
            exc.detail
            if isinstance(exc.detail, str)
            else "Offline order failed server-side validation."
        )

        record.sync_status = failure_status
        record.order_id = None
        record.synced_at = None
        record.error_message = detail

        db.flush()

        _audit_sync(
            db,
            actor_id=actor_id,
            record=record,
            action=action,
            payload_hash=fingerprint,
            error_message=detail,
        )

        db.flush()

        return _sync_result(record)

    if order.approval_status != "SUBMITTED":
        raise _conflict(
            "Synchronized order was not placed in "
            "SUBMITTED status."
        )

    if order.salesman_id != actor_id:
        raise _conflict(
            "Synchronized order ownership is inconsistent."
        )

    record.order_id = order.sales_order_id
    record.sync_status = "SYNCED"
    record.synced_at = datetime.now(timezone.utc)
    record.error_message = None

    db.flush()

    _audit_sync(
        db,
        actor_id=actor_id,
        record=record,
        action=AUDIT_ACTION_ACCEPTED,
        payload_hash=fingerprint,
    )

    db.flush()

    result = _sync_result(record)
    result["order_number"] = order.order_number
    result["approval_status"] = order.approval_status
    result["fulfillment_status"] = order.fulfillment_status

    return result


def get_synchronization_record(
    db: Session,
    *,
    actor_id: UUID,
    local_order_id: UUID,
) -> dict[str, object]:
    """Retrieve an offline order's authoritative server status."""

    _actor(db, actor_id)

    _validate_uuid(local_order_id, "local_order_id")

    record = db.scalar(
        select(SyncRecord).where(
            SyncRecord.user_id == actor_id,
            SyncRecord.local_order_id == local_order_id,
        )
    )

    if record is None:
        raise _error(
            status.HTTP_404_NOT_FOUND,
            "Synchronization record not found.",
        )

    result = _sync_result(record)

    if record.order_id is not None:
        order = db.get(SalesOrder, record.order_id)

        if order is None or order.salesman_id != actor_id:
            raise _conflict(
                "The linked sales order is unavailable "
                "or has inconsistent ownership."
            )

        result["order_number"] = order.order_number
        result["approval_status"] = order.approval_status
        result["fulfillment_status"] = (
            order.fulfillment_status
        )

    return result


def list_synchronization_records(
    db: Session,
    *,
    actor_id: UUID,
    sync_status: str | None = None,
    page: int = 1,
    page_size: int = 50,
) -> tuple[list[dict[str, object]], int]:
    """List synchronization outcomes for the authenticated Salesman."""

    _actor(db, actor_id)

    if sync_status is not None and sync_status not in SYNC_STATUSES:
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Invalid synchronization status.",
        )

    if (
        isinstance(page, bool)
        or isinstance(page_size, bool)
        or not isinstance(page, int)
        or not isinstance(page_size, int)
        or page < 1
        or not 1 <= page_size <= 100
    ):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Invalid synchronization pagination.",
        )

    from sqlalchemy import func

    filters = [SyncRecord.user_id == actor_id]

    if sync_status is not None:
        filters.append(
            SyncRecord.sync_status == sync_status
        )

    total = db.scalar(
        select(func.count())
        .select_from(SyncRecord)
        .where(*filters)
    ) or 0

    records = db.scalars(
        select(SyncRecord)
        .where(*filters)
        .order_by(
            SyncRecord.sync_id.desc(),
        )
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()

    order_ids = {
        record.order_id
        for record in records
        if record.order_id is not None
    }

    orders = {
        order.sales_order_id: order
        for order in db.scalars(
            select(SalesOrder).where(
                SalesOrder.sales_order_id.in_(order_ids),
                SalesOrder.salesman_id == actor_id,
            )
        ).all()
    } if order_ids else {}

    results = []

    for record in records:
        result = _sync_result(record)

        if record.order_id is not None:
            order = orders.get(record.order_id)

            if order is None:
                raise _conflict(
                    "A synchronization record references "
                    "an unavailable or unauthorized order."
                )

            result["order_number"] = order.order_number
            result["approval_status"] = order.approval_status
            result["fulfillment_status"] = (
                order.fulfillment_status
            )

        results.append(result)

    return results, total


def get_synchronization_status_by_key(
    db: Session,
    *,
    actor_id: UUID,
    idempotency_key: str,
) -> dict[str, object]:
    """Recover an existing result after a lost network response."""

    _actor(db, actor_id)

    key = _validate_key(idempotency_key)

    record = db.scalar(
        select(SyncRecord).where(
            SyncRecord.user_id == actor_id,
            SyncRecord.idempotency_key == key,
        )
    )

    if record is None:
        raise _error(
            status.HTTP_404_NOT_FOUND,
            "No synchronization record exists for this key.",
        )

    return get_synchronization_record(
        db,
        actor_id=actor_id,
        local_order_id=record.local_order_id,
    )