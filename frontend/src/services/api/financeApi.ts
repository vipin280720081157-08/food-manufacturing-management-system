import type {
  GSTInvoice,
  ISODate,
  ISODateTime,
  Money,
  PaginatedResponse,
  PaginationParams,
  PaymentMethod,
  PaymentStatus,
  TransactionStatus,
  UUID,
} from "../../types/business";

import {
  ApiError,
  apiClient,
  type ApiRequestOptions,
} from "./client";

/**
 * Payment collection, receivables, and invoice finance API integration.
 *
 * Payment allocation, outstanding balances, GST amounts, and
 * financial postings are calculated and enforced by the backend.
 * Mutation requests are never retried automatically.
 */

export const FINANCE_API_PATHS = {
  PAYMENTS: "/payments",
  OUTSTANDING: "/finance/outstanding",
  RECEIVABLES_SUMMARY: "/finance/receivables-summary",
  INVOICES: "/invoices",
} as const;

export interface FinanceApiRequestOptions
  extends Pick<
    ApiRequestOptions,
    "signal" | "timeoutMs"
  > {
  idempotencyKey?: string;
}

export interface PaymentAllocation {
  id: UUID;
  payment_id: UUID;
  invoice_id: UUID;
  allocated_amount: Money;
}

export interface Payment {
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
  created_at: ISODateTime;
  updated_at: ISODateTime | null;
  created_by?: UUID | null;
  posted_at?: ISODateTime | null;
  posted_by?: UUID | null;
}

export interface PaymentAllocationInput {
  invoice_id: UUID;
  allocated_amount: Money;
}

export interface PaymentInput {
  customer_id: UUID;
  payment_date?: ISODate;
  amount: Money;
  payment_method: PaymentMethod;
  reference_number?: string | null;
  notes?: string | null;
  allocations: PaymentAllocationInput[];
}

export type UpdatePaymentInput = Partial<PaymentInput>;

export interface PaymentListParams
  extends PaginationParams {
  customer_id?: UUID;
  invoice_id?: UUID;
  payment_method?: PaymentMethod;
  status?: TransactionStatus;
  date_from?: ISODate;
  date_to?: ISODate;
}

export interface OutstandingInvoice {
  invoice_id: UUID;
  invoice_number: string;
  customer_id: UUID;
  customer_name: string;
  invoice_date: ISODate;
  due_date: ISODate | null;
  invoice_amount: Money;
  amount_paid: Money;
  outstanding_amount: Money;
  payment_status: PaymentStatus;
  days_overdue: number;
}

export interface OutstandingListParams
  extends PaginationParams {
  customer_id?: UUID;
  payment_status?: PaymentStatus;
  date_from?: ISODate;
  date_to?: ISODate;
  overdue_only?: boolean;
}

export interface CustomerOutstandingSummary {
  customer_id: UUID;
  customer_name: string;
  total_invoiced: Money;
  total_paid: Money;
  total_outstanding: Money;
  overdue_amount: Money;
  outstanding_invoice_count: number;
}

export interface ReceivablesSummary {
  total_invoiced: Money;
  total_collected: Money;
  total_outstanding: Money;
  total_overdue: Money;
  unpaid_invoice_count: number;
  overdue_invoice_count: number;
  customers: CustomerOutstandingSummary[];
  generated_at: ISODateTime;
}

export interface ReceivablesSummaryParams {
  customer_id?: UUID;
  date_from?: ISODate;
  date_to?: ISODate;
}

export interface PaymentCancellationRequest {
  reason: string;
}

const NON_NEGATIVE_DECIMAL_PATTERN =
  /^\d+(?:\.\d+)?$/;

const PAYMENT_METHODS: readonly PaymentMethod[] = [
  "cash",
  "bank_transfer",
  "upi",
  "cheque",
  "other",
];

function validationError(
  message: string,
  code: string,
): ApiError {
  return new ApiError(message, {
    category: "validation",
    code,
  });
}

function requireText(
  value: string,
  label: string,
): string {
  if (
    typeof value !== "string" ||
    !value.trim()
  ) {
    throw validationError(
      `${label} is required.`,
      "REQUIRED_FIELD",
    );
  }

  return value.trim();
}

function requirePositiveDecimal(
  value: Money,
  label: string,
): void {
  if (
    typeof value !== "string" ||
    !NON_NEGATIVE_DECIMAL_PATTERN.test(value) ||
    !/[1-9]/.test(value)
  ) {
    throw validationError(
      `${label} must be a positive decimal amount.`,
      "INVALID_PAYMENT_AMOUNT",
    );
  }
}

function validatePaymentMethod(
  method: PaymentMethod,
): void {
  if (!PAYMENT_METHODS.includes(method)) {
    throw validationError(
      "The selected payment method is invalid.",
      "INVALID_PAYMENT_METHOD",
    );
  }
}

function validatePaymentAllocations(
  allocations: readonly PaymentAllocationInput[],
): void {
  if (
    !Array.isArray(allocations) ||
    allocations.length === 0
  ) {
    throw validationError(
      "At least one invoice allocation is required.",
      "EMPTY_PAYMENT_ALLOCATIONS",
    );
  }

  const invoiceIds = new Set<string>();

  allocations.forEach((allocation, index) => {
    const invoiceId = requireText(
      allocation.invoice_id,
      `Invoice ID at allocation ${index + 1}`,
    );

    if (invoiceIds.has(invoiceId)) {
      throw validationError(
        "The same invoice cannot appear more than once in a payment.",
        "DUPLICATE_INVOICE_ALLOCATION",
      );
    }

    invoiceIds.add(invoiceId);

    requirePositiveDecimal(
      allocation.allocated_amount,
      `Allocated amount at line ${index + 1}`,
    );
  });
}

function validatePaymentInput(
  request: PaymentInput,
): void {
  requireText(
    request.customer_id,
    "Customer ID",
  );

  requirePositiveDecimal(
    request.amount,
    "Payment amount",
  );

  validatePaymentMethod(
    request.payment_method,
  );

  validatePaymentAllocations(
    request.allocations,
  );
}

function validatePaymentUpdate(
  request: UpdatePaymentInput,
): void {
  if (Object.keys(request).length === 0) {
    throw validationError(
      "At least one payment field must be provided.",
      "EMPTY_UPDATE",
    );
  }

  if (request.customer_id !== undefined) {
    requireText(
      request.customer_id,
      "Customer ID",
    );
  }

  if (request.amount !== undefined) {
    requirePositiveDecimal(
      request.amount,
      "Payment amount",
    );
  }

  if (
    request.payment_method !== undefined
  ) {
    validatePaymentMethod(
      request.payment_method,
    );
  }

  if (request.allocations !== undefined) {
    validatePaymentAllocations(
      request.allocations,
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
  options: FinanceApiRequestOptions,
): FinanceApiRequestOptions {
  if (
    options.idempotencyKey === undefined
  ) {
    return options;
  }

  const key = requireText(
    options.idempotencyKey,
    "Idempotency key",
  );

  if (
    key.length > 255 ||
    /[\r\n]/.test(key)
  ) {
    throw validationError(
      "The idempotency key is invalid.",
      "INVALID_IDEMPOTENCY_KEY",
    );
  }

  return {
    ...options,
    idempotencyKey: key,
  };
}

/* Payment records */

export async function getPayments(
  params: PaymentListParams = {},
  options: FinanceApiRequestOptions = {},
): Promise<PaginatedResponse<Payment>> {
  return apiClient.get<
    PaginatedResponse<Payment>
  >(
    FINANCE_API_PATHS.PAYMENTS,
    {
      ...options,
      query: {
        ...paginationQuery(params),
        customer_id: params.customer_id,
        invoice_id: params.invoice_id,
        payment_method:
          params.payment_method,
        status: params.status,
        date_from: params.date_from,
        date_to: params.date_to,
      },
    },
  );
}

export async function getPaymentById(
  paymentId: UUID,
  options: FinanceApiRequestOptions = {},
): Promise<Payment> {
  return apiClient.get<Payment>(
    resourcePath(
      FINANCE_API_PATHS.PAYMENTS,
      paymentId,
      "Payment ID",
    ),
    options,
  );
}

export async function createPayment(
  request: PaymentInput,
  options: FinanceApiRequestOptions = {},
): Promise<Payment> {
  validatePaymentInput(request);

  return apiClient.post<Payment>(
    FINANCE_API_PATHS.PAYMENTS,
    request,
    mutationOptions(options),
  );
}

export async function updatePayment(
  paymentId: UUID,
  request: UpdatePaymentInput,
  options: FinanceApiRequestOptions = {},
): Promise<Payment> {
  validatePaymentUpdate(request);

  return apiClient.patch<Payment>(
    resourcePath(
      FINANCE_API_PATHS.PAYMENTS,
      paymentId,
      "Payment ID",
    ),
    request,
    mutationOptions(options),
  );
}

export async function postPayment(
  paymentId: UUID,
  options: FinanceApiRequestOptions = {},
): Promise<Payment> {
  return apiClient.post<Payment>(
    `${resourcePath(
      FINANCE_API_PATHS.PAYMENTS,
      paymentId,
      "Payment ID",
    )}/post`,
    undefined,
    mutationOptions(options),
  );
}

export async function cancelPayment(
  paymentId: UUID,
  request: PaymentCancellationRequest,
  options: FinanceApiRequestOptions = {},
): Promise<Payment> {
  return apiClient.post<Payment>(
    `${resourcePath(
      FINANCE_API_PATHS.PAYMENTS,
      paymentId,
      "Payment ID",
    )}/cancel`,
    {
      reason: requireText(
        request.reason,
        "Cancellation reason",
      ),
    },
    mutationOptions(options),
  );
}

/* Invoice payment details */

export async function getInvoicePayments(
  invoiceId: UUID,
  options: FinanceApiRequestOptions = {},
): Promise<PaymentAllocation[]> {
  return apiClient.get<
    PaymentAllocation[]
  >(
    `${resourcePath(
      FINANCE_API_PATHS.INVOICES,
      invoiceId,
      "Invoice ID",
    )}/payments`,
    options,
  );
}

export async function getInvoiceFinancialStatus(
  invoiceId: UUID,
  options: FinanceApiRequestOptions = {},
): Promise<GSTInvoice> {
  return apiClient.get<GSTInvoice>(
    resourcePath(
      FINANCE_API_PATHS.INVOICES,
      invoiceId,
      "Invoice ID",
    ),
    options,
  );
}

/* Outstanding receivables */

export async function getOutstandingInvoices(
  params: OutstandingListParams = {},
  options: FinanceApiRequestOptions = {},
): Promise<PaginatedResponse<OutstandingInvoice>> {
  return apiClient.get<
    PaginatedResponse<OutstandingInvoice>
  >(
    FINANCE_API_PATHS.OUTSTANDING,
    {
      ...options,
      query: {
        ...paginationQuery(params),
        customer_id: params.customer_id,
        payment_status:
          params.payment_status,
        date_from: params.date_from,
        date_to: params.date_to,
        overdue_only: params.overdue_only,
      },
    },
  );
}

export async function getCustomerOutstanding(
  customerId: UUID,
  options: FinanceApiRequestOptions = {},
): Promise<CustomerOutstandingSummary> {
  return apiClient.get<
    CustomerOutstandingSummary
  >(
    `${FINANCE_API_PATHS.OUTSTANDING}/customers/${encodeURIComponent(
      requireText(
        customerId,
        "Customer ID",
      ),
    )}`,
    options,
  );
}

export async function getReceivablesSummary(
  params: ReceivablesSummaryParams = {},
  options: FinanceApiRequestOptions = {},
): Promise<ReceivablesSummary> {
  return apiClient.get<
    ReceivablesSummary
  >(
    FINANCE_API_PATHS.RECEIVABLES_SUMMARY,
    {
      ...options,
      query: {
        customer_id: params.customer_id,
        date_from: params.date_from,
        date_to: params.date_to,
      },
    },
  );
}

export const financeApi = {
  getPayments,
  getPaymentById,
  createPayment,
  updatePayment,
  postPayment,
  cancelPayment,

  getInvoicePayments,
  getInvoiceFinancialStatus,

  getOutstandingInvoices,
  getCustomerOutstanding,
  getReceivablesSummary,
} as const;
