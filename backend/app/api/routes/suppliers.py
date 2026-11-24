"""Supplier master endpoints for purchasing workflows."""

import json
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import func, select

from app.api.dependencies import CurrentUser, DBSession, FactoryAdminUser, TransactionalDBSession
from app.models.supplier import Supplier
from app.schemas.masters import SupplierCreate, SupplierUpdate
from app.services.audit_service import create_audit_log

router = APIRouter(prefix="/suppliers", tags=["Suppliers"])


def _payload(row: Supplier) -> dict:
    try:
        address = json.loads(row.address) if row.address else {}
    except (ValueError, TypeError):
        address = {"line1": row.address or "", "city": "", "state": "", "postal_code": "", "country": "India"}
    return {"id": str(row.supplier_id), "supplier_id": str(row.supplier_id), "supplier_code": row.supplier_id.hex[:12].upper(), "name": row.supplier_name, "supplier_name": row.supplier_name, "phone": row.phone, "email": row.email, "gstin": row.gstin, "address": address, "is_active": row.is_active, "created_at": None, "updated_at": None}


@router.get("")
def list_suppliers(_user: CurrentUser, db: DBSession, is_active: bool | None = None, search: str | None = None, page: int = Query(1, ge=1), page_size: int = Query(50, ge=1, le=500)):
    query = select(Supplier)
    if is_active is not None:
        query = query.where(Supplier.is_active == is_active)
    if search:
        query = query.where(Supplier.supplier_name.ilike(f"%{search.strip()}%"))
    total = db.scalar(select(func.count()).select_from(query.subquery())) or 0
    rows = db.scalars(query.order_by(Supplier.supplier_name).offset((page - 1) * page_size).limit(page_size)).all()
    return {"items": [_payload(row) for row in rows], "total": total, "page": page, "page_size": page_size}


@router.post("", status_code=201)
def create_supplier(payload: dict, admin: FactoryAdminUser, db: TransactionalDBSession):
    body = dict(payload)
    body.pop("supplier_code", None)
    body.setdefault("supplier_name", body.pop("name", None))
    if isinstance(body.get("address"), dict):
        body["address"] = json.dumps(body["address"], ensure_ascii=False)
    data = SupplierCreate.model_validate(body)
    row = Supplier(**data.model_dump())
    db.add(row)
    db.flush()
    create_audit_log(db, user_id=admin.user_id, entity_type="Supplier", entity_id=row.supplier_id, action="SUPPLIER_CREATED", new_values={"supplier_name": row.supplier_name})
    return _payload(row)


@router.get("/{supplier_id}")
def get_supplier(supplier_id: UUID, _user: CurrentUser, db: DBSession):
    row = db.get(Supplier, supplier_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Supplier not found.")
    return _payload(row)


@router.patch("/{supplier_id}")
def update_supplier(supplier_id: UUID, payload: dict, admin: FactoryAdminUser, db: TransactionalDBSession):
    row = db.get(Supplier, supplier_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Supplier not found.")
    body = dict(payload)
    body.pop("supplier_code", None)
    if "name" in body and "supplier_name" not in body:
        body["supplier_name"] = body.pop("name")
    if isinstance(body.get("address"), dict):
        body["address"] = json.dumps(body["address"], ensure_ascii=False)
    data = SupplierUpdate.model_validate(body)
    changes = data.model_dump(exclude_unset=True)
    for key, value in changes.items():
        setattr(row, key, value)
    create_audit_log(db, user_id=admin.user_id, entity_type="Supplier", entity_id=row.supplier_id, action="SUPPLIER_UPDATED", new_values={key: str(value) for key, value in changes.items()})
    return _payload(row)
