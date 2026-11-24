
"""
Indian financial-year calculations and invoice-number formatting.

The Indian financial year runs from 1 April through 31 March.

This module provides deterministic date and numbering utilities.
Invoice sequence allocation must be performed atomically by the
invoicing service within a PostgreSQL transaction.

Formatting an invoice number does not reserve that number.
"""

from __future__ import annotations

import re
from datetime import date, datetime
from typing import Final


FINANCIAL_YEAR_START_MONTH: Final[int] = 4
FINANCIAL_YEAR_START_DAY: Final[int] = 1

DEFAULT_INVOICE_PREFIX: Final[str] = "INV"
DEFAULT_SEQUENCE_WIDTH: Final[int] = 5

_FINANCIAL_YEAR_PATTERN: Final[re.Pattern[str]] = re.compile(
    r"^(\d{4})-(\d{2})$"
)

_INVOICE_PREFIX_PATTERN: Final[re.Pattern[str]] = re.compile(
    r"^[A-Z][A-Z0-9_-]*$"
)


def _require_date(value: date | datetime) -> date:
    """Validate and normalize a date or datetime value."""

    if isinstance(value, datetime):
        return value.date()

    if isinstance(value, date):
        return value

    raise TypeError(
        "Expected a datetime.date or datetime.datetime value."
    )


def get_financial_year_start_year(
    value: date | datetime,
) -> int:
    """
    Return the calendar year in which the financial year begins.

    For example:
        2026-03-31 -> 2025
        2026-04-01 -> 2026
    """

    target_date = _require_date(value)

    if target_date.month >= FINANCIAL_YEAR_START_MONTH:
        return target_date.year

    return target_date.year - 1


def format_financial_year(start_year: int) -> str:
    """
    Format a financial year as YYYY-YY.

    For example:
        2025 -> 2025-26
        2026 -> 2026-27
    """

    if isinstance(start_year, bool) or not isinstance(
        start_year, int
    ):
        raise TypeError(
            "Financial-year start year must be an integer."
        )

    if not 1 <= start_year <= 9998:
        raise ValueError(
            "Financial-year start year must be between "
            "1 and 9998."
        )

    end_year = start_year + 1

    return f"{start_year:04d}-{end_year % 100:02d}"


def get_financial_year(
    value: date | datetime,
) -> str:
    """
    Return the Indian financial year containing the given date.

    The returned format is YYYY-YY.
    """

    start_year = get_financial_year_start_year(value)

    return format_financial_year(start_year)


def parse_financial_year(financial_year: str) -> int:
    """
    Validate a YYYY-YY financial-year identifier.

    Return the full four-digit starting year.

    The final two digits must match the following calendar
    year, including century transitions.
    """

    if not isinstance(financial_year, str):
        raise TypeError(
            "Financial year must be a string."
        )

    match = _FINANCIAL_YEAR_PATTERN.fullmatch(
        financial_year
    )

    if match is None:
        raise ValueError(
            "Financial year must use YYYY-YY format."
        )

    start_year = int(match.group(1))
    supplied_end_year = int(match.group(2))

    if not 1 <= start_year <= 9998:
        raise ValueError(
            "Financial-year start year is out of range."
        )

    expected_end_year = (start_year + 1) % 100

    if supplied_end_year != expected_end_year:
        raise ValueError(
            "Financial-year ending digits do not match "
            "the starting year."
        )

    return start_year


def get_financial_year_dates(
    financial_year: str,
) -> tuple[date, date]:
    """
    Return the inclusive start and end dates of a financial year.

    For example:
        2025-26 -> (2025-04-01, 2026-03-31)
    """

    start_year = parse_financial_year(financial_year)

    start_date = date(
        start_year,
        FINANCIAL_YEAR_START_MONTH,
        FINANCIAL_YEAR_START_DAY,
    )

    end_date = date(
        start_year + 1,
        FINANCIAL_YEAR_START_MONTH - 1,
        31,
    )

    return start_date, end_date


def get_financial_year_start(
    value: date | datetime,
) -> date:
    """Return the first date of the containing financial year."""

    start_year = get_financial_year_start_year(value)

    return date(
        start_year,
        FINANCIAL_YEAR_START_MONTH,
        FINANCIAL_YEAR_START_DAY,
    )


def get_financial_year_end(
    value: date | datetime,
) -> date:
    """Return the last date of the containing financial year."""

    start_year = get_financial_year_start_year(value)

    return date(
        start_year + 1,
        FINANCIAL_YEAR_START_MONTH - 1,
        31,
    )


def is_date_in_financial_year(
    value: date | datetime,
    financial_year: str,
) -> bool:
    """Check whether a date belongs to the specified financial year."""

    target_date = _require_date(value)

    start_date, end_date = get_financial_year_dates(
        financial_year
    )

    return start_date <= target_date <= end_date


def validate_financial_year_for_date(
    value: date | datetime,
    financial_year: str,
) -> str:
    """
    Validate that a document date matches its financial year.

    Return the validated financial-year identifier.
    """

    parse_financial_year(financial_year)

    if not is_date_in_financial_year(
        value,
        financial_year,
    ):
        raise ValueError(
            "Document date does not belong to the "
            "specified financial year."
        )

    return financial_year


def financial_years_between(
    start_date: date | datetime,
    end_date: date | datetime,
) -> tuple[str, ...]:
    """
    Return all financial years intersecting an inclusive date range.

    Results are ordered from earliest to latest.
    """

    first_date = _require_date(start_date)
    last_date = _require_date(end_date)

    if first_date > last_date:
        raise ValueError(
            "Start date cannot be later than end date."
        )

    first_year = get_financial_year_start_year(
        first_date
    )

    last_year = get_financial_year_start_year(
        last_date
    )

    return tuple(
        format_financial_year(year)
        for year in range(
            first_year,
            last_year + 1,
        )
    )


def format_invoice_number(
    financial_year: str,
    sequence_number: int,
    *,
    prefix: str = DEFAULT_INVOICE_PREFIX,
    sequence_width: int = DEFAULT_SEQUENCE_WIDTH,
) -> str:
    """
    Format an invoice number using its financial year and sequence.

    Example:
        INV/2025-26/00001

    The sequence number must already have been allocated safely
    by the invoicing service.

    This function does not query, lock, insert, or update any
    database records.
    """

    parse_financial_year(financial_year)

    if not isinstance(prefix, str):
        raise TypeError(
            "Invoice prefix must be a string."
        )

    normalized_prefix = prefix.strip().upper()

    if not normalized_prefix:
        raise ValueError(
            "Invoice prefix cannot be empty."
        )

    if len(normalized_prefix) > 30:
        raise ValueError(
            "Invoice prefix cannot exceed 30 characters."
        )

    if _INVOICE_PREFIX_PATTERN.fullmatch(
        normalized_prefix
    ) is None:
        raise ValueError(
            "Invoice prefix must begin with a letter "
            "and contain only letters, digits, "
            "underscores, or hyphens."
        )

    if isinstance(sequence_number, bool) or not isinstance(
        sequence_number, int
    ):
        raise TypeError(
            "Invoice sequence number must be an integer."
        )

    if sequence_number <= 0:
        raise ValueError(
            "Invoice sequence number must be positive."
        )

    if isinstance(sequence_width, bool) or not isinstance(
        sequence_width, int
    ):
        raise TypeError(
            "Invoice sequence width must be an integer."
        )

    if not 1 <= sequence_width <= 20:
        raise ValueError(
            "Invoice sequence width must be between 1 and 20."
        )

    sequence_text = str(sequence_number).zfill(
        sequence_width
    )

    invoice_number = (
        f"{normalized_prefix}/"
        f"{financial_year}/"
        f"{sequence_text}"
    )

    if len(invoice_number) > 100:
        raise ValueError(
            "Formatted invoice number exceeds "
            "the database field length."
        )

    return invoice_number


def validate_invoice_number(
    invoice_number: str,
    financial_year: str,
    *,
    prefix: str = DEFAULT_INVOICE_PREFIX,
    sequence_width: int = DEFAULT_SEQUENCE_WIDTH,
) -> int:
    """
    Validate a formatted invoice number.

    Return its positive integer sequence number.

    This verifies formatting only; it does not establish
    uniqueness or confirm that the invoice exists.
    """

    parse_financial_year(financial_year)

    if not isinstance(invoice_number, str):
        raise TypeError(
            "Invoice number must be a string."
        )

    if not isinstance(prefix, str):
        raise TypeError(
            "Invoice prefix must be a string."
        )

    normalized_prefix = prefix.strip().upper()

    if (
        not normalized_prefix
        or len(normalized_prefix) > 30
        or _INVOICE_PREFIX_PATTERN.fullmatch(
            normalized_prefix
        ) is None
    ):
        raise ValueError(
            "Invalid invoice prefix."
        )

    if isinstance(sequence_width, bool) or not isinstance(
        sequence_width, int
    ):
        raise TypeError(
            "Invoice sequence width must be an integer."
        )

    if not 1 <= sequence_width <= 20:
        raise ValueError(
            "Invoice sequence width must be between 1 and 20."
        )

    expected_start = (
        f"{normalized_prefix}/{financial_year}/"
    )

    if not invoice_number.startswith(expected_start):
        raise ValueError(
            "Invoice number prefix or financial year "
            "does not match."
        )

    sequence_text = invoice_number[
        len(expected_start):
    ]

    if (
        not sequence_text
        or not sequence_text.isascii()
        or not sequence_text.isdecimal()
    ):
        raise ValueError(
            "Invoice sequence must contain ASCII digits only."
        )

    sequence_number = int(sequence_text)

    expected_invoice_number = format_invoice_number(
        financial_year=financial_year,
        sequence_number=sequence_number,
        prefix=normalized_prefix,
        sequence_width=sequence_width,
    )

    if invoice_number != expected_invoice_number:
        raise ValueError(
            "Invoice number does not match the required format."
        )

    return sequence_number
