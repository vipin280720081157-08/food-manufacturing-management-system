import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  ClipboardList,
  Factory,
  PackageCheck,
  Plus,
  RefreshCw,
} from "lucide-react";

import { Link, useParams } from "react-router-dom";

import type {
  ProductionStatus,
  UnitOfMeasure,
  UUID,
} from "../../types/business";

import { USER_ROLES } from "../../types/auth";
import { useAuth } from "../../hooks/useAuth";
import { useOnlineStatus } from "../../hooks/useOnlineStatus";

import {
  apiClient,
  getApiErrorMessage,
} from "../../services/api/client";

import { LoadingState } from "../../components/common/LoadingState";
import { ErrorState } from "../../components/common/ErrorState";
import { StatusBadge } from "../../components/common/StatusBadge";
import { ConfirmDialog } from "../../components/common/ConfirmDialog";

import {
  formatDate,
  formatDateTime,
  formatQuantity,
} from "../../utils/formatters";

const MAX_NOTES_LENGTH = 2000;

interface ProductionMaterial {
  id: UUID;
  item_id: UUID;
  item_code: string;
  item_name: string;
  item_type: "raw_material" | "packaging_material";
  unit: UnitOfMeasure;
  planned_quantity: string;
  issued_quantity: string;
  consumed_quantity: string;
  wastage_quantity: string;
  returned_quantity: string;
}

interface ProductionMaterialMovement {
  id: UUID;
  material_id: UUID;
  movement_type: "issue" | "consume" | "wastage" | "return";
  quantity: string;
  unit: UnitOfMeasure;
  batch_id: UUID | null;
  batch_number: string | null;
  notes: string | null;
  created_at: string;
}

interface ProductionOutput {
  id: UUID;
  batch_number: string;
  expiry_date: string | null;
  total_produced_quantity: string;
  good_quantity: string;
  rejected_quantity: string;
  damaged_quantity: string;
  packaging_wastage_quantity: string;
  notes: string | null;
  posted_at: string;
}

interface ProductionExpense {
  id: UUID;
  expense_type: string;
  amount: string;
  description: string | null;
  expense_date: string;
  created_at: string;
}

interface ProductionRunDetails {
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
  production_batch_number: string | null;
  started_at: string | null;
  completed_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string | null;
  materials: ProductionMaterial[];
  material_movements: ProductionMaterialMovement[];
  outputs: ProductionOutput[];
  expenses: ProductionExpense[];
}

interface StockBatchOption {
  id: UUID;
  item_id: UUID;
  batch_number: string;
  quantity_available: string;
  base_unit: UnitOfMeasure;
  expiry_date: string | null;
}

interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

type MaterialMovementType =
  | "issue"
  | "consume"
  | "wastage"
  | "return";

interface MaterialMovementForm {
  material_id: string;
  movement_type: MaterialMovementType;
  quantity: string;
  batch_id: string;
  notes: string;
}

interface OutputForm {
  batch_number: string;
  expiry_date: string;
  total_produced_quantity: string;
  good_quantity: string;
  rejected_quantity: string;
  damaged_quantity: string;
  packaging_wastage_quantity: string;
  completion_date: string;
  notes: string;
}

interface ExpenseForm {
  expense_type: string;
  amount: string;
  description: string;
  expense_date: string;
}

interface MaterialMovementInput {
  material_id: UUID;
  movement_type: MaterialMovementType;
  quantity: string;
  unit: UnitOfMeasure;
  batch_id: UUID | null;
  notes: string | null;
}

interface OutputInput {
  batch_number: string;
  expiry_date: string | null;
  total_produced_quantity: string;
  good_quantity: string;
  rejected_quantity: string;
  damaged_quantity: string;
  packaging_wastage_quantity: string;
  completion_date: string;
  notes: string | null;
}

interface ExpenseInput {
  expense_type: string;
  amount: string;
  description: string | null;
  expense_date: string;
}

const EMPTY_MATERIAL_FORM: MaterialMovementForm = {
  material_id: "",
  movement_type: "issue",
  quantity: "",
  batch_id: "",
  notes: "",
};

const EMPTY_OUTPUT_FORM: OutputForm = {
  batch_number: "",
  expiry_date: "",
  total_produced_quantity: "",
  good_quantity: "",
  rejected_quantity: "",
  damaged_quantity: "",
  packaging_wastage_quantity: "",
  completion_date: "",
  notes: "",
};

const EMPTY_EXPENSE_FORM: ExpenseForm = {
  expense_type: "labour",
  amount: "",
  description: "",
  expense_date: "",
};

const MOVEMENT_LABELS: Record<MaterialMovementType, string> = {
  issue: "Material issue",
  consume: "Actual consumption",
  wastage: "Wastage or damage",
  return: "Unused material return",
};

const EXPENSE_TYPES = [
  { value: "labour", label: "Labour" },
  { value: "gas_power", label: "Gas and power" },
  { value: "other_overhead", label: "Other overhead" },
] as const;

function isNonNegativeDecimal(value: string): boolean {
  return /^\d+(?:\.\d+)?$/.test(value.trim());
}

function isPositiveDecimal(value: string): boolean {
  return (
    isNonNegativeDecimal(value) &&
    /[1-9]/.test(value.trim().replace(".", ""))
  );
}

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

function toScaledInteger(
  value: string,
  scale: number,
): bigint {
  const [whole = "0", fraction = ""] = value.split(".");

  return (
    BigInt(whole) * 10n ** BigInt(scale) +
    BigInt(fraction.padEnd(scale, "0"))
  );
}

function decimalSumMatches(
  total: string,
  components: string[],
): boolean {
  const values = [total, ...components];

  if (!values.every(isNonNegativeDecimal)) {
    return false;
  }

  const scale = Math.max(
    ...values.map(
      (value) => value.split(".")[1]?.length ?? 0,
    ),
  );

  return (
    toScaledInteger(total, scale) ===
    components.reduce(
      (sum, value) => sum + toScaledInteger(value, scale),
      0n,
    )
  );
}

function getProductionStatusLabel(
  status: ProductionStatus,
): string {
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

function getExpenseLabel(value: string): string {
  return (
    EXPENSE_TYPES.find((type) => type.value === value)
      ?.label ?? value
  );
}

async function fetchProductionRun(
  runId: UUID,
  signal?: AbortSignal,
): Promise<ProductionRunDetails> {
  return apiClient.get<ProductionRunDetails>(
    `/production/runs/${encodeURIComponent(runId)}`,
    { signal },
  );
}

async function fetchMaterialBatches(
  itemId: UUID,
  signal?: AbortSignal,
): Promise<StockBatchOption[]> {
  const batches: StockBatchOption[] = [];
  let page = 1;

  while (!signal?.aborted) {
    const response = await apiClient.get<
      PaginatedResponse<StockBatchOption>
    >("/inventory/batches", {
      query: {
        item_id: itemId,
        page,
        page_size: 100,
      },
      signal,
    });

    batches.push(
      ...response.items.filter(
        (batch) => batch.item_id === itemId,
      ),
    );

    if (
      response.items.length === 0 ||
      page * 100 >= response.total
    ) {
      break;
    }

    page += 1;
  }

  return batches;
}

async function recordMaterialMovement(
  runId: UUID,
  payload: MaterialMovementInput,
  idempotencyKey: string,
): Promise<ProductionMaterialMovement> {
  return apiClient.post<ProductionMaterialMovement>(
    `/production/runs/${encodeURIComponent(runId)}/materials`,
    payload,
    { idempotencyKey },
  );
}

async function recordProductionOutput(
  runId: UUID,
  payload: OutputInput,
  idempotencyKey: string,
): Promise<ProductionOutput> {
  return apiClient.post<ProductionOutput>(
    `/production/runs/${encodeURIComponent(runId)}/outputs`,
    payload,
    { idempotencyKey },
  );
}

async function recordProductionExpense(
  runId: UUID,
  payload: ExpenseInput,
  idempotencyKey: string,
): Promise<ProductionExpense> {
  return apiClient.post<ProductionExpense>(
    `/production/runs/${encodeURIComponent(runId)}/expenses`,
    payload,
    { idempotencyKey },
  );
}

async function completeProductionRun(
  runId: UUID,
  idempotencyKey: string,
): Promise<ProductionRunDetails> {
  return apiClient.post<ProductionRunDetails>(
    `/production/runs/${encodeURIComponent(runId)}/complete`,
    undefined,
    { idempotencyKey },
  );
}

interface SectionProps {
  title: string;
  description: string;
  children: ReactNode;
  action?: ReactNode;
}

function Section({
  title,
  description,
  children,
  action,
}: SectionProps) {
  return (
    <section className="app-card space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="text-base font-semibold text-text-primary">
            {title}
          </h3>

          <p className="mt-1 text-sm text-text-muted">
            {description}
          </p>
        </div>

        {action}
      </div>

      {children}
    </section>
  );
}

interface FieldProps {
  id: string;
  label: string;
  children: ReactNode;
  help?: string;
}

function Field({
  id,
  label,
  children,
  help,
}: FieldProps) {
  return (
    <div>
      <label
        htmlFor={id}
        className="app-field-label mb-2 block"
      >
        {label}
      </label>

      {children}

      {help && (
        <p className="app-field-help mt-1">{help}</p>
      )}
    </div>
  );
}

export function ProductionRunFormPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const { isOnline } = useOnlineStatus();

  const canView =
    user?.role === USER_ROLES.FACTORY_ADMIN ||
    user?.role === USER_ROLES.PRODUCTION_SUPERVISOR ||
    user?.role === USER_ROLES.ACCOUNTANT_AUDITOR ||
    user?.role === USER_ROLES.OWNER;

  const canManage =
    user?.role === USER_ROLES.FACTORY_ADMIN ||
    user?.role === USER_ROLES.PRODUCTION_SUPERVISOR;

  const [run, setRun] =
    useState<ProductionRunDetails | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [materialForm, setMaterialForm] =
    useState<MaterialMovementForm>(EMPTY_MATERIAL_FORM);

  const [outputForm, setOutputForm] =
    useState<OutputForm>(EMPTY_OUTPUT_FORM);

  const [expenseForm, setExpenseForm] =
    useState<ExpenseForm>(EMPTY_EXPENSE_FORM);

  const [batchOptions, setBatchOptions] =
    useState<StockBatchOption[]>([]);

  const [batchesLoading, setBatchesLoading] =
    useState(false);

  const [batchesError, setBatchesError] =
    useState<string | null>(null);

  const [materialError, setMaterialError] =
    useState<string | null>(null);

  const [outputError, setOutputError] =
    useState<string | null>(null);

  const [expenseError, setExpenseError] =
    useState<string | null>(null);

  const [actionError, setActionError] =
    useState<string | null>(null);

  const [successMessage, setSuccessMessage] =
    useState<string | null>(null);

  const [savingMaterial, setSavingMaterial] =
    useState(false);

  const [savingOutput, setSavingOutput] =
    useState(false);

  const [savingExpense, setSavingExpense] =
    useState(false);

  const [completeDialogOpen, setCompleteDialogOpen] =
    useState(false);

  const [completing, setCompleting] = useState(false);

  const materialKeyRef = useRef<string | null>(null);
  const outputKeyRef = useRef<string | null>(null);
  const expenseKeyRef = useRef<string | null>(null);
  const completeKeyRef = useRef<string | null>(null);

  const selectedMaterial = useMemo(
    () =>
      run?.materials.find(
        (material) =>
          material.id === materialForm.material_id,
      ),
    [run, materialForm.material_id],
  );

  const canRecordProduction =
    canManage &&
    isOnline &&
    run?.status === "in_progress";

  const canRecordExpenses =
    canManage &&
    isOnline &&
    (run?.status === "in_progress" ||
      run?.status === "completed");

  const isAnyMutationPending =
    savingMaterial ||
    savingOutput ||
    savingExpense ||
    completing;

  const loadRun = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      if (!id || !canView) {
        setRun(null);
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const response = await fetchProductionRun(
          id,
          signal,
        );

        if (signal?.aborted) {
          return;
        }

        setRun(response);
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
    [id, canView],
  );

  useEffect(() => {
    const controller = new AbortController();

    void loadRun(controller.signal);

    return () => controller.abort();
  }, [loadRun]);

  useEffect(() => {
    if (
      !selectedMaterial ||
      !canRecordProduction
    ) {
      setBatchOptions([]);
      setBatchesError(null);
      return;
    }

    const controller = new AbortController();

    const loadBatches = async (): Promise<void> => {
      setBatchesLoading(true);
      setBatchesError(null);

      try {
        const response = await fetchMaterialBatches(
          selectedMaterial.item_id,
          controller.signal,
        );

        if (!controller.signal.aborted) {
          setBatchOptions(response);
        }
      } catch (failure) {
        if (!controller.signal.aborted) {
          setBatchesError(getApiErrorMessage(failure));
        }
      } finally {
        if (!controller.signal.aborted) {
          setBatchesLoading(false);
        }
      }
    };

    void loadBatches();

    return () => controller.abort();
  }, [
    selectedMaterial,
    canRecordProduction,
  ]);

  const updateMaterialForm = <
    K extends keyof MaterialMovementForm,
  >(
    field: K,
    value: MaterialMovementForm[K],
  ): void => {
    materialKeyRef.current = null;
    setMaterialError(null);

    setMaterialForm((current) => ({
      ...current,
      [field]: value,
      ...(field === "material_id"
        ? { batch_id: "" }
        : {}),
    }));
  };

  const updateOutputForm = <
    K extends keyof OutputForm,
  >(
    field: K,
    value: OutputForm[K],
  ): void => {
    outputKeyRef.current = null;
    setOutputError(null);

    setOutputForm((current) => ({
      ...current,
      [field]: value,
    }));
  };

  const updateExpenseForm = <
    K extends keyof ExpenseForm,
  >(
    field: K,
    value: ExpenseForm[K],
  ): void => {
    expenseKeyRef.current = null;
    setExpenseError(null);

    setExpenseForm((current) => ({
      ...current,
      [field]: value,
    }));
  };

  const validateMaterialForm = (): string | null => {
    if (!selectedMaterial) {
      return "Select a material from the production plan.";
    }

    if (!isPositiveDecimal(materialForm.quantity)) {
      return "Material quantity must be greater than zero.";
    }

    if (batchesLoading || batchesError) {
      return "Batch information must load successfully before recording a material movement.";
    }

    if (
      materialForm.batch_id &&
      !batchOptions.some(
        (batch) =>
          batch.id === materialForm.batch_id,
      )
    ) {
      return "Select a valid stock batch.";
    }

    if (
      materialForm.notes.length >
      MAX_NOTES_LENGTH
    ) {
      return "Material notes exceed the permitted length.";
    }

    return null;
  };

  const handleMaterialSubmit = async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();

    if (
      !run ||
      !canRecordProduction ||
      isAnyMutationPending
    ) {
      return;
    }

    const validationError = validateMaterialForm();

    if (validationError) {
      setMaterialError(validationError);
      return;
    }

    if (!selectedMaterial) {
      return;
    }

    const key =
      materialKeyRef.current ??
      crypto.randomUUID();

    materialKeyRef.current = key;

    setSavingMaterial(true);
    setMaterialError(null);
    setSuccessMessage(null);

    try {
      await recordMaterialMovement(
        run.id,
        {
          material_id: selectedMaterial.id,
          movement_type:
            materialForm.movement_type,
          quantity: materialForm.quantity.trim(),
          unit: selectedMaterial.unit,
          batch_id:
            materialForm.batch_id || null,
          notes:
            materialForm.notes.trim() || null,
        },
        key,
      );

      materialKeyRef.current = null;

      setMaterialForm({
        ...EMPTY_MATERIAL_FORM,
        material_id: selectedMaterial.id,
        movement_type:
          materialForm.movement_type,
      });

      setSuccessMessage(
        "Material movement was recorded successfully.",
      );

      await loadRun();
    } catch (failure) {
      setMaterialError(
        getApiErrorMessage(failure),
      );
    } finally {
      setSavingMaterial(false);
    }
  };

  const validateOutputForm = (): string | null => {
    if (!outputForm.batch_number.trim()) {
      return "Enter a finished-goods batch number.";
    }

    if (
      !isValidDate(
        outputForm.completion_date,
      )
    ) {
      return "Enter a valid completion date.";
    }

    if (
      run &&
      outputForm.completion_date <
        run.production_date
    ) {
      return "Completion date cannot precede the production date.";
    }

    if (
      outputForm.expiry_date &&
      (!isValidDate(outputForm.expiry_date) ||
        outputForm.expiry_date <
          outputForm.completion_date)
    ) {
      return "Expiry date must be valid and must not precede completion.";
    }

    const quantities = [
      outputForm.total_produced_quantity,
      outputForm.good_quantity,
      outputForm.rejected_quantity,
      outputForm.damaged_quantity,
      outputForm.packaging_wastage_quantity,
    ];

    if (
      !quantities.every(
        isNonNegativeDecimal,
      )
    ) {
      return "All output quantities must be non-negative decimal numbers.";
    }

    if (
      !isPositiveDecimal(
        outputForm.total_produced_quantity,
      )
    ) {
      return "Total produced quantity must be greater than zero.";
    }

    if (
      !decimalSumMatches(
        outputForm.total_produced_quantity,
        [
          outputForm.good_quantity,
          outputForm.rejected_quantity,
          outputForm.damaged_quantity,
        ],
      )
    ) {
      return "Good, rejected, and damaged quantities must reconcile with total produced quantity.";
    }

    if (
      outputForm.notes.length >
      MAX_NOTES_LENGTH
    ) {
      return "Output notes exceed the permitted length.";
    }

    return null;
  };

  const handleOutputSubmit = async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();

    if (
      !run ||
      !canRecordProduction ||
      isAnyMutationPending
    ) {
      return;
    }

    const validationError = validateOutputForm();

    if (validationError) {
      setOutputError(validationError);
      return;
    }

    const key =
      outputKeyRef.current ??
      crypto.randomUUID();

    outputKeyRef.current = key;

    setSavingOutput(true);
    setOutputError(null);
    setSuccessMessage(null);

    try {
      await recordProductionOutput(
        run.id,
        {
          batch_number:
            outputForm.batch_number.trim(),
          expiry_date:
            outputForm.expiry_date || null,
          total_produced_quantity:
            outputForm.total_produced_quantity.trim(),
          good_quantity:
            outputForm.good_quantity.trim(),
          rejected_quantity:
            outputForm.rejected_quantity.trim(),
          damaged_quantity:
            outputForm.damaged_quantity.trim(),
          packaging_wastage_quantity:
            outputForm.packaging_wastage_quantity.trim(),
          completion_date:
            outputForm.completion_date,
          notes: outputForm.notes.trim() || null,
        },
        key,
      );

      outputKeyRef.current = null;
      setOutputForm(EMPTY_OUTPUT_FORM);

      setSuccessMessage(
        "Production output was recorded successfully.",
      );

      await loadRun();
    } catch (failure) {
      setOutputError(
        getApiErrorMessage(failure),
      );
    } finally {
      setSavingOutput(false);
    }
  };

  const validateExpenseForm = (): string | null => {
    if (
      !EXPENSE_TYPES.some(
        (type) =>
          type.value ===
          expenseForm.expense_type,
      )
    ) {
      return "Select a valid expense category.";
    }

    if (!isPositiveDecimal(expenseForm.amount)) {
      return "Expense amount must be greater than zero.";
    }

    if (!isValidDate(expenseForm.expense_date)) {
      return "Enter a valid expense date.";
    }

    if (
      expenseForm.description.length >
      MAX_NOTES_LENGTH
    ) {
      return "Expense description exceeds the permitted length.";
    }

    return null;
  };

  const handleExpenseSubmit = async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();

    if (
      !run ||
      !canRecordExpenses ||
      isAnyMutationPending
    ) {
      return;
    }

    const validationError = validateExpenseForm();

    if (validationError) {
      setExpenseError(validationError);
      return;
    }

    const key =
      expenseKeyRef.current ??
      crypto.randomUUID();

    expenseKeyRef.current = key;

    setSavingExpense(true);
    setExpenseError(null);
    setSuccessMessage(null);

    try {
      await recordProductionExpense(
        run.id,
        {
          expense_type:
            expenseForm.expense_type,
          amount: expenseForm.amount.trim(),
          description:
            expenseForm.description.trim() ||
            null,
          expense_date:
            expenseForm.expense_date,
        },
        key,
      );

      expenseKeyRef.current = null;
      setExpenseForm(EMPTY_EXPENSE_FORM);

      setSuccessMessage(
        "Production expense was recorded successfully.",
      );

      await loadRun();
    } catch (failure) {
      setExpenseError(
        getApiErrorMessage(failure),
      );
    } finally {
      setSavingExpense(false);
    }
  };

  const handleComplete = async (): Promise<void> => {
    if (
      !run ||
      !canRecordProduction ||
      isAnyMutationPending
    ) {
      return;
    }

    const key =
      completeKeyRef.current ??
      crypto.randomUUID();

    completeKeyRef.current = key;

    setCompleting(true);
    setActionError(null);
    setSuccessMessage(null);

    try {
      const completed = await completeProductionRun(
        run.id,
        key,
      );

      completeKeyRef.current = null;
      setCompleteDialogOpen(false);
      setRun(completed);

      setSuccessMessage(
        `Production run ${completed.run_number} is now ${getProductionStatusLabel(completed.status)}.`,
      );

      await loadRun();
    } catch (failure) {
      setActionError(
        getApiErrorMessage(failure),
      );

      setCompleteDialogOpen(false);

      await loadRun();
    } finally {
      setCompleting(false);
    }
  };

  if (!canView) {
    return (
      <div className="app-page space-y-5">
        <h2 className="app-page-title">
          Production Run
        </h2>

        <div
          role="alert"
          className="app-alert app-alert-error"
        >
          Access to production run details is
          restricted for this role.
        </div>

        <Link
          to="/production/runs"
          className="app-button app-button-secondary"
        >
          Back to production runs
        </Link>
      </div>
    );
  }

  if (!id) {
    return (
      <div className="app-page space-y-5">
        <h2 className="app-page-title">
          Production Run
        </h2>

        <div
          role="alert"
          className="app-alert app-alert-error"
        >
          A production run reference is required.
        </div>

        <Link
          to="/production/runs"
          className="app-button app-button-secondary"
        >
          Back to production runs
        </Link>
      </div>
    );
  }

  if (loading && !run) {
    return (
      <div className="app-page">
        <LoadingState
          variant="page"
          message="Loading production run..."
        />
      </div>
    );
  }

  if (error && !run) {
    return (
      <div className="app-page space-y-5">
        <Link
          to="/production/runs"
          className="inline-flex items-center gap-2 text-sm font-medium text-accent hover:underline"
        >
          <ArrowLeft size={17} aria-hidden="true" />
          Production runs
        </Link>

        <ErrorState
          message={error}
          onRetry={() => {
            void loadRun();
          }}
        />
      </div>
    );
  }

  if (!run) {
    return (
      <div className="app-page space-y-5">
        <h2 className="app-page-title">
          Production run unavailable
        </h2>

        <Link
          to="/production/runs"
          className="app-button app-button-secondary"
        >
          Back to production runs
        </Link>
      </div>
    );
  }

  return (
    <div className="app-page space-y-6">
      <header className="space-y-4">
        <Link
          to="/production/runs"
          className="inline-flex items-center gap-2 text-sm font-medium text-accent hover:underline"
        >
          <ArrowLeft size={17} aria-hidden="true" />
          Production runs
        </Link>

        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="app-page-title">
                {run.run_number}
              </h2>

              <StatusBadge
                status={run.status}
                category="production"
                showDot
              />
            </div>

            <p className="app-page-description">
              {run.product_name} ({run.product_code})
              {" · "}BOM version {run.bom_version}
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                void loadRun();
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

            {canRecordProduction && (
              <button
                type="button"
                onClick={() =>
                  setCompleteDialogOpen(true)
                }
                disabled={isAnyMutationPending}
                className="app-button app-button-primary inline-flex items-center gap-2"
              >
                <CheckCircle2
                  size={17}
                  aria-hidden="true"
                />
                Complete run
              </button>
            )}
          </div>
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
            Production recording requires an active
            backend connection. Material movements,
            finished-goods output, expenses, and
            completion cannot be submitted offline.
          </p>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="app-alert app-alert-error"
        >
          {error}
        </div>
      )}

      {actionError && (
        <div
          role="alert"
          className="app-alert app-alert-error"
        >
          <p>{actionError}</p>

          <p className="mt-1 text-xs">
            Refresh the production run before
            retrying an uncertain transaction.
          </p>
        </div>
      )}

      {successMessage && (
        <div
          role="status"
          className="app-alert app-alert-success flex items-start gap-2"
        >
          <CheckCircle2
            size={18}
            className="shrink-0"
            aria-hidden="true"
          />
          {successMessage}
        </div>
      )}

      <section
        aria-label="Production run overview"
        className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
      >
        <div className="rounded-card border border-border bg-surface p-5">
          <p className="text-xs font-medium text-text-muted">
            Planned quantity
          </p>

          <p className="mt-2 text-xl font-semibold text-text-primary app-numeric">
            {formatQuantity(run.planned_quantity)}
          </p>
        </div>

        <div className="rounded-card border border-border bg-surface p-5">
          <p className="text-xs font-medium text-text-muted">
            Actual good output
          </p>

          <p className="mt-2 text-xl font-semibold text-text-primary app-numeric">
            {formatOptionalQuantity(
              run.actual_good_quantity,
            )}
          </p>
        </div>

        <div className="rounded-card border border-border bg-surface p-5">
          <p className="text-xs font-medium text-text-muted">
            Rejected quantity
          </p>

          <p className="mt-2 text-xl font-semibold text-text-primary app-numeric">
            {formatOptionalQuantity(
              run.rejected_quantity,
            )}
          </p>
        </div>

        <div className="rounded-card border border-border bg-surface p-5">
          <p className="text-xs font-medium text-text-muted">
            Production date
          </p>

          <p className="mt-2 text-lg font-semibold text-text-primary">
            {formatDate(run.production_date)}
          </p>
        </div>
      </section>

      <Section
        title="Production information"
        description="Backend-recorded run identity, schedule, and lifecycle information."
      >
        <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2 xl:grid-cols-3">
          {[
            ["Run number", run.run_number],
            ["Finished product", run.product_name],
            ["Product code", run.product_code],
            ["BOM version", String(run.bom_version)],
            [
              "Production batch",
              run.production_batch_number ?? "—",
            ],
            [
              "Production date",
              formatDate(run.production_date),
            ],
            [
              "Started at",
              run.started_at
                ? formatDateTime(run.started_at)
                : "Not started",
            ],
            [
              "Completed at",
              run.completed_at
                ? formatDateTime(run.completed_at)
                : "Not completed",
            ],
            [
              "Created at",
              formatDateTime(run.created_at),
            ],
          ].map(([label, value]) => (
            <div
              key={label}
              className="border-b border-border pb-3"
            >
              <dt className="text-xs text-text-muted">
                {label}
              </dt>

              <dd className="mt-1 break-words text-sm font-medium text-text-primary">
                {value}
              </dd>
            </div>
          ))}
        </dl>

        {run.notes && (
          <div>
            <h4 className="text-sm font-semibold text-text-primary">
              Planning notes
            </h4>

            <p className="mt-2 whitespace-pre-wrap rounded-control bg-background p-4 text-sm text-text-muted">
              {run.notes}
            </p>
          </div>
        )}
      </Section>

      <Section
        title="Planned material requirements"
        description="Standard material requirements calculated by the backend from the selected BOM."
        action={
          <ClipboardList
            size={21}
            className="text-primary"
            aria-hidden="true"
          />
        }
      >
        <div className="app-table-container">
          <table className="app-table w-full">
            <thead>
              <tr>
                <th scope="col">Material</th>
                <th scope="col">Type</th>
                <th scope="col" className="text-right">
                  Planned
                </th>
                <th scope="col" className="text-right">
                  Issued
                </th>
                <th scope="col" className="text-right">
                  Consumed
                </th>
                <th scope="col" className="text-right">
                  Wastage
                </th>
                <th scope="col" className="text-right">
                  Returned
                </th>
              </tr>
            </thead>

            <tbody>
              {run.materials.map((material) => (
                <tr key={material.id}>
                  <td>
                    <p className="font-medium">
                      {material.item_name}
                    </p>

                    <p className="text-xs text-text-muted">
                      {material.item_code}
                    </p>
                  </td>

                  <td>
                    {material.item_type ===
                    "raw_material"
                      ? "Raw material"
                      : "Packaging"}
                  </td>

                  {[
                    material.planned_quantity,
                    material.issued_quantity,
                    material.consumed_quantity,
                    material.wastage_quantity,
                    material.returned_quantity,
                  ].map((quantity, index) => (
                    <td
                      key={index}
                      className="app-numeric whitespace-nowrap text-right"
                    >
                      {formatQuantity(quantity)}{" "}
                      {material.unit}
                    </td>
                  ))}
                </tr>
              ))}

              {run.materials.length === 0 && (
                <tr>
                  <td
                    colSpan={7}
                    className="py-6 text-center text-text-muted"
                  >
                    No planned material requirements
                    were returned.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <p className="text-xs leading-5 text-text-muted">
          Material issue, actual consumption,
          wastage, and unused returns are separate
          records. The backend reconciles quantities,
          prevents negative stock, and maintains
          batch-level movement history.
        </p>
      </Section>

      <Section
        title="Material movements"
        description="Record and review material issues, consumption, wastage, and unused returns."
        action={
          <Factory
            size={21}
            className="text-primary"
            aria-hidden="true"
          />
        }
      >
        {canRecordProduction && (
          <form
            onSubmit={(event) => {
              void handleMaterialSubmit(event);
            }}
            className="space-y-4 rounded-control border border-border bg-background p-4"
          >
            <h4 className="text-sm font-semibold text-text-primary">
              Record material movement
            </h4>

            {materialError && (
              <div
                role="alert"
                className="app-alert app-alert-error"
              >
                {materialError}
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                id="production-material"
                label="Material *"
              >
                <select
                  id="production-material"
                  value={materialForm.material_id}
                  onChange={(event) =>
                    updateMaterialForm(
                      "material_id",
                      event.target.value,
                    )
                  }
                  required
                  disabled={isAnyMutationPending}
                  className="app-select w-full"
                >
                  <option value="">
                    Select material
                  </option>

                  {run.materials.map((material) => (
                    <option
                      key={material.id}
                      value={material.id}
                    >
                      {material.item_code} —{" "}
                      {material.item_name}
                    </option>
                  ))}
                </select>
              </Field>

              <Field
                id="production-movement-type"
                label="Movement type *"
              >
                <select
                  id="production-movement-type"
                  value={materialForm.movement_type}
                  onChange={(event) =>
                    updateMaterialForm(
                      "movement_type",
                      event.target
                        .value as MaterialMovementType,
                    )
                  }
                  disabled={isAnyMutationPending}
                  className="app-select w-full"
                >
                  {(
                    Object.keys(
                      MOVEMENT_LABELS,
                    ) as MaterialMovementType[]
                  ).map((type) => (
                    <option
                      key={type}
                      value={type}
                    >
                      {MOVEMENT_LABELS[type]}
                    </option>
                  ))}
                </select>
              </Field>

              <Field
                id="production-material-quantity"
                label="Quantity *"
                help={
                  selectedMaterial
                    ? `Unit: ${selectedMaterial.unit}`
                    : "Select a material to identify its unit."
                }
              >
                <input
                  id="production-material-quantity"
                  type="text"
                  inputMode="decimal"
                  value={materialForm.quantity}
                  onChange={(event) =>
                    updateMaterialForm(
                      "quantity",
                      event.target.value,
                    )
                  }
                  required
                  disabled={isAnyMutationPending}
                  placeholder="0"
                  className="app-input w-full"
                />
              </Field>

              <Field
                id="production-material-batch"
                label="Source batch"
                help="Batch selection is validated by the backend."
              >
                <select
                  id="production-material-batch"
                  value={materialForm.batch_id}
                  onChange={(event) =>
                    updateMaterialForm(
                      "batch_id",
                      event.target.value,
                    )
                  }
                  disabled={
                    isAnyMutationPending ||
                    !selectedMaterial ||
                    batchesLoading ||
                    Boolean(batchesError)
                  }
                  className="app-select w-full"
                >
                  <option value="">
                    {batchesLoading
                      ? "Loading batches..."
                      : "No specific batch"}
                  </option>

                  {batchOptions.map((batch) => (
                    <option
                      key={batch.id}
                      value={batch.id}
                    >
                      {batch.batch_number} —{" "}
                      {formatQuantity(
                        batch.quantity_available,
                      )}{" "}
                      {batch.base_unit}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            {batchesError && (
              <div
                role="alert"
                className="app-alert app-alert-error"
              >
                {batchesError}
              </div>
            )}

            <Field
              id="production-material-notes"
              label="Movement notes"
            >
              <textarea
                id="production-material-notes"
                rows={3}
                maxLength={MAX_NOTES_LENGTH}
                value={materialForm.notes}
                onChange={(event) =>
                  updateMaterialForm(
                    "notes",
                    event.target.value,
                  )
                }
                disabled={isAnyMutationPending}
                className="app-textarea w-full"
              />
            </Field>

            <div className="flex justify-end">
              <button
                type="submit"
                disabled={
                  isAnyMutationPending ||
                  batchesLoading ||
                  Boolean(batchesError)
                }
                className="app-button app-button-primary inline-flex items-center gap-2"
              >
                <Plus
                  size={16}
                  aria-hidden="true"
                />
                {savingMaterial
                  ? "Recording..."
                  : "Record movement"}
              </button>
            </div>
          </form>
        )}

        <div className="app-table-container">
          <table className="app-table w-full">
            <thead>
              <tr>
                <th scope="col">Recorded at</th>
                <th scope="col">Material</th>
                <th scope="col">Movement</th>
                <th scope="col">Batch</th>
                <th scope="col" className="text-right">
                  Quantity
                </th>
                <th scope="col">Notes</th>
              </tr>
            </thead>

            <tbody>
              {run.material_movements.map(
                (movement) => {
                  const material =
                    run.materials.find(
                      (entry) =>
                        entry.id ===
                        movement.material_id,
                    );

                  return (
                    <tr key={movement.id}>
                      <td>
                        {formatDateTime(
                          movement.created_at,
                        )}
                      </td>

                      <td>
                        {material?.item_name ??
                          movement.material_id}
                      </td>

                      <td>
                        {
                          MOVEMENT_LABELS[
                            movement.movement_type
                          ]
                        }
                      </td>

                      <td>
                        {movement.batch_number ?? "—"}
                      </td>

                      <td className="app-numeric whitespace-nowrap text-right">
                        {formatQuantity(
                          movement.quantity,
                        )}{" "}
                        {movement.unit}
                      </td>

                      <td>
                        {movement.notes ?? "—"}
                      </td>
                    </tr>
                  );
                },
              )}

              {run.material_movements.length ===
                0 && (
                <tr>
                  <td
                    colSpan={6}
                    className="py-6 text-center text-text-muted"
                  >
                    No material movements have
                    been recorded.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Section>

      <Section
        title="Finished-goods output"
        description="Record good, rejected, and damaged production output with batch traceability."
        action={
          <PackageCheck
            size={21}
            className="text-primary"
            aria-hidden="true"
          />
        }
      >
        {canRecordProduction && (
          <form
            onSubmit={(event) => {
              void handleOutputSubmit(event);
            }}
            className="space-y-4 rounded-control border border-border bg-background p-4"
          >
            <h4 className="text-sm font-semibold text-text-primary">
              Record production output
            </h4>

            {outputError && (
              <div
                role="alert"
                className="app-alert app-alert-error"
              >
                {outputError}
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <Field
                id="production-output-batch"
                label="Finished-goods batch *"
              >
                <input
                  id="production-output-batch"
                  type="text"
                  maxLength={100}
                  value={outputForm.batch_number}
                  onChange={(event) =>
                    updateOutputForm(
                      "batch_number",
                      event.target.value,
                    )
                  }
                  required
                  disabled={isAnyMutationPending}
                  className="app-input w-full"
                />
              </Field>

              <Field
                id="production-output-completion-date"
                label="Completion date *"
              >
                <input
                  id="production-output-completion-date"
                  type="date"
                  value={outputForm.completion_date}
                  onChange={(event) =>
                    updateOutputForm(
                      "completion_date",
                      event.target.value,
                    )
                  }
                  required
                  disabled={isAnyMutationPending}
                  className="app-input w-full"
                />
              </Field>

              <Field
                id="production-output-expiry"
                label="Expiry date"
              >
                <input
                  id="production-output-expiry"
                  type="date"
                  value={outputForm.expiry_date}
                  onChange={(event) =>
                    updateOutputForm(
                      "expiry_date",
                      event.target.value,
                    )
                  }
                  disabled={isAnyMutationPending}
                  className="app-input w-full"
                />
              </Field>

              {(
                [
                  [
                    "total_produced_quantity",
                    "Total produced *",
                  ],
                  ["good_quantity", "Good quantity *"],
                  [
                    "rejected_quantity",
                    "Rejected quantity *",
                  ],
                  [
                    "damaged_quantity",
                    "Damaged quantity *",
                  ],
                  [
                    "packaging_wastage_quantity",
                    "Packaging wastage *",
                  ],
                ] as const
              ).map(([field, label]) => (
                <Field
                  key={field}
                  id={`production-output-${field}`}
                  label={label}
                >
                  <input
                    id={`production-output-${field}`}
                    type="text"
                    inputMode="decimal"
                    value={outputForm[field]}
                    onChange={(event) =>
                      updateOutputForm(
                        field,
                        event.target.value,
                      )
                    }
                    required
                    disabled={isAnyMutationPending}
                    placeholder="0"
                    className="app-input w-full"
                  />
                </Field>
              ))}
            </div>

            <Field
              id="production-output-notes"
              label="Output remarks"
            >
              <textarea
                id="production-output-notes"
                rows={3}
                maxLength={MAX_NOTES_LENGTH}
                value={outputForm.notes}
                onChange={(event) =>
                  updateOutputForm(
                    "notes",
                    event.target.value,
                  )
                }
                disabled={isAnyMutationPending}
                className="app-textarea w-full"
              />
            </Field>

            <div className="rounded-control border border-border bg-surface p-4">
              <p className="text-xs leading-5 text-text-muted">
                Total produced must equal good,
                rejected, and damaged output.
                Packaging wastage is recorded
                separately and must not be added
                to finished-product output.
                Only eligible good output increases
                saleable inventory when the backend
                posts the production transaction.
              </p>
            </div>

            <div className="flex justify-end">
              <button
                type="submit"
                disabled={isAnyMutationPending}
                className="app-button app-button-primary inline-flex items-center gap-2"
              >
                <Plus
                  size={16}
                  aria-hidden="true"
                />
                {savingOutput
                  ? "Recording..."
                  : "Record output"}
              </button>
            </div>
          </form>
        )}

        <div className="app-table-container">
          <table className="app-table w-full">
            <thead>
              <tr>
                <th scope="col">Batch</th>
                <th scope="col">Expiry</th>
                <th scope="col" className="text-right">
                  Total
                </th>
                <th scope="col" className="text-right">
                  Good
                </th>
                <th scope="col" className="text-right">
                  Rejected
                </th>
                <th scope="col" className="text-right">
                  Damaged
                </th>
                <th scope="col" className="text-right">
                  Packaging wastage
                </th>
                <th scope="col">Posted at</th>
              </tr>
            </thead>

            <tbody>
              {run.outputs.map((output) => (
                <tr key={output.id}>
                  <td className="font-medium">
                    {output.batch_number}
                  </td>

                  <td>
                    {output.expiry_date
                      ? formatDate(
                          output.expiry_date,
                        )
                      : "—"}
                  </td>

                  {[
                    output.total_produced_quantity,
                    output.good_quantity,
                    output.rejected_quantity,
                    output.damaged_quantity,
                    output.packaging_wastage_quantity,
                  ].map((quantity, index) => (
                    <td
                      key={index}
                      className="app-numeric text-right"
                    >
                      {formatQuantity(quantity)}
                    </td>
                  ))}

                  <td>
                    {formatDateTime(
                      output.posted_at,
                    )}
                  </td>
                </tr>
              ))}

              {run.outputs.length === 0 && (
                <tr>
                  <td
                    colSpan={8}
                    className="py-6 text-center text-text-muted"
                  >
                    No finished-goods output has
                    been recorded.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Section>

      <Section
        title="Production expenses"
        description="Record direct labour, gas and power, or other production overheads. Authorized expenses may be added after physical completion."
      >
        {canRecordExpenses && (
          <form
            onSubmit={(event) => {
              void handleExpenseSubmit(event);
            }}
            className="space-y-4 rounded-control border border-border bg-background p-4"
          >
            <h4 className="text-sm font-semibold text-text-primary">
              Record production expense
            </h4>

            {expenseError && (
              <div
                role="alert"
                className="app-alert app-alert-error"
              >
                {expenseError}
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-3">
              <Field
                id="production-expense-type"
                label="Expense category *"
              >
                <select
                  id="production-expense-type"
                  value={expenseForm.expense_type}
                  onChange={(event) =>
                    updateExpenseForm(
                      "expense_type",
                      event.target.value,
                    )
                  }
                  disabled={isAnyMutationPending}
                  className="app-select w-full"
                >
                  {EXPENSE_TYPES.map((type) => (
                    <option
                      key={type.value}
                      value={type.value}
                    >
                      {type.label}
                    </option>
                  ))}
                </select>
              </Field>

              <Field
                id="production-expense-amount"
                label="Amount (₹) *"
              >
                <input
                  id="production-expense-amount"
                  type="text"
                  inputMode="decimal"
                  value={expenseForm.amount}
                  onChange={(event) =>
                    updateExpenseForm(
                      "amount",
                      event.target.value,
                    )
                  }
                  required
                  disabled={isAnyMutationPending}
                  placeholder="0.00"
                  className="app-input w-full"
                />
              </Field>

              <Field
                id="production-expense-date"
                label="Expense date *"
              >
                <input
                  id="production-expense-date"
                  type="date"
                  value={expenseForm.expense_date}
                  onChange={(event) =>
                    updateExpenseForm(
                      "expense_date",
                      event.target.value,
                    )
                  }
                  required
                  disabled={isAnyMutationPending}
                  className="app-input w-full"
                />
              </Field>
            </div>

            <Field
              id="production-expense-description"
              label="Expense description"
            >
              <textarea
                id="production-expense-description"
                rows={3}
                maxLength={MAX_NOTES_LENGTH}
                value={expenseForm.description}
                onChange={(event) =>
                  updateExpenseForm(
                    "description",
                    event.target.value,
                  )
                }
                disabled={isAnyMutationPending}
                className="app-textarea w-full"
              />
            </Field>

            <div className="flex justify-end">
              <button
                type="submit"
                disabled={isAnyMutationPending}
                className="app-button app-button-primary inline-flex items-center gap-2"
              >
                <Plus
                  size={16}
                  aria-hidden="true"
                />
                {savingExpense
                  ? "Recording..."
                  : "Record expense"}
              </button>
            </div>
          </form>
        )}

        <div className="app-table-container">
          <table className="app-table w-full">
            <thead>
              <tr>
                <th scope="col">Expense date</th>
                <th scope="col">Category</th>
                <th scope="col">Description</th>
                <th scope="col" className="text-right">
                  Amount (₹)
                </th>
                <th scope="col">Recorded at</th>
              </tr>
            </thead>

            <tbody>
              {run.expenses.map((expense) => (
                <tr key={expense.id}>
                  <td>
                    {formatDate(
                      expense.expense_date,
                    )}
                  </td>

                  <td>
                    {getExpenseLabel(
                      expense.expense_type,
                    )}
                  </td>

                  <td>
                    {expense.description ?? "—"}
                  </td>

                  <td className="app-numeric text-right">
                    {expense.amount}
                  </td>

                  <td>
                    {formatDateTime(
                      expense.created_at,
                    )}
                  </td>
                </tr>
              ))}

              {run.expenses.length === 0 && (
                <tr>
                  <td
                    colSpan={5}
                    className="py-6 text-center text-text-muted"
                  >
                    No production expenses have
                    been recorded.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <p className="text-xs leading-5 text-text-muted">
          Production costs, weighted-average
          material valuation, overhead allocation,
          and cost per good unit are calculated by
          the backend. Later authorized expense
          entries update costing without reposting
          finished-goods movements.
        </p>

        <Link
          to="/production/costing"
          className="inline-flex text-sm font-medium text-accent hover:underline"
        >
          View production costing
        </Link>
      </Section>

      {run.status === "draft" && (
        <div
          role="status"
          className="app-alert app-alert-warning"
        >
          This production run is a draft. Start the
          run from the production runs list before
          recording material movements or output.
        </div>
      )}

      {run.status === "completed" && (
        <div
          role="status"
          className="app-alert app-alert-success"
        >
          This production run is completed.
          Production quantities and posted stock
          movements are read-only. Authorized
          production expenses may still be recorded.
        </div>
      )}

      {run.status === "cancelled" && (
        <div
          role="status"
          className="app-alert app-alert-warning"
        >
          This production run is cancelled.
          Historical records remain available
          for audit review.
        </div>
      )}

      {canRecordProduction && (
        <div className="rounded-card border border-border bg-surface p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="text-sm font-semibold text-text-primary">
                Complete production run
              </h3>

              <p className="mt-1 text-xs leading-5 text-text-muted">
                Completion is subject to backend
                validation of material reconciliation,
                finished output, batch records, and
                duplicate-posting protection.
              </p>
            </div>

            <button
              type="button"
              onClick={() =>
                setCompleteDialogOpen(true)
              }
              disabled={isAnyMutationPending}
              className="app-button app-button-primary shrink-0"
            >
              Complete run
            </button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={completeDialogOpen}
        title="Complete production run?"
        message={`Complete production run ${run.run_number}?`}
        description="The backend must validate material movements, actual output, stock balances, and production status before committing completion. A completed run cannot be posted again."
        variant="warning"
        confirmLabel="Complete production"
        cancelLabel="Keep in progress"
        isLoading={completing}
        onCancel={() => {
          if (!completing) {
            setCompleteDialogOpen(false);
          }
        }}
        onConfirm={handleComplete}
      />
    </div>
  );
}

export default ProductionRunFormPage;
