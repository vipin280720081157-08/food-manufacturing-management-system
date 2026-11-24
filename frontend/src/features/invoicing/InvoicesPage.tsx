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
  Eye,
  FilePlus2,
  FileText,
  FilterX,
  RefreshCw,
  Search,
  WifiOff,
} from "lucide-react";

import { Link } from "react-router-dom";

import { USER_ROLES } from "../../types/auth";

import type {
  GSTInvoice,
  PaginatedResponse,
  PaymentStatus,
  TransactionStatus,
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
import { ConfirmDialog } from "../../components/common/ConfirmDialog";
import { StatusBadge } from "../../components/common/StatusBadge";

import {
  formatCurrency,
  formatDate,
} from "../../utils/formatters";

const PAGE_SIZE = 20;

type InvoiceStatusFilter = "all" | TransactionStatus;
type PaymentStatusFilter = "all" | PaymentStatus;

interface InvoiceListItem {
  id: UUID;
  invoice_number: string;
  financial_year: string;
  sales_order_id: UUID;
  sales_order_number: string | null;
  customer_id: UUID;
  customer_name: string;
  invoice_date: string;
  status: TransactionStatus;
  payment_status: PaymentStatus;
  total_amount: string;
  amount_paid: string;
  outstanding_amount: string;
  created_at: string;
}

interface ApprovedOrderOption {
  id: UUID;
  order_number: string;
  customer_id: UUID;
  customer_name: string;
  approval_status: string;
  invoice_id: UUID | null;
}

interface InvoiceFilters {
  page: number;
  search: string;
  status: InvoiceStatusFilter;
  paymentStatus: PaymentStatusFilter;
  dateFrom: string;
  dateTo: string;
}

interface InvoiceCreationResponse {
  id: UUID;
  invoice_number: string;
  status: TransactionStatus;
  sales_order_id: UUID;
}

const INVOICE_STATUS_OPTIONS: ReadonlyArray<{
  value: InvoiceStatusFilter;
  label: string;
}> = [
  { value: "all", label: "All invoice statuses" },
  { value: "draft", label: "Draft" },
  { value: "posted", label: "Posted" },
  { value: "cancelled", label: "Cancelled" },
];

const PAYMENT_STATUS_OPTIONS: ReadonlyArray<{
  value: PaymentStatusFilter;
  label: string;
}> = [
  { value: "all", label: "All payment statuses" },
  { value: "pending", label: "Pending" },
  { value: "partially_paid", label: "Partially paid" },
  { value: "paid", label: "Paid" },
];

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const parsed = new Date(`${value}T00:00:00Z`);

  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

async function fetchInvoices(
  filters: InvoiceFilters,
  signal?: AbortSignal,
): Promise<PaginatedResponse<InvoiceListItem>> {
  return apiClient.get<
    PaginatedResponse<InvoiceListItem>
  >("/invoices", {
    query: {
      page: filters.page,
      page_size: PAGE_SIZE,
      search: filters.search || undefined,
      status:
        filters.status === "all"
          ? undefined
          : filters.status,
      payment_status:
        filters.paymentStatus === "all"
          ? undefined
          : filters.paymentStatus,
      date_from: filters.dateFrom || undefined,
      date_to: filters.dateTo || undefined,
    },
    signal,
  });
}

async function fetchApprovedOrders(
  signal?: AbortSignal,
): Promise<ApprovedOrderOption[]> {
  const response = await apiClient.get<
    PaginatedResponse<ApprovedOrderOption>
  >("/sales/orders", {
    query: {
      approval_status: "approved",
      page: 1,
      page_size: 100,
    },
    signal,
  });

  return response.items.filter(
    (order) =>
      order.approval_status === "approved" &&
      !order.invoice_id,
  );
}

async function createInvoice(
  salesOrderId: UUID,
  idempotencyKey: string,
): Promise<InvoiceCreationResponse> {
  return apiClient.post<InvoiceCreationResponse>(
    "/invoices",
    {
      sales_order_id: salesOrderId,
    },
    {
      idempotencyKey,
    },
  );
}

async function postInvoice(
  invoiceId: UUID,
  idempotencyKey: string,
): Promise<GSTInvoice> {
  return apiClient.post<GSTInvoice>(
    `/invoices/${encodeURIComponent(invoiceId)}/post`,
    {},
    {
      idempotencyKey,
    },
  );
}

export function InvoicesPage() {
  const { user } = useAuth();
  const { isOnline } = useOnlineStatus();

  const canAccess =
    user?.role === USER_ROLES.FACTORY_ADMIN ||
    user?.role === USER_ROLES.ACCOUNTANT_AUDITOR ||
    user?.role === USER_ROLES.OWNER;

  const canManage =
    user?.role === USER_ROLES.FACTORY_ADMIN;

  const [invoices, setInvoices] =
    useState<InvoiceListItem[]>([]);

  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  const [statusFilter, setStatusFilter] =
    useState<InvoiceStatusFilter>("all");

  const [paymentStatusFilter, setPaymentStatusFilter] =
    useState<PaymentStatusFilter>("all");

  const [dateFromInput, setDateFromInput] = useState("");
  const [dateToInput, setDateToInput] = useState("");

  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const [filterError, setFilterError] =
    useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [successMessage, setSuccessMessage] =
    useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [approvedOrders, setApprovedOrders] =
    useState<ApprovedOrderOption[]>([]);

  const [approvedOrdersLoading, setApprovedOrdersLoading] =
    useState(false);

  const [approvedOrdersError, setApprovedOrdersError] =
    useState<string | null>(null);

  const [selectedSalesOrderId, setSelectedSalesOrderId] =
    useState("");

  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] =
    useState<string | null>(null);

  const [postTarget, setPostTarget] =
    useState<InvoiceListItem | null>(null);

  const [posting, setPosting] = useState(false);
  const [postError, setPostError] =
    useState<string | null>(null);

  const createKeyRef = useRef<string | null>(null);
  const postKeyRef = useRef<string | null>(null);
  const mutationLockRef = useRef(false);

  const filters = useMemo<InvoiceFilters>(
    () => ({
      page,
      search,
      status: statusFilter,
      paymentStatus: paymentStatusFilter,
      dateFrom,
      dateTo,
    }),
    [
      page,
      search,
      statusFilter,
      paymentStatusFilter,
      dateFrom,
      dateTo,
    ],
  );

  const loadInvoices = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      if (!canAccess) {
        setInvoices([]);
        setTotal(0);
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const response = await fetchInvoices(
          filters,
          signal,
        );

        if (signal?.aborted) {
          return;
        }

        setInvoices(response.items);
        setTotal(response.total);
      } catch (failure) {
        if (!signal?.aborted) {
          setError(getApiErrorMessage(failure));
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

    void loadInvoices(controller.signal);

    return () => controller.abort();
  }, [loadInvoices]);

  const loadApprovedOrders = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      if (!canManage || !isOnline) {
        return;
      }

      setApprovedOrdersLoading(true);
      setApprovedOrdersError(null);

      try {
        const response = await fetchApprovedOrders(
          signal,
        );

        if (!signal?.aborted) {
          setApprovedOrders(response);
        }
      } catch (failure) {
        if (!signal?.aborted) {
          setApprovedOrdersError(
            getApiErrorMessage(failure),
          );
        }
      } finally {
        if (!signal?.aborted) {
          setApprovedOrdersLoading(false);
        }
      }
    },
    [canManage, isOnline],
  );

  useEffect(() => {
    if (!createOpen) {
      return;
    }

    const controller = new AbortController();

    void loadApprovedOrders(controller.signal);

    return () => controller.abort();
  }, [createOpen, loadApprovedOrders]);

  const openCreate = (): void => {
    if (
      !canManage ||
      !isOnline ||
      creating ||
      posting
    ) {
      return;
    }

    setSelectedSalesOrderId("");
    setCreateError(null);
    setSuccessMessage(null);
    createKeyRef.current = null;
    setCreateOpen(true);
  };

  const closeCreate = (): void => {
    if (creating) {
      return;
    }

    setCreateOpen(false);
    setCreateError(null);
    setSelectedSalesOrderId("");
    createKeyRef.current = null;
  };

  const submitCreate = async (): Promise<void> => {
    if (
      !canManage ||
      !isOnline ||
      !selectedSalesOrderId ||
      creating ||
      mutationLockRef.current
    ) {
      return;
    }

    const selectedOrder = approvedOrders.find(
      (order) =>
        order.id === selectedSalesOrderId,
    );

    if (!selectedOrder) {
      setCreateError(
        "Select an eligible approved sales order.",
      );
      return;
    }

    const idempotencyKey =
      createKeyRef.current ??
      crypto.randomUUID();

    createKeyRef.current = idempotencyKey;
    mutationLockRef.current = true;

    setCreating(true);
    setCreateError(null);
    setSuccessMessage(null);

    try {
      const result = await createInvoice(
        selectedSalesOrderId,
        idempotencyKey,
      );

      if (
        !result.id ||
        result.sales_order_id !== selectedSalesOrderId
      ) {
        throw new Error(
          "The backend response did not confirm the requested invoice. Refresh the invoice register before retrying.",
        );
      }

      setCreateOpen(false);
      setSelectedSalesOrderId("");
      createKeyRef.current = null;

      setSuccessMessage(
        `Invoice ${result.invoice_number} was created with status "${result.status}".`,
      );

      setPage(1);
      await loadInvoices();
    } catch (failure) {
      setCreateError(getApiErrorMessage(failure));
    } finally {
      mutationLockRef.current = false;
      setCreating(false);
    }
  };

  const openPost = (invoice: InvoiceListItem): void => {
    if (
      !canManage ||
      !isOnline ||
      invoice.status !== "draft" ||
      posting ||
      creating
    ) {
      return;
    }

    postKeyRef.current = null;
    setPostError(null);
    setSuccessMessage(null);
    setPostTarget(invoice);
  };

  const closePost = (): void => {
    if (posting) {
      return;
    }

    setPostTarget(null);
    setPostError(null);
    postKeyRef.current = null;
  };

  const submitPost = async (): Promise<void> => {
    if (
      !postTarget ||
      !canManage ||
      !isOnline ||
      posting ||
      mutationLockRef.current
    ) {
      return;
    }

    const idempotencyKey =
      postKeyRef.current ??
      crypto.randomUUID();

    postKeyRef.current = idempotencyKey;
    mutationLockRef.current = true;

    setPosting(true);
    setPostError(null);
    setSuccessMessage(null);

    try {
      const result = await postInvoice(
        postTarget.id,
        idempotencyKey,
      );

      if (
        result.id !== postTarget.id ||
        result.status !== "posted"
      ) {
        throw new Error(
          "The backend did not confirm invoice posting. Refresh the invoice register before retrying.",
        );
      }

      setSuccessMessage(
        `Invoice ${result.invoice_number} was posted successfully.`,
      );

      setPostTarget(null);
      postKeyRef.current = null;

      await loadInvoices();
    } catch (failure) {
      setPostError(getApiErrorMessage(failure));
    } finally {
      mutationLockRef.current = false;
      setPosting(false);
    }
  };

  const handleFilterSubmit = (
    event: FormEvent<HTMLFormElement>,
  ): void => {
    event.preventDefault();

    if (
      dateFromInput &&
      !isValidDate(dateFromInput)
    ) {
      setFilterError(
        "Enter a valid start date.",
      );
      return;
    }

    if (
      dateToInput &&
      !isValidDate(dateToInput)
    ) {
      setFilterError(
        "Enter a valid end date.",
      );
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
    setStatusFilter("all");
    setPaymentStatusFilter("all");
    setDateFromInput("");
    setDateToInput("");
    setDateFrom("");
    setDateTo("");
    setFilterError(null);
    setPage(1);
  };

  const columns = useMemo<
    DataTableColumn<InvoiceListItem>[]
  >(
    () => [
      {
        key: "invoice_number",
        header: "Invoice number",
        render: (invoice) => (
          <div>
            <Link
              to={`/invoices/${encodeURIComponent(invoice.id)}`}
              className="font-semibold text-accent underline-offset-2 hover:underline"
            >
              {invoice.invoice_number}
            </Link>

            <p className="mt-1 text-xs text-text-muted">
              FY {invoice.financial_year}
            </p>
          </div>
        ),
      },
      {
        key: "invoice_date",
        header: "Invoice date",
        render: (invoice) =>
          formatDate(invoice.invoice_date),
      },
      {
        key: "customer",
        header: "Customer",
        render: (invoice) => (
          <div>
            <p className="font-medium text-text-primary">
              {invoice.customer_name}
            </p>

            {invoice.sales_order_number && (
              <p className="mt-1 text-xs text-text-muted">
                Order: {invoice.sales_order_number}
              </p>
            )}
          </div>
        ),
      },
      {
        key: "total_amount",
        header: "Invoice total",
        numeric: true,
        render: (invoice) => (
          <span className="app-numeric">
            {formatCurrency(invoice.total_amount)}
          </span>
        ),
      },
      {
        key: "amount_paid",
        header: "Paid",
        numeric: true,
        render: (invoice) => (
          <span className="app-numeric">
            {formatCurrency(invoice.amount_paid)}
          </span>
        ),
      },
      {
        key: "outstanding_amount",
        header: "Outstanding",
        numeric: true,
        render: (invoice) => (
          <span className="app-numeric font-medium">
            {formatCurrency(
              invoice.outstanding_amount,
            )}
          </span>
        ),
      },
      {
        key: "status",
        header: "Invoice status",
        render: (invoice) => (
          <StatusBadge
            status={invoice.status}
            category="transaction"
            showDot
          />
        ),
      },
      {
        key: "payment_status",
        header: "Payment",
        render: (invoice) => (
          <StatusBadge
            status={invoice.payment_status}
            category="payment"
            showDot
          />
        ),
      },
      {
        key: "actions",
        header: "Actions",
        align: "right",
        render: (invoice) => (
          <div className="flex flex-wrap justify-end gap-3">
            <Link
              to={`/invoices/${encodeURIComponent(invoice.id)}`}
              className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline"
            >
              <Eye
                size={15}
                aria-hidden="true"
              />
              View
            </Link>

            {canManage &&
              invoice.status === "draft" && (
                <button
                  type="button"
                  onClick={() => openPost(invoice)}
                  disabled={
                    !isOnline ||
                    posting ||
                    creating
                  }
                  className="text-sm font-medium text-success hover:underline disabled:opacity-50"
                >
                  Post
                </button>
              )}
          </div>
        ),
      },
    ],
    [canManage, isOnline, posting, creating],
  );

  if (!canAccess) {
    return (
      <div className="app-page space-y-5">
        <h2 className="app-page-title">
          GST Invoices
        </h2>

        <div
          role="alert"
          className="app-alert app-alert-error"
        >
          Invoice access is restricted to authorized
          Factory Admin, Accountant/Auditor, and
          Owner roles.
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
            <FileText
              size={27}
              className="text-primary"
              aria-hidden="true"
            />

            <h2 className="app-page-title">
              GST Invoices
            </h2>
          </div>

          <p className="app-page-description">
            View GST invoices, payment balances,
            and backend-recorded invoice statuses.
            Authorized invoice creation and posting
            are performed online.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              void loadInvoices();
            }}
            disabled={loading || creating || posting}
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
              onClick={openCreate}
              disabled={
                !isOnline ||
                creating ||
                posting
              }
              className="app-button app-button-primary inline-flex items-center gap-2"
            >
              <FilePlus2
                size={17}
                aria-hidden="true"
              />
              Create invoice
            </button>
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
            The device is offline. Official invoices,
            GST calculations, invoice posting, and
            payment balances require a backend connection.
            Invoice operations are not queued offline.
          </p>
        </div>
      )}

      {successMessage && (
        <div
          role="status"
          className="app-alert app-alert-success flex items-start gap-3"
        >
          <CheckCircle2
            size={19}
            className="shrink-0"
            aria-hidden="true"
          />

          <p>{successMessage}</p>
        </div>
      )}

      <div className="rounded-card border border-border bg-surface p-4">
        <div className="flex items-start gap-3">
          <AlertCircle
            size={20}
            className="mt-0.5 shrink-0 text-primary"
            aria-hidden="true"
          />

          <div>
            <h3 className="text-sm font-semibold text-text-primary">
              Invoice processing
            </h3>

            <p className="mt-1 text-xs leading-5 text-text-muted">
              Invoices originate from eligible approved
              sales orders. The backend determines invoice
              numbering, taxable values, CGST, SGST,
              IGST, totals, and financial-year details.
              Posting an invoice does not itself dispatch
              inventory or record a payment.
            </p>
          </div>
        </div>
      </div>

      <section className="app-card space-y-5">
        <div>
          <h3 className="text-base font-semibold text-text-primary">
            Invoice register
          </h3>

          <p className="mt-1 text-sm text-text-muted">
            Search invoices and review authoritative
            outstanding balances.
          </p>
        </div>

        <form
          onSubmit={handleFilterSubmit}
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

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
            <div>
              <label
                htmlFor="invoice-search"
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
                  id="invoice-search"
                  type="search"
                  value={searchInput}
                  onChange={(event) =>
                    setSearchInput(event.target.value)
                  }
                  placeholder="Invoice or customer..."
                  className="app-input w-full pl-10"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="invoice-status"
                className="app-field-label mb-2 block"
              >
                Invoice status
              </label>

              <select
                id="invoice-status"
                value={statusFilter}
                onChange={(event) => {
                  setStatusFilter(
                    event.target.value as InvoiceStatusFilter,
                  );
                  setPage(1);
                }}
                className="app-select w-full"
              >
                {INVOICE_STATUS_OPTIONS.map((option) => (
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
                htmlFor="invoice-payment-status"
                className="app-field-label mb-2 block"
              >
                Payment status
              </label>

              <select
                id="invoice-payment-status"
                value={paymentStatusFilter}
                onChange={(event) => {
                  setPaymentStatusFilter(
                    event.target.value as PaymentStatusFilter,
                  );
                  setPage(1);
                }}
                className="app-select w-full"
              >
                {PAYMENT_STATUS_OPTIONS.map((option) => (
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
                htmlFor="invoice-date-from"
                className="app-field-label mb-2 block"
              >
                Date from
              </label>

              <input
                id="invoice-date-from"
                type="date"
                value={dateFromInput}
                onChange={(event) =>
                  setDateFromInput(event.target.value)
                }
                className="app-input w-full"
              />
            </div>

            <div>
              <label
                htmlFor="invoice-date-to"
                className="app-field-label mb-2 block"
              >
                Date to
              </label>

              <input
                id="invoice-date-to"
                type="date"
                value={dateToInput}
                onChange={(event) =>
                  setDateToInput(event.target.value)
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

        {loading && invoices.length === 0 ? (
          <LoadingState
            variant="section"
            message="Loading invoices..."
          />
        ) : (
          <DataTable<InvoiceListItem>
            columns={columns}
            data={invoices}
            getRowId={(invoice) => invoice.id}
            loading={loading}
            error={error}
            onRetry={() => loadInvoices()}
            emptyMessage="No invoices found"
            emptyDescription="No invoices match the selected filters."
            pagination={{
              page,
              pageSize: PAGE_SIZE,
              total,
              onPageChange: setPage,
            }}
            testId="invoices-table"
          />
        )}
      </section>

      {createOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-invoice-title"
            className="w-full max-w-xl rounded-card border border-border bg-surface shadow-xl"
          >
            <header className="border-b border-border p-5">
              <h3
                id="create-invoice-title"
                className="text-lg font-semibold text-text-primary"
              >
                Create GST invoice
              </h3>

              <p className="mt-1 text-sm text-text-muted">
                Select an approved sales order
                eligible for invoicing.
              </p>
            </header>

            <div className="space-y-5 p-5">
              {createError && (
                <div
                  role="alert"
                  className="app-alert app-alert-error"
                >
                  <p>{createError}</p>

                  <p className="mt-2 text-xs">
                    If a network response was interrupted,
                    check the invoice register before retrying.
                  </p>
                </div>
              )}

              {approvedOrdersError && (
                <div
                  role="alert"
                  className="app-alert app-alert-error"
                >
                  {approvedOrdersError}
                </div>
              )}

              {approvedOrdersLoading ? (
                <LoadingState
                  variant="section"
                  message="Loading approved orders..."
                />
              ) : (
                <div>
                  <label
                    htmlFor="invoice-sales-order"
                    className="app-field-label mb-2 block"
                  >
                    Approved sales order *
                  </label>

                  <select
                    id="invoice-sales-order"
                    value={selectedSalesOrderId}
                    onChange={(event) => {
                      setSelectedSalesOrderId(
                        event.target.value,
                      );
                      setCreateError(null);
                      createKeyRef.current = null;
                    }}
                    required
                    disabled={creating}
                    className="app-select w-full"
                  >
                    <option value="">
                      Select sales order
                    </option>

                    {approvedOrders.map((order) => (
                      <option
                        key={order.id}
                        value={order.id}
                      >
                        {order.order_number} —{" "}
                        {order.customer_name}
                      </option>
                    ))}
                  </select>

                  {approvedOrders.length === 0 &&
                    !approvedOrdersError && (
                      <p className="app-field-help mt-2">
                        No eligible approved sales orders
                        were returned in the current
                        selection.
                      </p>
                    )}
                </div>
              )}

              <div className="rounded-control border border-border bg-background p-4 text-xs leading-5 text-text-muted">
                The backend validates invoice eligibility
                and calculates all GST values. The
                resulting invoice must be reviewed
                before posting.
              </div>
            </div>

            <footer className="flex flex-wrap justify-end gap-3 border-t border-border p-5">
              <button
                type="button"
                onClick={closeCreate}
                disabled={creating}
                className="app-button app-button-secondary"
              >
                Cancel
              </button>

              <button
                type="button"
                onClick={() => {
                  void submitCreate();
                }}
                disabled={
                  creating ||
                  !isOnline ||
                  !selectedSalesOrderId ||
                  approvedOrdersLoading
                }
                className="app-button app-button-primary inline-flex items-center gap-2"
              >
                <FilePlus2
                  size={17}
                  aria-hidden="true"
                />
                {creating
                  ? "Creating..."
                  : "Create draft invoice"}
              </button>
            </footer>
          </section>
        </div>
      )}

      <ConfirmDialog
        open={postTarget !== null}
        title="Post GST invoice"
        message={
          postTarget
            ? `Post invoice ${postTarget.invoice_number}?`
            : ""
        }
        description="Posting finalizes the invoice through the backend. Verify customer, line items, GST breakdown, and invoice totals before proceeding. Dispatch and payment remain separate operations."
        variant="warning"
        confirmLabel="Post invoice"
        cancelLabel="Cancel"
        isLoading={posting}
        onCancel={closePost}
        onConfirm={submitPost}
      >
        {postTarget && (
          <div className="space-y-2 rounded-control border border-border p-4 text-sm">
            <div className="flex justify-between gap-4">
              <span className="text-text-muted">
                Customer
              </span>

              <span className="text-right font-medium">
                {postTarget.customer_name}
              </span>
            </div>

            <div className="flex justify-between gap-4">
              <span className="text-text-muted">
                Invoice total
              </span>

              <span className="app-numeric font-semibold">
                {formatCurrency(
                  postTarget.total_amount,
                )}
              </span>
            </div>
          </div>
        )}

        {postError && (
          <div
            role="alert"
            className="app-alert app-alert-error"
          >
            <p>{postError}</p>

            <p className="mt-2 text-xs">
              If the response was interrupted,
              verify the invoice status before retrying.
            </p>
          </div>
        )}
      </ConfirmDialog>
    </div>
  );
}

export default InvoicesPage;