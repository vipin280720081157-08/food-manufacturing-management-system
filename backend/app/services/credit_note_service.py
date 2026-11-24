"""
GST credit-note management for posted customer tax invoices.

Credit notes are separate financial documents linked to their
original tax invoices. They preserve historical invoice values,
GST rates, and tax components.

Business rules:
- Only Factory Admin may create, post, or cancel credit notes.
- Accountant/Auditor and Owner have read-only access.
- Credit notes must reference posted original tax invoices.
- Credit-note quantities cannot exceed the uncredited quantities.
- Monetary and GST calculations use exact Decimal arithmetic.
- Posted credit notes are immutable.
- Credits cannot exceed the original invoice's remaining creditable
  amount or reduce its receivable below existing payment allocations.
- Credit-note posting never changes inventory.
- Inventory returns require a separate authorized stock workflow.
- Audit records share the caller's database transaction.

The caller controls transaction commit and rollback.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from uuid import UUID, uuid4

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.models.invoicing import Invoice, InvoiceItem
from app.models.payment import Payment, PaymentAllocation
from app.models.user import User
from app.services.audit_service import create_audit_log
from app.services.invoicing_service import calculate_gst


ZERO = Decimal("0")
MONEY_QUANTUM = Decimal("0.01")
QUANTITY_QUANTUM = Decimal("0.001")

FACTORY_ADMIN_ROLE = "Factory Admin"

READ_ROLES = frozenset(
    {
        "Factory Admin",
        "Accountant/Auditor",
        "Owner",
    }
)

ACTIVE_CREDIT_STATUSES = frozenset(
    {"DRAFT", "POSTED"}
)


def _error(code: int, detail: str) -> HTTPException:
    return HTTPException(status_code=code, detail=detail)


def _decimal(value: object, field: str) -> Decimal:
    if isinstance(value, (bool, float)):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"{field} must use exact decimal arithmetic.",
        )

    try:
        number = Decimal(value)
    except (InvalidOperation, TypeError, ValueError):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"{field} must be a valid decimal.",
        ) from None

    if not number.is_finite():
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"{field} must be finite.",
        )

    return number


def _money(value: Decimal) -> Decimal:
    return value.quantize(
        MONEY_QUANTUM,
        rounding=ROUND_HALF_UP,
    )


def _quantity(value: object) -> Decimal:
    number = _decimal(value, "quantity")

    if (
        number <= ZERO
        or number != number.quantize(QUANTITY_QUANTUM)
    ):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Credit-note quantity must be positive with at most "
            "three decimal places.",
        )

    return number


def _text(
    value: str,
    field: str,
    *,
    maximum_length: int = 100,
) -> str:
    if not isinstance(value, str):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"{field} must be a string.",
        )

    normalized = value.strip()

    if not 1 <= len(normalized) <= maximum_length:
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"{field} must contain 1 to {maximum_length} characters.",
        )

    return normalized


def _financial_year(document_date: date) -> str:
    start_year = (
        document_date.year
        if document_date.month >= 4
        else document_date.year - 1
    )

    return f"{start_year}-{(start_year + 1) % 100:02d}"


def _actor(
    db: Session,
    actor_id: UUID,
    *,
    write: bool = False,
) -> User:
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

    allowed_roles = (
        {FACTORY_ADMIN_ROLE}
        if write
        else READ_ROLES
    )

    if role.role_name not in allowed_roles:
        raise _error(
            status.HTTP_403_FORBIDDEN,
            "Credit-note access is not permitted for this role.",
        )

    return user


def _invoice_query():
    return select(Invoice).options(
        selectinload(Invoice.items)
    )


def _get_invoice(
    db: Session,
    invoice_id: UUID,
    *,
    lock: bool = False,
) -> Invoice:
    statement = _invoice_query().where(
        Invoice.invoice_id == invoice_id
    )

    if lock:
        statement = statement.with_for_update(of=Invoice)

    invoice = db.scalar(statement)

    if invoice is None:
        raise _error(
            status.HTTP_404_NOT_FOUND,
            "Invoice not found.",
        )

    return invoice


def _get_credit_note(
    db: Session,
    credit_note_id: UUID,
    *,
    lock: bool = False,
) -> Invoice:
    credit_note = _get_invoice(
        db,
        credit_note_id,
        lock=lock,
    )

    if credit_note.invoice_type != "CREDIT_NOTE":
        raise _error(
            status.HTTP_404_NOT_FOUND,
            "Credit note not found.",
        )

    return credit_note


def _validate_original(invoice: Invoice) -> None:
    if invoice.invoice_type != "TAX_INVOICE":
        raise _error(
            status.HTTP_409_CONFLICT,
            "Credit notes must reference an original tax invoice.",
        )

    if invoice.status not in {"POSTED", "CREDITED"}:
        raise _error(
            status.HTTP_409_CONFLICT,
            "Only posted tax invoices may receive credit notes.",
        )

    if not invoice.items:
        raise _error(
            status.HTTP_409_CONFLICT,
            "The original tax invoice has no items.",
        )


def _existing_credits(
    db: Session,
    *,
    original_invoice_id: UUID,
    exclude_credit_note_id: UUID | None = None,
    include_drafts: bool = True,
) -> list[Invoice]:
    statuses = (
        ("DRAFT", "POSTED")
        if include_drafts
        else ("POSTED",)
    )

    statement = (
        _invoice_query()
        .where(
            Invoice.original_invoice_id == original_invoice_id,
            Invoice.invoice_type == "CREDIT_NOTE",
            Invoice.status.in_(statuses),
        )
        .order_by(Invoice.invoice_id)
    )

    if exclude_credit_note_id is not None:
        statement = statement.where(
            Invoice.invoice_id != exclude_credit_note_id
        )

    return list(db.scalars(statement).all())


def _credited_quantities(
    credits: Sequence[Invoice],
) -> dict[UUID, Decimal]:
    """
    Aggregate credited quantities by original sales-order line.

    The approved schema retains order_item_id on both original
    invoice lines and credit-note lines.
    """

    quantities: dict[UUID, Decimal] = {}

    for credit in credits:
        for line in credit.items:
            if line.order_item_id is None:
                raise _error(
                    status.HTTP_409_CONFLICT,
                    "An existing credit note has no source order line.",
                )

            quantities[line.order_item_id] = (
                quantities.get(line.order_item_id, ZERO)
                + Decimal(line.quantity)
            )

    return quantities


def _effective_payment_allocations(
    db: Session,
    invoice_id: UUID,
) -> Decimal:
    total = db.scalar(
        select(
            func.coalesce(
                func.sum(PaymentAllocation.allocated_amount),
                ZERO,
            )
        )
        .select_from(PaymentAllocation)
        .join(
            Payment,
            Payment.payment_id == PaymentAllocation.payment_id,
        )
        .where(
            PaymentAllocation.invoice_id == invoice_id,
            Payment.status == "POSTED",
        )
    )

    return Decimal(total or ZERO)


def _credit_totals(
    credit: Invoice,
    *,
    seller_state: str,
) -> dict[str, Decimal]:
    taxable_total = ZERO
    cgst_total = ZERO
    sgst_total = ZERO
    igst_total = ZERO

    for line in credit.items:
        taxable = Decimal(line.taxable_amount)

        tax = calculate_gst(
            taxable_amount=taxable,
            gst_rate=Decimal(line.tax_rate),
            seller_state=seller_state,
            place_of_supply_state=credit.place_of_supply_state,
        )

        line.tax_amount = tax["tax_amount"]
        line.line_total = tax["total_amount"]

        taxable_total += tax["taxable_amount"]
        cgst_total += tax["cgst_amount"]
        sgst_total += tax["sgst_amount"]
        igst_total += tax["igst_amount"]

    totals = {
        "taxable_amount": _money(taxable_total),
        "cgst_amount": _money(cgst_total),
        "sgst_amount": _money(sgst_total),
        "igst_amount": _money(igst_total),
    }

    totals["total_amount"] = (
        totals["taxable_amount"]
        + totals["cgst_amount"]
        + totals["sgst_amount"]
        + totals["igst_amount"]
    )

    return totals


def _set_credit_totals(
    credit: Invoice,
    totals: Mapping[str, Decimal],
) -> None:
    credit.taxable_amount = totals["taxable_amount"]
    credit.cgst_amount = totals["cgst_amount"]
    credit.sgst_amount = totals["sgst_amount"]
    credit.igst_amount = totals["igst_amount"]
    credit.total_amount = totals["total_amount"]


def _validate_credit_limits(
    db: Session,
    *,
    original: Invoice,
    credit: Invoice,
    exclude_credit_note_id: UUID | None = None,
) -> None:
    """
    Enforce quantity, financial, and payment-allocation limits.

    Draft credit notes reserve creditable quantities and amounts
    so concurrent corrections cannot silently over-credit.
    """

    other_credits = _existing_credits(
        db,
        original_invoice_id=original.invoice_id,
        exclude_credit_note_id=exclude_credit_note_id,
    )

    existing_quantities = _credited_quantities(
        other_credits
    )

    original_lines: dict[UUID, InvoiceItem] = {}

    for line in original.items:
        if line.order_item_id is None:
            raise _error(
                status.HTTP_409_CONFLICT,
                "Original invoice line has no sales-order reference.",
            )

        if line.order_item_id in original_lines:
            raise _error(
                status.HTTP_409_CONFLICT,
                "The original invoice has duplicate sales-order lines.",
            )

        original_lines[line.order_item_id] = line

    current_quantities: dict[UUID, Decimal] = {}

    for line in credit.items:
        source = original_lines.get(line.order_item_id)

        if source is None:
            raise _error(
                status.HTTP_409_CONFLICT,
                "Credit-note item does not belong to "
                "the original invoice.",
            )

        if (
            line.product_id != source.product_id
            or line.hsn_code != source.hsn_code
            or Decimal(line.unit_price)
            != Decimal(source.unit_price)
            or Decimal(line.tax_rate)
            != Decimal(source.tax_rate)
        ):
            raise _error(
                status.HTTP_409_CONFLICT,
                "Credit-note product, HSN, price, or GST rate "
                "differs from the original invoice.",
            )

        current_quantities[line.order_item_id] = (
            current_quantities.get(line.order_item_id, ZERO)
            + Decimal(line.quantity)
        )

    for order_item_id, quantity in current_quantities.items():
        original_quantity = Decimal(
            original_lines[order_item_id].quantity
        )

        if (
            existing_quantities.get(order_item_id, ZERO)
            + quantity
            > original_quantity
        ):
            raise _error(
                status.HTTP_409_CONFLICT,
                "Credit-note quantity exceeds the remaining "
                "creditable invoice quantity.",
            )

    existing_total = sum(
        (Decimal(note.total_amount) for note in other_credits),
        ZERO,
    )

    if (
        existing_total + Decimal(credit.total_amount)
        > Decimal(original.total_amount)
    ):
        raise _error(
            status.HTTP_409_CONFLICT,
            "Credit-note amounts exceed the original invoice total.",
        )

    posted_credits = sum(
        (
            Decimal(note.total_amount)
            for note in other_credits
            if note.status == "POSTED"
        ),
        ZERO,
    )

    allocated_payments = _effective_payment_allocations(
        db,
        original.invoice_id,
    )

    if (
        posted_credits
        + Decimal(credit.total_amount)
        + allocated_payments
        > Decimal(original.total_amount)
    ):
        raise _error(
            status.HTTP_409_CONFLICT,
            "The proposed credit exceeds the unpaid receivable. "
            "Existing payment allocations must be resolved "
            "through an authorized financial correction.",
        )


def create_credit_note(
    db: Session,
    *,
    actor_id: UUID,
    original_invoice_id: UUID,
    credit_note_date: date,
    seller_state: str,
    reason: str,
    items: Sequence[Mapping[str, object]],
    credit_note_number: str | None = None,
) -> Invoice:
    """
    Create a draft quantity-based GST credit note.

    Each item contains:
        order_item_id: UUID
        quantity: Decimal

    Original invoice prices, HSN codes, and GST rates are preserved.
    Proportional original discounts are retained where applicable.
    """

    _actor(db, actor_id, write=True)

    if (
        not isinstance(credit_note_date, date)
        or isinstance(credit_note_date, datetime)
    ):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "A valid credit-note date is required.",
        )

    _text(
        reason,
        "reason",
        maximum_length=1000,
    )

    seller = _text(
        seller_state,
        "seller_state",
    )

    original = _get_invoice(
        db,
        original_invoice_id,
        lock=True,
    )

    _validate_original(original)

    if credit_note_date < original.invoice_date:
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Credit-note date cannot precede "
            "the original invoice date.",
        )

    if not items:
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "A credit note requires at least one item.",
        )

    financial_year = _financial_year(
        credit_note_date
    )

    number = (
        _text(
            credit_note_number,
            "credit_note_number",
        )
        if credit_note_number is not None
        else (
            f"CN-{financial_year}-"
            f"{uuid4().hex[:16].upper()}"
        )
    )

    existing_number = db.scalar(
        select(Invoice.invoice_id).where(
            Invoice.financial_year == financial_year,
            Invoice.invoice_number == number,
        )
    )

    if existing_number is not None:
        raise _error(
            status.HTTP_409_CONFLICT,
            "Credit-note number already exists "
            "in this financial year.",
        )

    source_lines = {
        line.order_item_id: line
        for line in original.items
    }

    if len(source_lines) != len(original.items):
        raise _error(
            status.HTTP_409_CONFLICT,
            "Original invoice lines cannot be uniquely identified.",
        )

    seen: set[UUID] = set()
    credit_lines: list[InvoiceItem] = []

    for line_number, data in enumerate(items, start=1):
        if not isinstance(data, Mapping):
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Each credit-note item must be an object.",
            )

        order_item_id = data.get("order_item_id")

        if not isinstance(order_item_id, UUID):
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Each credit-note item requires a valid order_item_id.",
            )

        if order_item_id in seen:
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Duplicate credit-note order lines are not permitted.",
            )

        seen.add(order_item_id)

        source = source_lines.get(order_item_id)

        if source is None:
            raise _error(
                status.HTTP_409_CONFLICT,
                "Credit-note item does not belong "
                "to the original invoice.",
            )

        quantity = _quantity(
            data.get("quantity")
        )

        if quantity > Decimal(source.quantity):
            raise _error(
                status.HTTP_409_CONFLICT,
                "Credit quantity exceeds the original "
                "invoice line quantity.",
            )

        original_quantity = Decimal(source.quantity)
        original_discount = Decimal(source.discount)

        if quantity == original_quantity:
            discount = original_discount
            taxable = Decimal(source.taxable_amount)
        else:
            discount = _money(
                original_discount
                * quantity
                / original_quantity
            )

            gross = _money(
                quantity * Decimal(source.unit_price)
            )

            taxable = gross - discount

        tax = calculate_gst(
            taxable_amount=taxable,
            gst_rate=Decimal(source.tax_rate),
            seller_state=seller,
            place_of_supply_state=original.place_of_supply_state,
        )

        credit_lines.append(
            InvoiceItem(
                line_number=line_number,
                order_item_id=order_item_id,
                product_id=source.product_id,
                hsn_code=source.hsn_code,
                quantity=quantity,
                unit_price=Decimal(source.unit_price),
                discount=discount,
                tax_rate=Decimal(source.tax_rate),
                taxable_amount=tax["taxable_amount"],
                tax_amount=tax["tax_amount"],
                line_total=tax["total_amount"],
            )
        )

    credit = Invoice(
        order_id=original.order_id,
        customer_id=original.customer_id,
        invoice_number=number,
        financial_year=financial_year,
        invoice_date=credit_note_date,
        invoice_type="CREDIT_NOTE",
        place_of_supply_state=original.place_of_supply_state,
        due_date=credit_note_date,
        status="DRAFT",
        original_invoice_id=original.invoice_id,
    )

    credit.items.extend(credit_lines)

    totals = _credit_totals(
        credit,
        seller_state=seller,
    )

    _set_credit_totals(credit, totals)

    _validate_credit_limits(
        db,
        original=original,
        credit=credit,
    )

    db.add(credit)
    db.flush()

    create_audit_log(
        db,
        user_id=actor_id,
        entity_type="Invoice",
        entity_id=credit.invoice_id,
        action="CREDIT_NOTE_CREATED",
        new_values={
            "credit_note_number": credit.invoice_number,
            "original_invoice_id": str(
                original.invoice_id
            ),
            "reason": reason.strip(),
            "status": "DRAFT",
            "seller_state": seller,
            "taxable_amount": str(
                credit.taxable_amount
            ),
            "cgst_amount": str(credit.cgst_amount),
            "sgst_amount": str(credit.sgst_amount),
            "igst_amount": str(credit.igst_amount),
            "total_amount": str(credit.total_amount),
        },
    )

    return credit


def get_credit_note(
    db: Session,
    *,
    credit_note_id: UUID,
    actor_id: UUID,
) -> Invoice:
    """Retrieve a credit note and its item records."""

    _actor(db, actor_id)

    return _get_credit_note(
        db,
        credit_note_id,
    )


def list_credit_notes(
    db: Session,
    *,
    actor_id: UUID,
    original_invoice_id: UUID | None = None,
    customer_id: UUID | None = None,
    credit_note_status: str | None = None,
    page: int = 1,
    page_size: int = 50,
) -> tuple[list[Invoice], int]:
    """Return paginated credit-note records."""

    _actor(db, actor_id)

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

    filters = [
        Invoice.invoice_type == "CREDIT_NOTE"
    ]

    if original_invoice_id is not None:
        filters.append(
            Invoice.original_invoice_id
            == original_invoice_id
        )

    if customer_id is not None:
        filters.append(
            Invoice.customer_id == customer_id
        )

    if credit_note_status is not None:
        if credit_note_status not in {
            "DRAFT",
            "POSTED",
            "CANCELLED",
        }:
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Invalid credit-note status.",
            )

        filters.append(
            Invoice.status == credit_note_status
        )

    total = db.scalar(
        select(func.count())
        .select_from(Invoice)
        .where(*filters)
    ) or 0

    notes = list(
        db.scalars(
            _invoice_query()
            .where(*filters)
            .order_by(
                Invoice.invoice_date.desc(),
                Invoice.invoice_id.desc(),
            )
            .offset((page - 1) * page_size)
            .limit(page_size)
        ).all()
    )

    return notes, total


def post_credit_note(
    db: Session,
    *,
    credit_note_id: UUID,
    actor_id: UUID,
    seller_state: str,
) -> Invoice:
    """
    Post a draft credit note exactly once.

    Posting validates source quantities, tax totals, existing
    credits, and effective payment allocations.

    No inventory movements are generated.
    """

    _actor(db, actor_id, write=True)

    credit = _get_credit_note(
        db,
        credit_note_id,
        lock=True,
    )

    if credit.status == "POSTED":
        return credit

    if credit.status != "DRAFT":
        raise _error(
            status.HTTP_409_CONFLICT,
            "Only draft credit notes may be posted.",
        )

    if credit.original_invoice_id is None:
        raise _error(
            status.HTTP_409_CONFLICT,
            "Credit note has no original invoice reference.",
        )

    original = _get_invoice(
        db,
        credit.original_invoice_id,
        lock=True,
    )

    _validate_original(original)

    if (
        credit.order_id != original.order_id
        or credit.customer_id != original.customer_id
        or credit.place_of_supply_state
        != original.place_of_supply_state
    ):
        raise _error(
            status.HTTP_409_CONFLICT,
            "Credit note does not match its original invoice.",
        )

    if not credit.items:
        raise _error(
            status.HTTP_409_CONFLICT,
            "Cannot post an empty credit note.",
        )

    if credit.invoice_date < original.invoice_date:
        raise _error(
            status.HTTP_409_CONFLICT,
            "Credit-note date precedes original invoice date.",
        )

    if credit.financial_year != _financial_year(
        credit.invoice_date
    ):
        raise _error(
            status.HTTP_409_CONFLICT,
            "Credit-note financial year is invalid.",
        )

    seller = _text(
        seller_state,
        "seller_state",
    )

    old_totals = (
        Decimal(credit.taxable_amount),
        Decimal(credit.cgst_amount),
        Decimal(credit.sgst_amount),
        Decimal(credit.igst_amount),
        Decimal(credit.total_amount),
    )

    for line in credit.items:
        quantity = _quantity(line.quantity)

        gross = _money(
            quantity * Decimal(line.unit_price)
        )

        discount = _decimal(
            line.discount,
            "discount",
        )

        if (
            discount < ZERO
            or discount > gross
            or discount != _money(discount)
            or Decimal(line.taxable_amount)
            != gross - discount
        ):
            raise _error(
                status.HTTP_409_CONFLICT,
                "Credit-note line amounts do not reconcile.",
            )

    calculated = _credit_totals(
        credit,
        seller_state=seller,
    )

    new_totals = (
        calculated["taxable_amount"],
        calculated["cgst_amount"],
        calculated["sgst_amount"],
        calculated["igst_amount"],
        calculated["total_amount"],
    )

    if old_totals != new_totals:
        raise _error(
            status.HTTP_409_CONFLICT,
            "Credit-note GST totals do not reconcile. "
            "Correct the draft before posting.",
        )

    _validate_credit_limits(
        db,
        original=original,
        credit=credit,
        exclude_credit_note_id=credit.invoice_id,
    )

    credit.status = "POSTED"
    credit.posted_at = datetime.now(timezone.utc)

    db.flush()

    posted_credits = _existing_credits(
        db,
        original_invoice_id=original.invoice_id,
        include_drafts=False,
    )

    posted_credit_total = sum(
        (
            Decimal(note.total_amount)
            for note in posted_credits
        ),
        ZERO,
    )

    previous_original_status = original.status

    if posted_credit_total >= Decimal(
        original.total_amount
    ):
        original.status = "CREDITED"

    db.flush()

    create_audit_log(
        db,
        user_id=actor_id,
        entity_type="Invoice",
        entity_id=credit.invoice_id,
        action="CREDIT_NOTE_POSTED",
        old_values={"status": "DRAFT"},
        new_values={
            "status": "POSTED",
            "posted_at": credit.posted_at.isoformat(),
            "original_invoice_id": str(
                original.invoice_id
            ),
            "total_amount": str(credit.total_amount),
        },
    )

    if original.status != previous_original_status:
        create_audit_log(
            db,
            user_id=actor_id,
            entity_type="Invoice",
            entity_id=original.invoice_id,
            action="INVOICE_FULLY_CREDITED",
            old_values={
                "status": previous_original_status,
            },
            new_values={
                "status": original.status,
                "credit_note_id": str(credit.invoice_id),
            },
        )

    return credit


def cancel_draft_credit_note(
    db: Session,
    *,
    credit_note_id: UUID,
    actor_id: UUID,
    reason: str,
) -> Invoice:
    """Cancel an unposted credit note without deleting its history."""

    _actor(db, actor_id, write=True)

    cancellation_reason = _text(
        reason,
        "reason",
        maximum_length=1000,
    )

    credit = _get_credit_note(
        db,
        credit_note_id,
        lock=True,
    )

    if credit.status == "CANCELLED":
        return credit

    if credit.status != "DRAFT":
        raise _error(
            status.HTTP_409_CONFLICT,
            "Posted credit notes cannot be cancelled directly.",
        )

    credit.status = "CANCELLED"

    db.flush()

    create_audit_log(
        db,
        user_id=actor_id,
        entity_type="Invoice",
        entity_id=credit.invoice_id,
        action="CREDIT_NOTE_CANCELLED",
        old_values={"status": "DRAFT"},
        new_values={
            "status": "CANCELLED",
            "reason": cancellation_reason,
        },
    )

    return credit


def get_invoice_credit_balance(
    db: Session,
    *,
    original_invoice_id: UUID,
    actor_id: UUID,
) -> dict[str, object]:
    """
    Return original invoice, credited, paid, and creditable balances.

    Draft credit notes reserve part of the remaining credit capacity.
    """

    _actor(db, actor_id)

    original = _get_invoice(
        db,
        original_invoice_id,
    )

    _validate_original(original)

    credits = _existing_credits(
        db,
        original_invoice_id=original_invoice_id,
    )

    posted_total = sum(
        (
            Decimal(note.total_amount)
            for note in credits
            if note.status == "POSTED"
        ),
        ZERO,
    )

    draft_total = sum(
        (
            Decimal(note.total_amount)
            for note in credits
            if note.status == "DRAFT"
        ),
        ZERO,
    )

    paid = _effective_payment_allocations(
        db,
        original_invoice_id,
    )

    invoice_total = Decimal(
        original.total_amount
    )

    remaining_receivable = max(
        ZERO,
        invoice_total - posted_total - paid,
    )

    remaining_credit_capacity = max(
        ZERO,
        invoice_total - posted_total - draft_total,
    )

    quantities = _credited_quantities(credits)

    lines = []

    for line in original.items:
        original_quantity = Decimal(line.quantity)
        credited_quantity = quantities.get(
            line.order_item_id,
            ZERO,
        )

        lines.append(
            {
                "order_item_id": line.order_item_id,
                "product_id": line.product_id,
                "original_quantity": original_quantity,
                "credited_or_reserved_quantity": credited_quantity,
                "remaining_creditable_quantity": max(
                    ZERO,
                    original_quantity - credited_quantity,
                ),
            }
        )

    return {
        "original_invoice_id": original.invoice_id,
        "invoice_number": original.invoice_number,
        "invoice_status": original.status,
        "invoice_total": invoice_total,
        "posted_credit_total": posted_total,
        "draft_credit_total": draft_total,
        "paid_amount": paid,
        "remaining_receivable": remaining_receivable,
        "remaining_credit_capacity": remaining_credit_capacity,
        "items": lines,
    }