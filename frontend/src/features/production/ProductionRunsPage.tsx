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
  ArrowRight,
  CalendarDays,
  ClipboardList,
  Factory,
  PackageCheck,
  Plus,
  RefreshCw,
  Search,
  X,
} from "lucide-react";

import { Link } from "react-router-dom";

import type {
  PaginatedResponse,
  ProductionStatus,
  UUID,
} from "../../types/business";

import { USER_ROLES } from "../../types/auth";
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
  formatDate,
  formatDateTime,
  formatQuantity,
} from "../../utils/formatters";

const PAGE_SIZE = 20;
const LOOKUP_PAGE_SIZE = 100;

type StatusFilter = "all" | ProductionStatus;

interface ProductionRun {
  id: UUID;
  run_number: string;
  product_id: UUID;
  product_code: string;
  product_name: string;
  bom_id: UUID;
  bom_version: number;
  status: ProductionStatus;
  planned_quantity: string;
  actual_good_quantity: string | null;
  rejected_quantity: string | null;
  production_date: string;
  started_at: string | null;
  completed_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string | null;
  created_by: UUID | null;
}

interface ProductionBOMOption {
  id: UUID;
  product_id: UUID;
  product_code: string;
  product_name: string;
  version: number;
  is_active: boolean;
  effective_from: string;
  effective_to: string | null;
  standard_batch_size: string;
  expected_output: string;
}

interface CreateProductionRunInput {
  bom_id: UUID;
  production_date: string;
  planned_quantity: string;
  notes: string | null;
}

interface ProductionRunFilters {
  page: number;
  search: string;
  status: StatusFilter;
  dateFrom: string;
  dateTo: string;
}

interface CreateRunForm {
  bom_id: string;
  production_date: string;
  planned_quantity: string;
  notes: string;
}

const EMPTY_CREATE_FORM: CreateRunForm = {
  bom_id: "",
  production_date: "",
  planned_quantity: "",
  notes: "",
};

function isPositiveDecimal(value: string): boolean {
  const normalized = value.trim();

  return (
    /^\d+(?:\.\d+)?$/.test(normalized) &&
    /[1-9]/.test(normalized.replace(".", ""))
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

function getStatusLabel(status: ProductionStatus): string {
  switch (status) {
    case "draft":
      return "Draft";
    case "in_progress":
      return "In progress";
    case "completed":
      return "Completed";
    case "cancelled":
      return "Cancelled";
  }
}

function formatOptionalQuantity(
  value: string | null,
): string {
  return value === null ? "—" : formatQuantity(value);
}

function getRunRoute(runId: UUID): string {
  return `/production/runs/${encodeURIComponent(runId)}`;
}

async function fetchProductionRuns(
  filters: ProductionRunFilters,
  signal?: AbortSignal,
): Promise<PaginatedResponse<ProductionRun>> {
  return apiClient.get<PaginatedResponse<ProductionRun>>(
    "/production/runs",
    {
      query: {
        page: filters.page,
        page_size: PAGE_SIZE,
        search: filters.search || undefined,
        status:
          filters.status === "all"
            ? undefined
            : filters.status,
        date_from: filters.dateFrom || undefined,
        date_to: filters.dateTo || undefined,
      },
      signal,
    },
  );
}

async function fetchProductionRun(
  runId: UUID,
  signal?: AbortSignal,
): Promise<ProductionRun> {
  return apiClient.get<ProductionRun>(
    `/production/runs/${encodeURIComponent(runId)}`,
    { signal },
  );
}

async function fetchActiveBOMs(
  signal: AbortSignal,
): Promise<ProductionBOMOption[]> {
  const collected: ProductionBOMOption[] = [];
  let page = 1;

  while (!signal.aborted) {
    const response = await apiClient.get<
      PaginatedResponse<ProductionBOMOption>
    >("/production/boms", {
      query: {
        page,
        page_size: LOOKUP_PAGE_SIZE,
        is_active: true,
      },
      signal,
    });

    collected.push(...response.items);

    if (
      response.items.length === 0 ||
      collected.length >= response.total
    ) {
      break;
    }

    page += 1;
  }

  return collected.filter((bom) => bom.is_active);
}

async function createProductionRun(
  payload: CreateProductionRunInput,
  idempotencyKey: string,
): Promise<ProductionRun> {
  return apiClient.post<ProductionRun>(
    "/production/runs",
    payload,
    { idempotencyKey },
  );
}

async function startProductionRun(
  runId: UUID,
  idempotencyKey: string,
): Promise<ProductionRun> {
  return apiClient.post<ProductionRun>(
    `/production/runs/${encodeURIComponent(runId)}/start`,
    undefined,
    { idempotencyKey },
  );
}

async function cancelProductionRun(
  runId: UUID,
  idempotencyKey: string,
): Promise<ProductionRun> {
  return apiClient.post<ProductionRun>(
    `/production/runs/${encodeURIComponent(runId)}/cancel`,
    undefined,
    { idempotencyKey },
  );
}

interface RunDetailsProps {
  run: ProductionRun;
  onClose: () => void;
}

function RunDetails({ run, onClose }: RunDetailsProps) {
  const details: Array<{
    label: string;
    value: string;
  }> = [
    {
      label: "Run number",
      value: run.run_number,
    },
    {
      label: "Finished product",
      value: run.product_name,
    },
    {
      label: "Product code",
      value: run.product_code,
    },
    {
      label: "BOM version",
      value: String(run.bom_version),
    },
    {
      label: "Production date",
      value: formatDate(run.production_date),
    },
    {
      label: "Status",
      value: getStatusLabel(run.status),
    },
    {
      label: "Planned quantity",
      value: formatQuantity(run.planned_quantity),
    },
    {
      label: "Actual good quantity",
      value: formatOptionalQuantity(
        run.actual_good_quantity,
      ),
    },
    {
      label: "Rejected quantity",
      value: formatOptionalQuantity(
        run.rejected_quantity,
      ),
    },
    {
      label: "Started at",
      value: run.started_at
        ? formatDateTime(run.started_at)
        : "Not started",
    },
    {
      label: "Completed at",
      value: run.completed_at
        ? formatDateTime(run.completed_at)
        : "Not completed",
    },
    {
      label: "Created at",
      value: formatDateTime(run.created_at),
    },
    {
      label: "Last updated",
      value: run.updated_at
        ? formatDateTime(run.updated_at)
        : "—",
    },
    {
      label: "Created by",
      value: run.created_by ?? "—",
    },
    {
      label: "Run reference",
      value: run.id,
    },
    {
      label: "BOM reference",
      value: run.bom_id,
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <StatusBadge
          status={run.status}
          category="production"
          showDot
        />
      </div>

      <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
        {details.map((detail) => (
          <div
            key={detail.label}
            className="min-w-0 border-b border-border pb-3"
          >
            <dt className="text-xs font-medium text-text-muted">
              {detail.label}
            </dt>

            <dd className="mt-1 break-words text-sm font-medium text-text-primary">
              {detail.value}
            </dd>
          </div>
        ))}
      </dl>

      {run.notes && (
        <div>
          <h4 className="text-sm font-semibold text-text-primary">
            Production notes
          </h4>

          <p className="mt-2 whitespace-pre-wrap rounded-control bg-background p-4 text-sm text-text-muted">
            {run.notes}
          </p>
        </div>
      )}

      <div className="rounded-control border border-border bg-background p-4">
        <p className="text-xs leading-5 text-text-muted">
          Planned quantities and actual production
          results are distinct. Material consumption,
          wastage, finished-goods receipts, batch
          traceability, and costing are maintained
          through backend-controlled production
          transactions.
        </p>
      </div>

      <div className="flex flex-wrap justify-end gap-3">
        <button
          type="button"
          onClick={onClose}
          className="app-button app-button-secondary"
        >
          Close
        </button>

        <Link
          to={getRunRoute(run.id)}
          className="app-button app-button-primary inline-flex items-center gap-2"
        >
          Open production run
          <ArrowRight size={16} aria-hidden="true" />
        </Link>
      </div>
    </div>
  );
}

export function ProductionRunsPage() {
  const { user } = useAuth();
  const { isOnline } = useOnlineStatus();

  const canViewRuns =
    user?.role === USER_ROLES.FACTORY_ADMIN ||
    user?.role === USER_ROLES.PRODUCTION_SUPERVISOR ||
    user?.role === USER_ROLES.ACCOUNTANT_AUDITOR ||
    user?.role === USER_ROLES.OWNER;

  const canManageRuns =
    user?.role === USER_ROLES.FACTORY_ADMIN ||
    user?.role === USER_ROLES.PRODUCTION_SUPERVISOR;

  const [runs, setRuns] = useState<ProductionRun[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  const [statusFilter, setStatusFilter] =
    useState<StatusFilter>("all");

  const [dateFromInput, setDateFromInput] = useState("");
  const [dateToInput, setDateToInput] = useState("");

  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const [filterError, setFilterError] =
    useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] =
    useState<CreateRunForm>(EMPTY_CREATE_FORM);

  const [boms, setBOMs] =
    useState<ProductionBOMOption[]>([]);

  const [bomsLoading, setBOMsLoading] = useState(false);
  const [bomsError, setBOMsError] =
    useState<string | null>(null);

  const [formError, setFormError] =
    useState<string | null>(null);

  const [saving, setSaving] = useState(false);

  const [selectedRun, setSelectedRun] =
    useState<ProductionRun | null>(null);

  const [detailsLoading, setDetailsLoading] =
    useState(false);

  const [detailsError, setDetailsError] =
    useState<string | null>(null);

  const [startTarget, setStartTarget] =
    useState<ProductionRun | null>(null);

  const [cancelTarget, setCancelTarget] =
    useState<ProductionRun | null>(null);

  const [processingAction, setProcessingAction] =
    useState(false);

  const [actionError, setActionError] =
    useState<string | null>(null);

  const [successMessage, setSuccessMessage] =
    useState<string | null>(null);

  const createKeyRef = useRef<string | null>(null);
  const actionKeysRef = useRef<Map<string, string>>(
    new Map(),
  );

  const detailsRequestRef = useRef(0);
  const createDialogRef = useRef<HTMLDivElement>(null);
  const detailsDialogRef = useRef<HTMLDivElement>(null);

  const filters = useMemo<ProductionRunFilters>(
    () => ({
      page,
      search,
      status: statusFilter,
      dateFrom,
      dateTo,
    }),
    [page, search, statusFilter, dateFrom, dateTo],
  );

  const selectedBOM = useMemo(
    () =>
      boms.find(
        (bom) => bom.id === createForm.bom_id,
      ),
    [boms, createForm.bom_id],
  );

  const loadRuns = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      if (!canViewRuns) {
        setRuns([]);
        setTotal(0);
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const response = await fetchProductionRuns(
          filters,
          signal,
        );

        if (signal?.aborted) {
          return;
        }

        setRuns(response.items);
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
    [canViewRuns, filters],
  );

  useEffect(() => {
    const controller = new AbortController();

    void loadRuns(controller.signal);

    return () => controller.abort();
  }, [loadRuns]);

  useEffect(() => {
    if (!createOpen || !canManageRuns) {
      return;
    }

    const controller = new AbortController();

    const loadBOMOptions = async (): Promise<void> => {
      setBOMsLoading(true);
      setBOMsError(null);

      try {
        const response = await fetchActiveBOMs(
          controller.signal,
        );

        if (!controller.signal.aborted) {
          setBOMs(response);
        }
      } catch (failure) {
        if (!controller.signal.aborted) {
          setBOMsError(getApiErrorMessage(failure));
        }
      } finally {
        if (!controller.signal.aborted) {
          setBOMsLoading(false);
        }
      }
    };

    void loadBOMOptions();

    return () => controller.abort();
  }, [createOpen, canManageRuns]);

  useEffect(() => {
    const dialog = createOpen
      ? createDialogRef.current
      : selectedRun
        ? detailsDialogRef.current
        : null;

    if (!dialog) {
      return;
    }

    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    const focusableSelector =
      "button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex='0']";

    const initialFocus =
      dialog.querySelector<HTMLElement>(
        focusableSelector,
      );

    initialFocus?.focus();

    const handleKeyDown = (
      event: KeyboardEvent,
    ): void => {
      if (event.key === "Escape") {
        if (createOpen && !saving) {
          setCreateOpen(false);
        } else if (selectedRun) {
          detailsRequestRef.current += 1;
          setSelectedRun(null);
        }
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      const elements = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          focusableSelector,
        ),
      );

      const first = elements[0];
      const last = elements[elements.length - 1];

      if (!first || !last) {
        return;
      }

      if (
        event.shiftKey &&
        document.activeElement === first
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        document.activeElement === last
      ) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener(
      "keydown",
      handleKeyDown,
    );

    return () => {
      document.removeEventListener(
        "keydown",
        handleKeyDown,
      );
      previousFocus?.focus();
    };
  }, [createOpen, selectedRun, saving]);

  const openCreate = (): void => {
    if (!canManageRuns || !isOnline) {
      return;
    }

    setCreateForm(EMPTY_CREATE_FORM);
    setFormError(null);
    setBOMsError(null);
    setActionError(null);
    setSuccessMessage(null);
    createKeyRef.current = null;
    setCreateOpen(true);
  };

  const closeCreate = (): void => {
    if (!saving) {
      setCreateOpen(false);
    }
  };

  const updateCreateForm = <
    K extends keyof CreateRunForm,
  >(
    field: K,
    value: CreateRunForm[K],
  ): void => {
    createKeyRef.current = null;
    setFormError(null);

    setCreateForm((current) => ({
      ...current,
      [field]: value,
    }));
  };

  const validateCreateForm = (): string | null => {
    if (!selectedBOM) {
      return "Select an active bill of materials.";
    }

    if (!isValidDate(createForm.production_date)) {
      return "Enter a valid production date.";
    }

    if (
      createForm.production_date <
        selectedBOM.effective_from ||
      (selectedBOM.effective_to !== null &&
        createForm.production_date >
          selectedBOM.effective_to)
    ) {
      return "The production date is outside the selected BOM's effective period.";
    }

    if (
      !isPositiveDecimal(
        createForm.planned_quantity,
      )
    ) {
      return "Planned quantity must be greater than zero.";
    }

    return null;
  };

  const handleCreate = async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();

    if (
      saving ||
      !canManageRuns ||
      !isOnline ||
      bomsLoading ||
      bomsError
    ) {
      return;
    }

    const validationError = validateCreateForm();

    if (validationError) {
      setFormError(validationError);
      return;
    }

    const idempotencyKey =
      createKeyRef.current ?? crypto.randomUUID();

    createKeyRef.current = idempotencyKey;

    setSaving(true);
    setFormError(null);

    try {
      const created = await createProductionRun(
        {
          bom_id: createForm.bom_id,
          production_date:
            createForm.production_date,
          planned_quantity:
            createForm.planned_quantity.trim(),
          notes: createForm.notes.trim() || null,
        },
        idempotencyKey,
      );

      createKeyRef.current = null;
      setCreateOpen(false);
      setSuccessMessage(
        `Production run ${created.run_number} was created with status "${getStatusLabel(created.status)}".`,
      );

      setPage(1);
      await loadRuns();
    } catch (failure) {
      setFormError(getApiErrorMessage(failure));
    } finally {
      setSaving(false);
    }
  };

  const openDetails = async (
    run: ProductionRun,
  ): Promise<void> => {
    const requestId = ++detailsRequestRef.current;

    setSelectedRun(run);
    setDetailsLoading(true);
    setDetailsError(null);

    try {
      const response = await fetchProductionRun(
        run.id,
      );

      if (detailsRequestRef.current === requestId) {
        setSelectedRun(response);
      }
    } catch (failure) {
      if (detailsRequestRef.current === requestId) {
        setDetailsError(getApiErrorMessage(failure));
      }
    } finally {
      if (detailsRequestRef.current === requestId) {
        setDetailsLoading(false);
      }
    }
  };

  const closeDetails = (): void => {
    detailsRequestRef.current += 1;
    setSelectedRun(null);
    setDetailsError(null);
  };

  const performAction = async (
    run: ProductionRun,
    action: "start" | "cancel",
  ): Promise<void> => {
    if (
      processingAction ||
      !canManageRuns ||
      !isOnline
    ) {
      return;
    }

    const actionKey = `${action}:${run.id}`;
    const existingKey =
      actionKeysRef.current.get(actionKey);

    const idempotencyKey =
      existingKey ?? crypto.randomUUID();

    actionKeysRef.current.set(
      actionKey,
      idempotencyKey,
    );

    setProcessingAction(true);
    setActionError(null);
    setSuccessMessage(null);

    try {
      const result =
        action === "start"
          ? await startProductionRun(
              run.id,
              idempotencyKey,
            )
          : await cancelProductionRun(
              run.id,
              idempotencyKey,
            );

      actionKeysRef.current.delete(actionKey);
      setStartTarget(null);
      setCancelTarget(null);

      setSuccessMessage(
        `Production run ${result.run_number} is now "${getStatusLabel(result.status)}".`,
      );

      await loadRuns();
    } catch (failure) {
      setActionError(getApiErrorMessage(failure));
      setStartTarget(null);
      setCancelTarget(null);

      await loadRuns();
    } finally {
      setProcessingAction(false);
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
    setDateFromInput("");
    setDateToInput("");
    setDateFrom("");
    setDateTo("");
    setFilterError(null);
    setPage(1);
  };

  const columns = useMemo<
    DataTableColumn<ProductionRun>[]
  >(
    () => [
      {
        key: "run_number",
        header: "Run number",
        render: (run) => (
          <button
            type="button"
            onClick={() => {
              void openDetails(run);
            }}
            className="text-left font-semibold text-accent underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-accent"
          >
            {run.run_number}
          </button>
        ),
      },
      {
        key: "production_date",
        header: "Production date",
        render: (run) =>
          formatDate(run.production_date),
      },
      {
        key: "product",
        header: "Finished product",
        render: (run) => (
          <div>
            <p className="font-medium text-text-primary">
              {run.product_name}
            </p>

            <p className="mt-1 text-xs text-text-muted">
              {run.product_code}
            </p>
          </div>
        ),
      },
      {
        key: "bom_version",
        header: "BOM",
        render: (run) => `v${run.bom_version}`,
        hideOnMobile: true,
      },
      {
        key: "planned_quantity",
        header: "Planned",
        numeric: true,
        render: (run) => (
          <span className="app-numeric">
            {formatQuantity(run.planned_quantity)}
          </span>
        ),
      },
      {
        key: "actual_good_quantity",
        header: "Good output",
        numeric: true,
        render: (run) => (
          <span className="app-numeric">
            {formatOptionalQuantity(
              run.actual_good_quantity,
            )}
          </span>
        ),
      },
      {
        key: "rejected_quantity",
        header: "Rejected",
        numeric: true,
        render: (run) => (
          <span className="app-numeric">
            {formatOptionalQuantity(
              run.rejected_quantity,
            )}
          </span>
        ),
        hideOnMobile: true,
      },
      {
        key: "status",
        header: "Status",
        render: (run) => (
          <StatusBadge
            status={run.status}
            category="production"
            showDot
          />
        ),
      },
      {
        key: "actions",
        header: "Actions",
        align: "right",
        render: (run) => (
          <div className="flex flex-wrap justify-end gap-2">
            <Link
              to={getRunRoute(run.id)}
              className="text-sm font-medium text-accent hover:underline"
            >
              Open
            </Link>

            {canManageRuns &&
              run.status === "draft" && (
                <>
                  <button
                    type="button"
                    onClick={() =>
                      setStartTarget(run)
                    }
                    disabled={
                      !isOnline || processingAction
                    }
                    className="text-sm font-medium text-success hover:underline disabled:opacity-50"
                  >
                    Start
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      setCancelTarget(run)
                    }
                    disabled={
                      !isOnline || processingAction
                    }
                    className="text-sm font-medium text-error hover:underline disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </>
              )}
          </div>
        ),
      },
    ],
    [canManageRuns, isOnline, processingAction],
  );

  if (!canViewRuns) {
    return (
      <div className="app-page space-y-5">
        <div>
          <h2 className="app-page-title">
            Production Runs
          </h2>

          <p className="app-page-description">
            Production planning, execution,
            and finished-goods recording.
          </p>
        </div>

        <div
          role="alert"
          className="app-alert app-alert-error flex items-start gap-3"
        >
          <AlertCircle
            size={20}
            className="shrink-0"
            aria-hidden="true"
          />

          <div>
            <p className="font-semibold">
              Access restricted
            </p>
            <p className="mt-1">
              Production run access is not
              available for this role.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-page space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="app-page-title">
            Production Runs
          </h2>

          <p className="app-page-description">
            Plan production against approved BOM
            versions, track run progress, and
            review actual finished output.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              void loadRuns();
            }}
            disabled={loading}
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

          {canManageRuns && (
            <button
              type="button"
              onClick={openCreate}
              disabled={!isOnline}
              className="app-button app-button-primary inline-flex items-center gap-2"
            >
              <Plus size={17} aria-hidden="true" />
              New production run
            </button>
          )}
        </div>
      </header>

      {!isOnline && (
        <div
          role="status"
          className="app-alert app-alert-warning flex items-start gap-3"
        >
          <AlertCircle
            size={19}
            className="shrink-0"
            aria-hidden="true"
          />

          <p>
            Production transactions require an
            active backend connection. Previously
            loaded information may remain visible,
            but production runs cannot be created,
            started, or cancelled offline.
          </p>
        </div>
      )}

      {actionError && (
        <div
          role="alert"
          className="app-alert app-alert-error"
        >
          {actionError}
        </div>
      )}

      {successMessage && (
        <div
          role="status"
          className="app-alert app-alert-success"
        >
          {successMessage}
        </div>
      )}

      <section
        aria-label="Production workflow overview"
        className="grid gap-4 md:grid-cols-3"
      >
        <div className="flex items-start gap-3 rounded-card border border-border bg-surface p-4">
          <ClipboardList
            size={21}
            className="mt-0.5 shrink-0 text-primary"
            aria-hidden="true"
          />

          <div>
            <h3 className="text-sm font-semibold text-text-primary">
              Plan
            </h3>

            <p className="mt-1 text-xs leading-5 text-text-muted">
              Select an effective BOM version and
              record planned production quantity.
            </p>
          </div>
        </div>

        <div className="flex items-start gap-3 rounded-card border border-border bg-surface p-4">
          <Factory
            size={21}
            className="mt-0.5 shrink-0 text-primary"
            aria-hidden="true"
          />

          <div>
            <h3 className="text-sm font-semibold text-text-primary">
              Execute
            </h3>

            <p className="mt-1 text-xs leading-5 text-text-muted">
              Record actual material consumption,
              wastage, returns, and production
              expenses in the run workflow.
            </p>
          </div>
        </div>

        <div className="flex items-start gap-3 rounded-card border border-border bg-surface p-4">
          <PackageCheck
            size={21}
            className="mt-0.5 shrink-0 text-primary"
            aria-hidden="true"
          />

          <div>
            <h3 className="text-sm font-semibold text-text-primary">
              Complete
            </h3>

            <p className="mt-1 text-xs leading-5 text-text-muted">
              Confirm good and rejected output.
              Backend posting creates finished
              stock movements and final costing.
            </p>
          </div>
        </div>
      </section>

      <section
        aria-labelledby="production-runs-list-heading"
        className="app-card space-y-5"
      >
        <div>
          <h3
            id="production-runs-list-heading"
            className="text-base font-semibold text-text-primary"
          >
            Production records
          </h3>

          <p className="mt-1 text-sm text-text-muted">
            Filter by run reference, product,
            production date, and lifecycle status.
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
                htmlFor="production-run-search"
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
                  id="production-run-search"
                  type="search"
                  value={searchInput}
                  onChange={(event) =>
                    setSearchInput(event.target.value)
                  }
                  placeholder="Run or product..."
                  className="app-input w-full pl-10"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="production-run-status"
                className="app-field-label mb-2 block"
              >
                Status
              </label>

              <select
                id="production-run-status"
                value={statusFilter}
                onChange={(event) => {
                  setPage(1);
                  setStatusFilter(
                    event.target.value as StatusFilter,
                  );
                }}
                className="app-select w-full"
              >
                <option value="all">
                  All statuses
                </option>
                <option value="draft">
                  Draft
                </option>
                <option value="in_progress">
                  In progress
                </option>
                <option value="completed">
                  Completed
                </option>
                <option value="cancelled">
                  Cancelled
                </option>
              </select>
            </div>

            <div>
              <label
                htmlFor="production-date-from"
                className="app-field-label mb-2 block"
              >
                Date from
              </label>

              <input
                id="production-date-from"
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
                htmlFor="production-date-to"
                className="app-field-label mb-2 block"
              >
                Date to
              </label>

              <input
                id="production-date-to"
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
              className="app-button app-button-secondary"
            >
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

        {loading && runs.length === 0 ? (
          <LoadingState
            variant="section"
            message="Loading production runs..."
          />
        ) : (
          <DataTable<ProductionRun>
            columns={columns}
            data={runs}
            getRowId={(run) => run.id}
            loading={loading}
            error={error}
            onRetry={() => loadRuns()}
            emptyMessage="No production runs found"
            emptyDescription={
              search ||
              statusFilter !== "all" ||
              dateFrom ||
              dateTo
                ? "Try changing the search or date filters."
                : "No production runs have been recorded."
            }
            pagination={{
              page,
              pageSize: PAGE_SIZE,
              total,
              onPageChange: setPage,
            }}
            testId="production-runs-table"
          />
        )}
      </section>

      <div className="rounded-card border border-border bg-surface p-4">
        <div className="flex items-start gap-3">
          <CalendarDays
            size={20}
            className="mt-0.5 shrink-0 text-primary"
            aria-hidden="true"
          />

          <div>
            <h3 className="text-sm font-semibold text-text-primary">
              Production transaction integrity
            </h3>

            <p className="mt-1 text-xs leading-5 text-text-muted">
              Creating or starting a run does not
              fabricate actual material consumption
              or finished-goods output. All stock
              movements, batch allocations,
              completion rules, and costing are
              enforced by backend transactions.
              Completed production records remain
              available for audit review.
            </p>
          </div>
        </div>
      </div>

      {createOpen && (
        <div
          role="presentation"
          className="fixed inset-0 z-50 flex items-center justify-center bg-text-primary/60 p-3 sm:p-6"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              closeCreate();
            }
          }}
        >
          <div
            ref={createDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-production-run-title"
            className="flex max-h-[95vh] w-full max-w-2xl flex-col overflow-hidden rounded-card bg-surface shadow-xl"
          >
            <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-5 py-4 sm:px-6">
              <div>
                <h3
                  id="create-production-run-title"
                  className="text-lg font-semibold text-text-primary"
                >
                  New production run
                </h3>

                <p className="mt-1 text-sm text-text-muted">
                  Create a production plan using an
                  active BOM version.
                </p>
              </div>

              <button
                type="button"
                onClick={closeCreate}
                disabled={saving}
                aria-label="Close production run form"
                className="rounded-control p-2 text-text-muted hover:bg-background focus-visible:outline-2 focus-visible:outline-accent"
              >
                <X size={20} aria-hidden="true" />
              </button>
            </div>

            <form
              onSubmit={(event) => {
                void handleCreate(event);
              }}
              className="min-h-0 overflow-y-auto"
            >
              <div className="space-y-5 px-5 py-5 sm:px-6">
                {formError && (
                  <div
                    role="alert"
                    className="app-alert app-alert-error"
                  >
                    {formError}
                  </div>
                )}

                {bomsError && (
                  <div
                    role="alert"
                    className="app-alert app-alert-error"
                  >
                    {bomsError}
                  </div>
                )}

                <div>
                  <label
                    htmlFor="production-run-bom"
                    className="app-field-label mb-2 block"
                  >
                    Product and BOM version *
                  </label>

                  <select
                    id="production-run-bom"
                    value={createForm.bom_id}
                    onChange={(event) =>
                      updateCreateForm(
                        "bom_id",
                        event.target.value,
                      )
                    }
                    required
                    disabled={saving || bomsLoading}
                    className="app-select w-full"
                  >
                    <option value="">
                      {bomsLoading
                        ? "Loading active BOMs..."
                        : "Select a product and BOM"}
                    </option>

                    {boms.map((bom) => (
                      <option
                        key={bom.id}
                        value={bom.id}
                      >
                        {bom.product_code} —{" "}
                        {bom.product_name} (v
                        {bom.version})
                      </option>
                    ))}
                  </select>
                </div>

                {selectedBOM && (
                  <div className="rounded-control border border-border bg-background p-4">
                    <h4 className="text-sm font-semibold text-text-primary">
                      Selected BOM
                    </h4>

                    <dl className="mt-3 grid gap-3 sm:grid-cols-2">
                      <div>
                        <dt className="text-xs text-text-muted">
                          Standard batch size
                        </dt>
                        <dd className="mt-1 text-sm font-medium">
                          {formatQuantity(
                            selectedBOM.standard_batch_size,
                          )}
                        </dd>
                      </div>

                      <div>
                        <dt className="text-xs text-text-muted">
                          Expected good output
                        </dt>
                        <dd className="mt-1 text-sm font-medium">
                          {formatQuantity(
                            selectedBOM.expected_output,
                          )}
                        </dd>
                      </div>

                      <div>
                        <dt className="text-xs text-text-muted">
                          Effective from
                        </dt>
                        <dd className="mt-1 text-sm font-medium">
                          {formatDate(
                            selectedBOM.effective_from,
                          )}
                        </dd>
                      </div>

                      <div>
                        <dt className="text-xs text-text-muted">
                          Effective to
                        </dt>
                        <dd className="mt-1 text-sm font-medium">
                          {selectedBOM.effective_to
                            ? formatDate(
                                selectedBOM.effective_to,
                              )
                            : "No end date"}
                        </dd>
                      </div>
                    </dl>
                  </div>
                )}

                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label
                      htmlFor="production-run-date"
                      className="app-field-label mb-2 block"
                    >
                      Production date *
                    </label>

                    <input
                      id="production-run-date"
                      type="date"
                      value={createForm.production_date}
                      onChange={(event) =>
                        updateCreateForm(
                          "production_date",
                          event.target.value,
                        )
                      }
                      required
                      disabled={saving}
                      className="app-input w-full"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="production-run-quantity"
                      className="app-field-label mb-2 block"
                    >
                      Planned quantity *
                    </label>

                    <input
                      id="production-run-quantity"
                      type="text"
                      inputMode="decimal"
                      value={createForm.planned_quantity}
                      onChange={(event) =>
                        updateCreateForm(
                          "planned_quantity",
                          event.target.value,
                        )
                      }
                      required
                      disabled={saving}
                      placeholder="0"
                      className="app-input w-full"
                    />

                    <p className="app-field-help mt-1">
                      Planned finished-product
                      quantity. Actual output is
                      recorded during execution.
                    </p>
                  </div>
                </div>

                <div>
                  <label
                    htmlFor="production-run-notes"
                    className="app-field-label mb-2 block"
                  >
                    Production notes
                  </label>

                  <textarea
                    id="production-run-notes"
                    rows={4}
                    maxLength={2000}
                    value={createForm.notes}
                    onChange={(event) =>
                      updateCreateForm(
                        "notes",
                        event.target.value,
                      )
                    }
                    disabled={saving}
                    placeholder="Optional production planning notes"
                    className="app-textarea w-full"
                  />
                </div>

                <div className="rounded-control border border-border bg-background p-4">
                  <p className="text-xs leading-5 text-text-muted">
                    The backend validates BOM
                    eligibility, production dates,
                    planned quantities, and role
                    permissions. Creating this run
                    does not consume inventory or
                    produce finished goods.
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap justify-end gap-3 border-t border-border px-5 py-4 sm:px-6">
                <button
                  type="button"
                  onClick={closeCreate}
                  disabled={saving}
                  className="app-button app-button-secondary"
                >
                  Cancel
                </button>

                <button
                  type="submit"
                  disabled={
                    saving ||
                    bomsLoading ||
                    Boolean(bomsError) ||
                    !isOnline
                  }
                  className="app-button app-button-primary"
                >
                  {saving
                    ? "Creating..."
                    : "Create production run"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {selectedRun && (
        <div
          role="presentation"
          className="fixed inset-0 z-50 flex items-center justify-center bg-text-primary/60 p-3 sm:p-6"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              closeDetails();
            }
          }}
        >
          <div
            ref={detailsDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="production-run-details-title"
            className="flex max-h-[95vh] w-full max-w-3xl flex-col overflow-hidden rounded-card bg-surface shadow-xl"
          >
            <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-5 py-4 sm:px-6">
              <div>
                <h3
                  id="production-run-details-title"
                  className="text-lg font-semibold text-text-primary"
                >
                  Production run details
                </h3>

                <p className="mt-1 text-sm text-text-muted">
                  {selectedRun.run_number}
                </p>
              </div>

              <button
                type="button"
                onClick={closeDetails}
                aria-label="Close production run details"
                className="rounded-control p-2 text-text-muted hover:bg-background focus-visible:outline-2 focus-visible:outline-accent"
              >
                <X size={20} aria-hidden="true" />
              </button>
            </div>

            <div className="min-h-0 overflow-y-auto px-5 py-5 sm:px-6">
              {detailsError && (
                <div
                  role="alert"
                  className="app-alert app-alert-error mb-4"
                >
                  {detailsError}
                </div>
              )}

              {detailsLoading ? (
                <LoadingState
                  variant="section"
                  message="Loading production run details..."
                />
              ) : !detailsError ? (
                <RunDetails
                  run={selectedRun}
                  onClose={closeDetails}
                />
              ) : null}
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={startTarget !== null}
        title="Start production run?"
        message={
          startTarget
            ? `Start production run ${startTarget.run_number} for ${startTarget.product_name}?`
            : undefined
        }
        description="The backend validates the run status and selected BOM before starting production. Actual material consumption and output must be recorded through the production workflow."
        variant="warning"
        confirmLabel="Start production"
        cancelLabel="Cancel"
        isLoading={processingAction}
        onCancel={() => {
          if (!processingAction) {
            setStartTarget(null);
          }
        }}
        onConfirm={() =>
          startTarget
            ? performAction(startTarget, "start")
            : undefined
        }
      />

      <ConfirmDialog
        open={cancelTarget !== null}
        title="Cancel production run?"
        message={
          cancelTarget
            ? `Cancel draft production run ${cancelTarget.run_number}?`
            : undefined
        }
        description="Cancellation is subject to backend lifecycle and inventory transaction rules. Posted material movements must not be silently reversed."
        variant="danger"
        confirmLabel="Cancel run"
        cancelLabel="Keep run"
        isLoading={processingAction}
        onCancel={() => {
          if (!processingAction) {
            setCancelTarget(null);
          }
        }}
        onConfirm={() =>
          cancelTarget
            ? performAction(cancelTarget, "cancel")
            : undefined
        }
      />
    </div>
  );
}

export default ProductionRunsPage;