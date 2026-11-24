"""GST invoice lifecycle endpoints."""

from datetime import timedelta
from uuid import UUID

from fastapi import APIRouter, Query

from app.api.dependencies import CurrentUser, DBSession, FactoryAdminUser, TransactionalDBSession
from app.core.config import settings
from app.schemas.invoicing import InvoiceCreate, InvoiceResponse
from app.services import invoicing_service

router = APIRouter(prefix="/invoices", tags=["Invoicing"])


def _response(invoice):
    return InvoiceResponse.model_validate(invoice).model_dump(mode="json")


@router.get("")
def list_invoices(
    user: CurrentUser,
    db: DBSession,
    customer_id: UUID | None = None,
    order_id: UUID | None = None,
    status: str | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
):
    items, total = invoicing_service.list_invoices(
        db, actor_id=user.user_id, customer_id=customer_id,
        order_id=order_id, invoice_status=status.upper() if status else None,
        page=page, page_size=page_size,
    )
    return {"items": [_response(item) for item in items], "total": total, "page": page, "page_size": page_size}


@router.post("", status_code=201)
def create_invoice(payload: InvoiceCreate, admin: FactoryAdminUser, db: TransactionalDBSession):
    invoice = invoicing_service.create_invoice(
        db, actor_id=admin.user_id, order_id=payload.order_id,
        invoice_date=payload.invoice_date,
        due_date=payload.invoice_date + timedelta(days=30),
        seller_state=settings.COMPANY_STATE,
        place_of_supply_state=payload.place_of_supply_state,
        items=[item.model_dump() for item in payload.items],
    )
    return _response(invoice)


@router.get("/{invoice_id}")
def get_invoice(invoice_id: UUID, user: CurrentUser, db: DBSession):
    return _response(invoicing_service.get_invoice(db, invoice_id=invoice_id, actor_id=user.user_id))


@router.post("/{invoice_id}/post")
def post_invoice(invoice_id: UUID, admin: FactoryAdminUser, db: TransactionalDBSession):
    return _response(invoicing_service.post_invoice(db, invoice_id=invoice_id, actor_id=admin.user_id, seller_state=settings.COMPANY_STATE))


@router.post("/{invoice_id}/cancel")
def cancel_invoice(invoice_id: UUID, payload: dict[str, str], admin: FactoryAdminUser, db: TransactionalDBSession):
    return _response(invoicing_service.cancel_draft_invoice(db, invoice_id=invoice_id, actor_id=admin.user_id, reason=payload.get("reason", "")))
