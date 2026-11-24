import type {
  DecimalString,
  InventoryItemType,
  ISODate,
  ISODateTime,
  Money,
  PaginatedResponse,
  PaginationParams,
  Quantity,
  TransactionStatus,
  UnitOfMeasure,
  UUID,
} from "../../types/business";

import {
  ApiError,
  apiClient,
  type ApiRequestOptions,
} from "./client";

/**
 * Purchasing, goods receipt, inventory, and dispatch API services.
 *
 * Stock balances, batch allocation, valuation, and stock movements
 * are authoritative on the backend. Posting operations are distinct
 * from draft creation and are never automatically retried.
 */

export const INVENTORY_API_PATHS = {
  PURCHASE_ORDERS: "/purchase-orders",
  GOODS_RECEIPTS: "/goods-receipts",
  STOCK_SUMMARY: "/inventory/stock-summary",
  STOCK_BATCHES: "/inventory/batches",
  STOCK_LEDGER: "/inventory/ledger",
  STOCK_ADJUSTMENTS: "/inventory/adjustments",
  DISPATCHES: "/dispatches",
} as const;

export interface InventoryApiRequestOptions
  extends Pick<
    ApiRequestOptions,
    "signal" | "timeoutMs"
  > {
  idempotencyKey?: string;
}

export interface PurchaseOrderItem {
  id: UUID;
  purchase_order_id: UUID;
  item_id: UUID;
  quantity: Quantity;
  unit: UnitOfMeasure;
  unit_price: Money;
  line_total: Money;
}

export interface PurchaseOrder {
  id: UUID;
  purchase_order_number: string;
  supplier_id: UUID;
  order_date: ISODate;
  expected_delivery_date: ISODate | null;
  status: TransactionStatus;
  notes: string | null;
  total_amount: Money;
  items: PurchaseOrderItem[];
  created_at: ISODateTime;
  updated_at: ISODateTime | null;
  created_by?: UUID | null;
}

export interface PurchaseOrderItemInput {
  item_id: UUID;
  quantity: Quantity;
  unit: UnitOfMeasure;
  unit_price: Money;
}

export interface PurchaseOrderInput {
  supplier_id: UUID;
  order_date?: ISODate;
  expected_delivery_date?: ISODate | null;
  notes?: string | null;
  items: PurchaseOrderItemInput[];
}

export interface GoodsReceiptItem {
  id: UUID;
  goods_receipt_id: UUID;
  purchase_order_item_id: UUID;
  item_id: UUID;
  received_quantity: Quantity;
  unit: UnitOfMeasure;
  unit_cost: Money;
  batch_number: string;
  manufacturing_date: ISODate | null;
  expiry_date: ISODate | null;
}

export interface GoodsReceipt {
  id: UUID;
  goods_receipt_number: string;
  purchase_order_id: UUID;
  supplier_id: UUID;
  receipt_date: ISODate;
  status: TransactionStatus;
  notes: string | null;
  items: GoodsReceiptItem[];
  created_at: ISODateTime;
  updated_at: ISODateTime | null;
  posted_at?: ISODateTime | null;
  posted_by?: UUID | null;
}

export interface GoodsReceiptItemInput {
  purchase_order_item_id: UUID;
  item_id: UUID;
  received_quantity: Quantity;
  unit: UnitOfMeasure;
  unit_cost: Money;
  batch_number: string;
  manufacturing_date?: ISODate | null;
  expiry_date?: ISODate | null;
}

export interface GoodsReceiptInput {
  purchase_order_id: UUID;
  receipt_date?: ISODate;
  notes?: string | null;
  items: GoodsReceiptItemInput[];
}

export interface StockSummary {
  item_id: UUID;
  item_code: string;
  item_name: string;
  item_type: InventoryItemType;
  base_unit: UnitOfMeasure;
  quantity_on_hand: Quantity;
  quantity_reserved: Quantity;
  quantity_available: Quantity;
  stock_value: Money;
}

export interface StockBatch {
  id: UUID;
  item_id: UUID;
  batch_number: string;
  source_type: string;
  source_id: UUID | null;
  manufacturing_date: ISODate | null;
  expiry_date: ISODate | null;
  received_quantity: Quantity;
  available_quantity: Quantity;
  unit: UnitOfMeasure;
  unit_cost: Money;
  created_at: ISODateTime;
  updated_at: ISODateTime | null;
}

export interface StockLedgerEntry {
  id: UUID;
  item_id: UUID;
  batch_id: UUID | null;
  movement_date: ISODateTime;
  movement_type: string;
  reference_type: string;
  reference_id: UUID;
  quantity_in: Quantity;
  quantity_out: Quantity;
  balance_quantity: Quantity;
  unit: UnitOfMeasure;
  unit_cost: Money | null;
  value_change: Money | null;
  notes: string | null;
  created_by: UUID | null;
  created_at: ISODateTime;
}

export interface StockAdjustment {
  id: UUID;
  item_id: UUID;
  batch_id: UUID;
  adjustment_quantity: Quantity;
  unit: UnitOfMeasure;
  reason: string;
  status: TransactionStatus;
  approved_by: UUID | null;
  approved_at: ISODateTime | null;
  created_at: ISODateTime;
  updated_at: ISODateTime | null;
}

export interface StockAdjustmentInput {
  item_id: UUID;
  batch_id: UUID;
  adjustment_quantity: Quantity;
  unit: UnitOfMeasure;
  reason: string;
}

export interface DispatchBatchAllocation {
  batch_id: UUID;
  quantity: Quantity;
  unit: UnitOfMeasure;
}

export interface DispatchItemInput {
  sales_order_item_id: UUID;
  product_id: UUID;
  quantity: Quantity;
  unit: UnitOfMeasure;
  batch_allocations: DispatchBatchAllocation[];
}

export interface DispatchInput {
  sales_order_id: UUID;
  dispatch_date?: ISODate;
  notes?: string | null;
  items: DispatchItemInput[];
}

export interface DispatchItem {
  id: UUID;
  dispatch_id: UUID;
  sales_order_item_id: UUID;
  product_id: UUID;
  quantity: Quantity;
  unit: UnitOfMeasure;
  batch_allocations: DispatchBatchAllocation[];
}

export interface Dispatch {
  id: UUID;
  dispatch_number: string;
  sales_order_id: UUID;
  dispatch_date: ISODate;
  status: TransactionStatus;
  notes: string | null;
  items: DispatchItem[];
  created_at: ISODateTime;
  updated_at: ISODateTime | null;
  posted_at?: ISODateTime | null;
}

export interface PurchaseOrderListParams
  extends PaginationParams {
  supplier_id?: UUID;
  status?: TransactionStatus;
  date_from?: ISODate;
  date_to?: ISODate;
}

export interface GoodsReceiptListParams
  extends PaginationParams {
  supplier_id?: UUID;
  purchase_order_id?: UUID;
  status?: TransactionStatus;
  date_from?: ISODate;
  date_to?: ISODate;
}

export interface StockSummaryParams
  extends PaginationParams {
  item_id?: UUID;
  item_type?: InventoryItemType;
}

export interface StockBatchListParams
  extends PaginationParams {
  item_id?: UUID;
  batch_number?: string;
  expiry_from?: ISODate;
  expiry_to?: ISODate;
}

export interface StockLedgerParams
  extends PaginationParams {
  item_id?: UUID;
  batch_id?: UUID;
  movement_type?: string;
  date_from?: ISODate;
  date_to?: ISODate;
}

export interface StockAdjustmentListParams
  extends PaginationParams {
  item_id?: UUID;
  batch_id?: UUID;
  status?: TransactionStatus;
  date_from?: ISODate;
  date_to?: ISODate;
}

export interface DispatchListParams
  extends PaginationParams {
  sales_order_id?: UUID;
  status?: TransactionStatus;
  date_from?: ISODate;
  date_to?: ISODate;
}

export type UpdatePurchaseOrderInput = Partial<PurchaseOrderInput>;

export type UpdateGoodsReceiptInput = Partial<GoodsReceiptInput>;

export type UpdateDispatchInput = Partial<DispatchInput>;

const DECIMAL_PATTERN = /^-?\d+(?:\.\d+)?$/;

function requireText(
  value: string,
  label: string,
): string {
  if (
    typeof value !== "string" ||
    !value.trim()
  ) {
    throw new ApiError(
      `${label} is required.`,
      {
        category: "validation",
        code: "REQUIRED_FIELD",
      },
    );
  }

  return value.trim();
}

function requirePositiveDecimal(
  value: DecimalString,
  label: string,
): void {
  if (
    typeof value !== "string" ||
    !/^\d+(?:\.\d+)?$/.test(value) ||
    !/[1-9]/.test(value)
  ) {
    throw new ApiError(
      `${label} must be a positive decimal value.`,
      {
        category: "validation",
        code: "INVALID_QUANTITY",
      },
    );
  }
}

function requireNonNegativeDecimal(
  value: DecimalString,
  label: string,
): void {
  if (
    typeof value !== "string" ||
    !/^\d+(?:\.\d+)?$/.test(value)
  ) {
    throw new ApiError(
      `${label} must be a non-negative decimal value.`,
      {
        category: "validation",
        code: "INVALID_DECIMAL",
      },
    );
  }
}

function requireNonZeroSignedDecimal(
  value: DecimalString,
  label: string,
): void {
  if (
    typeof value !== "string" ||
    !DECIMAL_PATTERN.test(value) ||
    !/[1-9]/.test(value)
  ) {
    throw new ApiError(
      `${label} must be a non-zero decimal value.`,
      {
        category: "validation",
        code: "INVALID_ADJUSTMENT_QUANTITY",
      },
    );
  }
}

function requireItems<T>(
  items: readonly T[],
  label: string,
): void {
  if (
    !Array.isArray(items) ||
    items.length === 0
  ) {
    throw new ApiError(
      `${label} must contain at least one item.`,
      {
        category: "validation",
        code: "EMPTY_ITEMS",
      },
    );
  }
}

function requireUpdate(
  request: object,
): void {
  if (Object.keys(request).length === 0) {
    throw new ApiError(
      "At least one field must be provided.",
      {
        category: "validation",
        code: "EMPTY_UPDATE",
      },
    );
  }
}

function resourcePath(
  collection: string,
  id: UUID,
  label: string,
): string {
  return `${collection}/${encodeURIComponent(
    requireText(id, label),
  )}`;
}

function paginationQuery(
  params: PaginationParams,
): {
  page?: number;
  page_size?: number;
  search?: string;
  sort_by?: string;
  sort_direction?: "asc" | "desc";
} {
  return {
    page: params.page,
    page_size: params.page_size,
    search: params.search,
    sort_by: params.sort_by,
    sort_direction: params.sort_direction,
  };
}

function mutationOptions(
  options: InventoryApiRequestOptions,
): InventoryApiRequestOptions {
  if (options.idempotencyKey !== undefined) {
    const key = requireText(
      options.idempotencyKey,
      "Idempotency key",
    );

    if (
      key.length > 255 ||
      /[\r\n]/.test(key)
    ) {
      throw new ApiError(
        "The idempotency key is invalid.",
        {
          category: "validation",
          code: "INVALID_IDEMPOTENCY_KEY",
        },
      );
    }

    return {
      ...options,
      idempotencyKey: key,
    };
  }

  return options;
}

function validatePurchaseItems(
  items: readonly PurchaseOrderItemInput[],
): void {
  requireItems(items, "Purchase order");

  items.forEach((item, index) => {
    requireText(
      item.item_id,
      `Item ID at line ${index + 1}`,
    );

    requirePositiveDecimal(
      item.quantity,
      `Quantity at line ${index + 1}`,
    );

    requireNonNegativeDecimal(
      item.unit_price,
      `Unit price at line ${index + 1}`,
    );
  });
}

function validateReceiptItems(
  items: readonly GoodsReceiptItemInput[],
): void {
  requireItems(items, "Goods receipt");

  items.forEach((item, index) => {
    requireText(
      item.purchase_order_item_id,
      `Purchase order item at line ${index + 1}`,
    );

    requireText(
      item.item_id,
      `Inventory item at line ${index + 1}`,
    );

    requireText(
      item.batch_number,
      `Batch number at line ${index + 1}`,
    );

    requirePositiveDecimal(
      item.received_quantity,
      `Received quantity at line ${index + 1}`,
    );

    requireNonNegativeDecimal(
      item.unit_cost,
      `Unit cost at line ${index + 1}`,
    );

    if (
      item.manufacturing_date &&
      item.expiry_date &&
      item.expiry_date <
        item.manufacturing_date
    ) {
      throw new ApiError(
        `Expiry date cannot precede manufacturing date at line ${index + 1}.`,
        {
          category: "validation",
          code: "INVALID_BATCH_DATES",
        },
      );
    }
  });
}

function validateDispatchItems(
  items: readonly DispatchItemInput[],
): void {
  requireItems(items, "Dispatch");

  items.forEach((item, index) => {
    requireText(
      item.sales_order_item_id,
      `Sales order item at line ${index + 1}`,
    );

    requireText(
      item.product_id,
      `Product ID at line ${index + 1}`,
    );

    requirePositiveDecimal(
      item.quantity,
      `Dispatch quantity at line ${index + 1}`,
    );

    requireItems(
      item.batch_allocations,
      `Batch allocations at line ${index + 1}`,
    );

    item.batch_allocations.forEach(
      (allocation, allocationIndex) => {
        requireText(
          allocation.batch_id,
          `Batch ID at line ${index + 1}, allocation ${allocationIndex + 1}`,
        );

        requirePositiveDecimal(
          allocation.quantity,
          `Batch quantity at line ${index + 1}, allocation ${allocationIndex + 1}`,
        );
      },
    );
  });
}

/* Purchase orders */

export async function getPurchaseOrders(
  params: PurchaseOrderListParams = {},
  options: InventoryApiRequestOptions = {},
): Promise<PaginatedResponse<PurchaseOrder>> {
  return apiClient.get<
    PaginatedResponse<PurchaseOrder>
  >(
    INVENTORY_API_PATHS.PURCHASE_ORDERS,
    {
      ...options,
      query: {
        ...paginationQuery(params),
        supplier_id: params.supplier_id,
        status: params.status,
        date_from: params.date_from,
        date_to: params.date_to,
      },
    },
  );
}

export async function getPurchaseOrderById(
  purchaseOrderId: UUID,
  options: InventoryApiRequestOptions = {},
): Promise<PurchaseOrder> {
  return apiClient.get<PurchaseOrder>(
    resourcePath(
      INVENTORY_API_PATHS.PURCHASE_ORDERS,
      purchaseOrderId,
      "Purchase order ID",
    ),
    options,
  );
}

export async function createPurchaseOrder(
  request: PurchaseOrderInput,
  options: InventoryApiRequestOptions = {},
): Promise<PurchaseOrder> {
  requireText(
    request.supplier_id,
    "Supplier ID",
  );

  validatePurchaseItems(request.items);

  return apiClient.post<PurchaseOrder>(
    INVENTORY_API_PATHS.PURCHASE_ORDERS,
    request,
    mutationOptions(options),
  );
}

export async function updatePurchaseOrder(
  purchaseOrderId: UUID,
  request: UpdatePurchaseOrderInput,
  options: InventoryApiRequestOptions = {},
): Promise<PurchaseOrder> {
  requireUpdate(request);

  if (request.supplier_id !== undefined) {
    requireText(
      request.supplier_id,
      "Supplier ID",
    );
  }

  if (request.items !== undefined) {
    validatePurchaseItems(request.items);
  }

  return apiClient.patch<PurchaseOrder>(
    resourcePath(
      INVENTORY_API_PATHS.PURCHASE_ORDERS,
      purchaseOrderId,
      "Purchase order ID",
    ),
    request,
    mutationOptions(options),
  );
}

export async function postPurchaseOrder(
  purchaseOrderId: UUID,
  options: InventoryApiRequestOptions = {},
): Promise<PurchaseOrder> {
  return apiClient.post<PurchaseOrder>(
    `${resourcePath(
      INVENTORY_API_PATHS.PURCHASE_ORDERS,
      purchaseOrderId,
      "Purchase order ID",
    )}/post`,
    undefined,
    mutationOptions(options),
  );
}

export async function cancelPurchaseOrder(
  purchaseOrderId: UUID,
  reason: string,
  options: InventoryApiRequestOptions = {},
): Promise<PurchaseOrder> {
  return apiClient.post<PurchaseOrder>(
    `${resourcePath(
      INVENTORY_API_PATHS.PURCHASE_ORDERS,
      purchaseOrderId,
      "Purchase order ID",
    )}/cancel`,
    {
      reason: requireText(
        reason,
        "Cancellation reason",
      ),
    },
    mutationOptions(options),
  );
}

/* Goods receipts */

export async function getGoodsReceipts(
  params: GoodsReceiptListParams = {},
  options: InventoryApiRequestOptions = {},
): Promise<PaginatedResponse<GoodsReceipt>> {
  return apiClient.get<
    PaginatedResponse<GoodsReceipt>
  >(
    INVENTORY_API_PATHS.GOODS_RECEIPTS,
    {
      ...options,
      query: {
        ...paginationQuery(params),
        supplier_id: params.supplier_id,
        purchase_order_id:
          params.purchase_order_id,
        status: params.status,
        date_from: params.date_from,
        date_to: params.date_to,
      },
    },
  );
}

export async function getGoodsReceiptById(
  receiptId: UUID,
  options: InventoryApiRequestOptions = {},
): Promise<GoodsReceipt> {
  return apiClient.get<GoodsReceipt>(
    resourcePath(
      INVENTORY_API_PATHS.GOODS_RECEIPTS,
      receiptId,
      "Goods receipt ID",
    ),
    options,
  );
}

export async function createGoodsReceipt(
  request: GoodsReceiptInput,
  options: InventoryApiRequestOptions = {},
): Promise<GoodsReceipt> {
  requireText(
    request.purchase_order_id,
    "Purchase order ID",
  );

  validateReceiptItems(request.items);

  return apiClient.post<GoodsReceipt>(
    INVENTORY_API_PATHS.GOODS_RECEIPTS,
    request,
    mutationOptions(options),
  );
}

export async function updateGoodsReceipt(
  receiptId: UUID,
  request: UpdateGoodsReceiptInput,
  options: InventoryApiRequestOptions = {},
): Promise<GoodsReceipt> {
  requireUpdate(request);

  if (
    request.purchase_order_id !== undefined
  ) {
    requireText(
      request.purchase_order_id,
      "Purchase order ID",
    );
  }

  if (request.items !== undefined) {
    validateReceiptItems(request.items);
  }

  return apiClient.patch<GoodsReceipt>(
    resourcePath(
      INVENTORY_API_PATHS.GOODS_RECEIPTS,
      receiptId,
      "Goods receipt ID",
    ),
    request,
    mutationOptions(options),
  );
}

export async function postGoodsReceipt(
  receiptId: UUID,
  options: InventoryApiRequestOptions = {},
): Promise<GoodsReceipt> {
  return apiClient.post<GoodsReceipt>(
    `${resourcePath(
      INVENTORY_API_PATHS.GOODS_RECEIPTS,
      receiptId,
      "Goods receipt ID",
    )}/post`,
    undefined,
    mutationOptions(options),
  );
}

export async function cancelGoodsReceipt(
  receiptId: UUID,
  reason: string,
  options: InventoryApiRequestOptions = {},
): Promise<GoodsReceipt> {
  return apiClient.post<GoodsReceipt>(
    `${resourcePath(
      INVENTORY_API_PATHS.GOODS_RECEIPTS,
      receiptId,
      "Goods receipt ID",
    )}/cancel`,
    {
      reason: requireText(
        reason,
        "Cancellation reason",
      ),
    },
    mutationOptions(options),
  );
}

/* Stock summary */

export async function getStockSummary(
  params: StockSummaryParams = {},
  options: InventoryApiRequestOptions = {},
): Promise<PaginatedResponse<StockSummary>> {
  return apiClient.get<
    PaginatedResponse<StockSummary>
  >(
    INVENTORY_API_PATHS.STOCK_SUMMARY,
    {
      ...options,
      query: {
        ...paginationQuery(params),
        item_id: params.item_id,
        item_type: params.item_type,
      },
    },
  );
}

/* Stock batches */

export async function getStockBatches(
  params: StockBatchListParams = {},
  options: InventoryApiRequestOptions = {},
): Promise<PaginatedResponse<StockBatch>> {
  return apiClient.get<
    PaginatedResponse<StockBatch>
  >(
    INVENTORY_API_PATHS.STOCK_BATCHES,
    {
      ...options,
      query: {
        ...paginationQuery(params),
        item_id: params.item_id,
        batch_number: params.batch_number,
        expiry_from: params.expiry_from,
        expiry_to: params.expiry_to,
      },
    },
  );
}

export async function getStockBatchById(
  batchId: UUID,
  options: InventoryApiRequestOptions = {},
): Promise<StockBatch> {
  return apiClient.get<StockBatch>(
    resourcePath(
      INVENTORY_API_PATHS.STOCK_BATCHES,
      batchId,
      "Stock batch ID",
    ),
    options,
  );
}

/* Stock ledger */

export async function getStockLedger(
  params: StockLedgerParams = {},
  options: InventoryApiRequestOptions = {},
): Promise<PaginatedResponse<StockLedgerEntry>> {
  return apiClient.get<
    PaginatedResponse<StockLedgerEntry>
  >(
    INVENTORY_API_PATHS.STOCK_LEDGER,
    {
      ...options,
      query: {
        ...paginationQuery(params),
        item_id: params.item_id,
        batch_id: params.batch_id,
        movement_type: params.movement_type,
        date_from: params.date_from,
        date_to: params.date_to,
      },
    },
  );
}

/* Stock adjustments */

export async function getStockAdjustments(
  params: StockAdjustmentListParams = {},
  options: InventoryApiRequestOptions = {},
): Promise<PaginatedResponse<StockAdjustment>> {
  return apiClient.get<
    PaginatedResponse<StockAdjustment>
  >(
    INVENTORY_API_PATHS.STOCK_ADJUSTMENTS,
    {
      ...options,
      query: {
        ...paginationQuery(params),
        item_id: params.item_id,
        batch_id: params.batch_id,
        status: params.status,
        date_from: params.date_from,
        date_to: params.date_to,
      },
    },
  );
}

export async function getStockAdjustmentById(
  adjustmentId: UUID,
  options: InventoryApiRequestOptions = {},
): Promise<StockAdjustment> {
  return apiClient.get<StockAdjustment>(
    resourcePath(
      INVENTORY_API_PATHS.STOCK_ADJUSTMENTS,
      adjustmentId,
      "Stock adjustment ID",
    ),
    options,
  );
}

export async function createStockAdjustment(
  request: StockAdjustmentInput,
  options: InventoryApiRequestOptions = {},
): Promise<StockAdjustment> {
  requireText(
    request.item_id,
    "Inventory item ID",
  );

  requireText(
    request.batch_id,
    "Stock batch ID",
  );

  requireText(
    request.reason,
    "Adjustment reason",
  );

  requireNonZeroSignedDecimal(
    request.adjustment_quantity,
    "Adjustment quantity",
  );

  return apiClient.post<StockAdjustment>(
    INVENTORY_API_PATHS.STOCK_ADJUSTMENTS,
    request,
    mutationOptions(options),
  );
}

export async function postStockAdjustment(
  adjustmentId: UUID,
  options: InventoryApiRequestOptions = {},
): Promise<StockAdjustment> {
  return apiClient.post<StockAdjustment>(
    `${resourcePath(
      INVENTORY_API_PATHS.STOCK_ADJUSTMENTS,
      adjustmentId,
      "Stock adjustment ID",
    )}/post`,
    undefined,
    mutationOptions(options),
  );
}

/* Dispatches */

export async function getDispatches(
  params: DispatchListParams = {},
  options: InventoryApiRequestOptions = {},
): Promise<PaginatedResponse<Dispatch>> {
  return apiClient.get<
    PaginatedResponse<Dispatch>
  >(
    INVENTORY_API_PATHS.DISPATCHES,
    {
      ...options,
      query: {
        ...paginationQuery(params),
        sales_order_id: params.sales_order_id,
        status: params.status,
        date_from: params.date_from,
        date_to: params.date_to,
      },
    },
  );
}

export async function getDispatchById(
  dispatchId: UUID,
  options: InventoryApiRequestOptions = {},
): Promise<Dispatch> {
  return apiClient.get<Dispatch>(
    resourcePath(
      INVENTORY_API_PATHS.DISPATCHES,
      dispatchId,
      "Dispatch ID",
    ),
    options,
  );
}

export async function createDispatch(
  request: DispatchInput,
  options: InventoryApiRequestOptions = {},
): Promise<Dispatch> {
  requireText(
    request.sales_order_id,
    "Sales order ID",
  );

  validateDispatchItems(request.items);

  return apiClient.post<Dispatch>(
    INVENTORY_API_PATHS.DISPATCHES,
    request,
    mutationOptions(options),
  );
}

export async function updateDispatch(
  dispatchId: UUID,
  request: UpdateDispatchInput,
  options: InventoryApiRequestOptions = {},
): Promise<Dispatch> {
  requireUpdate(request);

  if (
    request.sales_order_id !== undefined
  ) {
    requireText(
      request.sales_order_id,
      "Sales order ID",
    );
  }

  if (request.items !== undefined) {
    validateDispatchItems(request.items);
  }

  return apiClient.patch<Dispatch>(
    resourcePath(
      INVENTORY_API_PATHS.DISPATCHES,
      dispatchId,
      "Dispatch ID",
    ),
    request,
    mutationOptions(options),
  );
}

export async function postDispatch(
  dispatchId: UUID,
  options: InventoryApiRequestOptions = {},
): Promise<Dispatch> {
  return apiClient.post<Dispatch>(
    `${resourcePath(
      INVENTORY_API_PATHS.DISPATCHES,
      dispatchId,
      "Dispatch ID",
    )}/post`,
    undefined,
    mutationOptions(options),
  );
}

export async function cancelDispatch(
  dispatchId: UUID,
  reason: string,
  options: InventoryApiRequestOptions = {},
): Promise<Dispatch> {
  return apiClient.post<Dispatch>(
    `${resourcePath(
      INVENTORY_API_PATHS.DISPATCHES,
      dispatchId,
      "Dispatch ID",
    )}/cancel`,
    {
      reason: requireText(
        reason,
        "Cancellation reason",
      ),
    },
    mutationOptions(options),
  );
}

export const inventoryApi = {
  getPurchaseOrders,
  getPurchaseOrderById,
  createPurchaseOrder,
  updatePurchaseOrder,
  postPurchaseOrder,
  cancelPurchaseOrder,

  getGoodsReceipts,
  getGoodsReceiptById,
  createGoodsReceipt,
  updateGoodsReceipt,
  postGoodsReceipt,
  cancelGoodsReceipt,

  getStockSummary,
  getStockBatches,
  getStockBatchById,
  getStockLedger,

  getStockAdjustments,
  getStockAdjustmentById,
  createStockAdjustment,
  postStockAdjustment,

  getDispatches,
  getDispatchById,
  createDispatch,
  updateDispatch,
  postDispatch,
  cancelDispatch,
} as const;
