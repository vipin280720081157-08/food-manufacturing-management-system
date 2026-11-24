
"""
Decimal-safe business calculations for the Food Manufacturing Management System.

This module implements pure calculations for:
- Sales order values and GST
- Inventory balances and stock shortages
- Moving weighted-average inventory valuation
- BOM consumption and production variances
- Production costs and selling margins
- Payments, outstanding balances, and receivables ageing

All monetary calculations use Decimal rather than binary floating-point
arithmetic. Database transactions, authorization, posting, and audit
logging remain the responsibility of the corresponding backend services.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from decimal import (
    Decimal,
    InvalidOperation,
    ROUND_HALF_UP,
)
from typing import Final, Iterable


MONEY_QUANTUM: Final[Decimal] = Decimal("0.01")
UNIT_COST_QUANTUM: Final[Decimal] = Decimal("0.000001")
QUANTITY_QUANTUM: Final[Decimal] = Decimal("0.001")
PERCENT_QUANTUM: Final[Decimal] = Decimal("0.01")

ZERO: Final[Decimal] = Decimal("0")
ONE_HUNDRED: Final[Decimal] = Decimal("100")


def _decimal(value: Decimal | int | str) -> Decimal:
    """Convert a supported numeric input to a finite Decimal."""

    if isinstance(value, bool) or isinstance(value, float):
        raise TypeError(
            "Use Decimal, int, or a decimal string; "
            "floating-point values are not accepted."
        )

    if not isinstance(value, (Decimal, int, str)):
        raise TypeError(
            "Expected Decimal, int, or str."
        )

    if isinstance(value, str):
        value = value.strip()

        if not value:
            raise ValueError(
                "Numeric value cannot be empty."
            )

    try:
        result = Decimal(value)
    except (InvalidOperation, ValueError) as exc:
        raise ValueError(
            "Invalid decimal value."
        ) from exc

    if not result.is_finite():
        raise ValueError(
            "Numeric value must be finite."
        )

    return result


def _nonnegative(
    value: Decimal | int | str,
    name: str,
) -> Decimal:
    """Require a nonnegative finite Decimal."""

    result = _decimal(value)

    if result < ZERO:
        raise ValueError(
            f"{name} cannot be negative."
        )

    return result


def _positive(
    value: Decimal | int | str,
    name: str,
) -> Decimal:
    """Require a strictly positive finite Decimal."""

    result = _decimal(value)

    if result <= ZERO:
        raise ValueError(
            f"{name} must be greater than zero."
        )

    return result


def _quantize(
    value: Decimal,
    quantum: Decimal,
) -> Decimal:
    """Round using decimal ROUND_HALF_UP."""

    try:
        return value.quantize(
            quantum,
            rounding=ROUND_HALF_UP,
        )
    except InvalidOperation as exc:
        raise ValueError(
            "Value exceeds supported decimal precision."
        ) from exc


def round_money(
    value: Decimal | int | str,
) -> Decimal:
    """Round a monetary amount to two decimal places."""

    return _quantize(
        _decimal(value),
        MONEY_QUANTUM,
    )


def round_unit_cost(
    value: Decimal | int | str,
) -> Decimal:
    """Round an inventory unit cost to six decimal places."""

    return _quantize(
        _decimal(value),
        UNIT_COST_QUANTUM,
    )


def round_quantity(
    value: Decimal | int | str,
) -> Decimal:
    """Round an inventory quantity to three decimal places."""

    return _quantize(
        _decimal(value),
        QUANTITY_QUANTUM,
    )


def round_percentage(
    value: Decimal | int | str,
) -> Decimal:
    """Round a percentage to two decimal places."""

    return _quantize(
        _decimal(value),
        PERCENT_QUANTUM,
    )


def calculate_line_amount(
    quantity: Decimal | int | str,
    unit_price: Decimal | int | str,
) -> Decimal:
    """Calculate a sales line's taxable amount."""

    quantity_value = _positive(
        quantity,
        "Quantity",
    )

    price_value = _nonnegative(
        unit_price,
        "Unit price",
    )

    return round_money(
        quantity_value * price_value
    )


def calculate_subtotal(
    line_amounts: Iterable[Decimal | int | str],
) -> Decimal:
    """Sum already-rounded sales or invoice line amounts."""

    total = ZERO

    for amount in line_amounts:
        total += _nonnegative(
            amount,
            "Line amount",
        )

    return round_money(total)


def calculate_tax_amount(
    taxable_amount: Decimal | int | str,
    tax_rate: Decimal | int | str,
) -> Decimal:
    """Calculate tax from a taxable amount and percentage rate."""

    taxable = _nonnegative(
        taxable_amount,
        "Taxable amount",
    )

    rate = _nonnegative(
        tax_rate,
        "Tax rate",
    )

    if rate > ONE_HUNDRED:
        raise ValueError(
            "Tax rate cannot exceed 100 percent."
        )

    return round_money(
        taxable * rate / ONE_HUNDRED
    )


def _normalize_state(state: str) -> str:
    """Normalize a supplier or place-of-supply state identifier."""

    if not isinstance(state, str):
        raise TypeError(
            "State must be a string."
        )

    normalized = " ".join(
        state.strip().casefold().split()
    )

    if not normalized:
        raise ValueError(
            "State cannot be empty."
        )

    return normalized


@dataclass(frozen=True, slots=True)
class GSTCalculation:
    """Calculated GST components for a taxable supply."""

    taxable_amount: Decimal
    gst_rate: Decimal
    cgst_rate: Decimal
    sgst_rate: Decimal
    igst_rate: Decimal
    cgst_amount: Decimal
    sgst_amount: Decimal
    igst_amount: Decimal
    total_tax: Decimal
    total_amount: Decimal
    is_interstate: bool


def calculate_gst(
    taxable_amount: Decimal | int | str,
    gst_rate: Decimal | int | str,
    supplier_state: str,
    place_of_supply_state: str,
) -> GSTCalculation:
    """
    Calculate intra-state CGST/SGST or inter-state IGST.

    The GST rate is supplied by the calling business workflow.
    It is not inferred from product names or hardcoded benchmark data.

    For intra-state supplies, the full rate is divided equally
    between CGST and SGST.

    Tax components are independently rounded to two decimals.
    """

    taxable = round_money(
        _nonnegative(
            taxable_amount,
            "Taxable amount",
        )
    )

    rate = _nonnegative(
        gst_rate,
        "GST rate",
    )

    if rate > ONE_HUNDRED:
        raise ValueError(
            "GST rate cannot exceed 100 percent."
        )

    supplier = _normalize_state(
        supplier_state
    )

    destination = _normalize_state(
        place_of_supply_state
    )

    is_interstate = supplier != destination

    if is_interstate:
        cgst_rate = ZERO
        sgst_rate = ZERO
        igst_rate = rate

        cgst_amount = round_money(ZERO)
        sgst_amount = round_money(ZERO)

        igst_amount = calculate_tax_amount(
            taxable,
            igst_rate,
        )

    else:
        cgst_rate = rate / Decimal("2")
        sgst_rate = rate / Decimal("2")
        igst_rate = ZERO

        cgst_amount = calculate_tax_amount(
            taxable,
            cgst_rate,
        )

        sgst_amount = calculate_tax_amount(
            taxable,
            sgst_rate,
        )

        igst_amount = round_money(ZERO)

    total_tax = round_money(
        cgst_amount
        + sgst_amount
        + igst_amount
    )

    total_amount = round_money(
        taxable + total_tax
    )

    return GSTCalculation(
        taxable_amount=taxable,
        gst_rate=rate,
        cgst_rate=cgst_rate,
        sgst_rate=sgst_rate,
        igst_rate=igst_rate,
        cgst_amount=cgst_amount,
        sgst_amount=sgst_amount,
        igst_amount=igst_amount,
        total_tax=total_tax,
        total_amount=total_amount,
        is_interstate=is_interstate,
    )


@dataclass(frozen=True, slots=True)
class InvoiceTotals:
    """Aggregated taxable value, GST components, and invoice total."""

    taxable_amount: Decimal
    cgst_amount: Decimal
    sgst_amount: Decimal
    igst_amount: Decimal
    total_tax: Decimal
    total_amount: Decimal


def calculate_invoice_totals(
    gst_lines: Iterable[GSTCalculation],
) -> InvoiceTotals:
    """
    Aggregate calculated GST line values into invoice totals.

    Each input line must already have been calculated and rounded.
    Aggregation does not recompute tax from the invoice subtotal.
    """

    taxable = ZERO
    cgst = ZERO
    sgst = ZERO
    igst = ZERO

    for line in gst_lines:
        if not isinstance(line, GSTCalculation):
            raise TypeError(
                "Invoice tax lines must be GSTCalculation instances."
            )

        taxable += line.taxable_amount
        cgst += line.cgst_amount
        sgst += line.sgst_amount
        igst += line.igst_amount

    taxable = round_money(taxable)
    cgst = round_money(cgst)
    sgst = round_money(sgst)
    igst = round_money(igst)

    total_tax = round_money(
        cgst + sgst + igst
    )

    return InvoiceTotals(
        taxable_amount=taxable,
        cgst_amount=cgst,
        sgst_amount=sgst,
        igst_amount=igst,
        total_tax=total_tax,
        total_amount=round_money(
            taxable + total_tax
        ),
    )


def calculate_stock_balance(
    opening_quantity: Decimal | int | str,
    receipts: Decimal | int | str,
    issues: Decimal | int | str,
    adjustments: Decimal | int | str = ZERO,
) -> Decimal:
    """
    Calculate closing inventory quantity.

    Closing = opening + receipts - issues + signed adjustments.

    Adjustments may be positive or negative.
    Negative closing stock is rejected.
    """

    opening = _nonnegative(
        opening_quantity,
        "Opening quantity",
    )

    received = _nonnegative(
        receipts,
        "Receipts",
    )

    issued = _nonnegative(
        issues,
        "Issues",
    )

    adjustment = _decimal(adjustments)

    closing = (
        opening
        + received
        - issued
        + adjustment
    )

    if closing < ZERO:
        raise ValueError(
            "Stock movement would produce negative inventory."
        )

    return round_quantity(closing)


def calculate_stock_shortage(
    requested_quantity: Decimal | int | str,
    available_quantity: Decimal | int | str,
) -> Decimal:
    """Return the unmet quantity without allowing a negative shortage."""

    requested = _nonnegative(
        requested_quantity,
        "Requested quantity",
    )

    available = _nonnegative(
        available_quantity,
        "Available quantity",
    )

    return round_quantity(
        max(ZERO, requested - available)
    )


def calculate_stock_value(
    quantity: Decimal | int | str,
    unit_cost: Decimal | int | str,
) -> Decimal:
    """Calculate monetary inventory value at the supplied unit cost."""

    quantity_value = _nonnegative(
        quantity,
        "Quantity",
    )

    cost_value = _nonnegative(
        unit_cost,
        "Unit cost",
    )

    return round_money(
        quantity_value * cost_value
    )


def calculate_weighted_average_cost(
    existing_quantity: Decimal | int | str,
    existing_unit_cost: Decimal | int | str,
    receipt_quantity: Decimal | int | str,
    receipt_unit_cost: Decimal | int | str,
) -> Decimal:
    """
    Calculate moving weighted-average unit cost after a receipt.

    The existing unit cost must represent the valuation
    immediately before the receipt.

    The result is rounded to six decimal places.
    """

    existing_qty = _nonnegative(
        existing_quantity,
        "Existing quantity",
    )

    existing_cost = _nonnegative(
        existing_unit_cost,
        "Existing unit cost",
    )

    received_qty = _nonnegative(
        receipt_quantity,
        "Receipt quantity",
    )

    received_cost = _nonnegative(
        receipt_unit_cost,
        "Receipt unit cost",
    )

    total_quantity = (
        existing_qty + received_qty
    )

    if total_quantity == ZERO:
        raise ValueError(
            "Weighted-average cost is undefined "
            "when total quantity is zero."
        )

    total_value = (
        existing_qty * existing_cost
        + received_qty * received_cost
    )

    return round_unit_cost(
        total_value / total_quantity
    )


def calculate_consumption_cost(
    actual_quantity: Decimal | int | str,
    applicable_unit_cost: Decimal | int | str,
) -> Decimal:
    """
    Calculate consumption cost at the applicable posting-time rate.

    Callers must preserve the posting-time rate or value
    in the corresponding business transaction.
    """

    quantity = _nonnegative(
        actual_quantity,
        "Actual consumption",
    )

    unit_cost = _nonnegative(
        applicable_unit_cost,
        "Applicable unit cost",
    )

    return round_money(
        quantity * unit_cost
    )


def calculate_planned_consumption(
    standard_quantity: Decimal | int | str,
    planned_output: Decimal | int | str,
    standard_output: Decimal | int | str,
) -> Decimal:
    """
    Scale a standard BOM quantity to the planned output.

    Planned consumption =
        standard quantity * planned output / standard output
    """

    standard = _nonnegative(
        standard_quantity,
        "Standard quantity",
    )

    planned = _nonnegative(
        planned_output,
        "Planned output",
    )

    basis = _positive(
        standard_output,
        "Standard output",
    )

    return round_quantity(
        standard * planned / basis
    )


@dataclass(frozen=True, slots=True)
class VarianceCalculation:
    """Signed absolute and percentage variance with alert status."""

    planned_quantity: Decimal
    actual_quantity: Decimal
    variance_quantity: Decimal
    variance_percentage: Decimal | None
    tolerance_percentage: Decimal
    exceeds_tolerance: bool


def calculate_variance(
    planned_quantity: Decimal | int | str,
    actual_quantity: Decimal | int | str,
    tolerance_percentage: Decimal | int | str = Decimal("3"),
) -> VarianceCalculation:
    """
    Calculate signed actual-minus-planned variance.

    A positive percentage indicates excess actual quantity.
    A negative percentage indicates a shortfall.

    Percentage is undefined when planned quantity is zero.
    The tolerance comparison uses the unrounded percentage.
    """

    planned = _nonnegative(
        planned_quantity,
        "Planned quantity",
    )

    actual = _nonnegative(
        actual_quantity,
        "Actual quantity",
    )

    tolerance = _nonnegative(
        tolerance_percentage,
        "Tolerance percentage",
    )

    difference = actual - planned

    if planned == ZERO:
        percentage = None
        exceeds_tolerance = False
    else:
        exact_percentage = (
            difference / planned
        ) * ONE_HUNDRED

        percentage = round_percentage(
            exact_percentage
        )

        exceeds_tolerance = (
            abs(exact_percentage) > tolerance
        )

    return VarianceCalculation(
        planned_quantity=round_quantity(planned),
        actual_quantity=round_quantity(actual),
        variance_quantity=round_quantity(difference),
        variance_percentage=percentage,
        tolerance_percentage=round_percentage(tolerance),
        exceeds_tolerance=exceeds_tolerance,
    )


def calculate_consumption_variance(
    planned_consumption: Decimal | int | str,
    actual_consumption: Decimal | int | str,
    tolerance_percentage: Decimal | int | str = Decimal("3"),
) -> VarianceCalculation:
    """Calculate planned-versus-actual material consumption variance."""

    return calculate_variance(
        planned_quantity=planned_consumption,
        actual_quantity=actual_consumption,
        tolerance_percentage=tolerance_percentage,
    )


def calculate_yield_variance(
    expected_good_output: Decimal | int | str,
    actual_good_output: Decimal | int | str,
    tolerance_percentage: Decimal | int | str = Decimal("3"),
) -> VarianceCalculation:
    """Calculate expected-versus-actual good finished-output variance."""

    return calculate_variance(
        planned_quantity=expected_good_output,
        actual_quantity=actual_good_output,
        tolerance_percentage=tolerance_percentage,
    )


@dataclass(frozen=True, slots=True)
class ProductionCostCalculation:
    """Production cost components and cost per good finished unit."""

    raw_material_cost: Decimal
    packaging_cost: Decimal
    overhead_cost: Decimal
    total_production_cost: Decimal
    good_output_quantity: Decimal
    cost_per_good_unit: Decimal | None


def calculate_production_cost(
    raw_material_cost: Decimal | int | str,
    packaging_cost: Decimal | int | str,
    overhead_cost: Decimal | int | str,
    good_output_quantity: Decimal | int | str,
) -> ProductionCostCalculation:
    """
    Calculate total production cost and cost per good unit.

    Overheads include allocated labour, gas, power, and other
    applicable production expenses.

    Rejected output is excluded from good output quantity.

    Cost per unit is undefined when good output is zero.
    """

    materials = round_money(
        _nonnegative(
            raw_material_cost,
            "Raw material cost",
        )
    )

    packaging = round_money(
        _nonnegative(
            packaging_cost,
            "Packaging cost",
        )
    )

    overheads = round_money(
        _nonnegative(
            overhead_cost,
            "Overhead cost",
        )
    )

    good_output = _nonnegative(
        good_output_quantity,
        "Good output quantity",
    )

    total = round_money(
        materials + packaging + overheads
    )

    if good_output == ZERO:
        cost_per_unit = None
    else:
        cost_per_unit = round_unit_cost(
            total / good_output
        )

    return ProductionCostCalculation(
        raw_material_cost=materials,
        packaging_cost=packaging,
        overhead_cost=overheads,
        total_production_cost=total,
        good_output_quantity=round_quantity(
            good_output
        ),
        cost_per_good_unit=cost_per_unit,
    )


@dataclass(frozen=True, slots=True)
class MarginCalculation:
    """Selling margin against a specified unit cost."""

    selling_price: Decimal
    unit_cost: Decimal
    margin_amount: Decimal
    margin_percentage: Decimal | None


def calculate_selling_margin(
    selling_price: Decimal | int | str,
    unit_cost: Decimal | int | str,
) -> MarginCalculation:
    """
    Calculate selling margin before GST.

    Margin percentage is based on the selling price.
    It is undefined when selling price is zero.
    """

    price = _nonnegative(
        selling_price,
        "Selling price",
    )

    cost = _nonnegative(
        unit_cost,
        "Unit cost",
    )

    margin = price - cost

    percentage = (
        None
        if price == ZERO
        else round_percentage(
            margin / price * ONE_HUNDRED
        )
    )

    return MarginCalculation(
        selling_price=round_money(price),
        unit_cost=round_unit_cost(cost),
        margin_amount=round_money(margin),
        margin_percentage=percentage,
    )


def calculate_outstanding(
    invoice_total: Decimal | int | str,
    total_allocated_payments: Decimal | int | str,
    total_credits: Decimal | int | str = ZERO,
) -> Decimal:
    """
    Calculate remaining invoice receivable.

    Outstanding = invoice total - allocated payments - credits.

    Over-allocation is rejected rather than silently producing
    a negative receivable.
    """

    invoice = round_money(
        _nonnegative(
            invoice_total,
            "Invoice total",
        )
    )

    payments = round_money(
        _nonnegative(
            total_allocated_payments,
            "Allocated payments",
        )
    )

    credits = round_money(
        _nonnegative(
            total_credits,
            "Total credits",
        )
    )

    outstanding = (
        invoice - payments - credits
    )

    if outstanding < ZERO:
        raise ValueError(
            "Payments and credits exceed the invoice total."
        )

    return round_money(outstanding)


def validate_payment_allocation(
    payment_amount: Decimal | int | str,
    allocation_amounts: Iterable[Decimal | int | str],
) -> Decimal:
    """
    Validate payment allocations against the received amount.

    Return the unallocated amount.

    This calculation does not verify invoice balances or
    perform database posting.
    """

    payment = round_money(
        _positive(
            payment_amount,
            "Payment amount",
        )
    )

    allocated = ZERO

    for amount in allocation_amounts:
        allocated += round_money(
            _positive(
                amount,
                "Allocation amount",
            )
        )

    allocated = round_money(allocated)

    if allocated > payment:
        raise ValueError(
            "Payment allocations exceed the received amount."
        )

    return round_money(
        payment - allocated
    )


def calculate_receivable_age_days(
    due_date: date,
    as_of_date: date,
    outstanding_amount: Decimal | int | str,
) -> int:
    """
    Calculate overdue days using the invoice due date.

    Returns zero for invoices that are not overdue or have
    no outstanding balance.
    """

    if (
        isinstance(due_date, datetime)
        or not isinstance(due_date, date)
    ):
        raise TypeError(
            "Due date must be a datetime.date."
        )

    if (
        isinstance(as_of_date, datetime)
        or not isinstance(as_of_date, date)
    ):
        raise TypeError(
            "As-of date must be a datetime.date."
        )

    outstanding = _nonnegative(
        outstanding_amount,
        "Outstanding amount",
    )

    if outstanding == ZERO:
        return 0

    return max(
        0,
        (as_of_date - due_date).days,
    )


def classify_receivable_age(
    due_date: date,
    as_of_date: date,
    outstanding_amount: Decimal | int | str,
) -> str:
    """
    Classify a receivable using its due date.

    Categories:
        PAID
        NOT_DUE
        1-30
        31-60
        61-90
        OVER_90
    """

    outstanding = _nonnegative(
        outstanding_amount,
        "Outstanding amount",
    )

    if outstanding == ZERO:
        return "PAID"

    if (
        isinstance(due_date, datetime)
        or not isinstance(due_date, date)
        or isinstance(as_of_date, datetime)
        or not isinstance(as_of_date, date)
    ):
        raise TypeError(
            "Receivables ageing requires date values."
        )

    if as_of_date <= due_date:
        return "NOT_DUE"

    days = calculate_receivable_age_days(
        due_date,
        as_of_date,
        outstanding,
    )

    if days <= 30:
        return "1-30"

    if days <= 60:
        return "31-60"

    if days <= 90:
        return "61-90"

    return "OVER_90"
