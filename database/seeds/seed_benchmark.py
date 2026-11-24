"""
Seed the mandatory Winter Internship 2026 benchmark scenario.

Source:
- Original internship problem statement, Section 5.
- Business_Rules_and_Benchmark.docx.
- database/fixtures/benchmark_data.json.

The seed preserves the benchmark's specified quantities, prices,
production consumption, GST treatment, and transaction sequence.

The opening finished-goods unit cost is not specified by the
problem statement. The evaluator fixture records a user-approved,
documented derived estimate for this local demonstration.

All database changes are performed in one transaction. The script
does not execute unless --apply is provided.

This script is intended for a clean, non-production benchmark
database. It does not replace the application's production
transaction services or its end-to-end acceptance tests.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

PROJECT_ROOT = Path(__file__).resolve().parents[2]
BACKEND_DIR = PROJECT_ROOT / "backend"
FIXTURE_PATH = (
    PROJECT_ROOT / "database" / "fixtures" / "benchmark_data.json"
)

if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.core.config import settings
from app.core.database import SessionLocal
from app.models import (
    BOMItem,
    Customer,
    GoodsReceipt,
    GoodsReceiptItem,
    InventoryBalance,
    InventoryItem,
    Invoice,
    InvoiceItem,
    OrderApprovalHistory,
    PackagingMaterial,
    Payment,
    PaymentAllocation,
    Product,
    ProductBOM,
    ProductionCostSummary,
    ProductionExpense,
    ProductionMaterial,
    ProductionOutput,
    ProductionRun,
    PurchaseOrder,
    PurchaseOrderItem,
    RawMaterial,
    Role,
    SalesOrder,
    SalesOrderItem,
    StockBatch,
    StockMovement,
    Supplier,
    UnitConversion,
    User,
    UserRole,
    Dispatch,
    DispatchItem,
)
from app.services import inventory_service
from app.services.audit_service import create_audit_log


MONEY_QUANTUM = Decimal("0.01")
QUANTITY_QUANTUM = Decimal("0.001")
COST_QUANTUM = Decimal("0.000001")
RATE_QUANTUM = Decimal("0.0001")

BENCHMARK_PREFIX = "BENCH2026"
UTC = timezone.utc


def decimal_value(value: Any) -> Decimal:
    """Convert fixture values to exact Decimal values."""

    if value is None:
        raise ValueError("A required numeric fixture value is missing.")

    result = Decimal(str(value))

    if not result.is_finite():
        raise ValueError("Benchmark values must be finite numbers.")

    return result


def money(value: Any) -> Decimal:
    return decimal_value(value).quantize(
        MONEY_QUANTUM,
        rounding=ROUND_HALF_UP,
    )


def quantity(value: Any) -> Decimal:
    return decimal_value(value).quantize(
        QUANTITY_QUANTUM,
        rounding=ROUND_HALF_UP,
    )


def unit_cost(value: Any) -> Decimal:
    return decimal_value(value).quantize(
        COST_QUANTUM,
        rounding=ROUND_HALF_UP,
    )


def percent(value: Any) -> Decimal:
    return decimal_value(value).quantize(
        RATE_QUANTUM,
        rounding=ROUND_HALF_UP,
    )


def utc_now() -> datetime:
    return datetime.now(UTC)


def fixture_uuid(namespace: str, key: str) -> uuid.UUID:
    """Generate stable UUIDs for benchmark records."""

    return uuid.uuid5(
        uuid.NAMESPACE_URL,
        f"food-manufacturing/benchmark-2026/{namespace}/{key}",
    )


def load_fixture() -> dict[str, Any]:
    if not FIXTURE_PATH.is_file():
        raise FileNotFoundError(
            f"Benchmark fixture not found: {FIXTURE_PATH}"
        )

    with FIXTURE_PATH.open("r", encoding="utf-8") as handle:
        fixture = json.load(handle)

    if fixture.get("fixture_name") != (
        "winter_internship_2026_mandatory_benchmark"
    ):
        raise ValueError("Unexpected benchmark fixture identity.")

    if fixture.get("currency") != "INR":
        raise ValueError("Benchmark currency must be INR.")

    expected_operations = [
        "PURCHASE_AND_RECEIVE",
        "START_PRODUCTION_AND_ISSUE_MATERIALS",
        "COMPLETE_PRODUCTION",
        "CREATE_SALES_ORDER",
        "APPROVE_INVOICE_AND_DISPATCH",
        "CREATE_SALES_ORDER_AND_CHECK_STOCK",
        "RECORD_AND_ALLOCATE_PAYMENT",
        "RECORD_PRODUCTION_EXPENSES_AND_RECALCULATE_COST",
        "GENERATE_MONTHLY_REPORTS",
    ]

    actual_operations = [
        step["operation"]
        for step in fixture["benchmark_steps"]
    ]

    if actual_operations != expected_operations:
        raise ValueError(
            "Benchmark transaction sequence does not match "
            "the approved fixture."
        )

    return fixture


def require_opening_finished_goods_cost() -> Decimal:
    """
    Require the unspecified opening finished-goods valuation.

    This value is an operator-supplied assumption, not a value
    attributed to the original problem statement.
    """

    raw_value = os.environ.get("BENCHMARK_OPENING_FG_UNIT_COST", "").strip()
    if not raw_value:
        fixture = load_fixture()
        assumption = next(
            (
                entry
                for entry in fixture.get("documented_assumptions_and_discrepancies", [])
                if entry.get("code") == "OPENING_FINISHED_GOODS_VALUATION_UNSPECIFIED"
                and entry.get("user_approved_value_per_packet")
            ),
            None,
        )
        if assumption is None:
            raise ValueError(
                "Set BENCHMARK_OPENING_FG_UNIT_COST or record an "
                "approved opening finished-goods valuation in the fixture."
            )
        raw_value = str(assumption["user_approved_value_per_packet"])

    value = unit_cost(raw_value)

    if value < 0:
        raise ValueError(
            "Opening finished-goods unit cost cannot be negative."
        )

    return value


@dataclass
class BenchmarkContext:
    fixture: dict[str, Any]
    session: Session
    transaction_date: date
    transaction_time: datetime
    opening_fg_unit_cost: Decimal

    def __post_init__(self) -> None:
        self.users: dict[str, User] = {}
        self.customers: dict[str, Customer] = {}
        self.suppliers: dict[str, Supplier] = {}
        self.items: dict[str, InventoryItem] = {}
        self.products: dict[str, Product] = {}
        self.boms: dict[str, ProductBOM] = {}
        self.balances: dict[tuple[str, str], InventoryBalance] = {}
        self.batches: dict[str, StockBatch] = {}
        self.orders: dict[str, SalesOrder] = {}
        self.invoices: dict[str, Invoice] = {}
        self.production_runs: dict[str, ProductionRun] = {}

    def add(self, instance: Any) -> Any:
        self.session.add(instance)
        self.session.flush()
        return instance

    def audit(
        self,
        *,
        actor: User,
        entity_type: str,
        entity_id: uuid.UUID,
        action: str,
        new_values: dict[str, Any],
    ) -> None:
        create_audit_log(
            self.session,
            user_id=actor.user_id,
            entity_type=entity_type,
            entity_id=entity_id,
            action=action,
            new_values=new_values,
        )

    def get_balance(
        self,
        item_key: str,
        location: str = "WAREHOUSE",
    ) -> InventoryBalance:
        key = (item_key, location)

        if key not in self.balances:
            self.balances[key] = self.add(
                InventoryBalance(
                    balance_id=fixture_uuid(
                        "inventory_balance",
                        f"{item_key}:{location}",
                    ),
                    item_id=self.items[item_key].item_id,
                    location=location,
                    quantity_on_hand=quantity("0"),
                    average_unit_cost=unit_cost("0"),
                )
            )

        return self.balances[key]

    def post_movement(
        self,
        *,
        item_key: str,
        batch: StockBatch | None,
        movement_type: str,
        direction: str,
        amount: Decimal,
        applied_cost: Decimal,
        source_type: str,
        source_id: uuid.UUID,
        source_line_id: uuid.UUID,
        actor: User,
        location: str = "WAREHOUSE",
    ) -> StockMovement:
        """
        Post a movement and update its balance atomically.

        The surrounding seed transaction must hold the relevant
        balance and batch rows when modifying existing records.
        """

        if amount <= 0:
            raise ValueError("Stock movement quantity must be positive.")

        movement = inventory_service.post_stock_movement(
            self.session,
            item_id=self.items[item_key].item_id,
            movement_type=movement_type,
            direction=direction,
            location=location,
            quantity=amount,
            unit_cost=applied_cost,
            source_type=source_type,
            source_id=source_id,
            source_line_id=source_line_id,
            created_by=actor.user_id,
            batch_id=(batch.batch_id if batch and location == "WAREHOUSE" else None),
        )
        balance = inventory_service.get_inventory_balance(
            self.session,
            item_id=self.items[item_key].item_id,
            location=location,
        )
        if balance is not None:
            self.balances[(item_key, location)] = balance
        self.audit(
            actor=actor,
            entity_type="StockMovement",
            entity_id=movement.movement_id,
            action="STOCK_MOVEMENT_POSTED",
            new_values={
                "item_id": movement.item_id,
                "movement_type": movement.movement_type,
                "direction": movement.direction,
                "location": movement.location,
                "quantity": movement.quantity,
                "unit_cost": movement.unit_cost,
                "source_type": movement.source_type,
                "source_id": movement.source_id,
            },
        )
        return movement


def benchmark_namespace_exists(session: Session) -> bool:
    """Return whether any stable record in this benchmark exists."""

    existing_items = session.scalar(
        select(InventoryItem.item_id)
        .where(InventoryItem.item_code.like("BENCH-%"))
        .limit(1)
    )

    existing_orders = session.scalar(
        select(SalesOrder.sales_order_id)
        .where(SalesOrder.order_number.like(f"{BENCHMARK_PREFIX}%"))
        .limit(1)
    )

    existing_invoices = session.scalar(
        select(Invoice.invoice_id)
        .where(Invoice.invoice_number.like(f"{BENCHMARK_PREFIX}%"))
        .limit(1)
    )

    return any(
        value is not None
        for value in (
            existing_items,
            existing_orders,
            existing_invoices,
        )
    )


def load_existing_benchmark(context: BenchmarkContext) -> None:
    """Load a previous fixture run and verify it without writing."""
    fixture = context.fixture
    session = context.session
    for definition in fixture["users"]:
        user = session.scalar(
            select(User)
            .join(UserRole, UserRole.user_id == User.user_id)
            .join(Role, Role.role_id == UserRole.role_id)
            .where(
                User.full_name == definition["display_name"],
                Role.role_name == definition["role"],
                User.is_active.is_(True),
            )
        )
        if user is None:
            raise ValueError("Existing benchmark is incomplete: a demo user is missing.")
        context.users[definition["fixture_key"]] = user

    for definition in fixture["customers"]:
        row = session.get(Customer, fixture_uuid("customer", definition["fixture_key"]))
        if row is None or row.customer_name != definition["customer_name"]:
            raise ValueError("Existing benchmark is incomplete: a customer is missing or changed.")
        context.customers[definition["fixture_key"]] = row

    for definition in fixture["suppliers"]:
        row = session.get(Supplier, fixture_uuid("supplier", definition["fixture_key"]))
        if row is None or row.supplier_name != definition["supplier_name"]:
            raise ValueError("Existing benchmark is incomplete: a supplier is missing or changed.")
        context.suppliers[definition["fixture_key"]] = row

    for definition in fixture["inventory_items"]:
        key = definition["fixture_key"]
        row = session.get(InventoryItem, fixture_uuid("inventory_item", key))
        if row is None or row.item_code != definition["item_code"]:
            raise ValueError("Existing benchmark is incomplete: inventory master data is missing or changed.")
        context.items[key] = row
        if definition["item_type"] == "FINISHED_PRODUCT":
            product = session.get(Product, row.item_id)
            if product is None:
                raise ValueError("Existing benchmark is incomplete: finished product is missing.")
            context.products[key] = product
        balance = inventory_service.get_inventory_balance(
            session,
            item_id=row.item_id,
            location="WAREHOUSE",
        )
        if balance is None:
            raise ValueError("Existing benchmark is incomplete: an inventory balance is missing.")
        context.balances[(key, "WAREHOUSE")] = balance

    bom_definition = fixture["bom"]
    bom = session.get(ProductBOM, fixture_uuid("bom", bom_definition["fixture_key"]))
    if bom is None:
        raise ValueError("Existing benchmark is incomplete: BOM is missing.")
    context.boms[bom_definition["fixture_key"]] = bom

    for step in fixture["benchmark_steps"]:
        if step["operation"] in ("CREATE_SALES_ORDER", "CREATE_SALES_ORDER_AND_CHECK_STOCK"):
            key = step["fixture_key"]
            order = session.get(SalesOrder, fixture_uuid("sales_order", key))
            if order is None:
                raise ValueError("Existing benchmark is incomplete: a sales order is missing.")
            context.orders[key] = order
        elif step["operation"] == "START_PRODUCTION_AND_ISSUE_MATERIALS":
            key = step["fixture_key"]
            run = session.get(ProductionRun, fixture_uuid("production_run", key))
            if run is None:
                raise ValueError("Existing benchmark is incomplete: production run is missing.")
            context.production_runs[key] = run
        elif step["operation"] == "APPROVE_INVOICE_AND_DISPATCH":
            definition = step["invoice"]
            invoice = session.get(Invoice, fixture_uuid("invoice", definition["fixture_key"]))
            if invoice is None:
                raise ValueError("Existing benchmark is incomplete: invoice is missing.")
            context.invoices[definition["fixture_key"]] = invoice

    opening_item = context.items[fixture["expected_results"]["finished_goods"]["product_key"]]
    opening_batch = session.scalar(
        select(StockBatch).where(
            StockBatch.item_id == opening_item.item_id,
            StockBatch.batch_number == f"{BENCHMARK_PREFIX}-OPEN-MURUKKU_200G",
        )
    )
    if opening_batch is None or Decimal(opening_batch.unit_cost) != context.opening_fg_unit_cost:
        raise ValueError("Existing benchmark opening finished-goods valuation differs from the requested assumption.")
    verify_benchmark(context)


def load_users(context: BenchmarkContext) -> None:
    """Resolve previously seeded users without creating passwords."""

    for definition in context.fixture["users"]:
        role_name = definition["role"]
        display_name = definition["display_name"]

        user = context.session.scalar(
            select(User)
            .join(UserRole, UserRole.user_id == User.user_id)
            .join(Role, Role.role_id == UserRole.role_id)
            .where(
                User.full_name == display_name,
                Role.role_name == role_name,
                User.is_active.is_(True),
            )
        )

        if user is None:
            raise ValueError(
                f"Required benchmark user is missing: {display_name}. "
                "Seed demonstration users first."
            )

        context.users[definition["fixture_key"]] = user


def seed_customers_and_suppliers(
    context: BenchmarkContext,
) -> None:
    for definition in context.fixture["customers"]:
        key = definition["fixture_key"]

        existing = context.session.scalar(
            select(Customer)
            .where(Customer.customer_name == definition["customer_name"])
        )

        if existing is not None:
            raise ValueError(
                f"Benchmark customer already exists: {key}."
            )

        context.customers[key] = context.add(
            Customer(
                customer_id=fixture_uuid("customer", key),
                customer_name=definition["customer_name"],
                customer_type=definition["customer_type"],
                state=definition["state"],
                assigned_salesman_id=context.users[
                    definition["assigned_salesman_key"]
                ].user_id,
                is_active=True,
            )
        )
        context.audit(
            actor=context.users["factory_admin"],
            entity_type="Customer",
            entity_id=context.customers[key].customer_id,
            action="CUSTOMER_CREATED",
            new_values={"customer_name": definition["customer_name"], "state": definition["state"]},
        )

    for definition in context.fixture["suppliers"]:
        key = definition["fixture_key"]

        context.suppliers[key] = context.add(
            Supplier(
                supplier_id=fixture_uuid("supplier", key),
                supplier_name=definition["supplier_name"],
                is_active=True,
            )
        )
        context.audit(
            actor=context.users["factory_admin"],
            entity_type="Supplier",
            entity_id=context.suppliers[key].supplier_id,
            action="SUPPLIER_CREATED",
            new_values={"supplier_name": definition["supplier_name"]},
        )


def seed_unit_conversions(context: BenchmarkContext) -> None:
    """Create only fixture-approved unit conversion factors."""
    for definition in context.fixture.get("unit_conversions", []):
        existing = context.session.scalar(
            select(UnitConversion).where(
                UnitConversion.from_unit == definition["from_unit"],
                UnitConversion.to_unit == definition["to_unit"],
            )
        )
        factor = decimal_value(definition["conversion_factor"])
        if existing is not None:
            if Decimal(existing.conversion_factor) != factor:
                raise ValueError(
                    f"Existing conversion {definition['from_unit']} to "
                    f"{definition['to_unit']} differs from the fixture."
                )
            continue
        conversion = context.add(UnitConversion(
            from_unit=definition["from_unit"],
            to_unit=definition["to_unit"],
            conversion_factor=factor,
        ))
        context.audit(
            actor=context.users["factory_admin"],
            entity_type="UnitConversion",
            entity_id=conversion.conversion_id,
            action="UNIT_CONVERSION_CREATED",
            new_values={"from_unit": conversion.from_unit, "to_unit": conversion.to_unit, "conversion_factor": conversion.conversion_factor},
        )


def seed_inventory_master_data(
    context: BenchmarkContext,
) -> None:
    for definition in context.fixture["inventory_items"]:
        key = definition["fixture_key"]
        item_type = definition["item_type"]

        item = context.add(
            InventoryItem(
                item_id=fixture_uuid("inventory_item", key),
                item_code=definition["item_code"],
                item_name=definition["item_name"],
                item_type=item_type,
                base_unit=definition["base_unit"],
                reorder_level=quantity("0"),
                is_active=True,
            )
        )

        context.items[key] = item
        context.audit(
            actor=context.users["factory_admin"],
            entity_type="InventoryItem",
            entity_id=item.item_id,
            action="INVENTORY_ITEM_CREATED",
            new_values={"item_code": item.item_code, "item_name": item.item_name, "item_type": item.item_type, "base_unit": item.base_unit},
        )

        if item_type == "RAW_MATERIAL":
            context.add(
                RawMaterial(
                    material_id=item.item_id,
                )
            )

        elif item_type == "PACKAGING_MATERIAL":
            context.add(
                PackagingMaterial(
                    packaging_id=item.item_id,
                    capacity_packets=(
                        quantity(definition["capacity_packets"])
                        if definition.get("capacity_packets") is not None
                        else None
                    ),
                )
            )

        elif item_type == "FINISHED_PRODUCT":
            context.products[key] = context.add(
                Product(
                    product_id=item.item_id,
                    selling_price=money(definition["selling_price"]),
                    gst_rate=percent(
                        definition["gst_rate_percent"]
                    ),
                    pack_size=quantity(definition["pack_size"]),
                    pack_unit=definition["pack_unit"],
                )
            )
            context.audit(
                actor=context.users["factory_admin"],
                entity_type="Product",
                entity_id=context.products[key].product_id,
                action="PRODUCT_CREATED",
                new_values={"selling_price": context.products[key].selling_price, "gst_rate": context.products[key].gst_rate},
            )

        else:
            raise ValueError(f"Unknown inventory item type: {item_type}")


def seed_opening_stock(context: BenchmarkContext) -> None:
    actor = context.users["factory_admin"]

    for definition in context.fixture["inventory_items"]:
        key = definition["fixture_key"]
        opening_quantity = quantity(definition["opening_quantity"])

        opening_cost = (
            context.opening_fg_unit_cost
            if definition["item_type"] == "FINISHED_PRODUCT"
            else unit_cost(definition["opening_unit_cost"])
        )

        batch_key = f"opening:{key}"

        batch = inventory_service.create_stock_batch(
            context.session,
            item_id=context.items[key].item_id,
            batch_number=f"{BENCHMARK_PREFIX}-OPEN-{key.upper()}",
            source_type="OPENING_BALANCE",
            source_id=fixture_uuid("opening_source", key),
            quantity=opening_quantity,
            unit_cost=opening_cost,
            manufacturing_date=context.transaction_date,
        )

        context.batches[batch_key] = batch

        context.post_movement(
            item_key=key,
            batch=batch,
            movement_type="OPENING_BALANCE",
            direction="IN",
            amount=opening_quantity,
            applied_cost=opening_cost,
            source_type="OPENING_BALANCE",
            source_id=batch.source_id,
            source_line_id=fixture_uuid("opening_line", key),
            actor=actor,
        )


def seed_bom(context: BenchmarkContext) -> None:
    definition = context.fixture["bom"]
    key = definition["fixture_key"]

    bom = context.add(
        ProductBOM(
            bom_id=fixture_uuid("bom", key),
            product_id=context.products[
                definition["product_key"]
            ].product_id,
            version=definition["version"],
            standard_batch_size=quantity(
                definition["standard_batch_size"]
            ),
            expected_output=quantity(
                definition["expected_output"]
            ),
            effective_from=context.transaction_date,
            is_active=True,
        )
    )

    context.boms[key] = bom

    for item_definition in definition["items"]:
        item_key = item_definition["item_key"]

        context.add(
            BOMItem(
                bom_item_id=fixture_uuid(
                    "bom_item",
                    f"{key}:{item_key}",
                ),
                bom_id=bom.bom_id,
                item_id=context.items[item_key].item_id,
                quantity_required=quantity(
                    item_definition["quantity_required"]
                ),
                unit=item_definition["unit"],
            )
        )
    context.audit(
        actor=context.users["factory_admin"],
        entity_type="ProductBOM",
        entity_id=bom.bom_id,
        action="PRODUCT_BOM_CREATED",
        new_values={"product_id": bom.product_id, "version": bom.version, "standard_batch_size": bom.standard_batch_size},
    )


def purchase_and_receive(
    context: BenchmarkContext,
    step: dict[str, Any],
) -> None:
    actor = context.users["factory_admin"]
    key = step["fixture_key"]

    purchase_order = context.add(
        PurchaseOrder(
            purchase_order_id=fixture_uuid("purchase_order", key),
            supplier_id=context.suppliers[
                step["supplier_key"]
            ].supplier_id,
            po_number=f"{BENCHMARK_PREFIX}-PO-001",
            order_date=context.transaction_date,
            expected_date=context.transaction_date,
            status="RECEIVED",
            created_by=actor.user_id,
        )
    )
    context.audit(
        actor=actor,
        entity_type="PurchaseOrder",
        entity_id=purchase_order.purchase_order_id,
        action="PURCHASE_ORDER_CREATED",
        new_values={"po_number": purchase_order.po_number, "status": purchase_order.status, "supplier_id": purchase_order.supplier_id},
    )

    receipt = context.add(
        GoodsReceipt(
            receipt_id=fixture_uuid("goods_receipt", key),
            purchase_order_id=purchase_order.purchase_order_id,
            receipt_number=f"{BENCHMARK_PREFIX}-GRN-001",
            received_date=context.transaction_date,
            received_by=actor.user_id,
            status="POSTED",
            posted_at=context.transaction_time,
        )
    )
    context.audit(
        actor=actor,
        entity_type="GoodsReceipt",
        entity_id=receipt.receipt_id,
        action="GOODS_RECEIPT_POSTED",
        new_values={"receipt_number": receipt.receipt_number, "status": receipt.status, "purchase_order_id": receipt.purchase_order_id},
    )

    for definition in step["items"]:
        item_key = definition["item_key"]
        received_quantity = quantity(definition["quantity"])
        price = money(definition["unit_price"])

        purchase_item = context.add(
            PurchaseOrderItem(
                po_item_id=fixture_uuid(
                    "purchase_order_item",
                    f"{key}:{item_key}",
                ),
                purchase_order_id=purchase_order.purchase_order_id,
                item_id=context.items[item_key].item_id,
                quantity=received_quantity,
                unit_price=price,
                tax_rate=percent("0"),
                line_total=money(received_quantity * price),
            )
        )

        receipt_item = context.add(
            GoodsReceiptItem(
                receipt_item_id=fixture_uuid(
                    "goods_receipt_item",
                    f"{key}:{item_key}",
                ),
                receipt_id=receipt.receipt_id,
                po_item_id=purchase_item.po_item_id,
                received_quantity=received_quantity,
                accepted_quantity=received_quantity,
                rejected_quantity=quantity("0"),
            )
        )

        batch = context.add(
            StockBatch(
                batch_id=fixture_uuid(
                    "stock_batch",
                    f"purchase:{key}:{item_key}",
                ),
                item_id=context.items[item_key].item_id,
                batch_number=(
                    f"{BENCHMARK_PREFIX}-PURCHASE-{item_key.upper()}"
                ),
                source_type="GOODS_RECEIPT",
                source_id=receipt.receipt_id,
                initial_quantity=received_quantity,
                quantity_remaining=quantity("0"),
                unit_cost=unit_cost(price),
            )
        )

        context.batches[f"purchase:{item_key}"] = batch

        context.post_movement(
            item_key=item_key,
            batch=batch,
            movement_type="PURCHASE_RECEIPT",
            direction="IN",
            amount=received_quantity,
            applied_cost=unit_cost(price),
            source_type="GOODS_RECEIPT",
            source_id=receipt.receipt_id,
            source_line_id=receipt_item.receipt_item_id,
            actor=actor,
        )


def allocate_from_batches(
    context: BenchmarkContext,
    item_key: str,
    required: Decimal,
) -> list[tuple[StockBatch, Decimal]]:
    """
    Select eligible batches by expiry and creation order.

    This seed uses the benchmark's warehouse stock only.
    Production service code must perform equivalent allocation
    under database row locks for concurrent operations.
    """

    available_batches = [
        batch
        for batch in context.batches.values()
        if batch.item_id == context.items[item_key].item_id
        and batch.quantity_remaining > 0
        and (
            batch.expiry_date is None
            or batch.expiry_date >= context.transaction_date
        )
    ]

    available_batches.sort(
        key=lambda batch: (
            batch.expiry_date or date.max,
            batch.created_at or context.transaction_time,
            batch.batch_number,
        )
    )

    remaining = required
    allocations: list[tuple[StockBatch, Decimal]] = []

    for batch in available_batches:
        if remaining <= 0:
            break

        allocated = min(
            remaining,
            batch.quantity_remaining,
        )

        if allocated > 0:
            allocations.append((batch, allocated))
            remaining = quantity(remaining - allocated)

    if remaining > 0:
        raise ValueError(
            f"Insufficient stock for {item_key}: "
            f"requested {required}, shortage {remaining}."
        )

    return allocations


def start_production(
    context: BenchmarkContext,
    step: dict[str, Any],
) -> None:
    key = step["fixture_key"]
    supervisor = context.users.get(
        "production_supervisor",
        context.users["factory_admin"],
    )

    bom = context.boms[step["bom_key"]]

    production_run = context.add(
        ProductionRun(
            production_run_id=fixture_uuid("production_run", key),
            production_number=f"{BENCHMARK_PREFIX}-PROD-001",
            product_id=context.products[
                step["product_key"]
            ].product_id,
            bom_id=bom.bom_id,
            supervisor_id=supervisor.user_id,
            planned_output=quantity(step["planned_output"]),
            actual_output=quantity("0"),
            good_output=quantity("0"),
            rejected_output=quantity("0"),
            start_time=context.transaction_time,
            status="IN_PROGRESS",
        )
    )
    context.audit(
        actor=supervisor,
        entity_type="ProductionRun",
        entity_id=production_run.production_run_id,
        action="PRODUCTION_RUN_STARTED",
        new_values={"production_number": production_run.production_number, "status": production_run.status, "planned_output": production_run.planned_output},
    )

    context.production_runs[key] = production_run

    bom_requirements = {
        context.session.get(
            InventoryItem,
            bom_item.item_id,
        ).item_code: bom_item
        for bom_item in context.session.scalars(
            select(BOMItem).where(BOMItem.bom_id == bom.bom_id)
        )
    }

    for definition in step["materials"]:
        item_key = definition["item_key"]
        item_code = context.items[item_key].item_code

        if item_code not in bom_requirements:
            raise ValueError(
                f"Production material {item_key} is absent from the BOM."
            )

        planned = bom_requirements[item_code].quantity_required
        issued = quantity(definition["issued_quantity"])
        consumed = quantity(definition["actual_consumption"])
        wasted = quantity(definition["wasted_quantity"])
        returned = quantity(definition["returned_quantity"])

        if consumed + wasted + returned != issued:
            raise ValueError(
                f"Unreconciled issued material: {item_key}."
            )

        allocations = allocate_from_batches(
            context,
            item_key,
            issued,
        )

        for allocation_number, (batch, allocated) in enumerate(
            allocations,
            start=1,
        ):
            fraction = allocated / issued

            allocated_consumption = quantity(
                consumed * fraction
            )
            allocated_waste = quantity(
                wasted * fraction
            )
            allocated_return = quantity(
                returned * fraction
            )

            if allocation_number == len(allocations):
                previous = context.session.scalars(
                    select(ProductionMaterial).where(
                        ProductionMaterial.production_run_id
                        == production_run.production_run_id,
                        ProductionMaterial.item_id
                        == context.items[item_key].item_id,
                    )
                ).all()

                allocated_consumption = consumed - sum(
                    (row.actual_quantity for row in previous),
                    Decimal("0"),
                )
                allocated_waste = wasted - sum(
                    (row.wasted_quantity for row in previous),
                    Decimal("0"),
                )
                allocated_return = returned - sum(
                    (row.returned_quantity for row in previous),
                    Decimal("0"),
                )

            if (
                allocated_consumption
                + allocated_waste
                + allocated_return
                != allocated
            ):
                raise ValueError(
                    f"Batch allocation does not reconcile: {item_key}."
                )

            material = context.add(
                ProductionMaterial(
                    production_material_id=fixture_uuid(
                        "production_material",
                        f"{key}:{item_key}:{batch.batch_id}",
                    ),
                    production_run_id=production_run.production_run_id,
                    item_id=context.items[item_key].item_id,
                    batch_id=batch.batch_id,
                    planned_quantity=(
                        planned
                        if allocation_number == 1
                        else quantity("0")
                    ),
                    issued_quantity=allocated,
                    actual_quantity=quantity("0"),
                    wasted_quantity=quantity("0"),
                    returned_quantity=quantity("0"),
                    unit=definition["unit"],
                    applied_unit_cost=context.get_balance(
                        item_key
                    ).average_unit_cost,
                )
            )

            context.post_movement(
                item_key=item_key,
                batch=batch,
                movement_type="PRODUCTION_ISSUE",
                direction="OUT",
                amount=allocated,
                applied_cost=material.applied_unit_cost,
                source_type="PRODUCTION_RUN",
                source_id=production_run.production_run_id,
                source_line_id=material.production_material_id,
                actor=supervisor,
            )

            context.post_movement(
                item_key=item_key,
                batch=batch,
                movement_type="PRODUCTION_ISSUE",
                direction="IN",
                amount=allocated,
                applied_cost=material.applied_unit_cost,
                source_type="PRODUCTION_RUN",
                source_id=production_run.production_run_id,
                source_line_id=material.production_material_id,
                actor=supervisor,
                location="PRODUCTION_HELD",
            )

            material.actual_quantity = allocated_consumption
            material.wasted_quantity = allocated_waste
            material.returned_quantity = allocated_return

            if allocated_consumption > 0:
                context.post_movement(
                    item_key=item_key,
                    batch=batch,
                    movement_type="PRODUCTION_CONSUMPTION",
                    direction="OUT",
                    amount=allocated_consumption,
                    applied_cost=material.applied_unit_cost,
                    source_type="PRODUCTION_RUN",
                    source_id=production_run.production_run_id,
                    source_line_id=material.production_material_id,
                    actor=supervisor,
                    location="PRODUCTION_HELD",
                )

            if allocated_waste > 0:
                context.post_movement(
                    item_key=item_key,
                    batch=batch,
                    movement_type="PRODUCTION_WASTAGE",
                    direction="OUT",
                    amount=allocated_waste,
                    applied_cost=material.applied_unit_cost,
                    source_type="PRODUCTION_RUN",
                    source_id=production_run.production_run_id,
                    source_line_id=material.production_material_id,
                    actor=supervisor,
                    location="PRODUCTION_HELD",
                )

            if allocated_return > 0:
                context.post_movement(
                    item_key=item_key,
                    batch=batch,
                    movement_type="UNUSED_MATERIAL_RETURN",
                    direction="OUT",
                    amount=allocated_return,
                    applied_cost=material.applied_unit_cost,
                    source_type="PRODUCTION_RUN",
                    source_id=production_run.production_run_id,
                    source_line_id=material.production_material_id,
                    actor=supervisor,
                    location="PRODUCTION_HELD",
                )

                context.post_movement(
                    item_key=item_key,
                    batch=batch,
                    movement_type="UNUSED_MATERIAL_RETURN",
                    direction="IN",
                    amount=allocated_return,
                    applied_cost=material.applied_unit_cost,
                    source_type="PRODUCTION_RUN",
                    source_id=production_run.production_run_id,
                    source_line_id=material.production_material_id,
                    actor=supervisor,
                )

            context.session.flush()


def calculate_production_costs(
    context: BenchmarkContext,
    production_run: ProductionRun,
) -> tuple[Decimal, Decimal, Decimal]:
    material_cost = Decimal("0")
    packaging_cost = Decimal("0")

    materials = context.session.scalars(
        select(ProductionMaterial).where(
            ProductionMaterial.production_run_id
            == production_run.production_run_id
        )
    ).all()

    for material in materials:
        item = context.session.get(
            InventoryItem,
            material.item_id,
        )

        consumed_value = (
            material.actual_quantity + material.wasted_quantity
        ) * material.applied_unit_cost

        if item.item_type == "PACKAGING_MATERIAL":
            packaging_cost += consumed_value
        else:
            material_cost += consumed_value

    expenses = context.session.scalars(
        select(ProductionExpense).where(
            ProductionExpense.production_run_id
            == production_run.production_run_id
        )
    ).all()

    overhead_cost = sum(
        (expense.amount for expense in expenses),
        Decimal("0"),
    )

    return (
        money(material_cost),
        money(packaging_cost),
        money(overhead_cost),
    )


def recalculate_cost_summary(
    context: BenchmarkContext,
    production_run: ProductionRun,
) -> ProductionCostSummary:
    if production_run.good_output <= 0:
        raise ValueError(
            "Cannot calculate cost per packet with zero good output."
        )

    material_cost, packaging_cost, overhead_cost = (
        calculate_production_costs(context, production_run)
    )

    total_cost = money(
        material_cost + packaging_cost + overhead_cost
    )

    calculated_unit_cost = unit_cost(
        total_cost / production_run.good_output
    )

    summary = context.session.scalar(
        select(ProductionCostSummary).where(
            ProductionCostSummary.production_run_id
            == production_run.production_run_id
        )
    )

    if summary is None:
        summary = ProductionCostSummary(
            cost_summary_id=fixture_uuid(
                "production_cost_summary",
                str(production_run.production_run_id),
            ),
            production_run_id=production_run.production_run_id,
            good_output=production_run.good_output,
        )

        context.session.add(summary)

    summary.material_cost = material_cost
    summary.packaging_cost = packaging_cost
    summary.overhead_cost = overhead_cost
    summary.total_cost = total_cost
    summary.good_output = production_run.good_output
    summary.cost_per_unit = calculated_unit_cost
    summary.calculated_at = utc_now()

    context.session.flush()
    return summary


def complete_production(
    context: BenchmarkContext,
    step: dict[str, Any],
) -> None:
    production_run = context.production_runs[
        step["production_run_key"]
    ]

    output = step["output"]
    good_quantity = quantity(output["good_quantity"])
    rejected_quantity = quantity(output["rejected_quantity"])

    production_run.good_output = good_quantity
    production_run.rejected_output = rejected_quantity
    production_run.actual_output = quantity(
        good_quantity + rejected_quantity
    )
    production_run.completion_time = context.transaction_time
    production_run.status = "COMPLETED"

    context.session.flush()

    cost_summary = recalculate_cost_summary(
        context,
        production_run,
    )

    product_key = output["product_key"]
    batch_key = f"production:{production_run.production_run_id}"

    batch = context.add(
        StockBatch(
            batch_id=fixture_uuid("stock_batch", batch_key),
            item_id=context.items[product_key].item_id,
            batch_number=f"{BENCHMARK_PREFIX}-FG-001",
            source_type="PRODUCTION_RUN",
            source_id=production_run.production_run_id,
            initial_quantity=good_quantity,
            quantity_remaining=quantity("0"),
            unit_cost=cost_summary.cost_per_unit,
            manufacturing_date=context.transaction_date,
        )
    )

    context.batches[batch_key] = batch

    output_record = context.add(
        ProductionOutput(
            output_id=fixture_uuid(
                "production_output",
                batch_key,
            ),
            production_run_id=production_run.production_run_id,
            product_id=context.products[product_key].product_id,
            batch_id=batch.batch_id,
            good_quantity=good_quantity,
            rejected_quantity=rejected_quantity,
            unit=output["unit"],
        )
    )

    context.post_movement(
        item_key=product_key,
        batch=batch,
        movement_type="PRODUCTION_OUTPUT",
        direction="IN",
        amount=good_quantity,
        applied_cost=cost_summary.cost_per_unit,
        source_type="PRODUCTION_RUN",
        source_id=production_run.production_run_id,
        source_line_id=output_record.output_id,
        actor=context.users["factory_admin"],
    )
    context.audit(
        actor=context.users["factory_admin"],
        entity_type="ProductionRun",
        entity_id=production_run.production_run_id,
        action="PRODUCTION_RUN_COMPLETED",
        new_values={"status": production_run.status, "good_output": good_quantity, "rejected_output": rejected_quantity, "cost_per_unit": cost_summary.cost_per_unit},
    )


def create_sales_order(
    context: BenchmarkContext,
    step: dict[str, Any],
) -> SalesOrder:
    key = step["fixture_key"]
    customer = context.customers[step["customer_key"]]
    salesman = context.users[step["salesman_key"]]

    subtotal = Decimal("0")
    tax_total = Decimal("0")

    prepared_items: list[dict[str, Any]] = []

    for line_number, definition in enumerate(
        step["items"],
        start=1,
    ):
        ordered_quantity = quantity(definition["quantity"])
        price = money(definition["unit_price"])
        rate = percent(definition["gst_rate_percent"])

        line_subtotal = money(ordered_quantity * price)
        line_tax = money(line_subtotal * rate / Decimal("100"))

        subtotal += line_subtotal
        tax_total += line_tax

        prepared_items.append(
            {
                "line_number": line_number,
                "definition": definition,
                "quantity": ordered_quantity,
                "price": price,
                "rate": rate,
                "subtotal": line_subtotal,
                "tax": line_tax,
            }
        )

    order = context.add(
        SalesOrder(
            sales_order_id=fixture_uuid("sales_order", key),
            order_number=f"{BENCHMARK_PREFIX}-SO-{len(context.orders) + 1:03d}",
            customer_id=customer.customer_id,
            salesman_id=salesman.user_id,
            order_date=context.transaction_date,
            required_date=context.transaction_date,
            approval_status="SUBMITTED",
            fulfillment_status="NOT_DISPATCHED",
            subtotal=money(subtotal),
            tax_total=money(tax_total),
            grand_total=money(subtotal + tax_total),
        )
    )

    context.orders[key] = order

    for prepared in prepared_items:
        definition = prepared["definition"]
        product_key = definition["product_key"]

        context.add(
            SalesOrderItem(
                sales_order_item_id=fixture_uuid(
                    "sales_order_item",
                    f"{key}:{prepared['line_number']}",
                ),
                sales_order_id=order.sales_order_id,
                line_number=prepared["line_number"],
                product_id=context.products[product_key].product_id,
                quantity=prepared["quantity"],
                unit_price=prepared["price"],
                tax_rate=prepared["rate"],
                line_subtotal=prepared["subtotal"],
                tax_amount=prepared["tax"],
                line_total=money(
                    prepared["subtotal"] + prepared["tax"]
                ),
            )
        )

    context.audit(
        actor=salesman,
        entity_type="SalesOrder",
        entity_id=order.sales_order_id,
        action="SALES_ORDER_SUBMITTED",
        new_values={"order_number": order.order_number, "approval_status": order.approval_status, "grand_total": order.grand_total},
    )

    return order


def approve_invoice_and_dispatch(
    context: BenchmarkContext,
    step: dict[str, Any],
) -> None:
    order = context.orders[step["sales_order_key"]]
    approver = context.users[step["approver_key"]]

    previous_status = order.approval_status
    order.approval_status = "APPROVED"

    context.add(
        OrderApprovalHistory(
            approval_history_id=fixture_uuid(
                "approval",
                str(order.sales_order_id),
            ),
            sales_order_id=order.sales_order_id,
            previous_status=previous_status,
            new_status="APPROVED",
            decided_by=approver.user_id,
            decided_at=context.transaction_time,
        )
    )
    context.audit(
        actor=approver,
        entity_type="SalesOrder",
        entity_id=order.sales_order_id,
        action="SALES_ORDER_APPROVED",
        new_values={"approval_status": order.approval_status},
    )

    invoice_definition = step["invoice"]
    customer = context.session.get(
        Customer,
        order.customer_id,
    )

    if customer.state != invoice_definition["place_of_supply_state"]:
        raise ValueError(
            "The benchmark's Retailer A invoice must use "
            "intra-state GST."
        )

    invoice = context.add(
        Invoice(
            invoice_id=fixture_uuid(
                "invoice",
                invoice_definition["fixture_key"],
            ),
            order_id=order.sales_order_id,
            customer_id=order.customer_id,
            invoice_number=f"{BENCHMARK_PREFIX}-INV-001",
            financial_year=(
                f"{context.transaction_date.year}-"
                f"{context.transaction_date.year + 1}"
            ),
            invoice_date=context.transaction_date,
            invoice_type=invoice_definition["invoice_type"],
            place_of_supply_state=invoice_definition[
                "place_of_supply_state"
            ],
            taxable_amount=order.subtotal,
            cgst_amount=money(order.tax_total / 2),
            sgst_amount=money(order.tax_total / 2),
            igst_amount=money("0"),
            total_amount=order.grand_total,
            due_date=context.transaction_date + timedelta(days=30),
            status="POSTED",
            posted_at=context.transaction_time,
        )
    )

    context.invoices[invoice_definition["fixture_key"]] = invoice
    context.audit(
        actor=approver,
        entity_type="Invoice",
        entity_id=invoice.invoice_id,
        action="INVOICE_POSTED",
        new_values={"invoice_number": invoice.invoice_number, "status": invoice.status, "total_amount": invoice.total_amount},
    )

    order_items = context.session.scalars(
        select(SalesOrderItem)
        .where(SalesOrderItem.sales_order_id == order.sales_order_id)
        .order_by(SalesOrderItem.line_number)
    ).all()

    invoice_items: list[InvoiceItem] = []

    for order_item in order_items:
        product = context.session.get(
            Product,
            order_item.product_id,
        )

        invoice_items.append(
            context.add(
                InvoiceItem(
                    invoice_item_id=fixture_uuid(
                        "invoice_item",
                        str(order_item.sales_order_item_id),
                    ),
                    invoice_id=invoice.invoice_id,
                    line_number=order_item.line_number,
                    order_item_id=order_item.sales_order_item_id,
                    product_id=order_item.product_id,
                    hsn_code=product.hsn_code,
                    quantity=order_item.quantity,
                    unit_price=order_item.unit_price,
                    discount=money("0"),
                    tax_rate=order_item.tax_rate,
                    taxable_amount=order_item.line_subtotal,
                    tax_amount=order_item.tax_amount,
                    line_total=order_item.line_total,
                )
            )
        )

    dispatch_definition = step["dispatch"]
    product_key = dispatch_definition["product_key"]
    dispatch_quantity = quantity(
        dispatch_definition["quantity"]
    )

    dispatch = context.add(
        Dispatch(
            dispatch_id=fixture_uuid(
                "dispatch",
                dispatch_definition["fixture_key"],
            ),
            invoice_id=invoice.invoice_id,
            dispatch_number=f"{BENCHMARK_PREFIX}-DISP-001",
            dispatch_date=context.transaction_date,
            status="POSTED",
            posted_at=context.transaction_time,
        )
    )

    matching_invoice_items = [
        item
        for item in invoice_items
        if item.product_id == context.products[product_key].product_id
    ]

    if len(matching_invoice_items) != 1:
        raise ValueError(
            "Expected exactly one matching benchmark invoice line."
        )

    invoice_item = matching_invoice_items[0]

    if dispatch_quantity > invoice_item.quantity:
        raise ValueError(
            "Dispatch quantity exceeds the invoiced quantity."
        )

    allocations = allocate_from_batches(
        context,
        product_key,
        dispatch_quantity,
    )

    for batch, allocated in allocations:
        dispatch_item = context.add(
            DispatchItem(
                dispatch_item_id=fixture_uuid(
                    "dispatch_item",
                    f"{dispatch.dispatch_id}:{batch.batch_id}",
                ),
                dispatch_id=dispatch.dispatch_id,
                invoice_item_id=invoice_item.invoice_item_id,
                product_id=invoice_item.product_id,
                batch_id=batch.batch_id,
                quantity=allocated,
            )
        )

        context.post_movement(
            item_key=product_key,
            batch=batch,
            movement_type="DISPATCH",
            direction="OUT",
            amount=allocated,
            applied_cost=batch.unit_cost,
            source_type="DISPATCH",
            source_id=dispatch.dispatch_id,
            source_line_id=dispatch_item.dispatch_item_id,
            actor=approver,
        )

    order.fulfillment_status = (
        "DISPATCHED"
        if dispatch_quantity == invoice_item.quantity
        else "PARTIALLY_DISPATCHED"
    )

    context.session.flush()
    context.audit(
        actor=approver,
        entity_type="Dispatch",
        entity_id=dispatch.dispatch_id,
        action="DISPATCH_POSTED",
        new_values={"dispatch_number": dispatch.dispatch_number, "status": dispatch.status, "quantity": dispatch_quantity},
    )


def validate_distributor_shortage(
    context: BenchmarkContext,
    step: dict[str, Any],
) -> None:
    order = create_sales_order(context, step)

    if len(step["items"]) != 1:
        raise ValueError(
            "Benchmark distributor stock check expects one product."
        )

    definition = step["items"][0]
    product_key = definition["product_key"]

    requested = quantity(definition["quantity"])
    available = context.get_balance(
        product_key
    ).quantity_on_hand

    if requested <= available:
        raise ValueError(
            "The benchmark distributor order must demonstrate "
            "an insufficient-stock condition."
        )

    # The order remains submitted. No invalid dispatch is created.
    order.fulfillment_status = "NOT_DISPATCHED"


def record_payment(
    context: BenchmarkContext,
    step: dict[str, Any],
) -> None:
    invoice = context.invoices[step["invoice_key"]]
    customer = context.customers[step["customer_key"]]
    amount = money(step["amount"])

    if invoice.customer_id != customer.customer_id:
        raise ValueError(
            "Payment customer does not match invoice customer."
        )

    if amount > invoice.total_amount:
        raise ValueError(
            "Payment exceeds the benchmark invoice amount."
        )

    payment = context.add(
        Payment(
            payment_id=fixture_uuid(
                "payment",
                step["fixture_key"],
            ),
            customer_id=customer.customer_id,
            payment_date=context.transaction_date,
            amount=amount,
            payment_method="BANK_TRANSFER",
            reference_number=f"{BENCHMARK_PREFIX}-PAY-001",
            recorded_by=context.users["factory_admin"].user_id,
            status="POSTED",
            posted_at=context.transaction_time,
        )
    )

    context.add(
        PaymentAllocation(
            allocation_id=fixture_uuid(
                "payment_allocation",
                f"{payment.payment_id}:{invoice.invoice_id}",
            ),
            payment_id=payment.payment_id,
            invoice_id=invoice.invoice_id,
            allocated_amount=amount,
        )
    )
    context.audit(
        actor=context.users["factory_admin"],
        entity_type="Payment",
        entity_id=payment.payment_id,
        action="PAYMENT_POSTED",
        new_values={"amount": payment.amount, "status": payment.status, "customer_id": payment.customer_id},
    )


def record_late_production_expenses(
    context: BenchmarkContext,
    step: dict[str, Any],
) -> None:
    production_run = context.production_runs[
        step["production_run_key"]
    ]

    if production_run.status != "COMPLETED":
        raise ValueError(
            "Late production expenses require a completed run."
        )

    for definition in step["expenses"]:
        category = definition["expense_category"]

        context.add(
            ProductionExpense(
                expense_id=fixture_uuid(
                    "production_expense",
                    f"{production_run.production_run_id}:{category}",
                ),
                production_run_id=production_run.production_run_id,
                expense_category=category,
                amount=money(definition["amount"]),
                expense_date=context.transaction_date,
                recorded_by=context.users["factory_admin"].user_id,
            )
        )
        context.audit(
            actor=context.users["factory_admin"],
            entity_type="ProductionExpense",
            entity_id=fixture_uuid("production_expense", f"{production_run.production_run_id}:{category}"),
            action="PRODUCTION_EXPENSE_RECORDED",
            new_values={"production_run_id": production_run.production_run_id, "expense_category": category, "amount": money(definition["amount"])},
        )

    # Recalculate the costing summary only.
    # Do not create another finished-goods stock movement.
    recalculate_cost_summary(
        context,
        production_run,
    )


def verify_benchmark(
    context: BenchmarkContext,
) -> None:
    """
    Verify persisted calculations against fixture expectations.

    These assertions do not populate results. All actual values
    are derived from the records created in this transaction.
    """

    expected = context.fixture["expected_results"]

    for definition in expected["stock_balances"]:
        actual = context.get_balance(
            definition["item_key"]
        ).quantity_on_hand

        target = quantity(definition["quantity"])

        if actual != target:
            raise ValueError(
                f"Stock mismatch for {definition['item_key']}: "
                f"actual={actual}, expected={target}."
            )

    finished_goods = expected["finished_goods"]
    product_key = finished_goods["product_key"]

    final_stock = context.get_balance(
        product_key
    ).quantity_on_hand

    if final_stock != quantity(
        finished_goods["after_retailer_a_dispatch"]
    ):
        raise ValueError(
            "Final finished-goods stock does not match the benchmark."
        )

    invoice = context.invoices["retailer_a_invoice"]
    expected_invoice = expected["retailer_a_invoice"]

    for field in (
        "taxable_amount",
        "cgst_amount",
        "sgst_amount",
        "igst_amount",
        "total_amount",
    ):
        actual = getattr(invoice, field)
        target = money(expected_invoice[field])

        if actual != target:
            raise ValueError(
                f"Invoice {field} mismatch: "
                f"actual={actual}, expected={target}."
            )

    allocations = context.session.scalars(
        select(PaymentAllocation).where(
            PaymentAllocation.invoice_id == invoice.invoice_id
        )
    ).all()

    allocated = sum(
        (allocation.allocated_amount for allocation in allocations),
        Decimal("0"),
    )

    outstanding = money(invoice.total_amount - allocated)

    if outstanding != money(
        expected_invoice["outstanding_amount"]
    ):
        raise ValueError(
            "Benchmark outstanding receivable does not reconcile."
        )

    production_run = context.production_runs[
        "murukku_production_run"
    ]

    summary = context.session.scalar(
        select(ProductionCostSummary).where(
            ProductionCostSummary.production_run_id
            == production_run.production_run_id
        )
    )

    if summary is None:
        raise ValueError("Production cost summary is missing.")

    expected_costing = expected["production_costing"]

    for field in (
        "material_cost",
        "packaging_cost",
        "overhead_cost",
        "total_cost",
    ):
        actual = getattr(summary, field)
        fixture_field = (
            "total_production_cost"
            if field == "total_cost"
            else field
        )
        target = money(expected_costing[fixture_field])

        if actual != target:
            raise ValueError(
                f"Production {field} mismatch: "
                f"actual={actual}, expected={target}."
            )

    if money(summary.cost_per_unit) != money(
        expected_costing["cost_per_good_packet_rounded"]
    ):
        raise ValueError(
            "Production cost per good packet does not match "
            "the benchmark."
        )

    flour_average = context.get_balance(
        "flour"
    ).average_unit_cost

    if flour_average != unit_cost(
        expected_costing["flour_weighted_average_unit_cost"]
    ):
        raise ValueError(
            "Flour weighted-average valuation does not match "
            "the benchmark."
        )

    distributor_order = context.orders["distributor_b_order"]

    if distributor_order.fulfillment_status != "NOT_DISPATCHED":
        raise ValueError(
            "Insufficient-stock distributor order was dispatched."
        )

    context.session.flush()


def seed_benchmark(
    fixture: dict[str, Any],
    opening_fg_unit_cost: Decimal,
) -> bool:
    """
    Execute the benchmark in a single database transaction.

    The transaction is rolled back on any failed validation.
    No application-level benchmark values are hardcoded as
    database outputs.
    """

    transaction_time = utc_now()
    transaction_date = transaction_time.date()
    already_seeded = False

    with SessionLocal.begin() as session:
        context = BenchmarkContext(
            fixture=fixture,
            session=session,
            transaction_date=transaction_date,
            transaction_time=transaction_time,
            opening_fg_unit_cost=opening_fg_unit_cost,
        )

        if benchmark_namespace_exists(session):
            load_existing_benchmark(context)
            already_seeded = True
        else:
            load_users(context)
            seed_unit_conversions(context)
            seed_customers_and_suppliers(context)
            seed_inventory_master_data(context)
            seed_opening_stock(context)
            seed_bom(context)

            steps = context.fixture["benchmark_steps"]

            purchase_and_receive(context, steps[0])
            start_production(context, steps[1])
            complete_production(context, steps[2])
            create_sales_order(context, steps[3])
            approve_invoice_and_dispatch(context, steps[4])
            validate_distributor_shortage(context, steps[5])
            record_payment(context, steps[6])
            record_late_production_expenses(context, steps[7])

            # Reports use the recorded transactions through the report API.
            if steps[8]["operation"] != "GENERATE_MONTHLY_REPORTS":
                raise ValueError("Missing benchmark reporting step.")

            verify_benchmark(context)

    return already_seeded


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Seed and validate the mandatory Winter Internship "
            "2026 food manufacturing benchmark."
        )
    )

    parser.add_argument(
        "--apply",
        action="store_true",
        help="Explicitly authorize benchmark database changes.",
    )

    args = parser.parse_args()

    if not args.apply:
        parser.error(
            "No database changes were made. "
            "Pass --apply to execute the benchmark seed."
        )

    environment = str(settings.ENVIRONMENT).strip().lower()

    if environment == "production":
        parser.error(
            "Benchmark seeding is prohibited in production."
        )

    try:
        fixture = load_fixture()
        opening_cost = require_opening_finished_goods_cost()

        already_seeded = seed_benchmark(
            fixture=fixture,
            opening_fg_unit_cost=opening_cost,
        )

    except (
        ValueError,
        FileNotFoundError,
        KeyError,
        TypeError,
    ) as exc:
        print(
            f"Benchmark seed failed: {exc}",
            file=sys.stderr,
        )
        return 1

    except Exception:
        print(
            "Benchmark seed failed. "
            "The database transaction was rolled back.",
            file=sys.stderr,
        )
        raise

    if already_seeded:
        print("Existing benchmark records verified; no data was changed.")
    else:
        print(
            "Benchmark seed transaction committed. "
            "The recorded values passed the fixture checks. "
            "API, authorization, and reporting checks must be run separately."
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
