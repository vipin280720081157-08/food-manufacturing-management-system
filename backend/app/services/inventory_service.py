"""
Inventory management and stock movement service.

All stock changes are recorded through StockMovement and reconciled
with InventoryBalance and, where applicable, StockBatch.

The service implements:
- Warehouse and production-held inventory balances.
- Moving weighted-average inventory valuation.
- Batch-level stock receipts and issues.
- Finished-goods FEFO allocation.
- Idempotent stock movement posting.
- Traceable stock movement reversals.
- Draft, approval, and posting workflows for stock adjustments.
- Stock availability and movement history.

Inventory-changing operations must run inside a database transaction
owned by the caller. This module never commits transactions.

PostgreSQL row-level locks protect stock balances and batches against
concurrent consumption. Business services must use the same
transaction when updating source documents and writing audit records.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
from typing import Literal
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.inventory import (
    InventoryBalance,
    StockAdjustment,
    StockAdjustmentItem,
    StockBatch,
    StockMovement,
)
from app.models.product import InventoryItem
from app.models.user import User
from app.services.audit_service import create_audit_log


QUANTITY_QUANTUM = Decimal("0.001")
UNIT_COST_QUANTUM = Decimal("0.000001")
ZERO_QUANTITY = Decimal("0.000")
ZERO_COST = Decimal("0.000000")

InventoryLocation = Literal["WAREHOUSE", "PRODUCTION_HELD"]
MovementDirection = Literal["IN", "OUT"]

VALID_LOCATIONS = frozenset(
    {"WAREHOUSE", "PRODUCTION_HELD"}
)

VALID_MOVEMENT_TYPES = frozenset(
    {
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
    }
)

VALID_ADJUSTMENT_STATUSES = frozenset(
    {
        "DRAFT",
        "SUBMITTED",
        "APPROVED",
        "REJECTED",
        "POSTED",
        "CANCELLED",
    }
)

FACTORY_ADMIN_ROLE = "Factory Admin"


def _error(
    status_code: int,
    message: str,
) -> HTTPException:
    return HTTPException(
        status_code=status_code,
        detail=message,
    )


def _require_uuid(value: UUID, field_name: str) -> UUID:
    if not isinstance(value, UUID):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"{field_name} must be a UUID.",
        )
    return value


def _decimal(
    value: Decimal | int | str,
    *,
    field_name: str,
    quantum: Decimal,
    allow_zero: bool = False,
) -> Decimal:
    if isinstance(value, bool) or isinstance(value, float):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"{field_name} must use exact decimal arithmetic.",
        )

    try:
        number = Decimal(value)
    except (TypeError, ValueError, ArithmeticError):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"{field_name} must be a valid decimal.",
        ) from None

    if not number.is_finite():
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"{field_name} must be finite.",
        )

    if number < ZERO_QUANTITY or (
        not allow_zero and number == ZERO_QUANTITY
    ):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"{field_name} must be "
            + ("nonnegative." if allow_zero else "positive."),
        )

    if number != number.quantize(quantum):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"{field_name} exceeds supported decimal precision.",
        )

    return number


def _quantity(
    value: Decimal | int | str,
    *,
    allow_zero: bool = False,
) -> Decimal:
    return _decimal(
        value,
        field_name="quantity",
        quantum=QUANTITY_QUANTUM,
        allow_zero=allow_zero,
    )


def _unit_cost(
    value: Decimal | int | str,
) -> Decimal:
    return _decimal(
        value,
        field_name="unit_cost",
        quantum=UNIT_COST_QUANTUM,
        allow_zero=True,
    )


def _round_unit_cost(value: Decimal) -> Decimal:
    return value.quantize(
        UNIT_COST_QUANTUM,
        rounding=ROUND_HALF_UP,
    )


def _validate_location(location: str) -> str:
    if location not in VALID_LOCATIONS:
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Invalid inventory location.",
        )
    return location


def _validate_direction(direction: str) -> str:
    if direction not in {"IN", "OUT"}:
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Stock direction must be IN or OUT.",
        )
    return direction


def _validate_movement_type(movement_type: str) -> str:
    if movement_type not in VALID_MOVEMENT_TYPES:
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Invalid stock movement type.",
        )
    return movement_type


def _validate_reference(
    value: str,
    field_name: str,
    max_length: int,
) -> str:
    if not isinstance(value, str):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"{field_name} must be a string.",
        )

    normalized = value.strip()

    if not normalized or len(normalized) > max_length:
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"{field_name} must contain 1 to {max_length} characters.",
        )

    return normalized


def _require_item(
    db: Session,
    item_id: UUID,
) -> InventoryItem:
    item = db.get(
        InventoryItem,
        _require_uuid(item_id, "item_id"),
    )

    if item is None:
        raise _error(
            status.HTTP_404_NOT_FOUND,
            "Inventory item not found.",
        )

    return item


def _require_actor(
    db: Session,
    user_id: UUID,
) -> User:
    user = db.get(
        User,
        _require_uuid(user_id, "user_id"),
    )

    if user is None or not user.is_active:
        raise _error(
            status.HTTP_403_FORBIDDEN,
            "An active user account is required.",
        )

    return user


def _require_factory_admin(
    db: Session,
    user_id: UUID,
) -> User:
    user = _require_actor(db, user_id)
    role = user.primary_role

    if role is None or role.role_name != FACTORY_ADMIN_ROLE:
        raise _error(
            status.HTTP_403_FORBIDDEN,
            "Factory Admin authorization is required.",
        )

    return user


def get_inventory_balance(
    db: Session,
    *,
    item_id: UUID,
    location: InventoryLocation = "WAREHOUSE",
    lock: bool = False,
) -> InventoryBalance | None:
    """Retrieve an item/location balance, optionally locking its row."""

    _validate_location(location)

    statement = select(InventoryBalance).where(
        InventoryBalance.item_id == item_id,
        InventoryBalance.location == location,
    )

    if lock:
        statement = statement.with_for_update(
            of=InventoryBalance
        )

    return db.scalar(statement)


def get_stock_quantity(
    db: Session,
    *,
    item_id: UUID,
    location: InventoryLocation = "WAREHOUSE",
) -> Decimal:
    """Return the recorded quantity at an inventory location."""

    _require_item(db, item_id)

    balance = get_inventory_balance(
        db,
        item_id=item_id,
        location=location,
    )

    return (
        Decimal(balance.quantity_on_hand)
        if balance is not None
        else ZERO_QUANTITY
    )


def get_stock_availability(
    db: Session,
    *,
    item_id: UUID,
    location: InventoryLocation = "WAREHOUSE",
) -> dict[str, object]:
    """
    Return stock availability without reserving inventory.

    The posting operation must recheck availability under locks.
    """

    item = _require_item(db, item_id)
    balance = get_inventory_balance(
        db,
        item_id=item_id,
        location=location,
    )

    return {
        "item_id": item.item_id,
        "item_name": item.item_name,
        "item_type": item.item_type,
        "base_unit": item.base_unit,
        "location": location,
        "quantity_on_hand": (
            Decimal(balance.quantity_on_hand)
            if balance is not None
            else ZERO_QUANTITY
        ),
        "average_unit_cost": (
            Decimal(balance.average_unit_cost)
            if balance is not None
            else ZERO_COST
        ),
    }


def _locked_balance(
    db: Session,
    *,
    item_id: UUID,
    location: str,
    create: bool,
) -> InventoryBalance:
    """
    Obtain a locked balance, creating it safely when permitted.

    Locking the inventory-item master serializes first-time balance
    creation for a given item. All inventory writers using this
    service follow the same lock order.
    """

    _validate_location(location)

    item = db.scalar(
        select(InventoryItem)
        .where(InventoryItem.item_id == item_id)
        .with_for_update(of=InventoryItem)
    )

    if item is None:
        raise _error(
            status.HTTP_404_NOT_FOUND,
            "Inventory item not found.",
        )

    balance = get_inventory_balance(
        db,
        item_id=item_id,
        location=location,
        lock=True,
    )

    if balance is not None:
        return balance

    if not create:
        raise _error(
            status.HTTP_409_CONFLICT,
            "No inventory balance exists for this item and location.",
        )

    balance = InventoryBalance(
        item_id=item_id,
        location=location,
        quantity_on_hand=ZERO_QUANTITY,
        average_unit_cost=ZERO_COST,
    )

    db.add(balance)
    db.flush()

    return balance


def _locked_batch(
    db: Session,
    *,
    batch_id: UUID,
    item_id: UUID,
) -> StockBatch:
    batch = db.scalar(
        select(StockBatch)
        .where(StockBatch.batch_id == batch_id)
        .with_for_update(of=StockBatch)
    )

    if batch is None:
        raise _error(
            status.HTTP_404_NOT_FOUND,
            "Stock batch not found.",
        )

    if batch.item_id != item_id:
        raise _error(
            status.HTTP_409_CONFLICT,
            "Stock batch does not belong to the inventory item.",
        )

    return batch


def _existing_source_movement(
    db: Session,
    *,
    source_type: str,
    source_id: UUID,
    source_line_id: UUID,
    movement_type: str,
    location: str,
    direction: str,
) -> StockMovement | None:
    return db.scalar(
        select(StockMovement).where(
            StockMovement.source_type == source_type,
            StockMovement.source_id == source_id,
            StockMovement.source_line_id == source_line_id,
            StockMovement.movement_type == movement_type,
            StockMovement.location == location,
            StockMovement.direction == direction,
        )
    )


def post_stock_movement(
    db: Session,
    *,
    item_id: UUID,
    movement_type: str,
    direction: MovementDirection,
    location: InventoryLocation,
    quantity: Decimal,
    source_type: str,
    source_id: UUID,
    source_line_id: UUID,
    created_by: UUID,
    batch_id: UUID | None = None,
    unit_cost: Decimal | None = None,
    reversal_of_id: UUID | None = None,
) -> StockMovement:
    """
    Atomically post one stock movement within the caller's transaction.

    Repeated requests with the same source-line action return the
    existing movement only if every material attribute agrees.

    Incoming movements use moving weighted-average valuation.
    Outgoing movements retain the prevailing balance cost unless
    a specific historical cost is required for a reversal.

    A stock batch must exist for batch-tracked outgoing movements.
    New batch receipts are created separately before this call.
    """

    _require_uuid(item_id, "item_id")
    _require_uuid(source_id, "source_id")
    _require_uuid(source_line_id, "source_line_id")
    _require_uuid(created_by, "created_by")

    movement_type = _validate_movement_type(movement_type)
    direction = _validate_direction(direction)
    location = _validate_location(location)
    quantity = _quantity(quantity)
    source_type = _validate_reference(
        source_type,
        "source_type",
        50,
    )

    if unit_cost is not None:
        unit_cost = _unit_cost(unit_cost)

    if batch_id is not None:
        _require_uuid(batch_id, "batch_id")

    if reversal_of_id is not None:
        _require_uuid(reversal_of_id, "reversal_of_id")

    if movement_type == "REVERSAL" and reversal_of_id is None:
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "A reversal must reference its original movement.",
        )

    if movement_type != "REVERSAL" and reversal_of_id is not None:
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Only reversal movements may reference an original movement.",
        )

    _require_actor(db, created_by)

    balance = _locked_balance(
        db,
        item_id=item_id,
        location=location,
        create=direction == "IN",
    )

    existing = _existing_source_movement(
        db,
        source_type=source_type,
        source_id=source_id,
        source_line_id=source_line_id,
        movement_type=movement_type,
        location=location,
        direction=direction,
    )

    if existing is not None:
        if (
            existing.item_id != item_id
            or Decimal(existing.quantity) != quantity
            or existing.batch_id != batch_id
            or existing.reversal_of_id != reversal_of_id
            or (
                unit_cost is not None
                and Decimal(existing.unit_cost) != unit_cost
            )
        ):
            raise _error(
                status.HTTP_409_CONFLICT,
                "The source movement already exists with "
                "different transaction details.",
            )

        return existing

    if reversal_of_id is not None:
        previous_reversal = db.scalar(
            select(StockMovement).where(
                StockMovement.reversal_of_id == reversal_of_id
            )
        )

        if previous_reversal is not None:
            raise _error(
                status.HTTP_409_CONFLICT,
                "This stock movement has already been reversed.",
            )

    previous_quantity = Decimal(balance.quantity_on_hand)
    previous_cost = Decimal(balance.average_unit_cost)

    batch = None

    if batch_id is not None:
        batch = _locked_batch(
            db,
            batch_id=batch_id,
            item_id=item_id,
        )

        if location != "WAREHOUSE":
            raise _error(
                status.HTTP_409_CONFLICT,
                "Batch movements are supported only "
                "at the warehouse location.",
            )

    if direction == "OUT":
        if previous_quantity < quantity:
            raise _error(
                status.HTTP_409_CONFLICT,
                "Insufficient inventory for the requested stock issue.",
            )

        if batch is not None:
            if Decimal(batch.quantity_remaining) < quantity:
                raise _error(
                    status.HTTP_409_CONFLICT,
                    "Insufficient quantity in the selected stock batch.",
                )

            if movement_type == "DISPATCH":
                if (
                    batch.expiry_date is not None
                    and batch.expiry_date < date.today()
                ):
                    raise _error(
                        status.HTTP_409_CONFLICT,
                        "Expired stock batches cannot be dispatched.",
                    )

        effective_cost = (
            unit_cost
            if unit_cost is not None
            else previous_cost
        )

        balance.quantity_on_hand = (
            previous_quantity - quantity
        )

        if batch is not None:
            batch.quantity_remaining = (
                Decimal(batch.quantity_remaining) - quantity
            )

    else:
        if unit_cost is not None:
            effective_cost = unit_cost
        elif batch is not None:
            effective_cost = Decimal(batch.unit_cost)
        else:
            effective_cost = previous_cost

        new_quantity = previous_quantity + quantity

        if previous_quantity == ZERO_QUANTITY:
            new_average_cost = effective_cost
        else:
            new_average_cost = _round_unit_cost(
                (
                    previous_quantity * previous_cost
                    + quantity * effective_cost
                )
                / new_quantity
            )

        balance.quantity_on_hand = new_quantity
        balance.average_unit_cost = new_average_cost

        if batch is not None:
            updated_batch_quantity = (
                Decimal(batch.quantity_remaining) + quantity
            )

            if updated_batch_quantity > Decimal(batch.initial_quantity):
                raise _error(
                    status.HTTP_409_CONFLICT,
                    "The receipt would exceed the batch's "
                    "recorded initial quantity.",
                )

            batch.quantity_remaining = updated_batch_quantity

    movement = StockMovement(
        item_id=item_id,
        batch_id=batch_id,
        movement_type=movement_type,
        direction=direction,
        location=location,
        quantity=quantity,
        unit_cost=effective_cost,
        source_type=source_type,
        source_id=source_id,
        source_line_id=source_line_id,
        reversal_of_id=reversal_of_id,
        created_by=created_by,
    )

    db.add(movement)
    db.flush()

    return movement


def create_stock_batch(
    db: Session,
    *,
    item_id: UUID,
    batch_number: str,
    source_type: str,
    source_id: UUID,
    quantity: Decimal,
    unit_cost: Decimal,
    manufacturing_date: date | None = None,
    expiry_date: date | None = None,
) -> StockBatch:
    """
    Create batch metadata for an incoming warehouse receipt.

    This function does not add inventory. The caller must post the
    corresponding incoming StockMovement in the same transaction.
    """

    _require_item(db, item_id)

    batch_number = _validate_reference(
        batch_number,
        "batch_number",
        100,
    )
    source_type = _validate_reference(
        source_type,
        "source_type",
        50,
    )
    _require_uuid(source_id, "source_id")

    quantity = _quantity(quantity)
    unit_cost = _unit_cost(unit_cost)

    if (
        manufacturing_date is not None
        and expiry_date is not None
        and expiry_date < manufacturing_date
    ):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Expiry date cannot precede manufacturing date.",
        )

    item = db.scalar(
        select(InventoryItem)
        .where(InventoryItem.item_id == item_id)
        .with_for_update(of=InventoryItem)
    )

    if item is None:
        raise _error(
            status.HTTP_404_NOT_FOUND,
            "Inventory item not found.",
        )

    existing = db.scalar(
        select(StockBatch).where(
            StockBatch.item_id == item_id,
            StockBatch.batch_number == batch_number,
        )
    )

    if existing is not None:
        if (
            existing.source_type != source_type
            or existing.source_id != source_id
            or Decimal(existing.initial_quantity) != quantity
            or Decimal(existing.unit_cost) != unit_cost
            or existing.manufacturing_date != manufacturing_date
            or existing.expiry_date != expiry_date
        ):
            raise _error(
                status.HTTP_409_CONFLICT,
                "A stock batch with this number already exists "
                "with different details.",
            )

        return existing

    batch = StockBatch(
        item_id=item_id,
        batch_number=batch_number,
        source_type=source_type,
        source_id=source_id,
        initial_quantity=quantity,
        quantity_remaining=ZERO_QUANTITY,
        unit_cost=unit_cost,
        manufacturing_date=manufacturing_date,
        expiry_date=expiry_date,
    )

    db.add(batch)
    db.flush()

    return batch


def list_stock_batches(
    db: Session,
    *,
    item_id: UUID,
    include_empty: bool = False,
    as_of_date: date | None = None,
) -> list[StockBatch]:
    """List stock batches in FEFO order."""

    _require_item(db, item_id)

    statement = select(StockBatch).where(
        StockBatch.item_id == item_id
    )

    if not include_empty:
        statement = statement.where(
            StockBatch.quantity_remaining > ZERO_QUANTITY
        )

    if as_of_date is not None:
        statement = statement.where(
            (StockBatch.expiry_date.is_(None))
            | (StockBatch.expiry_date >= as_of_date)
        )

    statement = statement.order_by(
        StockBatch.expiry_date.asc().nulls_last(),
        StockBatch.created_at.asc(),
        StockBatch.batch_id.asc(),
    )

    return list(db.scalars(statement).all())


def allocate_fefo_batches(
    db: Session,
    *,
    item_id: UUID,
    quantity: Decimal,
    as_of_date: date | None = None,
) -> list[tuple[StockBatch, Decimal]]:
    """
    Calculate FEFO allocations without changing stock.

    This function is a preview. A dispatch service must revalidate
    and lock batches while posting the actual stock movements.
    """

    item = _require_item(db, item_id)

    if item.item_type != "FINISHED_PRODUCT":
        raise _error(
            status.HTTP_409_CONFLICT,
            "FEFO dispatch allocation requires a finished product.",
        )

    requested_quantity = _quantity(quantity)
    reference_date = as_of_date or date.today()

    available_batches = list_stock_batches(
        db,
        item_id=item_id,
        as_of_date=reference_date,
    )

    remaining = requested_quantity
    allocations: list[tuple[StockBatch, Decimal]] = []

    for batch in available_batches:
        if remaining == ZERO_QUANTITY:
            break

        available = Decimal(batch.quantity_remaining)

        if available <= ZERO_QUANTITY:
            continue

        allocated = min(available, remaining)

        allocations.append((batch, allocated))
        remaining -= allocated

    if remaining > ZERO_QUANTITY:
        raise _error(
            status.HTTP_409_CONFLICT,
            "Insufficient eligible finished-goods batches "
            f"for dispatch. Shortage: {remaining}.",
        )

    return allocations


def reverse_stock_movement(
    db: Session,
    *,
    movement_id: UUID,
    created_by: UUID,
    source_id: UUID,
    source_line_id: UUID,
) -> StockMovement:
    """
    Reverse a stock movement without deleting its original record.

    A reversal uses the opposite direction and preserves the
    original quantity, location, batch, and unit cost.

    Source-document authorization and the reason for correction
    must be validated and audited by the calling business service.
    """

    _require_uuid(movement_id, "movement_id")
    _require_factory_admin(db, created_by)

    original = db.scalar(
        select(StockMovement)
        .where(StockMovement.movement_id == movement_id)
        .with_for_update(of=StockMovement)
    )

    if original is None:
        raise _error(
            status.HTTP_404_NOT_FOUND,
            "Original stock movement not found.",
        )

    if original.movement_type == "REVERSAL":
        raise _error(
            status.HTTP_409_CONFLICT,
            "A reversal movement cannot itself be reversed.",
        )

    existing_reversal = db.scalar(
        select(StockMovement).where(
            StockMovement.reversal_of_id == movement_id
        )
    )

    if existing_reversal is not None:
        if (
            existing_reversal.source_id == source_id
            and existing_reversal.source_line_id == source_line_id
        ):
            return existing_reversal

        raise _error(
            status.HTTP_409_CONFLICT,
            "The stock movement has already been reversed.",
        )

    opposite_direction: MovementDirection = (
        "OUT" if original.direction == "IN" else "IN"
    )

    reversal = post_stock_movement(
        db,
        item_id=original.item_id,
        movement_type="REVERSAL",
        direction=opposite_direction,
        location=original.location,
        quantity=Decimal(original.quantity),
        source_type="STOCK_MOVEMENT_REVERSAL",
        source_id=source_id,
        source_line_id=source_line_id,
        created_by=created_by,
        batch_id=original.batch_id,
        unit_cost=Decimal(original.unit_cost),
        reversal_of_id=original.movement_id,
    )

    create_audit_log(
        db,
        user_id=created_by,
        entity_type="StockMovement",
        entity_id=original.movement_id,
        action="STOCK_MOVEMENT_REVERSED",
        old_values={
            "movement_id": str(original.movement_id),
            "direction": original.direction,
            "quantity": str(original.quantity),
        },
        new_values={
            "reversal_movement_id": str(reversal.movement_id),
            "direction": reversal.direction,
            "quantity": str(reversal.quantity),
        },
    )

    return reversal


def create_stock_adjustment(
    db: Session,
    *,
    adjustment_number: str,
    reason: str,
    created_by: UUID,
    items: list[dict[str, object]],
) -> StockAdjustment:
    """Create a draft stock adjustment with validated line items."""

    _require_factory_admin(db, created_by)

    adjustment_number = _validate_reference(
        adjustment_number,
        "adjustment_number",
        100,
    )
    reason = _validate_reference(
        reason,
        "reason",
        10_000,
    )

    if not items:
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "A stock adjustment must contain at least one item.",
        )

    existing = db.scalar(
        select(StockAdjustment).where(
            StockAdjustment.adjustment_number == adjustment_number
        )
    )

    if existing is not None:
        raise _error(
            status.HTTP_409_CONFLICT,
            "Stock adjustment number already exists.",
        )

    adjustment = StockAdjustment(
        adjustment_number=adjustment_number,
        reason=reason,
        status="DRAFT",
        created_by=created_by,
    )

    for item_data in items:
        item_id = item_data.get("item_id")
        batch_id = item_data.get("batch_id")
        location = item_data.get("location", "WAREHOUSE")
        direction = item_data.get("direction")
        quantity = item_data.get("quantity")
        unit_cost = item_data.get("unit_cost", ZERO_COST)

        if not isinstance(item_id, UUID):
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Each adjustment item requires a valid item_id.",
            )

        _require_item(db, item_id)

        if batch_id is not None and not isinstance(batch_id, UUID):
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Invalid adjustment batch_id.",
            )

        if not isinstance(location, str):
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Invalid adjustment location.",
            )

        if not isinstance(direction, str):
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Invalid adjustment direction.",
            )

        validated_location = _validate_location(location)
        validated_direction = _validate_direction(direction)

        if batch_id is not None:
            batch = db.get(StockBatch, batch_id)

            if batch is None or batch.item_id != item_id:
                raise _error(
                    status.HTTP_409_CONFLICT,
                    "Adjustment batch does not belong to the item.",
                )

            if validated_location != "WAREHOUSE":
                raise _error(
                    status.HTTP_409_CONFLICT,
                    "Batch adjustments must use the warehouse location.",
                )

        adjustment.items.append(
            StockAdjustmentItem(
                item_id=item_id,
                batch_id=batch_id,
                location=validated_location,
                direction=validated_direction,
                quantity=_quantity(quantity),
                unit_cost=_unit_cost(unit_cost),
            )
        )

    db.add(adjustment)
    db.flush()

    create_audit_log(
        db,
        user_id=created_by,
        entity_type="StockAdjustment",
        entity_id=adjustment.adjustment_id,
        action="STOCK_ADJUSTMENT_CREATED",
        new_values={
            "adjustment_number": adjustment.adjustment_number,
            "reason": adjustment.reason,
            "status": adjustment.status,
            "item_count": len(adjustment.items),
        },
    )

    return adjustment


def _locked_adjustment(
    db: Session,
    adjustment_id: UUID,
) -> StockAdjustment:
    adjustment = db.scalar(
        select(StockAdjustment)
        .where(
            StockAdjustment.adjustment_id == adjustment_id
        )
        .with_for_update(of=StockAdjustment)
    )

    if adjustment is None:
        raise _error(
            status.HTTP_404_NOT_FOUND,
            "Stock adjustment not found.",
        )

    return adjustment


def submit_stock_adjustment(
    db: Session,
    *,
    adjustment_id: UUID,
    actor_id: UUID,
) -> StockAdjustment:
    """Submit a draft stock adjustment for approval."""

    _require_factory_admin(db, actor_id)
    adjustment = _locked_adjustment(db, adjustment_id)

    if adjustment.status == "SUBMITTED":
        return adjustment

    if adjustment.status != "DRAFT":
        raise _error(
            status.HTTP_409_CONFLICT,
            "Only draft stock adjustments may be submitted.",
        )

    if not adjustment.items:
        raise _error(
            status.HTTP_409_CONFLICT,
            "An adjustment must contain at least one item.",
        )

    adjustment.status = "SUBMITTED"

    create_audit_log(
        db,
        user_id=actor_id,
        entity_type="StockAdjustment",
        entity_id=adjustment.adjustment_id,
        action="STOCK_ADJUSTMENT_SUBMITTED",
        old_values={"status": "DRAFT"},
        new_values={"status": "SUBMITTED"},
    )

    db.flush()
    return adjustment


def approve_stock_adjustment(
    db: Session,
    *,
    adjustment_id: UUID,
    actor_id: UUID,
) -> StockAdjustment:
    """Approve a submitted adjustment before inventory posting."""

    _require_factory_admin(db, actor_id)
    adjustment = _locked_adjustment(db, adjustment_id)

    if adjustment.status == "APPROVED":
        return adjustment

    if adjustment.status != "SUBMITTED":
        raise _error(
            status.HTTP_409_CONFLICT,
            "Only submitted stock adjustments may be approved.",
        )

    if adjustment.created_by == actor_id:
        raise _error(
            status.HTTP_403_FORBIDDEN,
            "A stock adjustment cannot be self-approved.",
        )

    adjustment.status = "APPROVED"
    adjustment.approved_by = actor_id
    adjustment.approved_at = datetime.now(timezone.utc)

    create_audit_log(
        db,
        user_id=actor_id,
        entity_type="StockAdjustment",
        entity_id=adjustment.adjustment_id,
        action="STOCK_ADJUSTMENT_APPROVED",
        old_values={"status": "SUBMITTED"},
        new_values={
            "status": "APPROVED",
            "approved_by": str(actor_id),
        },
    )

    db.flush()
    return adjustment


def reject_stock_adjustment(
    db: Session,
    *,
    adjustment_id: UUID,
    actor_id: UUID,
    reason: str,
) -> StockAdjustment:
    """Reject a submitted stock adjustment without changing stock."""

    _require_factory_admin(db, actor_id)
    reason = _validate_reference(reason, "reason", 10_000)

    adjustment = _locked_adjustment(db, adjustment_id)

    if adjustment.status != "SUBMITTED":
        raise _error(
            status.HTTP_409_CONFLICT,
            "Only submitted adjustments may be rejected.",
        )

    adjustment.status = "REJECTED"

    create_audit_log(
        db,
        user_id=actor_id,
        entity_type="StockAdjustment",
        entity_id=adjustment.adjustment_id,
        action="STOCK_ADJUSTMENT_REJECTED",
        old_values={"status": "SUBMITTED"},
        new_values={
            "status": "REJECTED",
            "reason": reason,
        },
    )

    db.flush()
    return adjustment


def cancel_stock_adjustment(
    db: Session,
    *,
    adjustment_id: UUID,
    actor_id: UUID,
    reason: str,
) -> StockAdjustment:
    """Cancel an unposted adjustment while preserving its history."""

    _require_factory_admin(db, actor_id)
    reason = _validate_reference(reason, "reason", 10_000)

    adjustment = _locked_adjustment(db, adjustment_id)

    if adjustment.status == "POSTED":
        raise _error(
            status.HTTP_409_CONFLICT,
            "Posted stock adjustments cannot be cancelled directly.",
        )

    if adjustment.status == "CANCELLED":
        return adjustment

    previous_status = adjustment.status
    adjustment.status = "CANCELLED"

    create_audit_log(
        db,
        user_id=actor_id,
        entity_type="StockAdjustment",
        entity_id=adjustment.adjustment_id,
        action="STOCK_ADJUSTMENT_CANCELLED",
        old_values={"status": previous_status},
        new_values={
            "status": "CANCELLED",
            "reason": reason,
        },
    )

    db.flush()
    return adjustment


def post_stock_adjustment(
    db: Session,
    *,
    adjustment_id: UUID,
    actor_id: UUID,
) -> StockAdjustment:
    """
    Post an approved stock adjustment exactly once.

    All adjustment movements, balance changes, and the posting
    audit entry remain in the caller's single transaction.
    """

    _require_factory_admin(db, actor_id)

    adjustment = _locked_adjustment(db, adjustment_id)

    if adjustment.status == "POSTED":
        return adjustment

    if (
        adjustment.status != "APPROVED"
        or adjustment.approved_by is None
    ):
        raise _error(
            status.HTTP_409_CONFLICT,
            "The adjustment must be approved before posting.",
        )

    if not adjustment.items:
        raise _error(
            status.HTTP_409_CONFLICT,
            "Cannot post an adjustment without items.",
        )

    for line in sorted(
        adjustment.items,
        key=lambda item: (
            str(item.item_id),
            item.location,
            str(item.batch_id or ""),
            str(item.adjustment_item_id),
        ),
    ):
        post_stock_movement(
            db,
            item_id=line.item_id,
            movement_type="STOCK_ADJUSTMENT",
            direction=line.direction,
            location=line.location,
            quantity=Decimal(line.quantity),
            source_type="STOCK_ADJUSTMENT",
            source_id=adjustment.adjustment_id,
            source_line_id=line.adjustment_item_id,
            created_by=actor_id,
            batch_id=line.batch_id,
            unit_cost=(
                Decimal(line.unit_cost)
                if line.direction == "IN"
                else None
            ),
        )

    adjustment.status = "POSTED"
    adjustment.posted_at = datetime.now(timezone.utc)

    create_audit_log(
        db,
        user_id=actor_id,
        entity_type="StockAdjustment",
        entity_id=adjustment.adjustment_id,
        action="STOCK_ADJUSTMENT_POSTED",
        old_values={"status": "APPROVED"},
        new_values={
            "status": "POSTED",
            "posted_at": adjustment.posted_at.isoformat(),
            "item_count": len(adjustment.items),
        },
    )

    db.flush()
    return adjustment


def list_stock_movements(
    db: Session,
    *,
    item_id: UUID | None = None,
    batch_id: UUID | None = None,
    source_type: str | None = None,
    source_id: UUID | None = None,
    location: InventoryLocation | None = None,
    page: int = 1,
    page_size: int = 50,
) -> tuple[list[StockMovement], int]:
    """Return paginated, traceable inventory movement history."""

    if page < 1 or not 1 <= page_size <= 500:
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Invalid stock ledger pagination.",
        )

    filters = []

    if item_id is not None:
        filters.append(StockMovement.item_id == item_id)

    if batch_id is not None:
        filters.append(StockMovement.batch_id == batch_id)

    if source_type is not None:
        filters.append(
            StockMovement.source_type == source_type
        )

    if source_id is not None:
        filters.append(StockMovement.source_id == source_id)

    if location is not None:
        filters.append(
            StockMovement.location == _validate_location(location)
        )

    total = db.scalar(
        select(func.count())
        .select_from(StockMovement)
        .where(*filters)
    ) or 0

    movements = list(
        db.scalars(
            select(StockMovement)
            .where(*filters)
            .order_by(
                StockMovement.created_at.desc(),
                StockMovement.movement_id.desc(),
            )
            .offset((page - 1) * page_size)
            .limit(page_size)
        ).all()
    )

    return movements, total


def list_inventory_balances(
    db: Session,
    *,
    location: InventoryLocation | None = None,
) -> list[InventoryBalance]:
    """Return current item/location inventory balances."""

    statement = select(InventoryBalance)

    if location is not None:
        statement = statement.where(
            InventoryBalance.location == _validate_location(location)
        )

    return list(
        db.scalars(
            statement.order_by(
                InventoryBalance.item_id,
                InventoryBalance.location,
            )
        ).all()
    )


def calculate_inventory_valuation(
    db: Session,
    *,
    location: InventoryLocation | None = None,
) -> Decimal:
    """
    Calculate current inventory value from stored balance quantities
    and moving weighted-average unit costs.
    """

    balances = list_inventory_balances(
        db,
        location=location,
    )

    total = sum(
        (
            Decimal(balance.quantity_on_hand)
            * Decimal(balance.average_unit_cost)
            for balance in balances
        ),
        Decimal("0"),
    )

    return total.quantize(
        Decimal("0.01"),
        rounding=ROUND_HALF_UP,
    )