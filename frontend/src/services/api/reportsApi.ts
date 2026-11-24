import type {
  DashboardMetric,
  ISODate,
  ISODateTime,
  PaginatedResponse,
  PaginationParams,
  ReportCellValue,
  ReportColumn,
  UUID,
} from "../../types/business";

import type { UserRole } from "../../types/auth";

import {
  API_BASE_URL,
  ApiError,
  apiClient,
  buildApiUrl,
  getAccessToken,
  type ApiRequestOptions,
  type QueryParameters,
} from "./client";

/**
 * Reporting, dashboards, audit records, and mock government
 * document API integration.
 *
 * All report figures and document statuses originate from the
 * backend. Report exports contain actual backend-generated data.
 */

export const REPORTS_API_PATHS = {
  REPORTS: "/reports",
  DASHBOARDS: "/dashboards",
  AUDIT_RECORDS: "/audit-records",
  GOVERNMENT_DOCUMENTS: "/government-documents",
} as const;

export const REPORT_TYPES = {
  SALES_REGISTER: "sales-register",
  GST_SUMMARY: "gst-summary",
  PURCHASE_REGISTER: "purchase-register",
  STOCK_SUMMARY: "stock-summary",
  STOCK_LEDGER: "stock-ledger",
  PRODUCTION: "production",
  PAYMENTS_COLLECTIONS: "payments-collections",
  OUTSTANDING: "outstanding",
  AUDIT: "audit",
} as const;

export type ReportType =
  (typeof REPORT_TYPES)[keyof typeof REPORT_TYPES];

export const REPORT_EXPORT_FORMATS = {
  CSV: "csv",
  PDF: "pdf",
} as const;

export type ReportExportFormat =
  (typeof REPORT_EXPORT_FORMATS)[keyof typeof REPORT_EXPORT_FORMATS];

export type ReportsApiRequestOptions = Pick<ApiRequestOptions, "signal" | "timeoutMs">;

export interface ReportDefinition {
  id: string;
  report_type: ReportType;
  name: string;
  description: string | null;
  supported_formats: ReportExportFormat[];
  available_filters: string[];
}

export interface ReportFilters {
  date_from?: ISODate;
  date_to?: ISODate;
  customer_id?: UUID;
  supplier_id?: UUID;
  product_id?: UUID;
  item_id?: UUID;
  production_run_id?: UUID;
  salesman_id?: UUID;
  status?: string;
  search?: string;
}

export interface ReportRequest
  extends ReportFilters,
    PaginationParams {}

export interface ReportRow {
  [columnKey: string]: ReportCellValue;
}

export interface ReportResult {
  report_type: ReportType;
  title: string;
  columns: ReportColumn[];
  rows: ReportRow[];
  totals: Record<string, ReportCellValue>;
  date_from: ISODate | null;
  date_to: ISODate | null;
  generated_at: ISODateTime;
  page: number;
  page_size: number;
  total: number;
}

export interface ReportExport {
  blob: Blob;
  filename: string;
  contentType: string;
  format: ReportExportFormat;
}

export interface DashboardData {
  role: UserRole;
  metrics: DashboardMetric[];
  generated_at: ISODateTime;
  sections: DashboardSection[];
}

export interface DashboardSection {
  key: string;
  title: string;
  columns?: ReportColumn[];
  rows?: ReportRow[];
  metrics?: DashboardMetric[];
}

export interface DashboardFilters {
  date_from?: ISODate;
  date_to?: ISODate;
}

export interface AuditRecord {
  id: UUID;
  timestamp: ISODateTime;
  user_id: UUID | null;
  username: string | null;
  action: string;
  entity_type: string;
  entity_id: UUID | null;
  previous_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  reference: string | null;
}

export interface AuditRecordListParams
  extends PaginationParams {
  user_id?: UUID;
  entity_type?: string;
  entity_id?: UUID;
  action?: string;
  date_from?: ISODate;
  date_to?: ISODate;
}

export type GovernmentDocumentType =
  | "e_invoice"
  | "e_waybill";

export type GovernmentDocumentStatus =
  | "not_generated"
  | "generated"
  | "failed"
  | "cancelled";

export interface GovernmentDocument {
  id: UUID;
  document_type: GovernmentDocumentType;
  invoice_id: UUID;
  status: GovernmentDocumentStatus;
  mock_reference: string | null;
  generated_at: ISODateTime | null;
  error_message: string | null;
  created_at: ISODateTime;
  updated_at: ISODateTime | null;
}

export interface GovernmentDocumentListParams
  extends PaginationParams {
  invoice_id?: UUID;
  document_type?: GovernmentDocumentType;
  status?: GovernmentDocumentStatus;
  date_from?: ISODate;
  date_to?: ISODate;
}

export interface GenerateGovernmentDocumentRequest {
  invoice_id: UUID;
  document_type: GovernmentDocumentType;
}

export interface ReportCatalogResponse {
  items: ReportDefinition[];
}

const REPORT_TYPE_VALUES: readonly string[] =
  Object.values(REPORT_TYPES);

const DASHBOARD_ROLES: readonly UserRole[] = [
  "salesman",
  "factory_admin",
  "production_supervisor",
  "accountant_auditor",
  "owner",
];

const EXPORT_CONTENT_TYPES: Record<
  ReportExportFormat,
  string
> = {
  csv: "text/csv",
  pdf: "application/pdf",
};

const EXPORT_EXTENSIONS: Record<
  ReportExportFormat,
  string
> = {
  csv: "csv",
  pdf: "pdf",
};

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

function resourcePath(
  collection: string,
  id: string,
  label: string,
): string {
  return `${collection}/${encodeURIComponent(
    requireText(id, label),
  )}`;
}

function validateReportType(
  reportType: ReportType,
): void {
  if (!REPORT_TYPE_VALUES.includes(reportType)) {
    throw validationError(
      "The requested report type is invalid.",
      "INVALID_REPORT_TYPE",
    );
  }
}

function validateDateRange(
  dateFrom?: ISODate,
  dateTo?: ISODate,
): void {
  const datePattern =
    /^\d{4}-\d{2}-\d{2}$/;

  const isValidDate = (value: string): boolean => {
    if (!datePattern.test(value)) {
      return false;
    }

    const parsed = new Date(
      `${value}T00:00:00.000Z`,
    );

    return (
      !Number.isNaN(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  };

  if (
    dateFrom !== undefined &&
    !isValidDate(dateFrom)
  ) {
    throw validationError(
      "The start date must be a valid ISO date.",
      "INVALID_START_DATE",
    );
  }

  if (
    dateTo !== undefined &&
    !isValidDate(dateTo)
  ) {
    throw validationError(
      "The end date must be a valid ISO date.",
      "INVALID_END_DATE",
    );
  }

  if (
    dateFrom !== undefined &&
    dateTo !== undefined &&
    dateFrom > dateTo
  ) {
    throw validationError(
      "The start date cannot be later than the end date.",
      "INVALID_DATE_RANGE",
    );
  }
}

function validatePagination(
  params: PaginationParams,
): void {
  if (
    params.page !== undefined &&
    (
      !Number.isSafeInteger(params.page) ||
      params.page < 1
    )
  ) {
    throw validationError(
      "Page must be a positive integer.",
      "INVALID_PAGE",
    );
  }

  if (
    params.page_size !== undefined &&
    (
      !Number.isSafeInteger(params.page_size) ||
      params.page_size < 1
    )
  ) {
    throw validationError(
      "Page size must be a positive integer.",
      "INVALID_PAGE_SIZE",
    );
  }
}

function paginationQuery(
  params: PaginationParams,
): QueryParameters {
  validatePagination(params);

  return {
    page: params.page,
    page_size: params.page_size,
    search: params.search,
    sort_by: params.sort_by,
    sort_direction: params.sort_direction,
  };
}

function reportQuery(
  params: ReportRequest,
): QueryParameters {
  validateDateRange(
    params.date_from,
    params.date_to,
  );

  return {
    ...paginationQuery(params),
    date_from: params.date_from,
    date_to: params.date_to,
    customer_id: params.customer_id,
    supplier_id: params.supplier_id,
    product_id: params.product_id,
    item_id: params.item_id,
    production_run_id:
      params.production_run_id,
    salesman_id: params.salesman_id,
    status: params.status,
  };
}

function validateGovernmentDocumentType(
  type: GovernmentDocumentType,
): void {
  if (
    type !== "e_invoice" &&
    type !== "e_waybill"
  ) {
    throw validationError(
      "The government document type is invalid.",
      "INVALID_DOCUMENT_TYPE",
    );
  }
}

function validateDashboardRole(
  role: UserRole,
): void {
  if (!DASHBOARD_ROLES.includes(role)) {
    throw validationError(
      "The dashboard role is invalid.",
      "INVALID_DASHBOARD_ROLE",
    );
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
    throw validationError(
      "The idempotency key is invalid.",
      "INVALID_IDEMPOTENCY_KEY",
    );
  }

  return normalized;
}

/* Report catalog and report data */

export async function getReportCatalog(
  options: ReportsApiRequestOptions = {},
): Promise<ReportCatalogResponse> {
  return apiClient.get<ReportCatalogResponse>(
    REPORTS_API_PATHS.REPORTS,
    options,
  );
}

export async function getReport(
  reportType: ReportType,
  params: ReportRequest = {},
  options: ReportsApiRequestOptions = {},
): Promise<ReportResult> {
  validateReportType(reportType);

  return apiClient.get<ReportResult>(
    resourcePath(
      REPORTS_API_PATHS.REPORTS,
      reportType,
      "Report type",
    ),
    {
      ...options,
      query: reportQuery(params),
    },
  );
}

export async function getSalesRegisterReport(
  params: ReportRequest = {},
  options: ReportsApiRequestOptions = {},
): Promise<ReportResult> {
  return getReport(
    REPORT_TYPES.SALES_REGISTER,
    params,
    options,
  );
}

export async function getGSTSummaryReport(
  params: ReportRequest = {},
  options: ReportsApiRequestOptions = {},
): Promise<ReportResult> {
  return getReport(
    REPORT_TYPES.GST_SUMMARY,
    params,
    options,
  );
}

export async function getPurchaseRegisterReport(
  params: ReportRequest = {},
  options: ReportsApiRequestOptions = {},
): Promise<ReportResult> {
  return getReport(
    REPORT_TYPES.PURCHASE_REGISTER,
    params,
    options,
  );
}

export async function getStockSummaryReport(
  params: ReportRequest = {},
  options: ReportsApiRequestOptions = {},
): Promise<ReportResult> {
  return getReport(
    REPORT_TYPES.STOCK_SUMMARY,
    params,
    options,
  );
}

export async function getStockLedgerReport(
  params: ReportRequest = {},
  options: ReportsApiRequestOptions = {},
): Promise<ReportResult> {
  return getReport(
    REPORT_TYPES.STOCK_LEDGER,
    params,
    options,
  );
}

export async function getProductionReport(
  params: ReportRequest = {},
  options: ReportsApiRequestOptions = {},
): Promise<ReportResult> {
  return getReport(
    REPORT_TYPES.PRODUCTION,
    params,
    options,
  );
}

export async function getPaymentsCollectionsReport(
  params: ReportRequest = {},
  options: ReportsApiRequestOptions = {},
): Promise<ReportResult> {
  return getReport(
    REPORT_TYPES.PAYMENTS_COLLECTIONS,
    params,
    options,
  );
}

export async function getOutstandingReport(
  params: ReportRequest = {},
  options: ReportsApiRequestOptions = {},
): Promise<ReportResult> {
  return getReport(
    REPORT_TYPES.OUTSTANDING,
    params,
    options,
  );
}

export async function getAuditReport(
  params: ReportRequest = {},
  options: ReportsApiRequestOptions = {},
): Promise<ReportResult> {
  return getReport(
    REPORT_TYPES.AUDIT,
    params,
    options,
  );
}

/* Report exports */

function extractFilename(
  contentDisposition: string | null,
  fallback: string,
): string {
  if (!contentDisposition) {
    return fallback;
  }

  const encodedMatch =
    /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(
      contentDisposition,
    );

  if (encodedMatch?.[1]) {
    try {
      const decoded = decodeURIComponent(
        encodedMatch[1].trim(),
      );

      const sanitized = sanitizeFilename(decoded);

      if (sanitized) {
        return sanitized;
      }
    } catch {
      return fallback;
    }
  }

  const plainMatch =
    /filename\s*=\s*(?:"([^"]+)"|([^;]+))/i.exec(
      contentDisposition,
    );

  const filename = sanitizeFilename(
    plainMatch?.[1] ?? plainMatch?.[2] ?? "",
  );

  return filename || fallback;
}

function sanitizeFilename(value: string): string {
  return Array.from(value.trim(), (character) => {
    const code = character.charCodeAt(0);
    return character === "/" || character === "\\" || code < 32 || code === 127
      ? "_"
      : character;
  }).join("").replace(/^\.+/, "").trim();
}

function extractErrorMessage(
  body: unknown,
  fallback: string,
): string {
  if (
    !body ||
    typeof body !== "object"
  ) {
    return fallback;
  }

  const record = body as Record<
    string,
    unknown
  >;

  if (typeof record.detail === "string") {
    return record.detail;
  }

  if (typeof record.message === "string") {
    return record.message;
  }

  return fallback;
}

async function fetchReportExport(
  path: string,
  query: QueryParameters,
  format: ReportExportFormat,
  fallbackFilename: string,
  options: ReportsApiRequestOptions,
): Promise<ReportExport> {
  const accessToken = getAccessToken();

  if (!accessToken) {
    throw new ApiError(
      "Authentication is required to export reports.",
      {
        status: 401,
        category: "authentication",
        code: "AUTHENTICATION_REQUIRED",
      },
    );
  }

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 30_000;

  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  ) {
    throw validationError(
      "Request timeout must be positive.",
      "INVALID_TIMEOUT",
    );
  }

  let timedOut = false;

  const onExternalAbort = (): void => {
    controller.abort();
  };

  if (options.signal?.aborted) {
    controller.abort();
  } else {
    options.signal?.addEventListener(
      "abort",
      onExternalAbort,
      { once: true },
    );
  }

  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(
      buildApiUrl(
        path,
        query,
        API_BASE_URL,
      ),
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept:
            format === "pdf"
              ? "application/pdf"
              : "text/csv",
        },
        cache: "no-store",
        credentials: "omit",
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      let errorBody: unknown = null;

      try {
        errorBody = await response.json();
      } catch {
        errorBody = null;
      }

      const category =
        response.status === 401
          ? "authentication"
          : response.status === 403
            ? "authorization"
            : response.status === 404
              ? "not_found"
              : response.status === 422
                ? "validation"
                : response.status === 409
                  ? "conflict"
                  : response.status === 429
                    ? "rate_limit"
                    : response.status >= 500
                      ? "server"
                      : "unknown";

      throw new ApiError(
        extractErrorMessage(
          errorBody,
          `Report export failed (HTTP ${response.status}).`,
        ),
        {
          status: response.status,
          category,
          details: errorBody,
          retryable:
            response.status === 429 ||
            response.status >= 500,
        },
      );
    }

    const contentType =
      response.headers.get("Content-Type") ??
      EXPORT_CONTENT_TYPES[format];

    const normalizedContentType =
      contentType.toLowerCase();

    const isExpectedType =
      format === "pdf"
        ? normalizedContentType.includes(
            "application/pdf",
          )
        : normalizedContentType.includes(
              "text/csv",
            ) ||
          normalizedContentType.includes(
            "application/csv",
          ) ||
          normalizedContentType.includes(
            "application/octet-stream",
          );

    if (!isExpectedType) {
      throw new ApiError(
        "The backend returned an unexpected report export format.",
        {
          category: "server",
          code: "INVALID_EXPORT_CONTENT_TYPE",
        },
      );
    }

    const blob = await response.blob();

    if (blob.size === 0) {
      throw new ApiError(
        "The backend returned an empty report export.",
        {
          category: "server",
          code: "EMPTY_REPORT_EXPORT",
        },
      );
    }

    if (format === "pdf") {
      const header = await blob
        .slice(0, 5)
        .text();

      if (header !== "%PDF-") {
        throw new ApiError(
          "The backend returned an invalid PDF document.",
          {
            category: "server",
            code: "INVALID_PDF_EXPORT",
          },
        );
      }
    }

    return {
      blob,
      filename: extractFilename(
        response.headers.get(
          "Content-Disposition",
        ),
        fallbackFilename,
      ),
      contentType,
      format,
    };
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }

    if (controller.signal.aborted) {
      if (timedOut) {
        throw new ApiError(
          "The report export request timed out.",
          {
            category: "timeout",
            code: "REQUEST_TIMEOUT",
            retryable: true,
          },
        );
      }

      throw error;
    }

    throw new ApiError(
      "Unable to connect to the backend to export the report.",
      {
        category: "network",
        code: "NETWORK_ERROR",
        details: error,
        retryable: true,
      },
    );
  } finally {
    clearTimeout(timeoutId);

    options.signal?.removeEventListener(
      "abort",
      onExternalAbort,
    );
  }
}

export async function exportReport(
  reportType: ReportType,
  format: ReportExportFormat,
  params: ReportFilters = {},
  options: ReportsApiRequestOptions = {},
): Promise<ReportExport> {
  validateReportType(reportType);

  if (
    format !== REPORT_EXPORT_FORMATS.CSV &&
    format !== REPORT_EXPORT_FORMATS.PDF
  ) {
    throw validationError(
      "The requested export format is invalid.",
      "INVALID_EXPORT_FORMAT",
    );
  }

  validateDateRange(
    params.date_from,
    params.date_to,
  );

  const query: QueryParameters = {
    ...params,
    format,
  };

  const suffix =
    params.date_from && params.date_to
      ? `_${params.date_from}_${params.date_to}`
      : "";

  const fallbackFilename =
    `${reportType}${suffix}.${EXPORT_EXTENSIONS[format]}`;

  return fetchReportExport(
    `${resourcePath(
      REPORTS_API_PATHS.REPORTS,
      reportType,
      "Report type",
    )}/export`,
    query,
    format,
    fallbackFilename,
    options,
  );
}

/* Role-specific dashboards */

export async function getDashboard(
  role: UserRole,
  params: DashboardFilters = {},
  options: ReportsApiRequestOptions = {},
): Promise<DashboardData> {
  validateDashboardRole(role);

  validateDateRange(
    params.date_from,
    params.date_to,
  );

  return apiClient.get<DashboardData>(
    resourcePath(
      REPORTS_API_PATHS.DASHBOARDS,
      role,
      "Dashboard role",
    ),
    {
      ...options,
      query: {
        date_from: params.date_from,
        date_to: params.date_to,
      },
    },
  );
}

export async function getSalesmanDashboard(
  params: DashboardFilters = {},
  options: ReportsApiRequestOptions = {},
): Promise<DashboardData> {
  return getDashboard(
    "salesman",
    params,
    options,
  );
}

export async function getAdminDashboard(
  params: DashboardFilters = {},
  options: ReportsApiRequestOptions = {},
): Promise<DashboardData> {
  return getDashboard(
    "factory_admin",
    params,
    options,
  );
}

export async function getProductionDashboard(
  params: DashboardFilters = {},
  options: ReportsApiRequestOptions = {},
): Promise<DashboardData> {
  return getDashboard(
    "production_supervisor",
    params,
    options,
  );
}

export async function getAccountantDashboard(
  params: DashboardFilters = {},
  options: ReportsApiRequestOptions = {},
): Promise<DashboardData> {
  return getDashboard(
    "accountant_auditor",
    params,
    options,
  );
}

export async function getOwnerDashboard(
  params: DashboardFilters = {},
  options: ReportsApiRequestOptions = {},
): Promise<DashboardData> {
  return getDashboard(
    "owner",
    params,
    options,
  );
}

/* Audit records */

export async function getAuditRecords(
  params: AuditRecordListParams = {},
  options: ReportsApiRequestOptions = {},
): Promise<PaginatedResponse<AuditRecord>> {
  validateDateRange(
    params.date_from,
    params.date_to,
  );

  return apiClient.get<
    PaginatedResponse<AuditRecord>
  >(
    REPORTS_API_PATHS.AUDIT_RECORDS,
    {
      ...options,
      query: {
        ...paginationQuery(params),
        user_id: params.user_id,
        entity_type: params.entity_type,
        entity_id: params.entity_id,
        action: params.action,
        date_from: params.date_from,
        date_to: params.date_to,
      },
    },
  );
}

export async function getAuditRecordById(
  auditRecordId: UUID,
  options: ReportsApiRequestOptions = {},
): Promise<AuditRecord> {
  return apiClient.get<AuditRecord>(
    resourcePath(
      REPORTS_API_PATHS.AUDIT_RECORDS,
      auditRecordId,
      "Audit record ID",
    ),
    options,
  );
}

/* Mock government documents */

export async function getGovernmentDocuments(
  params: GovernmentDocumentListParams = {},
  options: ReportsApiRequestOptions = {},
): Promise<PaginatedResponse<GovernmentDocument>> {
  validateDateRange(
    params.date_from,
    params.date_to,
  );

  if (params.document_type !== undefined) {
    validateGovernmentDocumentType(
      params.document_type,
    );
  }

  return apiClient.get<
    PaginatedResponse<GovernmentDocument>
  >(
    REPORTS_API_PATHS.GOVERNMENT_DOCUMENTS,
    {
      ...options,
      query: {
        ...paginationQuery(params),
        invoice_id: params.invoice_id,
        document_type:
          params.document_type,
        status: params.status,
        date_from: params.date_from,
        date_to: params.date_to,
      },
    },
  );
}

export async function getGovernmentDocumentById(
  documentId: UUID,
  options: ReportsApiRequestOptions = {},
): Promise<GovernmentDocument> {
  return apiClient.get<GovernmentDocument>(
    resourcePath(
      REPORTS_API_PATHS.GOVERNMENT_DOCUMENTS,
      documentId,
      "Government document ID",
    ),
    options,
  );
}

export async function generateMockGovernmentDocument(
  request: GenerateGovernmentDocumentRequest,
  idempotencyKey: string,
  options: ReportsApiRequestOptions = {},
): Promise<GovernmentDocument> {
  requireText(
    request.invoice_id,
    "Invoice ID",
  );

  validateGovernmentDocumentType(
    request.document_type,
  );

  return apiClient.post<GovernmentDocument>(
    REPORTS_API_PATHS.GOVERNMENT_DOCUMENTS,
    request,
    {
      ...options,
      idempotencyKey:
        validateIdempotencyKey(
          idempotencyKey,
        ),
    },
  );
}

export const reportsApi = {
  getReportCatalog,
  getReport,

  getSalesRegisterReport,
  getGSTSummaryReport,
  getPurchaseRegisterReport,
  getStockSummaryReport,
  getStockLedgerReport,
  getProductionReport,
  getPaymentsCollectionsReport,
  getOutstandingReport,
  getAuditReport,

  exportReport,

  getDashboard,
  getSalesmanDashboard,
  getAdminDashboard,
  getProductionDashboard,
  getAccountantDashboard,
  getOwnerDashboard,

  getAuditRecords,
  getAuditRecordById,

  getGovernmentDocuments,
  getGovernmentDocumentById,
  generateMockGovernmentDocument,
} as const;
