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
  BookOpen,
  CalendarDays,
  CheckCircle2,
  ClipboardList,
  Eye,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";

import type {
  InventoryItem,
  PaginatedResponse,
  Product,
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

import {
  getInventoryItems,
  getProducts,
} from "../../services/api/mastersApi";

import {
  DataTable,
  type DataTableColumn,
} from "../../components/tables/DataTable";

import { LoadingState } from "../../components/common/LoadingState";
import { StatusBadge } from "../../components/common/StatusBadge";
import { ConfirmDialog } from "../../components/common/ConfirmDialog";

import {
  formatDate,
  formatQuantity,
} from "../../utils/formatters";

const PAGE_SIZE = 20;
const LOOKUP_PAGE_SIZE = 100;

interface BOMItem {
  id: UUID;
  bom_id: UUID;
  item_id: UUID;
  item_code: string;
  item_name: string;
  quantity_required: string;
  unit: UnitOfMeasure;
}

interface ProductBOM {
  id: UUID;
  product_id: UUID;
  product_code: string;
  product_name: string;
  version: number;
  standard_batch_size: string;
  expected_output: string;
  effective_from: string;
  effective_to: string | null;
  is_active: boolean;
  items: BOMItem[];
  created_at: string;
  updated_at: string | null;
}

interface BOMLineInput {
  item_id: UUID;
  quantity_required: string;
  unit: UnitOfMeasure;
}

interface CreateBOMInput {
  product_id: UUID;
  version: number;
  standard_batch_size: string;
  expected_output: string;
  effective_from: string;
  effective_to: string | null;
  is_active: boolean;
  items: BOMLineInput[];
}

interface UpdateBOMInput {
  effective_from: string;
  effective_to: string | null;
  is_active: boolean;
}

interface BOMFilters {
  page: number;
  search: string;
  activeOnly: boolean;
}

interface BOMFormLine {
  key: string;
  item_id: string;
  quantity_required: string;
}

interface BOMFormState {
  product_id: string;
  version: string;
  standard_batch_size: string;
  expected_output: string;
  effective_from: string;
  effective_to: string;
  is_active: boolean;
  items: BOMFormLine[];
}

interface BOMEditState {
  effective_from: string;
  effective_to: string;
  is_active: boolean;
}

type FormMode = "create" | "edit";

function createEmptyLine(): BOMFormLine {
  return {
    key: crypto.randomUUID(),
    item_id: "",
    quantity_required: "",
  };
}

function createEmptyForm(): BOMFormState {
  return {
    product_id: "",
    version: "1",
    standard_batch_size: "",
    expected_output: "",
    effective_from: "",
    effective_to: "",
    is_active: true,
    items: [createEmptyLine()],
  };
}

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

  const parsed = new Date(`${value}T00:00:00Z`);

  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function isValidVersion(value: string): boolean {
  if (!/^[1-9]\d*$/.test(value)) {
    return false;
  }

  return Number.isSafeInteger(Number(value));
}

function formatBOMVersion(version: number): string {
  return `Version ${version}`;
}

async function fetchBOMs(
  filters: BOMFilters,
  signal?: AbortSignal,
): Promise<PaginatedResponse<ProductBOM>> {
  return apiClient.get<PaginatedResponse<ProductBOM>>(
    "/production/boms",
    {
      query: {
        page: filters.page,
        page_size: PAGE_SIZE,
        search: filters.search || undefined,
        is_active: filters.activeOnly
          ? true
          : undefined,
      },
      signal,
    },
  );
}

async function fetchBOM(
  bomId: UUID,
  signal?: AbortSignal,
): Promise<ProductBOM> {
  return apiClient.get<ProductBOM>(
    `/production/boms/${encodeURIComponent(bomId)}`,
    { signal },
  );
}

async function createBOM(
  payload: CreateBOMInput,
  idempotencyKey: string,
): Promise<ProductBOM> {
  return apiClient.post<ProductBOM>(
    "/production/boms",
    payload,
    { idempotencyKey },
  );
}

async function updateBOM(
  bomId: UUID,
  payload: UpdateBOMInput,
): Promise<ProductBOM> {
  return apiClient.patch<ProductBOM>(
    `/production/boms/${encodeURIComponent(bomId)}`,
    payload,
  );
}

async function loadAllProducts(
  signal: AbortSignal,
): Promise<Product[]> {
  const collected: Product[] = [];
  let page = 1;

  while (!signal.aborted) {
    const response = await getProducts(
      {
        page,
        page_size: LOOKUP_PAGE_SIZE,
      },
      { signal },
    );

    collected.push(...response.items);

    if (
      response.items.length === 0 ||
      collected.length >= response.total
    ) {
      break;
    }

    page += 1;
  }

  return collected;
}

async function loadAllInventoryItems(
  signal: AbortSignal,
): Promise<InventoryItem[]> {
  const collected: InventoryItem[] = [];
  let page = 1;

  while (!signal.aborted) {
    const response = await getInventoryItems(
      {
        page,
        page_size: LOOKUP_PAGE_SIZE,
      },
      { signal },
    );

    collected.push(...response.items);

    if (
      response.items.length === 0 ||
      collected.length >= response.total
    ) {
      break;
    }

    page += 1;
  }

  return collected;
}

interface BOMDetailsProps {
  bom: ProductBOM;
}

function BOMDetails({ bom }: BOMDetailsProps) {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <StatusBadge
          status={bom.is_active ? "active" : "inactive"}
          label={bom.is_active ? "Active" : "Inactive"}
          variant={bom.is_active ? "success" : "neutral"}
          showDot
        />

        <span className="text-sm font-semibold text-text-primary">
          {formatBOMVersion(bom.version)}
        </span>
      </div>

      <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
        {[
          ["Product", bom.product_name],
          ["Product code", bom.product_code],
          ["Version", String(bom.version)],
          [
            "Standard batch size",
            formatQuantity(bom.standard_batch_size),
          ],
          [
            "Expected good output",
            formatQuantity(bom.expected_output),
          ],
          ["Effective from", formatDate(bom.effective_from)],
          [
            "Effective to",
            bom.effective_to
              ? formatDate(bom.effective_to)
              : "No end date",
          ],
          ["Created at", bom.created_at],
          ["BOM reference", bom.id],
        ].map(([label, value]) => (
          <div
            key={label}
            className="min-w-0 border-b border-border pb-3"
          >
            <dt className="text-xs font-medium text-text-muted">
              {label}
            </dt>

            <dd className="mt-1 break-words text-sm font-medium text-text-primary">
              {value}
            </dd>
          </div>
        ))}
      </dl>

      <section aria-labelledby="bom-details-items-heading">
        <h4
          id="bom-details-items-heading"
          className="mb-3 text-sm font-semibold text-text-primary"
        >
          Standard material requirements
        </h4>

        <div className="app-table-container">
          <table className="app-table w-full">
            <thead>
              <tr>
                <th scope="col">Material</th>
                <th scope="col">Item code</th>
                <th scope="col" className="text-right">
                  Required quantity
                </th>
              </tr>
            </thead>

            <tbody>
              {bom.items.map((item) => (
                <tr key={item.id}>
                  <td>{item.item_name}</td>
                  <td>{item.item_code}</td>
                  <td className="app-numeric text-right">
                    {formatQuantity(item.quantity_required)}{" "}
                    {item.unit}
                  </td>
                </tr>
              ))}

              {bom.items.length === 0 && (
                <tr>
                  <td
                    colSpan={3}
                    className="py-6 text-center text-text-muted"
                  >
                    No material lines were returned.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <div className="rounded-control border border-border bg-background p-4">
        <p className="text-xs leading-5 text-text-muted">
          Standard material quantities and expected
          output define the production recipe.
          Production runs retain the selected BOM
          version. Actual consumption, wastage,
          output, and costing are recorded separately
          through backend production workflows.
        </p>
      </div>
    </div>
  );
}

export function BOMPage() {
  const { user } = useAuth();
  const { isOnline } = useOnlineStatus();

  const canViewBOMs =
    user?.role === USER_ROLES.FACTORY_ADMIN ||
    user?.role === USER_ROLES.PRODUCTION_SUPERVISOR ||
    user?.role === USER_ROLES.ACCOUNTANT_AUDITOR ||
    user?.role === USER_ROLES.OWNER;

  const canManageBOMs =
    user?.role === USER_ROLES.FACTORY_ADMIN;

  const [boms, setBOMs] = useState<ProductBOM[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [activeOnly, setActiveOnly] = useState(false);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedBOM, setSelectedBOM] =
    useState<ProductBOM | null>(null);

  const [detailsLoading, setDetailsLoading] =
    useState(false);

  const [detailsError, setDetailsError] =
    useState<string | null>(null);

  const [formMode, setFormMode] =
    useState<FormMode | null>(null);

  const [form, setForm] =
    useState<BOMFormState>(createEmptyForm);

  const [editForm, setEditForm] =
    useState<BOMEditState>({
      effective_from: "",
      effective_to: "",
      is_active: true,
    });

  const [editingBOM, setEditingBOM] =
    useState<ProductBOM | null>(null);

  const [products, setProducts] = useState<Product[]>([]);
  const [inventoryItems, setInventoryItems] =
    useState<InventoryItem[]>([]);

  const [lookupsLoading, setLookupsLoading] =
    useState(false);

  const [lookupsError, setLookupsError] =
    useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [formError, setFormError] =
    useState<string | null>(null);

  const [actionError, setActionError] =
    useState<string | null>(null);

  const [successMessage, setSuccessMessage] =
    useState<string | null>(null);

  const [activationTarget, setActivationTarget] =
    useState<ProductBOM | null>(null);

  const [updatingStatus, setUpdatingStatus] =
    useState(false);

  const createKeyRef = useRef<string | null>(null);
  const detailsRequestRef = useRef(0);

  const filters = useMemo<BOMFilters>(
    () => ({
      page,
      search,
      activeOnly,
    }),
    [page, search, activeOnly],
  );

  const availableProducts = useMemo(
    () => products.filter((product) => product.is_active),
    [products],
  );

  const availableMaterials = useMemo(
    () =>
      inventoryItems.filter(
        (item) =>
          item.is_active &&
          (item.item_type === "raw_material" ||
            item.item_type === "packaging_material"),
      ),
    [inventoryItems],
  );

  const loadBOMs = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      if (!canViewBOMs) {
        setBOMs([]);
        setTotal(0);
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const response = await fetchBOMs(filters, signal);

        if (signal?.aborted) {
          return;
        }

        setBOMs(response.items);
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
    [canViewBOMs, filters],
  );

  useEffect(() => {
    const controller = new AbortController();

    void loadBOMs(controller.signal);

    return () => controller.abort();
  }, [loadBOMs]);

  useEffect(() => {
    if (formMode !== "create" || !canManageBOMs) {
      return;
    }

    const controller = new AbortController();

    const loadLookups = async (): Promise<void> => {
      setLookupsLoading(true);
      setLookupsError(null);

      try {
        const [productList, itemList] = await Promise.all([
          loadAllProducts(controller.signal),
          loadAllInventoryItems(controller.signal),
        ]);

        if (!controller.signal.aborted) {
          setProducts(productList);
          setInventoryItems(itemList);
        }
      } catch (failure) {
        if (!controller.signal.aborted) {
          setLookupsError(getApiErrorMessage(failure));
        }
      } finally {
        if (!controller.signal.aborted) {
          setLookupsLoading(false);
        }
      }
    };

    void loadLookups();

    return () => controller.abort();
  }, [formMode, canManageBOMs]);

  useEffect(() => {
    if (!selectedBOM && !formMode) {
      return;
    }

    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || saving) {
        return;
      }

      if (formMode) {
        setFormMode(null);
      } else {
        setSelectedBOM(null);
      }
    };

    document.addEventListener("keydown", handleEscape);

    return () =>
      document.removeEventListener(
        "keydown",
        handleEscape,
      );
  }, [selectedBOM, formMode, saving]);

  const refresh = (): void => {
    void loadBOMs();
  };

  const openDetails = async (
    bom: ProductBOM,
  ): Promise<void> => {
    const requestId = ++detailsRequestRef.current;

    setSelectedBOM(bom);
    setDetailsLoading(true);
    setDetailsError(null);

    try {
      const result = await fetchBOM(bom.id);

      if (detailsRequestRef.current === requestId) {
        setSelectedBOM(result);
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
    setSelectedBOM(null);
    setDetailsError(null);
  };

  const openCreate = (): void => {
    if (!canManageBOMs || !isOnline) {
      return;
    }

    setForm(createEmptyForm());
    setFormError(null);
    setLookupsError(null);
    setActionError(null);
    setSuccessMessage(null);
    createKeyRef.current = null;
    setFormMode("create");
  };

  const openEdit = async (
    bom: ProductBOM,
  ): Promise<void> => {
    if (!canManageBOMs || !isOnline) {
      return;
    }

    setActionError(null);
    setFormError(null);

    try {
      const current = await fetchBOM(bom.id);

      setEditingBOM(current);
      setEditForm({
        effective_from: current.effective_from,
        effective_to: current.effective_to ?? "",
        is_active: current.is_active,
      });
      setFormMode("edit");
    } catch (failure) {
      setActionError(getApiErrorMessage(failure));
    }
  };

  const closeForm = (): void => {
    if (saving) {
      return;
    }

    setFormMode(null);
    setEditingBOM(null);
    setFormError(null);
  };

  const updateForm = <K extends keyof BOMFormState>(
    field: K,
    value: BOMFormState[K],
  ): void => {
    createKeyRef.current = null;
    setFormError(null);

    setForm((current) => ({
      ...current,
      [field]: value,
    }));
  };

  const updateLine = (
    key: string,
    field: "item_id" | "quantity_required",
    value: string,
  ): void => {
    createKeyRef.current = null;
    setFormError(null);

    setForm((current) => ({
      ...current,
      items: current.items.map((line) =>
        line.key === key
          ? { ...line, [field]: value }
          : line,
      ),
    }));
  };

  const addLine = (): void => {
    createKeyRef.current = null;

    setForm((current) => ({
      ...current,
      items: [...current.items, createEmptyLine()],
    }));
  };

  const removeLine = (key: string): void => {
    createKeyRef.current = null;

    setForm((current) => ({
      ...current,
      items: current.items.filter(
        (line) => line.key !== key,
      ),
    }));
  };

  const validateDates = (
    effectiveFrom: string,
    effectiveTo: string,
  ): string | null => {
    if (!isValidDate(effectiveFrom)) {
      return "Enter a valid effective start date.";
    }

    if (
      effectiveTo &&
      !isValidDate(effectiveTo)
    ) {
      return "Enter a valid effective end date.";
    }

    if (
      effectiveTo &&
      effectiveTo < effectiveFrom
    ) {
      return "The effective end date cannot precede the start date.";
    }

    return null;
  };

  const validateCreateForm = (): string | null => {
    if (
      !availableProducts.some(
        (product) => product.id === form.product_id,
      )
    ) {
      return "Select an active finished product.";
    }

    if (!isValidVersion(form.version)) {
      return "BOM version must be a positive whole number.";
    }

    if (!isPositiveDecimal(form.standard_batch_size)) {
      return "Standard batch size must be greater than zero.";
    }

    if (!isPositiveDecimal(form.expected_output)) {
      return "Expected good output must be greater than zero.";
    }

    const dateError = validateDates(
      form.effective_from,
      form.effective_to,
    );

    if (dateError) {
      return dateError;
    }

    if (form.items.length === 0) {
      return "Add at least one raw material or packaging material.";
    }

    const selectedIds = new Set<string>();

    for (const line of form.items) {
      const material = availableMaterials.find(
        (item) => item.id === line.item_id,
      );

      if (!material) {
        return "Select a valid material for every BOM line.";
      }

      if (selectedIds.has(line.item_id)) {
        return "Each material may appear only once in a BOM.";
      }

      selectedIds.add(line.item_id);

      if (!isPositiveDecimal(line.quantity_required)) {
        return `Enter a positive quantity for ${material.name}.`;
      }
    }

    return null;
  };

  const handleCreate = async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();

    if (
      saving ||
      !canManageBOMs ||
      !isOnline ||
      lookupsLoading ||
      lookupsError
    ) {
      return;
    }

    const validationError = validateCreateForm();

    if (validationError) {
      setFormError(validationError);
      return;
    }

    const lines: BOMLineInput[] = form.items.map(
      (line) => {
        const material = availableMaterials.find(
          (item) => item.id === line.item_id,
        );

        if (!material) {
          throw new Error(
            "The selected material is unavailable.",
          );
        }

        return {
          item_id: material.id,
          quantity_required:
            line.quantity_required.trim(),
          unit: material.base_unit,
        };
      },
    );

    const idempotencyKey =
      createKeyRef.current ?? crypto.randomUUID();

    createKeyRef.current = idempotencyKey;

    setSaving(true);
    setFormError(null);

    try {
      const created = await createBOM(
        {
          product_id: form.product_id,
          version: Number(form.version),
          standard_batch_size:
            form.standard_batch_size.trim(),
          expected_output:
            form.expected_output.trim(),
          effective_from: form.effective_from,
          effective_to: form.effective_to || null,
          is_active: form.is_active,
          items: lines,
        },
        idempotencyKey,
      );

      createKeyRef.current = null;
      setFormMode(null);
      setSuccessMessage(
        `BOM version ${created.version} was created successfully.`,
      );
      setPage(1);
      await loadBOMs();
    } catch (failure) {
      setFormError(getApiErrorMessage(failure));
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();

    if (
      !editingBOM ||
      saving ||
      !canManageBOMs ||
      !isOnline
    ) {
      return;
    }

    const validationError = validateDates(
      editForm.effective_from,
      editForm.effective_to,
    );

    if (validationError) {
      setFormError(validationError);
      return;
    }

    setSaving(true);
    setFormError(null);

    try {
      const updated = await updateBOM(
        editingBOM.id,
        {
          effective_from: editForm.effective_from,
          effective_to:
            editForm.effective_to || null,
          is_active: editForm.is_active,
        },
      );

      setFormMode(null);
      setEditingBOM(null);
      setSuccessMessage(
        `BOM version ${updated.version} was updated successfully.`,
      );

      await loadBOMs();
    } catch (failure) {
      setFormError(getApiErrorMessage(failure));
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (): Promise<void> => {
    if (
      !activationTarget ||
      updatingStatus ||
      !canManageBOMs ||
      !isOnline
    ) {
      return;
    }

    const target = activationTarget;

    setUpdatingStatus(true);
    setActionError(null);

    try {
      const updated = await updateBOM(
        target.id,
        {
          effective_from: target.effective_from,
          effective_to: target.effective_to,
          is_active: !target.is_active,
        },
      );

      setActivationTarget(null);
      setSuccessMessage(
        `BOM version ${updated.version} is now ${
          updated.is_active ? "active" : "inactive"
        }.`,
      );

      await loadBOMs();
    } catch (failure) {
      setActionError(getApiErrorMessage(failure));
      setActivationTarget(null);
    } finally {
      setUpdatingStatus(false);
    }
  };

  const handleSearch = (
    event: FormEvent<HTMLFormElement>,
  ): void => {
    event.preventDefault();
    setPage(1);
    setSearch(searchInput.trim());
  };

  const columns = useMemo<
    DataTableColumn<ProductBOM>[]
  >(
    () => [
      {
        key: "product",
        header: "Finished product",
        render: (bom) => (
          <div>
            <p className="font-semibold text-text-primary">
              {bom.product_name}
            </p>
            <p className="mt-1 text-xs text-text-muted">
              {bom.product_code}
            </p>
          </div>
        ),
      },
      {
        key: "version",
        header: "BOM version",
        render: (bom) => (
          <span className="font-medium">
            {formatBOMVersion(bom.version)}
          </span>
        ),
      },
      {
        key: "standard_batch_size",
        header: "Standard batch",
        numeric: true,
        render: (bom) => (
          <span className="app-numeric">
            {formatQuantity(bom.standard_batch_size)}
          </span>
        ),
      },
      {
        key: "expected_output",
        header: "Expected good output",
        numeric: true,
        render: (bom) => (
          <span className="app-numeric">
            {formatQuantity(bom.expected_output)}
          </span>
        ),
      },
      {
        key: "materials",
        header: "Materials",
        numeric: true,
        render: (bom) => (
          <span className="app-numeric">
            {bom.items.length}
          </span>
        ),
        hideOnMobile: true,
      },
      {
        key: "effective_from",
        header: "Effective from",
        render: (bom) =>
          formatDate(bom.effective_from),
        hideOnMobile: true,
      },
      {
        key: "effective_to",
        header: "Effective to",
        render: (bom) =>
          bom.effective_to
            ? formatDate(bom.effective_to)
            : "—",
        hideOnMobile: true,
      },
      {
        key: "status",
        header: "Status",
        render: (bom) => (
          <StatusBadge
            status={bom.is_active ? "active" : "inactive"}
            label={bom.is_active ? "Active" : "Inactive"}
            variant={
              bom.is_active ? "success" : "neutral"
            }
            showDot
          />
        ),
      },
      {
        key: "actions",
        header: "Actions",
        align: "right",
        render: (bom) => (
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                void openDetails(bom);
              }}
              className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline"
            >
              <Eye size={15} aria-hidden="true" />
              View
            </button>

            {canManageBOMs && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    void openEdit(bom);
                  }}
                  disabled={!isOnline}
                  className="text-sm font-medium text-primary hover:underline disabled:opacity-50"
                >
                  Edit
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setActivationTarget(bom);
                  }}
                  disabled={!isOnline}
                  className="text-sm font-medium text-text-muted hover:underline disabled:opacity-50"
                >
                  {bom.is_active
                    ? "Deactivate"
                    : "Activate"}
                </button>
              </>
            )}
          </div>
        ),
      },
    ],
    [canManageBOMs, isOnline],
  );

  if (!canViewBOMs) {
    return (
      <div className="app-page space-y-5">
        <div>
          <h2 className="app-page-title">
            Bills of Materials
          </h2>
          <p className="app-page-description">
            Product recipes and standard material
            requirements.
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
              BOM access is not available for this
              role.
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
            Bills of Materials
          </h2>

          <p className="app-page-description">
            Manage versioned production recipes,
            standard batch quantities, expected
            output, and raw or packaging material
            requirements.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={refresh}
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

          {canManageBOMs && (
            <button
              type="button"
              onClick={openCreate}
              disabled={!isOnline}
              className="app-button app-button-primary inline-flex items-center gap-2"
            >
              <Plus size={17} aria-hidden="true" />
              New BOM
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
            BOM creation and modification require
            a backend connection. Offline sales
            order capture does not apply to
            production recipe management.
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
          className="app-alert app-alert-success flex items-center gap-2"
        >
          <CheckCircle2
            size={18}
            aria-hidden="true"
          />
          {successMessage}
        </div>
      )}

      <section
        aria-label="BOM management principles"
        className="grid gap-4 md:grid-cols-2"
      >
        <div className="flex items-start gap-3 rounded-card border border-border bg-surface p-4">
          <BookOpen
            size={21}
            className="mt-0.5 shrink-0 text-primary"
            aria-hidden="true"
          />

          <div>
            <h3 className="text-sm font-semibold text-text-primary">
              Versioned recipes
            </h3>
            <p className="mt-1 text-xs leading-5 text-text-muted">
              Each finished product can have
              multiple BOM versions. Historical
              versions used by production runs
              remain available for traceability.
            </p>
          </div>
        </div>

        <div className="flex items-start gap-3 rounded-card border border-border bg-surface p-4">
          <ClipboardList
            size={21}
            className="mt-0.5 shrink-0 text-primary"
            aria-hidden="true"
          />

          <div>
            <h3 className="text-sm font-semibold text-text-primary">
              Standard requirements
            </h3>
            <p className="mt-1 text-xs leading-5 text-text-muted">
              Material quantities define planned
              consumption. The backend scales
              requirements for production runs
              and records actual consumption
              separately.
            </p>
          </div>
        </div>
      </section>

      <section
        aria-labelledby="bom-list-heading"
        className="app-card space-y-5"
      >
        <div>
          <h3
            id="bom-list-heading"
            className="text-base font-semibold text-text-primary"
          >
            Product BOM records
          </h3>

          <p className="mt-1 text-sm text-text-muted">
            Review recipes, effective dates,
            version numbers, and active status.
          </p>
        </div>

        <div className="flex flex-col gap-4 md:flex-row md:items-end">
          <form
            onSubmit={handleSearch}
            role="search"
            className="flex min-w-0 flex-1 gap-2"
          >
            <label
              htmlFor="bom-search"
              className="app-sr-only"
            >
              Search bills of materials
            </label>

            <div className="relative min-w-0 flex-1">
              <Search
                size={17}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
                aria-hidden="true"
              />

              <input
                id="bom-search"
                type="search"
                value={searchInput}
                onChange={(event) =>
                  setSearchInput(event.target.value)
                }
                placeholder="Search product or BOM..."
                className="app-input w-full pl-10"
              />
            </div>

            <button
              type="submit"
              className="app-button app-button-secondary"
            >
              Search
            </button>
          </form>

          <label className="flex items-center gap-2 text-sm text-text-primary">
            <input
              type="checkbox"
              checked={activeOnly}
              onChange={(event) => {
                setPage(1);
                setActiveOnly(event.target.checked);
              }}
              className="h-4 w-4 accent-primary"
            />
            Active BOMs only
          </label>
        </div>

        {loading && boms.length === 0 ? (
          <LoadingState
            variant="section"
            message="Loading bills of materials..."
          />
        ) : (
          <DataTable<ProductBOM>
            columns={columns}
            data={boms}
            getRowId={(bom) => bom.id}
            loading={loading}
            error={error}
            onRetry={refresh}
            emptyMessage="No bills of materials found"
            emptyDescription={
              search || activeOnly
                ? "Try changing the search or active filter."
                : "No product BOM records are available."
            }
            pagination={{
              page,
              pageSize: PAGE_SIZE,
              total,
              onPageChange: setPage,
            }}
            testId="bom-table"
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
              Historical recipe integrity
            </h3>

            <p className="mt-1 text-xs leading-5 text-text-muted">
              Material requirements and expected
              output must not be overwritten for
              BOM versions referenced by production
              runs. Create a new version when
              changing the recipe. Activation,
              version uniqueness, effective-date
              conflicts, and historical protections
              are enforced by the backend.
            </p>
          </div>
        </div>
      </div>

      {selectedBOM && (
        <div
          role="presentation"
          className="fixed inset-0 z-50 flex items-center justify-center bg-text-primary/60 p-3 sm:p-6"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              closeDetails();
            }
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="bom-details-title"
            className="flex max-h-[95vh] w-full max-w-3xl flex-col overflow-hidden rounded-card bg-surface shadow-xl"
          >
            <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4 sm:px-6">
              <div>
                <h3
                  id="bom-details-title"
                  className="text-lg font-semibold text-text-primary"
                >
                  BOM details
                </h3>

                <p className="mt-1 text-sm text-text-muted">
                  {selectedBOM.product_name} —{" "}
                  {formatBOMVersion(selectedBOM.version)}
                </p>
              </div>

              <button
                type="button"
                onClick={closeDetails}
                aria-label="Close BOM details"
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
                  message="Loading BOM details..."
                />
              ) : !detailsError ? (
                <BOMDetails bom={selectedBOM} />
              ) : null}
            </div>
          </section>
        </div>
      )}

      {formMode && (
        <div
          role="presentation"
          className="fixed inset-0 z-50 flex items-center justify-center bg-text-primary/60 p-3 sm:p-6"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              closeForm();
            }
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="bom-form-title"
            className="flex max-h-[95vh] w-full max-w-3xl flex-col overflow-hidden rounded-card bg-surface shadow-xl"
          >
            <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-5 py-4 sm:px-6">
              <div>
                <h3
                  id="bom-form-title"
                  className="text-lg font-semibold text-text-primary"
                >
                  {formMode === "create"
                    ? "Create bill of materials"
                    : "Edit BOM schedule"}
                </h3>

                <p className="mt-1 text-sm text-text-muted">
                  {formMode === "create"
                    ? "Define a new recipe version and standard material requirements."
                    : "Update effective dates and activation without changing historical recipe quantities."}
                </p>
              </div>

              <button
                type="button"
                onClick={closeForm}
                disabled={saving}
                aria-label="Close BOM form"
                className="rounded-control p-2 text-text-muted hover:bg-background focus-visible:outline-2 focus-visible:outline-accent"
              >
                <X size={20} aria-hidden="true" />
              </button>
            </div>

            {formMode === "create" ? (
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

                  {lookupsError && (
                    <div
                      role="alert"
                      className="app-alert app-alert-error"
                    >
                      {lookupsError}
                    </div>
                  )}

                  <div>
                    <label
                      htmlFor="bom-product"
                      className="app-field-label mb-2 block"
                    >
                      Finished product *
                    </label>

                    <select
                      id="bom-product"
                      value={form.product_id}
                      onChange={(event) =>
                        updateForm(
                          "product_id",
                          event.target.value,
                        )
                      }
                      required
                      disabled={saving || lookupsLoading}
                      className="app-select w-full"
                    >
                      <option value="">
                        {lookupsLoading
                          ? "Loading products..."
                          : "Select a finished product"}
                      </option>

                      {availableProducts.map((product) => (
                        <option
                          key={product.id}
                          value={product.id}
                        >
                          {product.item_code} — {product.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-3">
                    <div>
                      <label
                        htmlFor="bom-version"
                        className="app-field-label mb-2 block"
                      >
                        Version *
                      </label>

                      <input
                        id="bom-version"
                        type="number"
                        min="1"
                        step="1"
                        value={form.version}
                        onChange={(event) =>
                          updateForm(
                            "version",
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
                        htmlFor="bom-standard-batch"
                        className="app-field-label mb-2 block"
                      >
                        Standard batch size *
                      </label>

                      <input
                        id="bom-standard-batch"
                        type="text"
                        inputMode="decimal"
                        value={form.standard_batch_size}
                        onChange={(event) =>
                          updateForm(
                            "standard_batch_size",
                            event.target.value,
                          )
                        }
                        required
                        disabled={saving}
                        className="app-input w-full"
                        placeholder="0"
                      />
                    </div>

                    <div>
                      <label
                        htmlFor="bom-expected-output"
                        className="app-field-label mb-2 block"
                      >
                        Expected good output *
                      </label>

                      <input
                        id="bom-expected-output"
                        type="text"
                        inputMode="decimal"
                        value={form.expected_output}
                        onChange={(event) =>
                          updateForm(
                            "expected_output",
                            event.target.value,
                          )
                        }
                        required
                        disabled={saving}
                        className="app-input w-full"
                        placeholder="0"
                      />
                    </div>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <label
                        htmlFor="bom-effective-from"
                        className="app-field-label mb-2 block"
                      >
                        Effective from *
                      </label>

                      <input
                        id="bom-effective-from"
                        type="date"
                        value={form.effective_from}
                        onChange={(event) =>
                          updateForm(
                            "effective_from",
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
                        htmlFor="bom-effective-to"
                        className="app-field-label mb-2 block"
                      >
                        Effective to
                      </label>

                      <input
                        id="bom-effective-to"
                        type="date"
                        value={form.effective_to}
                        onChange={(event) =>
                          updateForm(
                            "effective_to",
                            event.target.value,
                          )
                        }
                        disabled={saving}
                        className="app-input w-full"
                      />
                    </div>
                  </div>

                  <label className="flex items-center gap-2 text-sm text-text-primary">
                    <input
                      type="checkbox"
                      checked={form.is_active}
                      onChange={(event) =>
                        updateForm(
                          "is_active",
                          event.target.checked,
                        )
                      }
                      disabled={saving}
                      className="h-4 w-4 accent-primary"
                    />
                    Active BOM
                  </label>

                  <div className="border-t border-border pt-5">
                    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <h4 className="text-sm font-semibold text-text-primary">
                          Material requirements
                        </h4>

                        <p className="mt-1 text-xs text-text-muted">
                          Specify raw and packaging
                          materials in their base units.
                        </p>
                      </div>

                      <button
                        type="button"
                        onClick={addLine}
                        disabled={saving || lookupsLoading}
                        className="app-button app-button-secondary inline-flex items-center gap-2"
                      >
                        <Plus
                          size={16}
                          aria-hidden="true"
                        />
                        Add material
                      </button>
                    </div>

                    <div className="space-y-3">
                      {form.items.map((line, index) => {
                        const material =
                          availableMaterials.find(
                            (item) =>
                              item.id === line.item_id,
                          );

                        return (
                          <div
                            key={line.key}
                            className="rounded-control border border-border bg-background p-4"
                          >
                            <div className="mb-3 flex items-center justify-between">
                              <span className="text-xs font-semibold text-text-muted">
                                Material {index + 1}
                              </span>

                              <button
                                type="button"
                                onClick={() =>
                                  removeLine(line.key)
                                }
                                disabled={
                                  saving ||
                                  form.items.length === 1
                                }
                                aria-label={`Remove material ${index + 1}`}
                                className="rounded-control p-2 text-error hover:bg-error/10 disabled:opacity-40"
                              >
                                <Trash2
                                  size={17}
                                  aria-hidden="true"
                                />
                              </button>
                            </div>

                            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_170px]">
                              <div>
                                <label
                                  htmlFor={`bom-item-${line.key}`}
                                  className="app-field-label mb-2 block"
                                >
                                  Material *
                                </label>

                                <select
                                  id={`bom-item-${line.key}`}
                                  value={line.item_id}
                                  onChange={(event) =>
                                    updateLine(
                                      line.key,
                                      "item_id",
                                      event.target.value,
                                    )
                                  }
                                  required
                                  disabled={
                                    saving || lookupsLoading
                                  }
                                  className="app-select w-full"
                                >
                                  <option value="">
                                    Select material
                                  </option>

                                  {availableMaterials.map(
                                    (item) => (
                                      <option
                                        key={item.id}
                                        value={item.id}
                                      >
                                        {item.item_code} —{" "}
                                        {item.name}
                                      </option>
                                    ),
                                  )}
                                </select>
                              </div>

                              <div>
                                <label
                                  htmlFor={`bom-quantity-${line.key}`}
                                  className="app-field-label mb-2 block"
                                >
                                  Quantity *
                                </label>

                                <input
                                  id={`bom-quantity-${line.key}`}
                                  type="text"
                                  inputMode="decimal"
                                  value={
                                    line.quantity_required
                                  }
                                  onChange={(event) =>
                                    updateLine(
                                      line.key,
                                      "quantity_required",
                                      event.target.value,
                                    )
                                  }
                                  required
                                  disabled={saving}
                                  placeholder="0"
                                  className="app-input w-full"
                                />

                                {material && (
                                  <p className="mt-1 text-xs text-text-muted">
                                    Unit:{" "}
                                    {material.base_unit}
                                  </p>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <div className="rounded-control border border-border bg-background p-4">
                    <p className="text-xs leading-5 text-text-muted">
                      BOM version uniqueness,
                      effective-date validity,
                      material eligibility, and
                      standard quantity constraints
                      are validated by the backend.
                      Creating a BOM does not consume
                      stock or create a production run.
                    </p>
                  </div>
                </div>

                <div className="flex justify-end gap-3 border-t border-border px-5 py-4 sm:px-6">
                  <button
                    type="button"
                    onClick={closeForm}
                    disabled={saving}
                    className="app-button app-button-secondary"
                  >
                    Cancel
                  </button>

                  <button
                    type="submit"
                    disabled={
                      saving ||
                      lookupsLoading ||
                      Boolean(lookupsError) ||
                      !isOnline
                    }
                    className="app-button app-button-primary"
                  >
                    {saving
                      ? "Creating..."
                      : "Create BOM"}
                  </button>
                </div>
              </form>
            ) : (
              <form
                onSubmit={(event) => {
                  void handleEdit(event);
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

                  {editingBOM && (
                    <div className="rounded-control bg-background p-4">
                      <p className="text-sm font-semibold text-text-primary">
                        {editingBOM.product_name}
                      </p>
                      <p className="mt-1 text-xs text-text-muted">
                        {formatBOMVersion(
                          editingBOM.version,
                        )}
                      </p>
                    </div>
                  )}

                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <label
                        htmlFor="edit-bom-effective-from"
                        className="app-field-label mb-2 block"
                      >
                        Effective from *
                      </label>

                      <input
                        id="edit-bom-effective-from"
                        type="date"
                        value={editForm.effective_from}
                        onChange={(event) =>
                          setEditForm((current) => ({
                            ...current,
                            effective_from:
                              event.target.value,
                          }))
                        }
                        required
                        disabled={saving}
                        className="app-input w-full"
                      />
                    </div>

                    <div>
                      <label
                        htmlFor="edit-bom-effective-to"
                        className="app-field-label mb-2 block"
                      >
                        Effective to
                      </label>

                      <input
                        id="edit-bom-effective-to"
                        type="date"
                        value={editForm.effective_to}
                        onChange={(event) =>
                          setEditForm((current) => ({
                            ...current,
                            effective_to:
                              event.target.value,
                          }))
                        }
                        disabled={saving}
                        className="app-input w-full"
                      />
                    </div>
                  </div>

                  <label className="flex items-center gap-2 text-sm text-text-primary">
                    <input
                      type="checkbox"
                      checked={editForm.is_active}
                      onChange={(event) =>
                        setEditForm((current) => ({
                          ...current,
                          is_active:
                            event.target.checked,
                        }))
                      }
                      disabled={saving}
                      className="h-4 w-4 accent-primary"
                    />
                    Active BOM
                  </label>

                  <div className="rounded-control border border-border bg-background p-4">
                    <p className="text-xs leading-5 text-text-muted">
                      Recipe quantities, finished
                      product, and BOM version are
                      immutable in this form.
                      Create a new version to change
                      material requirements or
                      standard output.
                    </p>
                  </div>
                </div>

                <div className="flex justify-end gap-3 border-t border-border px-5 py-4 sm:px-6">
                  <button
                    type="button"
                    onClick={closeForm}
                    disabled={saving}
                    className="app-button app-button-secondary"
                  >
                    Cancel
                  </button>

                  <button
                    type="submit"
                    disabled={saving || !isOnline}
                    className="app-button app-button-primary"
                  >
                    {saving
                      ? "Saving..."
                      : "Save changes"}
                  </button>
                </div>
              </form>
            )}
          </section>
        </div>
      )}

      <ConfirmDialog
        open={activationTarget !== null}
        title={
          activationTarget?.is_active
            ? "Deactivate BOM?"
            : "Activate BOM?"
        }
        message={
          activationTarget
            ? `${activationTarget.product_name}, version ${activationTarget.version}`
            : undefined
        }
        description={
          activationTarget?.is_active
            ? "Deactivation prevents this recipe from being selected for new production runs where backend rules require an active BOM. Historical production references remain unchanged."
            : "Activation makes this recipe eligible for production planning subject to backend version and effective-date validation."
        }
        variant="warning"
        confirmLabel={
          activationTarget?.is_active
            ? "Deactivate"
            : "Activate"
        }
        cancelLabel="Cancel"
        isLoading={updatingStatus}
        onCancel={() => {
          if (!updatingStatus) {
            setActivationTarget(null);
          }
        }}
        onConfirm={handleToggleActive}
      />
    </div>
  );
}

export default BOMPage;