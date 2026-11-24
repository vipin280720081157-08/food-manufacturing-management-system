"""Idempotent synchronization of Salesman offline orders."""

from __future__ import annotations

from datetime import date
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Header, HTTPException, status

from app.api.dependencies import DBSession, SalesmanUser, TransactionalDBSession
from app.services.synchronization_service import (
    get_synchronization_record,
    list_synchronization_records,
    synchronize_sales_order,
)

router = APIRouter(tags=["Offline synchronization"])


@router.post("/sales-orders/sync", status_code=status.HTTP_200_OK)
def sync_order(
    payload: dict[str, Any],
    actor: SalesmanUser,
    db: TransactionalDBSession,
    idempotency_key_header: str | None = Header(None, alias="Idempotency-Key"),
) -> dict[str, Any]:
    try:
        local_id = UUID(str(payload["local_order_id"]))
        key = str(payload["idempotency_key"])
        claimed_user = UUID(str(payload["salesman_id"]))
        order = payload["order"]
        if not isinstance(order, dict):
            raise ValueError
        if claimed_user != actor.user_id:
            raise HTTPException(status_code=403, detail="The order belongs to another Salesman.")
        if idempotency_key_header and idempotency_key_header != key:
            raise HTTPException(status_code=409, detail="Idempotency key does not match the order.")
        lines = order.get("items")
        if not isinstance(lines, list) or not lines:
            raise HTTPException(status_code=422, detail="At least one order line is required.")
        result = synchronize_sales_order(
            db,
            actor_id=actor.user_id,
            local_order_id=local_id,
            idempotency_key=key,
            customer_id=UUID(str(order["customer_id"])),
            order_date=date.fromisoformat(str(order["order_date"])[:10]),
            required_date=date.fromisoformat(str(order["required_date"])) if order.get("required_date") else None,
            notes=order.get("notes"),
            items=[{"product_id": UUID(str(line["product_id"])), "quantity": line["quantity"]} for line in lines],
        )
    except HTTPException:
        raise
    except (KeyError, TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail="Offline order payload is invalid.") from exc

    order_id = result.get("order_id")
    server_number = result.get("order_number")
    return {
        **result,
        "sync_status": "SYNCED" if result.get("sync_status") == "SYNCED" else result.get("sync_status"),
        "server_order_id": str(order_id) if order_id else None,
        "server_order_number": server_number,
        "accepted_at": result.get("synced_at"),
        "already_processed": bool(result.get("duplicate")),
    }


@router.get("/sales-orders/sync")
def list_sync_records(actor: SalesmanUser, db: DBSession, page: int = 1, page_size: int = 50):
    records, total = list_synchronization_records(db, actor_id=actor.user_id, page=page, page_size=page_size)
    return {"items": records, "total": total, "page": page, "page_size": page_size}


@router.get("/sales-orders/sync/{local_order_id}")
def get_sync_record(local_order_id: UUID, actor: SalesmanUser, db: DBSession):
    return get_synchronization_record(db, actor_id=actor.user_id, local_order_id=local_order_id)
