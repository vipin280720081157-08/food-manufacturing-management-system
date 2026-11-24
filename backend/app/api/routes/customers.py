"""Customer master API used by sales and receivables workflows."""

import json
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import func, select

from app.api.dependencies import DBSession, FactoryAdminUser, TransactionalDBSession, CurrentUser
from app.models.customer import Customer
from app.schemas.masters import CustomerCreate, CustomerUpdate
from app.services.audit_service import create_audit_log

router = APIRouter(prefix="/customers", tags=["Customers"])


def _address(value: str | None, state: str | None) -> dict:
    if value:
        try:
            loaded = json.loads(value)
            if isinstance(loaded, dict):
                return {"line1": "", "city": "", "state": state or "", "postal_code": "", "country": "India", **loaded}
        except (ValueError, TypeError):
            pass
    return {"line1": value or "", "line2": None, "city": "", "state": state or "", "postal_code": "", "country": "India"}


def _payload(row: Customer) -> dict:
    return {"id": str(row.customer_id), "customer_id": str(row.customer_id), "customer_code": row.customer_id.hex[:12].upper(), "name": row.customer_name, "customer_name": row.customer_name, "customer_type": row.customer_type, "phone": row.phone, "email": row.email, "gstin": row.gstin, "billing_address": _address(row.billing_address, row.state), "shipping_address": _address(row.shipping_address, row.state), "state": row.state, "payment_terms_days": row.payment_terms_days, "assigned_salesman_id": str(row.assigned_salesman_id), "is_active": row.is_active, "created_at": row.created_at.isoformat(), "updated_at": None}


def _text_address(value: object) -> str | None:
    if value is None:
        return None
    if isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


@router.get("")
def list_customers(user: CurrentUser, db: DBSession, assigned_salesman_id: UUID | None = None, is_active: bool | None = None, search: str | None = None, page: int = Query(1, ge=1), page_size: int = Query(50, ge=1, le=500)):
    query = select(Customer)
    if user.primary_role.role_name == "Salesman":
        query = query.where(Customer.assigned_salesman_id == user.user_id)
    elif assigned_salesman_id:
        query = query.where(Customer.assigned_salesman_id == assigned_salesman_id)
    if is_active is not None:
        query = query.where(Customer.is_active == is_active)
    if search:
        query = query.where(Customer.customer_name.ilike(f"%{search.strip()}%"))
    total = db.scalar(select(func.count()).select_from(query.subquery())) or 0
    rows = db.scalars(query.order_by(Customer.customer_name).offset((page - 1) * page_size).limit(page_size)).all()
    return {"items": [_payload(row) for row in rows], "total": total, "page": page, "page_size": page_size}


@router.post("", status_code=201)
def create_customer(payload: dict, admin: FactoryAdminUser, db: TransactionalDBSession):
    body = dict(payload)
    body.pop("customer_code", None)
    body.setdefault("customer_name", body.pop("name", None))
    if isinstance(body.get("billing_address"), dict):
        body.setdefault("state", body["billing_address"].get("state"))
    body.setdefault("billing_address", _text_address(body.get("billing_address")))
    body.setdefault("shipping_address", _text_address(body.get("shipping_address")))
    data = CustomerCreate.model_validate(body)
    row = Customer(**data.model_dump())
    db.add(row)
    db.flush()
    create_audit_log(db, user_id=admin.user_id, entity_type="Customer", entity_id=row.customer_id, action="CUSTOMER_CREATED", new_values={"customer_name": row.customer_name})
    return _payload(row)


@router.get("/{customer_id}")
def get_customer(customer_id: UUID, user: CurrentUser, db: DBSession):
    row = db.get(Customer, customer_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Customer not found.")
    if user.primary_role.role_name == "Salesman" and row.assigned_salesman_id != user.user_id:
        raise HTTPException(status_code=403, detail="Customer is not assigned to this Salesman.")
    return _payload(row)


@router.patch("/{customer_id}")
def update_customer(customer_id: UUID, payload: dict, admin: FactoryAdminUser, db: TransactionalDBSession):
    row = db.get(Customer, customer_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Customer not found.")
    body = dict(payload)
    body.pop("customer_code", None)
    if "name" in body and "customer_name" not in body:
        body["customer_name"] = body.pop("name")
    if isinstance(body.get("billing_address"), dict):
        body.setdefault("state", body["billing_address"].get("state"))
    for key in ("billing_address", "shipping_address"):
        if key in body:
            body[key] = _text_address(body[key])
    data = CustomerUpdate.model_validate(body)
    changes = data.model_dump(exclude_unset=True)
    old = {key: getattr(row, key) for key in changes}
    for key, value in changes.items():
        setattr(row, key, value)
    create_audit_log(db, user_id=admin.user_id, entity_type="Customer", entity_id=row.customer_id, action="CUSTOMER_UPDATED", old_values={key: str(value) for key, value in old.items()}, new_values={key: str(value) for key, value in changes.items()})
    return _payload(row)
