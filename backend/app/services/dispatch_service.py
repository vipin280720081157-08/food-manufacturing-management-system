"""
Finished-goods dispatch management.

Dispatches are created against posted GST invoices belonging to
approved sales orders. Draft dispatches do not change inventory.

Posting a dispatch:
- Validates invoice and sales-order authorization.
- Prevents over-dispatch against invoice and order quantities.
- Validates batch ownership, expiry, and available warehouse stock.
- Enforces first-expiry-first-out (FEFO) allocation.
- Posts one stock-out movement per dispatch item.
- Updates the sales-order fulfillment status.
- Records an audit entry in the same database transaction.

The caller controls transaction commit and rollback.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Mapping, Sequence
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from uuid import UUID, uuid4

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.models.dispatch import Dispatch, DispatchItem
from app.models.inventory import InventoryBalance, StockBatch
from app.models.invoicing import Invoice, InvoiceItem
from app.models.product import InventoryItem
from app.models.sales import SalesOrder, SalesOrderItem
from app.models.user import User
from app.services.audit_service import create_audit_log
from app.services.inventory_service import post_stock_movement


ZERO = Decimal("0")
QUANTITY_QUANTUM = Decimal("0.001")

FACTORY_ADMIN_ROLE = "Factory Admin"

READ_ROLES = frozenset(
    {
        "Factory Admin",
        "Production Supervisor",
        "Accountant/Auditor",
        "Owner",
    }
)

DISPATCH_STATUSES = frozenset(
    {"DRAFT", "POSTED", "CANCELLED"}
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


def _quantity(value: object) -> Decimal:
    number = _decimal(value, "quantity")

    if (
        number <= ZERO
        or number != number.quantize(QUANTITY_QUANTUM)
    ):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Dispatch quantity must be positive with at most "
            "three decimal places.",
        )

    return number


def _reference(
    value: str,
    field: str,
    *,
    maximum_length: int = 100,
) -> str:
    if not isinstance(value, str):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"{field} must be a string.",
        )

    normalized = value.strip()

    if not 1 <= len(normalized) <= maximum_length:
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"{field} must contain 1 to {maximum_length} characters.",
        )

    return normalized


def _require_role(
    db: Session,
    actor_id: UUID,
    *,
    write: bool,
) -> User:
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

    allowed_roles = (
        {FACTORY_ADMIN_ROLE}
        if write
        else READ_ROLES
    )

    if role.role_name not in allowed_roles:
        raise _error(
            status.HTTP_403_FORBIDDEN,
            "Dispatch access is not permitted for this role.",
        )

    return user


def _dispatch_query():
    return select(Dispatch).options(
        selectinload(Dispatch.items),
        selectinload(Dispatch.invoice),
    )


def _get_dispatch(
    db: Session,
    dispatch_id: UUID,
    *,
    lock: bool = False,
) -> Dispatch:
    statement = _dispatch_query().where(
        Dispatch.dispatch_id == dispatch_id
    )

    if lock:
        statement = statement.with_for_update(of=Dispatch)

    dispatch = db.scalar(statement)

    if dispatch is None:
        raise _error(
            status.HTTP_404_NOT_FOUND,
            "Dispatch not found.",
        )

    return dispatch


def _get_invoice(
    db: Session,
    invoice_id: UUID,
    *,
    lock: bool = False,
) -> Invoice:
    statement = (
        select(Invoice)
        .where(Invoice.invoice_id == invoice_id)
        .options(selectinload(Invoice.items))
    )

    if lock:
        statement = statement.with_for_update(of=Invoice)

    invoice = db.scalar(statement)

    if invoice is None:
        raise _error(
            status.HTTP_404_NOT_FOUND,
            "Invoice not found.",
        )

    return invoice


def _get_order(
    db: Session,
    order_id: UUID,
    *,
    lock: bool = False,
) -> SalesOrder:
    statement = (
        select(SalesOrder)
        .where(SalesOrder.sales_order_id == order_id)
        .options(selectinload(SalesOrder.items))
    )

    if lock:
        statement = statement.with_for_update(of=SalesOrder)

    order = db.scalar(statement)

    if order is None:
        raise _error(
            status.HTTP_409_CONFLICT,
            "The invoice's sales order no longer exists.",
        )

    return order


def _validate_invoice_and_order(
    invoice: Invoice,
    order: SalesOrder,
) -> None:
    if invoice.status != "POSTED":
        raise _error(
            status.HTTP_409_CONFLICT,
            "Dispatch requires a posted invoice.",
        )

    if invoice.invoice_type != "TAX_INVOICE":
        raise _error(
            status.HTTP_409_CONFLICT,
            "Dispatch cannot be created against a credit note.",
        )

    if invoice.order_id != order.sales_order_id:
        raise _error(
            status.HTTP_409_CONFLICT,
            "Invoice does not belong to the selected sales order.",
        )

    if invoice.customer_id != order.customer_id:
        raise _error(
            status.HTTP_409_CONFLICT,
            "Invoice and sales-order customers do not match.",
        )

    if order.approval_status != "APPROVED":
        raise _error(
            status.HTTP_409_CONFLICT,
            "Dispatch requires an approved sales order.",
        )


def _posted_invoice_quantities(
    db: Session,
    invoice_id: UUID,
) -> dict[UUID, Decimal]:
    rows = db.execute(
        select(
            DispatchItem.invoice_item_id,
            func.sum(DispatchItem.quantity),
        )
        .join(
            Dispatch,
            Dispatch.dispatch_id == DispatchItem.dispatch_id,
        )
        .where(
            Dispatch.invoice_id == invoice_id,
            Dispatch.status == "POSTED",
        )
        .group_by(DispatchItem.invoice_item_id)
    ).all()

    return {
        invoice_item_id: Decimal(quantity)
        for invoice_item_id, quantity in rows
    }


def _posted_order_quantities(
    db: Session,
    order_id: UUID,
) -> dict[UUID, Decimal]:
    rows = db.execute(
        select(
            InvoiceItem.order_item_id,
            func.sum(DispatchItem.quantity),
        )
        .join(
            Dispatch,
            Dispatch.dispatch_id == DispatchItem.dispatch_id,
        )
        .join(
            Invoice,
            Invoice.invoice_id == Dispatch.invoice_id,
        )
        .join(
            InvoiceItem,
            InvoiceItem.invoice_item_id
            == DispatchItem.invoice_item_id,
        )
        .where(
            Invoice.order_id == order_id,
            Dispatch.status == "POSTED",
        )
        .group_by(InvoiceItem.order_item_id)
    ).all()

    return {
        order_item_id: Decimal(quantity)
        for order_item_id, quantity in rows
        if order_item_id is not None
    }


def _batch_sort_key(
    batch: StockBatch,
) -> tuple[date, date, str]:
    return (
        batch.expiry_date or date.max,
        batch.manufacturing_date or date.min,
        str(batch.batch_id),
    )


def _eligible_batches(
    db: Session,
    *,
    product_id: UUID,
    dispatch_date: date,
    lock: bool = False,
) -> list[StockBatch]:
    statement = select(StockBatch).where(
        StockBatch.item_id == product_id,
        StockBatch.quantity_remaining > ZERO,
        (
            (StockBatch.expiry_date.is_(None))
            | (StockBatch.expiry_date >= dispatch_date)
        ),
    )

    if lock:
        statement = statement.with_for_update(of=StockBatch)

    batches = list(db.scalars(statement).all())
    batches.sort(key=_batch_sort_key)

    return batches


def _validate_product(
    db: Session,
    product_id: UUID,
) -> InventoryItem:
    item = db.get(InventoryItem, product_id)

    if (
        item is None
        or not item.is_active
        or item.item_type != "FINISHED_PRODUCT"
    ):
        raise _error(
            status.HTTP_409_CONFLICT,
            "Dispatch requires an active finished product.",
        )

    return item


def _build_dispatch_items(
    db: Session,
    *,
    invoice: Invoice,
    order: SalesOrder,
    dispatch_date: date,
    items: Sequence[Mapping[str, object]],
) -> list[DispatchItem]:
    if not items:
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "A dispatch requires at least one item.",
        )

    invoice_lines = {
        line.invoice_item_id: line
        for line in invoice.items
    }

    order_lines = {
        line.sales_order_item_id: line
        for line in order.items
    }

    previous_invoice = _posted_invoice_quantities(
        db,
        invoice.invoice_id,
    )

    previous_order = _posted_order_quantities(
        db,
        order.sales_order_id,
    )

    requested_invoice: dict[UUID, Decimal] = defaultdict(
        lambda: ZERO
    )
    requested_order: dict[UUID, Decimal] = defaultdict(
        lambda: ZERO
    )
    requested_batch: dict[UUID, Decimal] = defaultdict(
        lambda: ZERO
    )

    seen: set[tuple[UUID, UUID]] = set()
    result: list[DispatchItem] = []

    for data in items:
        if not isinstance(data, Mapping):
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Each dispatch item must be an object.",
            )

        invoice_item_id = data.get("invoice_item_id")
        batch_id = data.get("batch_id")

        if (
            not isinstance(invoice_item_id, UUID)
            or not isinstance(batch_id, UUID)
        ):
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Each dispatch item requires valid invoice_item_id "
                "and batch_id values.",
            )

        pair = (invoice_item_id, batch_id)

        if pair in seen:
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Duplicate invoice-line and batch allocations "
                "are not permitted.",
            )

        seen.add(pair)

        invoice_line = invoice_lines.get(invoice_item_id)

        if invoice_line is None:
            raise _error(
                status.HTTP_409_CONFLICT,
                "Dispatch item does not belong to the invoice.",
            )

        order_line = order_lines.get(invoice_line.order_item_id)

        if (
            order_line is None
            or order_line.product_id != invoice_line.product_id
        ):
            raise _error(
                status.HTTP_409_CONFLICT,
                "Invoice item does not match the approved sales order.",
            )

        _validate_product(db, invoice_line.product_id)

        quantity = _quantity(data.get("quantity"))

        batch = db.get(StockBatch, batch_id)

        if batch is None or batch.item_id != invoice_line.product_id:
            raise _error(
                status.HTTP_409_CONFLICT,
                "Selected batch does not belong to the invoiced product.",
            )

        if (
            batch.expiry_date is not None
            and batch.expiry_date < dispatch_date
        ):
            raise _error(
                status.HTTP_409_CONFLICT,
                "Expired stock batches cannot be dispatched.",
            )

        requested_invoice[invoice_item_id] += quantity
        requested_order[invoice_line.order_item_id] += quantity
        requested_batch[batch_id] += quantity

        result.append(
            DispatchItem(
                invoice_item_id=invoice_item_id,
                product_id=invoice_line.product_id,
                batch_id=batch_id,
                quantity=quantity,
            )
        )

    for invoice_item_id, requested in requested_invoice.items():
        invoice_line = invoice_lines[invoice_item_id]

        if (
            previous_invoice.get(invoice_item_id, ZERO)
            + requested
            > Decimal(invoice_line.quantity)
        ):
            raise _error(
                status.HTTP_409_CONFLICT,
                "Dispatch quantity exceeds the remaining "
                "invoiced quantity.",
            )

    for order_item_id, requested in requested_order.items():
        order_line = order_lines[order_item_id]

        if (
            previous_order.get(order_item_id, ZERO)
            + requested
            > Decimal(order_line.quantity)
        ):
            raise _error(
                status.HTTP_409_CONFLICT,
                "Dispatch quantity exceeds the remaining "
                "approved sales-order quantity.",
            )

    for batch_id, requested in requested_batch.items():
        batch = db.get(StockBatch, batch_id)

        if batch is None or requested > Decimal(
            batch.quantity_remaining
        ):
            raise _error(
                status.HTTP_409_CONFLICT,
                "Insufficient quantity in a selected stock batch.",
            )

    return result


def create_dispatch(
    db: Session,
    *,
    actor_id: UUID,
    invoice_id: UUID,
    dispatch_date: date,
    items: Sequence[Mapping[str, object]],
    dispatch_number: str | None = None,
    delivery_reference: str | None = None,
) -> Dispatch:
    """Create a draft dispatch without deducting stock."""

    _require_role(db, actor_id, write=True)

    if not isinstance(dispatch_date, date) or isinstance(
        dispatch_date, datetime
    ):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "A valid dispatch date is required.",
        )

    invoice = _get_invoice(db, invoice_id, lock=True)
    order = _get_order(db, invoice.order_id, lock=True)

    _validate_invoice_and_order(invoice, order)

    if dispatch_date < invoice.invoice_date:
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Dispatch date cannot precede invoice date.",
        )

    number = (
        _reference(dispatch_number, "dispatch_number")
        if dispatch_number is not None
        else f"DIS-{uuid4().hex.upper()}"
    )

    existing = db.scalar(
        select(Dispatch.dispatch_id).where(
            Dispatch.dispatch_number == number
        )
    )

    if existing is not None:
        raise _error(
            status.HTTP_409_CONFLICT,
            "Dispatch number already exists.",
        )

    if delivery_reference is not None:
        delivery_reference = _reference(
            delivery_reference,
            "delivery_reference",
            maximum_length=150,
        )

    dispatch_items = _build_dispatch_items(
        db,
        invoice=invoice,
        order=order,
        dispatch_date=dispatch_date,
        items=items,
    )

    dispatch = Dispatch(
        invoice_id=invoice_id,
        dispatch_number=number,
        dispatch_date=dispatch_date,
        delivery_reference=delivery_reference,
        status="DRAFT",
    )

    dispatch.items.extend(dispatch_items)

    db.add(dispatch)
    db.flush()

    create_audit_log(
        db,
        user_id=actor_id,
        entity_type="Dispatch",
        entity_id=dispatch.dispatch_id,
        action="DISPATCH_CREATED",
        new_values={
            "dispatch_number": dispatch.dispatch_number,
            "invoice_id": str(invoice_id),
            "dispatch_date": dispatch_date.isoformat(),
            "status": "DRAFT",
            "items": [
                {
                    "invoice_item_id": str(line.invoice_item_id),
                    "product_id": str(line.product_id),
                    "batch_id": str(line.batch_id),
                    "quantity": str(line.quantity),
                }
                for line in dispatch.items
            ],
        },
    )

    return dispatch


def get_dispatch(
    db: Session,
    *,
    dispatch_id: UUID,
    actor_id: UUID,
) -> Dispatch:
    """Retrieve a dispatch subject to role-based authorization."""

    _require_role(db, actor_id, write=False)
    return _get_dispatch(db, dispatch_id)


def list_dispatches(
    db: Session,
    *,
    actor_id: UUID,
    invoice_id: UUID | None = None,
    dispatch_status: str | None = None,
    page: int = 1,
    page_size: int = 50,
) -> tuple[list[Dispatch], int]:
    """Return authorized dispatch records with pagination."""

    _require_role(db, actor_id, write=False)

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

    if invoice_id is not None:
        filters.append(Dispatch.invoice_id == invoice_id)

    if dispatch_status is not None:
        if dispatch_status not in DISPATCH_STATUSES:
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Invalid dispatch status.",
            )

        filters.append(Dispatch.status == dispatch_status)

    total = db.scalar(
        select(func.count())
        .select_from(Dispatch)
        .where(*filters)
    ) or 0

    dispatches = list(
        db.scalars(
            _dispatch_query()
            .where(*filters)
            .order_by(
                Dispatch.dispatch_date.desc(),
                Dispatch.dispatch_id.desc(),
            )
            .offset((page - 1) * page_size)
            .limit(page_size)
        ).all()
    )

    return dispatches, total


def _validate_fefo_allocation(
    db: Session,
    *,
    dispatch_date: date,
    items: Sequence[DispatchItem],
) -> None:
    """
    Ensure allocations consume earlier-expiring eligible stock first.

    An allocation may use a later-expiring batch only when all
    earlier eligible batches of that product are exhausted by
    the same dispatch or have no remaining stock.
    """

    by_product: dict[UUID, dict[UUID, Decimal]] = defaultdict(
        lambda: defaultdict(lambda: ZERO)
    )

    for line in items:
        by_product[line.product_id][line.batch_id] += Decimal(
            line.quantity
        )

    for product_id, allocations in by_product.items():
        batches = _eligible_batches(
            db,
            product_id=product_id,
            dispatch_date=dispatch_date,
            lock=True,
        )

        eligible_ids = {
            batch.batch_id
            for batch in batches
        }

        if not set(allocations).issubset(eligible_ids):
            raise _error(
                status.HTTP_409_CONFLICT,
                "A selected batch is unavailable or expired.",
            )

        total_requested = sum(
            allocations.values(),
            ZERO,
        )

        total_available = sum(
            (
                Decimal(batch.quantity_remaining)
                for batch in batches
            ),
            ZERO,
        )

        if total_requested > total_available:
            raise _error(
                status.HTTP_409_CONFLICT,
                "Insufficient eligible finished-goods stock.",
            )

        remaining_request = total_requested

        for batch in batches:
            available = Decimal(batch.quantity_remaining)
            expected = min(
                remaining_request,
                available,
            )

            allocated = allocations.get(batch.batch_id, ZERO)

            if allocated != expected:
                raise _error(
                    status.HTTP_409_CONFLICT,
                    "Batch allocation violates FEFO. "
                    "Use the earliest-expiring eligible stock first.",
                )

            remaining_request -= expected

        if remaining_request != ZERO:
            raise _error(
                status.HTTP_409_CONFLICT,
                "FEFO allocation does not reconcile.",
            )


def _update_order_fulfillment(
    db: Session,
    *,
    order: SalesOrder,
) -> None:
    """
    Derive fulfillment from posted dispatches across the sales order.

    Invoice posting alone never changes fulfillment.
    """

    posted = _posted_order_quantities(
        db,
        order.sales_order_id,
    )

    if not posted or all(
        quantity == ZERO
        for quantity in posted.values()
    ):
        order.fulfillment_status = "NOT_DISPATCHED"
        return

    fully_dispatched = all(
        posted.get(line.sales_order_item_id, ZERO)
        >= Decimal(line.quantity)
        for line in order.items
    )

    order.fulfillment_status = (
        "DISPATCHED"
        if fully_dispatched
        else "PARTIALLY_DISPATCHED"
    )


def post_dispatch(
    db: Session,
    *,
    dispatch_id: UUID,
    actor_id: UUID,
) -> Dispatch:
    """
    Post a dispatch atomically and exactly once.

    The invoice and sales order are locked before validating
    remaining quantities. Inventory batch and balance locking
    is delegated to the inventory posting service.
    """

    _require_role(db, actor_id, write=True)

    dispatch = _get_dispatch(
        db,
        dispatch_id,
        lock=True,
    )

    if dispatch.status == "POSTED":
        return dispatch

    if dispatch.status != "DRAFT":
        raise _error(
            status.HTTP_409_CONFLICT,
            "Only draft dispatches may be posted.",
        )

    invoice = _get_invoice(
        db,
        dispatch.invoice_id,
        lock=True,
    )

    order = _get_order(
        db,
        invoice.order_id,
        lock=True,
    )

    _validate_invoice_and_order(invoice, order)

    if dispatch.dispatch_date < invoice.invoice_date:
        raise _error(
            status.HTTP_409_CONFLICT,
            "Dispatch date cannot precede invoice date.",
        )

    if not dispatch.items:
        raise _error(
            status.HTTP_409_CONFLICT,
            "Cannot post a dispatch without line items.",
        )

    invoice_lines = {
        line.invoice_item_id: line
        for line in invoice.items
    }

    order_lines = {
        line.sales_order_item_id: line
        for line in order.items
    }

    previous_invoice = _posted_invoice_quantities(
        db,
        invoice.invoice_id,
    )

    previous_order = _posted_order_quantities(
        db,
        order.sales_order_id,
    )

    current_invoice: dict[UUID, Decimal] = defaultdict(
        lambda: ZERO
    )
    current_order: dict[UUID, Decimal] = defaultdict(
        lambda: ZERO
    )
    current_batch: dict[UUID, Decimal] = defaultdict(
        lambda: ZERO
    )

    seen: set[tuple[UUID, UUID]] = set()

    for line in dispatch.items:
        invoice_line = invoice_lines.get(line.invoice_item_id)

        if invoice_line is None:
            raise _error(
                status.HTTP_409_CONFLICT,
                "Dispatch item does not belong to the posted invoice.",
            )

        order_line = order_lines.get(
            invoice_line.order_item_id
        )

        if (
            order_line is None
            or line.product_id != invoice_line.product_id
            or line.product_id != order_line.product_id
        ):
            raise _error(
                status.HTTP_409_CONFLICT,
                "Dispatch product does not match the approved order.",
            )

        _validate_product(db, line.product_id)

        quantity = _quantity(line.quantity)
        pair = (line.invoice_item_id, line.batch_id)

        if pair in seen:
            raise _error(
                status.HTTP_409_CONFLICT,
                "Duplicate dispatch batch allocation detected.",
            )

        seen.add(pair)

        current_invoice[line.invoice_item_id] += quantity
        current_order[invoice_line.order_item_id] += quantity
        current_batch[line.batch_id] += quantity

    for invoice_item_id, quantity in current_invoice.items():
        source = invoice_lines[invoice_item_id]

        if (
            previous_invoice.get(invoice_item_id, ZERO)
            + quantity
            > Decimal(source.quantity)
        ):
            raise _error(
                status.HTTP_409_CONFLICT,
                "Dispatch exceeds the remaining invoiced quantity.",
            )

    for order_item_id, quantity in current_order.items():
        source = order_lines[order_item_id]

        if (
            previous_order.get(order_item_id, ZERO)
            + quantity
            > Decimal(source.quantity)
        ):
            raise _error(
                status.HTTP_409_CONFLICT,
                "Dispatch exceeds the remaining approved "
                "sales-order quantity.",
            )

    _validate_fefo_allocation(
        db,
        dispatch_date=dispatch.dispatch_date,
        items=dispatch.items,
    )

    for batch_id in sorted(current_batch, key=str):
        batch = db.scalar(
            select(StockBatch)
            .where(StockBatch.batch_id == batch_id)
            .with_for_update(of=StockBatch)
        )

        if (
            batch is None
            or Decimal(batch.quantity_remaining)
            < current_batch[batch_id]
        ):
            raise _error(
                status.HTTP_409_CONFLICT,
                "Insufficient quantity in a selected stock batch.",
            )

        if (
            batch.expiry_date is not None
            and batch.expiry_date < dispatch.dispatch_date
        ):
            raise _error(
                status.HTTP_409_CONFLICT,
                "Expired batches cannot be dispatched.",
            )

    by_product: dict[UUID, Decimal] = defaultdict(
        lambda: ZERO
    )

    for line in dispatch.items:
        by_product[line.product_id] += Decimal(line.quantity)

    for product_id in sorted(by_product, key=str):
        balance = db.scalar(
            select(InventoryBalance)
            .where(
                InventoryBalance.item_id == product_id,
                InventoryBalance.location == "WAREHOUSE",
            )
            .with_for_update(of=InventoryBalance)
        )

        if (
            balance is None
            or Decimal(balance.quantity_on_hand)
            < by_product[product_id]
        ):
            raise _error(
                status.HTTP_409_CONFLICT,
                "Insufficient warehouse finished-goods inventory.",
            )

    for line in sorted(
        dispatch.items,
        key=lambda item: (
            str(item.product_id),
            str(item.batch_id),
            str(item.dispatch_item_id),
        ),
    ):
        post_stock_movement(
            db,
            item_id=line.product_id,
            movement_type="DISPATCH",
            direction="OUT",
            location="WAREHOUSE",
            quantity=Decimal(line.quantity),
            source_type="DISPATCH",
            source_id=dispatch.dispatch_id,
            source_line_id=line.dispatch_item_id,
            created_by=actor_id,
            batch_id=line.batch_id,
        )

    dispatch.status = "POSTED"
    dispatch.posted_at = datetime.now(timezone.utc)

    db.flush()

    previous_fulfillment = order.fulfillment_status

    _update_order_fulfillment(
        db,
        order=order,
    )

    db.flush()

    create_audit_log(
        db,
        user_id=actor_id,
        entity_type="Dispatch",
        entity_id=dispatch.dispatch_id,
        action="DISPATCH_POSTED",
        old_values={"status": "DRAFT"},
        new_values={
            "status": "POSTED",
            "posted_at": dispatch.posted_at.isoformat(),
            "invoice_id": str(invoice.invoice_id),
            "sales_order_id": str(order.sales_order_id),
            "fulfillment_status": order.fulfillment_status,
            "items": [
                {
                    "dispatch_item_id": str(line.dispatch_item_id),
                    "invoice_item_id": str(line.invoice_item_id),
                    "product_id": str(line.product_id),
                    "batch_id": str(line.batch_id),
                    "quantity": str(line.quantity),
                }
                for line in dispatch.items
            ],
        },
    )

    if previous_fulfillment != order.fulfillment_status:
        create_audit_log(
            db,
            user_id=actor_id,
            entity_type="SalesOrder",
            entity_id=order.sales_order_id,
            action="SALES_ORDER_FULFILLMENT_UPDATED",
            old_values={
                "fulfillment_status": previous_fulfillment,
            },
            new_values={
                "fulfillment_status": order.fulfillment_status,
                "dispatch_id": str(dispatch.dispatch_id),
            },
        )

    return dispatch


def cancel_draft_dispatch(
    db: Session,
    *,
    dispatch_id: UUID,
    actor_id: UUID,
    reason: str,
) -> Dispatch:
    """
    Cancel an unposted dispatch without changing stock.

    Posted dispatches require an authorized stock-reversal workflow.
    """

    _require_role(db, actor_id, write=True)

    if not isinstance(reason, str) or not reason.strip():
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "A cancellation reason is required.",
        )

    dispatch = _get_dispatch(
        db,
        dispatch_id,
        lock=True,
    )

    if dispatch.status == "CANCELLED":
        return dispatch

    if dispatch.status != "DRAFT":
        raise _error(
            status.HTTP_409_CONFLICT,
            "Posted dispatches cannot be cancelled directly.",
        )

    dispatch.status = "CANCELLED"

    db.flush()

    create_audit_log(
        db,
        user_id=actor_id,
        entity_type="Dispatch",
        entity_id=dispatch.dispatch_id,
        action="DISPATCH_CANCELLED",
        old_values={"status": "DRAFT"},
        new_values={
            "status": "CANCELLED",
            "reason": reason.strip(),
        },
    )

    return dispatch


def get_invoice_dispatch_balance(
    db: Session,
    *,
    invoice_id: UUID,
    actor_id: UUID,
) -> dict[str, object]:
    """
    Return invoiced, dispatched, and outstanding quantities.

    This report measures dispatch authorization, not current
    warehouse availability.
    """

    _require_role(db, actor_id, write=False)

    invoice = _get_invoice(db, invoice_id)
    dispatched = _posted_invoice_quantities(
        db,
        invoice_id,
    )

    lines = []

    for line in invoice.items:
        invoiced_quantity = Decimal(line.quantity)
        dispatched_quantity = dispatched.get(
            line.invoice_item_id,
            ZERO,
        )

        lines.append(
            {
                "invoice_item_id": line.invoice_item_id,
                "product_id": line.product_id,
                "invoiced_quantity": invoiced_quantity,
                "dispatched_quantity": dispatched_quantity,
                "remaining_quantity": max(
                    ZERO,
                    invoiced_quantity - dispatched_quantity,
                ),
            }
        )

    return {
        "invoice_id": invoice.invoice_id,
        "invoice_status": invoice.status,
        "items": lines,
    }


def get_fefo_batch_availability(
    db: Session,
    *,
    product_id: UUID,
    dispatch_date: date,
    actor_id: UUID,
) -> dict[str, object]:
    """Return eligible batches in FEFO order."""

    _require_role(db, actor_id, write=False)
    _validate_product(db, product_id)

    if not isinstance(dispatch_date, date) or isinstance(
        dispatch_date, datetime
    ):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "A valid dispatch date is required.",
        )

    batches = _eligible_batches(
        db,
        product_id=product_id,
        dispatch_date=dispatch_date,
    )

    available = sum(
        (
            Decimal(batch.quantity_remaining)
            for batch in batches
        ),
        ZERO,
    )

    return {
        "product_id": product_id,
        "dispatch_date": dispatch_date,
        "available_quantity": available,
        "batches": [
            {
                "batch_id": batch.batch_id,
                "batch_number": batch.batch_number,
                "manufacturing_date": batch.manufacturing_date,
                "expiry_date": batch.expiry_date,
                "quantity_remaining": Decimal(
                    batch.quantity_remaining
                ),
            }
            for batch in batches
        ],
    }