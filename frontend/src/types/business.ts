
/**
 * Shared business-domain types.
 *
 * Monetary amounts, quantities, unit costs, and tax rates are represented
 * as decimal strings to preserve precision across API boundaries.
 * All authoritative calculations and transaction posting occur on the backend.
 */

export type UUID = string;
export type ISODate = string;
export type ISODateTime = string;
export type DecimalString = string;
export type Money = DecimalString;
export type Quantity = DecimalString;
export type Percentage = DecimalString;

export type RecordStatus = "active" | "inactive";

export type UnitOfMeasure =
  | "kg"
  | "g"
  | "l"
  | "ml"
  | "pcs"
  | "packets"
  | "cartons";

export type InventoryItemType =
  | "raw_material"
  | "packaging_material"
  | "finished_product";

export type InventoryMovementType =
  | "opening_balance"
  | "purchase_receipt"
  | "production_material_issue"
  | "production_material_consumption"
  | "unused_material_return"
  | "production_wastage"
  | "production_output"
  | "dispatch"
  | "stock_adjustment"
  | "reversal";

export type MovementDirection = "in" | "out";

export type OrderApprovalStatus =
  | "draft"
  | "submitted"
  | "approved"
  | "rejected"
  | "cancelled";

export type OrderFulfillmentStatus =
  | "not_dispatched"
  | "partially_dispatched"
  | "dispatched";

export type ProductionStatus =
  | "draft"
  | "in_progress"
  | "completed"
  | "cancelled";

export type TransactionStatus =
  | "draft"
  | "posted"
  | "cancelled";

export type PaymentStatus =
  | "pending"
  | "partially_paid"
  | "paid";

export type PaymentMethod =
  | "cash"
  | "bank_transfer"
  | "upi"
  | "cheque"
  | "other";

export type GSTSupplyType = "intrastate" | "interstate";

export type GovernmentDocumentType = "e_invoice" | "e_waybill";

export type GovernmentDocumentStatus =
  | "not_generated"
  | "generated"
  | "failed"
  | "cancelled";

export type SortDirection = "asc" | "desc";

export interface PaginationParams {
  page?: number;
  page_size?: number;
  search?: string;
  sort_by?: string;
  sort_direction?: SortDirection;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

export interface DateRangeParams {
  date_from?: ISODate;
  date_to?: ISODate;
}

export interface AuditFields {
  created_at: ISODateTime;
  updated_at: ISODateTime | null;
  created_by?: UUID | null;
  updated_by?: UUID | null;
}

export interface Address {
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  state_code?: string | null;
  postal_code: string;
  country: string;
}

export interface Customer extends AuditFields {
  id: UUID;
  customer_code: string;
  name: string;
  phone: string | null;
  email: string | null;
  gstin: string | null;
  billing_address: Address;
  shipping_address: Address;
  assigned_salesman_id: UUID;
  is_active: boolean;
}

export interface CustomerInput {
  customer_code: string;
  name: string;
  phone?: string | null;
  email?: string | null;
  gstin?: string | null;
  billing_address: Address;
  shipping_address: Address;
  assigned_salesman_id: UUID;
  is_active?: boolean;
}

export interface Supplier extends AuditFields {
  id: UUID;
  supplier_code: string;
  name: string;
  phone: string | null;
  email: string | null;
  gstin: string | null;
  address: Address;
  is_active: boolean;
}

export interface SupplierInput {
  supplier_code: string;
  name: string;
  phone?: string | null;
  email?: string | null;
  gstin?: string | null;
  address: Address;
  is_active?: boolean;
}

export interface InventoryItem extends AuditFields {
  id: UUID;
  item_code: string;
  name: string;
  item_type: InventoryItemType;
  base_unit: UnitOfMeasure;
  description: string | null;
  is_active: boolean;
}

export interface InventoryItemInput {
  item_code: string;
  name: string;
  item_type: InventoryItemType;
  base_unit: UnitOfMeasure;
  description?: string | null;
  is_active?: boolean;
}

export interface Product extends InventoryItem {
  item_type: "finished_product";
  sku: string;
  hsn_code: string;
  package_size: Quantity;
  package_unit: UnitOfMeasure;
  gst_rate: Percentage;
}

export interface ProductInput extends InventoryItemInput {
  item_type: "finished_product";
  sku: string;
  hsn_code: string;
  package_size: Quantity;
  package_unit: UnitOfMeasure;
  gst_rate: Percentage;
}

export interface UnitConversion {
  id: UUID;
  from_unit: UnitOfMeasure;
  to_unit: UnitOfMeasure;
  conversion_factor: DecimalString;
}

export interface PriceList extends AuditFields {
  id: UUID;
  name: string;
  effective_from: ISODate;
  effective_to: ISODate | null;
  is_active: boolean;
  items: PriceListItem[];
}

export interface PriceListItem {
  id: UUID;
  price_list_id: UUID;
  product_id: UUID;
  selling_price: Money;
}

export interface PriceListInput {
  name: string;
  effective_from: ISODate;
  effective_to?: ISODate | null;
  is_active?: boolean;
  items: Array<{
    product_id: UUID;
    selling_price: Money;
  }>;
}

export interface BOMItem {
  id: UUID;
  bom_id: UUID;
  inventory_item_id: UUID;
  quantity: Quantity;
  unit: UnitOfMeasure;
}

export interface ProductBOM extends AuditFields {
  id: UUID;
  product_id: UUID;
  version: number;
  expected_output_quantity: Quantity;
  output_unit: UnitOfMeasure;
  is_active: boolean;
  items: BOMItem[];
}

export interface ProductBOMInput {
  product_id: UUID;
  version: number;
  expected_output_quantity: Quantity;
  output_unit: UnitOfMeasure;
  items: Array<{
    inventory_item_id: UUID;
    quantity: Quantity;
    unit: UnitOfMeasure;
  }>;
}

export interface PurchaseOrderItem {
  id: UUID;
  purchase_order_id: UUID;
  inventory_item_id: UUID;
  ordered_quantity: Quantity;
  unit: UnitOfMeasure;
  unit_price: Money;
  line_total: Money;
}

export interface PurchaseOrder extends AuditFields {
  id: UUID;
  purchase_order_number: string;
  supplier_id: UUID;
  order_date: ISODate;
  status: TransactionStatus;
  notes: string | null;
  total_amount: Money;
  items: PurchaseOrderItem[];
}

export interface PurchaseOrderInput {
  supplier_id: UUID;
  order_date: ISODate;
  notes?: string | null;
  items: Array<{
    inventory_item_id: UUID;
    ordered_quantity: Quantity;
    unit: UnitOfMeasure;
    unit_price: Money;
  }>;
}

export interface GoodsReceiptItem {
  id: UUID;
  goods_receipt_id: UUID;
  purchase_order_item_id: UUID;
  inventory_item_id: UUID;
  received_quantity: Quantity;
  accepted_quantity: Quantity;
  rejected_quantity: Quantity;
  unit: UnitOfMeasure;
  batch_number: string;
  manufacturing_date: ISODate | null;
  expiry_date: ISODate | null;
}

export interface GoodsReceipt extends AuditFields {
  id: UUID;
  goods_receipt_number: string;
  purchase_order_id: UUID;
  receipt_date: ISODate;
  status: TransactionStatus;
  notes: string | null;
  items: GoodsReceiptItem[];
}

export interface GoodsReceiptInput {
  purchase_order_id: UUID;
  receipt_date: ISODate;
  notes?: string | null;
  items: Array<{
    purchase_order_item_id: UUID;
    received_quantity: Quantity;
    accepted_quantity: Quantity;
    rejected_quantity: Quantity;
    unit: UnitOfMeasure;
    batch_number: string;
    manufacturing_date?: ISODate | null;
    expiry_date?: ISODate | null;
  }>;
}

export interface StockBatch extends AuditFields {
  id: UUID;
  inventory_item_id: UUID;
  batch_number: string;
  location_id: UUID;
  manufacturing_date: ISODate | null;
  expiry_date: ISODate | null;
  received_quantity: Quantity;
  available_quantity: Quantity;
  unit_cost: Money;
  source_type: string;
  source_id: UUID;
}

export interface InventoryBalance {
  inventory_item_id: UUID;
  location_id: UUID;
  available_quantity: Quantity;
  production_held_quantity: Quantity;
  base_unit: UnitOfMeasure;
  weighted_average_unit_cost: Money;
  updated_at: ISODateTime;
}

export interface StockMovement {
  id: UUID;
  inventory_item_id: UUID;
  batch_id: UUID | null;
  location_id: UUID;
  movement_type: InventoryMovementType;
  direction: MovementDirection;
  quantity: Quantity;
  unit: UnitOfMeasure;
  unit_cost: Money;
  source_type: string;
  source_id: UUID;
  movement_date: ISODateTime;
  notes: string | null;
  created_by: UUID;
}

export interface StockAdjustmentItem {
  inventory_item_id: UUID;
  batch_id?: UUID | null;
  location_id: UUID;
  direction: MovementDirection;
  quantity: Quantity;
  reason: string;
}

export interface StockAdjustment extends AuditFields {
  id: UUID;
  adjustment_number: string;
  status: TransactionStatus;
  reason: string;
  approved_by: UUID | null;
  posted_at: ISODateTime | null;
  items: StockAdjustmentItem[];
}

export interface StockAdjustmentInput {
  reason: string;
  items: StockAdjustmentItem[];
}

export interface ProductionMaterial {
  id: UUID;
  production_run_id: UUID;
  inventory_item_id: UUID;
  planned_quantity: Quantity;
  issued_quantity: Quantity;
  consumed_quantity: Quantity;
  wasted_quantity: Quantity;
  returned_quantity: Quantity;
  remaining_held_quantity: Quantity;
  unit: UnitOfMeasure;
  unit_cost: Money;
}

export interface ProductionOutput {
  id: UUID;
  production_run_id: UUID;
  batch_id: UUID | null;
  good_quantity: Quantity;
  rejected_quantity: Quantity;
  unit: UnitOfMeasure;
  manufacturing_date: ISODate;
  expiry_date: ISODate | null;
}

export interface ProductionExpense {
  id: UUID;
  production_run_id: UUID;
  expense_type: string;
  description: string | null;
  amount: Money;
  expense_date: ISODate;
  created_at: ISODateTime;
}

export interface ProductionCostSummary {
  production_run_id: UUID;
  raw_material_cost: Money;
  packaging_cost: Money;
  production_expense_cost: Money;
  total_production_cost: Money;
  good_output_quantity: Quantity;
  cost_per_good_unit: Money | null;
  updated_at: ISODateTime;
}

export interface ProductionRun extends AuditFields {
  id: UUID;
  production_number: string;
  product_id: UUID;
  bom_id: UUID;
  planned_quantity: Quantity;
  expected_output_quantity: Quantity;
  status: ProductionStatus;
  production_date: ISODate;
  completed_at: ISODateTime | null;
  notes: string | null;
  materials: ProductionMaterial[];
  outputs: ProductionOutput[];
  expenses: ProductionExpense[];
  cost_summary: ProductionCostSummary | null;
}

export interface ProductionRunInput {
  product_id: UUID;
  bom_id: UUID;
  planned_quantity: Quantity;
  production_date: ISODate;
  notes?: string | null;
}

export interface ProductionMaterialIssueInput {
  inventory_item_id: UUID;
  batch_id: UUID;
  quantity: Quantity;
  unit: UnitOfMeasure;
}

export interface ProductionMaterialReconciliationInput {
  production_material_id: UUID;
  consumed_quantity: Quantity;
  wasted_quantity: Quantity;
  returned_quantity: Quantity;
}

export interface ProductionOutputInput {
  good_quantity: Quantity;
  rejected_quantity: Quantity;
  unit: UnitOfMeasure;
  batch_number: string;
  manufacturing_date: ISODate;
  expiry_date?: ISODate | null;
}

export interface ProductionExpenseInput {
  expense_type: string;
  description?: string | null;
  amount: Money;
  expense_date: ISODate;
}

export interface SalesOrderItem {
  id: UUID;
  sales_order_id: UUID;
  product_id: UUID;
  quantity: Quantity;
  unit: UnitOfMeasure;
  unit_price: Money;
  gst_rate: Percentage;
  line_total: Money;
}

export interface SalesOrder extends AuditFields {
  id: UUID;
  order_number: string;
  customer_id: UUID;
  salesman_id: UUID;
  order_date: ISODateTime;
  approval_status: OrderApprovalStatus;
  fulfillment_status: OrderFulfillmentStatus;
  notes: string | null;
  rejection_reason: string | null;
  approved_by: UUID | null;
  approved_at: ISODateTime | null;
  total_amount: Money;
  items: SalesOrderItem[];
}

export interface SalesOrderInput {
  customer_id: UUID;
  order_date?: ISODateTime;
  notes?: string | null;
  items: Array<{
    product_id: UUID;
    quantity: Quantity;
    unit: UnitOfMeasure;
    unit_price: Money;
  }>;
}

export interface SalesOrderReviewInput {
  decision: "approved" | "rejected";
  reason?: string | null;
}

export interface GSTBreakdown {
  taxable_amount: Money;
  cgst_amount: Money;
  sgst_amount: Money;
  igst_amount: Money;
  total_tax: Money;
  total_amount: Money;
}

export interface InvoiceItem {
  id: UUID;
  invoice_id: UUID;
  sales_order_item_id: UUID;
  product_id: UUID;
  quantity: Quantity;
  unit: UnitOfMeasure;
  unit_price: Money;
  taxable_amount: Money;
  gst_rate: Percentage;
  cgst_amount: Money;
  sgst_amount: Money;
  igst_amount: Money;
  line_total: Money;
}

export interface GSTInvoice extends AuditFields {
  id: UUID;
  invoice_number: string;
  financial_year: string;
  sales_order_id: UUID;
  customer_id: UUID;
  invoice_date: ISODate;
  status: TransactionStatus;
  supply_type: GSTSupplyType;
  billing_address: Address;
  shipping_address: Address;
  tax_summary: GSTBreakdown;
  amount_paid: Money;
  outstanding_amount: Money;
  payment_status: PaymentStatus;
  items: InvoiceItem[];
}

export interface InvoiceInput {
  sales_order_id: UUID;
  invoice_date: ISODate;
}

export interface DispatchItem {
  id: UUID;
  dispatch_id: UUID;
  sales_order_item_id: UUID;
  product_id: UUID;
  batch_id: UUID;
  quantity: Quantity;
  unit: UnitOfMeasure;
}

export interface Dispatch extends AuditFields {
  id: UUID;
  dispatch_number: string;
  sales_order_id: UUID;
  invoice_id: UUID;
  dispatch_date: ISODate;
  status: TransactionStatus;
  notes: string | null;
  items: DispatchItem[];
}

export interface DispatchInput {
  sales_order_id: UUID;
  invoice_id: UUID;
  dispatch_date: ISODate;
  notes?: string | null;
  items: Array<{
    sales_order_item_id: UUID;
    quantity: Quantity;
    unit: UnitOfMeasure;
  }>;
}

export interface PaymentAllocation {
  id: UUID;
  payment_id: UUID;
  invoice_id: UUID;
  allocated_amount: Money;
}

export interface Payment extends AuditFields {
  id: UUID;
  payment_number: string;
  customer_id: UUID;
  payment_date: ISODate;
  amount: Money;
  payment_method: PaymentMethod;
  reference_number: string | null;
  notes: string | null;
  status: TransactionStatus;
  allocations: PaymentAllocation[];
}

export interface PaymentInput {
  customer_id: UUID;
  payment_date: ISODate;
  amount: Money;
  payment_method: PaymentMethod;
  reference_number?: string | null;
  notes?: string | null;
  allocations: Array<{
    invoice_id: UUID;
    allocated_amount: Money;
  }>;
}

export interface CustomerOutstanding {
  customer_id: UUID;
  customer_name: string;
  total_invoiced: Money;
  total_paid: Money;
  outstanding_amount: Money;
}

export interface InvoiceOutstanding {
  invoice_id: UUID;
  invoice_number: string;
  customer_id: UUID;
  invoice_date: ISODate;
  invoice_total: Money;
  amount_paid: Money;
  outstanding_amount: Money;
  payment_status: PaymentStatus;
}

export interface GovernmentDocument {
  id: UUID;
  invoice_id: UUID;
  document_type: GovernmentDocumentType;
  status: GovernmentDocumentStatus;
  reference_number: string | null;
  generated_at: ISODateTime | null;
  error_message: string | null;
  is_mock: boolean;
}

export interface ReportFilter extends DateRangeParams {
  customer_id?: UUID;
  supplier_id?: UUID;
  product_id?: UUID;
  inventory_item_id?: UUID;
  salesman_id?: UUID;
  production_run_id?: UUID;
  status?: string;
}

export interface ReportColumn {
  key: string;
  label: string;
  data_type: "text" | "number" | "currency" | "date" | "datetime";
}

export type ReportCellValue = string | number | boolean | null;

export interface ReportResult {
  report_type: string;
  title: string;
  generated_at: ISODateTime;
  columns: ReportColumn[];
  rows: Array<Record<string, ReportCellValue>>;
  totals?: Record<string, ReportCellValue>;
}

export interface DashboardMetric {
  key: string;
  label: string;
  value: string;
  unit?: string | null;
}

export interface DashboardChartPoint {
  label: string;
  value: number;
}

export interface DashboardData {
  metrics: DashboardMetric[];
  charts: Array<{
    id: string;
    title: string;
    data: DashboardChartPoint[];
  }>;
  generated_at: ISODateTime;
}

export interface AuditLog {
  id: UUID;
  user_id: UUID;
  entity_type: string;
  entity_id: UUID;
  action: string;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  created_at: ISODateTime;
}
