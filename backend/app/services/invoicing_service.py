"""
GST invoice creation, validation, posting, and retrieval.

Invoices use the approved sales order's historical quantities, prices,
and GST rates. Tax calculations use Decimal arithmetic exclusively.

Intra-state supplies attract equal CGST and SGST. Inter-state supplies
attract IGST. The seller's registered state must be supplied explicitly;
it is never inferred from the customer's address.

Invoice posting does not modify inventory. Stock is deducted only when
the corresponding dispatch is posted.

The caller owns the database transaction. This service does not commit.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from uuid import UUID, uuid4

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.models.customer import Customer
from app.models.invoicing import Invoice, InvoiceItem
from app.models.product import Product
from app.models.sales import SalesOrder, SalesOrderItem
from app.models.user import User
from app.services.audit_service import create_audit_log


ZERO = Decimal("0")
MONEY_QUANTUM = Decimal("0.01")
QUANTITY_QUANTUM = Decimal("0.001")
TAX_RATE_QUANTUM = Decimal("0.0001")

FACTORY_ADMIN = "Factory Admin"

INVOICE_READ_ROLES = frozenset(
    {
        "Factory Admin",
        "Accountant/Auditor",
        "Owner",
        "Salesman",
    }
)

INVOICE_STATUSES = frozenset(
    {"DRAFT", "POSTED", "CANCELLED", "CREDITED"}
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
            "Quantity must be positive with at most "
            "three decimal places.",
        )

    return number


def _price(value: object) -> Decimal:
    number = _decimal(value, "unit price")

    if (
        number < ZERO
        or number != number.quantize(MONEY_QUANTUM)
    ):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Unit price must be nonnegative with at most "
            "two decimal places.",
        )

    return number


def _tax_rate(value: object) -> Decimal:
    number = _decimal(value, "GST rate")

    if (
        not ZERO <= number <= Decimal("100")
        or number != number.quantize(TAX_RATE_QUANTUM)
    ):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "GST rate must be between 0 and 100 with "
            "at most four decimal places.",
        )

    return number


def _state(value: str, field: str) -> str:
    if not isinstance(value, str):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"{field} must be a string.",
        )

    normalized = " ".join(value.strip().split())

    if not 1 <= len(normalized) <= 100:
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"{field} must contain 1 to 100 characters.",
        )

    return normalized


def _financial_year(invoice_date: date) -> str:
    """Return the Indian April-to-March financial year."""

    start = (
        invoice_date.year
        if invoice_date.month >= 4
        else invoice_date.year - 1
    )

    return f"{start}-{(start + 1) % 100:02d}"


def _actor(db: Session, actor_id: UUID) -> tuple[User, str]:
    user = db.get(User, actor_id)

    if user is None or not user.is_active:
        raise _error(
            status.HTTP_403_FORBIDDEN,
            "An active user account is required.",
        )

    role = user.primary_role

    if role is None or role.role_name not in INVOICE_READ_ROLES:
        raise _error(
            status.HTTP_403_FORBIDDEN,
            "Invoice access is not permitted.",
        )

    return user, role.role_name


def _require_admin(db: Session, actor_id: UUID) -> User:
    user, role = _actor(db, actor_id)

    if role != FACTORY_ADMIN:
        raise _error(
            status.HTTP_403_FORBIDDEN,
            "Factory Admin authorization is required.",
        )

    return user


def _order(
    db: Session,
    order_id: UUID,
    *,
    lock: bool = False,
) -> SalesOrder:
    statement = (
        select(SalesOrder)
        .where(SalesOrder.sales_order_id == order_id)
        .options(selectinload(SalesOrder.items))
    )

    if lock:
        statement = statement.with_for_update(of=SalesOrder)

    order = db.scalar(statement)

    if order is None:
        raise _error(
            status.HTTP_404_NOT_FOUND,
            "Sales order not found.",
        )

    return order


def _invoice(
    db: Session,
    invoice_id: UUID,
    *,
    lock: bool = False,
) -> Invoice:
    statement = (
        select(Invoice)
        .where(Invoice.invoice_id == invoice_id)
        .options(selectinload(Invoice.items))
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


def _check_read_access(
    db: Session,
    *,
    invoice: Invoice,
    actor_id: UUID,
) -> None:
    _, role = _actor(db, actor_id)

    if role == "Salesman":
        order = _order(db, invoice.order_id)

        if order.salesman_id != actor_id:
            raise _error(
                status.HTTP_403_FORBIDDEN,
                "Access to this invoice is not permitted.",
            )

        customer = db.get(Customer, invoice.customer_id)

        if (
            customer is None
            or customer.assigned_salesman_id != actor_id
        ):
            raise _error(
                status.HTTP_403_FORBIDDEN,
                "Access to this customer's invoice is not permitted.",
            )


def _validate_approved_order(order: SalesOrder) -> None:
    if order.approval_status != "APPROVED":
        raise _error(
            status.HTTP_409_CONFLICT,
            "Only approved sales orders may be invoiced.",
        )

    if not order.items:
        raise _error(
            status.HTTP_409_CONFLICT,
            "An approved order must contain at least one item.",
        )


def _customer(db: Session, customer_id: UUID) -> Customer:
    customer = db.get(Customer, customer_id)

    if customer is None:
        raise _error(
            status.HTTP_404_NOT_FOUND,
            "Customer not found.",
        )

    if not customer.is_active:
        raise _error(
            status.HTTP_409_CONFLICT,
            "An inactive customer cannot receive a new invoice.",
        )

    return customer


def calculate_gst(
    *,
    taxable_amount: Decimal,
    gst_rate: Decimal,
    seller_state: str,
    place_of_supply_state: str,
) -> dict[str, Decimal]:
    """
    Calculate line-level GST using half-up monetary rounding.

    For intra-state transactions, each component is calculated
    independently at half the full GST rate.
    """

    taxable = _decimal(taxable_amount, "taxable amount")
    rate = _tax_rate(gst_rate)

    if taxable < ZERO:
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Taxable amount cannot be negative.",
        )

    if taxable != _money(taxable):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Taxable amount must have at most two decimal places.",
        )

    seller = _state(seller_state, "seller_state")
    destination = _state(
        place_of_supply_state,
        "place_of_supply_state",
    )

    if seller.casefold() == destination.casefold():
        component = _money(
            taxable * rate / Decimal("200")
        )
        cgst = component
        sgst = component
        igst = ZERO
    else:
        cgst = ZERO
        sgst = ZERO
        igst = _money(
            taxable * rate / Decimal("100")
        )

    return {
        "taxable_amount": taxable,
        "cgst_amount": cgst,
        "sgst_amount": sgst,
        "igst_amount": igst,
        "tax_amount": cgst + sgst + igst,
        "total_amount": taxable + cgst + sgst + igst,
    }


def _previously_invoiced_quantities(
    db: Session,
    *,
    order_id: UUID,
    exclude_invoice_id: UUID | None = None,
) -> dict[UUID, Decimal]:
    """
    Return quantities already committed to active tax invoices.

    Draft, posted, and credited tax invoices count against the
    original order. Cancelled invoices do not. Credit notes are
    handled separately and do not automatically permit re-invoicing.
    """

    statement = (
        select(
            InvoiceItem.order_item_id,
            func.sum(InvoiceItem.quantity),
        )
        .join(
            Invoice,
            Invoice.invoice_id == InvoiceItem.invoice_id,
        )
        .where(
            Invoice.order_id == order_id,
            Invoice.invoice_type == "TAX_INVOICE",
            Invoice.status.in_(
                ("DRAFT", "POSTED", "CREDITED")
            ),
        )
        .group_by(InvoiceItem.order_item_id)
    )

    if exclude_invoice_id is not None:
        statement = statement.where(
            Invoice.invoice_id != exclude_invoice_id
        )

    return {
        order_item_id: Decimal(quantity)
        for order_item_id, quantity in db.execute(statement)
        if order_item_id is not None
    }


def _invoice_lines(
    db: Session,
    *,
    order: SalesOrder,
    items: Sequence[Mapping[str, object]],
    seller_state: str,
    place_of_supply_state: str,
    exclude_invoice_id: UUID | None = None,
) -> list[InvoiceItem]:
    if not items:
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "An invoice requires at least one item.",
        )

    order_lines = {
        line.sales_order_item_id: line
        for line in order.items
    }

    previously_invoiced = _previously_invoiced_quantities(
        db,
        order_id=order.sales_order_id,
        exclude_invoice_id=exclude_invoice_id,
    )

    seen: set[UUID] = set()
    result: list[InvoiceItem] = []

    for line_number, data in enumerate(items, start=1):
        order_item_id = data.get("order_item_id")

        if not isinstance(order_item_id, UUID):
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Each invoice line requires a valid order_item_id.",
            )

        if order_item_id in seen:
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Duplicate sales-order lines are not permitted.",
            )

        seen.add(order_item_id)

        source = order_lines.get(order_item_id)

        if source is None:
            raise _error(
                status.HTTP_409_CONFLICT,
                "Invoice line does not belong to the approved order.",
            )

        quantity = _quantity(data.get("quantity"))

        remaining = (
            Decimal(source.quantity)
            - previously_invoiced.get(order_item_id, ZERO)
        )

        if quantity > remaining:
            raise _error(
                status.HTTP_409_CONFLICT,
                "Invoice quantity exceeds the remaining "
                "authorized order quantity.",
            )

        product = db.get(Product, source.product_id)

        if product is None:
            raise _error(
                status.HTTP_409_CONFLICT,
                "An ordered product no longer has a valid master record.",
            )

        hsn_code = product.hsn_code

        if not isinstance(hsn_code, str) or not hsn_code.strip():
            raise _error(
                status.HTTP_409_CONFLICT,
                "An HSN code is required for each invoiced product.",
            )

        unit_price = _price(source.unit_price)
        tax_rate = _tax_rate(source.tax_rate)

        discount = _decimal(
            data.get("discount", ZERO),
            "discount",
        )

        if (
            discount < ZERO
            or discount != _money(discount)
        ):
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Discount must be nonnegative with at most "
                "two decimal places.",
            )

        gross_amount = _money(quantity * unit_price)

        if discount > gross_amount:
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Discount cannot exceed the gross line amount.",
            )

        taxable = gross_amount - discount

        tax = calculate_gst(
            taxable_amount=taxable,
            gst_rate=tax_rate,
            seller_state=seller_state,
            place_of_supply_state=place_of_supply_state,
        )

        result.append(
            InvoiceItem(
                line_number=line_number,
                order_item_id=order_item_id,
                product_id=source.product_id,
                hsn_code=hsn_code.strip(),
                quantity=quantity,
                unit_price=unit_price,
                discount=discount,
                tax_rate=tax_rate,
                taxable_amount=tax["taxable_amount"],
                tax_amount=tax["tax_amount"],
                line_total=tax["total_amount"],
            )
        )

    return result


def _recalculate_invoice(
    invoice: Invoice,
    *,
    seller_state: str,
) -> None:
    """Recalculate every invoice total from persisted line values."""

    taxable_total = ZERO
    cgst_total = ZERO
    sgst_total = ZERO
    igst_total = ZERO

    for line in invoice.items:
        tax = calculate_gst(
            taxable_amount=Decimal(line.taxable_amount),
            gst_rate=Decimal(line.tax_rate),
            seller_state=seller_state,
            place_of_supply_state=invoice.place_of_supply_state,
        )

        line.tax_amount = tax["tax_amount"]
        line.line_total = tax["total_amount"]

        taxable_total += tax["taxable_amount"]
        cgst_total += tax["cgst_amount"]
        sgst_total += tax["sgst_amount"]
        igst_total += tax["igst_amount"]

    invoice.taxable_amount = _money(taxable_total)
    invoice.cgst_amount = _money(cgst_total)
    invoice.sgst_amount = _money(sgst_total)
    invoice.igst_amount = _money(igst_total)

    invoice.total_amount = (
        invoice.taxable_amount
        + invoice.cgst_amount
        + invoice.sgst_amount
        + invoice.igst_amount
    )


def create_invoice(
    db: Session,
    *,
    actor_id: UUID,
    order_id: UUID,
    invoice_date: date,
    due_date: date,
    seller_state: str,
    items: Sequence[Mapping[str, object]],
    place_of_supply_state: str | None = None,
    invoice_number: str | None = None,
) -> Invoice:
    """
    Create a draft GST tax invoice against an approved order.

    Partial invoicing is supported. The remaining quantities are
    calculated across existing non-cancelled tax invoices.
    """

    _require_admin(db, actor_id)

    if (
        not isinstance(invoice_date, date)
        or isinstance(invoice_date, datetime)
        or not isinstance(due_date, date)
        or isinstance(due_date, datetime)
    ):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Valid invoice and due dates are required.",
        )

    if due_date < invoice_date:
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Invoice due date cannot precede invoice date.",
        )

    seller = _state(seller_state, "seller_state")
    order = _order(db, order_id, lock=True)
    _validate_approved_order(order)

    customer = _customer(db, order.customer_id)

    destination = _state(
        place_of_supply_state
        if place_of_supply_state is not None
        else customer.state,
        "place_of_supply_state",
    )

    financial_year = _financial_year(invoice_date)

    if invoice_number is None:
        number = f"INV-{financial_year}-{uuid4().hex[:16].upper()}"
    else:
        if not isinstance(invoice_number, str):
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Invoice number must be a string.",
            )

        number = invoice_number.strip()

        if not 1 <= len(number) <= 100:
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Invoice number must contain 1 to 100 characters.",
            )

    if db.scalar(
        select(Invoice.invoice_id).where(
            Invoice.financial_year == financial_year,
            Invoice.invoice_number == number,
        )
    ) is not None:
        raise _error(
            status.HTTP_409_CONFLICT,
            "Invoice number already exists in this financial year.",
        )

    invoice_lines = _invoice_lines(
        db,
        order=order,
        items=items,
        seller_state=seller,
        place_of_supply_state=destination,
    )

    invoice = Invoice(
        order_id=order_id,
        customer_id=order.customer_id,
        invoice_number=number,
        financial_year=financial_year,
        invoice_date=invoice_date,
        invoice_type="TAX_INVOICE",
        place_of_supply_state=destination,
        due_date=due_date,
        status="DRAFT",
    )

    invoice.items.extend(invoice_lines)

    _recalculate_invoice(
        invoice,
        seller_state=seller,
    )

    db.add(invoice)
    db.flush()

    create_audit_log(
        db,
        user_id=actor_id,
        entity_type="Invoice",
        entity_id=invoice.invoice_id,
        action="INVOICE_CREATED",
        new_values={
            "order_id": str(order_id),
            "customer_id": str(order.customer_id),
            "invoice_number": invoice.invoice_number,
            "financial_year": financial_year,
            "invoice_type": "TAX_INVOICE",
            "status": "DRAFT",
            "seller_state": seller,
            "place_of_supply_state": destination,
            "taxable_amount": str(invoice.taxable_amount),
            "cgst_amount": str(invoice.cgst_amount),
            "sgst_amount": str(invoice.sgst_amount),
            "igst_amount": str(invoice.igst_amount),
            "total_amount": str(invoice.total_amount),
        },
    )

    return invoice


def get_invoice(
    db: Session,
    *,
    invoice_id: UUID,
    actor_id: UUID,
) -> Invoice:
    """Return an invoice after enforcing role and customer access."""

    invoice = _invoice(db, invoice_id)

    _check_read_access(
        db,
        invoice=invoice,
        actor_id=actor_id,
    )

    return invoice


def list_invoices(
    db: Session,
    *,
    actor_id: UUID,
    customer_id: UUID | None = None,
    order_id: UUID | None = None,
    invoice_status: str | None = None,
    financial_year: str | None = None,
    page: int = 1,
    page_size: int = 50,
) -> tuple[list[Invoice], int]:
    """Return paginated invoices within the caller's permissions."""

    _, role = _actor(db, actor_id)

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

    if role == "Salesman":
        filters.append(
            Invoice.order_id.in_(
                select(SalesOrder.sales_order_id).where(
                    SalesOrder.salesman_id == actor_id
                )
            )
        )

        filters.append(
            Invoice.customer_id.in_(
                select(Customer.customer_id).where(
                    Customer.assigned_salesman_id == actor_id
                )
            )
        )

    if customer_id is not None:
        filters.append(Invoice.customer_id == customer_id)

    if order_id is not None:
        filters.append(Invoice.order_id == order_id)

    if invoice_status is not None:
        if invoice_status not in INVOICE_STATUSES:
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Invalid invoice status.",
            )

        filters.append(Invoice.status == invoice_status)

    if financial_year is not None:
        filters.append(
            Invoice.financial_year == financial_year
        )

    total = db.scalar(
        select(func.count())
        .select_from(Invoice)
        .where(*filters)
    ) or 0

    invoices = list(
        db.scalars(
            select(Invoice)
            .options(selectinload(Invoice.items))
            .where(*filters)
            .order_by(
                Invoice.invoice_date.desc(),
                Invoice.invoice_id.desc(),
            )
            .offset((page - 1) * page_size)
            .limit(page_size)
        ).all()
    )

    return invoices, total


def update_draft_invoice(
    db: Session,
    *,
    invoice_id: UUID,
    actor_id: UUID,
    seller_state: str,
    due_date: date | None = None,
    place_of_supply_state: str | None = None,
    items: Sequence[Mapping[str, object]] | None = None,
) -> Invoice:
    """
    Update an unposted invoice.

    Draft invoice lines may be replaced because they have not
    become immutable accounting records.
    """

    _require_admin(db, actor_id)

    invoice = _invoice(db, invoice_id, lock=True)

    if invoice.status != "DRAFT":
        raise _error(
            status.HTTP_409_CONFLICT,
            "Only draft invoices may be edited.",
        )

    if invoice.invoice_type != "TAX_INVOICE":
        raise _error(
            status.HTTP_409_CONFLICT,
            "Credit-note corrections require the credit-note workflow.",
        )

    seller = _state(seller_state, "seller_state")

    order = _order(db, invoice.order_id, lock=True)
    _validate_approved_order(order)

    old_values = {
        "due_date": str(invoice.due_date),
        "place_of_supply_state": invoice.place_of_supply_state,
        "total_amount": str(invoice.total_amount),
    }

    if due_date is not None:
        if due_date < invoice.invoice_date:
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Due date cannot precede invoice date.",
            )

        invoice.due_date = due_date

    if place_of_supply_state is not None:
        invoice.place_of_supply_state = _state(
            place_of_supply_state,
            "place_of_supply_state",
        )

    if items is not None:
        replacement = _invoice_lines(
            db,
            order=order,
            items=items,
            seller_state=seller,
            place_of_supply_state=invoice.place_of_supply_state,
            exclude_invoice_id=invoice.invoice_id,
        )

        existing = list(invoice.items)

        if len(replacement) < len(existing):
            raise _error(
                status.HTTP_409_CONFLICT,
                "Removing existing invoice lines requires "
                "a dedicated authorized correction workflow.",
            )

        for index, line in enumerate(replacement):
            if index < len(existing):
                target = existing[index]

                target.order_item_id = line.order_item_id
                target.product_id = line.product_id
                target.hsn_code = line.hsn_code
                target.quantity = line.quantity
                target.unit_price = line.unit_price
                target.discount = line.discount
                target.tax_rate = line.tax_rate
                target.taxable_amount = line.taxable_amount
                target.tax_amount = line.tax_amount
                target.line_total = line.line_total
            else:
                invoice.items.append(line)

    _recalculate_invoice(
        invoice,
        seller_state=seller,
    )

    db.flush()

    create_audit_log(
        db,
        user_id=actor_id,
        entity_type="Invoice",
        entity_id=invoice.invoice_id,
        action="INVOICE_DRAFT_UPDATED",
        old_values=old_values,
        new_values={
            "due_date": str(invoice.due_date),
            "place_of_supply_state": invoice.place_of_supply_state,
            "seller_state": seller,
            "taxable_amount": str(invoice.taxable_amount),
            "cgst_amount": str(invoice.cgst_amount),
            "sgst_amount": str(invoice.sgst_amount),
            "igst_amount": str(invoice.igst_amount),
            "total_amount": str(invoice.total_amount),
        },
    )

    return invoice


def post_invoice(
    db: Session,
    *,
    invoice_id: UUID,
    actor_id: UUID,
    seller_state: str,
) -> Invoice:
    """
    Finalize an approved-order invoice exactly once.

    Posted line amounts are recalculated and verified before
    finalization. No stock movements are created.
    """

    _require_admin(db, actor_id)

    invoice = _invoice(db, invoice_id, lock=True)

    if invoice.status == "POSTED":
        return invoice

    if invoice.status != "DRAFT":
        raise _error(
            status.HTTP_409_CONFLICT,
            "Only draft invoices may be posted.",
        )

    if invoice.invoice_type != "TAX_INVOICE":
        raise _error(
            status.HTTP_409_CONFLICT,
            "Credit notes must use the credit-note posting workflow.",
        )

    order = _order(db, invoice.order_id, lock=True)
    _validate_approved_order(order)

    _customer(db, invoice.customer_id)

    if invoice.customer_id != order.customer_id:
        raise _error(
            status.HTTP_409_CONFLICT,
            "Invoice customer does not match the sales order.",
        )

    if not invoice.items:
        raise _error(
            status.HTTP_409_CONFLICT,
            "Cannot post an invoice without line items.",
        )

    expected_financial_year = _financial_year(
        invoice.invoice_date
    )

    if invoice.financial_year != expected_financial_year:
        raise _error(
            status.HTTP_409_CONFLICT,
            "Invoice financial year does not match its date.",
        )

    order_lines = {
        line.sales_order_item_id: line
        for line in order.items
    }

    previously_invoiced = _previously_invoiced_quantities(
        db,
        order_id=order.sales_order_id,
        exclude_invoice_id=invoice.invoice_id,
    )

    seen: set[UUID] = set()

    for line in invoice.items:
        source = order_lines.get(line.order_item_id)

        if source is None or line.order_item_id in seen:
            raise _error(
                status.HTTP_409_CONFLICT,
                "Invoice lines do not match the approved order.",
            )

        seen.add(line.order_item_id)

        if (
            line.product_id != source.product_id
            or Decimal(line.unit_price) != Decimal(source.unit_price)
            or Decimal(line.tax_rate) != Decimal(source.tax_rate)
        ):
            raise _error(
                status.HTTP_409_CONFLICT,
                "Invoice price, product, or GST rate differs "
                "from the approved order.",
            )

        if (
            Decimal(line.quantity)
            + previously_invoiced.get(line.order_item_id, ZERO)
            > Decimal(source.quantity)
        ):
            raise _error(
                status.HTTP_409_CONFLICT,
                "Invoice quantity exceeds the remaining "
                "authorized order quantity.",
            )

        gross = _money(
            Decimal(line.quantity) * Decimal(line.unit_price)
        )

        if (
            Decimal(line.discount) < ZERO
            or Decimal(line.discount) > gross
            or Decimal(line.taxable_amount)
            != gross - Decimal(line.discount)
        ):
            raise _error(
                status.HTTP_409_CONFLICT,
                "Invoice line taxable amount does not reconcile.",
            )

    seller = _state(seller_state, "seller_state")

    old_totals = (
        Decimal(invoice.taxable_amount),
        Decimal(invoice.cgst_amount),
        Decimal(invoice.sgst_amount),
        Decimal(invoice.igst_amount),
        Decimal(invoice.total_amount),
    )

    _recalculate_invoice(
        invoice,
        seller_state=seller,
    )

    new_totals = (
        Decimal(invoice.taxable_amount),
        Decimal(invoice.cgst_amount),
        Decimal(invoice.sgst_amount),
        Decimal(invoice.igst_amount),
        Decimal(invoice.total_amount),
    )

    if old_totals != new_totals:
        raise _error(
            status.HTTP_409_CONFLICT,
            "Invoice tax totals do not reconcile. "
            "Correct the draft before posting.",
        )

    invoice.status = "POSTED"
    invoice.posted_at = datetime.now(timezone.utc)

    db.flush()

    create_audit_log(
        db,
        user_id=actor_id,
        entity_type="Invoice",
        entity_id=invoice.invoice_id,
        action="INVOICE_POSTED",
        old_values={"status": "DRAFT"},
        new_values={
            "status": "POSTED",
            "posted_at": invoice.posted_at.isoformat(),
            "invoice_number": invoice.invoice_number,
            "financial_year": invoice.financial_year,
            "taxable_amount": str(invoice.taxable_amount),
            "cgst_amount": str(invoice.cgst_amount),
            "sgst_amount": str(invoice.sgst_amount),
            "igst_amount": str(invoice.igst_amount),
            "total_amount": str(invoice.total_amount),
        },
    )

    return invoice


def cancel_draft_invoice(
    db: Session,
    *,
    invoice_id: UUID,
    actor_id: UUID,
    reason: str,
) -> Invoice:
    """
    Cancel an unposted invoice without deleting its history.

    Posted invoices require an authorized credit-note or
    statutory correction workflow.
    """

    _require_admin(db, actor_id)

    if not isinstance(reason, str) or not reason.strip():
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "A cancellation reason is required.",
        )

    invoice = _invoice(db, invoice_id, lock=True)

    if invoice.status == "CANCELLED":
        return invoice

    if invoice.status != "DRAFT":
        raise _error(
            status.HTTP_409_CONFLICT,
            "Posted invoices cannot be cancelled directly.",
        )

    invoice.status = "CANCELLED"

    db.flush()

    create_audit_log(
        db,
        user_id=actor_id,
        entity_type="Invoice",
        entity_id=invoice.invoice_id,
        action="INVOICE_DRAFT_CANCELLED",
        old_values={"status": "DRAFT"},
        new_values={
            "status": "CANCELLED",
            "reason": reason.strip(),
        },
    )

    return invoice


def get_order_invoice_balance(
    db: Session,
    *,
    order_id: UUID,
    actor_id: UUID,
) -> dict[str, object]:
    """
    Report ordered, invoiced, and remaining authorized quantities.

    This is an invoicing balance, not an inventory availability
    or dispatch balance.
    """

    _, role = _actor(db, actor_id)
    order = _order(db, order_id)

    if role == "Salesman":
        if order.salesman_id != actor_id:
            raise _error(
                status.HTTP_403_FORBIDDEN,
                "Access to this sales order is not permitted.",
            )

        customer = db.get(Customer, order.customer_id)

        if (
            customer is None
            or customer.assigned_salesman_id != actor_id
        ):
            raise _error(
                status.HTTP_403_FORBIDDEN,
                "Access to this customer is not permitted.",
            )

    invoiced = _previously_invoiced_quantities(
        db,
        order_id=order_id,
    )

    lines = []

    for source in order.items:
        ordered_quantity = Decimal(source.quantity)
        invoiced_quantity = invoiced.get(
            source.sales_order_item_id,
            ZERO,
        )

        lines.append(
            {
                "order_item_id": source.sales_order_item_id,
                "product_id": source.product_id,
                "ordered_quantity": ordered_quantity,
                "invoiced_quantity": invoiced_quantity,
                "remaining_quantity": max(
                    ZERO,
                    ordered_quantity - invoiced_quantity,
                ),
            }
        )

    return {
        "order_id": order.sales_order_id,
        "approval_status": order.approval_status,
        "items": lines,
    }