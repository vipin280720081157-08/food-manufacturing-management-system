
"""
Decimal-safe quantity validation, unit conversion, and precision utilities.

Inventory quantities are stored in each item's configured base unit.
Approved conversion factors are maintained in the unit_conversions table.

A conversion factor represents:

    quantity_in_to_unit = quantity_in_from_unit * conversion_factor

This module performs calculations without accessing the database.
Callers must supply conversion factors obtained from approved records.
"""

from __future__ import annotations

from decimal import (
    Decimal,
    InvalidOperation,
    ROUND_HALF_UP,
)
from typing import Final


QUANTITY_DECIMAL_PLACES: Final[int] = 3
QUANTITY_QUANTUM: Final[Decimal] = Decimal("0.001")

ZERO_QUANTITY: Final[Decimal] = Decimal("0.000")


def to_decimal(
    value: Decimal | int | str,
) -> Decimal:
    """
    Convert a supported value to a finite Decimal.

    Floating-point values and booleans are rejected to prevent
    unintended precision loss and ambiguous numeric inputs.
    """

    if isinstance(value, bool) or isinstance(value, float):
        raise TypeError(
            "Quantities must use Decimal, int, or decimal strings."
        )

    if not isinstance(value, (Decimal, int, str)):
        raise TypeError(
            "Unsupported quantity type. "
            "Expected Decimal, int, or str."
        )

    if isinstance(value, str):
        value = value.strip()

        if not value:
            raise ValueError("Decimal value cannot be empty.")

    try:
        result = Decimal(value)
    except (InvalidOperation, ValueError) as exc:
        raise ValueError("Invalid decimal value.") from exc

    if not result.is_finite():
        raise ValueError("Decimal value must be finite.")

    return result


def normalize_unit(unit: str) -> str:
    """
    Validate and normalize a unit identifier.

    Whitespace is removed from the beginning and end.
    Case is preserved because stored unit identifiers must
    match the approved database records.
    """

    if not isinstance(unit, str):
        raise TypeError("Unit must be a string.")

    normalized = unit.strip()

    if not normalized:
        raise ValueError("Unit cannot be empty.")

    if len(normalized) > 30:
        raise ValueError(
            "Unit cannot exceed 30 characters."
        )

    return normalized


def quantize_quantity(
    quantity: Decimal | int | str,
) -> Decimal:
    """
    Round a finite quantity to three decimal places.

    Uses ROUND_HALF_UP for consistent application-level
    quantity rounding.
    """

    value = to_decimal(quantity)

    try:
        return value.quantize(
            QUANTITY_QUANTUM,
            rounding=ROUND_HALF_UP,
        )
    except InvalidOperation as exc:
        raise ValueError(
            "Quantity exceeds supported decimal precision."
        ) from exc


def validate_quantity(
    quantity: Decimal | int | str,
    *,
    allow_zero: bool = False,
    allow_negative: bool = False,
    enforce_precision: bool = True,
) -> Decimal:
    """
    Validate a quantity against its permitted sign and precision.

    By default, quantities must be strictly positive and
    representable at the application's three-decimal-place
    inventory precision.

    Zero and negative values require explicit authorization
    through the corresponding arguments.
    """

    value = to_decimal(quantity)

    if value < 0 and not allow_negative:
        raise ValueError(
            "Quantity cannot be negative."
        )

    if value == 0 and not allow_zero:
        raise ValueError(
            "Quantity must be greater than zero."
        )

    if enforce_precision:
        rounded = quantize_quantity(value)

        if rounded != value:
            raise ValueError(
                "Quantity cannot exceed three decimal places."
            )

        return rounded

    return value


def validate_conversion_factor(
    conversion_factor: Decimal | int | str,
) -> Decimal:
    """
    Validate an approved unit conversion factor.

    Conversion factors must be strictly positive.
    Their stored precision is preserved without premature
    rounding during arithmetic.
    """

    factor = to_decimal(conversion_factor)

    if factor <= 0:
        raise ValueError(
            "Conversion factor must be greater than zero."
        )

    return factor


def convert_quantity(
    quantity: Decimal | int | str,
    from_unit: str,
    to_unit: str,
    conversion_factor: Decimal | int | str | None = None,
    *,
    round_result: bool = True,
) -> Decimal:
    """
    Convert a quantity between compatible units.

    For different units, the caller must supply the approved
    factor for the exact from_unit -> to_unit direction.

    Reverse conversions require the corresponding approved
    reverse factor or an explicitly calculated reciprocal
    supplied by the caller.

    No conversion factors are inferred from unit names.

    When round_result is True, the converted quantity is
    rounded to the inventory quantity precision.
    """

    source_unit = normalize_unit(from_unit)
    destination_unit = normalize_unit(to_unit)

    value = validate_quantity(
        quantity,
        allow_zero=True,
        allow_negative=False,
        enforce_precision=False,
    )

    if source_unit == destination_unit:
        if conversion_factor is not None:
            factor = validate_conversion_factor(
                conversion_factor
            )

            if factor != Decimal("1"):
                raise ValueError(
                    "Identical units require a conversion "
                    "factor of one."
                )

        result = value

    else:
        if conversion_factor is None:
            raise ValueError(
                "An approved conversion factor is required "
                "when converting between different units."
            )

        factor = validate_conversion_factor(
            conversion_factor
        )

        result = value * factor

    if round_result:
        return quantize_quantity(result)

    return result


def reverse_conversion_factor(
    conversion_factor: Decimal | int | str,
) -> Decimal:
    """
    Calculate the reciprocal of a conversion factor.

    The result is not rounded to inventory quantity precision.
    Callers must ensure that reverse conversion is permitted
    by the application's approved unit-conversion records.
    """

    factor = validate_conversion_factor(
        conversion_factor
    )

    return Decimal("1") / factor


def add_quantities(
    *quantities: Decimal | int | str,
) -> Decimal:
    """
    Add quantities expressed in the same unit.

    Callers must convert all quantities to a common unit
    before using this function.
    """

    total = Decimal("0")

    for quantity in quantities:
        total += validate_quantity(
            quantity,
            allow_zero=True,
            allow_negative=True,
            enforce_precision=True,
        )

    return quantize_quantity(total)


def subtract_quantities(
    starting_quantity: Decimal | int | str,
    deducted_quantity: Decimal | int | str,
    *,
    allow_negative_result: bool = False,
) -> Decimal:
    """
    Subtract a nonnegative quantity from a starting balance.

    Negative resulting balances are rejected by default.
    Both inputs must already be expressed in the same unit.
    """

    starting = validate_quantity(
        starting_quantity,
        allow_zero=True,
        allow_negative=allow_negative_result,
    )

    deducted = validate_quantity(
        deducted_quantity,
        allow_zero=True,
    )

    result = starting - deducted

    if result < 0 and not allow_negative_result:
        raise ValueError(
            "Insufficient quantity for the requested deduction."
        )

    return quantize_quantity(result)


def quantities_equal(
    first_quantity: Decimal | int | str,
    second_quantity: Decimal | int | str,
) -> bool:
    """
    Compare two quantities exactly.

    Inputs must be expressed in the same unit.
    No tolerance or implicit rounding is applied.
    """

    first = to_decimal(first_quantity)
    second = to_decimal(second_quantity)

    return first == second


def calculate_quantity_difference(
    actual_quantity: Decimal | int | str,
    expected_quantity: Decimal | int | str,
) -> Decimal:
    """
    Calculate actual minus expected quantity.

    A positive result represents an excess.
    A negative result represents a shortfall.

    Both quantities must be expressed in the same unit.
    """

    actual = validate_quantity(
        actual_quantity,
        allow_zero=True,
    )

    expected = validate_quantity(
        expected_quantity,
        allow_zero=True,
    )

    return quantize_quantity(actual - expected)


def calculate_pack_quantity(
    total_quantity: Decimal | int | str,
    quantity_per_pack: Decimal | int | str,
) -> Decimal:
    """
    Calculate the number of packs represented by a quantity.

    The caller must ensure that total_quantity and
    quantity_per_pack use the same measurement unit.

    The result is returned without rounding so fractional
    pack quantities remain detectable by business validation.
    """

    total = validate_quantity(
        total_quantity,
        allow_zero=True,
        enforce_precision=False,
    )

    per_pack = validate_quantity(
        quantity_per_pack,
        enforce_precision=False,
    )

    return total / per_pack


def require_whole_packs(
    pack_quantity: Decimal | int | str,
) -> int:
    """
    Require a nonnegative, whole-number pack count.

    Useful for products or packaging materials that cannot
    be issued, dispatched, or received in fractional packs.
    """

    quantity = validate_quantity(
        pack_quantity,
        allow_zero=True,
        enforce_precision=False,
    )

    if quantity != quantity.to_integral_value():
        raise ValueError(
            "Pack quantity must be a whole number."
        )

    return int(quantity)
