"""
Production runs, material consumption, finished-goods outputs,
production expenses, and production costing summaries.

Production records retain the selected BOM version, material
cost snapshots, batch traceability, and actual output quantities.

Inventory posting and costing recalculation are performed by
the service layer within controlled database transactions.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import TYPE_CHECKING

from sqlalchemy import (
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import (
    Base,
    MONEY_TYPE,
    QUANTITY_TYPE,
    UNIT_COST_TYPE,
)

if TYPE_CHECKING:
    from app.models.bom import ProductBOM
    from app.models.inventory import StockBatch
    from app.models.product import InventoryItem, Product
    from app.models.user import User


class ProductionRun(Base):
    """Manufacturing run linked to a specific BOM version."""

    __tablename__ = "production_runs"

    __table_args__ = (
        CheckConstraint(
            "length(btrim(production_number)) > 0",
            name="production_number_not_blank",
        ),
        CheckConstraint(
            "status IN ("
            "'DRAFT', "
            "'IN_PROGRESS', "
            "'COMPLETED', "
            "'CANCELLED'"
            ")",
            name="valid_status",
        ),
        CheckConstraint(
            "planned_output > 0",
            name="planned_output_positive",
        ),
        CheckConstraint(
            "actual_output >= 0",
            name="actual_output_nonnegative",
        ),
        CheckConstraint(
            "good_output >= 0",
            name="good_output_nonnegative",
        ),
        CheckConstraint(
            "rejected_output >= 0",
            name="rejected_output_nonnegative",
        ),
        CheckConstraint(
            "actual_output = good_output + rejected_output",
            name="output_quantities_reconciled",
        ),
        CheckConstraint(
            "completion_time IS NULL "
            "OR start_time IS NULL "
            "OR completion_time >= start_time",
            name="completion_time_valid",
        ),
        CheckConstraint(
            "status <> 'COMPLETED' "
            "OR completion_time IS NOT NULL",
            name="completed_requires_timestamp",
        ),
        CheckConstraint(
            "status <> 'COMPLETED' "
            "OR actual_output > 0",
            name="completed_requires_output",
        ),
        Index(
            "ix_production_runs_product_id",
            "product_id",
        ),
        Index(
            "ix_production_runs_bom_id",
            "bom_id",
        ),
        Index(
            "ix_production_runs_supervisor_id",
            "supervisor_id",
        ),
        Index(
            "ix_production_runs_status",
            "status",
        ),
        Index(
            "ix_production_runs_start_time",
            "start_time",
        ),
    )

    production_run_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        nullable=False,
    )

    production_number: Mapped[str] = mapped_column(
        String(100),
        nullable=False,
        unique=True,
    )

    product_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "products.product_id",
            ondelete="RESTRICT",
        ),
        nullable=False,
    )

    bom_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "product_boms.bom_id",
            ondelete="RESTRICT",
        ),
        nullable=False,
    )

    supervisor_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "users.user_id",
            ondelete="RESTRICT",
        ),
        nullable=False,
    )

    planned_output: Mapped[Decimal] = mapped_column(
        QUANTITY_TYPE,
        nullable=False,
    )

    actual_output: Mapped[Decimal] = mapped_column(
        QUANTITY_TYPE,
        nullable=False,
        default=Decimal("0.000"),
        server_default=text("0"),
    )

    good_output: Mapped[Decimal] = mapped_column(
        QUANTITY_TYPE,
        nullable=False,
        default=Decimal("0.000"),
        server_default=text("0"),
    )

    rejected_output: Mapped[Decimal] = mapped_column(
        QUANTITY_TYPE,
        nullable=False,
        default=Decimal("0.000"),
        server_default=text("0"),
    )

    start_time: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )

    completion_time: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )

    status: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
        default="DRAFT",
        server_default=text("'DRAFT'"),
    )

    product: Mapped[Product] = relationship(
        "Product",
        foreign_keys=[product_id],
        lazy="selectin",
    )

    bom: Mapped[ProductBOM] = relationship(
        "ProductBOM",
        foreign_keys=[bom_id],
        lazy="selectin",
    )

    supervisor: Mapped[User] = relationship(
        "User",
        foreign_keys=[supervisor_id],
        lazy="selectin",
    )

    materials: Mapped[list[ProductionMaterial]] = relationship(
        "ProductionMaterial",
        back_populates="production_run",
        cascade="save-update, merge",
        passive_deletes=True,
    )

    outputs: Mapped[list[ProductionOutput]] = relationship(
        "ProductionOutput",
        back_populates="production_run",
        cascade="save-update, merge",
        passive_deletes=True,
    )

    expenses: Mapped[list[ProductionExpense]] = relationship(
        "ProductionExpense",
        back_populates="production_run",
        cascade="save-update, merge",
        passive_deletes=True,
    )

    cost_summary: Mapped[ProductionCostSummary | None] = relationship(
        "ProductionCostSummary",
        back_populates="production_run",
        uselist=False,
        cascade="save-update, merge",
        passive_deletes=True,
    )

    def __repr__(self) -> str:
        return (
            f"ProductionRun("
            f"production_run_id={self.production_run_id!r}, "
            f"production_number={self.production_number!r}, "
            f"status={self.status!r})"
        )


class ProductionMaterial(Base):
    """
    Material allocation and consumption for a production run.

    Issued material is held in production inventory until
    consumed, wasted, or returned.

    Remaining issued material may exist while production is
    in progress. Completion requires full reconciliation.
    """

    __tablename__ = "production_materials"

    __table_args__ = (
        UniqueConstraint(
            "production_run_id",
            "item_id",
            "batch_id",
            name="uq_production_materials_run_item_batch",
        ),
        CheckConstraint(
            "planned_quantity >= 0",
            name="planned_quantity_nonnegative",
        ),
        CheckConstraint(
            "issued_quantity >= 0",
            name="issued_quantity_nonnegative",
        ),
        CheckConstraint(
            "actual_quantity >= 0",
            name="actual_quantity_nonnegative",
        ),
        CheckConstraint(
            "wasted_quantity >= 0",
            name="wasted_quantity_nonnegative",
        ),
        CheckConstraint(
            "returned_quantity >= 0",
            name="returned_quantity_nonnegative",
        ),
        CheckConstraint(
            "actual_quantity + wasted_quantity + "
            "returned_quantity <= issued_quantity",
            name="issued_quantity_not_exceeded",
        ),
        CheckConstraint(
            "applied_unit_cost >= 0",
            name="applied_unit_cost_nonnegative",
        ),
        CheckConstraint(
            "length(btrim(unit)) > 0",
            name="unit_not_blank",
        ),
        Index(
            "ix_production_materials_item_id",
            "item_id",
        ),
        Index(
            "ix_production_materials_batch_id",
            "batch_id",
        ),
    )

    production_material_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        nullable=False,
    )

    production_run_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "production_runs.production_run_id",
            ondelete="RESTRICT",
        ),
        nullable=False,
    )

    item_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "inventory_items.item_id",
            ondelete="RESTRICT",
        ),
        nullable=False,
    )

    batch_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "stock_batches.batch_id",
            ondelete="RESTRICT",
        ),
        nullable=False,
    )

    planned_quantity: Mapped[Decimal] = mapped_column(
        QUANTITY_TYPE,
        nullable=False,
        default=Decimal("0.000"),
        server_default=text("0"),
    )

    issued_quantity: Mapped[Decimal] = mapped_column(
        QUANTITY_TYPE,
        nullable=False,
        default=Decimal("0.000"),
        server_default=text("0"),
    )

    actual_quantity: Mapped[Decimal] = mapped_column(
        QUANTITY_TYPE,
        nullable=False,
        default=Decimal("0.000"),
        server_default=text("0"),
    )

    wasted_quantity: Mapped[Decimal] = mapped_column(
        QUANTITY_TYPE,
        nullable=False,
        default=Decimal("0.000"),
        server_default=text("0"),
    )

    returned_quantity: Mapped[Decimal] = mapped_column(
        QUANTITY_TYPE,
        nullable=False,
        default=Decimal("0.000"),
        server_default=text("0"),
    )

    unit: Mapped[str] = mapped_column(
        String(30),
        nullable=False,
    )

    applied_unit_cost: Mapped[Decimal] = mapped_column(
        UNIT_COST_TYPE,
        nullable=False,
        default=Decimal("0.000000"),
        server_default=text("0"),
    )

    production_run: Mapped[ProductionRun] = relationship(
        "ProductionRun",
        back_populates="materials",
    )

    inventory_item: Mapped[InventoryItem] = relationship(
        "InventoryItem",
        foreign_keys=[item_id],
        lazy="selectin",
    )

    batch: Mapped[StockBatch] = relationship(
        "StockBatch",
        foreign_keys=[batch_id],
        lazy="selectin",
    )

    @property
    def remaining_issued_quantity(self) -> Decimal:
        """Calculate material still held by production."""

        return (
            self.issued_quantity
            - self.actual_quantity
            - self.wasted_quantity
            - self.returned_quantity
        )

    @property
    def material_variance(self) -> Decimal:
        """Actual consumption minus planned consumption."""

        return self.actual_quantity - self.planned_quantity

    def __repr__(self) -> str:
        return (
            f"ProductionMaterial("
            f"production_material_id={self.production_material_id!r}, "
            f"production_run_id={self.production_run_id!r}, "
            f"item_id={self.item_id!r}, "
            f"actual_quantity={self.actual_quantity!r})"
        )


class ProductionOutput(Base):
    """Accepted and rejected finished-goods output by batch."""

    __tablename__ = "production_outputs"

    __table_args__ = (
        UniqueConstraint(
            "production_run_id",
            "batch_id",
            name="uq_production_outputs_run_batch",
        ),
        CheckConstraint(
            "good_quantity >= 0",
            name="good_quantity_nonnegative",
        ),
        CheckConstraint(
            "rejected_quantity >= 0",
            name="rejected_quantity_nonnegative",
        ),
        CheckConstraint(
            "good_quantity + rejected_quantity > 0",
            name="output_quantity_positive",
        ),
        CheckConstraint(
            "length(btrim(unit)) > 0",
            name="unit_not_blank",
        ),
        Index(
            "ix_production_outputs_product_id",
            "product_id",
        ),
        Index(
            "ix_production_outputs_batch_id",
            "batch_id",
        ),
    )

    output_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        nullable=False,
    )

    production_run_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "production_runs.production_run_id",
            ondelete="RESTRICT",
        ),
        nullable=False,
    )

    product_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "products.product_id",
            ondelete="RESTRICT",
        ),
        nullable=False,
    )

    batch_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "stock_batches.batch_id",
            ondelete="RESTRICT",
        ),
        nullable=False,
    )

    good_quantity: Mapped[Decimal] = mapped_column(
        QUANTITY_TYPE,
        nullable=False,
        default=Decimal("0.000"),
        server_default=text("0"),
    )

    rejected_quantity: Mapped[Decimal] = mapped_column(
        QUANTITY_TYPE,
        nullable=False,
        default=Decimal("0.000"),
        server_default=text("0"),
    )

    unit: Mapped[str] = mapped_column(
        String(30),
        nullable=False,
    )

    production_run: Mapped[ProductionRun] = relationship(
        "ProductionRun",
        back_populates="outputs",
    )

    product: Mapped[Product] = relationship(
        "Product",
        foreign_keys=[product_id],
        lazy="selectin",
    )

    batch: Mapped[StockBatch] = relationship(
        "StockBatch",
        foreign_keys=[batch_id],
        lazy="selectin",
    )

    def __repr__(self) -> str:
        return (
            f"ProductionOutput(output_id={self.output_id!r}, "
            f"production_run_id={self.production_run_id!r}, "
            f"good_quantity={self.good_quantity!r}, "
            f"rejected_quantity={self.rejected_quantity!r})"
        )


class ProductionExpense(Base):
    """
    Labour, utilities, and other production expenses.

    Expenses may be recorded after physical completion.
    Cost summaries must then be recalculated without
    reposting inventory movements.
    """

    __tablename__ = "production_expenses"

    __table_args__ = (
        CheckConstraint(
            "length(btrim(expense_category)) > 0",
            name="expense_category_not_blank",
        ),
        CheckConstraint(
            "amount >= 0",
            name="amount_nonnegative",
        ),
        Index(
            "ix_production_expenses_run_date",
            "production_run_id",
            "expense_date",
        ),
        Index(
            "ix_production_expenses_recorded_by",
            "recorded_by",
        ),
    )

    expense_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        nullable=False,
    )

    production_run_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "production_runs.production_run_id",
            ondelete="RESTRICT",
        ),
        nullable=False,
    )

    expense_category: Mapped[str] = mapped_column(
        String(100),
        nullable=False,
    )

    amount: Mapped[Decimal] = mapped_column(
        MONEY_TYPE,
        nullable=False,
    )

    description: Mapped[str | None] = mapped_column(
        Text,
        nullable=True,
    )

    expense_date: Mapped[date] = mapped_column(
        Date,
        nullable=False,
    )

    recorded_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "users.user_id",
            ondelete="RESTRICT",
        ),
        nullable=False,
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )

    production_run: Mapped[ProductionRun] = relationship(
        "ProductionRun",
        back_populates="expenses",
    )

    recorder: Mapped[User] = relationship(
        "User",
        foreign_keys=[recorded_by],
        lazy="selectin",
    )

    def __repr__(self) -> str:
        return (
            f"ProductionExpense(expense_id={self.expense_id!r}, "
            f"production_run_id={self.production_run_id!r}, "
            f"expense_category={self.expense_category!r}, "
            f"amount={self.amount!r})"
        )


class ProductionCostSummary(Base):
    """
    Current production cost calculation for one production run.

    Material and packaging costs use recorded consumption
    quantities and their applicable unit-cost snapshots.

    Late expenses update this summary without duplicating
    finished-goods stock movements.
    """

    __tablename__ = "production_cost_summaries"

    __table_args__ = (
        UniqueConstraint(
            "production_run_id",
            name="uq_production_cost_summaries_run",
        ),
        CheckConstraint(
            "material_cost >= 0",
            name="material_cost_nonnegative",
        ),
        CheckConstraint(
            "packaging_cost >= 0",
            name="packaging_cost_nonnegative",
        ),
        CheckConstraint(
            "overhead_cost >= 0",
            name="overhead_cost_nonnegative",
        ),
        CheckConstraint(
            "total_cost >= 0",
            name="total_cost_nonnegative",
        ),
        CheckConstraint(
            "good_output > 0",
            name="good_output_positive",
        ),
        CheckConstraint(
            "cost_per_unit >= 0",
            name="cost_per_unit_nonnegative",
        ),
        CheckConstraint(
            "total_cost = "
            "material_cost + packaging_cost + overhead_cost",
            name="total_cost_reconciled",
        ),
    )

    cost_summary_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        nullable=False,
    )

    production_run_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "production_runs.production_run_id",
            ondelete="RESTRICT",
        ),
        nullable=False,
    )

    material_cost: Mapped[Decimal] = mapped_column(
        MONEY_TYPE,
        nullable=False,
        default=Decimal("0.00"),
        server_default=text("0"),
    )

    packaging_cost: Mapped[Decimal] = mapped_column(
        MONEY_TYPE,
        nullable=False,
        default=Decimal("0.00"),
        server_default=text("0"),
    )

    overhead_cost: Mapped[Decimal] = mapped_column(
        MONEY_TYPE,
        nullable=False,
        default=Decimal("0.00"),
        server_default=text("0"),
    )

    total_cost: Mapped[Decimal] = mapped_column(
        MONEY_TYPE,
        nullable=False,
        default=Decimal("0.00"),
        server_default=text("0"),
    )

    good_output: Mapped[Decimal] = mapped_column(
        QUANTITY_TYPE,
        nullable=False,
    )

    cost_per_unit: Mapped[Decimal] = mapped_column(
        UNIT_COST_TYPE,
        nullable=False,
        default=Decimal("0.000000"),
        server_default=text("0"),
    )

    calculated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    production_run: Mapped[ProductionRun] = relationship(
        "ProductionRun",
        back_populates="cost_summary",
    )

    def __repr__(self) -> str:
        return (
            f"ProductionCostSummary("
            f"cost_summary_id={self.cost_summary_id!r}, "
            f"production_run_id={self.production_run_id!r}, "
            f"total_cost={self.total_cost!r}, "
            f"cost_per_unit={self.cost_per_unit!r})"
        )