"""
Production-run management and inventory posting.

Production inventory follows a two-location model:

1. Material issue transfers stock from WAREHOUSE to PRODUCTION_HELD.
2. Consumption and wastage reduce PRODUCTION_HELD inventory.
3. Unused returns transfer stock back to WAREHOUSE.
4. Accepted finished-goods output increases WAREHOUSE inventory.

Every inventory operation creates traceable stock movements.
Completed runs cannot be posted again.

The caller owns the database transaction. This service never commits.
"""

from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from uuid import UUID, uuid4

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.models.bom import ProductBOM
from app.models.inventory import InventoryBalance, StockBatch
from app.models.product import InventoryItem, Product
from app.models.production import (
    ProductionMaterial,
    ProductionOutput,
    ProductionRun,
)
from app.models.user import User
from app.services.audit_service import create_audit_log
from app.services.costing_service import recalculate_production_cost
from app.services.inventory_service import (
    create_stock_batch,
    post_stock_movement,
)


ZERO = Decimal("0")
QUANTITY_QUANTUM = Decimal("0.001")
UNIT_COST_QUANTUM = Decimal("0.000001")

PRODUCTION_SUPERVISOR = "Production Supervisor"
FACTORY_ADMIN = "Factory Admin"

PRODUCTION_ROLES = frozenset(
    {PRODUCTION_SUPERVISOR, FACTORY_ADMIN}
)


def _error(code: int, message: str) -> HTTPException:
    return HTTPException(status_code=code, detail=message)


def _decimal(value: object, field: str) -> Decimal:
    if isinstance(value, (bool, float)):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"{field} must use exact decimal arithmetic.",
        )

    try:
        result = Decimal(value)
    except (InvalidOperation, TypeError, ValueError):
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


def _quantity(
    value: object,
    field: str,
    *,
    allow_zero: bool = False,
) -> Decimal:
    result = _decimal(value, field)

    if (
        result < ZERO
        or (not allow_zero and result == ZERO)
        or result != result.quantize(QUANTITY_QUANTUM)
    ):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"{field} must be "
            + ("nonnegative" if allow_zero else "positive")
            + " with at most three decimal places.",
        )

    return result


def _round_quantity(value: Decimal) -> Decimal:
    return value.quantize(
        QUANTITY_QUANTUM,
        rounding=ROUND_HALF_UP,
    )


def _round_unit_cost(value: Decimal) -> Decimal:
    return value.quantize(
        UNIT_COST_QUANTUM,
        rounding=ROUND_HALF_UP,
    )


def _actor(db: Session, actor_id: UUID) -> tuple[User, str]:
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

    return user, role.role_name


def _require_production_actor(
    db: Session,
    actor_id: UUID,
) -> User:
    user, role = _actor(db, actor_id)

    if role not in PRODUCTION_ROLES:
        raise _error(
            status.HTTP_403_FORBIDDEN,
            "Production-operation authorization is required.",
        )

    return user


def _run(
    db: Session,
    production_run_id: UUID,
    *,
    lock: bool = False,
) -> ProductionRun:
    statement = (
        select(ProductionRun)
        .where(
            ProductionRun.production_run_id == production_run_id
        )
        .options(
            selectinload(ProductionRun.materials),
            selectinload(ProductionRun.outputs),
        )
    )

    if lock:
        statement = statement.with_for_update(of=ProductionRun)

    run = db.scalar(statement)

    if run is None:
        raise _error(
            status.HTTP_404_NOT_FOUND,
            "Production run not found.",
        )

    return run


def _require_editable(run: ProductionRun) -> None:
    if run.status not in {"DRAFT", "IN_PROGRESS"}:
        raise _error(
            status.HTTP_409_CONFLICT,
            "Completed or cancelled production runs cannot be modified.",
        )


def _require_supervisor_access(
    db: Session,
    *,
    run: ProductionRun,
    actor_id: UUID,
) -> None:
    _, role = _actor(db, actor_id)

    if role not in PRODUCTION_ROLES:
        raise _error(
            status.HTTP_403_FORBIDDEN,
            "Production-operation authorization is required.",
        )

    if (
        role == PRODUCTION_SUPERVISOR
        and run.supervisor_id != actor_id
    ):
        raise _error(
            status.HTTP_403_FORBIDDEN,
            "This production run belongs to another supervisor.",
        )


def _material(
    db: Session,
    *,
    production_run_id: UUID,
    production_material_id: UUID,
    lock: bool = False,
) -> ProductionMaterial:
    statement = select(ProductionMaterial).where(
        ProductionMaterial.production_material_id
        == production_material_id,
        ProductionMaterial.production_run_id
        == production_run_id,
    )

    if lock:
        statement = statement.with_for_update(
            of=ProductionMaterial
        )

    material = db.scalar(statement)

    if material is None:
        raise _error(
            status.HTTP_404_NOT_FOUND,
            "Production material allocation not found.",
        )

    return material


def _audit(
    db: Session,
    *,
    actor_id: UUID,
    run_id: UUID,
    action: str,
    old_values: dict[str, object] | None = None,
    new_values: dict[str, object] | None = None,
) -> None:
    create_audit_log(
        db,
        user_id=actor_id,
        entity_type="ProductionRun",
        entity_id=run_id,
        action=action,
        old_values=old_values,
        new_values=new_values,
    )


def _active_bom(
    db: Session,
    *,
    product_id: UUID,
    bom_id: UUID,
    production_date: date,
) -> ProductBOM:
    bom = db.scalar(
        select(ProductBOM)
        .where(ProductBOM.bom_id == bom_id)
        .options(selectinload(ProductBOM.items))
    )

    if bom is None or bom.product_id != product_id:
        raise _error(
            status.HTTP_404_NOT_FOUND,
            "BOM not found for the selected product.",
        )

    if (
        not bom.is_active
        or bom.effective_from > production_date
        or (
            bom.effective_to is not None
            and bom.effective_to < production_date
        )
    ):
        raise _error(
            status.HTTP_409_CONFLICT,
            "The selected BOM version is not effective "
            "for the production date.",
        )

    if not bom.items:
        raise _error(
            status.HTTP_409_CONFLICT,
            "The selected BOM contains no material requirements.",
        )

    return bom


def calculate_planned_materials(
    db: Session,
    *,
    bom_id: UUID,
    planned_output: Decimal,
) -> list[dict[str, object]]:
    """
    Scale BOM quantities by planned output / expected BOM output.

    BOM material quantities must already use their approved
    inventory units. Quantity rounding follows the database's
    three-decimal precision.
    """

    planned = _quantity(planned_output, "planned_output")

    bom = db.scalar(
        select(ProductBOM)
        .where(ProductBOM.bom_id == bom_id)
        .options(selectinload(ProductBOM.items))
    )

    if bom is None:
        raise _error(
            status.HTTP_404_NOT_FOUND,
            "BOM not found.",
        )

    expected = Decimal(bom.expected_output)

    if expected <= ZERO:
        raise _error(
            status.HTTP_409_CONFLICT,
            "BOM expected output must be positive.",
        )

    multiplier = planned / expected

    return [
        {
            "bom_item_id": line.bom_item_id,
            "item_id": line.item_id,
            "unit": line.unit,
            "planned_quantity": _round_quantity(
                Decimal(line.quantity_required) * multiplier
            ),
        }
        for line in bom.items
    ]


def create_production_run(
    db: Session,
    *,
    actor_id: UUID,
    product_id: UUID,
    bom_id: UUID,
    planned_output: Decimal,
    production_date: date,
    production_number: str | None = None,
) -> ProductionRun:
    """Create a draft run with a fixed BOM version."""

    _require_production_actor(db, actor_id)

    planned = _quantity(planned_output, "planned_output")

    product = db.get(Product, product_id)
    item = db.get(InventoryItem, product_id)

    if (
        product is None
        or item is None
        or not item.is_active
        or item.item_type != "FINISHED_PRODUCT"
    ):
        raise _error(
            status.HTTP_409_CONFLICT,
            "An active finished product is required.",
        )

    _active_bom(
        db,
        product_id=product_id,
        bom_id=bom_id,
        production_date=production_date,
    )

    if production_number is None:
        number = f"PR-{uuid4().hex.upper()}"
    else:
        if not isinstance(production_number, str):
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Production number must be a string.",
            )

        number = production_number.strip()

        if not 1 <= len(number) <= 100:
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Production number must contain 1 to 100 characters.",
            )

    if db.scalar(
        select(ProductionRun.production_run_id).where(
            ProductionRun.production_number == number
        )
    ) is not None:
        raise _error(
            status.HTTP_409_CONFLICT,
            "Production number already exists.",
        )

    run = ProductionRun(
        production_number=number,
        product_id=product_id,
        bom_id=bom_id,
        supervisor_id=actor_id,
        planned_output=planned,
        actual_output=ZERO,
        good_output=ZERO,
        rejected_output=ZERO,
        status="DRAFT",
    )

    db.add(run)
    db.flush()

    _audit(
        db,
        actor_id=actor_id,
        run_id=run.production_run_id,
        action="PRODUCTION_RUN_CREATED",
        new_values={
            "production_number": number,
            "product_id": str(product_id),
            "bom_id": str(bom_id),
            "planned_output": str(planned),
            "status": "DRAFT",
        },
    )

    return run


def get_production_run(
    db: Session,
    *,
    production_run_id: UUID,
    actor_id: UUID,
) -> ProductionRun:
    """Retrieve a production run subject to role-based access."""

    run = _run(db, production_run_id)
    _, role = _actor(db, actor_id)

    if role == "Salesman":
        raise _error(
            status.HTTP_403_FORBIDDEN,
            "Production records are not available to Salesmen.",
        )

    if (
        role == PRODUCTION_SUPERVISOR
        and run.supervisor_id != actor_id
    ):
        raise _error(
            status.HTTP_403_FORBIDDEN,
            "This production run belongs to another supervisor.",
        )

    return run


def list_production_runs(
    db: Session,
    *,
    actor_id: UUID,
    run_status: str | None = None,
    product_id: UUID | None = None,
    page: int = 1,
    page_size: int = 50,
) -> tuple[list[ProductionRun], int]:
    """Return authorized production runs with pagination."""

    _, role = _actor(db, actor_id)

    if role == "Salesman":
        raise _error(
            status.HTTP_403_FORBIDDEN,
            "Production records are not available to Salesmen.",
        )

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

    if role == PRODUCTION_SUPERVISOR:
        filters.append(
            ProductionRun.supervisor_id == actor_id
        )

    if product_id is not None:
        filters.append(
            ProductionRun.product_id == product_id
        )

    if run_status is not None:
        if run_status not in {
            "DRAFT",
            "IN_PROGRESS",
            "COMPLETED",
            "CANCELLED",
        }:
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Invalid production-run status.",
            )

        filters.append(
            ProductionRun.status == run_status
        )

    total = db.scalar(
        select(func.count())
        .select_from(ProductionRun)
        .where(*filters)
    ) or 0

    runs = list(
        db.scalars(
            select(ProductionRun)
            .where(*filters)
            .order_by(
                ProductionRun.production_number.desc(),
                ProductionRun.production_run_id.desc(),
            )
            .offset((page - 1) * page_size)
            .limit(page_size)
        ).all()
    )

    return runs, total


def start_production_run(
    db: Session,
    *,
    production_run_id: UUID,
    actor_id: UUID,
) -> ProductionRun:
    """Start a draft production run."""

    _require_production_actor(db, actor_id)
    run = _run(db, production_run_id, lock=True)

    _require_supervisor_access(
        db,
        run=run,
        actor_id=actor_id,
    )

    if run.status == "IN_PROGRESS":
        return run

    if run.status != "DRAFT":
        raise _error(
            status.HTTP_409_CONFLICT,
            "Only draft production runs may be started.",
        )

    run.status = "IN_PROGRESS"
    run.start_time = datetime.now(timezone.utc)

    _audit(
        db,
        actor_id=actor_id,
        run_id=run.production_run_id,
        action="PRODUCTION_RUN_STARTED",
        old_values={"status": "DRAFT"},
        new_values={
            "status": "IN_PROGRESS",
            "start_time": run.start_time.isoformat(),
        },
    )

    db.flush()
    return run


def issue_production_material(
    db: Session,
    *,
    production_run_id: UUID,
    actor_id: UUID,
    item_id: UUID,
    batch_id: UUID,
    quantity: Decimal,
) -> ProductionMaterial:
    """
    Transfer batch-tracked material from warehouse to production.

    The production-held movement does not carry a warehouse batch
    identifier because the inventory service tracks batch quantities
    at the warehouse location. The ProductionMaterial record retains
    the source batch for traceability and subsequent returns.
    """

    _require_production_actor(db, actor_id)
    run = _run(db, production_run_id, lock=True)

    _require_supervisor_access(
        db,
        run=run,
        actor_id=actor_id,
    )

    if run.status != "IN_PROGRESS":
        raise _error(
            status.HTTP_409_CONFLICT,
            "Materials may be issued only to an in-progress run.",
        )

    issued_quantity = _quantity(quantity, "quantity")

    item = db.get(InventoryItem, item_id)

    if (
        item is None
        or not item.is_active
        or item.item_type not in {
            "RAW_MATERIAL",
            "PACKAGING_MATERIAL",
        }
    ):
        raise _error(
            status.HTTP_409_CONFLICT,
            "Production requires an active raw or packaging material.",
        )

    batch = db.scalar(
        select(StockBatch)
        .where(StockBatch.batch_id == batch_id)
        .with_for_update(of=StockBatch)
    )

    if batch is None or batch.item_id != item_id:
        raise _error(
            status.HTTP_409_CONFLICT,
            "The stock batch does not belong to the selected material.",
        )

    if Decimal(batch.quantity_remaining) < issued_quantity:
        raise _error(
            status.HTTP_409_CONFLICT,
            "Insufficient stock in the selected material batch.",
        )

    bom = db.scalar(
        select(ProductBOM)
        .where(ProductBOM.bom_id == run.bom_id)
        .options(selectinload(ProductBOM.items))
    )

    if bom is None:
        raise _error(
            status.HTTP_409_CONFLICT,
            "The production run's BOM is missing.",
        )

    bom_line = next(
        (
            line
            for line in bom.items
            if line.item_id == item_id
        ),
        None,
    )

    if bom_line is None:
        raise _error(
            status.HTTP_409_CONFLICT,
            "The material is not included in the selected BOM.",
        )

    if bom_line.unit != item.base_unit:
        raise _error(
            status.HTTP_409_CONFLICT,
            "The BOM material unit must match the inventory base unit "
            "before material issue.",
        )

    planned_quantity = _round_quantity(
        Decimal(bom_line.quantity_required)
        * Decimal(run.planned_output)
        / Decimal(bom.expected_output)
    )

    material = db.scalar(
        select(ProductionMaterial)
        .where(
            ProductionMaterial.production_run_id
            == production_run_id,
            ProductionMaterial.item_id == item_id,
            ProductionMaterial.batch_id == batch_id,
        )
        .with_for_update(of=ProductionMaterial)
    )

    if material is None:
        material = ProductionMaterial(
            production_run_id=production_run_id,
            item_id=item_id,
            batch_id=batch_id,
            planned_quantity=planned_quantity,
            issued_quantity=ZERO,
            actual_quantity=ZERO,
            wasted_quantity=ZERO,
            returned_quantity=ZERO,
            unit=item.base_unit,
            applied_unit_cost=ZERO,
        )
        db.add(material)
        db.flush()

    balance = db.scalar(
        select(InventoryBalance)
        .where(
            InventoryBalance.item_id == item_id,
            InventoryBalance.location == "WAREHOUSE",
        )
        .with_for_update(of=InventoryBalance)
    )

    if (
        balance is None
        or Decimal(balance.quantity_on_hand) < issued_quantity
    ):
        raise _error(
            status.HTTP_409_CONFLICT,
            "Insufficient warehouse inventory.",
        )

    applied_cost = Decimal(balance.average_unit_cost)

    if Decimal(material.issued_quantity) > ZERO:
        previous_quantity = Decimal(material.issued_quantity)
        previous_cost = Decimal(material.applied_unit_cost)
        applied_cost = _round_unit_cost(
            (
                previous_quantity * previous_cost
                + issued_quantity * applied_cost
            )
            / (previous_quantity + issued_quantity)
        )

    issue_id = uuid4()

    post_stock_movement(
        db,
        item_id=item_id,
        movement_type="PRODUCTION_ISSUE",
        direction="OUT",
        location="WAREHOUSE",
        quantity=issued_quantity,
        source_type="PRODUCTION_MATERIAL_ISSUE",
        source_id=production_run_id,
        source_line_id=issue_id,
        created_by=actor_id,
        batch_id=batch_id,
    )

    post_stock_movement(
        db,
        item_id=item_id,
        movement_type="PRODUCTION_ISSUE",
        direction="IN",
        location="PRODUCTION_HELD",
        quantity=issued_quantity,
        source_type="PRODUCTION_MATERIAL_ISSUE",
        source_id=production_run_id,
        source_line_id=issue_id,
        created_by=actor_id,
        unit_cost=Decimal(balance.average_unit_cost),
    )

    material.issued_quantity = (
        Decimal(material.issued_quantity) + issued_quantity
    )
    material.applied_unit_cost = applied_cost

    _audit(
        db,
        actor_id=actor_id,
        run_id=production_run_id,
        action="PRODUCTION_MATERIAL_ISSUED",
        new_values={
            "production_material_id": str(
                material.production_material_id
            ),
            "item_id": str(item_id),
            "batch_id": str(batch_id),
            "quantity": str(issued_quantity),
            "applied_unit_cost": str(applied_cost),
        },
    )

    db.flush()
    return material


def record_material_consumption(
    db: Session,
    *,
    production_run_id: UUID,
    production_material_id: UUID,
    actor_id: UUID,
    consumed_quantity: Decimal = ZERO,
    wasted_quantity: Decimal = ZERO,
    returned_quantity: Decimal = ZERO,
) -> ProductionMaterial:
    """
    Record actual consumption, wastage, and unused returns.

    Every quantity represents an additional movement, not a
    replacement for previously recorded quantities.
    """

    _require_production_actor(db, actor_id)
    run = _run(db, production_run_id, lock=True)

    _require_supervisor_access(
        db,
        run=run,
        actor_id=actor_id,
    )

    if run.status != "IN_PROGRESS":
        raise _error(
            status.HTTP_409_CONFLICT,
            "Material usage may be recorded only during production.",
        )

    material = _material(
        db,
        production_run_id=production_run_id,
        production_material_id=production_material_id,
        lock=True,
    )

    consumed = _quantity(
        consumed_quantity,
        "consumed_quantity",
        allow_zero=True,
    )
    wasted = _quantity(
        wasted_quantity,
        "wasted_quantity",
        allow_zero=True,
    )
    returned = _quantity(
        returned_quantity,
        "returned_quantity",
        allow_zero=True,
    )

    if consumed + wasted + returned == ZERO:
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "At least one material quantity must be positive.",
        )

    remaining = (
        Decimal(material.issued_quantity)
        - Decimal(material.actual_quantity)
        - Decimal(material.wasted_quantity)
        - Decimal(material.returned_quantity)
    )

    if consumed + wasted + returned > remaining:
        raise _error(
            status.HTTP_409_CONFLICT,
            "Consumption, wastage, and returns exceed "
            "the remaining issued quantity.",
        )

    source_line_id = uuid4()
    unit_cost = Decimal(material.applied_unit_cost)

    if consumed > ZERO:
        post_stock_movement(
            db,
            item_id=material.item_id,
            movement_type="PRODUCTION_CONSUMPTION",
            direction="OUT",
            location="PRODUCTION_HELD",
            quantity=consumed,
            source_type="PRODUCTION_MATERIAL",
            source_id=production_run_id,
            source_line_id=source_line_id,
            created_by=actor_id,
            unit_cost=unit_cost,
        )

    if wasted > ZERO:
        post_stock_movement(
            db,
            item_id=material.item_id,
            movement_type="PRODUCTION_WASTAGE",
            direction="OUT",
            location="PRODUCTION_HELD",
            quantity=wasted,
            source_type="PRODUCTION_MATERIAL",
            source_id=production_run_id,
            source_line_id=source_line_id,
            created_by=actor_id,
            unit_cost=unit_cost,
        )

    if returned > ZERO:
        post_stock_movement(
            db,
            item_id=material.item_id,
            movement_type="UNUSED_MATERIAL_RETURN",
            direction="OUT",
            location="PRODUCTION_HELD",
            quantity=returned,
            source_type="PRODUCTION_MATERIAL",
            source_id=production_run_id,
            source_line_id=source_line_id,
            created_by=actor_id,
            unit_cost=unit_cost,
        )

        post_stock_movement(
            db,
            item_id=material.item_id,
            movement_type="UNUSED_MATERIAL_RETURN",
            direction="IN",
            location="WAREHOUSE",
            quantity=returned,
            source_type="PRODUCTION_MATERIAL",
            source_id=production_run_id,
            source_line_id=source_line_id,
            created_by=actor_id,
            batch_id=material.batch_id,
            unit_cost=unit_cost,
        )

    material.actual_quantity = (
        Decimal(material.actual_quantity) + consumed
    )
    material.wasted_quantity = (
        Decimal(material.wasted_quantity) + wasted
    )
    material.returned_quantity = (
        Decimal(material.returned_quantity) + returned
    )

    _audit(
        db,
        actor_id=actor_id,
        run_id=production_run_id,
        action="PRODUCTION_MATERIAL_USAGE_RECORDED",
        new_values={
            "production_material_id": str(production_material_id),
            "consumed_quantity": str(consumed),
            "wasted_quantity": str(wasted),
            "returned_quantity": str(returned),
        },
    )

    db.flush()
    return material


def complete_production_run(
    db: Session,
    *,
    production_run_id: UUID,
    actor_id: UUID,
    good_output: Decimal,
    rejected_output: Decimal,
    batch_number: str,
    manufacturing_date: date,
    expiry_date: date | None = None,
) -> ProductionRun:
    """
    Complete production and post saleable finished-goods output.

    All issued materials must reconcile before completion.
    Rejected output is recorded but never added to saleable stock.
    """

    _require_production_actor(db, actor_id)
    run = _run(db, production_run_id, lock=True)

    _require_supervisor_access(
        db,
        run=run,
        actor_id=actor_id,
    )

    if run.status == "COMPLETED":
        raise _error(
            status.HTTP_409_CONFLICT,
            "This production run has already been completed.",
        )

    if run.status != "IN_PROGRESS":
        raise _error(
            status.HTTP_409_CONFLICT,
            "Only in-progress production runs may be completed.",
        )

    good = _quantity(good_output, "good_output")
    rejected = _quantity(
        rejected_output,
        "rejected_output",
        allow_zero=True,
    )

    if not isinstance(batch_number, str) or not batch_number.strip():
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "A finished-goods batch number is required.",
        )

    if not run.materials:
        raise _error(
            status.HTTP_409_CONFLICT,
            "Production materials must be issued before completion.",
        )

    for material in run.materials:
        issued = Decimal(material.issued_quantity)
        reconciled = (
            Decimal(material.actual_quantity)
            + Decimal(material.wasted_quantity)
            + Decimal(material.returned_quantity)
        )

        if issued <= ZERO or issued != reconciled:
            raise _error(
                status.HTTP_409_CONFLICT,
                "Every issued material must be fully reconciled "
                "before production completion.",
            )

    if run.outputs:
        raise _error(
            status.HTTP_409_CONFLICT,
            "Production output has already been recorded.",
        )

    run.good_output = good
    run.rejected_output = rejected
    run.actual_output = good + rejected
    run.completion_time = datetime.now(timezone.utc)
    run.status = "COMPLETED"

    db.flush()

    summary = recalculate_production_cost(
        db,
        production_run_id=production_run_id,
        actor_id=actor_id,
    )

    output_cost = Decimal(summary.cost_per_unit)

    batch = create_stock_batch(
        db,
        item_id=run.product_id,
        batch_number=batch_number.strip(),
        source_type="PRODUCTION_RUN",
        source_id=production_run_id,
        quantity=good,
        unit_cost=output_cost,
        manufacturing_date=manufacturing_date,
        expiry_date=expiry_date,
    )

    output = ProductionOutput(
        production_run_id=production_run_id,
        product_id=run.product_id,
        batch_id=batch.batch_id,
        good_quantity=good,
        rejected_quantity=rejected,
        unit=db.get(InventoryItem, run.product_id).base_unit,
    )

    db.add(output)
    db.flush()

    post_stock_movement(
        db,
        item_id=run.product_id,
        movement_type="PRODUCTION_OUTPUT",
        direction="IN",
        location="WAREHOUSE",
        quantity=good,
        source_type="PRODUCTION_RUN",
        source_id=production_run_id,
        source_line_id=output.output_id,
        created_by=actor_id,
        batch_id=batch.batch_id,
        unit_cost=output_cost,
    )

    _audit(
        db,
        actor_id=actor_id,
        run_id=production_run_id,
        action="PRODUCTION_RUN_COMPLETED",
        old_values={"status": "IN_PROGRESS"},
        new_values={
            "status": "COMPLETED",
            "actual_output": str(run.actual_output),
            "good_output": str(good),
            "rejected_output": str(rejected),
            "batch_id": str(batch.batch_id),
            "cost_per_unit": str(output_cost),
        },
    )

    db.flush()
    return run


def cancel_production_run(
    db: Session,
    *,
    production_run_id: UUID,
    actor_id: UUID,
    reason: str,
) -> ProductionRun:
    """
    Cancel a draft or unposted production run.

    Runs with recorded inventory movements require a separate
    authorized reversal process and cannot be cancelled directly.
    """

    _require_production_actor(db, actor_id)
    run = _run(db, production_run_id, lock=True)

    _require_supervisor_access(
        db,
        run=run,
        actor_id=actor_id,
    )

    if run.status == "CANCELLED":
        return run

    if run.status == "COMPLETED":
        raise _error(
            status.HTTP_409_CONFLICT,
            "Completed production runs cannot be cancelled directly.",
        )

    if not isinstance(reason, str) or not reason.strip():
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "A cancellation reason is required.",
        )

    if any(
        Decimal(material.issued_quantity) > ZERO
        for material in run.materials
    ):
        raise _error(
            status.HTTP_409_CONFLICT,
            "Production runs with issued inventory require "
            "an authorized stock-reversal workflow.",
        )

    previous_status = run.status
    run.status = "CANCELLED"

    _audit(
        db,
        actor_id=actor_id,
        run_id=production_run_id,
        action="PRODUCTION_RUN_CANCELLED",
        old_values={"status": previous_status},
        new_values={
            "status": "CANCELLED",
            "reason": reason.strip(),
        },
    )

    db.flush()
    return run