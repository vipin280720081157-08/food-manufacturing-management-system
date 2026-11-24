"""Role-scoped dashboard summary endpoints."""

from datetime import datetime, timezone
from decimal import Decimal

from fastapi import APIRouter
from sqlalchemy import func, select

from fastapi import HTTPException

from app.api.dependencies import AnyRoleUser, DBSession, FactoryAdminUser
from app.models.customer import Customer
from app.models.inventory import InventoryBalance
from app.models.invoicing import Invoice
from app.models.product import InventoryItem
from app.models.production import ProductionCostSummary, ProductionRun
from app.models.sales import SalesOrder
from app.models.supplier import Supplier
from app.services.payment_service import get_invoice_payment_balance

router = APIRouter(prefix="/dashboard", tags=["Dashboards"])


def _count(db, model, *conditions) -> int:
    return int(db.scalar(select(func.count()).select_from(model).where(*conditions)) or 0)


def _require_role(user, *allowed: str) -> None:
    role = user.primary_role.role_name if user.primary_role else None
    if role not in allowed:
        raise HTTPException(status_code=403, detail="Your role does not permit this operation.")


def _pending_costing_count(db) -> int:
    statement = (
        select(func.count())
        .select_from(ProductionRun)
        .outerjoin(ProductionCostSummary, ProductionCostSummary.production_run_id == ProductionRun.production_run_id)
        .where(ProductionRun.status == "COMPLETED", ProductionCostSummary.cost_summary_id.is_(None))
    )
    return int(db.scalar(statement) or 0)


def _low_stock_count(db) -> int:
    statement = (
        select(func.count(func.distinct(InventoryBalance.item_id)))
        .join(InventoryItem, InventoryItem.item_id == InventoryBalance.item_id)
        .where(
            InventoryBalance.location == "WAREHOUSE",
            InventoryBalance.quantity_on_hand <= InventoryItem.reorder_level,
            InventoryItem.is_active.is_(True),
        )
    )
    return int(db.scalar(statement) or 0)


def _financial_totals(db, actor_id):
    invoices = db.scalars(select(Invoice).where(Invoice.invoice_type == "TAX_INVOICE", Invoice.status.in_(("POSTED", "CREDITED")))).all()
    values = [get_invoice_payment_balance(db, invoice_id=row.invoice_id, actor_id=actor_id) for row in invoices]
    total = sum((Decimal(str(row.total_amount)) for row in invoices), Decimal("0.00"))
    paid = sum((Decimal(value["paid_amount"]) for value in values), Decimal("0.00"))
    outstanding = sum((Decimal(value["outstanding_amount"]) for value in values), Decimal("0.00"))
    overdue = sum((Decimal(value["outstanding_amount"]) for value in values if value.get("is_overdue")), Decimal("0.00"))
    return {
        "total_invoiced_amount": str(total.quantize(Decimal("0.01"))),
        "total_collected_amount": str(paid.quantize(Decimal("0.01"))),
        "outstanding_amount": str(outstanding.quantize(Decimal("0.01"))),
        "overdue_amount": str(overdue.quantize(Decimal("0.01"))),
        "posted_invoice_count": len(invoices),
        "unpaid_invoice_count": sum(1 for value in values if Decimal(value["paid_amount"]) == 0 and Decimal(value["outstanding_amount"]) > 0),
        "partially_paid_invoice_count": sum(1 for value in values if Decimal(value["paid_amount"]) > 0 and Decimal(value["outstanding_amount"]) > 0),
    }


@router.get("/admin")
def admin_dashboard(admin: FactoryAdminUser, db: DBSession):
    """Return authoritative headline metrics for the admin overview."""
    count = lambda statement: int(db.scalar(statement) or 0)
    total_customers = count(select(func.count()).select_from(Customer).where(Customer.is_active.is_(True)))
    total_suppliers = count(select(func.count()).select_from(Supplier).where(Supplier.is_active.is_(True)))
    pending = count(select(func.count()).select_from(SalesOrder).where(SalesOrder.approval_status == "SUBMITTED"))
    approved = count(select(func.count()).select_from(SalesOrder).where(SalesOrder.approval_status == "APPROVED"))
    pending_dispatches = count(select(func.count()).select_from(SalesOrder).where(SalesOrder.approval_status == "APPROVED", SalesOrder.fulfillment_status != "DISPATCHED"))
    low_stock = _low_stock_count(db)
    active_runs = count(select(func.count()).select_from(ProductionRun).where(ProductionRun.status == "IN_PROGRESS"))
    invoices = db.scalars(select(Invoice).where(Invoice.invoice_type == "TAX_INVOICE", Invoice.status.in_(("POSTED", "CREDITED")))).all()
    outstanding = sum((Decimal(get_invoice_payment_balance(db, invoice_id=row.invoice_id, actor_id=admin.user_id)["outstanding_amount"]) for row in invoices), Decimal("0.00"))
    return {
        "metrics": {
            "total_customers": total_customers,
            "total_suppliers": total_suppliers,
            "pending_order_approvals": pending,
            "approved_orders": approved,
            "pending_dispatches": pending_dispatches,
            "low_stock_items": low_stock,
            "active_production_runs": active_runs,
            "outstanding_amount": str(outstanding.quantize(Decimal("0.01"))),
        },
        "recent_orders": [],
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }


@router.get("/salesman")
def salesman_dashboard(user: AnyRoleUser, db: DBSession):
    _require_role(user, "Salesman")
    own = SalesOrder.salesman_id == user.user_id
    return {"metrics": {
        "total_customers": _count(db, Customer, Customer.is_active.is_(True)),
        "total_orders": _count(db, SalesOrder, own),
        "pending_orders": _count(db, SalesOrder, own, SalesOrder.approval_status == "SUBMITTED"),
        "approved_orders": _count(db, SalesOrder, own, SalesOrder.approval_status == "APPROVED"),
        "rejected_orders": _count(db, SalesOrder, own, SalesOrder.approval_status == "REJECTED"),
    }, "generated_at": datetime.now(timezone.utc).isoformat()}


@router.get("/production")
def production_dashboard(user: AnyRoleUser, db: DBSession):
    _require_role(user, "Factory Admin", "Production Supervisor")
    status_count = lambda state: _count(db, ProductionRun, ProductionRun.status == state)
    low_stock = _low_stock_count(db)
    return {"metrics": {
        "total_production_runs": _count(db, ProductionRun),
        "draft_production_runs": status_count("DRAFT"),
        "active_production_runs": status_count("IN_PROGRESS"),
        "completed_production_runs": status_count("COMPLETED"),
        "pending_costing_runs": _pending_costing_count(db),
        "low_stock_materials": low_stock,
    }, "generated_at": datetime.now(timezone.utc).isoformat()}


@router.get("/accountant")
def accountant_dashboard(user: AnyRoleUser, db: DBSession):
    _require_role(user, "Accountant/Auditor")
    metrics = _financial_totals(db, user.user_id)
    metrics["pending_costing_runs"] = _pending_costing_count(db)
    return {"metrics": metrics, "generated_at": datetime.now(timezone.utc).isoformat()}


@router.get("/owner")
def owner_dashboard(user: AnyRoleUser, db: DBSession):
    _require_role(user, "Owner")
    metrics = {
        "total_customers": _count(db, Customer, Customer.is_active.is_(True)),
        "total_suppliers": _count(db, Supplier, Supplier.is_active.is_(True)),
        "total_sales_orders": _count(db, SalesOrder),
        "pending_order_approvals": _count(db, SalesOrder, SalesOrder.approval_status == "SUBMITTED"),
        "approved_orders": _count(db, SalesOrder, SalesOrder.approval_status == "APPROVED"),
        "active_production_runs": _count(db, ProductionRun, ProductionRun.status == "IN_PROGRESS"),
        "completed_production_runs": _count(db, ProductionRun, ProductionRun.status == "COMPLETED"),
        "pending_dispatches": _count(db, SalesOrder, SalesOrder.approval_status == "APPROVED", SalesOrder.fulfillment_status != "DISPATCHED"),
        "low_stock_items": _low_stock_count(db),
        "pending_costing_runs": _pending_costing_count(db),
        **_financial_totals(db, user.user_id),
    }
    return {"metrics": metrics, "generated_at": datetime.now(timezone.utc).isoformat()}
