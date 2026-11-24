"""
Central SQLAlchemy model registry.

Import this module before accessing Base.metadata for Alembic
autogeneration so that all application tables and relationships
are registered.

Importing this module does not connect to the database,
create tables, run migrations, or insert records.
"""

from app.models.base import Base

# Authentication and master data
from app.models.user import Role, User, UserRole
from app.models.customer import Customer
from app.models.supplier import Supplier
from app.models.product import (
    InventoryItem,
    PackagingMaterial,
    Product,
    RawMaterial,
    UnitConversion,
)

# Bill of materials
from app.models.bom import BOMItem, ProductBOM

# Purchasing and goods receipt
from app.models.purchasing import (
    GoodsReceipt,
    GoodsReceiptItem,
    PurchaseOrder,
    PurchaseOrderItem,
)

# Inventory and stock ledger
from app.models.inventory import (
    InventoryBalance,
    StockAdjustment,
    StockAdjustmentItem,
    StockBatch,
    StockMovement,
)

# Production and costing
from app.models.production import (
    ProductionCostSummary,
    ProductionExpense,
    ProductionMaterial,
    ProductionOutput,
    ProductionRun,
)

# Sales and approval history
from app.models.sales import (
    OrderApprovalHistory,
    SalesOrder,
    SalesOrderItem,
)

# GST invoicing
from app.models.invoicing import Invoice, InvoiceItem

# Dispatch and fulfillment
from app.models.dispatch import Dispatch, DispatchItem

# Customer payments
from app.models.payment import Payment, PaymentAllocation

# Audit history and offline synchronization
from app.models.audit import AuditLog, SyncRecord


__all__ = [
    "Base",
    "User",
    "Role",
    "UserRole",
    "Customer",
    "Supplier",
    "InventoryItem",
    "Product",
    "RawMaterial",
    "PackagingMaterial",
    "UnitConversion",
    "ProductBOM",
    "BOMItem",
    "PurchaseOrder",
    "PurchaseOrderItem",
    "GoodsReceipt",
    "GoodsReceiptItem",
    "StockBatch",
    "StockMovement",
    "InventoryBalance",
    "StockAdjustment",
    "StockAdjustmentItem",
    "ProductionRun",
    "ProductionMaterial",
    "ProductionOutput",
    "ProductionExpense",
    "ProductionCostSummary",
    "SalesOrder",
    "SalesOrderItem",
    "OrderApprovalHistory",
    "Invoice",
    "InvoiceItem",
    "Dispatch",
    "DispatchItem",
    "Payment",
    "PaymentAllocation",
    "AuditLog",
    "SyncRecord",
]