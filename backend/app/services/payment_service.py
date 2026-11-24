"""
Customer payment recording, posting, allocation, and reversal.

Payments support partial settlement, allocation across multiple
invoices, and unapplied customer balances.

Financial integrity rules:
- Only Factory Admin may create, post, allocate, or reverse payments.
- Accountant/Auditor and Owner have read-only access.
- Payment amounts use exact Decimal arithmetic.
- Allocations cannot exceed the payment amount.
- Allocations cannot exceed invoice outstanding balances.
- Payments can be allocated only to invoices of the same customer.
- Only posted payments reduce receivables.
- Reversed payments are excluded from effective settlement.
- Posted financial records are never silently deleted or overwritten.
- All financial changes and audit entries share the caller's transaction.

The service never commits or rolls back the database session.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.models.customer import Customer
from app.models.invoicing import Invoice
from app.models.payment import Payment, PaymentAllocation
from app.models.user import User
from app.services.audit_service import create_audit_log


ZERO = Decimal("0.00")
MONEY_QUANTUM = Decimal("0.01")

FACTORY_ADMIN_ROLE = "Factory Admin"

PAYMENT_READ_ROLES = frozenset(
    {
        "Factory Admin",
        "Accountant/Auditor",
        "Owner",
    }
)

PAYMENT_STATUSES = frozenset(
    {"DRAFT", "POSTED", "REVERSED"}
)


def _error(code: int, detail: str) -> HTTPException:
    return HTTPException(status_code=code, detail=detail)


def _amount(
    value: object,
    field: str = "amount",
    *,
    allow_zero: bool = False,
) -> Decimal:
    """Validate an exact monetary value with two decimal places."""

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

    if (
        number < ZERO
        or (not allow_zero and number == ZERO)
        or number != number.quantize(MONEY_QUANTUM)
    ):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"{field} must be "
            + ("nonnegative" if allow_zero else "positive")
            + " with at most two decimal places.",
        )

    return number.quantize(MONEY_QUANTUM)


def _text(
    value: str,
    field: str,
    *,
    maximum_length: int,
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

    allowed = (
        {FACTORY_ADMIN_ROLE}
        if write
        else PAYMENT_READ_ROLES
    )

    if role.role_name not in allowed:
        raise _error(
            status.HTTP_403_FORBIDDEN,
            "Payment access is not permitted for this role.",
        )

    return user


def _customer(
    db: Session,
    customer_id: UUID,
    *,
    require_active: bool = False,
) -> Customer:
    customer = db.get(Customer, customer_id)

    if customer is None:
        raise _error(
            status.HTTP_404_NOT_FOUND,
            "Customer not found.",
        )

    if require_active and not customer.is_active:
        raise _error(
            status.HTTP_409_CONFLICT,
            "An inactive customer cannot receive new payments.",
        )

    return customer


def _payment(
    db: Session,
    payment_id: UUID,
    *,
    lock: bool = False,
) -> Payment:
    statement = (
        select(Payment)
        .where(Payment.payment_id == payment_id)
        .options(selectinload(Payment.allocations))
    )

    if lock:
        statement = statement.with_for_update(of=Payment)

    payment = db.scalar(statement)

    if payment is None:
        raise _error(
            status.HTTP_404_NOT_FOUND,
            "Payment not found.",
        )

    return payment


def _invoice(
    db: Session,
    invoice_id: UUID,
    *,
    lock: bool = False,
) -> Invoice:
    statement = select(Invoice).where(
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


def _validate_receivable_invoice(
    invoice: Invoice,
    customer_id: UUID,
) -> None:
    if invoice.customer_id != customer_id:
        raise _error(
            status.HTTP_409_CONFLICT,
            "Payment and invoice must belong to the same customer.",
        )

    if invoice.invoice_type != "TAX_INVOICE":
        raise _error(
            status.HTTP_409_CONFLICT,
            "Payments may be allocated only to tax invoices.",
        )

    if invoice.status not in {"POSTED", "CREDITED"}:
        raise _error(
            status.HTTP_409_CONFLICT,
            "Payments may be allocated only to posted tax invoices.",
        )


def _effective_allocated_amount(
    db: Session,
    invoice_id: UUID,
) -> Decimal:
    """
    Return effective allocations from posted, unreversed payments.

    Draft payments and reversed payments do not settle invoices.
    """

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


def _credit_note_amount(
    db: Session,
    invoice_id: UUID,
) -> Decimal:
    """
    Return posted credit-note value against an original invoice.

    Credits reduce receivables independently of customer payments.
    """

    total = db.scalar(
        select(
            func.coalesce(
                func.sum(Invoice.total_amount),
                ZERO,
            )
        )
        .where(
            Invoice.original_invoice_id == invoice_id,
            Invoice.invoice_type == "CREDIT_NOTE",
            Invoice.status == "POSTED",
        )
    )

    return Decimal(total or ZERO)


def _invoice_outstanding(
    db: Session,
    invoice: Invoice,
) -> Decimal:
    if invoice.invoice_type != "TAX_INVOICE":
        raise _error(
            status.HTTP_409_CONFLICT,
            "Outstanding balances apply to tax invoices.",
        )

    if invoice.status not in {"POSTED", "CREDITED"}:
        return ZERO

    total = Decimal(invoice.total_amount)
    allocated = _effective_allocated_amount(
        db,
        invoice.invoice_id,
    )
    credited = _credit_note_amount(
        db,
        invoice.invoice_id,
    )

    return max(
        ZERO,
        total - allocated - credited,
    )


def _payment_allocation_total(
    db: Session,
    payment_id: UUID,
) -> Decimal:
    total = db.scalar(
        select(
            func.coalesce(
                func.sum(PaymentAllocation.allocated_amount),
                ZERO,
            )
        )
        .where(PaymentAllocation.payment_id == payment_id)
    )

    return Decimal(total or ZERO)


def _audit(
    db: Session,
    *,
    actor_id: UUID,
    payment_id: UUID,
    action: str,
    old_values: Mapping[str, object] | None = None,
    new_values: Mapping[str, object] | None = None,
) -> None:
    create_audit_log(
        db,
        user_id=actor_id,
        entity_type="Payment",
        entity_id=payment_id,
        action=action,
        old_values=old_values,
        new_values=new_values,
    )


def create_payment(
    db: Session,
    *,
    actor_id: UUID,
    customer_id: UUID,
    payment_date: date,
    amount: Decimal,
    payment_method: str,
    reference_number: str | None = None,
    notes: str | None = None,
) -> Payment:
    """Create a draft customer payment without settling invoices."""

    _actor(db, actor_id, write=True)
    _customer(
        db,
        customer_id,
        require_active=True,
    )

    if (
        not isinstance(payment_date, date)
        or isinstance(payment_date, datetime)
    ):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "A valid payment date is required.",
        )

    validated_amount = _amount(amount)
    method = _text(
        payment_method,
        "payment_method",
        maximum_length=50,
    )

    reference = (
        _text(
            reference_number,
            "reference_number",
            maximum_length=150,
        )
        if reference_number is not None
        else None
    )

    if notes is not None and not isinstance(notes, str):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Notes must be a string.",
        )

    if reference is not None:
        existing = db.scalar(
            select(Payment)
            .where(
                Payment.customer_id == customer_id,
                Payment.reference_number == reference,
            )
            .with_for_update(of=Payment)
        )

        if existing is not None:
            if (
                existing.payment_date == payment_date
                and Decimal(existing.amount) == validated_amount
                and existing.payment_method == method
            ):
                return existing

            raise _error(
                status.HTTP_409_CONFLICT,
                "Payment reference already exists for this customer "
                "with different transaction details.",
            )

    payment = Payment(
        customer_id=customer_id,
        payment_date=payment_date,
        amount=validated_amount,
        payment_method=method,
        reference_number=reference,
        notes=notes.strip() if notes is not None else None,
        recorded_by=actor_id,
        status="DRAFT",
    )

    db.add(payment)
    db.flush()

    _audit(
        db,
        actor_id=actor_id,
        payment_id=payment.payment_id,
        action="PAYMENT_CREATED",
        new_values={
            "customer_id": str(customer_id),
            "payment_date": payment_date.isoformat(),
            "amount": str(validated_amount),
            "payment_method": method,
            "reference_number": reference,
            "status": "DRAFT",
        },
    )

    return payment


def get_payment(
    db: Session,
    *,
    payment_id: UUID,
    actor_id: UUID,
) -> Payment:
    """Retrieve a payment and its allocation records."""

    _actor(db, actor_id)
    return _payment(db, payment_id)


def list_payments(
    db: Session,
    *,
    actor_id: UUID,
    customer_id: UUID | None = None,
    payment_status: str | None = None,
    start_date: date | None = None,
    end_date: date | None = None,
    page: int = 1,
    page_size: int = 50,
) -> tuple[list[Payment], int]:
    """Return authorized, paginated payment records."""

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

    if (
        start_date is not None
        and end_date is not None
        and start_date > end_date
    ):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Start date cannot exceed end date.",
        )

    filters = []

    if customer_id is not None:
        filters.append(Payment.customer_id == customer_id)

    if payment_status is not None:
        if payment_status not in PAYMENT_STATUSES:
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Invalid payment status.",
            )

        filters.append(Payment.status == payment_status)

    if start_date is not None:
        filters.append(Payment.payment_date >= start_date)

    if end_date is not None:
        filters.append(Payment.payment_date <= end_date)

    total = db.scalar(
        select(func.count())
        .select_from(Payment)
        .where(*filters)
    ) or 0

    payments = list(
        db.scalars(
            select(Payment)
            .options(selectinload(Payment.allocations))
            .where(*filters)
            .order_by(
                Payment.payment_date.desc(),
                Payment.payment_id.desc(),
            )
            .offset((page - 1) * page_size)
            .limit(page_size)
        ).all()
    )

    return payments, total


def allocate_payment(
    db: Session,
    *,
    payment_id: UUID,
    actor_id: UUID,
    invoice_id: UUID,
    amount: Decimal,
) -> PaymentAllocation:
    """
    Allocate part of a draft or posted payment to a tax invoice.

    The invoice is locked to serialize competing allocations.
    The payment is locked to prevent concurrent over-allocation.
    """

    _actor(db, actor_id, write=True)

    payment = _payment(
        db,
        payment_id,
        lock=True,
    )

    if payment.status == "REVERSED":
        raise _error(
            status.HTTP_409_CONFLICT,
            "Reversed payments cannot receive allocations.",
        )

    invoice = _invoice(
        db,
        invoice_id,
        lock=True,
    )

    _validate_receivable_invoice(
        invoice,
        payment.customer_id,
    )

    allocation_amount = _amount(
        amount,
        "allocated_amount",
    )

    existing = db.scalar(
        select(PaymentAllocation)
        .where(
            PaymentAllocation.payment_id == payment_id,
            PaymentAllocation.invoice_id == invoice_id,
        )
        .with_for_update(of=PaymentAllocation)
    )

    if existing is not None:
        raise _error(
            status.HTTP_409_CONFLICT,
            "This payment already has an allocation "
            "to the selected invoice.",
        )

    allocated_total = _payment_allocation_total(
        db,
        payment_id,
    )

    if allocated_total + allocation_amount > Decimal(
        payment.amount
    ):
        raise _error(
            status.HTTP_409_CONFLICT,
            "Allocation exceeds the payment's unapplied balance.",
        )

    outstanding = _invoice_outstanding(
        db,
        invoice,
    )

    if allocation_amount > outstanding:
        raise _error(
            status.HTTP_409_CONFLICT,
            "Allocation exceeds the invoice's outstanding balance.",
        )

    allocation = PaymentAllocation(
        payment_id=payment_id,
        invoice_id=invoice_id,
        allocated_amount=allocation_amount,
    )

    db.add(allocation)
    db.flush()

    _audit(
        db,
        actor_id=actor_id,
        payment_id=payment_id,
        action="PAYMENT_ALLOCATED",
        new_values={
            "allocation_id": str(allocation.allocation_id),
            "invoice_id": str(invoice_id),
            "allocated_amount": str(allocation_amount),
            "payment_status": payment.status,
        },
    )

    return allocation


def allocate_payment_batch(
    db: Session,
    *,
    payment_id: UUID,
    actor_id: UUID,
    allocations: Sequence[Mapping[str, object]],
) -> list[PaymentAllocation]:
    """
    Allocate a payment across multiple invoices.

    The entire batch participates in the caller's transaction.
    Duplicate invoice IDs in one request are rejected.
    """

    _actor(db, actor_id, write=True)

    if not allocations:
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "At least one invoice allocation is required.",
        )

    seen: set[UUID] = set()
    normalized: list[tuple[UUID, Decimal]] = []

    for entry in allocations:
        if not isinstance(entry, Mapping):
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Each allocation must be an object.",
            )

        invoice_id = entry.get("invoice_id")

        if not isinstance(invoice_id, UUID):
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Each allocation requires a valid invoice_id.",
            )

        if invoice_id in seen:
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Duplicate invoice allocations are not permitted.",
            )

        seen.add(invoice_id)

        normalized.append(
            (
                invoice_id,
                _amount(
                    entry.get("allocated_amount"),
                    "allocated_amount",
                ),
            )
        )

    payment = _payment(
        db,
        payment_id,
        lock=True,
    )

    if payment.status == "REVERSED":
        raise _error(
            status.HTTP_409_CONFLICT,
            "Reversed payments cannot receive allocations.",
        )

    requested_total = sum(
        (amount for _, amount in normalized),
        ZERO,
    )

    remaining_payment = (
        Decimal(payment.amount)
        - _payment_allocation_total(db, payment_id)
    )

    if requested_total > remaining_payment:
        raise _error(
            status.HTTP_409_CONFLICT,
            "Requested allocations exceed the unapplied "
            "payment balance.",
        )

    for invoice_id, amount in sorted(
        normalized,
        key=lambda entry: str(entry[0]),
    ):
        invoice = _invoice(
            db,
            invoice_id,
            lock=True,
        )

        _validate_receivable_invoice(
            invoice,
            payment.customer_id,
        )

        if amount > _invoice_outstanding(db, invoice):
            raise _error(
                status.HTTP_409_CONFLICT,
                "An allocation exceeds its invoice's "
                "outstanding balance.",
            )

        if db.scalar(
            select(PaymentAllocation.allocation_id).where(
                PaymentAllocation.payment_id == payment_id,
                PaymentAllocation.invoice_id == invoice_id,
            )
        ) is not None:
            raise _error(
                status.HTTP_409_CONFLICT,
                "A payment allocation already exists "
                "for one of the selected invoices.",
            )

    created: list[PaymentAllocation] = []

    for invoice_id, amount in normalized:
        allocation = PaymentAllocation(
            payment_id=payment_id,
            invoice_id=invoice_id,
            allocated_amount=amount,
        )

        db.add(allocation)
        created.append(allocation)

    db.flush()

    _audit(
        db,
        actor_id=actor_id,
        payment_id=payment_id,
        action="PAYMENT_BATCH_ALLOCATED",
        new_values={
            "allocations": [
                {
                    "allocation_id": str(
                        allocation.allocation_id
                    ),
                    "invoice_id": str(allocation.invoice_id),
                    "allocated_amount": str(
                        allocation.allocated_amount
                    ),
                }
                for allocation in created
            ],
            "total_allocated": str(requested_total),
        },
    )

    return created


def post_payment(
    db: Session,
    *,
    payment_id: UUID,
    actor_id: UUID,
) -> Payment:
    """
    Post a payment exactly once.

    Allocations are optional: an entirely unapplied payment is
    permitted. Existing allocations are revalidated against the
    latest outstanding balances before posting.
    """

    _actor(db, actor_id, write=True)

    payment = _payment(
        db,
        payment_id,
        lock=True,
    )

    if payment.status == "POSTED":
        return payment

    if payment.status != "DRAFT":
        raise _error(
            status.HTTP_409_CONFLICT,
            "Only draft payments may be posted.",
        )

    _customer(
        db,
        payment.customer_id,
        require_active=True,
    )

    allocations = list(
        db.scalars(
            select(PaymentAllocation)
            .where(
                PaymentAllocation.payment_id == payment_id
            )
            .order_by(PaymentAllocation.invoice_id)
            .with_for_update(of=PaymentAllocation)
        ).all()
    )

    allocated_total = sum(
        (
            Decimal(allocation.allocated_amount)
            for allocation in allocations
        ),
        ZERO,
    )

    if allocated_total > Decimal(payment.amount):
        raise _error(
            status.HTTP_409_CONFLICT,
            "Payment allocations exceed the payment amount.",
        )

    for allocation in allocations:
        invoice = _invoice(
            db,
            allocation.invoice_id,
            lock=True,
        )

        _validate_receivable_invoice(
            invoice,
            payment.customer_id,
        )

        if Decimal(allocation.allocated_amount) > (
            _invoice_outstanding(db, invoice)
        ):
            raise _error(
                status.HTTP_409_CONFLICT,
                "A payment allocation exceeds the invoice's "
                "current outstanding balance.",
            )

    payment.status = "POSTED"
    payment.posted_at = datetime.now(timezone.utc)

    db.flush()

    _audit(
        db,
        actor_id=actor_id,
        payment_id=payment_id,
        action="PAYMENT_POSTED",
        old_values={"status": "DRAFT"},
        new_values={
            "status": "POSTED",
            "posted_at": payment.posted_at.isoformat(),
            "amount": str(payment.amount),
            "allocated_amount": str(allocated_total),
            "unallocated_amount": str(
                Decimal(payment.amount) - allocated_total
            ),
        },
    )

    return payment


def reverse_payment(
    db: Session,
    *,
    payment_id: UUID,
    actor_id: UUID,
    reason: str,
) -> Payment:
    """
    Reverse a posted payment while preserving its original allocations.

    Reversed payments cease to contribute to effective invoice
    settlement. Their historical allocation records remain intact.
    """

    _actor(db, actor_id, write=True)

    if not isinstance(reason, str) or not reason.strip():
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "A reversal reason is required.",
        )

    payment = _payment(
        db,
        payment_id,
        lock=True,
    )

    if payment.status == "REVERSED":
        return payment

    if payment.status != "POSTED":
        raise _error(
            status.HTTP_409_CONFLICT,
            "Only posted payments may be reversed.",
        )

    payment.status = "REVERSED"
    payment.reversed_at = datetime.now(timezone.utc)

    db.flush()

    _audit(
        db,
        actor_id=actor_id,
        payment_id=payment_id,
        action="PAYMENT_REVERSED",
        old_values={
            "status": "POSTED",
            "amount": str(payment.amount),
        },
        new_values={
            "status": "REVERSED",
            "reversed_at": payment.reversed_at.isoformat(),
            "reason": reason.strip(),
        },
    )

    return payment


def cancel_draft_payment(
    db: Session,
    *,
    payment_id: UUID,
    actor_id: UUID,
    reason: str,
) -> Payment:
    """
    Reject direct cancellation of a draft financial record.

    The existing Payment model supports only DRAFT, POSTED,
    and REVERSED. Reversal requires a previously posted payment.
    Therefore draft cancellation cannot be represented without
    changing the approved database status model.
    """

    _actor(db, actor_id, write=True)
    _payment(db, payment_id)

    raise _error(
        status.HTTP_409_CONFLICT,
        "Draft payment cancellation is not supported by the "
        "approved payment status model. Review the draft or "
        "post and reverse it through the authorized workflow.",
    )


def get_invoice_payment_balance(
    db: Session,
    *,
    invoice_id: UUID,
    actor_id: UUID,
) -> dict[str, object]:
    """Return invoice total, credits, collections, and outstanding."""

    _actor(db, actor_id)

    invoice = _invoice(db, invoice_id)

    if invoice.invoice_type != "TAX_INVOICE":
        raise _error(
            status.HTTP_409_CONFLICT,
            "Payment balances apply to tax invoices.",
        )

    total = Decimal(invoice.total_amount)

    paid = _effective_allocated_amount(
        db,
        invoice_id,
    )

    credited = _credit_note_amount(
        db,
        invoice_id,
    )

    outstanding = _invoice_outstanding(
        db,
        invoice,
    )

    return {
        "invoice_id": invoice.invoice_id,
        "customer_id": invoice.customer_id,
        "invoice_number": invoice.invoice_number,
        "invoice_status": invoice.status,
        "invoice_total": total,
        "credited_amount": credited,
        "paid_amount": paid,
        "outstanding_amount": outstanding,
        "is_fully_paid": (
            invoice.status in {"POSTED", "CREDITED"}
            and outstanding == ZERO
        ),
        "is_partially_paid": (
            paid > ZERO and outstanding > ZERO
        ),
        "is_overdue": (
            invoice.status in {"POSTED", "CREDITED"}
            and outstanding > ZERO
            and invoice.due_date < date.today()
        ),
    }


def get_payment_allocation_balance(
    db: Session,
    *,
    payment_id: UUID,
    actor_id: UUID,
) -> dict[str, object]:
    """Return the allocation and unapplied balance of a payment."""

    _actor(db, actor_id)

    payment = _payment(db, payment_id)

    allocated = _payment_allocation_total(
        db,
        payment_id,
    )

    amount = Decimal(payment.amount)

    return {
        "payment_id": payment.payment_id,
        "customer_id": payment.customer_id,
        "payment_status": payment.status,
        "payment_amount": amount,
        "allocated_amount": allocated,
        "unallocated_amount": amount - allocated,
        "effective_allocated_amount": (
            allocated if payment.status == "POSTED" else ZERO
        ),
        "allocations": [
            {
                "allocation_id": allocation.allocation_id,
                "invoice_id": allocation.invoice_id,
                "allocated_amount": Decimal(
                    allocation.allocated_amount
                ),
            }
            for allocation in payment.allocations
        ],
    }


def get_customer_receivables(
    db: Session,
    *,
    customer_id: UUID,
    actor_id: UUID,
) -> dict[str, object]:
    """
    Calculate customer receivables from posted tax invoices,
    posted credit notes, and effective posted payment allocations.
    """

    _actor(db, actor_id)
    _customer(db, customer_id)

    invoices = list(
        db.scalars(
            select(Invoice)
            .where(
                Invoice.customer_id == customer_id,
                Invoice.invoice_type == "TAX_INVOICE",
                Invoice.status.in_(("POSTED", "CREDITED")),
            )
            .order_by(
                Invoice.invoice_date,
                Invoice.invoice_id,
            )
        ).all()
    )

    rows: list[dict[str, object]] = []

    invoice_total = ZERO
    credited_total = ZERO
    paid_total = ZERO
    outstanding_total = ZERO

    for invoice in invoices:
        total = Decimal(invoice.total_amount)
        credited = _credit_note_amount(
            db,
            invoice.invoice_id,
        )
        paid = _effective_allocated_amount(
            db,
            invoice.invoice_id,
        )
        outstanding = max(
            ZERO,
            total - credited - paid,
        )

        invoice_total += total
        credited_total += credited
        paid_total += paid
        outstanding_total += outstanding

        rows.append(
            {
                "invoice_id": invoice.invoice_id,
                "invoice_number": invoice.invoice_number,
                "invoice_date": invoice.invoice_date,
                "due_date": invoice.due_date,
                "invoice_total": total,
                "credited_amount": credited,
                "paid_amount": paid,
                "outstanding_amount": outstanding,
                "is_overdue": (
                    outstanding > ZERO
                    and invoice.due_date < date.today()
                ),
            }
        )

    unapplied = db.scalar(
        select(
            func.coalesce(
                func.sum(Payment.amount),
                ZERO,
            )
        )
        .where(
            Payment.customer_id == customer_id,
            Payment.status == "POSTED",
        )
    )

    posted_payments_total = Decimal(unapplied or ZERO)

    posted_allocations_total = db.scalar(
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
            Payment.customer_id == customer_id,
            Payment.status == "POSTED",
        )
    )

    unapplied_total = max(
        ZERO,
        posted_payments_total
        - Decimal(posted_allocations_total or ZERO),
    )

    return {
        "customer_id": customer_id,
        "invoice_total": invoice_total,
        "credited_total": credited_total,
        "paid_total": paid_total,
        "outstanding_total": outstanding_total,
        "unapplied_payment_total": unapplied_total,
        "invoices": rows,
    }