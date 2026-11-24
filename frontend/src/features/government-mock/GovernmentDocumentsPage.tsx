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
  CheckCircle2,
  ExternalLink,
  FileCheck2,
  FileText,
  FilterX,
  Info,
  RefreshCw,
  Search,
  ShieldCheck,
  WifiOff,
  X,
} from "lucide-react";

import { Link } from "react-router-dom";

import { USER_ROLES } from "../../types/auth";

import type {
  GovernmentDocumentStatus,
  GovernmentDocumentType,
  PaginatedResponse,
  UUID,
} from "../../types/business";

import { useAuth } from "../../hooks/useAuth";
import { useOnlineStatus } from "../../hooks/useOnlineStatus";

import {
  apiClient,
  getApiErrorMessage,
} from "../../services/api/client";

import {
  DataTable,
  type DataTableColumn,
} from "../../components/tables/DataTable";

import { LoadingState } from "../../components/common/LoadingState";
import { StatusBadge } from "../../components/common/StatusBadge";
import { ConfirmDialog } from "../../components/common/ConfirmDialog";

import {
  formatCurrency,
  formatDate,
  formatDateTime,
} from "../../utils/formatters";

const PAGE_SIZE = 20;

type DocumentTypeFilter = "all" | GovernmentDocumentType;

type DocumentStatusFilter =
  | "all"
  | GovernmentDocumentStatus;

interface GovernmentDocument {
  id: UUID;
  document_type: GovernmentDocumentType;
  document_number: string | null;
  invoice_id: UUID;
  invoice_number: string;
  customer_id: UUID;
  customer_name: string;
  invoice_date: string;
  invoice_total: string;
  status: GovernmentDocumentStatus;
  generated_at: string | null;
  cancelled_at: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string | null;
  generated_by: UUID | null;
  is_mock: boolean;
}

interface GovernmentDocumentDetails extends GovernmentDocument {
  mock_reference_number: string | null;
  remarks: string | null;
  payload: Record<string, unknown> | null;
  response_data: Record<string, unknown> | null;
}

interface EligibleInvoice {
  id: UUID;
  invoice_number: string;
  invoice_date: string;
  customer_id: UUID;
  customer_name: string;
  status: string;
  tax_summary: {
    total_amount: string;
  };
}

interface DocumentFilters {
  page: number;
  search: string;
  documentType: DocumentTypeFilter;
  status: DocumentStatusFilter;
  dateFrom: string;
  dateTo: string;
}

const DOCUMENT_TYPES: ReadonlyArray<{
  value: GovernmentDocumentType;
  label: string;
}> = [
  {
    value: "e_invoice",
    label: "Mock e-Invoice",
  },
  {
    value: "e_waybill",
    label: "Mock e-Way Bill",
  },
];

const DOCUMENT_STATUSES: ReadonlyArray<{
  value: DocumentStatusFilter;
  label: string;
}> = [
  { value: "all", label: "All statuses" },
  { value: "not_generated", label: "Not generated" },
  { value: "generated", label: "Generated" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
];

function documentTypeLabel(
  type: GovernmentDocumentType,
): string {
  return (
    DOCUMENT_TYPES.find(
      (option) => option.value === type,
    )?.label ?? type
  );
}

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

function isGovernmentDocumentType(
  value: string,
): value is GovernmentDocumentType {
  return (
    value === "e_invoice" ||
    value === "e_waybill"
  );
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "Unable to display document data.";
  }
}

async function fetchDocuments(
  filters: DocumentFilters,
  signal?: AbortSignal,
): Promise<PaginatedResponse<GovernmentDocument>> {
  return apiClient.get<
    PaginatedResponse<GovernmentDocument>
  >("/government-documents", {
    query: {
      page: filters.page,
      page_size: PAGE_SIZE,
      search: filters.search || undefined,
      document_type:
        filters.documentType === "all"
          ? undefined
          : filters.documentType,
      status:
        filters.status === "all"
          ? undefined
          : filters.status,
      date_from: filters.dateFrom || undefined,
      date_to: filters.dateTo || undefined,
    },
    signal,
  });
}

async function fetchDocumentDetails(
  documentId: UUID,
  signal?: AbortSignal,
): Promise<GovernmentDocumentDetails> {
  return apiClient.get<GovernmentDocumentDetails>(
    `/government-documents/${encodeURIComponent(documentId)}`,
    { signal },
  );
}

async function fetchEligibleInvoices(
  signal?: AbortSignal,
): Promise<EligibleInvoice[]> {
  const invoices: EligibleInvoice[] = [];
  const pageSize = 100;

  let page = 1;
  let total = 0;

  do {
    const response = await apiClient.get<
      PaginatedResponse<EligibleInvoice>
    >("/invoices", {
      query: {
        page,
        page_size: pageSize,
        status: "posted",
      },
      signal,
    });

    invoices.push(...response.items);
    total = response.total;

    if (response.items.length === 0) {
      break;
    }

    page += 1;
  } while (invoices.length < total);

  return invoices.filter(
    (invoice) => invoice.status === "posted",
  );
}

async function generateMockDocument(
  invoiceId: UUID,
  documentType: GovernmentDocumentType,
  idempotencyKey: string,
): Promise<GovernmentDocument> {
  return apiClient.post<GovernmentDocument>(
    "/government-documents/generate",
    {
      invoice_id: invoiceId,
      document_type: documentType,
    },
    { idempotencyKey },
  );
}

async function cancelMockDocument(
  documentId: UUID,
  reason: string,
  idempotencyKey: string,
): Promise<GovernmentDocument> {
  return apiClient.post<GovernmentDocument>(
    `/government-documents/${encodeURIComponent(documentId)}/cancel`,
    { reason },
    { idempotencyKey },
  );
}

export function GovernmentDocumentsPage() {
  const { user } = useAuth();
  const { isOnline } = useOnlineStatus();

  const canAccess =
    user?.role === USER_ROLES.FACTORY_ADMIN ||
    user?.role === USER_ROLES.ACCOUNTANT_AUDITOR ||
    user?.role === USER_ROLES.OWNER;

  const canManage =
    user?.role === USER_ROLES.FACTORY_ADMIN;

  const [documents, setDocuments] =
    useState<GovernmentDocument[]>([]);

  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  const [typeFilter, setTypeFilter] =
    useState<DocumentTypeFilter>("all");

  const [statusFilter, setStatusFilter] =
    useState<DocumentStatusFilter>("all");

  const [dateFromInput, setDateFromInput] =
    useState("");

  const [dateToInput, setDateToInput] =
    useState("");

  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const [filterError, setFilterError] =
    useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [success, setSuccess] =
    useState<string | null>(null);

  const [generateOpen, setGenerateOpen] =
    useState(false);

  const [eligibleInvoices, setEligibleInvoices] =
    useState<EligibleInvoice[]>([]);

  const [invoicesLoading, setInvoicesLoading] =
    useState(false);

  const [invoicesError, setInvoicesError] =
    useState<string | null>(null);

  const [selectedInvoiceId, setSelectedInvoiceId] =
    useState("");

  const [selectedDocumentType, setSelectedDocumentType] =
    useState<GovernmentDocumentType>("e_invoice");

  const [generateError, setGenerateError] =
    useState<string | null>(null);

  const [generating, setGenerating] = useState(false);

  const [detailsTarget, setDetailsTarget] =
    useState<GovernmentDocumentDetails | null>(null);

  const [detailsLoading, setDetailsLoading] =
    useState(false);

  const [detailsError, setDetailsError] =
    useState<string | null>(null);

  const [cancelTarget, setCancelTarget] =
    useState<GovernmentDocument | null>(null);

  const [cancelReason, setCancelReason] =
    useState("");

  const [cancelError, setCancelError] =
    useState<string | null>(null);

  const [cancelling, setCancelling] = useState(false);

  const generateKeyRef = useRef<string | null>(null);
  const cancelKeyRef = useRef<string | null>(null);
  const mutationLockRef = useRef(false);

  const filters = useMemo<DocumentFilters>(
    () => ({
      page,
      search,
      documentType: typeFilter,
      status: statusFilter,
      dateFrom,
      dateTo,
    }),
    [
      page,
      search,
      typeFilter,
      statusFilter,
      dateFrom,
      dateTo,
    ],
  );

  const selectedInvoice = useMemo(
    () =>
      eligibleInvoices.find(
        (invoice) => invoice.id === selectedInvoiceId,
      ) ?? null,
    [eligibleInvoices, selectedInvoiceId],
  );

  const loadDocuments = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      if (!canAccess) {
        setDocuments([]);
        setTotal(0);
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const response = await fetchDocuments(
          filters,
          signal,
        );

        if (!signal?.aborted) {
          setDocuments(response.items);
          setTotal(response.total);
        }
      } catch (failure) {
        if (!signal?.aborted) {
          setError(getApiErrorMessage(failure));
          setDocuments([]);
          setTotal(0);
        }
      } finally {
        if (!signal?.aborted) {
          setLoading(false);
        }
      }
    },
    [canAccess, filters],
  );

  useEffect(() => {
    const controller = new AbortController();

    void loadDocuments(controller.signal);

    return () => controller.abort();
  }, [loadDocuments]);

  useEffect(() => {
    if (!generateOpen || !canManage || !isOnline) {
      return;
    }

    const controller = new AbortController();

    setInvoicesLoading(true);
    setInvoicesError(null);

    void fetchEligibleInvoices(controller.signal)
      .then((response) => {
        if (!controller.signal.aborted) {
          setEligibleInvoices(response);
        }
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) {
          setInvoicesError(
            getApiErrorMessage(failure),
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setInvoicesLoading(false);
        }
      });

    return () => controller.abort();
  }, [generateOpen, canManage, isOnline]);

  const openGenerate = (): void => {
    if (
      !canManage ||
      !isOnline ||
      generating ||
      cancelling
    ) {
      return;
    }

    setSelectedInvoiceId("");
    setSelectedDocumentType("e_invoice");
    setEligibleInvoices([]);
    setGenerateError(null);
    setInvoicesError(null);
    setSuccess(null);

    generateKeyRef.current = null;
    setGenerateOpen(true);
  };

  const closeGenerate = (): void => {
    if (generating) {
      return;
    }

    setGenerateOpen(false);
    setGenerateError(null);
    generateKeyRef.current = null;
  };

  const submitGenerate = async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();

    if (
      !canManage ||
      !isOnline ||
      generating ||
      mutationLockRef.current
    ) {
      return;
    }

    if (!selectedInvoice) {
      setGenerateError(
        "Select an eligible posted invoice.",
      );
      return;
    }

    if (
      !isGovernmentDocumentType(
        selectedDocumentType,
      )
    ) {
      setGenerateError(
        "Select a valid mock document type.",
      );
      return;
    }

    const idempotencyKey =
      generateKeyRef.current ?? crypto.randomUUID();

    generateKeyRef.current = idempotencyKey;
    mutationLockRef.current = true;

    setGenerating(true);
    setGenerateError(null);
    setSuccess(null);

    try {
      const result = await generateMockDocument(
        selectedInvoice.id,
        selectedDocumentType,
        idempotencyKey,
      );

      if (
        !result.id ||
        result.invoice_id !== selectedInvoice.id ||
        result.document_type !== selectedDocumentType ||
        result.is_mock !== true
      ) {
        throw new Error(
          "The backend response did not confirm the requested mock document. Refresh the register before retrying.",
        );
      }

      setGenerateOpen(false);
      generateKeyRef.current = null;

      setSuccess(
        `${documentTypeLabel(result.document_type)} request recorded with status "${result.status}". This is a simulated document and is not a government-issued registration.`,
      );

      setPage(1);
      await loadDocuments();
    } catch (failure) {
      setGenerateError(
        getApiErrorMessage(failure),
      );
    } finally {
      mutationLockRef.current = false;
      setGenerating(false);
    }
  };

  const openDetails = async (
    document: GovernmentDocument,
  ): Promise<void> => {
    setDetailsTarget({
      ...document,
      mock_reference_number: null,
      remarks: null,
      payload: null,
      response_data: null,
    });

    setDetailsLoading(true);
    setDetailsError(null);

    try {
      const result = await fetchDocumentDetails(
        document.id,
      );

      if (result.id !== document.id) {
        throw new Error(
          "The backend returned a different document.",
        );
      }

      setDetailsTarget(result);
    } catch (failure) {
      setDetailsError(
        getApiErrorMessage(failure),
      );
    } finally {
      setDetailsLoading(false);
    }
  };

  const openCancel = (
    document: GovernmentDocument,
  ): void => {
    if (
      !canManage ||
      !isOnline ||
      document.status !== "generated" ||
      !document.is_mock ||
      generating ||
      cancelling
    ) {
      return;
    }

    setCancelTarget(document);
    setCancelReason("");
    setCancelError(null);
    setSuccess(null);
    cancelKeyRef.current = null;
  };

  const closeCancel = (): void => {
    if (cancelling) {
      return;
    }

    setCancelTarget(null);
    setCancelReason("");
    setCancelError(null);
    cancelKeyRef.current = null;
  };

  const submitCancel = async (): Promise<void> => {
    if (
      !cancelTarget ||
      !canManage ||
      !isOnline ||
      cancelling ||
      mutationLockRef.current
    ) {
      return;
    }

    const reason = cancelReason.trim();

    if (reason.length < 5) {
      setCancelError(
        "Enter a cancellation reason of at least five characters.",
      );
      return;
    }

    if (reason.length > 500) {
      setCancelError(
        "Cancellation reason cannot exceed 500 characters.",
      );
      return;
    }

    const idempotencyKey =
      cancelKeyRef.current ?? crypto.randomUUID();

    cancelKeyRef.current = idempotencyKey;
    mutationLockRef.current = true;

    setCancelling(true);
    setCancelError(null);
    setSuccess(null);

    try {
      const result = await cancelMockDocument(
        cancelTarget.id,
        reason,
        idempotencyKey,
      );

      if (
        result.id !== cancelTarget.id ||
        result.status !== "cancelled" ||
        result.is_mock !== true
      ) {
        throw new Error(
          "The backend did not confirm mock document cancellation. Refresh the register before retrying.",
        );
      }

      setSuccess(
        `${documentTypeLabel(result.document_type)} ${result.document_number ?? result.id} was cancelled in the mock document register.`,
      );

      setCancelTarget(null);
      setCancelReason("");
      cancelKeyRef.current = null;

      await loadDocuments();
    } catch (failure) {
      setCancelError(
        getApiErrorMessage(failure),
      );
    } finally {
      mutationLockRef.current = false;
      setCancelling(false);
    }
  };

  const applyFilters = (
    event: FormEvent<HTMLFormElement>,
  ): void => {
    event.preventDefault();

    if (
      dateFromInput &&
      !isValidDate(dateFromInput)
    ) {
      setFilterError("Enter a valid start date.");
      return;
    }

    if (
      dateToInput &&
      !isValidDate(dateToInput)
    ) {
      setFilterError("Enter a valid end date.");
      return;
    }

    if (
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
    setPage(1);
    setSearch(searchInput.trim());
    setDateFrom(dateFromInput);
    setDateTo(dateToInput);
  };

  const clearFilters = (): void => {
    setSearchInput("");
    setSearch("");
    setTypeFilter("all");
    setStatusFilter("all");
    setDateFromInput("");
    setDateToInput("");
    setDateFrom("");
    setDateTo("");
    setFilterError(null);
    setPage(1);
  };

  const columns = useMemo<
    DataTableColumn<GovernmentDocument>[]
  >(
    () => [
      {
        key: "document",
        header: "Mock document",
        render: (document) => (
          <div>
            <p className="font-semibold text-text-primary">
              {document.document_number ??
                "Not assigned"}
            </p>

            <p className="mt-1 text-xs text-text-muted">
              {documentTypeLabel(
                document.document_type,
              )}
            </p>

            <span className="mt-2 inline-flex rounded-full bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning">
              Simulation only
            </span>
          </div>
        ),
      },
      {
        key: "invoice",
        header: "Invoice",
        render: (document) => (
          <div>
            <Link
              to={`/invoices/${encodeURIComponent(document.invoice_id)}`}
              className="font-medium text-accent hover:underline"
            >
              {document.invoice_number}
            </Link>

            <p className="mt-1 text-xs text-text-muted">
              {formatDate(document.invoice_date)}
            </p>
          </div>
        ),
      },
      {
        key: "customer",
        header: "Customer",
        render: (document) => (
          <span className="font-medium text-text-primary">
            {document.customer_name}
          </span>
        ),
      },
      {
        key: "amount",
        header: "Invoice total",
        numeric: true,
        render: (document) => (
          <span className="app-numeric">
            {formatCurrency(
              document.invoice_total,
            )}
          </span>
        ),
      },
      {
        key: "status",
        header: "Status",
        render: (document) => (
          <StatusBadge
            status={document.status}
            category="government"
            showDot
          />
        ),
      },
      {
        key: "generated_at",
        header: "Generated",
        render: (document) =>
          document.generated_at
            ? formatDateTime(
                document.generated_at,
              )
            : "Not generated",
      },
      {
        key: "actions",
        header: "Actions",
        align: "right",
        render: (document) => (
          <div className="flex flex-wrap justify-end gap-3">
            <button
              type="button"
              onClick={() => {
                void openDetails(document);
              }}
              className="text-sm font-medium text-accent hover:underline"
            >
              Details
            </button>

            {canManage &&
              document.status === "generated" &&
              document.is_mock && (
                <button
                  type="button"
                  onClick={() =>
                    openCancel(document)
                  }
                  disabled={
                    !isOnline ||
                    generating ||
                    cancelling
                  }
                  className="text-sm font-medium text-error hover:underline disabled:opacity-50"
                >
                  Cancel
                </button>
              )}
          </div>
        ),
      },
    ],
    [canManage, isOnline, generating, cancelling],
  );

  if (!canAccess) {
    return (
      <div className="app-page space-y-5">
        <h2 className="app-page-title">
          Government Documents (Mock)
        </h2>

        <div
          role="alert"
          className="app-alert app-alert-error"
        >
          Mock government document access is restricted
          to authorized Factory Admin, Accountant/Auditor,
          and Owner roles.
        </div>

        <Link
          to="/dashboard"
          className="app-button app-button-secondary"
        >
          Back to dashboard
        </Link>
      </div>
    );
  }

  return (
    <div className="app-page space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <FileCheck2
              size={28}
              className="shrink-0 text-primary"
              aria-hidden="true"
            />

            <h2 className="app-page-title">
              Government Documents (Mock)
            </h2>
          </div>

          <p className="app-page-description">
            Simulate e-Invoice and e-Way Bill document
            generation for posted GST invoices.
            No government portal integration is performed.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              void loadDocuments();
            }}
            disabled={loading || generating || cancelling}
            className="app-button app-button-secondary inline-flex items-center gap-2"
          >
            <RefreshCw
              size={17}
              className={
                loading
                  ? "motion-safe:animate-spin"
                  : ""
              }
              aria-hidden="true"
            />
            Refresh
          </button>

          {canManage && (
            <button
              type="button"
              onClick={openGenerate}
              disabled={
                !isOnline ||
                generating ||
                cancelling
              }
              className="app-button app-button-primary inline-flex items-center gap-2"
            >
              <FileText
                size={17}
                aria-hidden="true"
              />
              Generate mock document
            </button>
          )}
        </div>
      </header>

      <section className="rounded-card border border-warning/30 bg-warning/5 p-5">
        <div className="flex items-start gap-3">
          <Info
            size={22}
            className="mt-0.5 shrink-0 text-warning"
            aria-hidden="true"
          />

          <div>
            <h3 className="text-sm font-semibold text-text-primary">
              Simulation — not a government-issued document
            </h3>

            <p className="mt-2 text-sm leading-6 text-text-muted">
              All e-Invoice and e-Way Bill references
              displayed here are mock records generated
              within the application. They are not
              authenticated Invoice Reference Numbers
              (IRNs), official e-Way Bill numbers,
              government acknowledgements, or proof
              of statutory compliance.
            </p>

            <p className="mt-2 text-sm leading-6 text-text-muted">
              Official GST compliance requires the
              applicable government systems and
              statutory procedures. This module
              does not transmit information to
              any government service.
            </p>
          </div>
        </div>
      </section>

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
            The device is offline. Mock document
            generation, cancellation, and record
            verification require a backend connection.
            These operations are not queued offline.
          </p>
        </div>
      )}

      {success && (
        <div
          role="status"
          className="app-alert app-alert-success flex items-start gap-3"
        >
          <CheckCircle2
            size={19}
            className="shrink-0"
            aria-hidden="true"
          />

          <p>{success}</p>
        </div>
      )}

      <section className="app-card space-y-5">
        <div>
          <h3 className="text-base font-semibold text-text-primary">
            Mock document register
          </h3>

          <p className="mt-1 text-sm text-text-muted">
            Review simulated document requests and
            backend-confirmed generation statuses.
          </p>
        </div>

        <form
          onSubmit={applyFilters}
          className="space-y-4"
        >
          {filterError && (
            <div
              role="alert"
              className="app-alert app-alert-error"
            >
              {filterError}
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <div>
              <label
                htmlFor="mock-document-search"
                className="app-field-label mb-2 block"
              >
                Search
              </label>

              <div className="relative">
                <Search
                  size={17}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
                  aria-hidden="true"
                />

                <input
                  id="mock-document-search"
                  type="search"
                  value={searchInput}
                  onChange={(event) =>
                    setSearchInput(
                      event.target.value,
                    )
                  }
                  placeholder="Document, invoice, customer..."
                  className="app-input w-full pl-10"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="mock-document-type"
                className="app-field-label mb-2 block"
              >
                Document type
              </label>

              <select
                id="mock-document-type"
                value={typeFilter}
                onChange={(event) => {
                  setTypeFilter(
                    event.target.value as DocumentTypeFilter,
                  );
                  setPage(1);
                }}
                className="app-select w-full"
              >
                <option value="all">
                  All document types
                </option>

                {DOCUMENT_TYPES.map((option) => (
                  <option
                    key={option.value}
                    value={option.value}
                  >
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                htmlFor="mock-document-status"
                className="app-field-label mb-2 block"
              >
                Status
              </label>

              <select
                id="mock-document-status"
                value={statusFilter}
                onChange={(event) => {
                  setStatusFilter(
                    event.target.value as DocumentStatusFilter,
                  );
                  setPage(1);
                }}
                className="app-select w-full"
              >
                {DOCUMENT_STATUSES.map((option) => (
                  <option
                    key={option.value}
                    value={option.value}
                  >
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                htmlFor="mock-document-date-from"
                className="app-field-label mb-2 block"
              >
                Created from
              </label>

              <input
                id="mock-document-date-from"
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
                htmlFor="mock-document-date-to"
                className="app-field-label mb-2 block"
              >
                Created to
              </label>

              <input
                id="mock-document-date-to"
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

        {loading && documents.length === 0 ? (
          <LoadingState
            variant="section"
            message="Loading mock documents..."
          />
        ) : (
          <DataTable<GovernmentDocument>
            columns={columns}
            data={documents}
            getRowId={(document) => document.id}
            loading={loading}
            error={error}
            onRetry={() => loadDocuments()}
            emptyMessage="No mock documents found"
            emptyDescription="No simulated government documents match the selected filters."
            pagination={{
              page,
              pageSize: PAGE_SIZE,
              total,
              onPageChange: setPage,
            }}
            testId="government-mock-documents-table"
          />
        )}
      </section>

      {generateOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="generate-mock-title"
            className="flex max-h-[90vh] w-full max-w-xl flex-col overflow-hidden rounded-card border border-border bg-surface shadow-xl"
          >
            <header className="flex items-start justify-between gap-4 border-b border-border p-5">
              <div>
                <h3
                  id="generate-mock-title"
                  className="text-lg font-semibold text-text-primary"
                >
                  Generate mock government document
                </h3>

                <p className="mt-1 text-sm text-text-muted">
                  Create a simulated record for a
                  posted GST invoice.
                </p>
              </div>

              <button
                type="button"
                onClick={closeGenerate}
                disabled={generating}
                aria-label="Close generation form"
                className="rounded-control p-2 text-text-muted hover:bg-background"
              >
                <X
                  size={20}
                  aria-hidden="true"
                />
              </button>
            </header>

            <form
              onSubmit={(event) => {
                void submitGenerate(event);
              }}
              className="flex min-h-0 flex-1 flex-col"
            >
              <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
                {generateError && (
                  <div
                    role="alert"
                    className="app-alert app-alert-error"
                  >
                    <p>{generateError}</p>

                    <p className="mt-2 text-xs">
                      If a network response was
                      interrupted, check the document
                      register before retrying.
                    </p>
                  </div>
                )}

                {invoicesError && (
                  <div
                    role="alert"
                    className="app-alert app-alert-error"
                  >
                    {invoicesError}
                  </div>
                )}

                <div>
                  <label
                    htmlFor="generate-mock-type"
                    className="app-field-label mb-2 block"
                  >
                    Document type *
                  </label>

                  <select
                    id="generate-mock-type"
                    value={selectedDocumentType}
                    onChange={(event) => {
                      setSelectedDocumentType(
                        event.target.value as GovernmentDocumentType,
                      );
                      setGenerateError(null);
                      generateKeyRef.current = null;
                    }}
                    disabled={generating}
                    required
                    className="app-select w-full"
                  >
                    {DOCUMENT_TYPES.map((option) => (
                      <option
                        key={option.value}
                        value={option.value}
                      >
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="generate-mock-invoice"
                    className="app-field-label mb-2 block"
                  >
                    Posted GST invoice *
                  </label>

                  {invoicesLoading ? (
                    <LoadingState
                      variant="section"
                      message="Loading eligible invoices..."
                    />
                  ) : (
                    <select
                      id="generate-mock-invoice"
                      value={selectedInvoiceId}
                      onChange={(event) => {
                        setSelectedInvoiceId(
                          event.target.value,
                        );
                        setGenerateError(null);
                        generateKeyRef.current = null;
                      }}
                      disabled={generating}
                      required
                      className="app-select w-full"
                    >
                      <option value="">
                        Select invoice
                      </option>

                      {eligibleInvoices.map((invoice) => (
                        <option
                          key={invoice.id}
                          value={invoice.id}
                        >
                          {invoice.invoice_number} —{" "}
                          {invoice.customer_name}
                        </option>
                      ))}
                    </select>
                  )}

                  {!invoicesLoading &&
                    eligibleInvoices.length === 0 &&
                    !invoicesError && (
                      <p className="app-field-help mt-2">
                        No posted invoices were
                        returned by the backend.
                      </p>
                    )}
                </div>

                {selectedInvoice && (
                  <div className="rounded-control border border-border bg-background p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="font-semibold text-text-primary">
                          {selectedInvoice.invoice_number}
                        </p>

                        <p className="mt-1 text-sm text-text-muted">
                          {selectedInvoice.customer_name}
                        </p>

                        <p className="mt-1 text-xs text-text-muted">
                          {formatDate(
                            selectedInvoice.invoice_date,
                          )}
                        </p>
                      </div>

                      <p className="app-numeric font-semibold text-text-primary">
                        {formatCurrency(
                          selectedInvoice.tax_summary.total_amount,
                        )}
                      </p>
                    </div>

                    <Link
                      to={`/invoices/${encodeURIComponent(selectedInvoice.id)}`}
                      className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline"
                    >
                      View invoice
                      <ExternalLink
                        size={14}
                        aria-hidden="true"
                      />
                    </Link>
                  </div>
                )}

                <div className="rounded-control border border-warning/30 bg-warning/5 p-4">
                  <div className="flex items-start gap-2">
                    <AlertCircle
                      size={18}
                      className="mt-0.5 shrink-0 text-warning"
                      aria-hidden="true"
                    />

                    <p className="text-sm leading-6 text-text-primary">
                      This operation generates a
                      simulated document only. The
                      backend must validate invoice
                      eligibility, prevent duplicate
                      active documents, and assign
                      mock references. No official
                      government registration occurs.
                    </p>
                  </div>
                </div>
              </div>

              <footer className="flex flex-wrap justify-end gap-3 border-t border-border p-5">
                <button
                  type="button"
                  onClick={closeGenerate}
                  disabled={generating}
                  className="app-button app-button-secondary"
                >
                  Cancel
                </button>

                <button
                  type="submit"
                  disabled={
                    generating ||
                    invoicesLoading ||
                    !selectedInvoice ||
                    !isOnline
                  }
                  className="app-button app-button-primary"
                >
                  {generating
                    ? "Generating..."
                    : "Generate mock document"}
                </button>
              </footer>
            </form>
          </section>
        </div>
      )}

      {detailsTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="mock-details-title"
            className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-card border border-border bg-surface shadow-xl"
          >
            <header className="flex items-start justify-between gap-4 border-b border-border p-5">
              <div>
                <h3
                  id="mock-details-title"
                  className="text-lg font-semibold text-text-primary"
                >
                  Mock document details
                </h3>

                <p className="mt-1 text-sm text-text-muted">
                  {detailsTarget.document_number ??
                    detailsTarget.id}
                </p>
              </div>

              <button
                type="button"
                onClick={() => {
                  setDetailsTarget(null);
                  setDetailsError(null);
                }}
                aria-label="Close document details"
                className="rounded-control p-2 text-text-muted hover:bg-background"
              >
                <X
                  size={20}
                  aria-hidden="true"
                />
              </button>
            </header>

            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
              {detailsLoading ? (
                <LoadingState
                  variant="section"
                  message="Loading document details..."
                />
              ) : detailsError ? (
                <div
                  role="alert"
                  className="app-alert app-alert-error"
                >
                  {detailsError}
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-3">
                    <StatusBadge
                      status={detailsTarget.status}
                      category="government"
                      showDot
                    />

                    <span className="rounded-full bg-warning/10 px-3 py-1 text-xs font-semibold text-warning">
                      Mock document
                    </span>
                  </div>

                  <dl className="grid gap-4 text-sm sm:grid-cols-2">
                    <div>
                      <dt className="text-text-muted">
                        Document type
                      </dt>

                      <dd className="mt-1 font-medium">
                        {documentTypeLabel(
                          detailsTarget.document_type,
                        )}
                      </dd>
                    </div>

                    <div>
                      <dt className="text-text-muted">
                        Invoice
                      </dt>

                      <dd className="mt-1">
                        <Link
                          to={`/invoices/${encodeURIComponent(detailsTarget.invoice_id)}`}
                          className="font-medium text-accent hover:underline"
                        >
                          {detailsTarget.invoice_number}
                        </Link>
                      </dd>
                    </div>

                    <div>
                      <dt className="text-text-muted">
                        Customer
                      </dt>

                      <dd className="mt-1 font-medium">
                        {detailsTarget.customer_name}
                      </dd>
                    </div>

                    <div>
                      <dt className="text-text-muted">
                        Invoice total
                      </dt>

                      <dd className="app-numeric mt-1 font-medium">
                        {formatCurrency(
                          detailsTarget.invoice_total,
                        )}
                      </dd>
                    </div>

                    <div>
                      <dt className="text-text-muted">
                        Mock reference
                      </dt>

                      <dd className="mt-1 break-all font-medium">
                        {detailsTarget.mock_reference_number ??
                          "Not assigned"}
                      </dd>
                    </div>

                    <div>
                      <dt className="text-text-muted">
                        Generated at
                      </dt>

                      <dd className="mt-1 font-medium">
                        {detailsTarget.generated_at
                          ? formatDateTime(
                              detailsTarget.generated_at,
                            )
                          : "Not generated"}
                      </dd>
                    </div>

                    <div>
                      <dt className="text-text-muted">
                        Cancelled at
                      </dt>

                      <dd className="mt-1 font-medium">
                        {detailsTarget.cancelled_at
                          ? formatDateTime(
                              detailsTarget.cancelled_at,
                            )
                          : "Not cancelled"}
                      </dd>
                    </div>

                    <div>
                      <dt className="text-text-muted">
                        Created at
                      </dt>

                      <dd className="mt-1 font-medium">
                        {formatDateTime(
                          detailsTarget.created_at,
                        )}
                      </dd>
                    </div>
                  </dl>

                  {detailsTarget.failure_reason && (
                    <div
                      role="alert"
                      className="app-alert app-alert-error"
                    >
                      <p className="font-semibold">
                        Generation failure
                      </p>

                      <p className="mt-1">
                        {detailsTarget.failure_reason}
                      </p>
                    </div>
                  )}

                  {detailsTarget.remarks && (
                    <section>
                      <h4 className="text-sm font-semibold text-text-primary">
                        Remarks
                      </h4>

                      <p className="mt-2 whitespace-pre-wrap text-sm text-text-muted">
                        {detailsTarget.remarks}
                      </p>
                    </section>
                  )}

                  {detailsTarget.payload && (
                    <section>
                      <h4 className="mb-2 text-sm font-semibold text-text-primary">
                        Simulated request data
                      </h4>

                      <pre className="max-h-64 overflow-auto rounded-control border border-border bg-background p-4 text-xs leading-5 text-text-primary">
                        {formatJson(
                          detailsTarget.payload,
                        )}
                      </pre>
                    </section>
                  )}

                  {detailsTarget.response_data && (
                    <section>
                      <h4 className="mb-2 text-sm font-semibold text-text-primary">
                        Simulated response data
                      </h4>

                      <pre className="max-h-64 overflow-auto rounded-control border border-border bg-background p-4 text-xs leading-5 text-text-primary">
                        {formatJson(
                          detailsTarget.response_data,
                        )}
                      </pre>
                    </section>
                  )}

                  <div className="rounded-control border border-warning/30 bg-warning/5 p-4 text-xs leading-5 text-text-primary">
                    This record is a simulation and
                    must not be represented as an
                    officially issued e-Invoice or
                    e-Way Bill.
                  </div>
                </>
              )}
            </div>

            <footer className="flex justify-end border-t border-border p-5">
              <button
                type="button"
                onClick={() => {
                  setDetailsTarget(null);
                  setDetailsError(null);
                }}
                className="app-button app-button-secondary"
              >
                Close
              </button>
            </footer>
          </section>
        </div>
      )}

      <ConfirmDialog
        open={cancelTarget !== null}
        title="Cancel mock government document"
        message={
          cancelTarget
            ? `Cancel simulated document ${cancelTarget.document_number ?? cancelTarget.id}?`
            : ""
        }
        description="Cancellation updates the mock document record only. It does not cancel the GST invoice or perform any government portal operation."
        variant="danger"
        confirmLabel="Cancel mock document"
        cancelLabel="Keep document"
        isLoading={cancelling}
        onCancel={closeCancel}
        onConfirm={submitCancel}
      >
        <div className="space-y-3">
          <div>
            <label
              htmlFor="mock-cancel-reason"
              className="app-field-label mb-2 block"
            >
              Cancellation reason *
            </label>

            <textarea
              id="mock-cancel-reason"
              value={cancelReason}
              onChange={(event) => {
                setCancelReason(
                  event.target.value,
                );
                setCancelError(null);
                cancelKeyRef.current = null;
              }}
              rows={3}
              minLength={5}
              maxLength={500}
              disabled={cancelling}
              placeholder="Enter the reason for cancelling this simulated document."
              className="app-textarea w-full"
            />
          </div>

          {cancelError && (
            <div
              role="alert"
              className="app-alert app-alert-error flex items-start gap-2"
            >
              <AlertCircle
                size={18}
                className="shrink-0"
                aria-hidden="true"
              />

              <p>{cancelError}</p>
            </div>
          )}
        </div>
      </ConfirmDialog>

      <footer className="rounded-card border border-border bg-surface p-4">
        <div className="flex items-start gap-3">
          <ShieldCheck
            size={21}
            className="mt-0.5 shrink-0 text-primary"
            aria-hidden="true"
          />

          <div>
            <h3 className="text-sm font-semibold text-text-primary">
              Validation and auditability
            </h3>

            <p className="mt-1 text-xs leading-5 text-text-muted">
              The backend controls invoice eligibility,
              mock reference assignment, duplicate
              prevention, document status transitions,
              idempotency, and audit history. GST
              amounts remain derived from posted
              invoices. This frontend does not generate
              official IRNs, government acknowledgements,
              or statutory documents.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}

export default GovernmentDocumentsPage;