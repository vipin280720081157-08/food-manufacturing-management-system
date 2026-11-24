"""
Pydantic v2 schemas for production runs, material allocation,
consumption, wastage, returns, finished output, expenses, and costing.

Persisted response fields match the Development 03A SQLAlchemy models
defined in app.models.production.

Production material issues, consumption, wastage, returns, and finished
output are separate operations. The production service must enforce
authorization, inventory reconciliation, batch traceability, atomic
posting, and idempotency.

Production expenses may be recorded after completion. Such expenses
update costing without reposting finished goods or material movements.
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

NonnegativePercentage = Annotated[
    Decimal,
    Field(
        ge=0,
        max_digits=12,
        decimal_places=2,
        allow_inf_nan=False,
    ),
]

UnitName = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        min_length=1,
        max_length=30,
    ),
]

ExpenseCategory = Annotated[
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

ProductionStatus = Literal[
    "DRAFT",
    "IN_PROGRESS",
    "COMPLETED",
    "CANCELLED",
]


class ProductionSchema(BaseModel):
    """Shared configuration for production request schemas."""

    model_config = ConfigDict(
        extra="forbid",
        str_strip_whitespace=True,
    )


class ProductionResponseSchema(ProductionSchema):
    """Shared configuration for ORM-backed production responses."""

    model_config = ConfigDict(
        from_attributes=True,
        extra="forbid",
        str_strip_whitespace=True,
    )


class ProductionRunCreate(ProductionSchema):
    """
    Request to create a draft production run.

    The backend generates production_number, identifies the
    authenticated supervisor, and validates that the selected
    BOM belongs to the product and is effective for the run.

    Planned material requirements are calculated from the
    selected BOM version and planned output.
    """

    product_id: UUID
    bom_id: UUID
    planned_output: PositiveQuantity


class ProductionRunUpdate(ProductionSchema):
    """
    Editable production-run planning values.

    The backend must reject modifications once the run's status
    or posted transactions make the requested change unsafe.
    """

    bom_id: UUID | None = None
    planned_output: PositiveQuantity | None = None

    @model_validator(mode="after")
    def validate_update(self) -> ProductionRunUpdate:
        if not self.model_fields_set:
            raise ValueError(
                "At least one production-run field must be provided."
            )

        for field_name in self.model_fields_set:
            if getattr(self, field_name) is None:
                raise ValueError(
                    f"{field_name} cannot be null."
                )

        return self


class ProductionRunStartRequest(ProductionSchema):
    """
    Start a draft production run.

    The service records the authoritative start_time and changes
    the status to IN_PROGRESS within a controlled transaction.
    """


class ProductionRunCancellationRequest(ProductionSchema):
    """
    Request cancellation of an eligible production run.

    The service must prevent deletion of posted inventory history
    and require traceable reversals where applicable.
    """

    reason: RequiredReason


class ProductionMaterialIssueItem(ProductionSchema):
    """
    Issue a specified quantity of one inventory batch to production.

    Batch eligibility, available warehouse stock, and unit
    compatibility are verified by the inventory service.
    """

    item_id: UUID
    batch_id: UUID
    quantity: PositiveQuantity
    unit: UnitName


class ProductionMaterialIssueRequest(ProductionSchema):
    """
    Issue material batches to an in-progress production run.

    Material issues transfer inventory into production-held stock.
    They do not by themselves establish actual consumption.
    """

    items: list[ProductionMaterialIssueItem] = Field(
        ...,
        min_length=1,
    )

    @model_validator(mode="after")
    def validate_unique_batches(
        self,
    ) -> ProductionMaterialIssueRequest:
        keys = [
            (item.item_id, item.batch_id)
            for item in self.items
        ]

        if len(keys) != len(set(keys)):
            raise ValueError(
                "Each inventory item and batch may appear "
                "only once in a material issue request."
            )

        return self


class ProductionMaterialUsageItem(ProductionSchema):
    """
    Record actual usage of an issued production-material allocation.

    Actual consumption and wastage are separate quantities.
    Both reduce the material still held by production.
    """

    production_material_id: UUID
    actual_quantity: NonnegativeQuantity
    wasted_quantity: NonnegativeQuantity

    @model_validator(mode="after")
    def validate_usage(self) -> ProductionMaterialUsageItem:
        if (
            self.actual_quantity + self.wasted_quantity
            <= Decimal("0")
        ):
            raise ValueError(
                "Material usage must include positive consumption "
                "or wastage."
            )

        return self


class ProductionMaterialUsageRequest(ProductionSchema):
    """Record actual material consumption and wastage."""

    items: list[ProductionMaterialUsageItem] = Field(
        ...,
        min_length=1,
    )

    @model_validator(mode="after")
    def validate_unique_materials(
        self,
    ) -> ProductionMaterialUsageRequest:
        identifiers = [
            item.production_material_id
            for item in self.items
        ]

        if len(identifiers) != len(set(identifiers)):
            raise ValueError(
                "A production-material allocation may appear "
                "only once in a usage request."
            )

        return self


class ProductionMaterialReturnItem(ProductionSchema):
    """Return unused production-held material to warehouse stock."""

    production_material_id: UUID
    returned_quantity: PositiveQuantity


class ProductionMaterialReturnRequest(ProductionSchema):
    """Return unused issued materials through traceable stock movements."""

    items: list[ProductionMaterialReturnItem] = Field(
        ...,
        min_length=1,
    )

    @model_validator(mode="after")
    def validate_unique_materials(
        self,
    ) -> ProductionMaterialReturnRequest:
        identifiers = [
            item.production_material_id
            for item in self.items
        ]

        if len(identifiers) != len(set(identifiers)):
            raise ValueError(
                "A production-material allocation may appear "
                "only once in a return request."
            )

        return self


class ProductionMaterialResponse(ProductionResponseSchema):
    """Persisted production-material allocation and reconciliation."""

    production_material_id: UUID
    production_run_id: UUID
    item_id: UUID
    batch_id: UUID
    planned_quantity: Decimal
    issued_quantity: Decimal
    actual_quantity: Decimal
    wasted_quantity: Decimal
    returned_quantity: Decimal
    unit: str
    applied_unit_cost: Decimal


class ProductionMaterialBalanceResponse(ProductionSchema):
    """Issued material quantities remaining under production control."""

    production_material_id: UUID
    item_id: UUID
    batch_id: UUID
    issued_quantity: NonnegativeQuantity
    actual_quantity: NonnegativeQuantity
    wasted_quantity: NonnegativeQuantity
    returned_quantity: NonnegativeQuantity
    remaining_issued_quantity: NonnegativeQuantity

    @model_validator(mode="after")
    def validate_reconciliation(
        self,
    ) -> ProductionMaterialBalanceResponse:
        expected_remaining = (
            self.issued_quantity
            - self.actual_quantity
            - self.wasted_quantity
            - self.returned_quantity
        )

        if expected_remaining < Decimal("0"):
            raise ValueError(
                "Material consumption, wastage, and returns "
                "cannot exceed issued quantity."
            )

        if self.remaining_issued_quantity != expected_remaining:
            raise ValueError(
                "Remaining issued quantity does not reconcile "
                "with material movements."
            )

        return self


class ProductionOutputCreate(ProductionSchema):
    """
    Record good and rejected output for a production run.

    Good output is eligible for finished-goods inventory.
    Rejected output is excluded from saleable stock and
    production cost-per-good-unit denominators.

    Batch creation and inventory posting are controlled
    by the production service.
    """

    good_quantity: NonnegativeQuantity
    rejected_quantity: NonnegativeQuantity
    unit: UnitName
    batch_number: Annotated[
        str,
        StringConstraints(
            strip_whitespace=True,
            min_length=1,
            max_length=100,
        ),
    ]
    manufacturing_date: date | None = None
    expiry_date: date | None = None

    @model_validator(mode="after")
    def validate_output(self) -> ProductionOutputCreate:
        if (
            self.good_quantity + self.rejected_quantity
            <= Decimal("0")
        ):
            raise ValueError(
                "Total recorded production output must be positive."
            )

        if (
            self.manufacturing_date is not None
            and self.expiry_date is not None
            and self.expiry_date < self.manufacturing_date
        ):
            raise ValueError(
                "Expiry date cannot precede manufacturing date."
            )

        return self


class ProductionOutputResponse(ProductionResponseSchema):
    """Persisted finished-output quantities linked to a stock batch."""

    output_id: UUID
    production_run_id: UUID
    product_id: UUID
    batch_id: UUID
    good_quantity: Decimal
    rejected_quantity: Decimal
    unit: str


class ProductionCompletionRequest(ProductionSchema):
    """
    Request completion of an in-progress production run.

    The backend must reconcile all issued material quantities,
    validate output records, prevent duplicate posting, and
    atomically finalize production and associated stock movements.
    """


class ProductionExpenseCreate(ProductionSchema):
    """
    Record a production expense against an existing run.

    Expenses may be recorded after physical production completion.
    They must update production costing without repeating inventory
    movements or changing historical production quantities.
    """

    expense_category: ExpenseCategory
    amount: Money
    description: str | None = None
    expense_date: date


class ProductionExpenseResponse(ProductionResponseSchema):
    """Persisted production expense."""

    expense_id: UUID
    production_run_id: UUID
    expense_category: str
    amount: Decimal
    description: str | None
    expense_date: date
    recorded_by: UUID
    created_at: datetime


class ProductionCostSummaryResponse(ProductionResponseSchema):
    """Current cost calculation for a production run."""

    cost_summary_id: UUID
    production_run_id: UUID
    material_cost: Decimal
    packaging_cost: Decimal
    overhead_cost: Decimal
    total_cost: Decimal
    good_output: Decimal
    cost_per_unit: Decimal
    calculated_at: datetime


class ProductionVarianceResponse(ProductionSchema):
    """Signed planned-versus-actual production variance."""

    planned_quantity: NonnegativeQuantity
    actual_quantity: NonnegativeQuantity
    variance_quantity: Decimal = Field(
        max_digits=18,
        decimal_places=3,
        allow_inf_nan=False,
    )
    variance_percentage: Percentage | None
    tolerance_percentage: NonnegativePercentage
    exceeds_tolerance: bool

    @model_validator(mode="after")
    def validate_variance(self) -> ProductionVarianceResponse:
        expected_difference = (
            self.actual_quantity - self.planned_quantity
        )

        if self.variance_quantity != expected_difference:
            raise ValueError(
                "Variance quantity does not match "
                "actual minus planned quantity."
            )

        if self.planned_quantity == Decimal("0"):
            if self.variance_percentage is not None:
                raise ValueError(
                    "Variance percentage must be undefined "
                    "when planned quantity is zero."
                )

            if self.exceeds_tolerance:
                raise ValueError(
                    "Undefined percentage variance cannot "
                    "exceed a percentage tolerance."
                )

        else:
            exact_percentage = (
                expected_difference
                / self.planned_quantity
                * Decimal("100")
            )

            expected_percentage = exact_percentage.quantize(
                Decimal("0.01")
            )

            if self.variance_percentage != expected_percentage:
                raise ValueError(
                    "Variance percentage does not reconcile "
                    "with planned and actual quantities."
                )

            if self.exceeds_tolerance != (
                abs(exact_percentage) > self.tolerance_percentage
            ):
                raise ValueError(
                    "Variance alert does not match the "
                    "configured tolerance."
                )

        return self


class ProductionMaterialVarianceResponse(ProductionSchema):
    """Consumption variance for one production material allocation."""

    production_material_id: UUID
    item_id: UUID
    batch_id: UUID
    unit: str
    variance: ProductionVarianceResponse


class ProductionAnalysisResponse(ProductionSchema):
    """Production yield and material consumption analysis."""

    production_run_id: UUID
    planned_output: NonnegativeQuantity
    actual_output: NonnegativeQuantity
    good_output: NonnegativeQuantity
    rejected_output: NonnegativeQuantity
    yield_variance: ProductionVarianceResponse
    material_variances: list[ProductionMaterialVarianceResponse]

    @model_validator(mode="after")
    def validate_output_totals(self) -> ProductionAnalysisResponse:
        if self.actual_output != (
            self.good_output + self.rejected_output
        ):
            raise ValueError(
                "Actual output must equal good plus rejected output."
            )

        if (
            self.yield_variance.planned_quantity
            != self.planned_output
        ):
            raise ValueError(
                "Yield variance planned quantity must match "
                "production planned output."
            )

        if (
            self.yield_variance.actual_quantity
            != self.good_output
        ):
            raise ValueError(
                "Yield variance actual quantity must use "
                "good finished output."
            )

        return self


class ProductionRunResponse(ProductionResponseSchema):
    """Persisted production-run header."""

    production_run_id: UUID
    production_number: str
    product_id: UUID
    bom_id: UUID
    supervisor_id: UUID
    planned_output: Decimal
    actual_output: Decimal
    good_output: Decimal
    rejected_output: Decimal
    start_time: datetime | None
    completion_time: datetime | None
    status: ProductionStatus


class ProductionRunDetailResponse(ProductionRunResponse):
    """Production run with materials, outputs, expenses, and costing."""

    materials: list[ProductionMaterialResponse]
    outputs: list[ProductionOutputResponse]
    expenses: list[ProductionExpenseResponse]
    cost_summary: ProductionCostSummaryResponse | None


class ProductionRunListResponse(ProductionSchema):
    """Paginated production-run listing."""

    items: list[ProductionRunResponse]
    total: int = Field(ge=0)
    page: int = Field(ge=1)
    page_size: int = Field(ge=1)


class ProductionRunStatusResponse(ProductionSchema):
    """Compact response after an authorized production transition."""

    production_run_id: UUID
    production_number: str
    status: ProductionStatus
    start_time: datetime | None
    completion_time: datetime | None


class ProductionMaterialIssueResponse(ProductionSchema):
    """Production-material allocations after an authorized stock issue."""

    production_run_id: UUID
    materials: list[ProductionMaterialResponse]


class ProductionMaterialUsageResponse(ProductionSchema):
    """Updated production-material records after usage posting."""

    production_run_id: UUID
    materials: list[ProductionMaterialResponse]


class ProductionMaterialReturnResponse(ProductionSchema):
    """Updated production-material records after return posting."""

    production_run_id: UUID
    materials: list[ProductionMaterialResponse]


class ProductionOutputPostingResponse(ProductionSchema):
    """Production output and its resulting batch reference."""

    production_run_id: UUID
    output: ProductionOutputResponse


class ProductionCompletionResponse(ProductionSchema):
    """Completed run with its posted production and costing results."""

    production_run: ProductionRunResponse
    cost_summary: ProductionCostSummaryResponse | None