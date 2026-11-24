"""
Pydantic v2 schemas for operational, financial, GST, and audit reports.

Reports are read-only projections of authoritative PostgreSQL records.
They do not introduce additional SQLAlchemy models.

The reporting service is responsible for applying role-based access
controls, transaction-status filters, date boundaries, aggregation,
Decimal-safe calculations, and source-document traceability.

Reports must use actual posted business transactions. Benchmark
results must never be hardcoded into reporting responses.

Supported report families include sales, purchases, inventory,
production, GST, payments, receivables, dispatch, and audit history.
Exports support CSV, Excel, and PDF.
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Literal
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    model_validator,
)


Money = Annotated[
    Decimal,
    Field(
        max_digits=18,
        decimal_places=2,
        allow_inf_nan=False,
    ),
]

NonnegativeMoney = Annotated[
    Decimal,
    Field(
        ge=0,
        max_digits=18,
        decimal_places=2,
        allow_inf_nan=False,
    ),
]

Quantity = Annotated[
    Decimal,
    Field(
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

UnitCost = Annotated[
    Decimal,
    Field(
        ge=0,
        max_digits=18,
        decimal_places=6,
        allow_inf_nan=False,
    ),
]

Percentage = Annotated[
    Decimal,
    Field(
        max_digits=12,
        decimal_places=2,
        allow_inf_nan=False,
    ),
]

ReportType = Literal[
    "SALES_REGISTER",
    "CUSTOMER_SALES",
    "PRODUCT_SALES",
    "SALESMAN_SALES",
    "PURCHASE_REGISTER",
    "STOCK_SUMMARY",
    "STOCK_LEDGER",
    "INVENTORY_VALUATION",
    "PRODUCTION",
    "GST_SUMMARY",
    "PAYMENTS_COLLECTIONS",
    "OUTSTANDING_RECEIVABLES",
    "DISPATCH_HISTORY",
    "AUDIT_TRAIL",
]

ExportFormat = Literal["csv", "xlsx", "pdf"]

InventoryItemType = Literal[
    "RAW_MATERIAL",
    "PACKAGING_MATERIAL",
    "FINISHED_PRODUCT",
]

InventoryLocation = Literal[
    "WAREHOUSE",
    "PRODUCTION_HELD",
]

ReceivableAgeBucket = Literal[
    "CURRENT",
    "1_30",
    "31_60",
    "61_90",
    "OVER_90",
]

FinancialYear = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        pattern=r"^\d{4}-\d{2}$",
    ),
]


class ReportSchema(BaseModel):
    """Shared configuration for report requests and responses."""

    model_config = ConfigDict(
        extra="forbid",
        str_strip_whitespace=True,
    )


class ReportDateRange(ReportSchema):
    """Inclusive date range for transactional reports."""

    start_date: date
    end_date: date

    @model_validator(mode="after")
    def validate_dates(self) -> ReportDateRange:
        if self.end_date < self.start_date:
            raise ValueError(
                "Report end date cannot precede start date."
            )

        return self


class ReportPagination(ReportSchema):
    """Pagination parameters for detailed report queries."""

    page: int = Field(default=1, ge=1)
    page_size: int = Field(default=50, ge=1, le=500)


class ReportFilter(ReportDateRange):
    """
    Common filters for operational and financial reports.

    Each report service applies only the filters relevant to its
    underlying business records. The backend must additionally
    enforce the authenticated user's permitted data scope.
    """

    customer_id: UUID | None = None
    supplier_id: UUID | None = None
    product_id: UUID | None = None
    item_id: UUID | None = None
    salesman_id: UUID | None = None
    production_run_id: UUID | None = None
    invoice_id: UUID | None = None


class ReportQuery(ReportFilter):
    """Date-range report query with pagination."""

    page: int = Field(default=1, ge=1)
    page_size: int = Field(default=50, ge=1, le=500)


class InventoryReportQuery(ReportDateRange):
    """Inventory-specific report filters."""

    item_id: UUID | None = None
    item_type: InventoryItemType | None = None
    location: InventoryLocation | None = None
    batch_id: UUID | None = None
    page: int = Field(default=1, ge=1)
    page_size: int = Field(default=50, ge=1, le=500)


class GSTReportQuery(ReportDateRange):
    """GST reporting period and optional financial-year filter."""

    financial_year: FinancialYear | None = None
    page: int = Field(default=1, ge=1)
    page_size: int = Field(default=50, ge=1, le=500)


class ReceivablesReportQuery(ReportSchema):
    """Outstanding receivables as of an inclusive reporting date."""

    as_of_date: date
    customer_id: UUID | None = None
    include_settled: bool = False
    page: int = Field(default=1, ge=1)
    page_size: int = Field(default=50, ge=1, le=500)


class AuditReportQuery(ReportDateRange):
    """Filters for immutable audit history."""

    user_id: UUID | None = None
    entity_type: str | None = None
    entity_id: UUID | None = None
    action: str | None = None
    page: int = Field(default=1, ge=1)
    page_size: int = Field(default=50, ge=1, le=500)


class ReportMetadata(ReportSchema):
    """Provenance and reporting period accompanying generated results."""

    report_type: ReportType
    generated_at: datetime
    start_date: date | None = None
    end_date: date | None = None
    as_of_date: date | None = None


class ReportPage(ReportSchema):
    """Pagination metadata for detailed report results."""

    total: int = Field(ge=0)
    page: int = Field(ge=1)
    page_size: int = Field(ge=1)
    total_pages: int = Field(ge=0)

    @model_validator(mode="after")
    def validate_page_count(self) -> ReportPage:
        expected_pages = (
            (self.total + self.page_size - 1) // self.page_size
        )

        if self.total_pages != expected_pages:
            raise ValueError(
                "Total pages does not match the record count "
                "and page size."
            )

        return self


class SalesRegisterRow(ReportSchema):
    """Posted sales invoice line with customer and product details."""

    invoice_id: UUID
    invoice_number: str
    invoice_date: date
    customer_id: UUID
    customer_name: str
    sales_order_id: UUID
    salesman_id: UUID
    product_id: UUID
    product_name: str
    hsn_code: str | None
    quantity: NonnegativeQuantity
    unit_price: NonnegativeMoney
    taxable_amount: NonnegativeMoney
    cgst_amount: NonnegativeMoney
    sgst_amount: NonnegativeMoney
    igst_amount: NonnegativeMoney
    total_amount: NonnegativeMoney


class SalesRegisterTotals(ReportSchema):
    """Aggregated amounts from eligible sales invoice lines."""

    invoice_count: int = Field(ge=0)
    quantity_sold: NonnegativeQuantity
    taxable_amount: NonnegativeMoney
    cgst_amount: NonnegativeMoney
    sgst_amount: NonnegativeMoney
    igst_amount: NonnegativeMoney
    total_amount: NonnegativeMoney

    @model_validator(mode="after")
    def validate_totals(self) -> SalesRegisterTotals:
        expected_total = (
            self.taxable_amount
            + self.cgst_amount
            + self.sgst_amount
            + self.igst_amount
        )

        if self.total_amount != expected_total:
            raise ValueError(
                "Sales totals do not reconcile with taxable "
                "value and GST."
            )

        return self


class SalesRegisterReport(ReportSchema):
    """Detailed sales register with aggregate totals."""

    metadata: ReportMetadata
    rows: list[SalesRegisterRow]
    totals: SalesRegisterTotals
    pagination: ReportPage


class CustomerSalesRow(ReportSchema):
    """Customer-wise sales aggregation."""

    customer_id: UUID
    customer_name: str
    invoice_count: int = Field(ge=0)
    taxable_sales: NonnegativeMoney
    gst_amount: NonnegativeMoney
    total_sales: NonnegativeMoney

    @model_validator(mode="after")
    def validate_total(self) -> CustomerSalesRow:
        if self.total_sales != (
            self.taxable_sales + self.gst_amount
        ):
            raise ValueError(
                "Customer sales total does not reconcile."
            )

        return self


class CustomerSalesReport(ReportSchema):
    """Customer-wise sales report."""

    metadata: ReportMetadata
    rows: list[CustomerSalesRow]
    pagination: ReportPage


class ProductSalesRow(ReportSchema):
    """Product-wise sales aggregation."""

    product_id: UUID
    product_name: str
    base_unit: str
    quantity_sold: NonnegativeQuantity
    taxable_sales: NonnegativeMoney
    gst_amount: NonnegativeMoney
    total_sales: NonnegativeMoney


class ProductSalesReport(ReportSchema):
    """Product-wise sales report."""

    metadata: ReportMetadata
    rows: list[ProductSalesRow]
    pagination: ReportPage


class SalesmanSalesRow(ReportSchema):
    """Sales attributed to a salesman's approved customer orders."""

    salesman_id: UUID
    salesman_name: str
    customer_count: int = Field(ge=0)
    order_count: int = Field(ge=0)
    invoice_count: int = Field(ge=0)
    taxable_sales: NonnegativeMoney
    total_sales: NonnegativeMoney


class SalesmanSalesReport(ReportSchema):
    """Salesman-wise sales report."""

    metadata: ReportMetadata
    rows: list[SalesmanSalesRow]
    pagination: ReportPage


class PurchaseRegisterRow(ReportSchema):
    """
    Supplier purchase line with ordered and accepted quantities.

    Goods-receipt quantities are shown separately from purchase
    commitments to prevent treating unreceived purchases as stock.
    """

    purchase_order_id: UUID
    po_number: str
    order_date: date
    supplier_id: UUID
    supplier_name: str
    po_item_id: UUID
    item_id: UUID
    item_name: str
    base_unit: str
    ordered_quantity: NonnegativeQuantity
    accepted_quantity: NonnegativeQuantity
    unit_price: NonnegativeMoney
    tax_rate: Decimal = Field(
        ge=0,
        le=100,
        max_digits=7,
        decimal_places=4,
        allow_inf_nan=False,
    )
    ordered_value: NonnegativeMoney
    accepted_value: NonnegativeMoney


class PurchaseRegisterTotals(ReportSchema):
    """Aggregate purchase commitments and accepted receipts."""

    purchase_order_count: int = Field(ge=0)
    ordered_value: NonnegativeMoney
    accepted_value: NonnegativeMoney


class PurchaseRegisterReport(ReportSchema):
    """Purchase register with receipt progress and totals."""

    metadata: ReportMetadata
    rows: list[PurchaseRegisterRow]
    totals: PurchaseRegisterTotals
    pagination: ReportPage


class StockSummaryRow(ReportSchema):
    """Reconciled item-level stock quantities for a reporting period."""

    item_id: UUID
    item_code: str
    item_name: str
    item_type: InventoryItemType
    base_unit: str
    location: InventoryLocation
    opening_quantity: NonnegativeQuantity
    receipts_quantity: NonnegativeQuantity
    issues_quantity: NonnegativeQuantity
    net_adjustment_quantity: Quantity
    closing_quantity: NonnegativeQuantity
    average_unit_cost: UnitCost
    stock_value: NonnegativeMoney

    @model_validator(mode="after")
    def validate_stock_balance(self) -> StockSummaryRow:
        expected_closing = (
            self.opening_quantity
            + self.receipts_quantity
            - self.issues_quantity
            + self.net_adjustment_quantity
        )

        if self.closing_quantity != expected_closing:
            raise ValueError(
                "Closing stock does not reconcile with "
                "opening stock and movements."
            )

        return self


class StockSummaryReport(ReportSchema):
    """Stock summary across raw, packaging, and finished goods."""

    metadata: ReportMetadata
    rows: list[StockSummaryRow]
    total_stock_value: NonnegativeMoney
    pagination: ReportPage


class StockLedgerRow(ReportSchema):
    """Traceable stock movement with running quantity balance."""

    movement_id: UUID
    movement_date: datetime
    item_id: UUID
    item_name: str
    batch_id: UUID | None
    movement_type: str
    direction: Literal["IN", "OUT"]
    location: InventoryLocation
    source_type: str
    source_id: UUID
    source_line_id: UUID
    quantity_in: NonnegativeQuantity
    quantity_out: NonnegativeQuantity
    running_balance: NonnegativeQuantity
    unit_cost: UnitCost

    @model_validator(mode="after")
    def validate_movement(self) -> StockLedgerRow:
        if self.direction == "IN":
            if self.quantity_out != Decimal("0"):
                raise ValueError(
                    "Incoming stock movement cannot have "
                    "an outgoing quantity."
                )
        elif self.quantity_in != Decimal("0"):
            raise ValueError(
                "Outgoing stock movement cannot have "
                "an incoming quantity."
            )

        return self


class StockLedgerReport(ReportSchema):
    """Chronological stock ledger for a selected inventory item."""

    metadata: ReportMetadata
    item_id: UUID
    location: InventoryLocation
    opening_balance: NonnegativeQuantity
    closing_balance: NonnegativeQuantity
    rows: list[StockLedgerRow]
    pagination: ReportPage


class InventoryValuationRow(ReportSchema):
    """Moving weighted-average valuation of an inventory item."""

    item_id: UUID
    item_code: str
    item_name: str
    item_type: InventoryItemType
    base_unit: str
    location: InventoryLocation
    quantity_on_hand: NonnegativeQuantity
    average_unit_cost: UnitCost
    stock_value: NonnegativeMoney


class InventoryValuationReport(ReportSchema):
    """Inventory valuation using recorded weighted-average costs."""

    metadata: ReportMetadata
    rows: list[InventoryValuationRow]
    total_stock_value: NonnegativeMoney
    pagination: ReportPage


class ProductionMaterialReportRow(ReportSchema):
    """Planned and actual consumption for one production material."""

    production_material_id: UUID
    item_id: UUID
    item_name: str
    unit: str
    planned_quantity: NonnegativeQuantity
    issued_quantity: NonnegativeQuantity
    actual_quantity: NonnegativeQuantity
    wasted_quantity: NonnegativeQuantity
    returned_quantity: NonnegativeQuantity
    variance_quantity: Quantity
    variance_percentage: Percentage | None

    @model_validator(mode="after")
    def validate_variance(
        self,
    ) -> ProductionMaterialReportRow:
        if self.variance_quantity != (
            self.actual_quantity - self.planned_quantity
        ):
            raise ValueError(
                "Material variance does not reconcile."
            )

        if (
            self.planned_quantity == Decimal("0")
            and self.variance_percentage is not None
        ):
            raise ValueError(
                "Variance percentage is undefined "
                "when planned quantity is zero."
            )

        return self


class ProductionReportRow(ReportSchema):
    """Production run output, yield, wastage, and costing."""

    production_run_id: UUID
    production_number: str
    product_id: UUID
    product_name: str
    supervisor_id: UUID
    production_date: date
    status: str
    planned_output: NonnegativeQuantity
    actual_output: NonnegativeQuantity
    good_output: NonnegativeQuantity
    rejected_output: NonnegativeQuantity
    yield_variance_quantity: Quantity
    yield_variance_percentage: Percentage | None
    material_cost: NonnegativeMoney
    packaging_cost: NonnegativeMoney
    overhead_cost: NonnegativeMoney
    total_cost: NonnegativeMoney
    cost_per_good_unit: UnitCost | None
    materials: list[ProductionMaterialReportRow]

    @model_validator(mode="after")
    def validate_production_totals(
        self,
    ) -> ProductionReportRow:
        if self.actual_output != (
            self.good_output + self.rejected_output
        ):
            raise ValueError(
                "Actual production output must equal "
                "good and rejected output."
            )

        if self.yield_variance_quantity != (
            self.good_output - self.planned_output
        ):
            raise ValueError(
                "Production yield variance does not reconcile."
            )

        if self.total_cost != (
            self.material_cost
            + self.packaging_cost
            + self.overhead_cost
        ):
            raise ValueError(
                "Production cost does not reconcile."
            )

        if (
            self.planned_output == Decimal("0")
            and self.yield_variance_percentage is not None
        ):
            raise ValueError(
                "Yield variance percentage is undefined "
                "when planned output is zero."
            )

        if (
            self.good_output == Decimal("0")
            and self.cost_per_good_unit is not None
        ):
            raise ValueError(
                "Cost per good unit is undefined "
                "when good output is zero."
            )

        return self


class ProductionReport(ReportSchema):
    """Production report with material variance and costing details."""

    metadata: ReportMetadata
    rows: list[ProductionReportRow]
    pagination: ReportPage


class GSTSummaryRow(ReportSchema):
    """
    GST outward-supply aggregation by rate and supply classification.

    This structure supports reconciliation and preparation of
    GSTR-1/GSTR-3B-oriented outward-supply summaries. It is not
    a government filing submission.
    """

    tax_rate: Decimal = Field(
        ge=0,
        le=100,
        max_digits=7,
        decimal_places=4,
        allow_inf_nan=False,
    )
    is_interstate: bool
    invoice_count: int = Field(ge=0)
    taxable_amount: NonnegativeMoney
    cgst_amount: NonnegativeMoney
    sgst_amount: NonnegativeMoney
    igst_amount: NonnegativeMoney
    total_amount: NonnegativeMoney

    @model_validator(mode="after")
    def validate_gst(self) -> GSTSummaryRow:
        if self.cgst_amount != self.sgst_amount:
            raise ValueError(
                "CGST and SGST must be equal."
            )

        if self.is_interstate:
            if (
                self.cgst_amount != Decimal("0")
                or self.sgst_amount != Decimal("0")
            ):
                raise ValueError(
                    "Inter-state supplies must not include "
                    "CGST or SGST."
                )
        elif self.igst_amount != Decimal("0"):
            raise ValueError(
                "Intra-state supplies must not include IGST."
            )

        expected_total = (
            self.taxable_amount
            + self.cgst_amount
            + self.sgst_amount
            + self.igst_amount
        )

        if self.total_amount != expected_total:
            raise ValueError(
                "GST summary total does not reconcile."
            )

        return self


class GSTSummaryTotals(ReportSchema):
    """Aggregated outward GST amounts."""

    taxable_amount: NonnegativeMoney
    cgst_amount: NonnegativeMoney
    sgst_amount: NonnegativeMoney
    igst_amount: NonnegativeMoney
    total_amount: NonnegativeMoney

    @model_validator(mode="after")
    def validate_totals(self) -> GSTSummaryTotals:
        if self.cgst_amount != self.sgst_amount:
            raise ValueError(
                "Total CGST and SGST must be equal."
            )

        expected_total = (
            self.taxable_amount
            + self.cgst_amount
            + self.sgst_amount
            + self.igst_amount
        )

        if self.total_amount != expected_total:
            raise ValueError(
                "GST totals do not reconcile."
            )

        return self


class GSTSummaryReport(ReportSchema):
    """Outward GST report with tax-rate breakdown and totals."""

    metadata: ReportMetadata
    financial_year: str | None
    rows: list[GSTSummaryRow]
    totals: GSTSummaryTotals
    pagination: ReportPage


class PaymentCollectionRow(ReportSchema):
    """Posted customer payment and effective allocation amounts."""

    payment_id: UUID
    customer_id: UUID
    customer_name: str
    payment_date: date
    payment_method: str
    reference_number: str | None
    payment_amount: NonnegativeMoney
    allocated_amount: NonnegativeMoney
    unallocated_amount: NonnegativeMoney

    @model_validator(mode="after")
    def validate_allocation(self) -> PaymentCollectionRow:
        if self.payment_amount != (
            self.allocated_amount + self.unallocated_amount
        ):
            raise ValueError(
                "Payment collection amounts do not reconcile."
            )

        return self


class PaymentCollectionTotals(ReportSchema):
    """Aggregated effective customer collections."""

    payment_count: int = Field(ge=0)
    total_collections: NonnegativeMoney
    total_allocated: NonnegativeMoney
    total_unallocated: NonnegativeMoney

    @model_validator(mode="after")
    def validate_totals(self) -> PaymentCollectionTotals:
        if self.total_collections != (
            self.total_allocated + self.total_unallocated
        ):
            raise ValueError(
                "Collection totals do not reconcile."
            )

        return self


class PaymentCollectionsReport(ReportSchema):
    """Payments and collections register."""

    metadata: ReportMetadata
    rows: list[PaymentCollectionRow]
    totals: PaymentCollectionTotals
    pagination: ReportPage


class ReceivableInvoiceRow(ReportSchema):
    """Invoice-level outstanding receivable and ageing classification."""

    invoice_id: UUID
    invoice_number: str
    customer_id: UUID
    customer_name: str
    invoice_date: date
    due_date: date
    invoice_amount: NonnegativeMoney
    credited_amount: NonnegativeMoney
    paid_amount: NonnegativeMoney
    outstanding_amount: NonnegativeMoney
    days_overdue: int = Field(ge=0)
    ageing_bucket: ReceivableAgeBucket

    @model_validator(mode="after")
    def validate_outstanding(self) -> ReceivableInvoiceRow:
        expected_outstanding = (
            self.invoice_amount
            - self.credited_amount
            - self.paid_amount
        )

        if expected_outstanding < Decimal("0"):
            raise ValueError(
                "Payments and credits cannot exceed "
                "the invoice amount."
            )

        if self.outstanding_amount != expected_outstanding:
            raise ValueError(
                "Invoice receivable balance does not reconcile."
            )

        return self


class ReceivableAgeingTotals(ReportSchema):
    """Receivables aggregated by ageing bucket."""

    current: NonnegativeMoney
    days_1_30: NonnegativeMoney
    days_31_60: NonnegativeMoney
    days_61_90: NonnegativeMoney
    over_90: NonnegativeMoney
    total_outstanding: NonnegativeMoney

    @model_validator(mode="after")
    def validate_ageing(self) -> ReceivableAgeingTotals:
        expected_total = (
            self.current
            + self.days_1_30
            + self.days_31_60
            + self.days_61_90
            + self.over_90
        )

        if self.total_outstanding != expected_total:
            raise ValueError(
                "Receivable ageing buckets do not reconcile."
            )

        return self


class CustomerReceivableRow(ReportSchema):
    """Customer-level receivables and ageing balances."""

    customer_id: UUID
    customer_name: str
    invoice_count: int = Field(ge=0)
    ageing: ReceivableAgeingTotals


class OutstandingReceivablesReport(ReportSchema):
    """Customer and invoice receivables as of a specified date."""

    metadata: ReportMetadata
    invoices: list[ReceivableInvoiceRow]
    customers: list[CustomerReceivableRow]
    totals: ReceivableAgeingTotals
    pagination: ReportPage


class DispatchHistoryRow(ReportSchema):
    """Posted dispatch with invoice and finished-goods batch traceability."""

    dispatch_id: UUID
    dispatch_number: str
    dispatch_date: date
    invoice_id: UUID
    invoice_number: str
    customer_id: UUID
    customer_name: str
    dispatch_item_id: UUID
    product_id: UUID
    product_name: str
    batch_id: UUID
    batch_number: str
    quantity: NonnegativeQuantity


class DispatchHistoryReport(ReportSchema):
    """Dispatch register with batch-level shipment history."""

    metadata: ReportMetadata
    rows: list[DispatchHistoryRow]
    total_dispatched_quantity: NonnegativeQuantity
    pagination: ReportPage


class AuditTrailRow(ReportSchema):
    """Immutable business-transaction audit event."""

    audit_id: UUID
    user_id: UUID
    entity_type: str
    entity_id: UUID
    action: str
    old_values: dict[str, object] | None
    new_values: dict[str, object] | None
    timestamp: datetime


class AuditTrailReport(ReportSchema):
    """Authorized audit history with transaction references."""

    metadata: ReportMetadata
    rows: list[AuditTrailRow]
    pagination: ReportPage


class ReportExportRequest(ReportSchema):
    """
    Request export of an authorized report.

    The export service must reuse the same business filters,
    aggregation rules, and access restrictions as the report API.
    Exporting must not modify operational or financial records.
    """

    report_type: ReportType
    export_format: ExportFormat
    start_date: date | None = None
    end_date: date | None = None
    as_of_date: date | None = None
    customer_id: UUID | None = None
    supplier_id: UUID | None = None
    product_id: UUID | None = None
    item_id: UUID | None = None
    salesman_id: UUID | None = None

    @model_validator(mode="after")
    def validate_export_dates(self) -> ReportExportRequest:
        if (
            self.start_date is None
            and self.end_date is not None
        ):
            raise ValueError(
                "Start date is required when end date is supplied."
            )

        if (
            self.start_date is not None
            and self.end_date is None
        ):
            raise ValueError(
                "End date is required when start date is supplied."
            )

        if (
            self.start_date is not None
            and self.end_date is not None
            and self.end_date < self.start_date
        ):
            raise ValueError(
                "Export end date cannot precede start date."
            )

        if self.report_type == "OUTSTANDING_RECEIVABLES":
            if self.as_of_date is None:
                raise ValueError(
                    "Receivables export requires an as-of date."
                )
        elif (
            self.start_date is None
            or self.end_date is None
        ):
            raise ValueError(
                "A date range is required for this report export."
            )

        return self


class ReportExportResponse(ReportSchema):
    """Metadata for a successfully generated report export."""

    report_type: ReportType
    export_format: ExportFormat
    filename: str
    content_type: str
    generated_at: datetime
    row_count: int = Field(ge=0)