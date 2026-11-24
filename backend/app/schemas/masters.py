
"""
Pydantic v2 schemas for the Food Manufacturing Management System master data.

Covers customers, suppliers, inventory items, finished products,
raw materials, packaging materials, unit conversions, and BOMs.

Field names follow the Development 03A SQLAlchemy models.
All financial and quantity values use Decimal.
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Literal
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    EmailStr,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)


Quantity = Annotated[
    Decimal,
    Field(
        max_digits=18,
        decimal_places=3,
        ge=0,
        allow_inf_nan=False,
    ),
]

PositiveQuantity = Annotated[
    Decimal,
    Field(
        max_digits=18,
        decimal_places=3,
        gt=0,
        allow_inf_nan=False,
    ),
]

Money = Annotated[
    Decimal,
    Field(
        max_digits=18,
        decimal_places=2,
        ge=0,
        allow_inf_nan=False,
    ),
]

UnitPrice = Annotated[
    Decimal,
    Field(
        max_digits=18,
        decimal_places=6,
        ge=0,
        allow_inf_nan=False,
    ),
]

TaxRate = Annotated[
    Decimal,
    Field(
        max_digits=7,
        decimal_places=4,
        ge=0,
        le=100,
        allow_inf_nan=False,
    ),
]

RequiredName = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        min_length=1,
        max_length=200,
    ),
]

ItemCode = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        min_length=1,
        max_length=100,
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

GSTIN = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        pattern=r"^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$",
        min_length=15,
        max_length=15,
    ),
]

Phone = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        min_length=1,
        max_length=30,
    ),
]


class MasterSchema(BaseModel):
    """Shared validation configuration for master-data requests."""

    model_config = ConfigDict(
        extra="forbid",
        str_strip_whitespace=True,
        validate_assignment=True,
    )


class MasterResponseSchema(MasterSchema):
    """Shared configuration for ORM-backed master-data responses."""

    model_config = ConfigDict(
        from_attributes=True,
        extra="forbid",
        str_strip_whitespace=True,
    )


def _reject_empty_update(
    model: BaseModel,
) -> None:
    """Reject update requests that do not specify any fields."""

    if not model.model_fields_set:
        raise ValueError(
            "At least one field must be provided."
        )


def _reject_null_for_fields(
    model: BaseModel,
    field_names: tuple[str, ...],
) -> None:
    """Reject explicit null values for nonnullable model attributes."""

    for field_name in field_names:
        if (
            field_name in model.model_fields_set
            and getattr(model, field_name) is None
        ):
            raise ValueError(
                f"{field_name} cannot be null."
            )


def _normalize_gstin(
    value: str | None,
) -> str | None:
    """Normalize an optional GST registration number."""

    if value is None:
        return None

    normalized = value.strip().upper()

    return normalized or None


class CustomerCreate(MasterSchema):
    """Request to create a customer master record."""

    customer_name: RequiredName
    customer_type: str | None = Field(
        default=None,
        max_length=50,
    )
    gstin: GSTIN | None = None
    phone: Phone | None = None
    email: EmailStr | None = None
    billing_address: str | None = None
    shipping_address: str | None = None
    state: str | None = Field(
        default=None,
        max_length=100,
    )
    payment_terms_days: int = Field(
        default=0,
        ge=0,
    )
    assigned_salesman_id: UUID
    is_active: bool = True

    @field_validator("gstin", mode="before")
    @classmethod
    def normalize_gstin(cls, value: str | None) -> str | None:
        return _normalize_gstin(value)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str | None) -> str | None:
        return value.lower() if value is not None else None


class CustomerUpdate(MasterSchema):
    """Partial update of editable customer attributes."""

    customer_name: RequiredName | None = None
    customer_type: str | None = Field(
        default=None,
        max_length=50,
    )
    gstin: GSTIN | None = None
    phone: Phone | None = None
    email: EmailStr | None = None
    billing_address: str | None = None
    shipping_address: str | None = None
    state: str | None = Field(
        default=None,
        max_length=100,
    )
    payment_terms_days: int | None = Field(
        default=None,
        ge=0,
    )
    assigned_salesman_id: UUID | None = None
    is_active: bool | None = None

    @field_validator("gstin", mode="before")
    @classmethod
    def normalize_gstin(cls, value: str | None) -> str | None:
        return _normalize_gstin(value)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str | None) -> str | None:
        return value.lower() if value is not None else None

    @model_validator(mode="after")
    def validate_update(self) -> CustomerUpdate:
        _reject_empty_update(self)
        _reject_null_for_fields(
            self,
            (
                "customer_name",
                "payment_terms_days",
                "assigned_salesman_id",
                "is_active",
            ),
        )
        return self


class CustomerResponse(MasterResponseSchema):
    """Customer master record returned by the API."""

    customer_id: UUID
    customer_name: str
    customer_type: str | None
    gstin: str | None
    phone: str | None
    email: str | None
    billing_address: str | None
    shipping_address: str | None
    state: str | None
    payment_terms_days: int
    assigned_salesman_id: UUID
    is_active: bool
    created_at: datetime


class CustomerListResponse(MasterSchema):
    """Paginated customer master records."""

    items: list[CustomerResponse]
    total: int = Field(ge=0)
    page: int = Field(ge=1)
    page_size: int = Field(ge=1)


class SupplierCreate(MasterSchema):
    """Request to create a supplier master record."""

    supplier_name: RequiredName
    gstin: GSTIN | None = None
    phone: Phone | None = None
    email: EmailStr | None = None
    address: str | None = None
    is_active: bool = True

    @field_validator("gstin", mode="before")
    @classmethod
    def normalize_gstin(cls, value: str | None) -> str | None:
        return _normalize_gstin(value)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str | None) -> str | None:
        return value.lower() if value is not None else None


class SupplierUpdate(MasterSchema):
    """Partial update of supplier master attributes."""

    supplier_name: RequiredName | None = None
    gstin: GSTIN | None = None
    phone: Phone | None = None
    email: EmailStr | None = None
    address: str | None = None
    is_active: bool | None = None

    @field_validator("gstin", mode="before")
    @classmethod
    def normalize_gstin(cls, value: str | None) -> str | None:
        return _normalize_gstin(value)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str | None) -> str | None:
        return value.lower() if value is not None else None

    @model_validator(mode="after")
    def validate_update(self) -> SupplierUpdate:
        _reject_empty_update(self)
        _reject_null_for_fields(
            self,
            ("supplier_name", "is_active"),
        )
        return self


class SupplierResponse(MasterResponseSchema):
    """Supplier master record returned by the API."""

    supplier_id: UUID
    supplier_name: str
    gstin: str | None
    phone: str | None
    email: str | None
    address: str | None
    is_active: bool


class SupplierListResponse(MasterSchema):
    """Paginated supplier master records."""

    items: list[SupplierResponse]
    total: int = Field(ge=0)
    page: int = Field(ge=1)
    page_size: int = Field(ge=1)


class InventoryItemCreate(MasterSchema):
    """Common inventory-item attributes for master-data creation."""

    item_name: RequiredName
    item_code: ItemCode
    item_type: Literal[
        "RAW_MATERIAL",
        "PACKAGING_MATERIAL",
        "FINISHED_GOOD",
    ]
    base_unit: UnitName
    reorder_level: Quantity = Decimal("0")
    is_active: bool = True


class InventoryItemUpdate(MasterSchema):
    """Partial update of common inventory-item attributes."""

    item_name: RequiredName | None = None
    item_code: ItemCode | None = None
    base_unit: UnitName | None = None
    reorder_level: Quantity | None = None
    is_active: bool | None = None

    @model_validator(mode="after")
    def validate_update(self) -> InventoryItemUpdate:
        _reject_empty_update(self)
        _reject_null_for_fields(
            self,
            (
                "item_name",
                "item_code",
                "base_unit",
                "reorder_level",
                "is_active",
            ),
        )
        return self


class InventoryItemResponse(MasterResponseSchema):
    """Shared inventory-item master record."""

    item_id: UUID
    item_name: str
    item_code: str
    item_type: str
    base_unit: str
    reorder_level: Decimal
    is_active: bool
    created_at: datetime


class ProductDetailsCreate(MasterSchema):
    """Finished-product attributes stored in the products table."""

    category: str | None = Field(
        default=None,
        max_length=100,
    )
    selling_price: UnitPrice
    gst_rate: TaxRate
    hsn_code: str | None = Field(
        default=None,
        max_length=20,
    )
    pack_size: PositiveQuantity
    pack_unit: UnitName
    shelf_life_days: int | None = Field(
        default=None,
        gt=0,
    )


class ProductDetailsUpdate(MasterSchema):
    """Partial update of finished-product attributes."""

    category: str | None = Field(
        default=None,
        max_length=100,
    )
    selling_price: UnitPrice | None = None
    gst_rate: TaxRate | None = None
    hsn_code: str | None = Field(
        default=None,
        max_length=20,
    )
    pack_size: PositiveQuantity | None = None
    pack_unit: UnitName | None = None
    shelf_life_days: int | None = Field(
        default=None,
        gt=0,
    )

    @model_validator(mode="after")
    def validate_update(self) -> ProductDetailsUpdate:
        _reject_empty_update(self)
        _reject_null_for_fields(
            self,
            (
                "selling_price",
                "gst_rate",
                "pack_size",
                "pack_unit",
            ),
        )
        return self


class ProductCreate(MasterSchema):
    """Create a finished good and its product-specific details."""

    inventory_item: InventoryItemCreate
    product: ProductDetailsCreate

    @model_validator(mode="after")
    def validate_item_type(self) -> ProductCreate:
        if self.inventory_item.item_type != "FINISHED_GOOD":
            raise ValueError(
                "Product inventory item type must be FINISHED_GOOD."
            )
        return self


class ProductUpdate(MasterSchema):
    """Update common inventory and/or product-specific attributes."""

    inventory_item: InventoryItemUpdate | None = None
    product: ProductDetailsUpdate | None = None

    @model_validator(mode="after")
    def validate_update(self) -> ProductUpdate:
        if (
            self.inventory_item is None
            and self.product is None
        ):
            raise ValueError(
                "At least one product update section is required."
            )
        return self


class ProductResponse(MasterResponseSchema):
    """Finished-product record with its inventory-item master."""

    product_id: UUID
    category: str | None
    selling_price: Decimal
    gst_rate: Decimal
    hsn_code: str | None
    pack_size: Decimal
    pack_unit: str
    shelf_life_days: int | None
    inventory_item: InventoryItemResponse


class ProductListResponse(MasterSchema):
    """Paginated finished-product master records."""

    items: list[ProductResponse]
    total: int = Field(ge=0)
    page: int = Field(ge=1)
    page_size: int = Field(ge=1)


class RawMaterialDetailsCreate(MasterSchema):
    """Raw-material attributes stored in the raw_materials table."""

    material_category: str | None = Field(
        default=None,
        max_length=100,
    )
    storage_type: str | None = Field(
        default=None,
        max_length=100,
    )


class RawMaterialDetailsUpdate(MasterSchema):
    """Partial update of raw-material-specific attributes."""

    material_category: str | None = Field(
        default=None,
        max_length=100,
    )
    storage_type: str | None = Field(
        default=None,
        max_length=100,
    )

    @model_validator(mode="after")
    def validate_update(self) -> RawMaterialDetailsUpdate:
        _reject_empty_update(self)
        return self


class RawMaterialCreate(MasterSchema):
    """Create an inventory item and its raw-material details."""

    inventory_item: InventoryItemCreate
    raw_material: RawMaterialDetailsCreate

    @model_validator(mode="after")
    def validate_item_type(self) -> RawMaterialCreate:
        if self.inventory_item.item_type != "RAW_MATERIAL":
            raise ValueError(
                "Raw-material inventory item type must be RAW_MATERIAL."
            )
        return self


class RawMaterialUpdate(MasterSchema):
    """Update common inventory and/or raw-material-specific attributes."""

    inventory_item: InventoryItemUpdate | None = None
    raw_material: RawMaterialDetailsUpdate | None = None

    @model_validator(mode="after")
    def validate_update(self) -> RawMaterialUpdate:
        if (
            self.inventory_item is None
            and self.raw_material is None
        ):
            raise ValueError(
                "At least one raw-material update section is required."
            )
        return self


class RawMaterialResponse(MasterResponseSchema):
    """Raw-material details with their inventory-item master."""

    material_id: UUID
    material_category: str | None
    storage_type: str | None
    inventory_item: InventoryItemResponse


class RawMaterialListResponse(MasterSchema):
    """Paginated raw-material master records."""

    items: list[RawMaterialResponse]
    total: int = Field(ge=0)
    page: int = Field(ge=1)
    page_size: int = Field(ge=1)


class PackagingMaterialDetailsCreate(MasterSchema):
    """Packaging-specific attributes."""

    packaging_type: str | None = Field(
        default=None,
        max_length=100,
    )
    dimensions: str | None = Field(
        default=None,
        max_length=150,
    )
    capacity_packets: PositiveQuantity | None = None


class PackagingMaterialDetailsUpdate(MasterSchema):
    """Partial update of packaging-specific attributes."""

    packaging_type: str | None = Field(
        default=None,
        max_length=100,
    )
    dimensions: str | None = Field(
        default=None,
        max_length=150,
    )
    capacity_packets: PositiveQuantity | None = None

    @model_validator(mode="after")
    def validate_update(self) -> PackagingMaterialDetailsUpdate:
        _reject_empty_update(self)
        return self


class PackagingMaterialCreate(MasterSchema):
    """Create a packaging inventory item and its details."""

    inventory_item: InventoryItemCreate
    packaging_material: PackagingMaterialDetailsCreate

    @model_validator(mode="after")
    def validate_item_type(self) -> PackagingMaterialCreate:
        if self.inventory_item.item_type != "PACKAGING_MATERIAL":
            raise ValueError(
                "Packaging inventory item type must be PACKAGING_MATERIAL."
            )
        return self


class PackagingMaterialUpdate(MasterSchema):
    """Update common inventory and/or packaging-specific attributes."""

    inventory_item: InventoryItemUpdate | None = None
    packaging_material: PackagingMaterialDetailsUpdate | None = None

    @model_validator(mode="after")
    def validate_update(self) -> PackagingMaterialUpdate:
        if (
            self.inventory_item is None
            and self.packaging_material is None
        ):
            raise ValueError(
                "At least one packaging-material update section is required."
            )
        return self


class PackagingMaterialResponse(MasterResponseSchema):
    """Packaging-material details with their inventory-item master."""

    packaging_id: UUID
    packaging_type: str | None
    dimensions: str | None
    capacity_packets: Decimal | None
    inventory_item: InventoryItemResponse


class PackagingMaterialListResponse(MasterSchema):
    """Paginated packaging-material master records."""

    items: list[PackagingMaterialResponse]
    total: int = Field(ge=0)
    page: int = Field(ge=1)
    page_size: int = Field(ge=1)


class UnitConversionCreate(MasterSchema):
    """Create an approved directional unit conversion."""

    from_unit: UnitName
    to_unit: UnitName
    conversion_factor: PositiveQuantity

    @model_validator(mode="after")
    def validate_units(self) -> UnitConversionCreate:
        if self.from_unit == self.to_unit:
            raise ValueError(
                "Source and destination units must differ."
            )
        return self


class UnitConversionUpdate(MasterSchema):
    """Update the factor of an existing directional conversion."""

    conversion_factor: PositiveQuantity


class UnitConversionResponse(MasterResponseSchema):
    """Approved directional unit conversion."""

    conversion_id: UUID
    from_unit: str
    to_unit: str
    conversion_factor: Decimal


class UnitConversionListResponse(MasterSchema):
    """List of approved unit conversions."""

    items: list[UnitConversionResponse]


class BOMItemCreate(MasterSchema):
    """Material or packaging requirement within a BOM."""

    item_id: UUID
    quantity_required: PositiveQuantity
    unit: UnitName


class BOMItemUpdate(MasterSchema):
    """Editable material or packaging requirement within a BOM."""

    quantity_required: PositiveQuantity | None = None
    unit: UnitName | None = None

    @model_validator(mode="after")
    def validate_update(self) -> BOMItemUpdate:
        _reject_empty_update(self)
        _reject_null_for_fields(
            self,
            ("quantity_required", "unit"),
        )
        return self


class BOMItemResponse(MasterResponseSchema):
    """Persisted BOM material or packaging requirement."""

    bom_item_id: UUID
    bom_id: UUID
    item_id: UUID
    quantity_required: Decimal
    unit: str


class ProductBOMCreate(MasterSchema):
    """Create a versioned product bill of materials."""

    product_id: UUID
    version: int = Field(ge=1)
    standard_batch_size: PositiveQuantity
    expected_output: PositiveQuantity
    effective_from: date
    effective_to: date | None = None
    is_active: bool = True
    items: list[BOMItemCreate] = Field(
        ...,
        min_length=1,
    )

    @model_validator(mode="after")
    def validate_bom(self) -> ProductBOMCreate:
        if (
            self.effective_to is not None
            and self.effective_to < self.effective_from
        ):
            raise ValueError(
                "BOM effective-to date cannot precede "
                "the effective-from date."
            )

        item_ids = [item.item_id for item in self.items]

        if len(item_ids) != len(set(item_ids)):
            raise ValueError(
                "A BOM cannot contain duplicate inventory items."
            )

        return self


class ProductBOMUpdate(MasterSchema):
    """
    Update the active status or effective end date of a BOM.

    Existing version contents are not edited through this schema;
    changes to the recipe require a new BOM version.
    """

    effective_to: date | None = None
    is_active: bool | None = None

    @model_validator(mode="after")
    def validate_update(self) -> ProductBOMUpdate:
        _reject_empty_update(self)
        _reject_null_for_fields(
            self,
            ("is_active",),
        )
        return self


class ProductBOMResponse(MasterResponseSchema):
    """Versioned product BOM with its component requirements."""

    bom_id: UUID
    product_id: UUID
    version: int
    standard_batch_size: Decimal
    expected_output: Decimal
    effective_from: date
    effective_to: date | None
    is_active: bool
    created_at: datetime
    items: list[BOMItemResponse]


class ProductBOMListResponse(MasterSchema):
    """Paginated product BOM records."""

    items: list[ProductBOMResponse]
    total: int = Field(ge=0)
    page: int = Field(ge=1)
    page_size: int = Field(ge=1)
