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
  ArrowUpRight,
  CheckCircle2,
  CreditCard,
  Eye,
  FilterX,
  Plus,
  RefreshCw,
  Search,
  Wallet,
  WifiOff,
  X,
} from "lucide-react";

import { Link } from "react-router-dom";

import { USER_ROLES } from "../../types/auth";

import type {
  PaginatedResponse,
  PaymentMethod,
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
  formatDateTime,
} from "../../utils/formatters";

const PAGE_SIZE = 20;
const MAX_NOTES_LENGTH = 2000;

type PaymentStatusFilter = "all" | TransactionStatus;

interface PaymentAllocation {
  id: UUID;
  payment_id: UUID;
  invoice_id: UUID;
  invoice_number: string;
  allocated_amount: string;
}

interface PaymentRecord {
  id: UUID;
  payment_number: string;
  customer_id: UUID;
  customer_name: string;
  payment_date: string;
  amount: string;
  method: PaymentMethod;
  reference_number: string | null;
  notes: string | null;
  status: TransactionStatus;
  allocations: PaymentAllocation[];
  created_at: string;
  posted_at: string | null;
}

interface OutstandingInvoiceOption {
  id: UUID;
  invoice_number: string;
  customer_id: UUID;
  customer_name: string;
  invoice_date: string;
  status: TransactionStatus;
  payment_status: PaymentStatus;
  outstanding_amount: string;
}

interface PaymentFormState {
  customer_id: UUID;
  invoice_id: UUID;
  payment_date: string;
  amount: string;
  method: PaymentMethod;
  reference_number: string;
  notes: string;
}

interface PaymentFilters {
  page: number;
  search: string;
  status: PaymentStatusFilter;
  date_from: string;
  date_to: string;
}

const PAYMENT_METHOD_OPTIONS: ReadonlyArray<{
  value: PaymentMethod;
  label: string;
}> = [
  { value: "cash", label: "Cash" },
  { value: "bank_transfer", label: "Bank transfer" },
  { value: "upi", label: "UPI" },
  { value: "cheque", label: "Cheque" },
  { value: "other", label: "Other" },
];

const PAYMENT_STATUS_OPTIONS: ReadonlyArray<{
  value: PaymentStatusFilter;
  label: string;
}> = [
  { value: "all", label: "All statuses" },
  { value: "draft", label: "Draft" },
  { value: "posted", label: "Posted" },
  { value: "cancelled", label: "Cancelled" },
];

function todayLocal(): string {
  const date = new Date();

  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
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

function parseMoney(value: string): bigint | null {
  const normalized = value.trim();

  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    return null;
  }

  const [whole = "0", fraction = ""] =
    normalized.split(".");

  return (
    BigInt(whole) * 100n +
    BigInt(fraction.padEnd(2, "0"))
  );
}

function isPositiveMoney(value: string): boolean {
  const amount = parseMoney(value);

  return amount !== null && amount > 0n;
}

function newPaymentForm(): PaymentFormState {
  return {
    customer_id: "",
    invoice_id: "",
    payment_date: todayLocal(),
    amount: "",
    method: "bank_transfer",
    reference_number: "",
    notes: "",
  };
}

function paymentMethodLabel(method: PaymentMethod): string {
  return (
    PAYMENT_METHOD_OPTIONS.find(
      (option) => option.value === method,
    )?.label ?? method
  );
}

async function fetchPayments(
  filters: PaymentFilters,
  signal?: AbortSignal,
): Promise<PaginatedResponse<PaymentRecord>> {
  return apiClient.get<PaginatedResponse<PaymentRecord>>(
    "/payments",
    {
      query: {
        page: filters.page,
        page_size: PAGE_SIZE,
        search: filters.search || undefined,
        status:
          filters.status === "all"
            ? undefined
            : filters.status,
        date_from: filters.date_from || undefined,
        date_to: filters.date_to || undefined,
      },
      signal,
    },
  );
}

async function fetchOutstandingInvoices(
  signal?: AbortSignal,
): Promise<OutstandingInvoiceOption[]> {
  const results: OutstandingInvoiceOption[] = [];
  const pageSize = 100;
  let page = 1;
  let total = 0;

  do {
    const response = await apiClient.get<
      PaginatedResponse<OutstandingInvoiceOption>
    >("/invoices", {
      query: {
        page,
        page_size: pageSize,
        status: "posted",
      },
      signal,
    });

    results.push(...response.items);
    total = response.total;

    if (response.items.length === 0) {
      break;
    }

    page += 1;
  } while (results.length < total);

  return results.filter((invoice) => {
    const outstanding = parseMoney(
      invoice.outstanding_amount,
    );

    return (
      invoice.status === "posted" &&
      outstanding !== null &&
      outstanding > 0n
    );
  });
}

async function createPayment(
  payload: {
    customer_id: UUID;
    payment_date: string;
    amount: string;
    method: PaymentMethod;
    reference_number: string | null;
    notes: string | null;
    allocations: Array<{
      invoice_id: UUID;
      amount: string;
    }>;
  },
  idempotencyKey: string,
): Promise<PaymentRecord> {
  return apiClient.post<PaymentRecord>(
    "/payments",
    payload,
    { idempotencyKey },
  );
}

async function postPayment(
  paymentId: UUID,
  idempotencyKey: string,
): Promise<PaymentRecord> {
  return apiClient.post<PaymentRecord>(
    `/payments/${encodeURIComponent(paymentId)}/post`,
    {},
    { idempotencyKey },
  );
}

async function fetchPaymentDetails(
  paymentId: UUID,
  signal?: AbortSignal,
): Promise<PaymentRecord> {
  return apiClient.get<PaymentRecord>(
    `/payments/${encodeURIComponent(paymentId)}`,
    { signal },
  );
}

export function PaymentsPage() {
  const { user } = useAuth();
  const { isOnline } = useOnlineStatus();

  const canAccess =
    user?.role === USER_ROLES.FACTORY_ADMIN ||
    user?.role === USER_ROLES.ACCOUNTANT_AUDITOR ||
    user?.role === USER_ROLES.OWNER;

  const canManage =
    user?.role === USER_ROLES.FACTORY_ADMIN;

  const [payments, setPayments] =
    useState<PaymentRecord[]>([]);

  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  const [statusFilter, setStatusFilter] =
    useState<PaymentStatusFilter>("all");

  const [dateFromInput, setDateFromInput] = useState("");
  const [dateToInput, setDateToInput] = useState("");

  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const [filterError, setFilterError] =
    useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [success, setSuccess] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);

  const [form, setForm] =
    useState<PaymentFormState>(newPaymentForm);

  const [outstandingInvoices, setOutstandingInvoices] =
    useState<OutstandingInvoiceOption[]>([]);

  const [invoicesLoading, setInvoicesLoading] =
    useState(false);

  const [invoicesError, setInvoicesError] =
    useState<string | null>(null);

  const [formError, setFormError] =
    useState<string | null>(null);

  const [creating, setCreating] = useState(false);

  const [postTarget, setPostTarget] =
    useState<PaymentRecord | null>(null);

  const [posting, setPosting] = useState(false);
  const [postError, setPostError] =
    useState<string | null>(null);

  const [detailsTarget, setDetailsTarget] =
    useState<PaymentRecord | null>(null);

  const [detailsLoading, setDetailsLoading] =
    useState(false);

  const [detailsError, setDetailsError] =
    useState<string | null>(null);

  const createKeyRef = useRef<string | null>(null);
  const postKeyRef = useRef<string | null>(null);
  const mutationLockRef = useRef(false);

  const filters = useMemo<PaymentFilters>(
    () => ({
      page,
      search,
      status: statusFilter,
      date_from: dateFrom,
      date_to: dateTo,
    }),
    [
      page,
      search,
      statusFilter,
      dateFrom,
      dateTo,
    ],
  );

  const loadPayments = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      if (!canAccess) {
        setPayments([]);
        setTotal(0);
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const response = await fetchPayments(
          filters,
          signal,
        );

        if (!signal?.aborted) {
          setPayments(response.items);
          setTotal(response.total);
        }
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

    void loadPayments(controller.signal);

    return () => controller.abort();
  }, [loadPayments]);

  const loadOutstandingInvoices = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      if (!canManage || !isOnline) {
        return;
      }

      setInvoicesLoading(true);
      setInvoicesError(null);

      try {
        const response = await fetchOutstandingInvoices(
          signal,
        );

        if (!signal?.aborted) {
          setOutstandingInvoices(response);
        }
      } catch (failure) {
        if (!signal?.aborted) {
          setInvoicesError(
            getApiErrorMessage(failure),
          );
        }
      } finally {
        if (!signal?.aborted) {
          setInvoicesLoading(false);
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

    void loadOutstandingInvoices(controller.signal);

    return () => controller.abort();
  }, [createOpen, loadOutstandingInvoices]);

  const selectedInvoice = useMemo(
    () =>
      outstandingInvoices.find(
        (invoice) => invoice.id === form.invoice_id,
      ) ?? null,
    [outstandingInvoices, form.invoice_id],
  );

  const customerOptions = useMemo(() => {
    const customers = new Map<
      UUID,
      { id: UUID; name: string }
    >();

    for (const invoice of outstandingInvoices) {
      if (!customers.has(invoice.customer_id)) {
        customers.set(invoice.customer_id, {
          id: invoice.customer_id,
          name: invoice.customer_name,
        });
      }
    }

    return [...customers.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }, [outstandingInvoices]);

  const customerInvoices = useMemo(
    () =>
      outstandingInvoices.filter(
        (invoice) =>
          invoice.customer_id === form.customer_id,
      ),
    [outstandingInvoices, form.customer_id],
  );

  const openCreate = (): void => {
    if (
      !canManage ||
      !isOnline ||
      creating ||
      posting
    ) {
      return;
    }

    setForm(newPaymentForm());
    setOutstandingInvoices([]);
    setInvoicesError(null);
    setFormError(null);
    setSuccess(null);

    createKeyRef.current = null;
    setCreateOpen(true);
  };

  const closeCreate = (): void => {
    if (creating) {
      return;
    }

    setCreateOpen(false);
    setFormError(null);
    createKeyRef.current = null;
  };

  const updateForm = <K extends keyof PaymentFormState>(
    field: K,
    value: PaymentFormState[K],
  ): void => {
    setForm((current) => ({
      ...current,
      [field]: value,
    }));

    setFormError(null);
    createKeyRef.current = null;
  };

  const selectCustomer = (customerId: UUID): void => {
    setForm((current) => ({
      ...current,
      customer_id: customerId,
      invoice_id: "",
      amount: "",
    }));

    setFormError(null);
    createKeyRef.current = null;
  };

  const selectInvoice = (invoiceId: UUID): void => {
    setForm((current) => ({
      ...current,
      invoice_id: invoiceId,
      amount: "",
    }));

    setFormError(null);
    createKeyRef.current = null;
  };

  const validateForm = (): string | null => {
    if (!canManage || !isOnline) {
      return "Payment recording requires an authorized online session.";
    }

    if (!form.customer_id) {
      return "Select a customer.";
    }

    if (!selectedInvoice) {
      return "Select an outstanding invoice.";
    }

    if (
      selectedInvoice.customer_id !== form.customer_id ||
      selectedInvoice.status !== "posted"
    ) {
      return "The selected invoice is not eligible for payment.";
    }

    if (!isValidDate(form.payment_date)) {
      return "Enter a valid payment date.";
    }

    if (!isPositiveMoney(form.amount)) {
      return "Enter a positive payment amount with at most two decimal places.";
    }

    const amount = parseMoney(form.amount);
    const outstanding = parseMoney(
      selectedInvoice.outstanding_amount,
    );

    if (
      amount === null ||
      outstanding === null ||
      amount > outstanding
    ) {
      return "Payment amount cannot exceed the current displayed invoice outstanding balance.";
    }

    if (
      !PAYMENT_METHOD_OPTIONS.some(
        (option) => option.value === form.method,
      )
    ) {
      return "Select a valid payment method.";
    }

    if (
      form.reference_number.trim().length > 100
    ) {
      return "Payment reference cannot exceed 100 characters.";
    }

    if (form.notes.length > MAX_NOTES_LENGTH) {
      return "Payment notes exceed the permitted length.";
    }

    return null;
  };

  const submitCreate = async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();

    if (
      !canManage ||
      !isOnline ||
      creating ||
      mutationLockRef.current
    ) {
      return;
    }

    const validationError = validateForm();

    if (validationError) {
      setFormError(validationError);
      return;
    }

    const idempotencyKey =
      createKeyRef.current ?? crypto.randomUUID();

    createKeyRef.current = idempotencyKey;
    mutationLockRef.current = true;

    setCreating(true);
    setFormError(null);
    setSuccess(null);

    try {
      const result = await createPayment(
        {
          customer_id: form.customer_id,
          payment_date: form.payment_date,
          amount: form.amount.trim(),
          method: form.method,
          reference_number:
            form.reference_number.trim() || null,
          notes: form.notes.trim() || null,
          allocations: [
            {
              invoice_id: form.invoice_id,
              amount: form.amount.trim(),
            },
          ],
        },
        idempotencyKey,
      );

      if (
        !result.id ||
        result.customer_id !== form.customer_id
      ) {
        throw new Error(
          "The backend response did not confirm the requested payment. Refresh the payment register before retrying.",
        );
      }

      setCreateOpen(false);
      createKeyRef.current = null;

      setSuccess(
        `Payment ${result.payment_number} was recorded with status "${result.status}". Invoice balances are updated only when the backend confirms the applicable posting operation.`,
      );

      setPage(1);
      await loadPayments();
    } catch (failure) {
      setFormError(getApiErrorMessage(failure));
    } finally {
      mutationLockRef.current = false;
      setCreating(false);
    }
  };

  const openPost = (payment: PaymentRecord): void => {
    if (
      !canManage ||
      !isOnline ||
      payment.status !== "draft" ||
      posting ||
      creating
    ) {
      return;
    }

    postKeyRef.current = null;
    setPostError(null);
    setSuccess(null);
    setPostTarget(payment);
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
      postKeyRef.current ?? crypto.randomUUID();

    postKeyRef.current = idempotencyKey;
    mutationLockRef.current = true;

    setPosting(true);
    setPostError(null);
    setSuccess(null);

    try {
      const result = await postPayment(
        postTarget.id,
        idempotencyKey,
      );

      if (
        result.id !== postTarget.id ||
        result.status !== "posted"
      ) {
        throw new Error(
          "The backend did not confirm payment posting. Refresh the payment register before retrying.",
        );
      }

      setSuccess(
        `Payment ${result.payment_number} was posted successfully. Invoice balances are maintained by the backend.`,
      );

      setPostTarget(null);
      postKeyRef.current = null;

      await loadPayments();
    } catch (failure) {
      setPostError(getApiErrorMessage(failure));
    } finally {
      mutationLockRef.current = false;
      setPosting(false);
    }
  };

  const openDetails = async (
    payment: PaymentRecord,
  ): Promise<void> => {
    setDetailsTarget(payment);
    setDetailsLoading(true);
    setDetailsError(null);

    try {
      const result = await fetchPaymentDetails(
        payment.id,
      );

      setDetailsTarget(result);
    } catch (failure) {
      setDetailsError(getApiErrorMessage(failure));
    } finally {
      setDetailsLoading(false);
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
    setStatusFilter("all");
    setDateFromInput("");
    setDateToInput("");
    setDateFrom("");
    setDateTo("");
    setFilterError(null);
    setPage(1);
  };

  const columns = useMemo<
    DataTableColumn<PaymentRecord>[]
  >(
    () => [
      {
        key: "payment_number",
        header: "Payment",
        render: (payment) => (
          <div>
            <p className="font-semibold text-text-primary">
              {payment.payment_number}
            </p>

            <p className="mt-1 text-xs text-text-muted">
              {formatDate(payment.payment_date)}
            </p>
          </div>
        ),
      },
      {
        key: "customer",
        header: "Customer",
        render: (payment) => (
          <span className="font-medium text-text-primary">
            {payment.customer_name}
          </span>
        ),
      },
      {
        key: "method",
        header: "Method",
        render: (payment) => (
          <div>
            <p>{paymentMethodLabel(payment.method)}</p>

            {payment.reference_number && (
              <p className="mt-1 break-all text-xs text-text-muted">
                Ref: {payment.reference_number}
              </p>
            )}
          </div>
        ),
      },
      {
        key: "amount",
        header: "Amount",
        numeric: true,
        render: (payment) => (
          <span className="app-numeric font-semibold">
            {formatCurrency(payment.amount)}
          </span>
        ),
      },
      {
        key: "allocations",
        header: "Invoices",
        numeric: true,
        render: (payment) => (
          <span className="app-numeric">
            {payment.allocations?.length ?? 0}
          </span>
        ),
      },
      {
        key: "status",
        header: "Status",
        render: (payment) => (
          <StatusBadge
            status={payment.status}
            category="transaction"
            showDot
          />
        ),
      },
      {
        key: "actions",
        header: "Actions",
        align: "right",
        render: (payment) => (
          <div className="flex flex-wrap justify-end gap-3">
            <button
              type="button"
              onClick={() => {
                void openDetails(payment);
              }}
              className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline"
            >
              <Eye size={15} aria-hidden="true" />
              Details
            </button>

            {canManage && payment.status === "draft" && (
              <button
                type="button"
                onClick={() => openPost(payment)}
                disabled={!isOnline || posting || creating}
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
          Payment Collections
        </h2>

        <div
          role="alert"
          className="app-alert app-alert-error"
        >
          Payment access is restricted to authorized
          Factory Admin, Accountant/Auditor, and Owner roles.
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
            <Wallet
              size={27}
              className="text-primary"
              aria-hidden="true"
            />

            <h2 className="app-page-title">
              Payment Collections
            </h2>
          </div>

          <p className="app-page-description">
            Record customer receipts, allocate payments
            against posted GST invoices, and review
            backend-confirmed payment transactions.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Link
            to="/payments/outstanding"
            className="app-button app-button-secondary inline-flex items-center gap-2"
          >
            <ArrowUpRight size={17} aria-hidden="true" />
            Outstanding
          </Link>

          <button
            type="button"
            onClick={() => {
              void loadPayments();
            }}
            disabled={loading || creating || posting}
            className="app-button app-button-secondary inline-flex items-center gap-2"
          >
            <RefreshCw
              size={17}
              className={
                loading ? "motion-safe:animate-spin" : ""
              }
              aria-hidden="true"
            />
            Refresh
          </button>

          {canManage && (
            <button
              type="button"
              onClick={openCreate}
              disabled={!isOnline || creating || posting}
              className="app-button app-button-primary inline-flex items-center gap-2"
            >
              <Plus size={17} aria-hidden="true" />
              Record payment
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
            The device is offline. Payment recording,
            posting, and outstanding-balance validation
            require a backend connection. Financial
            transactions are not queued offline.
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

      <section className="rounded-card border border-border bg-surface p-4">
        <div className="flex items-start gap-3">
          <CreditCard
            size={21}
            className="mt-0.5 shrink-0 text-primary"
            aria-hidden="true"
          />

          <div>
            <h3 className="text-sm font-semibold text-text-primary">
              Payment controls
            </h3>

            <p className="mt-1 text-xs leading-5 text-text-muted">
              Payments are allocated to posted invoices.
              The backend must validate customer ownership,
              invoice eligibility, available outstanding
              balances, monetary precision, concurrent
              collections, and idempotency. Draft payments
              do not reduce outstanding balances until
              the backend confirms posting.
            </p>
          </div>
        </div>
      </section>

      <section className="app-card space-y-5">
        <div>
          <h3 className="text-base font-semibold text-text-primary">
            Payment register
          </h3>

          <p className="mt-1 text-sm text-text-muted">
            Search receipts and review payment status.
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

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <div>
              <label
                htmlFor="payment-search"
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
                  id="payment-search"
                  type="search"
                  value={searchInput}
                  onChange={(event) =>
                    setSearchInput(event.target.value)
                  }
                  placeholder="Payment, customer, reference..."
                  className="app-input w-full pl-10"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="payment-status-filter"
                className="app-field-label mb-2 block"
              >
                Status
              </label>

              <select
                id="payment-status-filter"
                value={statusFilter}
                onChange={(event) => {
                  setStatusFilter(
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
                htmlFor="payment-date-from"
                className="app-field-label mb-2 block"
              >
                Date from
              </label>

              <input
                id="payment-date-from"
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
                htmlFor="payment-date-to"
                className="app-field-label mb-2 block"
              >
                Date to
              </label>

              <input
                id="payment-date-to"
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
              <FilterX size={16} aria-hidden="true" />
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

        {loading && payments.length === 0 ? (
          <LoadingState
            variant="section"
            message="Loading payments..."
          />
        ) : (
          <DataTable<PaymentRecord>
            columns={columns}
            data={payments}
            getRowId={(payment) => payment.id}
            loading={loading}
            error={error}
            onRetry={() => loadPayments()}
            emptyMessage="No payments found"
            emptyDescription="No payment records match the selected filters."
            pagination={{
              page,
              pageSize: PAGE_SIZE,
              total,
              onPageChange: setPage,
            }}
            testId="payments-register-table"
          />
        )}
      </section>

      {createOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3 sm:p-5">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-payment-title"
            className="flex max-h-[95vh] w-full max-w-2xl flex-col overflow-hidden rounded-card border border-border bg-surface shadow-xl"
          >
            <header className="flex items-start justify-between gap-4 border-b border-border p-5">
              <div>
                <h3
                  id="create-payment-title"
                  className="text-lg font-semibold text-text-primary"
                >
                  Record customer payment
                </h3>

                <p className="mt-1 text-sm text-text-muted">
                  Allocate a receipt against an outstanding
                  posted invoice.
                </p>
              </div>

              <button
                type="button"
                onClick={closeCreate}
                disabled={creating}
                aria-label="Close payment form"
                className="rounded-control p-2 text-text-muted hover:bg-background"
              >
                <X size={20} aria-hidden="true" />
              </button>
            </header>

            <form
              onSubmit={(event) => {
                void submitCreate(event);
              }}
              className="flex min-h-0 flex-1 flex-col"
            >
              <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
                {formError && (
                  <div
                    role="alert"
                    className="app-alert app-alert-error"
                  >
                    <p>{formError}</p>

                    <p className="mt-2 text-xs">
                      If a network response was interrupted,
                      check the payment register before retrying.
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

                {invoicesLoading ? (
                  <LoadingState
                    variant="section"
                    message="Loading outstanding invoices..."
                  />
                ) : (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <label
                        htmlFor="payment-customer"
                        className="app-field-label mb-2 block"
                      >
                        Customer *
                      </label>

                      <select
                        id="payment-customer"
                        value={form.customer_id}
                        onChange={(event) =>
                          selectCustomer(event.target.value)
                        }
                        required
                        disabled={creating}
                        className="app-select w-full"
                      >
                        <option value="">
                          Select customer
                        </option>

                        {customerOptions.map((customer) => (
                          <option
                            key={customer.id}
                            value={customer.id}
                          >
                            {customer.name}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label
                        htmlFor="payment-invoice"
                        className="app-field-label mb-2 block"
                      >
                        Outstanding invoice *
                      </label>

                      <select
                        id="payment-invoice"
                        value={form.invoice_id}
                        onChange={(event) =>
                          selectInvoice(event.target.value)
                        }
                        required
                        disabled={
                          creating || !form.customer_id
                        }
                        className="app-select w-full"
                      >
                        <option value="">
                          Select invoice
                        </option>

                        {customerInvoices.map((invoice) => (
                          <option
                            key={invoice.id}
                            value={invoice.id}
                          >
                            {invoice.invoice_number} —{" "}
                            {formatCurrency(
                              invoice.outstanding_amount,
                            )}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}

                {!invoicesLoading &&
                  outstandingInvoices.length === 0 &&
                  !invoicesError && (
                    <p className="text-sm text-text-muted">
                      No outstanding posted invoices were
                      returned.
                    </p>
                  )}

                {selectedInvoice && (
                  <div className="rounded-control border border-border bg-background p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-text-primary">
                          {selectedInvoice.invoice_number}
                        </p>

                        <p className="mt-1 text-xs text-text-muted">
                          Invoice date:{" "}
                          {formatDate(
                            selectedInvoice.invoice_date,
                          )}
                        </p>
                      </div>

                      <StatusBadge
                        status={selectedInvoice.payment_status}
                        category="payment"
                      />
                    </div>

                    <p className="mt-4 text-xs text-text-muted">
                      Current displayed outstanding
                    </p>

                    <p className="mt-1 text-xl font-bold text-text-primary">
                      {formatCurrency(
                        selectedInvoice.outstanding_amount,
                      )}
                    </p>

                    <Link
                      to={`/invoices/${encodeURIComponent(selectedInvoice.id)}`}
                      className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline"
                    >
                      View invoice
                      <ArrowUpRight
                        size={15}
                        aria-hidden="true"
                      />
                    </Link>
                  </div>
                )}

                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label
                      htmlFor="payment-date"
                      className="app-field-label mb-2 block"
                    >
                      Payment date *
                    </label>

                    <input
                      id="payment-date"
                      type="date"
                      value={form.payment_date}
                      onChange={(event) =>
                        updateForm(
                          "payment_date",
                          event.target.value,
                        )
                      }
                      required
                      disabled={creating}
                      className="app-input w-full"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="payment-amount"
                      className="app-field-label mb-2 block"
                    >
                      Amount (INR) *
                    </label>

                    <input
                      id="payment-amount"
                      type="text"
                      inputMode="decimal"
                      value={form.amount}
                      onChange={(event) =>
                        updateForm(
                          "amount",
                          event.target.value,
                        )
                      }
                      required
                      disabled={creating}
                      placeholder="0.00"
                      className="app-input w-full"
                    />

                    <p className="app-field-help mt-1">
                      Maximum two decimal places.
                    </p>
                  </div>

                  <div>
                    <label
                      htmlFor="payment-method"
                      className="app-field-label mb-2 block"
                    >
                      Payment method *
                    </label>

                    <select
                      id="payment-method"
                      value={form.method}
                      onChange={(event) =>
                        updateForm(
                          "method",
                          event.target.value as PaymentMethod,
                        )
                      }
                      required
                      disabled={creating}
                      className="app-select w-full"
                    >
                      {PAYMENT_METHOD_OPTIONS.map((option) => (
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
                      htmlFor="payment-reference"
                      className="app-field-label mb-2 block"
                    >
                      Transaction reference
                    </label>

                    <input
                      id="payment-reference"
                      type="text"
                      value={form.reference_number}
                      onChange={(event) =>
                        updateForm(
                          "reference_number",
                          event.target.value,
                        )
                      }
                      maxLength={100}
                      disabled={creating}
                      className="app-input w-full"
                    />
                  </div>
                </div>

                <div>
                  <label
                    htmlFor="payment-notes"
                    className="app-field-label mb-2 block"
                  >
                    Notes
                  </label>

                  <textarea
                    id="payment-notes"
                    value={form.notes}
                    onChange={(event) =>
                      updateForm(
                        "notes",
                        event.target.value,
                      )
                    }
                    rows={3}
                    maxLength={MAX_NOTES_LENGTH}
                    disabled={creating}
                    className="app-textarea w-full"
                  />
                </div>

                <div className="rounded-control border border-border bg-background p-4 text-xs leading-5 text-text-muted">
                  Outstanding amounts are snapshots.
                  The backend must revalidate the
                  selected invoice, monetary precision,
                  customer ownership, and remaining balance
                  when creating and posting the payment.
                  Recording a draft does not reduce the
                  outstanding balance.
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
                  type="submit"
                  disabled={
                    creating ||
                    !isOnline ||
                    invoicesLoading ||
                    !selectedInvoice
                  }
                  className="app-button app-button-primary inline-flex items-center gap-2"
                >
                  <Plus size={17} aria-hidden="true" />
                  {creating
                    ? "Recording..."
                    : "Record draft payment"}
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
            aria-labelledby="payment-details-title"
            className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-card border border-border bg-surface shadow-xl"
          >
            <header className="flex items-start justify-between gap-4 border-b border-border p-5">
              <div>
                <h3
                  id="payment-details-title"
                  className="text-lg font-semibold text-text-primary"
                >
                  Payment {detailsTarget.payment_number}
                </h3>

                <p className="mt-1 text-sm text-text-muted">
                  {detailsTarget.customer_name}
                </p>
              </div>

              <button
                type="button"
                onClick={() => setDetailsTarget(null)}
                aria-label="Close payment details"
                className="rounded-control p-2 text-text-muted hover:bg-background"
              >
                <X size={20} aria-hidden="true" />
              </button>
            </header>

            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
              {detailsLoading && (
                <LoadingState
                  variant="section"
                  message="Loading payment details..."
                />
              )}

              {detailsError && (
                <div
                  role="alert"
                  className="app-alert app-alert-error"
                >
                  {detailsError}
                </div>
              )}

              {!detailsLoading && !detailsError && (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <StatusBadge
                      status={detailsTarget.status}
                      category="transaction"
                      showDot
                    />

                    <p className="text-xl font-bold text-text-primary">
                      {formatCurrency(detailsTarget.amount)}
                    </p>
                  </div>

                  <dl className="grid gap-4 text-sm sm:grid-cols-2">
                    <div>
                      <dt className="text-text-muted">
                        Payment date
                      </dt>

                      <dd className="mt-1 font-medium">
                        {formatDate(
                          detailsTarget.payment_date,
                        )}
                      </dd>
                    </div>

                    <div>
                      <dt className="text-text-muted">
                        Payment method
                      </dt>

                      <dd className="mt-1 font-medium">
                        {paymentMethodLabel(
                          detailsTarget.method,
                        )}
                      </dd>
                    </div>

                    <div>
                      <dt className="text-text-muted">
                        Reference
                      </dt>

                      <dd className="mt-1 break-all font-medium">
                        {detailsTarget.reference_number ??
                          "Not recorded"}
                      </dd>
                    </div>

                    <div>
                      <dt className="text-text-muted">
                        Posted at
                      </dt>

                      <dd className="mt-1 font-medium">
                        {detailsTarget.posted_at
                          ? formatDateTime(
                              detailsTarget.posted_at,
                            )
                          : "Not posted"}
                      </dd>
                    </div>
                  </dl>

                  <section>
                    <h4 className="mb-3 font-semibold text-text-primary">
                      Invoice allocations
                    </h4>

                    <div className="app-table-container">
                      <table className="app-table w-full">
                        <thead>
                          <tr>
                            <th scope="col">
                              Invoice
                            </th>

                            <th
                              scope="col"
                              className="text-right"
                            >
                              Allocated amount
                            </th>
                          </tr>
                        </thead>

                        <tbody>
                          {detailsTarget.allocations?.map(
                            (allocation) => (
                              <tr key={allocation.id}>
                                <td>
                                  <Link
                                    to={`/invoices/${encodeURIComponent(allocation.invoice_id)}`}
                                    className="font-medium text-accent hover:underline"
                                  >
                                    {allocation.invoice_number}
                                  </Link>
                                </td>

                                <td className="app-numeric text-right">
                                  {formatCurrency(
                                    allocation.allocated_amount,
                                  )}
                                </td>
                              </tr>
                            ),
                          )}

                          {!detailsTarget.allocations?.length && (
                            <tr>
                              <td
                                colSpan={2}
                                className="py-6 text-center text-text-muted"
                              >
                                No allocations were returned.
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </section>

                  {detailsTarget.notes && (
                    <section>
                      <h4 className="text-sm font-semibold text-text-primary">
                        Notes
                      </h4>

                      <p className="mt-2 whitespace-pre-wrap text-sm text-text-muted">
                        {detailsTarget.notes}
                      </p>
                    </section>
                  )}
                </>
              )}
            </div>

            <footer className="flex justify-end border-t border-border p-5">
              <button
                type="button"
                onClick={() => setDetailsTarget(null)}
                className="app-button app-button-secondary"
              >
                Close
              </button>
            </footer>
          </section>
        </div>
      )}

      <ConfirmDialog
        open={postTarget !== null}
        title="Post customer payment"
        message={
          postTarget
            ? `Post payment ${postTarget.payment_number}?`
            : ""
        }
        description="Posting is a financial transaction. The backend must atomically revalidate invoice allocations and outstanding balances before recording the payment and updating receivables."
        variant="warning"
        confirmLabel="Post payment"
        cancelLabel="Cancel"
        isLoading={posting}
        onCancel={closePost}
        onConfirm={submitPost}
      >
        {postTarget && (
          <div className="space-y-3 rounded-control border border-border p-4 text-sm">
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
                Payment amount
              </span>

              <span className="app-numeric font-semibold">
                {formatCurrency(postTarget.amount)}
              </span>
            </div>

            <div className="flex justify-between gap-4">
              <span className="text-text-muted">
                Payment method
              </span>

              <span className="font-medium">
                {paymentMethodLabel(postTarget.method)}
              </span>
            </div>
          </div>
        )}

        {postError && (
          <div
            role="alert"
            className="app-alert app-alert-error"
          >
            <div className="flex items-start gap-2">
              <AlertCircle
                size={18}
                className="shrink-0"
                aria-hidden="true"
              />

              <div>
                <p>{postError}</p>

                <p className="mt-2 text-xs">
                  If the response was interrupted,
                  verify the payment status and invoice
                  balances before retrying.
                </p>
              </div>
            </div>
          </div>
        )}
      </ConfirmDialog>
    </div>
  );
}

export default PaymentsPage;