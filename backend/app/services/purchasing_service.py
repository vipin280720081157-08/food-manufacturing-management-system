"""
Purchase-order and goods-receipt business services.

Purchase orders record supplier commitments without changing inventory.
Only posting an accepted goods receipt creates stock batches, stock
movements, and warehouse inventory balances.

All writes, inventory movements, and audit entries participate in the
caller's database transaction. This module never commits transactions.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from uuid import UUID, uuid4

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.models.product import InventoryItem
from app.models.purchasing import (
    GoodsReceipt,
    GoodsReceiptItem,
    PurchaseOrder,
    PurchaseOrderItem,
)
from app.models.supplier import Supplier
from app.models.user import User
from app.services.audit_service import create_audit_log
from app.services.inventory_service import (
    create_stock_batch,
    post_stock_movement,
)


ZERO = Decimal("0")
QUANTITY_QUANTUM = Decimal("0.001")
MONEY_QUANTUM = Decimal("0.01")
TAX_RATE_QUANTUM = Decimal("0.0001")
UNIT_COST_QUANTUM = Decimal("0.000001")

FACTORY_ADMIN = "Factory Admin"
PRODUCTION_SUPERVISOR = "Production Supervisor"

PURCHASE_STATUSES = frozenset(
    {
        "DRAFT",
        "SUBMITTED",
        "APPROVED",
        "REJECTED",
        "PARTIALLY_RECEIVED",
        "RECEIVED",
        "CANCELLED",
    }
)

RECEIPT_ROLES = frozenset(
    {FACTORY_ADMIN, PRODUCTION_SUPERVISOR}
)


def _error(code: int, detail: str) -> HTTPException:
    return HTTPException(status_code=code, detail=detail)


def _decimal(value: object, field: str) -> Decimal:
    if isinstance(value, (bool, float)):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"{field} must use exact decimal arithmetic.",
        )

    try:
        result = Decimal(value)
    except (InvalidOperation, ValueError, TypeError):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"{field} must be a valid decimal.",
        ) from None

    if not result.is_finite():
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"{field} must be finite.",
        )

    return result


def _quantity(
    value: object,
    *,
    allow_zero: bool = False,
) -> Decimal:
    number = _decimal(value, "quantity")

    if (
        number < ZERO
        or (not allow_zero and number == ZERO)
        or number != number.quantize(QUANTITY_QUANTUM)
    ):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Quantity must be "
            + ("nonnegative" if allow_zero else "positive")
            + " with at most three decimal places.",
        )

    return number


def _money(value: object) -> Decimal:
    number = _decimal(value, "unit price")

    if (
        number < ZERO
        or number != number.quantize(MONEY_QUANTUM)
    ):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Unit price must be nonnegative with "
            "at most two decimal places.",
        )

    return number


def _tax_rate(value: object) -> Decimal:
    number = _decimal(value, "tax rate")

    if (
        not ZERO <= number <= Decimal("100")
        or number != number.quantize(TAX_RATE_QUANTUM)
    ):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Tax rate must be between 0 and 100 "
            "with at most four decimal places.",
        )

    return number


def _round_money(value: Decimal) -> Decimal:
    return value.quantize(
        MONEY_QUANTUM,
        rounding=ROUND_HALF_UP,
    )


def _unit_cost(value: Decimal) -> Decimal:
    return value.quantize(
        UNIT_COST_QUANTUM,
        rounding=ROUND_HALF_UP,
    )


def _reference(value: str, field: str) -> str:
    if not isinstance(value, str):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"{field} must be a string.",
        )

    normalized = value.strip()

    if not 1 <= len(normalized) <= 100:
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"{field} must contain 1 to 100 characters.",
        )

    return normalized


def _actor(db: Session, actor_id: UUID) -> tuple[User, str]:
    user = db.get(User, actor_id)

    if user is None or not user.is_active:
        raise _error(
            status.HTTP_403_FORBIDDEN,
            "An active user account is required.",
        )

    role = user.primary_role

    if role is None:
        raise _error(
            status.HTTP_403_FORBIDDEN,
            "An assigned application role is required.",
        )

    return user, role.role_name


def _require_admin(db: Session, actor_id: UUID) -> User:
    user, role = _actor(db, actor_id)

    if role != FACTORY_ADMIN:
        raise _error(
            status.HTTP_403_FORBIDDEN,
            "Factory Admin authorization is required.",
        )

    return user


def _require_receiver(db: Session, actor_id: UUID) -> User:
    user, role = _actor(db, actor_id)

    if role not in RECEIPT_ROLES:
        raise _error(
            status.HTTP_403_FORBIDDEN,
            "Material-receipt authorization is required.",
        )

    return user


def _supplier(db: Session, supplier_id: UUID) -> Supplier:
    supplier = db.get(Supplier, supplier_id)

    if supplier is None:
        raise _error(
            status.HTTP_404_NOT_FOUND,
            "Supplier not found.",
        )

    if not supplier.is_active:
        raise _error(
            status.HTTP_409_CONFLICT,
            "Inactive suppliers cannot receive new purchase orders.",
        )

    return supplier


def _inventory_item(
    db: Session,
    item_id: UUID,
) -> InventoryItem:
    item = db.get(InventoryItem, item_id)

    if item is None:
        raise _error(
            status.HTTP_404_NOT_FOUND,
            "Inventory item not found.",
        )

    if not item.is_active:
        raise _error(
            status.HTTP_409_CONFLICT,
            "Inactive inventory items cannot be purchased.",
        )

    if item.item_type not in {
        "RAW_MATERIAL",
        "PACKAGING_MATERIAL",
    }:
        raise _error(
            status.HTTP_409_CONFLICT,
            "Purchase orders may contain only raw materials "
            "and packaging materials.",
        )

    return item


def _purchase_order(
    db: Session,
    purchase_order_id: UUID,
    *,
    lock: bool = False,
) -> PurchaseOrder:
    statement = (
        select(PurchaseOrder)
        .where(
            PurchaseOrder.purchase_order_id == purchase_order_id
        )
        .options(
            selectinload(PurchaseOrder.items),
        )
    )

    if lock:
        statement = statement.with_for_update(of=PurchaseOrder)

    order = db.scalar(statement)

    if order is None:
        raise _error(
            status.HTTP_404_NOT_FOUND,
            "Purchase order not found.",
        )

    return order


def _goods_receipt(
    db: Session,
    receipt_id: UUID,
    *,
    lock: bool = False,
) -> GoodsReceipt:
    statement = (
        select(GoodsReceipt)
        .where(GoodsReceipt.receipt_id == receipt_id)
        .options(
            selectinload(GoodsReceipt.items),
        )
    )

    if lock:
        statement = statement.with_for_update(of=GoodsReceipt)

    receipt = db.scalar(statement)

    if receipt is None:
        raise _error(
            status.HTTP_404_NOT_FOUND,
            "Goods receipt not found.",
        )

    return receipt


def _purchase_line(
    db: Session,
    item_data: Mapping[str, object],
) -> PurchaseOrderItem:
    item_id = item_data.get("item_id")

    if not isinstance(item_id, UUID):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Each purchase line requires a valid item_id.",
        )

    _inventory_item(db, item_id)

    quantity = _quantity(item_data.get("quantity"))
    unit_price = _money(item_data.get("unit_price"))
    tax_rate = _tax_rate(
        item_data.get("tax_rate", Decimal("0"))
    )

    taxable_amount = _round_money(quantity * unit_price)
    tax_amount = _round_money(
        taxable_amount * tax_rate / Decimal("100")
    )

    return PurchaseOrderItem(
        item_id=item_id,
        quantity=quantity,
        unit_price=unit_price,
        tax_rate=tax_rate,
        line_total=taxable_amount + tax_amount,
    )


def _build_purchase_lines(
    db: Session,
    items: Sequence[Mapping[str, object]],
) -> list[PurchaseOrderItem]:
    if not items:
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "A purchase order requires at least one item.",
        )

    lines: list[PurchaseOrderItem] = []
    seen: set[UUID] = set()

    for data in items:
        line = _purchase_line(db, data)

        if line.item_id in seen:
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Duplicate inventory items are not permitted "
                "within a purchase order.",
            )

        seen.add(line.item_id)
        lines.append(line)

    return lines


def create_purchase_order(
    db: Session,
    *,
    actor_id: UUID,
    supplier_id: UUID,
    order_date: date,
    items: Sequence[Mapping[str, object]],
    expected_date: date | None = None,
    po_number: str | None = None,
) -> PurchaseOrder:
    """Create a draft purchase order without changing inventory."""

    _require_admin(db, actor_id)
    _supplier(db, supplier_id)

    if (
        expected_date is not None
        and expected_date < order_date
    ):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Expected date cannot precede order date.",
        )

    number = (
        _reference(po_number, "po_number")
        if po_number is not None
        else f"PO-{uuid4().hex.upper()}"
    )

    if db.scalar(
        select(PurchaseOrder.purchase_order_id).where(
            PurchaseOrder.po_number == number
        )
    ) is not None:
        raise _error(
            status.HTTP_409_CONFLICT,
            "Purchase-order number already exists.",
        )

    order = PurchaseOrder(
        supplier_id=supplier_id,
        po_number=number,
        order_date=order_date,
        expected_date=expected_date,
        status="DRAFT",
        created_by=actor_id,
    )

    order.items.extend(_build_purchase_lines(db, items))

    db.add(order)
    db.flush()

    create_audit_log(
        db,
        user_id=actor_id,
        entity_type="PurchaseOrder",
        entity_id=order.purchase_order_id,
        action="PURCHASE_ORDER_CREATED",
        new_values={
            "po_number": order.po_number,
            "supplier_id": order.supplier_id,
            "status": order.status,
            "item_count": len(order.items),
        },
    )

    return order


def get_purchase_order(
    db: Session,
    *,
    purchase_order_id: UUID,
) -> PurchaseOrder:
    """Return a purchase order with its line items."""

    return _purchase_order(db, purchase_order_id)


def list_purchase_orders(
    db: Session,
    *,
    supplier_id: UUID | None = None,
    order_status: str | None = None,
    page: int = 1,
    page_size: int = 50,
) -> tuple[list[PurchaseOrder], int]:
    """Return paginated purchase orders for an authorized caller."""

    if (
        isinstance(page, bool)
        or isinstance(page_size, bool)
        or not isinstance(page, int)
        or not isinstance(page_size, int)
        or page < 1
        or not 1 <= page_size <= 500
    ):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Invalid pagination parameters.",
        )

    filters = []

    if supplier_id is not None:
        filters.append(
            PurchaseOrder.supplier_id == supplier_id
        )

    if order_status is not None:
        if order_status not in PURCHASE_STATUSES:
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Invalid purchase-order status.",
            )

        filters.append(
            PurchaseOrder.status == order_status
        )

    total = db.scalar(
        select(func.count())
        .select_from(PurchaseOrder)
        .where(*filters)
    ) or 0

    orders = list(
        db.scalars(
            select(PurchaseOrder)
            .options(selectinload(PurchaseOrder.items))
            .where(*filters)
            .order_by(
                PurchaseOrder.order_date.desc(),
                PurchaseOrder.purchase_order_id.desc(),
            )
            .offset((page - 1) * page_size)
            .limit(page_size)
        ).all()
    )

    return orders, total


def update_purchase_order(
    db: Session,
    *,
    purchase_order_id: UUID,
    actor_id: UUID,
    expected_date: date | None = None,
    update_expected_date: bool = False,
    items: Sequence[Mapping[str, object]] | None = None,
) -> PurchaseOrder:
    """Update only an unsubmitted purchase-order draft."""

    _require_admin(db, actor_id)
    order = _purchase_order(
        db,
        purchase_order_id,
        lock=True,
    )

    if order.status != "DRAFT":
        raise _error(
            status.HTTP_409_CONFLICT,
            "Only draft purchase orders may be edited.",
        )

    if not update_expected_date and items is None:
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "At least one purchase-order field must be supplied.",
        )

    previous = {
        "expected_date": order.expected_date,
        "items": [
            {
                "item_id": str(line.item_id),
                "quantity": str(line.quantity),
                "unit_price": str(line.unit_price),
                "tax_rate": str(line.tax_rate),
            }
            for line in order.items
        ],
    }

    if update_expected_date:
        if (
            expected_date is not None
            and expected_date < order.order_date
        ):
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Expected date cannot precede order date.",
            )

        order.expected_date = expected_date

    if items is not None:
        replacement = _build_purchase_lines(db, items)

        old_by_item = {
            line.item_id: line
            for line in order.items
        }
        new_ids = {
            line.item_id
            for line in replacement
        }

        if not set(old_by_item).issubset(new_ids):
            raise _error(
                status.HTTP_409_CONFLICT,
                "Removing purchase-order lines requires "
                "a separate authorized correction workflow.",
            )

        for line in replacement:
            existing = old_by_item.get(line.item_id)

            if existing is None:
                order.items.append(line)
            else:
                existing.quantity = line.quantity
                existing.unit_price = line.unit_price
                existing.tax_rate = line.tax_rate
                existing.line_total = line.line_total

    db.flush()

    create_audit_log(
        db,
        user_id=actor_id,
        entity_type="PurchaseOrder",
        entity_id=order.purchase_order_id,
        action="PURCHASE_ORDER_UPDATED",
        old_values=previous,
        new_values={
            "expected_date": order.expected_date,
            "items": [
                {
                    "item_id": str(line.item_id),
                    "quantity": str(line.quantity),
                    "unit_price": str(line.unit_price),
                    "tax_rate": str(line.tax_rate),
                }
                for line in order.items
            ],
        },
    )

    return order


def change_purchase_order_status(
    db: Session,
    *,
    purchase_order_id: UUID,
    actor_id: UUID,
    new_status: str,
    reason: str | None = None,
) -> PurchaseOrder:
    """
    Perform an authorized purchase-order approval transition.

    Receiving statuses are maintained exclusively by goods-receipt
    posting, not by this function.
    """

    _require_admin(db, actor_id)
    order = _purchase_order(
        db,
        purchase_order_id,
        lock=True,
    )

    transitions = {
        "DRAFT": {"SUBMITTED", "CANCELLED"},
        "SUBMITTED": {"APPROVED", "REJECTED", "CANCELLED"},
        "REJECTED": {"CANCELLED"},
    }

    if order.status == new_status:
        return order

    if new_status not in transitions.get(order.status, set()):
        raise _error(
            status.HTTP_409_CONFLICT,
            "Invalid purchase-order status transition.",
        )

    if new_status in {"REJECTED", "CANCELLED"}:
        if not isinstance(reason, str) or not reason.strip():
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "A reason is required for rejection or cancellation.",
            )

    if new_status == "APPROVED" and order.created_by == actor_id:
        raise _error(
            status.HTTP_403_FORBIDDEN,
            "A purchase order cannot be self-approved.",
        )

    previous_status = order.status
    order.status = new_status

    create_audit_log(
        db,
        user_id=actor_id,
        entity_type="PurchaseOrder",
        entity_id=order.purchase_order_id,
        action=f"PURCHASE_ORDER_{new_status}",
        old_values={"status": previous_status},
        new_values={
            "status": new_status,
            "reason": reason,
        },
    )

    db.flush()
    return order


def _posted_received_quantities(
    db: Session,
    purchase_order_id: UUID,
) -> dict[UUID, Decimal]:
    """Return cumulative accepted quantities from posted receipts."""

    rows = db.execute(
        select(
            GoodsReceiptItem.po_item_id,
            func.sum(GoodsReceiptItem.accepted_quantity),
        )
        .join(
            GoodsReceipt,
            GoodsReceipt.receipt_id == GoodsReceiptItem.receipt_id,
        )
        .where(
            GoodsReceipt.purchase_order_id == purchase_order_id,
            GoodsReceipt.status == "POSTED",
        )
        .group_by(GoodsReceiptItem.po_item_id)
    ).all()

    return {
        po_item_id: Decimal(quantity)
        for po_item_id, quantity in rows
    }


def get_purchase_order_receipt_status(
    db: Session,
    *,
    purchase_order_id: UUID,
) -> dict[str, object]:
    """Calculate ordered, received, and outstanding quantities."""

    order = _purchase_order(db, purchase_order_id)
    received = _posted_received_quantities(
        db,
        purchase_order_id,
    )

    lines = []

    for line in order.items:
        accepted = received.get(line.po_item_id, ZERO)
        ordered = Decimal(line.quantity)

        lines.append(
            {
                "po_item_id": line.po_item_id,
                "item_id": line.item_id,
                "ordered_quantity": ordered,
                "received_quantity": accepted,
                "outstanding_quantity": max(
                    ZERO,
                    ordered - accepted,
                ),
            }
        )

    return {
        "purchase_order_id": order.purchase_order_id,
        "status": order.status,
        "items": lines,
    }


def create_goods_receipt(
    db: Session,
    *,
    actor_id: UUID,
    purchase_order_id: UUID,
    received_date: date,
    items: Sequence[Mapping[str, object]],
    receipt_number: str | None = None,
) -> GoodsReceipt:
    """
    Record a draft receipt against an approved purchase order.

    Draft receipts do not change stock. Accepted quantities must
    reconcile with received and rejected quantities.
    """

    _require_receiver(db, actor_id)

    order = _purchase_order(
        db,
        purchase_order_id,
        lock=True,
    )

    if order.status not in {
        "APPROVED",
        "PARTIALLY_RECEIVED",
    }:
        raise _error(
            status.HTTP_409_CONFLICT,
            "Goods may be received only against an approved "
            "or partially received purchase order.",
        )

    if received_date < order.order_date:
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Receipt date cannot precede purchase-order date.",
        )

    if not items:
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "A goods receipt requires at least one item.",
        )

    number = (
        _reference(receipt_number, "receipt_number")
        if receipt_number is not None
        else f"GRN-{uuid4().hex.upper()}"
    )

    if db.scalar(
        select(GoodsReceipt.receipt_id).where(
            GoodsReceipt.receipt_number == number
        )
    ) is not None:
        raise _error(
            status.HTTP_409_CONFLICT,
            "Goods-receipt number already exists.",
        )

    po_lines = {
        line.po_item_id: line
        for line in order.items
    }

    seen: set[UUID] = set()
    receipt = GoodsReceipt(
        purchase_order_id=purchase_order_id,
        receipt_number=number,
        received_date=received_date,
        received_by=actor_id,
        status="DRAFT",
    )

    for data in items:
        po_item_id = data.get("po_item_id")

        if not isinstance(po_item_id, UUID):
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "A receipt item requires a valid po_item_id.",
            )

        if po_item_id not in po_lines:
            raise _error(
                status.HTTP_409_CONFLICT,
                "Receipt line does not belong to the purchase order.",
            )

        if po_item_id in seen:
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Duplicate purchase-order lines are not permitted "
                "in one goods receipt.",
            )

        seen.add(po_item_id)

        received = _quantity(
            data.get("received_quantity")
        )
        accepted = _quantity(
            data.get("accepted_quantity"),
            allow_zero=True,
        )
        rejected = _quantity(
            data.get("rejected_quantity", ZERO),
            allow_zero=True,
        )

        if accepted + rejected != received:
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Accepted and rejected quantities must equal "
                "the received quantity.",
            )

        receipt.items.append(
            GoodsReceiptItem(
                po_item_id=po_item_id,
                received_quantity=received,
                accepted_quantity=accepted,
                rejected_quantity=rejected,
            )
        )

    db.add(receipt)
    db.flush()

    create_audit_log(
        db,
        user_id=actor_id,
        entity_type="GoodsReceipt",
        entity_id=receipt.receipt_id,
        action="GOODS_RECEIPT_CREATED",
        new_values={
            "receipt_number": receipt.receipt_number,
            "purchase_order_id": purchase_order_id,
            "status": receipt.status,
            "item_count": len(receipt.items),
        },
    )

    return receipt


def get_goods_receipt(
    db: Session,
    *,
    receipt_id: UUID,
) -> GoodsReceipt:
    """Return a goods receipt and its recorded quantities."""

    return _goods_receipt(db, receipt_id)


def list_goods_receipts(
    db: Session,
    *,
    purchase_order_id: UUID | None = None,
    receipt_status: str | None = None,
    page: int = 1,
    page_size: int = 50,
) -> tuple[list[GoodsReceipt], int]:
    """Return paginated goods receipts."""

    if (
        isinstance(page, bool)
        or isinstance(page_size, bool)
        or not isinstance(page, int)
        or not isinstance(page_size, int)
        or page < 1
        or not 1 <= page_size <= 500
    ):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Invalid pagination parameters.",
        )

    filters = []

    if purchase_order_id is not None:
        filters.append(
            GoodsReceipt.purchase_order_id == purchase_order_id
        )

    if receipt_status is not None:
        if receipt_status not in {"DRAFT", "POSTED", "CANCELLED"}:
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Invalid goods-receipt status.",
            )

        filters.append(
            GoodsReceipt.status == receipt_status
        )

    total = db.scalar(
        select(func.count())
        .select_from(GoodsReceipt)
        .where(*filters)
    ) or 0

    receipts = list(
        db.scalars(
            select(GoodsReceipt)
            .options(selectinload(GoodsReceipt.items))
            .where(*filters)
            .order_by(
                GoodsReceipt.received_date.desc(),
                GoodsReceipt.receipt_id.desc(),
            )
            .offset((page - 1) * page_size)
            .limit(page_size)
        ).all()
    )

    return receipts, total


def post_goods_receipt(
    db: Session,
    *,
    receipt_id: UUID,
    actor_id: UUID,
    batches: Mapping[UUID, Mapping[str, object]],
) -> GoodsReceipt:
    """
    Post accepted goods into warehouse stock exactly once.

    batches maps receipt_item_id to batch metadata:
      batch_number: required string
      manufacturing_date: optional date
      expiry_date: optional date

    The unit acquisition cost excludes recoverable GST and is
    taken from the approved purchase-order line.

    All stock batches, movements, balances, receipt status, purchase
    status, and audit entries share the caller's transaction.
    """

    _require_receiver(db, actor_id)

    receipt = _goods_receipt(
        db,
        receipt_id,
        lock=True,
    )

    if receipt.status == "POSTED":
        return receipt

    if receipt.status != "DRAFT":
        raise _error(
            status.HTTP_409_CONFLICT,
            "Only draft goods receipts may be posted.",
        )

    order = _purchase_order(
        db,
        receipt.purchase_order_id,
        lock=True,
    )

    if order.status not in {
        "APPROVED",
        "PARTIALLY_RECEIVED",
    }:
        raise _error(
            status.HTTP_409_CONFLICT,
            "The purchase order is not eligible for receipt posting.",
        )

    if not receipt.items:
        raise _error(
            status.HTTP_409_CONFLICT,
            "Cannot post an empty goods receipt.",
        )

    po_lines = {
        line.po_item_id: line
        for line in order.items
    }

    previously_received = _posted_received_quantities(
        db,
        order.purchase_order_id,
    )

    for line in receipt.items:
        purchase_line = po_lines.get(line.po_item_id)

        if purchase_line is None:
            raise _error(
                status.HTTP_409_CONFLICT,
                "A receipt line has no matching purchase-order line.",
            )

        accepted = Decimal(line.accepted_quantity)
        rejected = Decimal(line.rejected_quantity)
        received = Decimal(line.received_quantity)

        if (
            accepted < ZERO
            or rejected < ZERO
            or accepted + rejected != received
        ):
            raise _error(
                status.HTTP_409_CONFLICT,
                "Goods-receipt quantities do not reconcile.",
            )

        already_received = previously_received.get(
            line.po_item_id,
            ZERO,
        )

        if (
            already_received + accepted
            > Decimal(purchase_line.quantity)
        ):
            raise _error(
                status.HTTP_409_CONFLICT,
                "Accepted receipt quantity exceeds the "
                "outstanding purchase-order quantity.",
            )

    accepted_lines = [
        line
        for line in receipt.items
        if Decimal(line.accepted_quantity) > ZERO
    ]

    expected_batch_ids = {
        line.receipt_item_id
        for line in accepted_lines
    }

    if set(batches) != expected_batch_ids:
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Batch details must be supplied exactly once "
            "for every accepted receipt line.",
        )

    for line in sorted(
        accepted_lines,
        key=lambda entry: (
            str(po_lines[entry.po_item_id].item_id),
            str(entry.receipt_item_id),
        ),
    ):
        purchase_line = po_lines[line.po_item_id]
        metadata = batches[line.receipt_item_id]

        batch_number = metadata.get("batch_number")

        if not isinstance(batch_number, str):
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Each accepted receipt line requires a batch number.",
            )

        manufacturing_date = metadata.get(
            "manufacturing_date"
        )
        expiry_date = metadata.get("expiry_date")

        if manufacturing_date is not None and (
            not isinstance(manufacturing_date, date)
            or isinstance(manufacturing_date, datetime)
        ):
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Invalid manufacturing date.",
            )

        if expiry_date is not None and (
            not isinstance(expiry_date, date)
            or isinstance(expiry_date, datetime)
        ):
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Invalid expiry date.",
            )

        accepted_quantity = Decimal(line.accepted_quantity)
        acquisition_cost = _unit_cost(
            Decimal(purchase_line.unit_price)
        )

        batch = create_stock_batch(
            db,
            item_id=purchase_line.item_id,
            batch_number=batch_number,
            source_type="GOODS_RECEIPT",
            source_id=receipt.receipt_id,
            quantity=accepted_quantity,
            unit_cost=acquisition_cost,
            manufacturing_date=manufacturing_date,
            expiry_date=expiry_date,
        )

        post_stock_movement(
            db,
            item_id=purchase_line.item_id,
            movement_type="PURCHASE_RECEIPT",
            direction="IN",
            location="WAREHOUSE",
            quantity=accepted_quantity,
            source_type="GOODS_RECEIPT",
            source_id=receipt.receipt_id,
            source_line_id=line.receipt_item_id,
            created_by=actor_id,
            batch_id=batch.batch_id,
            unit_cost=acquisition_cost,
        )

    receipt.status = "POSTED"
    receipt.posted_at = datetime.now(timezone.utc)

    updated_received = {
        line_id: quantity
        for line_id, quantity in previously_received.items()
    }

    for line in receipt.items:
        updated_received[line.po_item_id] = (
            updated_received.get(line.po_item_id, ZERO)
            + Decimal(line.accepted_quantity)
        )

    all_received = all(
        updated_received.get(line.po_item_id, ZERO)
        >= Decimal(line.quantity)
        for line in order.items
    )

    any_received = any(
        quantity > ZERO
        for quantity in updated_received.values()
    )

    if all_received:
        order.status = "RECEIVED"
    elif any_received:
        order.status = "PARTIALLY_RECEIVED"

    db.flush()

    create_audit_log(
        db,
        user_id=actor_id,
        entity_type="GoodsReceipt",
        entity_id=receipt.receipt_id,
        action="GOODS_RECEIPT_POSTED",
        old_values={"status": "DRAFT"},
        new_values={
            "status": "POSTED",
            "posted_at": receipt.posted_at,
            "purchase_order_id": order.purchase_order_id,
            "purchase_order_status": order.status,
            "accepted_lines": len(accepted_lines),
        },
    )

    return receipt


def cancel_goods_receipt(
    db: Session,
    *,
    receipt_id: UUID,
    actor_id: UUID,
    reason: str,
) -> GoodsReceipt:
    """
    Cancel an unposted receipt without modifying inventory.

    Posted receipts require a separate authorized stock-reversal
    and supplier-correction workflow.
    """

    _require_admin(db, actor_id)

    if not isinstance(reason, str) or not reason.strip():
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "A cancellation reason is required.",
        )

    receipt = _goods_receipt(
        db,
        receipt_id,
        lock=True,
    )

    if receipt.status == "CANCELLED":
        return receipt

    if receipt.status == "POSTED":
        raise _error(
            status.HTTP_409_CONFLICT,
            "Posted goods receipts cannot be cancelled directly.",
        )

    receipt.status = "CANCELLED"

    create_audit_log(
        db,
        user_id=actor_id,
        entity_type="GoodsReceipt",
        entity_id=receipt.receipt_id,
        action="GOODS_RECEIPT_CANCELLED",
        old_values={"status": "DRAFT"},
        new_values={
            "status": "CANCELLED",
            "reason": reason.strip(),
        },
    )

    db.flush()
    return receipt