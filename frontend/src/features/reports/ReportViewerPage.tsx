import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";

import {
  AlertCircle,
  ArrowLeft,
  CalendarDays,
  Download,
  FileBarChart2,
  FileText,
  FilterX,
  Printer,
  RefreshCw,
  Search,
  ShieldCheck,
  WifiOff,
} from "lucide-react";

import {
  Link,
  useParams,
  useSearchParams,
} from "react-router-dom";

import { useAuth } from "../../hooks/useAuth";
import { useOnlineStatus } from "../../hooks/useOnlineStatus";

import {
  API_BASE_URL,
  apiClient,
  getAccessToken,
  getApiErrorMessage,
} from "../../services/api/client";

import type {
  PaginatedResponse,
  ReportCellValue,
  ReportColumn,
} from "../../types/business";

import { LoadingState } from "../../components/common/LoadingState";
import { ErrorState } from "../../components/common/ErrorState";

import {
  formatCurrency,
  formatDate,
  formatDateTime,
} from "../../utils/formatters";

const PAGE_SIZE = 25;

type ReportCategory =
  | "sales"
  | "purchasing"
  | "inventory"
  | "production"
  | "finance"
  | "taxation"
  | "audit";

type ExportFormat = "csv" | "pdf";

interface ReportDefinition {
  id: string;
  code: string;
  name: string;
  description: string;
  category: ReportCategory;
  is_available: boolean;
  supports_date_range: boolean;
  supports_export: boolean;
}

interface ReportSummaryMetric {
  key: string;
  label: string;
  value: string;
  unit?: string | null;
}

interface ReportRow {
  [key: string]: ReportCellValue;
}

interface ReportResult {
  report_id: string;
  report_name: string;
  generated_at: string;
  columns: ReportColumn[];
  rows: PaginatedResponse<ReportRow>;
  summary: ReportSummaryMetric[];
}

interface ReportFilters {
  page: number;
  search: string;
  dateFrom: string;
  dateTo: string;
}

const CATEGORY_LABELS: Record<
  ReportCategory,
  string
> = {
  sales: "Sales",
  purchasing: "Purchasing",
  inventory: "Inventory",
  production: "Production",
  finance: "Finance",
  taxation: "GST and Taxation",
  audit: "Audit",
};

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00Z`);

  return (
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
  );
}

function normalizeDateParameter(
  value: string | null,
): string {
  return value && isValidDate(value) ? value : "";
}

function isReportCategory(
  value: unknown,
): value is ReportCategory {
  return (
    value === "sales" ||
    value === "purchasing" ||
    value === "inventory" ||
    value === "production" ||
    value === "finance" ||
    value === "taxation" ||
    value === "audit"
  );
}

function validateReportDefinition(
  value: unknown,
): ReportDefinition {
  if (
    typeof value !== "object" ||
    value === null
  ) {
    throw new Error(
      "The backend returned an invalid report definition.",
    );
  }

  const record = value as Record<string, unknown>;

  if (
    typeof record.id !== "string" ||
    !record.id ||
    typeof record.code !== "string" ||
    typeof record.name !== "string" ||
    !record.name ||
    typeof record.description !== "string" ||
    !isReportCategory(record.category) ||
    typeof record.is_available !== "boolean" ||
    typeof record.supports_date_range !== "boolean" ||
    typeof record.supports_export !== "boolean"
  ) {
    throw new Error(
      "The backend returned an incomplete report definition.",
    );
  }

  return record as unknown as ReportDefinition;
}

function validateReportResult(
  value: unknown,
  expectedReportId: string,
): ReportResult {
  if (
    typeof value !== "object" ||
    value === null
  ) {
    throw new Error(
      "The backend returned an invalid report result.",
    );
  }

  const record = value as Record<string, unknown>;
  const rows = record.rows;

  if (
    record.report_id !== expectedReportId ||
    typeof record.report_name !== "string" ||
    typeof record.generated_at !== "string" ||
    !Array.isArray(record.columns) ||
    !Array.isArray(record.summary) ||
    typeof rows !== "object" ||
    rows === null
  ) {
    throw new Error(
      "The backend returned an incomplete report result.",
    );
  }

  const paginatedRows = rows as Record<string, unknown>;

  if (
    !Array.isArray(paginatedRows.items) ||
    typeof paginatedRows.total !== "number" ||
    typeof paginatedRows.page !== "number" ||
    typeof paginatedRows.page_size !== "number" ||
    paginatedRows.total < 0
  ) {
    throw new Error(
      "The backend returned an invalid report table.",
    );
  }

  for (const column of record.columns) {
    if (
      typeof column !== "object" ||
      column === null
    ) {
      throw new Error(
        "The report contains an invalid column definition.",
      );
    }

    const definition = column as Record<
      string,
      unknown
    >;

    if (
      typeof definition.key !== "string" ||
      typeof definition.label !== "string" ||
      ![
        "text",
        "number",
        "currency",
        "date",
        "datetime",
      ].includes(String(definition.data_type))
    ) {
      throw new Error(
        "The report contains an unsupported column definition.",
      );
    }
  }

  return record as unknown as ReportResult;
}

function formatReportCell(
  value: ReportCellValue | undefined,
  dataType: ReportColumn["data_type"],
): string {
  if (value === null || value === undefined) {
    return "—";
  }

  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }

  if (dataType === "currency") {
    return formatCurrency(String(value));
  }

  if (dataType === "date") {
    return formatDate(String(value));
  }

  if (dataType === "datetime") {
    return formatDateTime(String(value));
  }

  if (dataType === "number") {
    if (
      typeof value === "number" &&
      Number.isFinite(value)
    ) {
      return new Intl.NumberFormat("en-IN", {
        maximumFractionDigits: 6,
      }).format(value);
    }

    return String(value);
  }

  return String(value);
}

function isNumericColumn(
  column: ReportColumn,
): boolean {
  return (
    column.data_type === "number" ||
    column.data_type === "currency"
  );
}

function buildReportQuery(
  filters: ReportFilters,
  supportsDateRange: boolean,
): URLSearchParams {
  const parameters = new URLSearchParams();

  parameters.set("page", String(filters.page));
  parameters.set("page_size", String(PAGE_SIZE));

  if (filters.search) {
    parameters.set("search", filters.search);
  }

  if (supportsDateRange) {
    if (filters.dateFrom) {
      parameters.set("date_from", filters.dateFrom);
    }

    if (filters.dateTo) {
      parameters.set("date_to", filters.dateTo);
    }
  }

  return parameters;
}

function getSafeFilename(
  filename: string | null,
  reportCode: string,
  format: ExportFormat,
): string {
  const fallback = `${reportCode || "report"}.${format}`;

  if (!filename) {
    return fallback.replace(
      /[^a-zA-Z0-9._-]/g,
      "_",
    );
  }

  const sanitized = filename
    .split(/[\\/]/)
    .pop()
    ?.replace(/[^a-zA-Z0-9._-]/g, "_");

  if (!sanitized) {
    return fallback.replace(
      /[^a-zA-Z0-9._-]/g,
      "_",
    );
  }

  return sanitized.toLowerCase().endsWith(
    `.${format}`,
  )
    ? sanitized
    : `${sanitized}.${format}`;
}

function extractFilename(
  disposition: string | null,
): string | null {
  if (!disposition) {
    return null;
  }

  const encoded = disposition.match(
    /filename\*=UTF-8''([^;]+)/i,
  );

  if (encoded?.[1]) {
    try {
      return decodeURIComponent(
        encoded[1].trim(),
      );
    } catch {
      return null;
    }
  }

  const regular = disposition.match(
    /filename="?([^";]+)"?/i,
  );

  return regular?.[1]?.trim() ?? null;
}

async function fetchReportDefinition(
  reportId: string,
  signal?: AbortSignal,
): Promise<ReportDefinition> {
  const response = await apiClient.get<unknown>(
    `/reports/${encodeURIComponent(reportId)}`,
    { signal },
  );

  const definition = validateReportDefinition(
    response,
  );

  if (definition.id !== reportId) {
    throw new Error(
      "The backend returned a different report definition.",
    );
  }

  return definition;
}

async function fetchReportResult(
  reportId: string,
  filters: ReportFilters,
  supportsDateRange: boolean,
  signal?: AbortSignal,
): Promise<ReportResult> {
  const query = buildReportQuery(
    filters,
    supportsDateRange,
  );

  const response = await apiClient.get<unknown>(
    `/reports/${encodeURIComponent(reportId)}/data`,
    {
      query: Object.fromEntries(query.entries()),
      signal,
    },
  );

  return validateReportResult(
    response,
    reportId,
  );
}

async function exportReport(
  report: ReportDefinition,
  filters: ReportFilters,
  format: ExportFormat,
  signal?: AbortSignal,
): Promise<void> {
  const token = getAccessToken();

  if (!token) {
    throw new Error(
      "An authenticated session is required to export reports.",
    );
  }

  const query = buildReportQuery(
    filters,
    report.supports_date_range,
  );

  query.delete("page");
  query.delete("page_size");
  query.set("format", format);

  const url =
    `${API_BASE_URL}/reports/` +
    `${encodeURIComponent(report.id)}/export?` +
    query.toString();

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept:
        format === "csv"
          ? "text/csv"
          : "application/pdf",
    },
    credentials: "omit",
    cache: "no-store",
    signal,
  });

  if (!response.ok) {
    let message = `Report export failed (HTTP ${response.status}).`;

    try {
      const contentType =
        response.headers.get("content-type") ?? "";

      if (contentType.includes("application/json")) {
        const payload: unknown =
          await response.json();

        if (
          typeof payload === "object" &&
          payload !== null
        ) {
          const details = payload as Record<
            string,
            unknown
          >;

          if (typeof details.detail === "string") {
            message = details.detail;
          } else if (
            typeof details.message === "string"
          ) {
            message = details.message;
          }
        }
      }
    } catch {
      // Preserve the HTTP error if the response cannot be parsed.
    }

    throw new Error(message);
  }

  const contentType =
    response.headers.get("content-type") ?? "";

  const expectedContentType =
    format === "csv"
      ? ["text/csv", "application/csv"]
      : ["application/pdf"];

  if (
    !expectedContentType.some((type) =>
      contentType.toLowerCase().includes(type),
    )
  ) {
    throw new Error(
      "The backend returned an unexpected export format.",
    );
  }

  const blob = await response.blob();

  if (blob.size === 0) {
    throw new Error(
      "The backend returned an empty report export.",
    );
  }

  const filename = getSafeFilename(
    extractFilename(
      response.headers.get("content-disposition"),
    ),
    report.code,
    format,
  );

  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  try {
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.style.display = "none";

    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    window.setTimeout(
      () => URL.revokeObjectURL(objectUrl),
      60_000,
    );
  }
}

export function ReportViewerPage() {
  const { reportId } = useParams<{
    reportId: string;
  }>();

  const [searchParams, setSearchParams] =
    useSearchParams();

  const { user } = useAuth();
  const { isOnline } = useOnlineStatus();

  const canAccess =
    user !== null && user.is_active;

  const [definition, setDefinition] =
    useState<ReportDefinition | null>(null);

  const [definitionLoading, setDefinitionLoading] =
    useState(true);

  const [definitionError, setDefinitionError] =
    useState<string | null>(null);

  const [result, setResult] =
    useState<ReportResult | null>(null);

  const [resultLoading, setResultLoading] =
    useState(false);

  const [resultError, setResultError] =
    useState<string | null>(null);

  const [exporting, setExporting] =
    useState<ExportFormat | null>(null);

  const [exportError, setExportError] =
    useState<string | null>(null);

  const [searchInput, setSearchInput] = useState(
    searchParams.get("search") ?? "",
  );

  const [dateFromInput, setDateFromInput] =
    useState(
      normalizeDateParameter(
        searchParams.get("date_from"),
      ),
    );

  const [dateToInput, setDateToInput] =
    useState(
      normalizeDateParameter(
        searchParams.get("date_to"),
      ),
    );

  const [filterError, setFilterError] =
    useState<string | null>(null);

  const [refreshVersion, setRefreshVersion] =
    useState(0);

  const exportControllerRef =
    useRef<AbortController | null>(null);

  const pageParameter = Number(
    searchParams.get("page") ?? "1",
  );

  const page =
    Number.isSafeInteger(pageParameter) &&
    pageParameter > 0
      ? pageParameter
      : 1;

  const filters = useMemo<ReportFilters>(
    () => ({
      page,
      search:
        searchParams.get("search")?.trim() ?? "",
      dateFrom: normalizeDateParameter(
        searchParams.get("date_from"),
      ),
      dateTo: normalizeDateParameter(
        searchParams.get("date_to"),
      ),
    }),
    [page, searchParams],
  );

  const hasInvalidDateRange =
    Boolean(filters.dateFrom) &&
    Boolean(filters.dateTo) &&
    filters.dateFrom > filters.dateTo;

  useEffect(() => {
    setSearchInput(
      searchParams.get("search") ?? "",
    );

    setDateFromInput(
      normalizeDateParameter(
        searchParams.get("date_from"),
      ),
    );

    setDateToInput(
      normalizeDateParameter(
        searchParams.get("date_to"),
      ),
    );
  }, [searchParams]);

  const loadDefinition = useCallback(
    async (
      signal?: AbortSignal,
    ): Promise<void> => {
      if (!canAccess || !reportId) {
        setDefinition(null);
        setDefinitionLoading(false);
        return;
      }

      setDefinitionLoading(true);
      setDefinitionError(null);
      setDefinition(null);
      setResult(null);

      try {
        const response =
          await fetchReportDefinition(
            reportId,
            signal,
          );

        if (!signal?.aborted) {
          setDefinition(response);
        }
      } catch (failure) {
        if (!signal?.aborted) {
          setDefinitionError(
            getApiErrorMessage(failure),
          );
        }
      } finally {
        if (!signal?.aborted) {
          setDefinitionLoading(false);
        }
      }
    },
    [canAccess, reportId],
  );

  useEffect(() => {
    const controller = new AbortController();

    void loadDefinition(controller.signal);

    return () => controller.abort();
  }, [loadDefinition]);

  useEffect(() => {
    if (
      !canAccess ||
      !reportId ||
      !definition ||
      definition.id !== reportId ||
      !definition.is_available ||
      hasInvalidDateRange
    ) {
      setResult(null);
      setResultLoading(false);
      return;
    }

    const controller = new AbortController();

    setResultLoading(true);
    setResultError(null);
    setResult(null);

    void fetchReportResult(
      reportId,
      filters,
      definition.supports_date_range,
      controller.signal,
    )
      .then((response) => {
        if (!controller.signal.aborted) {
          setResult(response);
        }
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) {
          setResultError(
            getApiErrorMessage(failure),
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setResultLoading(false);
        }
      });

    return () => controller.abort();
  }, [
    canAccess,
    reportId,
    definition,
    filters,
    hasInvalidDateRange,
    refreshVersion,
  ]);

  useEffect(
    () => () => {
      exportControllerRef.current?.abort();
    },
    [],
  );

  const applyFilters = (
    event: FormEvent<HTMLFormElement>,
  ): void => {
    event.preventDefault();

    if (
      definition?.supports_date_range &&
      dateFromInput &&
      !isValidDate(dateFromInput)
    ) {
      setFilterError("Enter a valid start date.");
      return;
    }

    if (
      definition?.supports_date_range &&
      dateToInput &&
      !isValidDate(dateToInput)
    ) {
      setFilterError("Enter a valid end date.");
      return;
    }

    if (
      definition?.supports_date_range &&
      dateFromInput &&
      dateToInput &&
      dateFromInput > dateToInput
    ) {
      setFilterError(
        "The end date cannot precede the start date.",
      );
      return;
    }

    setFilterError(null);

    const next = new URLSearchParams();

    if (searchInput.trim()) {
      next.set("search", searchInput.trim());
    }

    if (definition?.supports_date_range) {
      if (dateFromInput) {
        next.set("date_from", dateFromInput);
      }

      if (dateToInput) {
        next.set("date_to", dateToInput);
      }
    }

    setSearchParams(next);
  };

  const clearFilters = (): void => {
    setSearchInput("");
    setDateFromInput("");
    setDateToInput("");
    setFilterError(null);
    setSearchParams(new URLSearchParams());
  };

  const changePage = (nextPage: number): void => {
    if (
      !Number.isSafeInteger(nextPage) ||
      nextPage < 1
    ) {
      return;
    }

    const next = new URLSearchParams(searchParams);

    if (nextPage === 1) {
      next.delete("page");
    } else {
      next.set("page", String(nextPage));
    }

    setSearchParams(next);
  };

  const refreshReport = (): void => {
    setExportError(null);
    setRefreshVersion((current) => current + 1);
  };

  const handleExport = async (
    format: ExportFormat,
  ): Promise<void> => {
    if (
      !definition ||
      !definition.is_available ||
      !definition.supports_export ||
      !canAccess ||
      !isOnline ||
      exporting !== null ||
      hasInvalidDateRange
    ) {
      return;
    }

    const controller = new AbortController();

    exportControllerRef.current = controller;
    setExporting(format);
    setExportError(null);

    try {
      await exportReport(
        definition,
        filters,
        format,
        controller.signal,
      );
    } catch (failure) {
      if (!controller.signal.aborted) {
        setExportError(
          getApiErrorMessage(failure),
        );
      }
    } finally {
      if (
        exportControllerRef.current === controller
      ) {
        exportControllerRef.current = null;
      }

      setExporting(null);
    }
  };

  const totalPages = result
    ? Math.max(
        1,
        Math.ceil(
          result.rows.total /
            Math.max(result.rows.page_size, 1),
        ),
      )
    : 1;

  const hasActiveFilters =
    Boolean(filters.search) ||
    Boolean(
      definition?.supports_date_range &&
        (filters.dateFrom || filters.dateTo),
    );

  if (!canAccess) {
    return (
      <div className="app-page space-y-5">
        <h2 className="app-page-title">
          Report Viewer
        </h2>

        <div
          role="alert"
          className="app-alert app-alert-error"
        >
          Report access requires an active,
          authenticated user account.
        </div>

        <Link
          to="/reports"
          className="app-button app-button-secondary"
        >
          Back to reports
        </Link>
      </div>
    );
  }

  if (!reportId) {
    return (
      <div className="app-page space-y-5">
        <h2 className="app-page-title">
          Report Viewer
        </h2>

        <div
          role="alert"
          className="app-alert app-alert-error"
        >
          A report identifier is required.
        </div>

        <Link
          to="/reports"
          className="app-button app-button-secondary"
        >
          Back to reports
        </Link>
      </div>
    );
  }

  return (
    <div className="app-page space-y-6">
      <header className="space-y-4">
        <Link
          to="/reports"
          className="inline-flex items-center gap-2 text-sm font-medium text-accent hover:underline"
        >
          <ArrowLeft
            size={17}
            aria-hidden="true"
          />
          Report catalog
        </Link>

        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <FileBarChart2
                size={28}
                className="shrink-0 text-primary"
                aria-hidden="true"
              />

              <h2 className="app-page-title">
                {definition?.name ?? "Report Viewer"}
              </h2>
            </div>

            {definition && (
              <>
                <p className="app-page-description">
                  {definition.description}
                </p>

                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-text-muted">
                  <span className="rounded-control bg-background px-2.5 py-1">
                    {CATEGORY_LABELS[
                      definition.category
                    ]}
                  </span>

                  <span className="rounded-control bg-background px-2.5 py-1">
                    {definition.code}
                  </span>
                </div>
              </>
            )}
          </div>

          {definition?.is_available && (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={refreshReport}
                disabled={
                  resultLoading ||
                  definitionLoading ||
                  !isOnline
                }
                className="app-button app-button-secondary inline-flex items-center gap-2"
              >
                <RefreshCw
                  size={17}
                  className={
                    resultLoading
                      ? "motion-safe:animate-spin"
                      : ""
                  }
                  aria-hidden="true"
                />
                Refresh
              </button>

              <button
                type="button"
                onClick={() => window.print()}
                disabled={
                  !result ||
                  resultLoading ||
                  Boolean(resultError)
                }
                className="app-button app-button-secondary inline-flex items-center gap-2"
                title="Print the currently displayed report page"
              >
                <Printer
                  size={17}
                  aria-hidden="true"
                />
                Print page
              </button>

              {definition.supports_export && (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      void handleExport("csv");
                    }}
                    disabled={
                      !isOnline ||
                      exporting !== null ||
                      resultLoading ||
                      hasInvalidDateRange
                    }
                    className="app-button app-button-secondary inline-flex items-center gap-2"
                  >
                    <Download
                      size={17}
                      aria-hidden="true"
                    />
                    {exporting === "csv"
                      ? "Exporting..."
                      : "Export CSV"}
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      void handleExport("pdf");
                    }}
                    disabled={
                      !isOnline ||
                      exporting !== null ||
                      resultLoading ||
                      hasInvalidDateRange
                    }
                    className="app-button app-button-primary inline-flex items-center gap-2"
                  >
                    <Download
                      size={17}
                      aria-hidden="true"
                    />
                    {exporting === "pdf"
                      ? "Exporting..."
                      : "Export PDF"}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </header>

      {!isOnline && (
        <div
          role="status"
          className="app-alert app-alert-warning flex items-start gap-3"
        >
          <WifiOff
            size={20}
            className="shrink-0"
            aria-hidden="true"
          />

          <p>
            The device is offline. Report data and
            exports require a backend connection.
            Previously displayed figures may no longer
            reflect current business transactions.
          </p>
        </div>
      )}

      {definitionLoading ? (
        <LoadingState
          variant="section"
          message="Loading report definition..."
        />
      ) : definitionError ? (
        <ErrorState
          title="Unable to load report"
          message={definitionError}
          onRetry={() => {
            void loadDefinition();
          }}
        />
      ) : !definition ? (
        <div
          role="alert"
          className="app-alert app-alert-error"
        >
          The requested report could not be found.
        </div>
      ) : !definition.is_available ? (
        <div className="rounded-card border border-border bg-surface px-6 py-12 text-center">
          <FileText
            size={36}
            className="mx-auto text-text-muted"
            aria-hidden="true"
          />

          <h3 className="mt-4 text-base font-semibold text-text-primary">
            Report unavailable
          </h3>

          <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-text-muted">
            The backend has marked this report as
            unavailable. Report availability and
            authorization are controlled by the server.
          </p>

          <Link
            to="/reports"
            className="app-button app-button-secondary mt-5 inline-flex"
          >
            Return to report catalog
          </Link>
        </div>
      ) : (
        <>
          <section className="app-card space-y-5">
            <div>
              <h3 className="text-base font-semibold text-text-primary">
                Report filters
              </h3>

              <p className="mt-1 text-sm text-text-muted">
                Apply filters to retrieve a new
                backend-generated report result.
              </p>
            </div>

            <form
              onSubmit={applyFilters}
              className="space-y-4"
            >
              {(filterError ||
                hasInvalidDateRange) && (
                <div
                  role="alert"
                  className="app-alert app-alert-error"
                >
                  {filterError ??
                    "The end date cannot precede the start date."}
                </div>
              )}

              <div
                className={`grid gap-4 ${
                  definition.supports_date_range
                    ? "md:grid-cols-3"
                    : "md:grid-cols-1"
                }`}
              >
                <div>
                  <label
                    htmlFor="report-viewer-search"
                    className="app-field-label mb-2 block"
                  >
                    Search report rows
                  </label>

                  <div className="relative">
                    <Search
                      size={17}
                      className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
                      aria-hidden="true"
                    />

                    <input
                      id="report-viewer-search"
                      type="search"
                      value={searchInput}
                      onChange={(event) =>
                        setSearchInput(
                          event.target.value,
                        )
                      }
                      placeholder="Search report data..."
                      className="app-input w-full pl-10"
                    />
                  </div>
                </div>

                {definition.supports_date_range && (
                  <>
                    <div>
                      <label
                        htmlFor="report-viewer-date-from"
                        className="app-field-label mb-2 block"
                      >
                        Date from
                      </label>

                      <input
                        id="report-viewer-date-from"
                        type="date"
                        value={dateFromInput}
                        onChange={(event) =>
                          setDateFromInput(
                            event.target.value,
                          )
                        }
                        className="app-input w-full"
                      />
                    </div>

                    <div>
                      <label
                        htmlFor="report-viewer-date-to"
                        className="app-field-label mb-2 block"
                      >
                        Date to
                      </label>

                      <input
                        id="report-viewer-date-to"
                        type="date"
                        value={dateToInput}
                        onChange={(event) =>
                          setDateToInput(
                            event.target.value,
                          )
                        }
                        className="app-input w-full"
                      />
                    </div>
                  </>
                )}
              </div>

              <div className="flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  onClick={clearFilters}
                  className="app-button app-button-secondary inline-flex items-center gap-2"
                >
                  <FilterX
                    size={16}
                    aria-hidden="true"
                  />
                  Clear filters
                </button>

                <button
                  type="submit"
                  className="app-button app-button-primary"
                >
                  Apply filters
                </button>
              </div>
            </form>
          </section>

          {exportError && (
            <div
              role="alert"
              className="app-alert app-alert-error flex items-start gap-3"
            >
              <AlertCircle
                size={19}
                className="shrink-0"
                aria-hidden="true"
              />

              <div>
                <p className="font-medium">
                  Report export failed
                </p>

                <p className="mt-1 text-sm">
                  {exportError}
                </p>
              </div>
            </div>
          )}

          {resultLoading ? (
            <LoadingState
              variant="section"
              message="Generating report..."
            />
          ) : resultError ? (
            <ErrorState
              title="Unable to generate report"
              message={resultError}
              onRetry={refreshReport}
            />
          ) : result ? (
            <>
              <section className="rounded-card border border-border bg-surface p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-start gap-3">
                    <CalendarDays
                      size={20}
                      className="mt-0.5 shrink-0 text-primary"
                      aria-hidden="true"
                    />

                    <div>
                      <h3 className="text-sm font-semibold text-text-primary">
                        {result.report_name}
                      </h3>

                      <p className="mt-1 text-xs text-text-muted">
                        Generated:{" "}
                        {formatDateTime(
                          result.generated_at,
                        )}
                      </p>
                    </div>
                  </div>

                  <p className="text-sm text-text-muted">
                    {result.rows.total}{" "}
                    {result.rows.total === 1
                      ? "record"
                      : "records"}
                  </p>
                </div>
              </section>

              {result.summary.length > 0 && (
                <section
                  aria-labelledby="report-summary-heading"
                  className="space-y-3"
                >
                  <h3
                    id="report-summary-heading"
                    className="text-base font-semibold text-text-primary"
                  >
                    Report summary
                  </h3>

                  <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                    {result.summary.map((metric) => (
                      <div
                        key={metric.key}
                        className="rounded-card border border-border bg-surface p-5 shadow-card"
                      >
                        <p className="text-sm font-medium text-text-muted">
                          {metric.label}
                        </p>

                        <p className="app-numeric mt-3 break-words text-xl font-bold text-text-primary">
                          {metric.value}
                          {metric.unit
                            ? ` ${metric.unit}`
                            : ""}
                        </p>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              <section className="app-card space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="text-base font-semibold text-text-primary">
                      Report data
                    </h3>

                    <p className="mt-1 text-sm text-text-muted">
                      Values are returned by the
                      backend report service.
                    </p>
                  </div>

                  <span className="rounded-full border border-border bg-background px-3 py-1 text-xs font-medium text-text-muted">
                    Page {result.rows.page} of{" "}
                    {totalPages}
                  </span>
                </div>

                <div className="app-table-container overflow-x-auto">
                  <table className="app-table w-full">
                    <caption className="app-sr-only">
                      {result.report_name} report
                      data
                    </caption>

                    <thead>
                      <tr>
                        {result.columns.map((column) => (
                          <th
                            key={column.key}
                            scope="col"
                            className={
                              isNumericColumn(column)
                                ? "text-right"
                                : "text-left"
                            }
                          >
                            {column.label}
                          </th>
                        ))}
                      </tr>
                    </thead>

                    <tbody>
                      {result.rows.items.map(
                        (row, index) => (
                          <tr
                            key={`report-row-${result.rows.page}-${index}`}
                          >
                            {result.columns.map(
                              (column) => (
                                <td
                                  key={column.key}
                                  className={
                                    isNumericColumn(
                                      column,
                                    )
                                      ? "app-numeric text-right"
                                      : "text-left"
                                  }
                                >
                                  {formatReportCell(
                                    row[column.key],
                                    column.data_type,
                                  )}
                                </td>
                              ),
                            )}
                          </tr>
                        ),
                      )}

                      {result.rows.items.length ===
                        0 && (
                        <tr>
                          <td
                            colSpan={Math.max(
                              result.columns.length,
                              1,
                            )}
                            className="py-10 text-center text-sm text-text-muted"
                          >
                            No records match the
                            selected report filters.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                {result.rows.total > 0 && (
                  <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
                    <p className="text-sm text-text-muted">
                      Showing{" "}
                      {(result.rows.page - 1) *
                        result.rows.page_size +
                        1}
                      –
                      {Math.min(
                        result.rows.page *
                          result.rows.page_size,
                        result.rows.total,
                      )}{" "}
                      of {result.rows.total}
                    </p>

                    <nav
                      aria-label="Report pagination"
                      className="flex items-center gap-2"
                    >
                      <button
                        type="button"
                        onClick={() =>
                          changePage(page - 1)
                        }
                        disabled={page <= 1}
                        className="app-button app-button-secondary"
                      >
                        Previous
                      </button>

                      <span className="px-2 text-sm text-text-muted">
                        {page} / {totalPages}
                      </span>

                      <button
                        type="button"
                        onClick={() =>
                          changePage(page + 1)
                        }
                        disabled={
                          page >= totalPages
                        }
                        className="app-button app-button-secondary"
                      >
                        Next
                      </button>
                    </nav>
                  </div>
                )}

                {hasActiveFilters && (
                  <p className="border-t border-border pt-3 text-xs text-text-muted">
                    Report results reflect the
                    selected filters. Summary metrics
                    and exports are generated by the
                    backend according to the same
                    report definition.
                  </p>
                )}
              </section>
            </>
          ) : hasInvalidDateRange ? null : (
            <div className="rounded-card border border-border bg-surface px-6 py-10 text-center">
              <FileText
                size={34}
                className="mx-auto text-text-muted"
                aria-hidden="true"
              />

              <p className="mt-3 text-sm text-text-muted">
                No report result is available.
              </p>
            </div>
          )}
        </>
      )}

      <footer className="rounded-card border border-border bg-surface p-4">
        <div className="flex items-start gap-3">
          <ShieldCheck
            size={21}
            className="mt-0.5 shrink-0 text-primary"
            aria-hidden="true"
          />

          <div>
            <h3 className="text-sm font-semibold text-text-primary">
              Report integrity
            </h3>

            <p className="mt-1 text-xs leading-5 text-text-muted">
              Report calculations, GST figures,
              inventory valuation, production costs,
              receivables, and access permissions
              remain authoritative on the backend.
              Exports are retrieved through an
              authenticated request. Printed output
              contains only the currently displayed
              report page, while backend exports may
              include all records matching the
              selected filters.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}

export default ReportViewerPage;