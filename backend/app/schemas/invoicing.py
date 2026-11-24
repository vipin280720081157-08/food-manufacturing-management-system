"""
Pydantic v2 schemas for GST invoices, invoice lines, posting,
cancellation, credit-note references, and invoice summaries.

Persisted invoice fields match the Development 03A SQLAlchemy models
Invoice and InvoiceItem in app.models.invoicing.

The backend is authoritative for financial-year invoice numbering,
transaction-time pricing, GST classification, tax calculations,
payment terms, and invoice totals.

Posting an invoice does not deduct finished-goods inventory.
Inventory deduction occurs only when the corresponding dispatch
is posted.

Posted invoices must not be silently edited or deleted. Corrections
must preserve the original transaction and its audit history.
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal, ROUND_HALF_UP
from typing import Annotated, Literal
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    model_validator,
)


MONEY_QUANTUM = Decimal("0.01")

PositiveQuantity = Annotated[
    Decimal,
    Field(
        gt=0,
        max_digits=18,
        decimal_places=3,
        allow_inf_nan=False,
    ),
]

NonnegativeQuantity = Annotated[
    Decimal,
    Field(
        ge=0,
        max_digits=18,
        decimal_places=3,
        allow_inf_nan=False,
    ),
]

Money = Annotated[
    Decimal,
    Field(
        ge=0,
        max_digits=18,
        decimal_places=2,
        allow_inf_nan=False,
    ),
]

TaxRate = Annotated[
    Decimal,
    Field(
        ge=0,
        le=100,
        max_digits=7,
        decimal_places=4,
        allow_inf_nan=False,
    ),
]

RequiredState = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        min_length=1,
        max_length=100,
    ),
]

RequiredReason = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        min_length=1,
    ),
]

InvoiceStatus = Literal[
    "DRAFT",
    "POSTED",
    "CANCELLED",
    "CREDITED",
]

InvoiceType = Literal[
    "TAX_INVOICE",
    "CREDIT_NOTE",
]


class InvoicingSchema(BaseModel):
    """Shared configuration for invoice request schemas."""

    model_config = ConfigDict(
        extra="forbid",
        str_strip_whitespace=True,
    )


class InvoicingResponseSchema(InvoicingSchema):
    """Shared configuration for ORM-backed invoice responses."""

    model_config = ConfigDict(
        from_attributes=True,
        extra="forbid",
        str_strip_whitespace=True,
    )


def _round_money(value: Decimal) -> Decimal:
    """Apply the application's two-decimal monetary rounding rule."""

    return value.quantize(
        MONEY_QUANTUM,
        rounding=ROUND_HALF_UP,
    )


class InvoiceItemCreate(InvoicingSchema):
    """
    Sales-order line and quantity to include on a tax invoice.

    The service resolves product identity, approved unit price,
    HSN code, and applicable GST rate from authoritative records.

    Client-supplied totals and tax calculations are not accepted.
    """

    order_item_id: UUID
    quantity: PositiveQuantity
    discount: Money = Decimal("0.00")


class InvoiceItemUpdate(InvoicingSchema):
    """
    Editable invoice-line values while the invoice is a draft.

    The service must validate approved order quantities and
    prohibit changes after posting.
    """

    quantity: PositiveQuantity | None = None
    discount: Money | None = None

    @model_validator(mode="after")
    def validate_update(self) -> InvoiceItemUpdate:
        if not self.model_fields_set:
            raise ValueError(
                "At least one invoice-item field must be provided."
            )

        for field_name in self.model_fields_set:
            if getattr(self, field_name) is None:
                raise ValueError(
                    f"{field_name} cannot be null."
                )

        return self


class InvoiceCreate(InvoicingSchema):
    """
    Request to create a draft tax invoice for an approved order.

    The backend derives customer_id from the sales order,
    generates invoice_number within the financial year,
    and calculates all monetary amounts.

    The invoice date determines its financial year. The backend
    validates the applicable supplier state and place of supply.
    """

    order_id: UUID
    invoice_date: date
    place_of_supply_state: RequiredState
    items: list[InvoiceItemCreate] = Field(
        ...,
        min_length=1,
    )

    @model_validator(mode="after")
    def validate_unique_order_items(self) -> InvoiceCreate:
        identifiers = [
            item.order_item_id
            for item in self.items
        ]

        if len(identifiers) != len(set(identifiers)):
            raise ValueError(
                "An invoice cannot contain duplicate sales-order lines."
            )

        return self


class InvoiceUpdate(InvoicingSchema):
    """
    Partial update of a draft invoice.

    Changes to order lines must use the dedicated invoice-item
    operation. Invoice numbers, financial years, and calculated
    totals cannot be directly edited by API clients.
    """

    invoice_date: date | None = None
    place_of_supply_state: RequiredState | None = None

    @model_validator(mode="after")
    def validate_update(self) -> InvoiceUpdate:
        if not self.model_fields_set:
            raise ValueError(
                "At least one invoice field must be provided."
            )

        for field_name in self.model_fields_set:
            if getattr(self, field_name) is None:
                raise ValueError(
                    f"{field_name} cannot be null."
                )

        return self


class InvoiceItemResponse(InvoicingResponseSchema):
    """Persisted invoice line with transaction-time price and tax."""

    invoice_item_id: UUID
    invoice_id: UUID
    line_number: int = Field(gt=0)
    order_item_id: UUID
    product_id: UUID
    hsn_code: str | None
    quantity: Decimal
    unit_price: Decimal
    discount: Decimal
    tax_rate: Decimal
    taxable_amount: Decimal
    tax_amount: Decimal
    line_total: Decimal


class InvoiceResponse(InvoicingResponseSchema):
    """Persisted GST invoice header and item lines."""

    invoice_id: UUID
    order_id: UUID
    customer_id: UUID
    invoice_number: str
    financial_year: str
    invoice_date: date
    invoice_type: InvoiceType
    place_of_supply_state: str
    taxable_amount: Decimal
    cgst_amount: Decimal
    sgst_amount: Decimal
    igst_amount: Decimal
    total_amount: Decimal
    due_date: date
    status: InvoiceStatus
    posted_at: datetime | None
    original_invoice_id: UUID | None
    items: list[InvoiceItemResponse]


class InvoiceListResponse(InvoicingSchema):
    """Paginated invoice listing."""

    items: list[InvoiceResponse]
    total: int = Field(ge=0)
    page: int = Field(ge=1)
    page_size: int = Field(ge=1)


class InvoicePostRequest(InvoicingSchema):
    """
    Request to post an existing draft invoice.

    The backend must verify the approved sales order, permitted
    invoicing quantities, tax treatment, totals, financial-year
    numbering, and transaction idempotency before posting.
    """


class InvoicePostResponse(InvoicingSchema):
    """Result of posting an invoice."""

    invoice_id: UUID
    invoice_number: str
    financial_year: str
    status: Literal["POSTED"]
    posted_at: datetime
    total_amount: Money


class InvoiceCancellationRequest(InvoicingSchema):
    """
    Request to cancel an eligible invoice with an auditable reason.

    The service determines whether cancellation is permitted.
    Posted invoice corrections must preserve the original invoice
    and use the authorized correction workflow where required.
    """

    reason: RequiredReason


class InvoiceStatusResponse(InvoicingSchema):
    """Compact invoice status after an authorized transition."""

    invoice_id: UUID
    invoice_number: str
    financial_year: str
    invoice_type: InvoiceType
    status: InvoiceStatus
    posted_at: datetime | None


class InvoiceGSTBreakdown(InvoicingSchema):
    """
    GST amounts for an invoice or invoice line.

    CGST and SGST apply to intra-state supplies. IGST applies
    to inter-state supplies. The two treatments are exclusive.
    """

    taxable_amount: Money
    cgst_amount: Money
    sgst_amount: Money
    igst_amount: Money
    total_tax: Money
    total_amount: Money
    is_interstate: bool

    @model_validator(mode="after")
    def validate_gst_breakdown(self) -> InvoiceGSTBreakdown:
        if self.cgst_amount != self.sgst_amount:
            raise ValueError(
                "CGST and SGST amounts must be equal."
            )

        if self.is_interstate:
            if (
                self.cgst_amount != Decimal("0")
                or self.sgst_amount != Decimal("0")
            ):
                raise ValueError(
                    "Inter-state GST must not contain CGST or SGST."
                )
        elif self.igst_amount != Decimal("0"):
            raise ValueError(
                "Intra-state GST must not contain IGST."
            )

        expected_tax = (
            self.cgst_amount
            + self.sgst_amount
            + self.igst_amount
        )

        if self.total_tax != expected_tax:
            raise ValueError(
                "Total GST does not reconcile with tax components."
            )

        if self.total_amount != (
            self.taxable_amount + expected_tax
        ):
            raise ValueError(
                "Invoice total does not reconcile with "
                "taxable value and GST."
            )

        return self


class InvoiceItemCalculation(InvoicingSchema):
    """
    Calculated financial amounts for one invoice item.

    This is a calculation response, not an additional database model.
    The service uses transaction-time values and Decimal arithmetic.
    """

    order_item_id: UUID
    product_id: UUID
    quantity: PositiveQuantity
    unit_price: Money
    discount: Money
    tax_rate: TaxRate
    taxable_amount: Money
    tax_amount: Money
    line_total: Money

    @model_validator(mode="after")
    def validate_line_totals(self) -> InvoiceItemCalculation:
        gross_amount = _round_money(
            self.quantity * self.unit_price
        )

        if self.discount > gross_amount:
            raise ValueError(
                "Invoice discount cannot exceed the gross line amount."
            )

        expected_taxable = gross_amount - self.discount

        if self.taxable_amount != expected_taxable:
            raise ValueError(
                "Taxable amount does not reconcile with "
                "quantity, unit price, and discount."
            )

        expected_tax = _round_money(
            self.taxable_amount
            * self.tax_rate
            / Decimal("100")
        )

        if self.tax_amount != expected_tax:
            raise ValueError(
                "Tax amount does not reconcile with "
                "taxable amount and GST rate."
            )

        if self.line_total != (
            self.taxable_amount + self.tax_amount
        ):
            raise ValueError(
                "Invoice line total does not reconcile."
            )

        return self


class InvoiceCalculationResponse(InvoicingSchema):
    """Preview of backend-calculated invoice amounts before posting."""

    order_id: UUID
    invoice_date: date
    financial_year: str
    place_of_supply_state: str
    items: list[InvoiceItemCalculation]
    gst: InvoiceGSTBreakdown

    @model_validator(mode="after")
    def validate_invoice_calculation(
        self,
    ) -> InvoiceCalculationResponse:
        expected_taxable = sum(
            (item.taxable_amount for item in self.items),
            Decimal("0.00"),
        )

        expected_tax = sum(
            (item.tax_amount for item in self.items),
            Decimal("0.00"),
        )

        expected_total = sum(
            (item.line_total for item in self.items),
            Decimal("0.00"),
        )

        if self.gst.taxable_amount != expected_taxable:
            raise ValueError(
                "Invoice taxable amount does not match item totals."
            )

        if self.gst.total_tax != expected_tax:
            raise ValueError(
                "Invoice GST does not match item tax totals."
            )

        if self.gst.total_amount != expected_total:
            raise ValueError(
                "Invoice grand total does not match item totals."
            )

        return self


class InvoiceOutstandingResponse(InvoicingSchema):
    """
    Invoice receivable balance.

    Payment allocations and credit adjustments must be obtained
    from posted financial records rather than client input.
    """

    invoice_id: UUID
    invoice_number: str
    invoice_date: date
    due_date: date
    invoice_total: Money
    allocated_payments: Money
    credited_amount: Money
    outstanding_amount: Money
    days_overdue: int = Field(ge=0)

    @model_validator(mode="after")
    def validate_outstanding(self) -> InvoiceOutstandingResponse:
        expected_outstanding = (
            self.invoice_total
            - self.allocated_payments
            - self.credited_amount
        )

        if expected_outstanding < Decimal("0"):
            raise ValueError(
                "Payments and credits cannot exceed invoice total."
            )

        if self.outstanding_amount != expected_outstanding:
            raise ValueError(
                "Outstanding amount does not reconcile "
                "with payments and credits."
            )

        return self


class InvoiceSummaryResponse(InvoicingSchema):
    """Aggregated invoice status and financial totals."""

    invoice_count: int = Field(ge=0)
    draft_count: int = Field(ge=0)
    posted_count: int = Field(ge=0)
    cancelled_count: int = Field(ge=0)
    credited_count: int = Field(ge=0)
    total_taxable_amount: Money
    total_cgst_amount: Money
    total_sgst_amount: Money
    total_igst_amount: Money
    total_invoice_amount: Money

    @model_validator(mode="after")
    def validate_summary(self) -> InvoiceSummaryResponse:
        status_count = (
            self.draft_count
            + self.posted_count
            + self.cancelled_count
            + self.credited_count
        )

        if status_count != self.invoice_count:
            raise ValueError(
                "Invoice status counts must equal invoice count."
            )

        if self.total_cgst_amount != self.total_sgst_amount:
            raise ValueError(
                "Aggregated CGST and SGST amounts must be equal."
            )

        expected_total = (
            self.total_taxable_amount
            + self.total_cgst_amount
            + self.total_sgst_amount
            + self.total_igst_amount
        )

        if self.total_invoice_amount != expected_total:
            raise ValueError(
                "Aggregated invoice totals do not reconcile."
            )

        return self