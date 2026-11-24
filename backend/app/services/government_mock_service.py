"""
Simulated government e-Invoice and e-Waybill integration.

This module provides a demonstration-only interface for preparing,
validating, submitting, and retrieving mock government responses.

IMPORTANT:
    No requests are sent to GSTN, NIC, IRP, or any other government
    service. All responses are simulated and have no legal validity.

The integration:
- Reads actual posted invoices and dispatches.
- Validates source records before preparing payloads.
- Generates clearly labelled simulated acknowledgements.
- Stores responses in the existing audit log.
- Prevents duplicate mock submissions.
- Enforces backend role permissions.
- Never changes invoice, dispatch, inventory, or tax records.
- Uses the caller's database transaction.

The approved Development 03A schema has no dedicated government
integration table. AuditLog is therefore used to retain the
demonstration submission records without introducing a new model.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any, Literal
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models.audit import AuditLog
from app.models.dispatch import Dispatch
from app.models.invoicing import Invoice
from app.models.user import User
from app.services.audit_service import create_audit_log


MockDocumentType = Literal["E_INVOICE", "E_WAYBILL"]

FACTORY_ADMIN_ROLE = "Factory Admin"

READ_ROLES = frozenset(
    {
        "Factory Admin",
        "Accountant/Auditor",
        "Owner",
    }
)

MOCK_ACTIONS = {
    "E_INVOICE": "MOCK_E_INVOICE_SUBMITTED",
    "E_WAYBILL": "MOCK_E_WAYBILL_SUBMITTED",
}

MOCK_PROVIDER = "FOOD_MANUFACTURING_DEMO_GATEWAY"
MOCK_ENVIRONMENT = "SIMULATION"
MOCK_STATUS = "SIMULATED_SUCCESS"


def _error(code: int, detail: str) -> HTTPException:
    return HTTPException(status_code=code, detail=detail)


def _authorize(
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
        else READ_ROLES
    )

    if role.role_name not in allowed:
        raise _error(
            status.HTTP_403_FORBIDDEN,
            "Government mock integration access is not "
            "permitted for this role.",
        )

    return user


def _validate_document_type(
    document_type: str,
) -> MockDocumentType:
    if document_type not in MOCK_ACTIONS:
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Document type must be E_INVOICE or E_WAYBILL.",
        )

    return document_type  # type: ignore[return-value]


def _decimal(value: object) -> Decimal:
    if isinstance(value, (bool, float)):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Mock payload amounts must use exact decimals.",
        )

    try:
        number = Decimal(value)
    except (TypeError, ValueError, ArithmeticError):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Invalid decimal amount in mock payload.",
        ) from None

    if not number.is_finite():
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Non-finite decimal amount in mock payload.",
        )

    return number


def _serialize(value: object) -> Any:
    """Convert supported values to deterministic JSON-compatible data."""

    if value is None or isinstance(value, (str, bool, int)):
        return value

    if isinstance(value, Decimal):
        return format(_decimal(value), "f")

    if isinstance(value, UUID):
        return str(value)

    if isinstance(value, datetime):
        return value.isoformat()

    if isinstance(value, date):
        return value.isoformat()

    if isinstance(value, Mapping):
        return {
            str(key): _serialize(item)
            for key, item in value.items()
        }

    if isinstance(value, (list, tuple)):
        return [_serialize(item) for item in value]

    raise _error(
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "Unsupported value in mock government payload.",
    )


def _canonical_json(value: Mapping[str, object]) -> str:
    return json.dumps(
        _serialize(value),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        allow_nan=False,
    )


def _payload_hash(payload: Mapping[str, object]) -> str:
    return hashlib.sha256(
        _canonical_json(payload).encode("utf-8")
    ).hexdigest()


def _invoice(
    db: Session,
    invoice_id: UUID,
    *,
    lock: bool = False,
) -> Invoice:
    statement = (
        select(Invoice)
        .options(
            selectinload(Invoice.items),
            selectinload(Invoice.customer),
        )
        .where(Invoice.invoice_id == invoice_id)
    )

    if lock:
        statement = statement.with_for_update(of=Invoice)

    invoice = db.scalar(statement)

    if invoice is None:
        raise _error(
            status.HTTP_404_NOT_FOUND,
            "Invoice not found.",
        )

    if (
        invoice.invoice_type != "TAX_INVOICE"
        or invoice.status not in {"POSTED", "CREDITED"}
        or invoice.posted_at is None
    ):
        raise _error(
            status.HTTP_409_CONFLICT,
            "Mock government submission requires a posted "
            "tax invoice.",
        )

    if not invoice.items:
        raise _error(
            status.HTTP_409_CONFLICT,
            "Invoice has no line items.",
        )

    return invoice


def _dispatch(
    db: Session,
    dispatch_id: UUID,
    *,
    lock: bool = False,
) -> Dispatch:
    statement = (
        select(Dispatch)
        .options(selectinload(Dispatch.items))
        .where(Dispatch.dispatch_id == dispatch_id)
    )

    if lock:
        statement = statement.with_for_update(of=Dispatch)

    dispatch = db.scalar(statement)

    if dispatch is None:
        raise _error(
            status.HTTP_404_NOT_FOUND,
            "Dispatch not found.",
        )

    if dispatch.status != "POSTED" or dispatch.posted_at is None:
        raise _error(
            status.HTTP_409_CONFLICT,
            "Mock e-Waybill submission requires a posted dispatch.",
        )

    if not dispatch.items:
        raise _error(
            status.HTTP_409_CONFLICT,
            "Dispatch has no line items.",
        )

    return dispatch


def _validate_invoice_totals(invoice: Invoice) -> None:
    taxable = _decimal(invoice.taxable_amount)
    cgst = _decimal(invoice.cgst_amount)
    sgst = _decimal(invoice.sgst_amount)
    igst = _decimal(invoice.igst_amount)
    total = _decimal(invoice.total_amount)

    if min(taxable, cgst, sgst, igst, total) < Decimal("0"):
        raise _error(
            status.HTTP_409_CONFLICT,
            "Invoice contains negative tax or total amounts.",
        )

    if total != taxable + cgst + sgst + igst:
        raise _error(
            status.HTTP_409_CONFLICT,
            "Invoice GST totals do not reconcile.",
        )

    if cgst != sgst or (
        igst > Decimal("0")
        and (cgst > Decimal("0") or sgst > Decimal("0"))
    ):
        raise _error(
            status.HTTP_409_CONFLICT,
            "Invoice GST components are inconsistent.",
        )

    line_taxable = Decimal("0")
    line_tax = Decimal("0")

    for item in invoice.items:
        quantity = _decimal(item.quantity)
        unit_price = _decimal(item.unit_price)
        discount = _decimal(item.discount)
        taxable_amount = _decimal(item.taxable_amount)
        tax_amount = _decimal(item.tax_amount)
        line_total = _decimal(item.line_total)

        if quantity <= 0 or unit_price < 0 or discount < 0:
            raise _error(
                status.HTTP_409_CONFLICT,
                "Invoice line contains invalid quantities or prices.",
            )

        if taxable_amount < 0 or tax_amount < 0:
            raise _error(
                status.HTTP_409_CONFLICT,
                "Invoice line contains invalid taxable or tax amounts.",
            )

        if line_total != taxable_amount + tax_amount:
            raise _error(
                status.HTTP_409_CONFLICT,
                "Invoice line totals do not reconcile.",
            )

        if not item.hsn_code or not item.hsn_code.strip():
            raise _error(
                status.HTTP_409_CONFLICT,
                "Invoice line is missing its HSN code.",
            )

        line_taxable += taxable_amount
        line_tax += tax_amount

    if line_taxable != taxable:
        raise _error(
            status.HTTP_409_CONFLICT,
            "Invoice taxable amount differs from its line totals.",
        )

    if line_tax != cgst + sgst + igst:
        raise _error(
            status.HTTP_409_CONFLICT,
            "Invoice GST amount differs from its line taxes.",
        )


def _invoice_payload(invoice: Invoice) -> dict[str, object]:
    _validate_invoice_totals(invoice)

    customer = invoice.customer

    if customer is None:
        raise _error(
            status.HTTP_409_CONFLICT,
            "Invoice customer is unavailable.",
        )

    if not customer.customer_name.strip():
        raise _error(
            status.HTTP_409_CONFLICT,
            "Invoice customer name is missing.",
        )

    if not invoice.place_of_supply_state.strip():
        raise _error(
            status.HTTP_409_CONFLICT,
            "Invoice place of supply is missing.",
        )

    items = [
        {
            "line_number": item.line_number,
            "product_id": str(item.product_id),
            "hsn_code": item.hsn_code,
            "quantity": _serialize(item.quantity),
            "unit_price": _serialize(item.unit_price),
            "discount": _serialize(item.discount),
            "gst_rate": _serialize(item.tax_rate),
            "taxable_amount": _serialize(item.taxable_amount),
            "tax_amount": _serialize(item.tax_amount),
            "line_total": _serialize(item.line_total),
        }
        for item in sorted(
            invoice.items,
            key=lambda line: line.line_number,
        )
    ]

    return {
        "simulation": True,
        "document_type": "E_INVOICE",
        "source_invoice_id": str(invoice.invoice_id),
        "invoice_number": invoice.invoice_number,
        "financial_year": invoice.financial_year,
        "invoice_date": invoice.invoice_date.isoformat(),
        "customer": {
            "customer_id": str(customer.customer_id),
            "name": customer.customer_name,
            "gstin": customer.gstin,
            "billing_address": customer.billing_address,
            "shipping_address": customer.shipping_address,
            "state": customer.state,
        },
        "place_of_supply_state": invoice.place_of_supply_state,
        "taxable_amount": _serialize(invoice.taxable_amount),
        "cgst_amount": _serialize(invoice.cgst_amount),
        "sgst_amount": _serialize(invoice.sgst_amount),
        "igst_amount": _serialize(invoice.igst_amount),
        "total_amount": _serialize(invoice.total_amount),
        "items": items,
    }


def _ewaybill_payload(
    dispatch: Dispatch,
    invoice: Invoice,
    *,
    vehicle_number: str,
    transporter_name: str,
    transport_distance_km: Decimal,
) -> dict[str, object]:
    if dispatch.invoice_id != invoice.invoice_id:
        raise _error(
            status.HTTP_409_CONFLICT,
            "Dispatch and invoice references do not match.",
        )

    invoice_data = _invoice_payload(invoice)

    if not vehicle_number.strip():
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Vehicle number is required.",
        )

    if not transporter_name.strip():
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Transporter name is required.",
        )

    distance = _decimal(transport_distance_km)

    if distance <= 0:
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Transport distance must be positive.",
        )

    invoice_lines = {
        item.invoice_item_id: item
        for item in invoice.items
    }

    items = []

    for item in sorted(
        dispatch.items,
        key=lambda line: str(line.dispatch_item_id),
    ):
        invoice_line = invoice_lines.get(item.invoice_item_id)

        if invoice_line is None:
            raise _error(
                status.HTTP_409_CONFLICT,
                "Dispatch contains an item not present "
                "on its invoice.",
            )

        if invoice_line.product_id != item.product_id:
            raise _error(
                status.HTTP_409_CONFLICT,
                "Dispatch product differs from its invoice line.",
            )

        quantity = _decimal(item.quantity)

        if quantity <= 0:
            raise _error(
                status.HTTP_409_CONFLICT,
                "Dispatch contains a nonpositive quantity.",
            )

        if quantity > _decimal(invoice_line.quantity):
            raise _error(
                status.HTTP_409_CONFLICT,
                "Dispatch quantity exceeds its invoice line quantity.",
            )

        items.append(
            {
                "dispatch_item_id": str(item.dispatch_item_id),
                "invoice_item_id": str(item.invoice_item_id),
                "product_id": str(item.product_id),
                "hsn_code": invoice_line.hsn_code,
                "quantity": _serialize(quantity),
                "batch_id": (
                    str(item.batch_id)
                    if item.batch_id is not None
                    else None
                ),
            }
        )

    return {
        "simulation": True,
        "document_type": "E_WAYBILL",
        "source_dispatch_id": str(dispatch.dispatch_id),
        "dispatch_number": dispatch.dispatch_number,
        "dispatch_date": dispatch.dispatch_date.isoformat(),
        "delivery_reference": dispatch.delivery_reference,
        "source_invoice_id": str(invoice.invoice_id),
        "invoice_number": invoice.invoice_number,
        "invoice_date": invoice.invoice_date.isoformat(),
        "customer": invoice_data["customer"],
        "place_of_supply_state": invoice.place_of_supply_state,
        "invoice_total": invoice_data["total_amount"],
        "vehicle_number": vehicle_number.strip().upper(),
        "transporter_name": transporter_name.strip(),
        "transport_distance_km": _serialize(distance),
        "items": items,
    }


def _submission_history(
    db: Session,
    *,
    document_type: MockDocumentType,
    entity_id: UUID,
) -> list[AuditLog]:
    return list(
        db.scalars(
            select(AuditLog)
            .where(
                AuditLog.entity_type == "MockGovernmentSubmission",
                AuditLog.entity_id == entity_id,
                AuditLog.action == MOCK_ACTIONS[document_type],
            )
            .order_by(
                AuditLog.timestamp.desc(),
                AuditLog.audit_id.desc(),
            )
        ).all()
    )


def _stored_response(
    entry: AuditLog,
) -> dict[str, object]:
    values = entry.new_values

    if not isinstance(values, dict):
        raise _error(
            status.HTTP_409_CONFLICT,
            "Stored mock submission record is invalid.",
        )

    response = values.get("response")

    if not isinstance(response, dict):
        raise _error(
            status.HTTP_409_CONFLICT,
            "Stored mock government response is invalid.",
        )

    return response


def _submit_mock(
    db: Session,
    *,
    actor_id: UUID,
    document_type: MockDocumentType,
    entity_id: UUID,
    payload: Mapping[str, object],
) -> dict[str, object]:
    """
    Persist a simulated submission with idempotent replay.

    The caller must hold a row lock on the source document before
    invoking this function. This serializes concurrent submissions
    for the same invoice or dispatch.
    """

    canonical_payload = _serialize(payload)
    digest = _payload_hash(payload)

    previous = _submission_history(
        db,
        document_type=document_type,
        entity_id=entity_id,
    )

    for entry in previous:
        values = entry.new_values or {}

        if values.get("payload_hash") == digest:
            return _stored_response(entry)

    if previous:
        raise _error(
            status.HTTP_409_CONFLICT,
            "A different mock submission already exists for this "
            "document. Existing simulated submissions are immutable.",
        )

    submitted_at = datetime.now(timezone.utc)

    reference = (
        f"DEMO-{document_type}-"
        f"{digest[:20].upper()}"
    )

    response: dict[str, object] = {
        "simulation": True,
        "environment": MOCK_ENVIRONMENT,
        "provider": MOCK_PROVIDER,
        "document_type": document_type,
        "status": MOCK_STATUS,
        "mock_reference": reference,
        "source_document_id": str(entity_id),
        "payload_hash": digest,
        "submitted_at": submitted_at.isoformat(),
        "message": (
            "Simulated submission accepted by the demonstration "
            "gateway. This is not a government acknowledgement."
        ),
        "government_issued": False,
        "legal_validity": False,
        "official_irn": None,
        "official_acknowledgement_number": None,
        "official_ewaybill_number": None,
    }

    create_audit_log(
        db,
        user_id=actor_id,
        entity_type="MockGovernmentSubmission",
        entity_id=entity_id,
        action=MOCK_ACTIONS[document_type],
        new_values={
            "document_type": document_type,
            "payload_hash": digest,
            "request": canonical_payload,
            "response": response,
        },
    )

    db.flush()

    return response


def prepare_mock_e_invoice(
    db: Session,
    *,
    actor_id: UUID,
    invoice_id: UUID,
) -> dict[str, object]:
    """
    Prepare an e-Invoice demonstration payload without submitting it.

    The payload is derived from a posted tax invoice and includes
    its historical customer, product, and GST information.
    """

    _authorize(db, actor_id)

    invoice = _invoice(
        db,
        invoice_id,
    )

    return _invoice_payload(invoice)


def submit_mock_e_invoice(
    db: Session,
    *,
    actor_id: UUID,
    invoice_id: UUID,
) -> dict[str, object]:
    """
    Submit an invoice to the simulated gateway.

    A repeated submission with identical source data returns the
    original stored mock response without creating another record.
    """

    _authorize(db, actor_id, write=True)

    invoice = _invoice(
        db,
        invoice_id,
        lock=True,
    )

    payload = _invoice_payload(invoice)

    return _submit_mock(
        db,
        actor_id=actor_id,
        document_type="E_INVOICE",
        entity_id=invoice.invoice_id,
        payload=payload,
    )


def prepare_mock_e_waybill(
    db: Session,
    *,
    actor_id: UUID,
    dispatch_id: UUID,
    vehicle_number: str,
    transporter_name: str,
    transport_distance_km: Decimal,
) -> dict[str, object]:
    """
    Prepare an e-Waybill demonstration payload.

    The dispatch must already be posted. Vehicle and transporter
    details are supplied for simulation only and are not stored
    on the operational dispatch record.
    """

    _authorize(db, actor_id)

    dispatch = _dispatch(
        db,
        dispatch_id,
    )

    invoice = _invoice(
        db,
        dispatch.invoice_id,
    )

    return _ewaybill_payload(
        dispatch,
        invoice,
        vehicle_number=vehicle_number,
        transporter_name=transporter_name,
        transport_distance_km=transport_distance_km,
    )


def submit_mock_e_waybill(
    db: Session,
    *,
    actor_id: UUID,
    dispatch_id: UUID,
    vehicle_number: str,
    transporter_name: str,
    transport_distance_km: Decimal,
) -> dict[str, object]:
    """
    Submit a posted dispatch to the simulated e-Waybill gateway.

    Repeated identical submissions return the previously stored
    simulated response.
    """

    _authorize(db, actor_id, write=True)

    dispatch = _dispatch(
        db,
        dispatch_id,
        lock=True,
    )

    invoice = _invoice(
        db,
        dispatch.invoice_id,
    )

    payload = _ewaybill_payload(
        dispatch,
        invoice,
        vehicle_number=vehicle_number,
        transporter_name=transporter_name,
        transport_distance_km=transport_distance_km,
    )

    return _submit_mock(
        db,
        actor_id=actor_id,
        document_type="E_WAYBILL",
        entity_id=dispatch.dispatch_id,
        payload=payload,
    )


def get_mock_submission(
    db: Session,
    *,
    actor_id: UUID,
    document_type: MockDocumentType,
    source_document_id: UUID,
) -> dict[str, object] | None:
    """Retrieve the stored simulated response for a source document."""

    _authorize(db, actor_id)

    validated_type = _validate_document_type(document_type)

    if validated_type == "E_INVOICE":
        _invoice(db, source_document_id)
    else:
        _dispatch(db, source_document_id)

    entries = _submission_history(
        db,
        document_type=validated_type,
        entity_id=source_document_id,
    )

    if not entries:
        return None

    return _stored_response(entries[0])


def list_mock_submissions(
    db: Session,
    *,
    actor_id: UUID,
    document_type: MockDocumentType | None = None,
    page: int = 1,
    page_size: int = 50,
) -> tuple[list[dict[str, object]], int]:
    """List simulated government submissions for authorized users."""

    _authorize(db, actor_id)

    if (
        isinstance(page, bool)
        or isinstance(page_size, bool)
        or not isinstance(page, int)
        or not isinstance(page_size, int)
        or page < 1
        or not 1 <= page_size <= 100
    ):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Invalid pagination parameters.",
        )

    actions = (
        [MOCK_ACTIONS[_validate_document_type(document_type)]]
        if document_type is not None
        else list(MOCK_ACTIONS.values())
    )

    from sqlalchemy import func

    filters = (
        AuditLog.entity_type == "MockGovernmentSubmission",
        AuditLog.action.in_(actions),
    )

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

    results: list[dict[str, object]] = []

    for entry in entries:
        values = entry.new_values or {}

        results.append(
            {
                "audit_id": entry.audit_id,
                "source_document_id": entry.entity_id,
                "submitted_by": entry.user_id,
                "submitted_at": entry.timestamp,
                "document_type": values.get("document_type"),
                "payload_hash": values.get("payload_hash"),
                "response": _stored_response(entry),
            }
        )

    return results, total


def get_mock_integration_status(
    db: Session,
    *,
    actor_id: UUID,
    document_type: MockDocumentType,
    source_document_id: UUID,
) -> dict[str, object]:
    """
    Return the current simulated submission status.

    Status is derived exclusively from stored audit records.
    It must never be interpreted as an official government status.
    """

    validated_type = _validate_document_type(document_type)

    response = get_mock_submission(
        db,
        actor_id=actor_id,
        document_type=validated_type,
        source_document_id=source_document_id,
    )

    return {
        "simulation": True,
        "environment": MOCK_ENVIRONMENT,
        "document_type": validated_type,
        "source_document_id": source_document_id,
        "submitted": response is not None,
        "status": (
            MOCK_STATUS if response is not None else "NOT_SUBMITTED"
        ),
        "response": response,
        "government_issued": False,
        "legal_validity": False,
    }