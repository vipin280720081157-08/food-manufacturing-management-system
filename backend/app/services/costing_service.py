"""
Production costing and variance analysis.

Material and packaging costs are calculated from actual consumption
and wastage using the unit-cost snapshots retained on production
material records.

Production expenses may be recorded after physical completion.
Recalculation updates the production cost summary without creating
or modifying inventory movements.

All database writes remain in the caller's transaction.
"""

from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models.bom import ProductBOM
from app.models.product import InventoryItem, Product
from app.models.production import (
    ProductionCostSummary,
    ProductionExpense,
    ProductionMaterial,
    ProductionRun,
)
from app.models.user import User
from app.services.audit_service import create_audit_log


MONEY_QUANTUM = Decimal("0.01")
UNIT_COST_QUANTUM = Decimal("0.000001")
QUANTITY_QUANTUM = Decimal("0.001")
PERCENT_QUANTUM = Decimal("0.01")
ZERO = Decimal("0")

AUTHORIZED_COSTING_ROLES = frozenset(
    {"Factory Admin", "Production Supervisor"}
)


def _error(code: int, detail: str) -> HTTPException:
    return HTTPException(status_code=code, detail=detail)


def _decimal(value: Decimal | int | str, name: str) -> Decimal:
    if isinstance(value, (bool, float)):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"{name} must use exact decimal arithmetic.",
        )
    try:
        result = Decimal(value)
    except (InvalidOperation, TypeError, ValueError):
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


def _money(value: Decimal | int | str) -> Decimal:
    return _decimal(value, "amount").quantize(
        MONEY_QUANTUM, rounding=ROUND_HALF_UP
    )


def _unit_cost(value: Decimal | int | str) -> Decimal:
    return _decimal(value, "unit cost").quantize(
        UNIT_COST_QUANTUM, rounding=ROUND_HALF_UP
    )


def _percentage(value: Decimal) -> Decimal:
    return value.quantize(
        PERCENT_QUANTUM, rounding=ROUND_HALF_UP
    )


def _require_actor(db: Session, actor_id: UUID) -> User:
    user = db.get(User, actor_id)
    if user is None or not user.is_active:
        raise _error(
            status.HTTP_403_FORBIDDEN,
            "An active user account is required.",
        )
    role = user.primary_role
    if role is None or role.role_name not in AUTHORIZED_COSTING_ROLES:
        raise _error(
            status.HTTP_403_FORBIDDEN,
            "Production costing permission is required.",
        )
    return user


def _get_run(
    db: Session,
    production_run_id: UUID,
    *,
    lock: bool = False,
) -> ProductionRun:
    statement = (
        select(ProductionRun)
        .where(ProductionRun.production_run_id == production_run_id)
        .options(
            selectinload(ProductionRun.materials).selectinload(
                ProductionMaterial.inventory_item
            ),
            selectinload(ProductionRun.expenses),
            selectinload(ProductionRun.cost_summary),
        )
    )
    if lock:
        statement = statement.with_for_update(of=ProductionRun)
    production_run = db.scalar(statement)
    if production_run is None:
        raise _error(
            status.HTTP_404_NOT_FOUND,
            "Production run not found.",
        )
    return production_run


def calculate_weighted_average_unit_cost(
    *,
    existing_quantity: Decimal,
    existing_unit_cost: Decimal,
    received_quantity: Decimal,
    received_unit_cost: Decimal,
) -> Decimal:
    """Calculate moving weighted-average cost after a receipt."""

    existing_quantity = _decimal(
        existing_quantity, "existing quantity"
    )
    received_quantity = _decimal(
        received_quantity, "received quantity"
    )
    existing_unit_cost = _decimal(
        existing_unit_cost, "existing unit cost"
    )
    received_unit_cost = _decimal(
        received_unit_cost, "received unit cost"
    )

    if (
        existing_quantity < ZERO
        or received_quantity <= ZERO
        or existing_unit_cost < ZERO
        or received_unit_cost < ZERO
    ):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Stock quantities and unit costs must be valid.",
        )

    total_quantity = existing_quantity + received_quantity
    total_value = (
        existing_quantity * existing_unit_cost
        + received_quantity * received_unit_cost
    )
    return _unit_cost(total_value / total_quantity)


def calculate_consumption_cost(
    *,
    consumed_quantity: Decimal,
    wasted_quantity: Decimal = ZERO,
    applied_unit_cost: Decimal,
) -> Decimal:
    """
    Value consumed and wasted material at its recorded issue cost.

    Returned and unconsumed quantities are excluded.
    """

    consumed = _decimal(consumed_quantity, "consumed quantity")
    wasted = _decimal(wasted_quantity, "wasted quantity")
    cost = _decimal(applied_unit_cost, "applied unit cost")

    if consumed < ZERO or wasted < ZERO or cost < ZERO:
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Consumption, wastage, and unit cost cannot be negative.",
        )

    return _money((consumed + wasted) * cost)


def calculate_material_variance(
    *,
    planned_quantity: Decimal,
    actual_quantity: Decimal,
    tolerance_percent: Decimal = Decimal("3"),
) -> dict[str, Decimal | bool | None]:
    """Calculate actual-versus-planned material consumption."""

    planned = _decimal(planned_quantity, "planned quantity")
    actual = _decimal(actual_quantity, "actual quantity")
    tolerance = _decimal(tolerance_percent, "tolerance percent")

    if planned < ZERO or actual < ZERO or tolerance < ZERO:
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Variance inputs cannot be negative.",
        )

    difference = actual - planned
    percentage = (
        _percentage(difference / planned * Decimal("100"))
        if planned > ZERO
        else None
    )

    return {
        "planned_quantity": planned,
        "actual_quantity": actual,
        "variance_quantity": difference,
        "variance_percentage": percentage,
        "exceeds_tolerance": (
            abs(percentage) > tolerance
            if percentage is not None
            else False
        ),
    }


def calculate_yield_variance(
    *,
    expected_output: Decimal,
    actual_good_output: Decimal,
    tolerance_percent: Decimal = Decimal("3"),
) -> dict[str, Decimal | bool | None]:
    """Calculate good-output yield variance."""

    expected = _decimal(expected_output, "expected output")
    actual = _decimal(actual_good_output, "actual good output")
    tolerance = _decimal(tolerance_percent, "tolerance percent")

    if expected < ZERO or actual < ZERO or tolerance < ZERO:
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Yield variance inputs cannot be negative.",
        )

    difference = actual - expected
    percentage = (
        _percentage(difference / expected * Decimal("100"))
        if expected > ZERO
        else None
    )

    return {
        "expected_output": expected,
        "actual_good_output": actual,
        "variance_quantity": difference,
        "variance_percentage": percentage,
        "exceeds_tolerance": (
            abs(percentage) > tolerance
            if percentage is not None
            else False
        ),
    }


def calculate_production_cost_components(
    production_run: ProductionRun,
) -> dict[str, Decimal]:
    """
    Calculate production costs from persisted material and expense data.

    Historical applied_unit_cost is used rather than the current
    inventory average, preserving the original consumption valuation.
    """

    material_cost = ZERO
    packaging_cost = ZERO

    for material in production_run.materials:
        inventory_item = material.inventory_item

        if inventory_item is None:
            raise _error(
                status.HTTP_409_CONFLICT,
                "A production material has no inventory master.",
            )

        issued = _decimal(
            material.issued_quantity, "issued quantity"
        )
        consumed = _decimal(
            material.actual_quantity, "actual quantity"
        )
        wasted = _decimal(
            material.wasted_quantity, "wasted quantity"
        )
        returned = _decimal(
            material.returned_quantity, "returned quantity"
        )

        if (
            issued < ZERO
            or consumed < ZERO
            or wasted < ZERO
            or returned < ZERO
            or consumed + wasted + returned > issued
        ):
            raise _error(
                status.HTTP_409_CONFLICT,
                "Production material quantities do not reconcile.",
            )

        line_cost = calculate_consumption_cost(
            consumed_quantity=consumed,
            wasted_quantity=wasted,
            applied_unit_cost=material.applied_unit_cost,
        )

        if inventory_item.item_type == "RAW_MATERIAL":
            material_cost += line_cost
        elif inventory_item.item_type == "PACKAGING_MATERIAL":
            packaging_cost += line_cost
        else:
            raise _error(
                status.HTTP_409_CONFLICT,
                "Production consumption contains an invalid item type.",
            )

    overhead_cost = ZERO

    for expense in production_run.expenses:
        amount = _decimal(expense.amount, "production expense")
        if amount < ZERO:
            raise _error(
                status.HTTP_409_CONFLICT,
                "Production expense cannot be negative.",
            )
        overhead_cost += amount

    material_cost = _money(material_cost)
    packaging_cost = _money(packaging_cost)
    overhead_cost = _money(overhead_cost)
    total_cost = material_cost + packaging_cost + overhead_cost

    good_output = _decimal(
        production_run.good_output, "good output"
    )

    if good_output < ZERO:
        raise _error(
            status.HTTP_409_CONFLICT,
            "Good output cannot be negative.",
        )

    cost_per_unit = (
        _unit_cost(total_cost / good_output)
        if good_output > ZERO
        else Decimal("0.000000")
    )

    return {
        "material_cost": material_cost,
        "packaging_cost": packaging_cost,
        "overhead_cost": overhead_cost,
        "total_cost": total_cost,
        "good_output": good_output,
        "cost_per_unit": cost_per_unit,
    }


def recalculate_production_cost(
    db: Session,
    *,
    production_run_id: UUID,
    actor_id: UUID,
) -> ProductionCostSummary:
    """
    Create or update the current production cost summary.

    Only completed runs with positive good output may have a persisted
    cost summary. Recalculation never posts stock movements.
    """

    _require_actor(db, actor_id)
    production_run = _get_run(
        db, production_run_id, lock=True
    )

    if production_run.status != "COMPLETED":
        raise _error(
            status.HTTP_409_CONFLICT,
            "Only completed production runs can be costed.",
        )

    components = calculate_production_cost_components(
        production_run
    )

    if components["good_output"] <= ZERO:
        raise _error(
            status.HTTP_409_CONFLICT,
            "Good output must be positive to calculate unit cost.",
        )

    summary = db.scalar(
        select(ProductionCostSummary)
        .where(
            ProductionCostSummary.production_run_id
            == production_run_id
        )
        .with_for_update(of=ProductionCostSummary)
    )

    old_values = None

    if summary is None:
        summary = ProductionCostSummary(
            production_run_id=production_run_id,
            **components,
        )
        db.add(summary)
        action = "PRODUCTION_COST_CREATED"
    else:
        old_values = {
            "material_cost": summary.material_cost,
            "packaging_cost": summary.packaging_cost,
            "overhead_cost": summary.overhead_cost,
            "total_cost": summary.total_cost,
            "good_output": summary.good_output,
            "cost_per_unit": summary.cost_per_unit,
        }
        for field, value in components.items():
            setattr(summary, field, value)
        action = "PRODUCTION_COST_RECALCULATED"

    summary.calculated_at = datetime.now(timezone.utc)
    db.flush()

    create_audit_log(
        db,
        user_id=actor_id,
        entity_type="ProductionCostSummary",
        entity_id=summary.cost_summary_id,
        action=action,
        old_values=old_values,
        new_values=components,
    )

    return summary


def record_production_expense(
    db: Session,
    *,
    production_run_id: UUID,
    actor_id: UUID,
    expense_category: str,
    amount: Decimal,
    expense_date: date,
    description: str | None = None,
) -> ProductionExpense:
    """
    Record a directly attributable production expense.

    Expenses may be entered after physical completion. For completed
    runs, the cost summary is recalculated in the same transaction.
    """

    _require_actor(db, actor_id)

    production_run = _get_run(
        db, production_run_id, lock=True
    )

    if production_run.status == "CANCELLED":
        raise _error(
            status.HTTP_409_CONFLICT,
            "Expenses cannot be recorded against cancelled runs.",
        )

    if not isinstance(expense_category, str):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Expense category must be a string.",
        )

    category = expense_category.strip()

    if not category or len(category) > 100:
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Expense category must contain 1 to 100 characters.",
        )

    if not isinstance(expense_date, date) or isinstance(
        expense_date, datetime
    ):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "A valid expense date is required.",
        )

    validated_amount = _decimal(amount, "expense amount")

    if (
        validated_amount < ZERO
        or validated_amount != _money(validated_amount)
    ):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Expense amount must be nonnegative with "
            "at most two decimal places.",
        )

    expense = ProductionExpense(
        production_run_id=production_run_id,
        expense_category=category,
        amount=validated_amount,
        description=description,
        expense_date=expense_date,
        recorded_by=actor_id,
    )

    db.add(expense)
    db.flush()

    create_audit_log(
        db,
        user_id=actor_id,
        entity_type="ProductionExpense",
        entity_id=expense.expense_id,
        action="PRODUCTION_EXPENSE_RECORDED",
        new_values={
            "production_run_id": production_run_id,
            "expense_category": category,
            "amount": validated_amount,
            "expense_date": expense_date,
            "description": description,
        },
    )

    if production_run.status == "COMPLETED":
        db.expire(production_run, ["expenses"])
        recalculate_production_cost(
            db,
            production_run_id=production_run_id,
            actor_id=actor_id,
        )

    return expense


def get_production_cost_summary(
    db: Session,
    *,
    production_run_id: UUID,
) -> ProductionCostSummary | None:
    """Return the persisted cost summary, if available."""

    _get_run(db, production_run_id)

    return db.scalar(
        select(ProductionCostSummary).where(
            ProductionCostSummary.production_run_id
            == production_run_id
        )
    )


def get_production_variance_analysis(
    db: Session,
    *,
    production_run_id: UUID,
    tolerance_percent: Decimal = Decimal("3"),
) -> dict[str, object]:
    """Return planned-versus-actual material and yield variances."""

    production_run = _get_run(db, production_run_id)

    bom = db.get(ProductBOM, production_run.bom_id)
    if bom is None:
        raise _error(
            status.HTTP_409_CONFLICT,
            "The production run's BOM is missing.",
        )

    material_variances: list[dict[str, object]] = []

    for material in production_run.materials:
        variance = calculate_material_variance(
            planned_quantity=material.planned_quantity,
            actual_quantity=material.actual_quantity,
            tolerance_percent=tolerance_percent,
        )
        material_variances.append(
            {
                "production_material_id": material.production_material_id,
                "item_id": material.item_id,
                "batch_id": material.batch_id,
                "unit": material.unit,
                "wasted_quantity": material.wasted_quantity,
                "returned_quantity": material.returned_quantity,
                **variance,
            }
        )

    expected_output = _decimal(
        bom.expected_output, "expected output"
    ) * (
        _decimal(production_run.planned_output, "planned output")
        / _decimal(bom.standard_batch_size, "standard batch size")
    )

    yield_variance = calculate_yield_variance(
        expected_output=expected_output,
        actual_good_output=production_run.good_output,
        tolerance_percent=tolerance_percent,
    )

    return {
        "production_run_id": production_run.production_run_id,
        "production_number": production_run.production_number,
        "status": production_run.status,
        "tolerance_percent": tolerance_percent,
        "material_variances": material_variances,
        "yield_variance": yield_variance,
        "rejected_output": production_run.rejected_output,
    }


def calculate_production_margin(
    db: Session,
    *,
    production_run_id: UUID,
) -> dict[str, Decimal | UUID]:
    """
    Compare recorded production unit cost with current selling price.

    The result is an indicative margin, not a historical sales margin.
    """

    production_run = _get_run(db, production_run_id)

    summary = get_production_cost_summary(
        db, production_run_id=production_run_id
    )

    if summary is None:
        raise _error(
            status.HTTP_409_CONFLICT,
            "Production costing has not been calculated.",
        )

    product = db.get(Product, production_run.product_id)

    if product is None:
        raise _error(
            status.HTTP_409_CONFLICT,
            "The finished-product master is missing.",
        )

    selling_price = _decimal(
        product.selling_price, "selling price"
    )
    cost_per_unit = _decimal(
        summary.cost_per_unit, "cost per unit"
    )

    margin_amount = _money(selling_price - cost_per_unit)
    margin_percentage = (
        _percentage(
            (selling_price - cost_per_unit)
            / selling_price
            * Decimal("100")
        )
        if selling_price > ZERO
        else ZERO
    )

    return {
        "production_run_id": production_run_id,
        "product_id": product.product_id,
        "selling_price": selling_price,
        "cost_per_unit": cost_per_unit,
        "margin_amount": margin_amount,
        "margin_percentage": margin_percentage,
    }