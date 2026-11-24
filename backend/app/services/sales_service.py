"""
Sales-order creation, editing, submission, approval, and reporting.

Sales orders retain transaction-time selling prices and GST rates.
Approval and fulfillment are separate states: approval does not
reserve inventory, create an invoice, or deduct stock.

Salesmen may manage only their own orders for assigned customers.
Factory Admin users may manage orders and make approval decisions.
All changes and audit entries remain in the caller's transaction.
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from uuid import UUID, uuid4

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.models.customer import Customer
from app.models.product import InventoryItem, Product
from app.models.sales import (
    OrderApprovalHistory,
    SalesOrder,
    SalesOrderItem,
)
from app.models.user import User
from app.services.audit_service import create_audit_log


MONEY_QUANTUM = Decimal("0.01")
QUANTITY_QUANTUM = Decimal("0.001")
TAX_RATE_QUANTUM = Decimal("0.0001")
ZERO = Decimal("0")

SALESMAN_ROLE = "Salesman"
FACTORY_ADMIN_ROLE = "Factory Admin"

READ_ROLES = frozenset(
    {
        "Salesman",
        "Factory Admin",
        "Production Supervisor",
        "Accountant/Auditor",
        "Owner",
    }
)


def _error(code: int, message: str) -> HTTPException:
    return HTTPException(status_code=code, detail=message)


def _decimal(value: Decimal | int | str, name: str) -> Decimal:
    if isinstance(value, (bool, float)):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"{name} must use exact decimal arithmetic.",
        )

    try:
        result = Decimal(value)
    except (InvalidOperation, ValueError, TypeError):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"{name} must be a valid decimal.",
        ) from None

    if not result.is_finite():
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"{name} must be finite.",
        )

    return result


def _money(value: Decimal) -> Decimal:
    return value.quantize(
        MONEY_QUANTUM,
        rounding=ROUND_HALF_UP,
    )


def _validate_quantity(value: Decimal | int | str) -> Decimal:
    quantity = _decimal(value, "quantity")

    if (
        quantity <= ZERO
        or quantity != quantity.quantize(QUANTITY_QUANTUM)
    ):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Quantity must be positive with at most three decimal places.",
        )

    return quantity


def _validate_price(value: Decimal | int | str) -> Decimal:
    price = _decimal(value, "unit price")

    if (
        price < ZERO
        or price != price.quantize(MONEY_QUANTUM)
    ):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Unit price must be nonnegative with at most two decimal places.",
        )

    return price


def _validate_tax_rate(value: Decimal | int | str) -> Decimal:
    rate = _decimal(value, "GST rate")

    if (
        not ZERO <= rate <= Decimal("100")
        or rate != rate.quantize(TAX_RATE_QUANTUM)
    ):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "GST rate must be between 0 and 100 "
            "with at most four decimal places.",
        )

    return rate


def _actor(db: Session, actor_id: UUID) -> tuple[User, str]:
    user = db.get(User, actor_id)

    if user is None or not user.is_active:
        raise _error(
            status.HTTP_403_FORBIDDEN,
            "An active user account is required.",
        )

    role = user.primary_role

    if role is None or role.role_name not in READ_ROLES:
        raise _error(
            status.HTTP_403_FORBIDDEN,
            "A valid application role is required.",
        )

    return user, role.role_name


def _require_writer(
    db: Session,
    actor_id: UUID,
) -> tuple[User, str]:
    user, role = _actor(db, actor_id)

    if role not in {SALESMAN_ROLE, FACTORY_ADMIN_ROLE}:
        raise _error(
            status.HTTP_403_FORBIDDEN,
            "Sales-order modification permission is required.",
        )

    return user, role


def _require_admin(db: Session, actor_id: UUID) -> User:
    user, role = _actor(db, actor_id)

    if role != FACTORY_ADMIN_ROLE:
        raise _error(
            status.HTTP_403_FORBIDDEN,
            "Factory Admin authorization is required.",
        )

    return user


def _customer(
    db: Session,
    customer_id: UUID,
    *,
    actor_id: UUID,
    role: str,
) -> Customer:
    customer = db.get(Customer, customer_id)

    if customer is None:
        raise _error(
            status.HTTP_404_NOT_FOUND,
            "Customer not found.",
        )

    if not customer.is_active:
        raise _error(
            status.HTTP_409_CONFLICT,
            "Inactive customers cannot receive new sales orders.",
        )

    if (
        role == SALESMAN_ROLE
        and customer.assigned_salesman_id != actor_id
    ):
        raise _error(
            status.HTTP_403_FORBIDDEN,
            "This customer is not assigned to the Salesman.",
        )

    return customer


def _product(
    db: Session,
    product_id: UUID,
) -> tuple[Product, InventoryItem]:
    product = db.get(Product, product_id)

    if product is None:
        raise _error(
            status.HTTP_404_NOT_FOUND,
            "Product not found.",
        )

    item = db.get(InventoryItem, product.product_id)

    if (
        item is None
        or not item.is_active
        or item.item_type != "FINISHED_PRODUCT"
    ):
        raise _error(
            status.HTTP_409_CONFLICT,
            "The selected product is not available for sale.",
        )

    return product, item


def _order_query():
    return select(SalesOrder).options(
        selectinload(SalesOrder.items),
        selectinload(SalesOrder.approval_history),
    )


def _get_order(
    db: Session,
    sales_order_id: UUID,
    *,
    lock: bool = False,
) -> SalesOrder:
    statement = _order_query().where(
        SalesOrder.sales_order_id == sales_order_id
    )

    if lock:
        statement = statement.with_for_update(of=SalesOrder)

    order = db.scalar(statement)

    if order is None:
        raise _error(
            status.HTTP_404_NOT_FOUND,
            "Sales order not found.",
        )

    return order


def _check_order_access(
    db: Session,
    *,
    order: SalesOrder,
    actor_id: UUID,
    write: bool = False,
) -> str:
    _, role = _actor(db, actor_id)

    if role == SALESMAN_ROLE:
        if order.salesman_id != actor_id:
            raise _error(
                status.HTTP_403_FORBIDDEN,
                "Access to this sales order is not permitted.",
            )

        customer = db.get(Customer, order.customer_id)

        if (
            customer is None
            or customer.assigned_salesman_id != actor_id
        ):
            raise _error(
                status.HTTP_403_FORBIDDEN,
                "The order's customer is not assigned to this Salesman.",
            )

    if write and role not in {SALESMAN_ROLE, FACTORY_ADMIN_ROLE}:
        raise _error(
            status.HTTP_403_FORBIDDEN,
            "Sales-order modification permission is required.",
        )

    return role


def _calculate_line(
    *,
    quantity: Decimal,
    unit_price: Decimal,
    tax_rate: Decimal,
) -> tuple[Decimal, Decimal, Decimal]:
    subtotal = _money(quantity * unit_price)
    tax_amount = _money(
        subtotal * tax_rate / Decimal("100")
    )
    return subtotal, tax_amount, subtotal + tax_amount


def _recalculate_totals(order: SalesOrder) -> None:
    order.subtotal = sum(
        (Decimal(line.line_subtotal) for line in order.items),
        Decimal("0.00"),
    )
    order.tax_total = sum(
        (Decimal(line.tax_amount) for line in order.items),
        Decimal("0.00"),
    )
    order.grand_total = order.subtotal + order.tax_total


def _make_lines(
    db: Session,
    *,
    order: SalesOrder,
    items: list[dict[str, object]],
) -> list[SalesOrderItem]:
    if not items:
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "A sales order requires at least one item.",
        )

    seen_products: set[UUID] = set()
    lines: list[SalesOrderItem] = []

    for line_number, item_data in enumerate(items, start=1):
        if not isinstance(item_data, dict):
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Each sales-order item must be an object.",
            )

        product_id = item_data.get("product_id")

        if not isinstance(product_id, UUID):
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Each item requires a valid product_id.",
            )

        if product_id in seen_products:
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Duplicate products are not permitted in one order.",
            )

        seen_products.add(product_id)

        product, _ = _product(db, product_id)

        quantity = _validate_quantity(
            item_data.get("quantity")
        )

        unit_price = _validate_price(
            product.selling_price
        )
        tax_rate = _validate_tax_rate(
            product.gst_rate
        )

        subtotal, tax_amount, total = _calculate_line(
            quantity=quantity,
            unit_price=unit_price,
            tax_rate=tax_rate,
        )

        lines.append(
            SalesOrderItem(
                sales_order_id=order.sales_order_id,
                line_number=line_number,
                product_id=product_id,
                quantity=quantity,
                unit_price=unit_price,
                tax_rate=tax_rate,
                line_subtotal=subtotal,
                tax_amount=tax_amount,
                line_total=total,
            )
        )

    return lines


def create_sales_order(
    db: Session,
    *,
    actor_id: UUID,
    customer_id: UUID,
    order_date: date,
    items: list[dict[str, object]],
    required_date: date | None = None,
    notes: str | None = None,
    order_number: str | None = None,
) -> SalesOrder:
    """
    Create a draft sales order using authoritative product prices.

    The generated order number is unique and independent of the
    offline synchronization idempotency key.
    """

    _, role = _require_writer(db, actor_id)

    _customer(
        db,
        customer_id,
        actor_id=actor_id,
        role=role,
    )

    if (
        required_date is not None
        and required_date < order_date
    ):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Required date cannot precede order date.",
        )

    if order_number is None:
        order_number = f"SO-{uuid4().hex.upper()}"
    else:
        order_number = order_number.strip()

        if not order_number or len(order_number) > 100:
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Invalid sales-order number.",
            )

    existing = db.scalar(
        select(SalesOrder.sales_order_id).where(
            SalesOrder.order_number == order_number
        )
    )

    if existing is not None:
        raise _error(
            status.HTTP_409_CONFLICT,
            "Sales-order number already exists.",
        )

    order = SalesOrder(
        order_number=order_number,
        customer_id=customer_id,
        salesman_id=actor_id,
        order_date=order_date,
        required_date=required_date,
        approval_status="DRAFT",
        fulfillment_status="NOT_DISPATCHED",
        notes=notes,
    )

    db.add(order)
    db.flush()

    order.items.extend(
        _make_lines(db, order=order, items=items)
    )
    _recalculate_totals(order)

    db.flush()

    create_audit_log(
        db,
        user_id=actor_id,
        entity_type="SalesOrder",
        entity_id=order.sales_order_id,
        action="SALES_ORDER_CREATED",
        new_values={
            "order_number": order.order_number,
            "customer_id": order.customer_id,
            "salesman_id": order.salesman_id,
            "approval_status": order.approval_status,
            "subtotal": order.subtotal,
            "tax_total": order.tax_total,
            "grand_total": order.grand_total,
        },
    )

    return order


def get_sales_order(
    db: Session,
    *,
    sales_order_id: UUID,
    actor_id: UUID,
) -> SalesOrder:
    """Return a sales order after enforcing record-level access."""

    order = _get_order(db, sales_order_id)
    _check_order_access(
        db,
        order=order,
        actor_id=actor_id,
    )
    return order


def list_sales_orders(
    db: Session,
    *,
    actor_id: UUID,
    customer_id: UUID | None = None,
    approval_status: str | None = None,
    page: int = 1,
    page_size: int = 50,
) -> tuple[list[SalesOrder], int]:
    """Return authorized sales orders with pagination."""

    _, role = _actor(db, actor_id)

    if (
        isinstance(page, bool)
        or not isinstance(page, int)
        or page < 1
        or isinstance(page_size, bool)
        or not isinstance(page_size, int)
        or not 1 <= page_size <= 500
    ):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Invalid pagination parameters.",
        )

    filters = []

    if role == SALESMAN_ROLE:
        filters.append(
            SalesOrder.salesman_id == actor_id
        )
        filters.append(
            SalesOrder.customer_id.in_(
                select(Customer.customer_id).where(
                    Customer.assigned_salesman_id == actor_id
                )
            )
        )

    if customer_id is not None:
        filters.append(
            SalesOrder.customer_id == customer_id
        )

    if approval_status is not None:
        if approval_status not in {
            "DRAFT",
            "SUBMITTED",
            "APPROVED",
            "REJECTED",
            "CANCELLED",
        }:
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Invalid approval status.",
            )

        filters.append(
            SalesOrder.approval_status == approval_status
        )

    total = db.scalar(
        select(func.count())
        .select_from(SalesOrder)
        .where(*filters)
    ) or 0

    orders = list(
        db.scalars(
            _order_query()
            .where(*filters)
            .order_by(
                SalesOrder.order_date.desc(),
                SalesOrder.sales_order_id.desc(),
            )
            .offset((page - 1) * page_size)
            .limit(page_size)
        ).all()
    )

    return orders, total


def update_sales_order(
    db: Session,
    *,
    sales_order_id: UUID,
    actor_id: UUID,
    required_date: date | None = None,
    notes: str | None = None,
    items: list[dict[str, object]] | None = None,
    update_required_date: bool = False,
    update_notes: bool = False,
) -> SalesOrder:
    """
    Update an unsubmitted draft.

    Item replacement is permitted only before submission.
    Existing draft lines are updated in place where possible,
    avoiding deletion of historical order records.
    """

    _require_writer(db, actor_id)
    order = _get_order(db, sales_order_id, lock=True)

    _check_order_access(
        db,
        order=order,
        actor_id=actor_id,
        write=True,
    )

    if order.approval_status != "DRAFT":
        raise _error(
            status.HTTP_409_CONFLICT,
            "Only draft sales orders may be edited.",
        )

    old_values = {
        "required_date": order.required_date,
        "notes": order.notes,
        "subtotal": order.subtotal,
        "tax_total": order.tax_total,
        "grand_total": order.grand_total,
    }

    if update_required_date:
        if (
            required_date is not None
            and required_date < order.order_date
        ):
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Required date cannot precede order date.",
            )

        order.required_date = required_date

    if update_notes:
        order.notes = notes

    if items is not None:
        new_lines = _make_lines(
            db,
            order=order,
            items=items,
        )

        existing_lines = list(order.items)

        for index, new_line in enumerate(new_lines):
            if index < len(existing_lines):
                existing = existing_lines[index]
                existing.product_id = new_line.product_id
                existing.quantity = new_line.quantity
                existing.unit_price = new_line.unit_price
                existing.tax_rate = new_line.tax_rate
                existing.line_subtotal = new_line.line_subtotal
                existing.tax_amount = new_line.tax_amount
                existing.line_total = new_line.line_total
            else:
                order.items.append(new_line)

        if len(existing_lines) > len(new_lines):
            raise _error(
                status.HTTP_409_CONFLICT,
                "Removing existing order lines requires "
                "a dedicated authorized correction workflow.",
            )

    _recalculate_totals(order)
    db.flush()

    create_audit_log(
        db,
        user_id=actor_id,
        entity_type="SalesOrder",
        entity_id=order.sales_order_id,
        action="SALES_ORDER_UPDATED",
        old_values=old_values,
        new_values={
            "required_date": order.required_date,
            "notes": order.notes,
            "subtotal": order.subtotal,
            "tax_total": order.tax_total,
            "grand_total": order.grand_total,
        },
    )

    return order


def _record_decision(
    db: Session,
    *,
    order: SalesOrder,
    actor_id: UUID,
    new_status: str,
    reason: str | None = None,
) -> None:
    previous_status = order.approval_status

    history = OrderApprovalHistory(
        sales_order_id=order.sales_order_id,
        previous_status=previous_status,
        new_status=new_status,
        decided_by=actor_id,
        reason=reason,
    )

    db.add(history)
    order.approval_status = new_status
    db.flush()

    create_audit_log(
        db,
        user_id=actor_id,
        entity_type="SalesOrder",
        entity_id=order.sales_order_id,
        action=f"SALES_ORDER_{new_status}",
        old_values={
            "approval_status": previous_status,
        },
        new_values={
            "approval_status": new_status,
            "reason": reason,
        },
    )


def submit_sales_order(
    db: Session,
    *,
    sales_order_id: UUID,
    actor_id: UUID,
) -> SalesOrder:
    """Submit a draft order for Factory Admin review."""

    _require_writer(db, actor_id)
    order = _get_order(db, sales_order_id, lock=True)

    role = _check_order_access(
        db,
        order=order,
        actor_id=actor_id,
        write=True,
    )

    if order.approval_status == "SUBMITTED":
        return order

    if order.approval_status != "DRAFT":
        raise _error(
            status.HTTP_409_CONFLICT,
            "Only draft sales orders may be submitted.",
        )

    _customer(
        db,
        order.customer_id,
        actor_id=actor_id,
        role=role,
    )

    if not order.items:
        raise _error(
            status.HTTP_409_CONFLICT,
            "An order must contain at least one item.",
        )

    for line in order.items:
        _product(db, line.product_id)
        _validate_quantity(line.quantity)

    _record_decision(
        db,
        order=order,
        actor_id=actor_id,
        new_status="SUBMITTED",
    )

    return order


def approve_sales_order(
    db: Session,
    *,
    sales_order_id: UUID,
    actor_id: UUID,
    reason: str | None = None,
) -> SalesOrder:
    """
    Approve a submitted sales order.

    Stock shortages do not prevent approval. Availability must
    be rechecked when an actual dispatch is posted.
    """

    _require_admin(db, actor_id)
    order = _get_order(db, sales_order_id, lock=True)

    if order.approval_status == "APPROVED":
        return order

    if order.approval_status != "SUBMITTED":
        raise _error(
            status.HTTP_409_CONFLICT,
            "Only submitted sales orders may be approved.",
        )

    if order.salesman_id == actor_id:
        raise _error(
            status.HTTP_403_FORBIDDEN,
            "An order cannot be self-approved.",
        )

    _customer(
        db,
        order.customer_id,
        actor_id=actor_id,
        role=FACTORY_ADMIN_ROLE,
    )

    for line in order.items:
        _product(db, line.product_id)

    _record_decision(
        db,
        order=order,
        actor_id=actor_id,
        new_status="APPROVED",
        reason=reason,
    )

    return order


def reject_sales_order(
    db: Session,
    *,
    sales_order_id: UUID,
    actor_id: UUID,
    reason: str,
) -> SalesOrder:
    """Reject a submitted order with a mandatory explanation."""

    _require_admin(db, actor_id)

    if not isinstance(reason, str) or not reason.strip():
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "A rejection reason is required.",
        )

    order = _get_order(db, sales_order_id, lock=True)

    if order.approval_status != "SUBMITTED":
        raise _error(
            status.HTTP_409_CONFLICT,
            "Only submitted sales orders may be rejected.",
        )

    _record_decision(
        db,
        order=order,
        actor_id=actor_id,
        new_status="REJECTED",
        reason=reason.strip(),
    )

    return order


def cancel_sales_order(
    db: Session,
    *,
    sales_order_id: UUID,
    actor_id: UUID,
    reason: str,
) -> SalesOrder:
    """
    Cancel an eligible order without deleting its history.

    Salesmen may cancel only their own unsubmitted drafts.
    Factory Admin users may cancel drafts or submitted orders.
    Approved orders require a separate correction workflow.
    """

    _, role = _require_writer(db, actor_id)
    order = _get_order(db, sales_order_id, lock=True)

    _check_order_access(
        db,
        order=order,
        actor_id=actor_id,
        write=True,
    )

    if order.approval_status == "CANCELLED":
        return order

    allowed_statuses = (
        {"DRAFT"}
        if role == SALESMAN_ROLE
        else {"DRAFT", "SUBMITTED", "REJECTED"}
    )

    if order.approval_status not in allowed_statuses:
        raise _error(
            status.HTTP_409_CONFLICT,
            "This order cannot be cancelled in its current state.",
        )

    if order.fulfillment_status != "NOT_DISPATCHED":
        raise _error(
            status.HTTP_409_CONFLICT,
            "Dispatched orders require an authorized reversal process.",
        )

    if not isinstance(reason, str) or not reason.strip():
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "A cancellation reason is required.",
        )

    _record_decision(
        db,
        order=order,
        actor_id=actor_id,
        new_status="CANCELLED",
        reason=reason.strip(),
    )

    return order