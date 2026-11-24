import type {
  GSTInvoice,
  ISODate,
  ISODateTime,
  OrderApprovalStatus,
  OrderFulfillmentStatus,
  PaginatedResponse,
  PaginationParams,
  SalesOrderInput,
  UUID,
} from "../../types/business";

import type {
  OfflineOrderSyncRequest,
  OfflineOrderSyncResponse,
} from "../../types/offline";

import {
  ApiError,
  apiClient,
  type ApiRequestOptions,
} from "./client";

/**
 * Sales order, approval, invoicing, and offline synchronization APIs.
 *
 * Order approval, fulfillment, invoicing, and synchronization are
 * independent workflows. All business transitions and financial
 * calculations remain authoritative on the backend.
 */

export const SALES_API_PATHS = {
  ORDERS: "/sales-orders",
  INVOICES: "/invoices",
  OFFLINE_SYNC: "/sales-orders/sync",
} as const;

export interface SalesApiRequestOptions
  extends Pick<
    ApiRequestOptions,
    "signal" | "timeoutMs"
  > {
  idempotencyKey?: string;
}

export interface SalesOrderItem {
  id: UUID;
  sales_order_id: UUID;
  product_id: UUID;
  quantity: string;
  unit: string;
  unit_price: string;
}

export interface SalesOrder {
  id: UUID;
  order_number: string;
  customer_id: UUID;
  salesman_id: UUID;
  order_date: ISODateTime;
  approval_status: OrderApprovalStatus;
  fulfillment_status: OrderFulfillmentStatus;
  notes: string | null;
  rejection_reason: string | null;
  items: SalesOrderItem[];
  created_at: ISODateTime;
  updated_at: ISODateTime | null;
  submitted_at?: ISODateTime | null;
  reviewed_at?: ISODateTime | null;
  reviewed_by?: UUID | null;
}

export interface SalesOrderListParams
  extends PaginationParams {
  customer_id?: UUID;
  salesman_id?: UUID;
  approval_status?: OrderApprovalStatus;
  fulfillment_status?: OrderFulfillmentStatus;
  date_from?: ISODate;
  date_to?: ISODate;
}

export interface InvoiceListParams
  extends PaginationParams {
  customer_id?: UUID;
  sales_order_id?: UUID;
  status?: GSTInvoice["status"];
  payment_status?: GSTInvoice["payment_status"];
  date_from?: ISODate;
  date_to?: ISODate;
}

export interface RejectSalesOrderRequest {
  reason: string;
}

export interface CreateInvoiceRequest {
  sales_order_id: UUID;
  invoice_date?: ISODate;
}

export type UpdateSalesOrderRequest = Partial<SalesOrderInput>;

function requireText(
  value: string,
  label: string,
): string {
  const normalized = value.trim();

  if (!normalized) {
    throw new ApiError(
      `${label} is required.`,
      {
        category: "validation",
        code: "REQUIRED_FIELD",
      },
    );
  }

  return normalized;
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

function validateSalesOrderInput(
  request: SalesOrderInput,
): void {
  requireText(
    request.customer_id,
    "Customer ID",
  );

  if (
    !Array.isArray(request.items) ||
    request.items.length === 0
  ) {
    throw new ApiError(
      "A sales order must contain at least one item.",
      {
        category: "validation",
        code: "EMPTY_SALES_ORDER",
      },
    );
  }

  for (
    const [index, item] of
    request.items.entries()
  ) {
    requireText(
      item.product_id,
      `Product ID for item ${index + 1}`,
    );

    if (
      !/^\d+(?:\.\d+)?$/.test(
        item.quantity,
      ) ||
      !/[1-9]/.test(item.quantity)
    ) {
      throw new ApiError(
        `Item ${index + 1} must have a positive quantity.`,
        {
          category: "validation",
          code: "INVALID_ORDER_QUANTITY",
        },
      );
    }

    if (
      !/^\d+(?:\.\d+)?$/.test(
        item.unit_price,
      )
    ) {
      throw new ApiError(
        `Item ${index + 1} must have a non-negative unit price.`,
        {
          category: "validation",
          code: "INVALID_UNIT_PRICE",
        },
      );
    }
  }
}

function validateUpdateRequest(
  request: UpdateSalesOrderRequest,
): void {
  if (Object.keys(request).length === 0) {
    throw new ApiError(
      "At least one order field must be provided.",
      {
        category: "validation",
        code: "EMPTY_UPDATE",
      },
    );
  }

  if (
    request.items !== undefined ||
    request.customer_id !== undefined
  ) {
    validateSalesOrderInput({
      customer_id:
        request.customer_id ?? "unchanged",
      items:
        request.items ?? [
          {
            product_id: "unchanged",
            quantity: "1",
            unit: "pcs",
            unit_price: "0",
          },
        ],
    });
  }
}

function validateIdempotencyKey(
  key: string,
): string {
  const normalized = requireText(
    key,
    "Idempotency key",
  );

  if (
    normalized.length > 255 ||
    /[\r\n]/.test(normalized)
  ) {
    throw new ApiError(
      "The idempotency key is invalid.",
      {
        category: "validation",
        code: "INVALID_IDEMPOTENCY_KEY",
      },
    );
  }

  return normalized;
}

function getPaginationQuery(
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

/* Sales orders */

export async function getSalesOrders(
  params: SalesOrderListParams = {},
  options: SalesApiRequestOptions = {},
): Promise<PaginatedResponse<SalesOrder>> {
  return apiClient.get<
    PaginatedResponse<SalesOrder>
  >(
    SALES_API_PATHS.ORDERS,
    {
      ...options,
      query: {
        ...getPaginationQuery(params),
        customer_id: params.customer_id,
        salesman_id: params.salesman_id,
        approval_status:
          params.approval_status,
        fulfillment_status:
          params.fulfillment_status,
        date_from: params.date_from,
        date_to: params.date_to,
      },
    },
  );
}

export async function getSalesOrderById(
  orderId: UUID,
  options: SalesApiRequestOptions = {},
): Promise<SalesOrder> {
  return apiClient.get<SalesOrder>(
    resourcePath(
      SALES_API_PATHS.ORDERS,
      orderId,
      "Sales order ID",
    ),
    options,
  );
}

export async function createSalesOrder(
  request: SalesOrderInput,
  options: SalesApiRequestOptions = {},
): Promise<SalesOrder> {
  validateSalesOrderInput(request);

  return apiClient.post<SalesOrder>(
    SALES_API_PATHS.ORDERS,
    request,
    {
      ...options,
      idempotencyKey:
        options.idempotencyKey
          ? validateIdempotencyKey(
              options.idempotencyKey,
            )
          : undefined,
    },
  );
}

export async function updateSalesOrder(
  orderId: UUID,
  request: UpdateSalesOrderRequest,
  options: SalesApiRequestOptions = {},
): Promise<SalesOrder> {
  validateUpdateRequest(request);

  return apiClient.patch<SalesOrder>(
    resourcePath(
      SALES_API_PATHS.ORDERS,
      orderId,
      "Sales order ID",
    ),
    request,
    options,
  );
}

export async function submitSalesOrder(
  orderId: UUID,
  options: SalesApiRequestOptions = {},
): Promise<SalesOrder> {
  return apiClient.post<SalesOrder>(
    `${resourcePath(
      SALES_API_PATHS.ORDERS,
      orderId,
      "Sales order ID",
    )}/submit`,
    undefined,
    options,
  );
}

export async function approveSalesOrder(
  orderId: UUID,
  options: SalesApiRequestOptions = {},
): Promise<SalesOrder> {
  return apiClient.post<SalesOrder>(
    `${resourcePath(
      SALES_API_PATHS.ORDERS,
      orderId,
      "Sales order ID",
    )}/approve`,
    undefined,
    options,
  );
}

export async function rejectSalesOrder(
  orderId: UUID,
  request: RejectSalesOrderRequest,
  options: SalesApiRequestOptions = {},
): Promise<SalesOrder> {
  return apiClient.post<SalesOrder>(
    `${resourcePath(
      SALES_API_PATHS.ORDERS,
      orderId,
      "Sales order ID",
    )}/reject`,
    {
      reason: requireText(
        request.reason,
        "Rejection reason",
      ),
    },
    options,
  );
}

export async function cancelSalesOrder(
  orderId: UUID,
  options: SalesApiRequestOptions = {},
): Promise<SalesOrder> {
  return apiClient.post<SalesOrder>(
    `${resourcePath(
      SALES_API_PATHS.ORDERS,
      orderId,
      "Sales order ID",
    )}/cancel`,
    undefined,
    options,
  );
}

/* Offline synchronization */

export async function synchronizeOfflineOrder(
  request: OfflineOrderSyncRequest,
  options: SalesApiRequestOptions = {},
): Promise<OfflineOrderSyncResponse> {
  const payload = request as unknown as
    Record<string, unknown>;

  const key = payload.idempotency_key;

  if (
    typeof key !== "string" ||
    !key.trim()
  ) {
    throw new ApiError(
      "Offline synchronization requires a stable idempotency key.",
      {
        category: "validation",
        code: "MISSING_IDEMPOTENCY_KEY",
      },
    );
  }

  const idempotencyKey =
    validateIdempotencyKey(key);

  if (
    options.idempotencyKey !== undefined &&
    options.idempotencyKey !==
      idempotencyKey
  ) {
    throw new ApiError(
      "The request idempotency key does not match the offline order.",
      {
        category: "validation",
        code: "IDEMPOTENCY_KEY_MISMATCH",
      },
    );
  }

  return apiClient.post<
    OfflineOrderSyncResponse
  >(
    SALES_API_PATHS.OFFLINE_SYNC,
    request,
    {
      ...options,
      idempotencyKey,
    },
  );
}

/* GST invoices */

export async function getInvoices(
  params: InvoiceListParams = {},
  options: SalesApiRequestOptions = {},
): Promise<PaginatedResponse<GSTInvoice>> {
  return apiClient.get<
    PaginatedResponse<GSTInvoice>
  >(
    SALES_API_PATHS.INVOICES,
    {
      ...options,
      query: {
        ...getPaginationQuery(params),
        customer_id: params.customer_id,
        sales_order_id:
          params.sales_order_id,
        status: params.status,
        payment_status:
          params.payment_status,
        date_from: params.date_from,
        date_to: params.date_to,
      },
    },
  );
}

export async function getInvoiceById(
  invoiceId: UUID,
  options: SalesApiRequestOptions = {},
): Promise<GSTInvoice> {
  return apiClient.get<GSTInvoice>(
    resourcePath(
      SALES_API_PATHS.INVOICES,
      invoiceId,
      "Invoice ID",
    ),
    options,
  );
}

export async function createInvoice(
  request: CreateInvoiceRequest,
  options: SalesApiRequestOptions = {},
): Promise<GSTInvoice> {
  requireText(
    request.sales_order_id,
    "Sales order ID",
  );

  return apiClient.post<GSTInvoice>(
    SALES_API_PATHS.INVOICES,
    request,
    options,
  );
}

export async function postInvoice(
  invoiceId: UUID,
  options: SalesApiRequestOptions = {},
): Promise<GSTInvoice> {
  return apiClient.post<GSTInvoice>(
    `${resourcePath(
      SALES_API_PATHS.INVOICES,
      invoiceId,
      "Invoice ID",
    )}/post`,
    undefined,
    options,
  );
}

export async function cancelInvoice(
  invoiceId: UUID,
  reason: string,
  options: SalesApiRequestOptions = {},
): Promise<GSTInvoice> {
  return apiClient.post<GSTInvoice>(
    `${resourcePath(
      SALES_API_PATHS.INVOICES,
      invoiceId,
      "Invoice ID",
    )}/cancel`,
    {
      reason: requireText(
        reason,
        "Cancellation reason",
      ),
    },
    options,
  );
}

export async function downloadInvoicePdf(
  invoiceId: UUID,
  options: SalesApiRequestOptions = {},
): Promise<Blob> {
  const response = await apiClient.request<
    Blob
  >(
    "GET",
    `${resourcePath(
      SALES_API_PATHS.INVOICES,
      invoiceId,
      "Invoice ID",
    )}/pdf`,
    undefined,
    {
      ...options,
      headers: {
        Accept: "application/pdf",
      },
    },
  );

  if (!(response instanceof Blob)) {
    throw new ApiError(
      "The backend did not return a valid invoice PDF.",
      {
        category: "server",
        code: "INVALID_PDF_RESPONSE",
      },
    );
  }

  return response;
}

export const salesApi = {
  getSalesOrders,
  getSalesOrderById,
  createSalesOrder,
  updateSalesOrder,
  submitSalesOrder,
  approveSalesOrder,
  rejectSalesOrder,
  cancelSalesOrder,

  synchronizeOfflineOrder,

  getInvoices,
  getInvoiceById,
  createInvoice,
  postInvoice,
  cancelInvoice,
  downloadInvoicePdf,
} as const;
