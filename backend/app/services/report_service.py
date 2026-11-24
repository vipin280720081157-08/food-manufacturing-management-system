"""
Read-only operational, inventory, production, GST, and financial reports.

All report values are calculated from persisted SQLAlchemy records.
No benchmark figures are hardcoded.

Supported reports:
- Sales register
- Purchase register
- Stock summary
- Stock movement ledger
- Production report
- GST outward supplies summary
- Payments and collections
- Outstanding receivables with ageing
- Audit trail

Financial reports use posted transactions. Stock reports use the
inventory movement ledger. Production reports use recorded production
materials, outputs, and costing summaries.

The service never modifies business records or commits transactions.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.models.audit import AuditLog
from app.models.customer import Customer
from app.models.inventory import (
    InventoryBalance,
    StockMovement,
)
from app.models.invoicing import Invoice
from app.models.payment import Payment, PaymentAllocation
from app.models.product import InventoryItem, Product
from app.models.production import ProductionRun
from app.models.purchasing import (
    GoodsReceipt,
    PurchaseOrder,
    PurchaseOrderItem,
)
from app.models.sales import SalesOrder
from app.models.supplier import Supplier
from app.models.user import User


ZERO = Decimal("0")
MONEY_ZERO = Decimal("0.00")

REPORT_ROLES = frozenset(
    {
        "Factory Admin",
        "Accountant/Auditor",
        "Owner",
    }
)

DEFAULT_AGEING_BUCKETS = (30, 60, 90)


def _error(code: int, detail: str) -> HTTPException:
    return HTTPException(status_code=code, detail=detail)


def _authorize(db: Session, actor_id: UUID) -> User:
    user = db.get(User, actor_id)

    if user is None or not user.is_active:
        raise _error(
            status.HTTP_403_FORBIDDEN,
            "An active user account is required.",
        )

    role = user.primary_role

    if role is None or role.role_name not in REPORT_ROLES:
        raise _error(
            status.HTTP_403_FORBIDDEN,
            "Report access is not permitted for this role.",
        )

    return user


def _validate_dates(
    start_date: date | None,
    end_date: date | None,
) -> None:
    for value in (start_date, end_date):
        if value is not None and (
            not isinstance(value, date)
            or isinstance(value, datetime)
        ):
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Report dates must be valid calendar dates.",
            )

    if (
        start_date is not None
        and end_date is not None
        and start_date > end_date
    ):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Start date cannot be later than end date.",
        )


def _date_filters(
    column,
    start_date: date | None,
    end_date: date | None,
) -> list:
    _validate_dates(start_date, end_date)

    filters = []

    if start_date is not None:
        filters.append(column >= start_date)

    if end_date is not None:
        filters.append(column <= end_date)

    return filters


def _datetime_filters(
    column,
    start_date: date | None,
    end_date: date | None,
) -> list:
    _validate_dates(start_date, end_date)

    filters = []

    if start_date is not None:
        filters.append(
            column >= datetime.combine(
                start_date,
                time.min,
                tzinfo=timezone.utc,
            )
        )

    if end_date is not None:
        filters.append(
            column < datetime.combine(
                end_date + timedelta(days=1),
                time.min,
                tzinfo=timezone.utc,
            )
        )

    return filters


def _decimal(value: object) -> Decimal:
    return Decimal(value) if value is not None else ZERO


def _item_names(
    db: Session,
    item_ids: set[UUID],
) -> dict[UUID, InventoryItem]:
    if not item_ids:
        return {}

    items = db.scalars(
        select(InventoryItem).where(
            InventoryItem.item_id.in_(item_ids)
        )
    ).all()

    return {item.item_id: item for item in items}


def _invoice_payments(
    db: Session,
    invoice_ids: set[UUID],
) -> dict[UUID, Decimal]:
    if not invoice_ids:
        return {}

    rows = db.execute(
        select(
            PaymentAllocation.invoice_id,
            func.sum(PaymentAllocation.allocated_amount),
        )
        .join(
            Payment,
            Payment.payment_id == PaymentAllocation.payment_id,
        )
        .where(
            PaymentAllocation.invoice_id.in_(invoice_ids),
            Payment.status == "POSTED",
        )
        .group_by(PaymentAllocation.invoice_id)
    ).all()

    return {
        invoice_id: _decimal(amount)
        for invoice_id, amount in rows
    }


def _invoice_credits(
    db: Session,
    invoice_ids: set[UUID],
) -> dict[UUID, Decimal]:
    if not invoice_ids:
        return {}

    rows = db.execute(
        select(
            Invoice.original_invoice_id,
            func.sum(Invoice.total_amount),
        )
        .where(
            Invoice.original_invoice_id.in_(invoice_ids),
            Invoice.invoice_type == "CREDIT_NOTE",
            Invoice.status == "POSTED",
        )
        .group_by(Invoice.original_invoice_id)
    ).all()

    return {
        invoice_id: _decimal(amount)
        for invoice_id, amount in rows
    }


def get_sales_register(
    db: Session,
    *,
    actor_id: UUID,
    start_date: date | None = None,
    end_date: date | None = None,
    customer_id: UUID | None = None,
    product_id: UUID | None = None,
) -> list[dict]:
    """Posted tax-invoice sales, with one row per invoice item."""

    _authorize(db, actor_id)

    filters = [
        Invoice.invoice_type == "TAX_INVOICE",
        Invoice.status.in_(("POSTED", "CREDITED")),
        *_date_filters(
            Invoice.invoice_date,
            start_date,
            end_date,
        ),
    ]

    if customer_id is not None:
        filters.append(Invoice.customer_id == customer_id)

    invoices = db.scalars(
        select(Invoice)
        .options(selectinload(Invoice.items))
        .where(*filters)
        .order_by(
            Invoice.invoice_date,
            Invoice.invoice_number,
        )
    ).all()

    customer_ids = {invoice.customer_id for invoice in invoices}

    customers = {
        customer.customer_id: customer
        for customer in db.scalars(
            select(Customer).where(
                Customer.customer_id.in_(customer_ids)
            )
        ).all()
    } if customer_ids else {}

    product_ids = {
        item.product_id
        for invoice in invoices
        for item in invoice.items
    }

    products = _item_names(db, product_ids)

    rows = []

    for invoice in invoices:
        customer = customers.get(invoice.customer_id)

        for item in sorted(
            invoice.items,
            key=lambda entry: entry.line_number,
        ):
            if (
                product_id is not None
                and item.product_id != product_id
            ):
                continue

            product = products.get(item.product_id)

            rows.append(
                {
                    "invoice_id": invoice.invoice_id,
                    "invoice_number": invoice.invoice_number,
                    "invoice_date": invoice.invoice_date,
                    "customer_id": invoice.customer_id,
                    "customer_name": (
                        customer.customer_name if customer else ""
                    ),
                    "product_id": item.product_id,
                    "product_name": (
                        product.item_name if product else ""
                    ),
                    "hsn_code": item.hsn_code,
                    "quantity": _decimal(item.quantity),
                    "unit_price": _decimal(item.unit_price),
                    "discount": _decimal(item.discount),
                    "taxable_amount": _decimal(
                        item.taxable_amount
                    ),
                    "gst_rate": _decimal(item.tax_rate),
                    "gst_amount": _decimal(item.tax_amount),
                    "line_total": _decimal(item.line_total),
                    "invoice_total": _decimal(
                        invoice.total_amount
                    ),
                    "invoice_status": invoice.status,
                }
            )

    return rows


def get_purchase_register(
    db: Session,
    *,
    actor_id: UUID,
    start_date: date | None = None,
    end_date: date | None = None,
    supplier_id: UUID | None = None,
    item_id: UUID | None = None,
) -> list[dict]:
    """
    Purchase register based on posted goods receipts.

    Only accepted quantities are treated as received inventory.
    Purchase prices and tax rates originate from purchase-order
    lines. Rejected quantities are reported separately.
    """

    _authorize(db, actor_id)

    filters = [
        GoodsReceipt.status == "POSTED",
        *_date_filters(
            GoodsReceipt.received_date,
            start_date,
            end_date,
        ),
    ]

    receipts = db.scalars(
        select(GoodsReceipt)
        .options(selectinload(GoodsReceipt.items))
        .where(*filters)
        .order_by(
            GoodsReceipt.received_date,
            GoodsReceipt.receipt_number,
        )
    ).all()

    po_ids = {receipt.purchase_order_id for receipt in receipts}

    purchase_orders = {
        po.purchase_order_id: po
        for po in db.scalars(
            select(PurchaseOrder).where(
                PurchaseOrder.purchase_order_id.in_(po_ids)
            )
        ).all()
    } if po_ids else {}

    po_item_ids = {
        line.po_item_id
        for receipt in receipts
        for line in receipt.items
    }

    po_items = {
        line.po_item_id: line
        for line in db.scalars(
            select(PurchaseOrderItem).where(
                PurchaseOrderItem.po_item_id.in_(po_item_ids)
            )
        ).all()
    } if po_item_ids else {}

    supplier_ids = {
        po.supplier_id for po in purchase_orders.values()
    }

    suppliers = {
        supplier.supplier_id: supplier
        for supplier in db.scalars(
            select(Supplier).where(
                Supplier.supplier_id.in_(supplier_ids)
            )
        ).all()
    } if supplier_ids else {}

    inventory_items = _item_names(
        db,
        {line.item_id for line in po_items.values()},
    )

    rows = []

    for receipt in receipts:
        po = purchase_orders.get(receipt.purchase_order_id)

        if po is None:
            continue

        if (
            supplier_id is not None
            and po.supplier_id != supplier_id
        ):
            continue

        supplier = suppliers.get(po.supplier_id)

        for receipt_line in receipt.items:
            po_line = po_items.get(receipt_line.po_item_id)

            if po_line is None:
                continue

            if (
                item_id is not None
                and po_line.item_id != item_id
            ):
                continue

            inventory_item = inventory_items.get(
                po_line.item_id
            )

            accepted = _decimal(
                receipt_line.accepted_quantity
            )
            rejected = _decimal(
                receipt_line.rejected_quantity
            )
            unit_price = _decimal(po_line.unit_price)
            taxable = accepted * unit_price
            tax_rate = _decimal(po_line.tax_rate)
            tax_amount = taxable * tax_rate / Decimal("100")

            rows.append(
                {
                    "purchase_order_id": po.purchase_order_id,
                    "purchase_number": po.po_number,
                    "purchase_date": po.order_date,
                    "receipt_id": receipt.receipt_id,
                    "receipt_number": receipt.receipt_number,
                    "receipt_date": receipt.received_date,
                    "supplier_id": po.supplier_id,
                    "supplier_name": (
                        supplier.supplier_name if supplier else ""
                    ),
                    "item_id": po_line.item_id,
                    "item_name": (
                        inventory_item.item_name
                        if inventory_item else ""
                    ),
                    "accepted_quantity": accepted,
                    "rejected_quantity": rejected,
                    "unit_price": unit_price,
                    "tax_rate": tax_rate,
                    "taxable_amount": taxable,
                    "tax_amount": tax_amount,
                    "total_amount": taxable + tax_amount,
                }
            )

    return rows


def get_stock_ledger(
    db: Session,
    *,
    actor_id: UUID,
    start_date: date | None = None,
    end_date: date | None = None,
    item_id: UUID | None = None,
    location: str | None = None,
) -> list[dict]:
    """
    Chronological stock ledger with running balances.

    Running balances include movements preceding the requested
    start date, so filtered ledger balances remain meaningful.
    """

    _authorize(db, actor_id)
    _validate_dates(start_date, end_date)

    filters = []

    if item_id is not None:
        filters.append(StockMovement.item_id == item_id)

    if location is not None:
        filters.append(StockMovement.location == location)

    if end_date is not None:
        filters.extend(
            _datetime_filters(
                StockMovement.created_at,
                None,
                end_date,
            )
        )

    movements = db.scalars(
        select(StockMovement)
        .where(*filters)
        .order_by(
            StockMovement.created_at,
            StockMovement.movement_id,
        )
    ).all()

    items = _item_names(
        db,
        {movement.item_id for movement in movements},
    )

    balances: dict[tuple[UUID, str], Decimal] = defaultdict(
        lambda: ZERO
    )

    rows = []

    for movement in movements:
        key = (
            movement.item_id,
            movement.location,
        )

        quantity = _decimal(movement.quantity)

        quantity_in = (
            quantity if movement.direction == "IN" else ZERO
        )
        quantity_out = (
            quantity if movement.direction == "OUT" else ZERO
        )

        balances[key] += quantity_in - quantity_out

        movement_date = movement.created_at.date()

        if start_date is not None and movement_date < start_date:
            continue

        item = items.get(movement.item_id)

        rows.append(
            {
                "movement_id": movement.movement_id,
                "movement_date": movement.created_at,
                "item_id": movement.item_id,
                "item_name": item.item_name if item else "",
                "item_type": item.item_type if item else "",
                "location": movement.location,
                "batch_id": movement.batch_id,
                "movement_type": movement.movement_type,
                "source_type": movement.source_type,
                "source_id": movement.source_id,
                "source_line_id": movement.source_line_id,
                "quantity_in": quantity_in,
                "quantity_out": quantity_out,
                "running_balance": balances[key],
                "unit_cost": _decimal(movement.unit_cost),
                "created_by": movement.created_by,
                "reversal_of_id": movement.reversal_of_id,
            }
        )

    return rows


def get_stock_summary(
    db: Session,
    *,
    actor_id: UUID,
    start_date: date | None = None,
    end_date: date | None = None,
    item_type: str | None = None,
    location: str | None = None,
) -> list[dict]:
    """
    Stock opening, receipts, issues, adjustments, and closing.

    Historical quantities are derived from the movement ledger.
    Current weighted-average cost is used for indicative valuation;
    it is not presented as historical cost.
    """

    _authorize(db, actor_id)
    _validate_dates(start_date, end_date)

    item_filters = []

    if item_type is not None:
        item_filters.append(
            InventoryItem.item_type == item_type
        )

    items = db.scalars(
        select(InventoryItem)
        .where(*item_filters)
        .order_by(InventoryItem.item_code)
    ).all()

    item_ids = {item.item_id for item in items}

    if not item_ids:
        return []

    movement_filters = [
        StockMovement.item_id.in_(item_ids)
    ]

    if location is not None:
        movement_filters.append(
            StockMovement.location == location
        )

    if end_date is not None:
        movement_filters.extend(
            _datetime_filters(
                StockMovement.created_at,
                None,
                end_date,
            )
        )

    movements = db.scalars(
        select(StockMovement)
        .where(*movement_filters)
        .order_by(
            StockMovement.created_at,
            StockMovement.movement_id,
        )
    ).all()

    summary: dict[tuple[UUID, str], dict] = {}

    def entry(key: tuple[UUID, str]) -> dict:
        if key not in summary:
            summary[key] = {
                "opening_stock": ZERO,
                "receipts": ZERO,
                "issues": ZERO,
                "adjustments": ZERO,
            }

        return summary[key]

    for movement in movements:
        key = (
            movement.item_id,
            movement.location,
        )
        target = entry(key)

        signed = (
            _decimal(movement.quantity)
            if movement.direction == "IN"
            else -_decimal(movement.quantity)
        )

        if (
            start_date is not None
            and movement.created_at.date() < start_date
        ):
            target["opening_stock"] += signed
            continue

        if movement.movement_type == "ADJUSTMENT":
            target["adjustments"] += signed
        elif signed >= ZERO:
            target["receipts"] += signed
        else:
            target["issues"] += -signed

    balance_filters = [
        InventoryBalance.item_id.in_(item_ids)
    ]

    if location is not None:
        balance_filters.append(
            InventoryBalance.location == location
        )

    current_balances = {
        (balance.item_id, balance.location): balance
        for balance in db.scalars(
            select(InventoryBalance)
            .where(*balance_filters)
        ).all()
    }

    if end_date is None:
        for key in current_balances:
            entry(key)

    item_lookup = {
        item.item_id: item for item in items
    }

    rows = []

    for key in sorted(
        summary,
        key=lambda value: (str(value[0]), value[1]),
    ):
        item_id, stock_location = key
        item = item_lookup[item_id]
        values = summary[key]

        closing = (
            values["opening_stock"]
            + values["receipts"]
            - values["issues"]
            + values["adjustments"]
        )

        current = current_balances.get(key)

        unit_cost = (
            _decimal(current.average_unit_cost)
            if current is not None
            else ZERO
        )

        rows.append(
            {
                "item_id": item_id,
                "item_code": item.item_code,
                "item_name": item.item_name,
                "item_type": item.item_type,
                "unit": item.base_unit,
                "location": stock_location,
                "opening_stock": values["opening_stock"],
                "receipts": values["receipts"],
                "issues": values["issues"],
                "adjustments": values["adjustments"],
                "closing_stock": closing,
                "current_average_unit_cost": unit_cost,
                "indicative_stock_value": closing * unit_cost,
                "reorder_level": _decimal(item.reorder_level),
                "below_reorder_level": (
                    stock_location == "WAREHOUSE"
                    and closing < _decimal(item.reorder_level)
                ),
            }
        )

    return rows


def get_production_report(
    db: Session,
    *,
    actor_id: UUID,
    start_date: date | None = None,
    end_date: date | None = None,
    product_id: UUID | None = None,
) -> list[dict]:
    """Production runs with material, yield, wastage, and costing."""

    _authorize(db, actor_id)

    filters = [
        *_datetime_filters(
            ProductionRun.start_time,
            start_date,
            end_date,
        )
    ]

    if product_id is not None:
        filters.append(
            ProductionRun.product_id == product_id
        )

    runs = db.scalars(
        select(ProductionRun)
        .options(
            selectinload(ProductionRun.materials),
            selectinload(ProductionRun.outputs),
            selectinload(ProductionRun.cost_summary),
        )
        .where(*filters)
        .order_by(
            ProductionRun.start_time,
            ProductionRun.production_number,
        )
    ).all()

    products = _item_names(
        db,
        {run.product_id for run in runs},
    )

    rows = []

    for run in runs:
        planned_output = _decimal(run.planned_output)
        actual_output = _decimal(run.actual_output)
        good_output = _decimal(run.good_output)
        rejected_output = _decimal(run.rejected_output)

        planned_material = sum(
            (
                _decimal(material.planned_quantity)
                for material in run.materials
            ),
            ZERO,
        )

        actual_material = sum(
            (
                _decimal(material.actual_quantity)
                for material in run.materials
            ),
            ZERO,
        )

        wasted_material = sum(
            (
                _decimal(material.wasted_quantity)
                for material in run.materials
            ),
            ZERO,
        )

        issued_material = sum(
            (
                _decimal(material.issued_quantity)
                for material in run.materials
            ),
            ZERO,
        )

        returned_material = sum(
            (
                _decimal(material.returned_quantity)
                for material in run.materials
            ),
            ZERO,
        )

        yield_variance = (
            (
                good_output - planned_output
            )
            / planned_output
            * Decimal("100")
            if planned_output > ZERO
            else None
        )

        material_variance = (
            (
                actual_material - planned_material
            )
            / planned_material
            * Decimal("100")
            if planned_material > ZERO
            else None
        )

        costing = run.cost_summary
        product = products.get(run.product_id)

        rows.append(
            {
                "production_run_id": run.production_run_id,
                "production_number": run.production_number,
                "product_id": run.product_id,
                "product_name": (
                    product.item_name if product else ""
                ),
                "start_time": run.start_time,
                "completion_time": run.completion_time,
                "status": run.status,
                "planned_output": planned_output,
                "actual_output": actual_output,
                "good_output": good_output,
                "rejected_output": rejected_output,
                "planned_material_quantity": planned_material,
                "issued_material_quantity": issued_material,
                "actual_material_quantity": actual_material,
                "wasted_material_quantity": wasted_material,
                "returned_material_quantity": returned_material,
                "material_variance_percent": material_variance,
                "yield_variance_percent": yield_variance,
                "material_cost": (
                    _decimal(costing.material_cost)
                    if costing else ZERO
                ),
                "packaging_cost": (
                    _decimal(costing.packaging_cost)
                    if costing else ZERO
                ),
                "overhead_cost": (
                    _decimal(costing.overhead_cost)
                    if costing else ZERO
                ),
                "total_cost": (
                    _decimal(costing.total_cost)
                    if costing else ZERO
                ),
                "cost_per_unit": (
                    _decimal(costing.cost_per_unit)
                    if costing else ZERO
                ),
            }
        )

    return rows


def get_gst_summary(
    db: Session,
    *,
    actor_id: UUID,
    start_date: date | None = None,
    end_date: date | None = None,
) -> dict:
    """
    Posted outward-supplies GST summary.

    Credit notes are presented as negative adjustments. This
    supports reconciliation for GSTR-1/GSTR-3B preparation but
    does not file government returns.
    """

    _authorize(db, actor_id)

    invoices = db.scalars(
        select(Invoice)
        .where(
            Invoice.status.in_(("POSTED", "CREDITED")),
            Invoice.invoice_type.in_(
                ("TAX_INVOICE", "CREDIT_NOTE")
            ),
            *_date_filters(
                Invoice.invoice_date,
                start_date,
                end_date,
            ),
        )
        .order_by(
            Invoice.invoice_date,
            Invoice.invoice_number,
        )
    ).all()

    totals = {
        "taxable_amount": ZERO,
        "cgst_amount": ZERO,
        "sgst_amount": ZERO,
        "igst_amount": ZERO,
        "total_tax": ZERO,
        "total_amount": ZERO,
    }

    rows = []

    for invoice in invoices:
        sign = (
            Decimal("-1")
            if invoice.invoice_type == "CREDIT_NOTE"
            else Decimal("1")
        )

        taxable = sign * _decimal(invoice.taxable_amount)
        cgst = sign * _decimal(invoice.cgst_amount)
        sgst = sign * _decimal(invoice.sgst_amount)
        igst = sign * _decimal(invoice.igst_amount)
        total_tax = cgst + sgst + igst
        total = sign * _decimal(invoice.total_amount)

        values = {
            "taxable_amount": taxable,
            "cgst_amount": cgst,
            "sgst_amount": sgst,
            "igst_amount": igst,
            "total_tax": total_tax,
            "total_amount": total,
        }

        for key, value in values.items():
            totals[key] += value

        rows.append(
            {
                "invoice_id": invoice.invoice_id,
                "invoice_number": invoice.invoice_number,
                "invoice_date": invoice.invoice_date,
                "invoice_type": invoice.invoice_type,
                "original_invoice_id": (
                    invoice.original_invoice_id
                ),
                "customer_id": invoice.customer_id,
                "place_of_supply_state": (
                    invoice.place_of_supply_state
                ),
                **values,
            }
        )

    return {
        "start_date": start_date,
        "end_date": end_date,
        "totals": totals,
        "invoices": rows,
    }


def get_payments_report(
    db: Session,
    *,
    actor_id: UUID,
    start_date: date | None = None,
    end_date: date | None = None,
    customer_id: UUID | None = None,
) -> list[dict]:
    """Posted customer payments and invoice allocations."""

    _authorize(db, actor_id)

    filters = [
        Payment.status == "POSTED",
        *_date_filters(
            Payment.payment_date,
            start_date,
            end_date,
        ),
    ]

    if customer_id is not None:
        filters.append(Payment.customer_id == customer_id)

    payments = db.scalars(
        select(Payment)
        .options(selectinload(Payment.allocations))
        .where(*filters)
        .order_by(
            Payment.payment_date,
            Payment.payment_id,
        )
    ).all()

    customer_ids = {
        payment.customer_id for payment in payments
    }

    customers = {
        customer.customer_id: customer
        for customer in db.scalars(
            select(Customer).where(
                Customer.customer_id.in_(customer_ids)
            )
        ).all()
    } if customer_ids else {}

    invoice_ids = {
        allocation.invoice_id
        for payment in payments
        for allocation in payment.allocations
    }

    invoices = {
        invoice.invoice_id: invoice
        for invoice in db.scalars(
            select(Invoice).where(
                Invoice.invoice_id.in_(invoice_ids)
            )
        ).all()
    } if invoice_ids else {}

    rows = []

    for payment in payments:
        customer = customers.get(payment.customer_id)

        allocated = sum(
            (
                _decimal(allocation.allocated_amount)
                for allocation in payment.allocations
            ),
            ZERO,
        )

        if not payment.allocations:
            rows.append(
                {
                    "payment_id": payment.payment_id,
                    "payment_date": payment.payment_date,
                    "customer_id": payment.customer_id,
                    "customer_name": (
                        customer.customer_name if customer else ""
                    ),
                    "payment_method": payment.payment_method,
                    "payment_reference": payment.reference_number,
                    "payment_amount": _decimal(payment.amount),
                    "invoice_id": None,
                    "invoice_number": None,
                    "allocated_amount": ZERO,
                    "unapplied_amount": (
                        _decimal(payment.amount) - allocated
                    ),
                }
            )
            continue

        for allocation in payment.allocations:
            invoice = invoices.get(allocation.invoice_id)

            rows.append(
                {
                    "payment_id": payment.payment_id,
                    "payment_date": payment.payment_date,
                    "customer_id": payment.customer_id,
                    "customer_name": (
                        customer.customer_name if customer else ""
                    ),
                    "payment_method": payment.payment_method,
                    "payment_reference": payment.reference_number,
                    "payment_amount": _decimal(payment.amount),
                    "invoice_id": allocation.invoice_id,
                    "invoice_number": (
                        invoice.invoice_number if invoice else None
                    ),
                    "allocated_amount": _decimal(
                        allocation.allocated_amount
                    ),
                    "unapplied_amount": (
                        _decimal(payment.amount) - allocated
                    ),
                }
            )

    return rows


def get_outstanding_receivables(
    db: Session,
    *,
    actor_id: UUID,
    as_of_date: date | None = None,
    customer_id: UUID | None = None,
    ageing_buckets: tuple[int, int, int] = DEFAULT_AGEING_BUCKETS,
) -> dict:
    """
    Outstanding invoices with due-date-based ageing.

    Historical as-of reports include only invoices, credits,
    and payments posted on or before the requested date.
    """

    _authorize(db, actor_id)

    if as_of_date is None:
        as_of_date = date.today()

    if (
        not isinstance(as_of_date, date)
        or isinstance(as_of_date, datetime)
    ):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Invalid receivables as-of date.",
        )

    if (
        len(ageing_buckets) != 3
        or any(
            isinstance(value, bool)
            or not isinstance(value, int)
            for value in ageing_buckets
        )
        or not (
            0 < ageing_buckets[0]
            < ageing_buckets[1]
            < ageing_buckets[2]
        )
    ):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Ageing buckets must contain three increasing "
            "positive day limits.",
        )

    filters = [
        Invoice.invoice_type == "TAX_INVOICE",
        Invoice.invoice_date <= as_of_date,
        Invoice.posted_at.is_not(None),
        Invoice.posted_at < datetime.combine(
            as_of_date + timedelta(days=1),
            time.min,
            tzinfo=timezone.utc,
        ),
        Invoice.status.in_(("POSTED", "CREDITED")),
    ]

    if customer_id is not None:
        filters.append(Invoice.customer_id == customer_id)

    invoices = db.scalars(
        select(Invoice)
        .where(*filters)
        .order_by(
            Invoice.due_date,
            Invoice.invoice_number,
        )
    ).all()

    invoice_ids = {
        invoice.invoice_id for invoice in invoices
    }

    payments: dict[UUID, Decimal] = defaultdict(
        lambda: ZERO
    )
    credits: dict[UUID, Decimal] = defaultdict(
        lambda: ZERO
    )

    if invoice_ids:
        payment_rows = db.execute(
            select(
                PaymentAllocation.invoice_id,
                func.sum(PaymentAllocation.allocated_amount),
            )
            .join(
                Payment,
                Payment.payment_id
                == PaymentAllocation.payment_id,
            )
            .where(
                PaymentAllocation.invoice_id.in_(invoice_ids),
                Payment.status == "POSTED",
                Payment.posted_at.is_not(None),
                Payment.posted_at < datetime.combine(
                    as_of_date + timedelta(days=1),
                    time.min,
                    tzinfo=timezone.utc,
                ),
            )
            .group_by(PaymentAllocation.invoice_id)
        ).all()

        for invoice_id, amount in payment_rows:
            payments[invoice_id] = _decimal(amount)

        credit_rows = db.execute(
            select(
                Invoice.original_invoice_id,
                func.sum(Invoice.total_amount),
            )
            .where(
                Invoice.original_invoice_id.in_(invoice_ids),
                Invoice.invoice_type == "CREDIT_NOTE",
                Invoice.status == "POSTED",
                Invoice.posted_at.is_not(None),
                Invoice.posted_at < datetime.combine(
                    as_of_date + timedelta(days=1),
                    time.min,
                    tzinfo=timezone.utc,
                ),
            )
            .group_by(Invoice.original_invoice_id)
        ).all()

        for invoice_id, amount in credit_rows:
            credits[invoice_id] = _decimal(amount)

    customer_ids = {
        invoice.customer_id for invoice in invoices
    }

    customers = {
        customer.customer_id: customer
        for customer in db.scalars(
            select(Customer).where(
                Customer.customer_id.in_(customer_ids)
            )
        ).all()
    } if customer_ids else {}

    first, second, third = ageing_buckets

    bucket_names = (
        "not_due",
        f"overdue_1_{first}",
        f"overdue_{first + 1}_{second}",
        f"overdue_{second + 1}_{third}",
        f"overdue_over_{third}",
    )

    totals = {
        name: ZERO for name in bucket_names
    }
    totals["outstanding_total"] = ZERO

    rows = []

    for invoice in invoices:
        outstanding = max(
            ZERO,
            _decimal(invoice.total_amount)
            - payments[invoice.invoice_id]
            - credits[invoice.invoice_id],
        )

        if outstanding <= ZERO:
            continue

        days_overdue = (
            as_of_date - invoice.due_date
        ).days

        if days_overdue <= 0:
            bucket = bucket_names[0]
        elif days_overdue <= first:
            bucket = bucket_names[1]
        elif days_overdue <= second:
            bucket = bucket_names[2]
        elif days_overdue <= third:
            bucket = bucket_names[3]
        else:
            bucket = bucket_names[4]

        totals[bucket] += outstanding
        totals["outstanding_total"] += outstanding

        customer = customers.get(invoice.customer_id)

        rows.append(
            {
                "invoice_id": invoice.invoice_id,
                "invoice_number": invoice.invoice_number,
                "invoice_date": invoice.invoice_date,
                "due_date": invoice.due_date,
                "customer_id": invoice.customer_id,
                "customer_name": (
                    customer.customer_name if customer else ""
                ),
                "invoice_total": _decimal(
                    invoice.total_amount
                ),
                "paid_amount": payments[invoice.invoice_id],
                "credited_amount": credits[invoice.invoice_id],
                "outstanding_amount": outstanding,
                "days_overdue": max(0, days_overdue),
                "ageing_bucket": bucket,
            }
        )

    return {
        "as_of_date": as_of_date,
        "ageing_buckets": ageing_buckets,
        "totals": totals,
        "invoices": rows,
    }


def get_audit_report(
    db: Session,
    *,
    actor_id: UUID,
    start_date: date | None = None,
    end_date: date | None = None,
    entity_type: str | None = None,
    user_id: UUID | None = None,
    page: int = 1,
    page_size: int = 100,
) -> dict:
    """Paginated audit history for authorized reporting users."""

    _authorize(db, actor_id)

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
            "Invalid audit-report pagination.",
        )

    filters = [
        *_datetime_filters(
            AuditLog.timestamp,
            start_date,
            end_date,
        )
    ]

    if entity_type is not None:
        filters.append(
            AuditLog.entity_type == entity_type
        )

    if user_id is not None:
        filters.append(AuditLog.user_id == user_id)

    total = db.scalar(
        select(func.count())
        .select_from(AuditLog)
        .where(*filters)
    ) or 0

    entries = db.scalars(
        select(AuditLog)
        .where(*filters)
        .order_by(
            AuditLog.timestamp.desc(),
            AuditLog.audit_id.desc(),
        )
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()

    return {
        "total": total,
        "page": page,
        "page_size": page_size,
        "entries": [
            {
                "audit_id": entry.audit_id,
                "timestamp": entry.timestamp,
                "user_id": entry.user_id,
                "entity_type": entry.entity_type,
                "entity_id": entry.entity_id,
                "action": entry.action,
                "old_values": entry.old_values,
                "new_values": entry.new_values,
            }
            for entry in entries
        ],
    }