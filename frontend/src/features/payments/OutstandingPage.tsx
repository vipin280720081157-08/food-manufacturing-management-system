import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";

import {
  AlertCircle,
  ArrowLeft,
  ArrowUpRight,
  CalendarClock,
  FileText,
  FilterX,
  RefreshCw,
  Search,
  Wallet,
  WifiOff,
} from "lucide-react";

import { Link } from "react-router-dom";

import { USER_ROLES } from "../../types/auth";

import type {
  PaginatedResponse,
  PaymentStatus,
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

import {
  formatCurrency,
  formatDate,
  formatDateTime,
} from "../../utils/formatters";

const PAGE_SIZE = 20;

type PaymentStatusFilter = "all" | PaymentStatus;

interface OutstandingInvoice {
  id: UUID;
  invoice_number: string;
  financial_year: string;
  customer_id: UUID;
  customer_name: string;
  sales_order_id: UUID;
  sales_order_number: string | null;
  invoice_date: string;
  due_date: string | null;
  payment_status: PaymentStatus;
  total_amount: string;
  amount_paid: string;
  outstanding_amount: string;
  days_overdue: number | null;
}

interface OutstandingSummary {
  total_outstanding: string;
  total_invoiced: string;
  total_collected: string;
  outstanding_invoice_count: number;
  overdue_invoice_count: number;
  overdue_amount: string;
  as_of: string;
}

interface OutstandingFilters {
  page: number;
  search: string;
  paymentStatus: PaymentStatusFilter;
  dateFrom: string;
  dateTo: string;
  overdueOnly: boolean;
}

const PAYMENT_STATUS_OPTIONS: ReadonlyArray<{
  value: PaymentStatusFilter;
  label: string;
}> = [
  {
    value: "all",
    label: "All payment statuses",
  },
  {
    value: "pending",
    label: "Pending",
  },
  {
    value: "partially_paid",
    label: "Partially paid",
  },
  {
    value: "paid",
    label: "Paid",
  },
];

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

function isOverdue(invoice: OutstandingInvoice): boolean {
  return (
    invoice.days_overdue !== null &&
    invoice.days_overdue > 0
  );
}

async function fetchOutstandingInvoices(
  filters: OutstandingFilters,
  signal?: AbortSignal,
): Promise<PaginatedResponse<OutstandingInvoice>> {
  return apiClient.get<
    PaginatedResponse<OutstandingInvoice>
  >("/payments/outstanding", {
    query: {
      page: filters.page,
      page_size: PAGE_SIZE,
      search: filters.search || undefined,
      payment_status:
        filters.paymentStatus === "all"
          ? undefined
          : filters.paymentStatus,
      date_from: filters.dateFrom || undefined,
      date_to: filters.dateTo || undefined,
      overdue_only: filters.overdueOnly || undefined,
    },
    signal,
  });
}

async function fetchOutstandingSummary(
  signal?: AbortSignal,
): Promise<OutstandingSummary> {
  return apiClient.get<OutstandingSummary>(
    "/payments/outstanding/summary",
    { signal },
  );
}

interface SummaryCardProps {
  label: string;
  value: string;
  description?: string;
  icon: typeof Wallet;
  emphasis?: "default" | "warning";
}

function SummaryCard({
  label,
  value,
  description,
  icon: Icon,
  emphasis = "default",
}: SummaryCardProps) {
  return (
    <div className="rounded-card border border-border bg-surface p-5 shadow-card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-text-muted">
            {label}
          </p>

          <p
            className={`app-numeric mt-3 break-words text-2xl font-bold ${
              emphasis === "warning"
                ? "text-warning"
                : "text-text-primary"
            }`}
          >
            {value}
          </p>

          {description && (
            <p className="mt-2 text-xs leading-5 text-text-muted">
              {description}
            </p>
          )}
        </div>

        <div
          className={`rounded-control p-2.5 ${
            emphasis === "warning"
              ? "bg-warning/10 text-warning"
              : "bg-background text-primary"
          }`}
        >
          <Icon size={21} aria-hidden="true" />
        </div>
      </div>
    </div>
  );
}

export function OutstandingPage() {
  const { user } = useAuth();
  const { isOnline } = useOnlineStatus();

  const canAccess =
    user?.role === USER_ROLES.FACTORY_ADMIN ||
    user?.role === USER_ROLES.ACCOUNTANT_AUDITOR ||
    user?.role === USER_ROLES.OWNER;

  const canManage =
    user?.role === USER_ROLES.FACTORY_ADMIN;

  const [invoices, setInvoices] =
    useState<OutstandingInvoice[]>([]);

  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  const [paymentStatusFilter, setPaymentStatusFilter] =
    useState<PaymentStatusFilter>("all");

  const [dateFromInput, setDateFromInput] = useState("");
  const [dateToInput, setDateToInput] = useState("");

  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const [overdueOnly, setOverdueOnly] = useState(false);

  const [filterError, setFilterError] =
    useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [summary, setSummary] =
    useState<OutstandingSummary | null>(null);

  const [summaryLoading, setSummaryLoading] =
    useState(true);

  const [summaryError, setSummaryError] =
    useState<string | null>(null);

  const [lastRefreshedAt, setLastRefreshedAt] =
    useState<string | null>(null);

  const filters = useMemo<OutstandingFilters>(
    () => ({
      page,
      search,
      paymentStatus: paymentStatusFilter,
      dateFrom,
      dateTo,
      overdueOnly,
    }),
    [
      page,
      search,
      paymentStatusFilter,
      dateFrom,
      dateTo,
      overdueOnly,
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
        const response = await fetchOutstandingInvoices(
          filters,
          signal,
        );

        if (signal?.aborted) {
          return;
        }

        setInvoices(response.items);
        setTotal(response.total);
        setLastRefreshedAt(new Date().toISOString());
      } catch (failure) {
        if (!signal?.aborted) {
          setError(getApiErrorMessage(failure));
          setInvoices([]);
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

  const loadSummary = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      if (!canAccess) {
        setSummary(null);
        setSummaryLoading(false);
        return;
      }

      setSummaryLoading(true);
      setSummaryError(null);

      try {
        const response = await fetchOutstandingSummary(
          signal,
        );

        if (!signal?.aborted) {
          setSummary(response);
        }
      } catch (failure) {
        if (!signal?.aborted) {
          setSummaryError(
            getApiErrorMessage(failure),
          );
          setSummary(null);
        }
      } finally {
        if (!signal?.aborted) {
          setSummaryLoading(false);
        }
      }
    },
    [canAccess],
  );

  useEffect(() => {
    const controller = new AbortController();

    void loadInvoices(controller.signal);

    return () => controller.abort();
  }, [loadInvoices]);

  useEffect(() => {
    const controller = new AbortController();

    void loadSummary(controller.signal);

    return () => controller.abort();
  }, [loadSummary]);

  const refreshAll = (): void => {
    void loadInvoices();
    void loadSummary();
  };

  const handleFilterSubmit = (
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
    setPaymentStatusFilter("all");
    setDateFromInput("");
    setDateToInput("");
    setDateFrom("");
    setDateTo("");
    setOverdueOnly(false);
    setFilterError(null);
    setPage(1);
  };

  const columns = useMemo<
    DataTableColumn<OutstandingInvoice>[]
  >(
    () => [
      {
        key: "invoice_number",
        header: "Invoice",
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

            {invoice.sales_order_number && (
              <p className="mt-1 text-xs text-text-muted">
                Order: {invoice.sales_order_number}
              </p>
            )}
          </div>
        ),
      },
      {
        key: "customer",
        header: "Customer",
        render: (invoice) => (
          <span className="font-medium text-text-primary">
            {invoice.customer_name}
          </span>
        ),
      },
      {
        key: "invoice_date",
        header: "Invoice date",
        render: (invoice) =>
          formatDate(invoice.invoice_date),
      },
      {
        key: "due_date",
        header: "Due date",
        render: (invoice) => (
          <div>
            <span>
              {invoice.due_date
                ? formatDate(invoice.due_date)
                : "Not recorded"}
            </span>

            {isOverdue(invoice) && (
              <p className="mt-1 text-xs font-medium text-warning">
                {invoice.days_overdue} day
                {invoice.days_overdue === 1 ? "" : "s"} overdue
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
        header: "Collected",
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
          <span
            className={`app-numeric font-semibold ${
              isOverdue(invoice)
                ? "text-warning"
                : "text-text-primary"
            }`}
          >
            {formatCurrency(
              invoice.outstanding_amount,
            )}
          </span>
        ),
      },
      {
        key: "payment_status",
        header: "Payment status",
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
          <Link
            to={`/invoices/${encodeURIComponent(invoice.id)}`}
            className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline"
          >
            <FileText
              size={15}
              aria-hidden="true"
            />
            View
          </Link>
        ),
      },
    ],
    [],
  );

  if (!canAccess) {
    return (
      <div className="app-page space-y-5">
        <h2 className="app-page-title">
          Outstanding Receivables
        </h2>

        <div
          role="alert"
          className="app-alert app-alert-error"
        >
          Outstanding receivables are restricted to
          authorized Factory Admin, Accountant/Auditor,
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
      <header className="space-y-4">
        <Link
          to="/payments"
          className="inline-flex items-center gap-2 text-sm font-medium text-accent hover:underline"
        >
          <ArrowLeft
            size={17}
            aria-hidden="true"
          />
          Payment collections
        </Link>

        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <Wallet
                size={27}
                className="text-primary"
                aria-hidden="true"
              />

              <h2 className="app-page-title">
                Outstanding Receivables
              </h2>
            </div>

            <p className="app-page-description">
              Monitor unpaid and partially paid GST
              invoices, customer balances, and overdue
              receivables using backend-calculated values.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={refreshAll}
              disabled={loading || summaryLoading}
              className="app-button app-button-secondary inline-flex items-center gap-2"
            >
              <RefreshCw
                size={17}
                className={
                  loading || summaryLoading
                    ? "motion-safe:animate-spin"
                    : ""
                }
                aria-hidden="true"
              />
              Refresh
            </button>

            {canManage && (
              <Link
                to="/payments"
                className="app-button app-button-primary inline-flex items-center gap-2"
              >
                <ArrowUpRight
                  size={17}
                  aria-hidden="true"
                />
                Record payment
              </Link>
            )}
          </div>
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
            The device is offline. Receivables and payment
            balances require a backend connection.
            Previously loaded information, if visible,
            may no longer reflect current transactions.
          </p>
        </div>
      )}

      <section aria-labelledby="outstanding-summary-title">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h3
            id="outstanding-summary-title"
            className="text-base font-semibold text-text-primary"
          >
            Receivables overview
          </h3>

          {summary?.as_of && (
            <p className="text-xs text-text-muted">
              As of {formatDateTime(summary.as_of)}
            </p>
          )}
        </div>

        {summaryLoading ? (
          <LoadingState
            variant="section"
            message="Loading receivables summary..."
          />
        ) : summaryError ? (
          <div
            role="alert"
            className="app-alert app-alert-error flex flex-wrap items-center justify-between gap-3"
          >
            <div className="flex items-start gap-2">
              <AlertCircle
                size={18}
                className="mt-0.5 shrink-0"
                aria-hidden="true"
              />

              <p>{summaryError}</p>
            </div>

            <button
              type="button"
              onClick={() => {
                void loadSummary();
              }}
              className="app-button app-button-secondary"
            >
              Retry
            </button>
          </div>
        ) : summary ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <SummaryCard
              label="Total outstanding"
              value={formatCurrency(
                summary.total_outstanding,
              )}
              description="Unpaid balance across posted invoices"
              icon={Wallet}
            />

            <SummaryCard
              label="Total collected"
              value={formatCurrency(
                summary.total_collected,
              )}
              description="Backend-recorded collections"
              icon={ArrowUpRight}
            />

            <SummaryCard
              label="Outstanding invoices"
              value={String(
                summary.outstanding_invoice_count,
              )}
              description="Invoices with a remaining balance"
              icon={FileText}
            />

            <SummaryCard
              label="Overdue amount"
              value={formatCurrency(
                summary.overdue_amount,
              )}
              description={`${summary.overdue_invoice_count} overdue invoice${
                summary.overdue_invoice_count === 1
                  ? ""
                  : "s"
              }`}
              icon={CalendarClock}
              emphasis="warning"
            />
          </div>
        ) : null}
      </section>

      <section className="rounded-card border border-border bg-surface p-4">
        <div className="flex items-start gap-3">
          <AlertCircle
            size={20}
            className="mt-0.5 shrink-0 text-primary"
            aria-hidden="true"
          />

          <div>
            <h3 className="text-sm font-semibold text-text-primary">
              Balance and aging controls
            </h3>

            <p className="mt-1 text-xs leading-5 text-text-muted">
              Invoice totals, posted collections, remaining
              balances, and overdue aging are determined
              by the backend. Draft payments do not reduce
              receivables. Overdue indicators are displayed
              only when the backend supplies aging data.
              The overview covers all eligible records,
              independently of the filters applied below.
            </p>
          </div>
        </div>
      </section>

      <section className="app-card space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-text-primary">
              Outstanding invoice register
            </h3>

            <p className="mt-1 text-sm text-text-muted">
              Search customer receivables and review
              outstanding invoice balances.
            </p>
          </div>

          {lastRefreshedAt && (
            <p className="text-xs text-text-muted">
              Last loaded:{" "}
              {formatDateTime(lastRefreshedAt)}
            </p>
          )}
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

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <div>
              <label
                htmlFor="outstanding-search"
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
                  id="outstanding-search"
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
                htmlFor="outstanding-payment-status"
                className="app-field-label mb-2 block"
              >
                Payment status
              </label>

              <select
                id="outstanding-payment-status"
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
                htmlFor="outstanding-date-from"
                className="app-field-label mb-2 block"
              >
                Invoice date from
              </label>

              <input
                id="outstanding-date-from"
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
                htmlFor="outstanding-date-to"
                className="app-field-label mb-2 block"
              >
                Invoice date to
              </label>

              <input
                id="outstanding-date-to"
                type="date"
                value={dateToInput}
                onChange={(event) =>
                  setDateToInput(event.target.value)
                }
                className="app-input w-full"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-4">
            <label className="inline-flex cursor-pointer items-center gap-3 text-sm text-text-primary">
              <input
                type="checkbox"
                checked={overdueOnly}
                onChange={(event) => {
                  setOverdueOnly(event.target.checked);
                  setPage(1);
                }}
                className="h-4 w-4 rounded border-border accent-primary"
              />

              Show overdue invoices only
            </label>

            <div className="flex flex-wrap gap-2">
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
          </div>
        </form>

        {loading && invoices.length === 0 ? (
          <LoadingState
            variant="section"
            message="Loading outstanding invoices..."
          />
        ) : (
          <DataTable<OutstandingInvoice>
            columns={columns}
            data={invoices}
            getRowId={(invoice) => invoice.id}
            loading={loading}
            error={error}
            onRetry={() => loadInvoices()}
            emptyMessage="No outstanding invoices found"
            emptyDescription="No receivables match the selected filters."
            pagination={{
              page,
              pageSize: PAGE_SIZE,
              total,
              onPageChange: setPage,
            }}
            testId="outstanding-invoices-table"
          />
        )}
      </section>

      <footer className="text-xs leading-5 text-text-muted">
        Receivable values are read-only and reflect
        backend-confirmed invoice and payment transactions.
        Payment entry and posting are available only to
        authorized Factory Admin users.
      </footer>
    </div>
  );
}

export default OutstandingPage;