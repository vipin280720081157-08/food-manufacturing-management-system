"""Sales-order endpoints, including role-scoped review and approval."""

from __future__ import annotations

from typing import Any
from uuid import UUID

from fastapi import APIRouter, Query, status

from app.api.dependencies import CurrentUser, DBSession, FactoryAdminUser, TransactionalDBSession
from app.models.sales import SalesOrder
from app.schemas.sales import SalesOrderCreate, SalesOrderUpdate
from app.services import sales_service

router = APIRouter(prefix="/sales-orders", tags=["Sales"])
legacy_router = APIRouter(prefix="/sales/orders", tags=["Sales compatibility"])


def order_payload(order: SalesOrder) -> dict[str, Any]:
    rejection = next(
        (entry.reason for entry in reversed(order.approval_history) if entry.new_status == "REJECTED"),
        None,
    )
    return {
        "id": str(order.sales_order_id),
        "sales_order_id": str(order.sales_order_id),
        "order_number": order.order_number,
        "customer_id": str(order.customer_id),
        "customer_name": order.customer.customer_name if order.customer else "",
        "salesman_id": str(order.salesman_id),
        "salesman_name": order.salesman.full_name if order.salesman else "",
        "order_date": order.order_date.isoformat(),
        "required_date": order.required_date.isoformat() if order.required_date else None,
        "approval_status": order.approval_status.lower(),
        "fulfillment_status": order.fulfillment_status.lower(),
        "subtotal": str(order.subtotal),
        "tax_total": str(order.tax_total),
        "grand_total": str(order.grand_total),
        "notes": order.notes,
        "rejection_reason": rejection,
        "created_at": order.created_at.isoformat(),
        "updated_at": order.updated_at.isoformat() if order.updated_at else None,
        "items": [
            {
                "id": str(line.sales_order_item_id),
                "sales_order_item_id": str(line.sales_order_item_id),
                "sales_order_id": str(line.sales_order_id),
                "product_id": str(line.product_id),
                "quantity": str(line.quantity),
                "unit": line.product.inventory_item.base_unit if line.product else "pcs",
                "unit_price": str(line.unit_price),
                "tax_rate": str(line.tax_rate),
                "line_subtotal": str(line.line_subtotal),
                "tax_amount": str(line.tax_amount),
                "line_total": str(line.line_total),
            }
            for line in order.items
        ],
    }


def _items(payload: SalesOrderCreate | SalesOrderUpdate) -> list[dict[str, object]] | None:
    items = getattr(payload, "items", None)
    if items is None:
        return None
    return [{"product_id": line.product_id, "quantity": line.quantity} for line in items]


@router.get("")
def list_orders(
    user: CurrentUser,
    db: DBSession,
    customer_id: UUID | None = None,
    approval_status: str | None = None,
    fulfillment_status: str | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
) -> dict[str, Any]:
    del fulfillment_status  # service returns all fulfillment states; filter below.
    orders, total = sales_service.list_sales_orders(
        db,
        actor_id=user.user_id,
        customer_id=customer_id,
        approval_status=approval_status.upper() if approval_status else None,
        page=page,
        page_size=page_size,
    )
    return {"items": [order_payload(o) for o in orders], "total": total, "page": page, "page_size": page_size}


@router.post("", status_code=status.HTTP_201_CREATED)
def create_order(payload: SalesOrderCreate, user: CurrentUser, db: TransactionalDBSession):
    order = sales_service.create_sales_order(
        db,
        actor_id=user.user_id,
        customer_id=payload.customer_id,
        order_date=payload.order_date,
        items=_items(payload) or [],
        required_date=payload.required_date,
        notes=payload.notes,
    )
    if user.primary_role and user.primary_role.role_name == "Salesman":
        order = sales_service.submit_sales_order(db, sales_order_id=order.sales_order_id, actor_id=user.user_id)
    return order_payload(order)


@legacy_router.post("", status_code=status.HTTP_201_CREATED)
def create_order_legacy(payload: SalesOrderCreate, user: CurrentUser, db: TransactionalDBSession):
    return create_order(payload, user, db)


@legacy_router.get("")
def list_orders_legacy(
    user: CurrentUser,
    db: DBSession,
    customer_id: UUID | None = None,
    approval_status: str | None = None,
    fulfillment_status: str | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
):
    orders, total = sales_service.list_sales_orders(
        db,
        actor_id=user.user_id,
        customer_id=customer_id,
        approval_status=approval_status.upper() if approval_status else None,
        page=page,
        page_size=page_size,
    )
    if fulfillment_status:
        filtered = [order for order in orders if order.fulfillment_status.casefold() == fulfillment_status.casefold()]
        orders = filtered
        total = len(filtered)
    return {"items": [order_payload(order) for order in orders], "total": total, "page": page, "page_size": page_size}


@router.get("/{order_id}")
def get_order(order_id: UUID, user: CurrentUser, db: DBSession):
    order = sales_service.get_sales_order(db, sales_order_id=order_id, actor_id=user.user_id)
    return order_payload(order)


@router.patch("/{order_id}")
def update_order(order_id: UUID, payload: SalesOrderUpdate, user: CurrentUser, db: TransactionalDBSession):
    values = payload.model_dump(exclude_unset=True)
    order = sales_service.update_sales_order(
        db,
        sales_order_id=order_id,
        actor_id=user.user_id,
        required_date=values.get("required_date"),
        notes=values.get("notes"),
        items=_items(payload),
        update_required_date="required_date" in values,
        update_notes="notes" in values,
    )
    return order_payload(order)


@router.post("/{order_id}/submit")
def submit_order(order_id: UUID, user: CurrentUser, db: TransactionalDBSession):
    return order_payload(sales_service.submit_sales_order(db, sales_order_id=order_id, actor_id=user.user_id))


@router.post("/{order_id}/approve")
def approve_order(order_id: UUID, admin: FactoryAdminUser, db: TransactionalDBSession):
    return order_payload(sales_service.approve_sales_order(db, sales_order_id=order_id, actor_id=admin.user_id))


@router.post("/{order_id}/reject")
def reject_order(order_id: UUID, payload: dict[str, str], admin: FactoryAdminUser, db: TransactionalDBSession):
    return order_payload(sales_service.reject_sales_order(db, sales_order_id=order_id, actor_id=admin.user_id, reason=payload.get("reason", "")))


@router.post("/{order_id}/cancel")
def cancel_order(order_id: UUID, user: CurrentUser, db: TransactionalDBSession, payload: dict[str, str] | None = None):
    return order_payload(sales_service.cancel_sales_order(db, sales_order_id=order_id, actor_id=user.user_id, reason=(payload or {}).get("reason", "Cancelled by user")))


@router.get("/{order_id}/availability")
def order_availability(order_id: UUID, user: CurrentUser, db: DBSession):
    from app.models.product import InventoryItem
    from app.services.inventory_service import get_stock_quantity
    order = sales_service.get_sales_order(db, sales_order_id=order_id, actor_id=user.user_id)
    lines = []
    for line in order.items:
        item_id = line.product_id
        product_item = db.get(InventoryItem, item_id)
        available = get_stock_quantity(db, item_id=item_id) if product_item else 0
        requested = line.quantity
        shortage = max(requested - available, 0)
        lines.append({
            "product_id": str(line.product_id),
            "requested_quantity": str(requested),
            "available_quantity": str(available),
            "shortage_quantity": str(shortage),
        })
    return {"order_id": str(order.sales_order_id), "approval_status": order.approval_status.lower(), "items": lines}
