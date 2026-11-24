import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";

import {
  AlertCircle,
  CheckCircle2,
  Eye,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Tags,
  Trash2,
  X,
} from "lucide-react";

import type {
  Money,
  PriceListItem,
  Product,
  UUID,
} from "../../types/business";

import {
  USER_ROLES,
} from "../../types/auth";

import {
  useAuth,
} from "../../hooks/useAuth";

import {
  getProducts,
} from "../../services/api/mastersApi";

import {
  apiClient,
  getApiErrorMessage,
} from "../../services/api/client";

import {
  DataTable,
  type DataTableColumn,
} from "../../components/tables/DataTable";

import {
  StatusBadge,
} from "../../components/common/StatusBadge";

import {
  LoadingState,
} from "../../components/common/LoadingState";

import {
  FormField,
} from "../../components/forms/FormField";

import {
  formatCurrency,
  formatDate,
} from "../../utils/formatters";

const PAGE_SIZE = 20;
const PRODUCT_PAGE_SIZE = 100;

interface PriceList {
  id: UUID;
  name: string;
  description: string | null;
  effective_from: string;
  effective_to: string | null;
  is_active: boolean;
  items: PriceListItem[];
  created_at: string;
  updated_at: string | null;
}

interface PriceListSummary
  extends Omit<PriceList, "items"> {
  items?: PriceListItem[];
}

interface PaginatedPriceLists {
  items: PriceListSummary[];
  total: number;
  page: number;
  page_size: number;
}

interface PaginatedProducts {
  items: Product[];
  total: number;
  page: number;
  page_size: number;
}

interface PriceListItemInput {
  product_id: UUID;
  selling_price: Money;
}

interface PriceListPayload {
  name: string;
  description: string | null;
  effective_from: string;
  effective_to: string | null;
  is_active: boolean;
  items: PriceListItemInput[];
}

interface EditablePriceItem {
  localId: string;
  productId: string;
  sellingPrice: string;
}

interface PriceListFormValues {
  name: string;
  description: string;
  effectiveFrom: string;
  effectiveTo: string;
  isActive: boolean;
  items: EditablePriceItem[];
}

interface PriceListFormErrors {
  name?: string;
  effectiveFrom?: string;
  effectiveTo?: string;
  items?: string;
  itemErrors: Record<string, string>;
}

interface PriceListFormProps {
  initialPriceList: PriceList | null;
  products: readonly Product[];
  productsLoading: boolean;
  productsError: string | null;
  saving: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (
    payload: PriceListPayload,
  ) => Promise<void>;
}

interface PriceListDetailsProps {
  priceList: PriceList;
  products: readonly Product[];
  onClose: () => void;
}

function joinClasses(
  ...classes: Array<
    string | false | null | undefined
  >
): string {
  return classes.filter(Boolean).join(" ");
}

function todayISO(): string {
  const now = new Date();

  const year = now.getFullYear();
  const month = String(
    now.getMonth() + 1,
  ).padStart(2, "0");

  const day = String(
    now.getDate(),
  ).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function normalizeDecimal(
  value: string,
): string {
  const trimmed = value.trim();

  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return trimmed;
  }

  const [whole = "0", fraction] =
    trimmed.split(".");

  const normalizedWhole =
    whole.replace(/^0+(?=\d)/, "") || "0";

  const normalizedFraction =
    fraction?.replace(/0+$/, "");

  return normalizedFraction
    ? `${normalizedWhole}.${normalizedFraction}`
    : normalizedWhole;
}

function isValidMoney(
  value: string,
): boolean {
  const normalized = normalizeDecimal(value);

  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    return false;
  }

  const [whole = "0"] = normalized.split(".");

  return whole.length <= 15;
}

function createEditableItem(
  productId = "",
  sellingPrice = "",
): EditablePriceItem {
  return {
    localId: crypto.randomUUID(),
    productId,
    sellingPrice,
  };
}

function createEmptyForm(): PriceListFormValues {
  return {
    name: "",
    description: "",
    effectiveFrom: todayISO(),
    effectiveTo: "",
    isActive: true,
    items: [createEditableItem()],
  };
}

function toFormValues(
  priceList: PriceList,
): PriceListFormValues {
  return {
    name: priceList.name,
    description: priceList.description ?? "",
    effectiveFrom: priceList.effective_from,
    effectiveTo: priceList.effective_to ?? "",
    isActive: priceList.is_active,
    items:
      priceList.items.length > 0
        ? priceList.items.map((item) =>
            createEditableItem(
              item.product_id,
              item.selling_price,
            ),
          )
        : [createEditableItem()],
  };
}

function validateForm(
  values: PriceListFormValues,
): PriceListFormErrors {
  const errors: PriceListFormErrors = {
    itemErrors: {},
  };

  if (!values.name.trim()) {
    errors.name = "Price list name is required.";
  }

  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(
      values.effectiveFrom,
    ) ||
    Number.isNaN(
      Date.parse(values.effectiveFrom),
    )
  ) {
    errors.effectiveFrom =
      "Enter a valid effective start date.";
  }

  if (values.effectiveTo) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(
        values.effectiveTo,
      ) ||
      Number.isNaN(
        Date.parse(values.effectiveTo),
      )
    ) {
      errors.effectiveTo =
        "Enter a valid effective end date.";
    } else if (
      values.effectiveFrom &&
      values.effectiveTo <
        values.effectiveFrom
    ) {
      errors.effectiveTo =
        "End date cannot precede the start date.";
    }
  }

  if (values.items.length === 0) {
    errors.items =
      "Add at least one product price.";
  }

  const seenProducts = new Set<string>();

  for (const item of values.items) {
    if (!item.productId) {
      errors.itemErrors[item.localId] =
        "Select a product.";
      continue;
    }

    if (seenProducts.has(item.productId)) {
      errors.itemErrors[item.localId] =
        "This product is already included.";
      continue;
    }

    seenProducts.add(item.productId);

    if (!isValidMoney(item.sellingPrice)) {
      errors.itemErrors[item.localId] =
        "Enter a valid nonnegative price with up to two decimal places.";
    }
  }

  return errors;
}

function hasValidationErrors(
  errors: PriceListFormErrors,
): boolean {
  return Boolean(
    errors.name ||
      errors.effectiveFrom ||
      errors.effectiveTo ||
      errors.items ||
      Object.keys(errors.itemErrors).length > 0,
  );
}

function toPayload(
  values: PriceListFormValues,
): PriceListPayload {
  return {
    name: values.name.trim(),
    description:
      values.description.trim() || null,
    effective_from: values.effectiveFrom,
    effective_to:
      values.effectiveTo || null,
    is_active: values.isActive,
    items: values.items.map((item) => ({
      product_id: item.productId,
      selling_price: normalizeDecimal(
        item.sellingPrice,
      ),
    })),
  };
}

function isPriceListActive(
  priceList: PriceListSummary,
): boolean {
  if (!priceList.is_active) {
    return false;
  }

  const today = todayISO();

  return (
    priceList.effective_from <= today &&
    (!priceList.effective_to ||
      priceList.effective_to >= today)
  );
}

function getPriceListStatus(
  priceList: PriceListSummary,
): {
  label: string;
  variant: "success" | "warning" | "neutral";
} {
  if (!priceList.is_active) {
    return {
      label: "Inactive",
      variant: "neutral",
    };
  }

  const today = todayISO();

  if (priceList.effective_from > today) {
    return {
      label: "Scheduled",
      variant: "warning",
    };
  }

  if (
    priceList.effective_to &&
    priceList.effective_to < today
  ) {
    return {
      label: "Expired",
      variant: "neutral",
    };
  }

  return {
    label: "Active",
    variant: "success",
  };
}

async function fetchPriceLists(
  page: number,
  search: string,
  signal?: AbortSignal,
): Promise<PaginatedPriceLists> {
  return apiClient.get<PaginatedPriceLists>(
    "/price-lists",
    {
      query: {
        page,
        page_size: PAGE_SIZE,
        search: search || undefined,
      },
      signal,
    },
  );
}

async function fetchPriceList(
  id: UUID,
  signal?: AbortSignal,
): Promise<PriceList> {
  return apiClient.get<PriceList>(
    `/price-lists/${encodeURIComponent(id)}`,
    { signal },
  );
}

async function savePriceList(
  payload: PriceListPayload,
  id?: UUID,
): Promise<PriceList> {
  if (id) {
    return apiClient.put<PriceList>(
      `/price-lists/${encodeURIComponent(id)}`,
      payload,
    );
  }

  return apiClient.post<PriceList>(
    "/price-lists",
    payload,
  );
}

async function fetchAllActiveProducts(
  signal?: AbortSignal,
): Promise<Product[]> {
  const products: Product[] = [];
  let page = 1;

  while (true) {
    const response: PaginatedProducts =
      await getProducts(
        {
          page,
          page_size: PRODUCT_PAGE_SIZE,
        },
        { signal },
      );

    products.push(...response.items);

    if (
      products.length >= response.total ||
      response.items.length === 0
    ) {
      break;
    }

    page += 1;
  }

  return products;
}

function PriceListForm({
  initialPriceList,
  products,
  productsLoading,
  productsError,
  saving,
  error,
  onCancel,
  onSubmit,
}: PriceListFormProps) {
  const generatedId = useId();

  const [values, setValues] =
    useState<PriceListFormValues>(() =>
      initialPriceList
        ? toFormValues(initialPriceList)
        : createEmptyForm(),
    );

  const [errors, setErrors] =
    useState<PriceListFormErrors>({
      itemErrors: {},
    });

  const submittingRef = useRef(false);

  const productOptions = useMemo(() => {
    const selectedIds = new Set(
      values.items.map((item) => item.productId),
    );

    return products.filter(
      (product) =>
        product.is_active ||
        selectedIds.has(product.id),
    );
  }, [products, values.items]);

  const updateField = <
    K extends keyof PriceListFormValues,
  >(
    field: K,
    value: PriceListFormValues[K],
  ): void => {
    setValues((current) => ({
      ...current,
      [field]: value,
    }));

    setErrors((current) => ({
      ...current,
      [field]: undefined,
    }));
  };

  const updateItem = (
    localId: string,
    field: "productId" | "sellingPrice",
    value: string,
  ): void => {
    setValues((current) => ({
      ...current,
      items: current.items.map((item) =>
        item.localId === localId
          ? {
              ...item,
              [field]: value,
            }
          : item,
      ),
    }));

    setErrors((current) => {
      const itemErrors = {
        ...current.itemErrors,
      };

      delete itemErrors[localId];

      return {
        ...current,
        items: undefined,
        itemErrors,
      };
    });
  };

  const addItem = (): void => {
    setValues((current) => ({
      ...current,
      items: [
        ...current.items,
        createEditableItem(),
      ],
    }));

    setErrors((current) => ({
      ...current,
      items: undefined,
    }));
  };

  const removeItem = (
    localId: string,
  ): void => {
    setValues((current) => ({
      ...current,
      items: current.items.filter(
        (item) => item.localId !== localId,
      ),
    }));

    setErrors((current) => {
      const itemErrors = {
        ...current.itemErrors,
      };

      delete itemErrors[localId];

      return {
        ...current,
        itemErrors,
      };
    });
  };

  const handleSubmit = async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();

    if (
      saving ||
      productsLoading ||
      productsError ||
      submittingRef.current
    ) {
      return;
    }

    const validationErrors =
      validateForm(values);

    setErrors(validationErrors);

    if (hasValidationErrors(validationErrors)) {
      return;
    }

    const availableIds = new Set(
      productOptions.map((product) => product.id),
    );

    if (
      values.items.some(
        (item) =>
          !availableIds.has(item.productId),
      )
    ) {
      setErrors((current) => ({
        ...current,
        items:
          "One or more selected products are unavailable.",
      }));

      return;
    }

    submittingRef.current = true;

    try {
      await onSubmit(toPayload(values));
    } finally {
      submittingRef.current = false;
    }
  };

  return (
    <form
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
      noValidate
      aria-busy={saving}
      className="space-y-6"
    >
      <fieldset className="space-y-4">
        <legend className="mb-4 text-sm font-semibold text-text-primary">
          Price list information
        </legend>

        <FormField
          label="Price list name"
          name="name"
          value={values.name}
          onChange={(event) =>
            updateField(
              "name",
              event.target.value,
            )
          }
          error={errors.name}
          required
          disabled={saving}
          maxLength={200}
        />

        <div>
          <label
            htmlFor={`${generatedId}-description`}
            className="app-field-label mb-2 block"
          >
            Description
          </label>

          <textarea
            id={`${generatedId}-description`}
            name="description"
            value={values.description}
            onChange={(event) =>
              updateField(
                "description",
                event.target.value,
              )
            }
            disabled={saving}
            rows={3}
            maxLength={2000}
            className="app-textarea w-full"
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            label="Effective from"
            name="effective_from"
            type="date"
            value={values.effectiveFrom}
            onChange={(event) =>
              updateField(
                "effectiveFrom",
                event.target.value,
              )
            }
            error={errors.effectiveFrom}
            required
            disabled={saving}
          />

          <FormField
            label="Effective to"
            name="effective_to"
            type="date"
            value={values.effectiveTo}
            onChange={(event) =>
              updateField(
                "effectiveTo",
                event.target.value,
              )
            }
            error={errors.effectiveTo}
            disabled={saving}
            helperText="Leave blank for no end date."
          />
        </div>

        <div>
          <label
            htmlFor={`${generatedId}-status`}
            className="app-field-label mb-2 block"
          >
            Status
          </label>

          <select
            id={`${generatedId}-status`}
            name="is_active"
            value={
              values.isActive
                ? "active"
                : "inactive"
            }
            onChange={(event) =>
              updateField(
                "isActive",
                event.target.value === "active",
              )
            }
            disabled={saving}
            className="app-select w-full"
          >
            <option value="active">
              Active
            </option>

            <option value="inactive">
              Inactive
            </option>
          </select>
        </div>
      </fieldset>

      <fieldset className="space-y-4 border-t border-border pt-5">
        <legend className="text-sm font-semibold text-text-primary">
          Product selling prices
        </legend>

        <p className="text-xs leading-5 text-text-muted">
          Enter selling prices before GST.
          Applicable tax and transaction totals
          are calculated by the backend.
        </p>

        {productsLoading && (
          <LoadingState
            variant="inline"
            message="Loading available products..."
          />
        )}

        {productsError && (
          <div
            role="alert"
            className="app-alert app-alert-error"
          >
            {productsError}
          </div>
        )}

        {values.items.map((item, index) => {
          const itemError =
            errors.itemErrors[item.localId];

          return (
            <div
              key={item.localId}
              className="rounded-control border border-border bg-background p-4"
            >
              <div className="mb-3 flex items-center justify-between gap-3">
                <h4 className="text-sm font-semibold text-text-primary">
                  Product {index + 1}
                </h4>

                <button
                  type="button"
                  onClick={() =>
                    removeItem(item.localId)
                  }
                  disabled={saving}
                  aria-label={`Remove product ${index + 1}`}
                  className="inline-flex items-center gap-1 rounded-control px-2 py-1 text-xs font-medium text-error hover:bg-error/10 focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
                >
                  <Trash2
                    size={15}
                    aria-hidden="true"
                  />

                  Remove
                </button>
              </div>

              <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,12rem)]">
                <div>
                  <label
                    htmlFor={`${generatedId}-product-${item.localId}`}
                    className="app-field-label mb-2 block"
                  >
                    Product
                  </label>

                  <select
                    id={`${generatedId}-product-${item.localId}`}
                    value={item.productId}
                    onChange={(event) =>
                      updateItem(
                        item.localId,
                        "productId",
                        event.target.value,
                      )
                    }
                    disabled={
                      saving || productsLoading
                    }
                    required
                    aria-invalid={Boolean(itemError)}
                    className="app-select w-full"
                  >
                    <option value="">
                      Select product
                    </option>

                    {productOptions.map(
                      (product) => (
                        <option
                          key={product.id}
                          value={product.id}
                        >
                          {product.name} ({product.sku})
                        </option>
                      ),
                    )}
                  </select>
                </div>

                <div>
                  <label
                    htmlFor={`${generatedId}-price-${item.localId}`}
                    className="app-field-label mb-2 block"
                  >
                    Selling price (₹)
                  </label>

                  <input
                    id={`${generatedId}-price-${item.localId}`}
                    type="text"
                    inputMode="decimal"
                    value={item.sellingPrice}
                    onChange={(event) =>
                      updateItem(
                        item.localId,
                        "sellingPrice",
                        event.target.value,
                      )
                    }
                    disabled={saving}
                    required
                    placeholder="0.00"
                    aria-invalid={Boolean(itemError)}
                    className="app-input w-full"
                  />
                </div>
              </div>

              {itemError && (
                <p
                  role="alert"
                  className="app-field-error mt-2"
                >
                  {itemError}
                </p>
              )}
            </div>
          );
        })}

        {errors.items && (
          <p
            role="alert"
            className="app-field-error"
          >
            {errors.items}
          </p>
        )}

        <button
          type="button"
          onClick={addItem}
          disabled={
            saving ||
            productsLoading ||
            Boolean(productsError)
          }
          className="app-button app-button-secondary inline-flex items-center gap-2"
        >
          <Plus
            size={17}
            aria-hidden="true"
          />

          Add product price
        </button>
      </fieldset>

      {error && (
        <div
          role="alert"
          className="app-alert app-alert-error"
        >
          {error}
        </div>
      )}

      <div className="flex flex-wrap justify-end gap-3 border-t border-border pt-5">
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="app-button app-button-secondary"
        >
          Cancel
        </button>

        <button
          type="submit"
          disabled={
            saving ||
            productsLoading ||
            Boolean(productsError)
          }
          className="app-button app-button-primary"
        >
          {saving
            ? "Saving..."
            : initialPriceList
              ? "Save changes"
              : "Create price list"}
        </button>
      </div>
    </form>
  );
}

function PriceListDetails({
  priceList,
  products,
  onClose,
}: PriceListDetailsProps) {
  const productMap = useMemo(
    () =>
      new Map(
        products.map((product) => [
          product.id,
          product,
        ]),
      ),
    [products],
  );

  const status = getPriceListStatus(priceList);

  return (
    <div className="space-y-6">
      <dl className="grid gap-4 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-text-muted">
            Price list name
          </dt>

          <dd className="mt-1 font-medium text-text-primary">
            {priceList.name}
          </dd>
        </div>

        <div>
          <dt className="text-text-muted">
            Status
          </dt>

          <dd className="mt-1">
            <StatusBadge
              status={status.label.toLowerCase()}
              label={status.label}
              variant={status.variant}
              showDot
            />
          </dd>
        </div>

        <div>
          <dt className="text-text-muted">
            Effective from
          </dt>

          <dd className="mt-1 text-text-primary">
            {formatDate(priceList.effective_from)}
          </dd>
        </div>

        <div>
          <dt className="text-text-muted">
            Effective to
          </dt>

          <dd className="mt-1 text-text-primary">
            {priceList.effective_to
              ? formatDate(priceList.effective_to)
              : "No end date"}
          </dd>
        </div>
      </dl>

      {priceList.description && (
        <div className="border-t border-border pt-4">
          <h4 className="text-sm font-semibold text-text-primary">
            Description
          </h4>

          <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-text-muted">
            {priceList.description}
          </p>
        </div>
      )}

      <div className="border-t border-border pt-4">
        <h4 className="mb-3 text-sm font-semibold text-text-primary">
          Product prices
        </h4>

        <div className="app-table-container">
          <table className="app-table">
            <thead>
              <tr>
                <th scope="col">
                  Product
                </th>

                <th scope="col">
                  SKU
                </th>

                <th
                  scope="col"
                  className="text-right"
                >
                  Selling price
                </th>
              </tr>
            </thead>

            <tbody>
              {priceList.items.map((item) => {
                const product =
                  productMap.get(item.product_id);

                return (
                  <tr key={item.id}>
                    <td>
                      {product?.name ??
                        item.product_id}
                    </td>

                    <td>
                      {product?.sku ?? "—"}
                    </td>

                    <td className="app-numeric text-right">
                      {formatCurrency(
                        item.selling_price,
                      )}
                    </td>
                  </tr>
                );
              })}

              {priceList.items.length === 0 && (
                <tr>
                  <td
                    colSpan={3}
                    className="py-6 text-center text-text-muted"
                  >
                    No product prices recorded.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex justify-end border-t border-border pt-5">
        <button
          type="button"
          onClick={onClose}
          className="app-button app-button-secondary"
        >
          Close
        </button>
      </div>
    </div>
  );
}

/**
 * Price list management uses backend-authoritative
 * product pricing and transaction validation.
 */
export function PriceListsPage() {
  const { user } = useAuth();

  const canManagePriceLists =
    user?.role === USER_ROLES.FACTORY_ADMIN;

  const [priceLists, setPriceLists] =
    useState<PriceListSummary[]>([]);

  const [products, setProducts] =
    useState<Product[]>([]);

  const [total, setTotal] =
    useState(0);

  const [page, setPage] =
    useState(1);

  const [searchInput, setSearchInput] =
    useState("");

  const [search, setSearch] =
    useState("");

  const [loading, setLoading] =
    useState(true);

  const [productsLoading, setProductsLoading] =
    useState(false);

  const [detailsLoading, setDetailsLoading] =
    useState(false);

  const [error, setError] =
    useState<string | null>(null);

  const [productsError, setProductsError] =
    useState<string | null>(null);

  const [detailsError, setDetailsError] =
    useState<string | null>(null);

  const [successMessage, setSuccessMessage] =
    useState<string | null>(null);

  const [dialogOpen, setDialogOpen] =
    useState(false);

  const [editingPriceList, setEditingPriceList] =
    useState<PriceList | null>(null);

  const [viewingPriceList, setViewingPriceList] =
    useState<PriceList | null>(null);

  const [saving, setSaving] =
    useState(false);

  const [formError, setFormError] =
    useState<string | null>(null);

  const [dialogMode, setDialogMode] =
    useState<"create" | "edit" | "view">(
      "create",
    );

  const detailsRequestRef = useRef(0);

  const loadPriceLists = useCallback(
    async (
      signal?: AbortSignal,
    ): Promise<void> => {
      setLoading(true);
      setError(null);

      try {
        const response = await fetchPriceLists(
          page,
          search,
          signal,
        );

        if (signal?.aborted) {
          return;
        }

        setPriceLists(response.items);
        setTotal(response.total);
      } catch (failure) {
        if (signal?.aborted) {
          return;
        }

        setError(
          getApiErrorMessage(failure),
        );
      } finally {
        if (!signal?.aborted) {
          setLoading(false);
        }
      }
    },
    [page, search],
  );

  const loadProducts = useCallback(
    async (): Promise<void> => {
      setProductsLoading(true);
      setProductsError(null);

      try {
        const response =
          await fetchAllActiveProducts();

        setProducts(response);
      } catch (failure) {
        setProductsError(
          getApiErrorMessage(failure),
        );
      } finally {
        setProductsLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    const controller = new AbortController();

    void loadPriceLists(controller.signal);

    return () => {
      controller.abort();
    };
  }, [loadPriceLists]);

  useEffect(() => {
    void loadProducts();
  }, [loadProducts]);

  const closeDialog = (): void => {
    if (saving) {
      return;
    }

    detailsRequestRef.current += 1;

    setDialogOpen(false);
    setEditingPriceList(null);
    setViewingPriceList(null);
    setFormError(null);
    setDetailsError(null);
    setDetailsLoading(false);
  };

  const openCreateDialog = (): void => {
    if (!canManagePriceLists) {
      return;
    }

    setDialogMode("create");
    setEditingPriceList(null);
    setViewingPriceList(null);
    setFormError(null);
    setDetailsError(null);
    setDialogOpen(true);
  };

  const openExistingPriceList = async (
    summary: PriceListSummary,
    mode: "edit" | "view",
  ): Promise<void> => {
    if (
      mode === "edit" &&
      !canManagePriceLists
    ) {
      return;
    }

    const requestId =
      ++detailsRequestRef.current;

    setDialogMode(mode);
    setEditingPriceList(null);
    setViewingPriceList(null);
    setFormError(null);
    setDetailsError(null);
    setDetailsLoading(true);
    setDialogOpen(true);

    try {
      const details = await fetchPriceList(
        summary.id,
      );

      if (
        requestId !==
        detailsRequestRef.current
      ) {
        return;
      }

      if (mode === "edit") {
        setEditingPriceList(details);
      } else {
        setViewingPriceList(details);
      }
    } catch (failure) {
      if (
        requestId !==
        detailsRequestRef.current
      ) {
        return;
      }

      setDetailsError(
        getApiErrorMessage(failure),
      );
    } finally {
      if (
        requestId ===
        detailsRequestRef.current
      ) {
        setDetailsLoading(false);
      }
    }
  };

  const handleSave = async (
    payload: PriceListPayload,
  ): Promise<void> => {
    if (
      !canManagePriceLists ||
      saving
    ) {
      return;
    }

    setSaving(true);
    setFormError(null);
    setSuccessMessage(null);

    try {
      await savePriceList(
        payload,
        editingPriceList?.id,
      );

      setSuccessMessage(
        editingPriceList
          ? "Price list updated successfully."
          : "Price list created successfully.",
      );

      closeDialogAfterSave();

      await loadPriceLists();
    } catch (failure) {
      setFormError(
        getApiErrorMessage(failure),
      );
    } finally {
      setSaving(false);
    }
  };

  const closeDialogAfterSave = (): void => {
    detailsRequestRef.current += 1;

    setDialogOpen(false);
    setEditingPriceList(null);
    setViewingPriceList(null);
    setDetailsError(null);
  };

  const columns = useMemo<
    DataTableColumn<PriceListSummary>[]
  >(
    () => [
      {
        key: "name",
        header: "Price list",
        accessor: "name",
        sortable: true,
        render: (priceList) => (
          <div className="min-w-40">
            <p className="font-medium text-text-primary">
              {priceList.name}
            </p>

            {priceList.description && (
              <p className="mt-1 line-clamp-2 text-xs text-text-muted">
                {priceList.description}
              </p>
            )}
          </div>
        ),
      },
      {
        key: "effective_from",
        header: "Effective from",
        render: (priceList) =>
          formatDate(
            priceList.effective_from,
          ),
      },
      {
        key: "effective_to",
        header: "Effective to",
        render: (priceList) =>
          priceList.effective_to
            ? formatDate(
                priceList.effective_to,
              )
            : "No end date",
        hideOnMobile: true,
      },
      {
        key: "items",
        header: "Products",
        render: (priceList) =>
          priceList.items
            ? priceList.items.length
            : "—",
        numeric: true,
        hideOnMobile: true,
      },
      {
        key: "status",
        header: "Status",
        render: (priceList) => {
          const status =
            getPriceListStatus(priceList);

          return (
            <StatusBadge
              status={
                status.label.toLowerCase()
              }
              label={status.label}
              variant={status.variant}
              showDot
            />
          );
        },
      },
      {
        key: "actions",
        header: "Actions",
        align: "right",
        render: (priceList) => (
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();

                void openExistingPriceList(
                  priceList,
                  "view",
                );
              }}
              className="app-button app-button-secondary inline-flex items-center gap-1.5"
              aria-label={`View ${priceList.name}`}
            >
              <Eye
                size={15}
                aria-hidden="true"
              />

              View
            </button>

            {canManagePriceLists && (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();

                  void openExistingPriceList(
                    priceList,
                    "edit",
                  );
                }}
                className="app-button app-button-secondary inline-flex items-center gap-1.5"
                aria-label={`Edit ${priceList.name}`}
              >
                <Pencil
                  size={15}
                  aria-hidden="true"
                />

                Edit
              </button>
            )}
          </div>
        ),
      },
    ],
    [canManagePriceLists],
  );

  const handleSearch = (
    event: FormEvent<HTMLFormElement>,
  ): void => {
    event.preventDefault();

    setPage(1);
    setSearch(searchInput.trim());
  };

  const activeCount = useMemo(
    () =>
      priceLists.filter(isPriceListActive)
        .length,
    [priceLists],
  );

  return (
    <div className="app-page space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="app-page-title">
            Price Lists
          </h2>

          <p className="app-page-description">
            Maintain product selling prices,
            effective dates, and price list
            availability.
          </p>
        </div>

        {canManagePriceLists && (
          <button
            type="button"
            onClick={openCreateDialog}
            className="app-button app-button-primary inline-flex items-center justify-center gap-2"
          >
            <Plus
              size={18}
              aria-hidden="true"
            />

            Add price list
          </button>
        )}
      </div>

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

          <span className="flex-1">
            {successMessage}
          </span>

          <button
            type="button"
            onClick={() =>
              setSuccessMessage(null)
            }
            aria-label="Dismiss notification"
            className="rounded-control p-1 focus-visible:outline-2 focus-visible:outline-accent"
          >
            <X
              size={17}
              aria-hidden="true"
            />
          </button>
        </div>
      )}

      <section className="app-card space-y-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <form
            onSubmit={handleSearch}
            role="search"
            className="flex w-full max-w-md gap-2"
          >
            <label
              htmlFor="price-list-search"
              className="app-sr-only"
            >
              Search price lists
            </label>

            <div className="relative min-w-0 flex-1">
              <Search
                size={17}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
                aria-hidden="true"
              />

              <input
                id="price-list-search"
                type="search"
                value={searchInput}
                onChange={(event) =>
                  setSearchInput(
                    event.target.value,
                  )
                }
                placeholder="Search price lists..."
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

          <button
            type="button"
            onClick={() => {
              void loadPriceLists();
            }}
            disabled={loading}
            className="app-button app-button-secondary inline-flex items-center justify-center gap-2"
          >
            <RefreshCw
              size={16}
              className={
                loading
                  ? "motion-safe:animate-spin"
                  : ""
              }
              aria-hidden="true"
            />

            Refresh
          </button>
        </div>

        {!loading && !error && (
          <p className="text-xs text-text-muted">
            {total} price list
            {total === 1 ? "" : "s"} found.
            {" "}
            {activeCount} currently active
            on this page.
          </p>
        )}

        {loading &&
        priceLists.length === 0 ? (
          <LoadingState
            variant="section"
            message="Loading price lists..."
          />
        ) : (
          <DataTable<PriceListSummary>
            columns={columns}
            data={priceLists}
            getRowId={(priceList) =>
              priceList.id
            }
            loading={loading}
            error={error}
            onRetry={() =>
              loadPriceLists()
            }
            emptyMessage="No price lists found"
            emptyDescription={
              search
                ? "Try another search term."
                : "No price list records are available."
            }
            pagination={{
              page,
              pageSize: PAGE_SIZE,
              total,
              onPageChange: setPage,
            }}
            testId="price-lists-table"
          />
        )}
      </section>

      {dialogOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-text-primary/60 p-3 sm:p-6"
          role="presentation"
          onMouseDown={(event) => {
            if (
              event.target ===
              event.currentTarget
            ) {
              closeDialog();
            }
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="price-list-dialog-title"
            className={joinClasses(
              "flex max-h-[95vh] w-full max-w-3xl flex-col",
              "overflow-hidden rounded-card bg-surface shadow-xl",
            )}
          >
            <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-5 py-4 sm:px-6">
              <div>
                <h3
                  id="price-list-dialog-title"
                  className="text-lg font-semibold text-text-primary"
                >
                  {dialogMode === "view"
                    ? "Price list details"
                    : dialogMode === "edit"
                      ? "Edit price list"
                      : "Add price list"}
                </h3>

                <p className="mt-1 text-sm text-text-muted">
                  {dialogMode === "view"
                    ? "View configured product selling prices."
                    : "Configure product prices before GST."}
                </p>
              </div>

              <button
                type="button"
                onClick={closeDialog}
                disabled={saving}
                aria-label="Close price list dialog"
                className="rounded-control p-2 text-text-muted hover:bg-background focus-visible:outline-2 focus-visible:outline-accent"
              >
                <X
                  size={20}
                  aria-hidden="true"
                />
              </button>
            </div>

            <div className="min-h-0 overflow-y-auto px-5 py-5 sm:px-6">
              {detailsLoading ? (
                <LoadingState
                  variant="section"
                  message="Loading price list details..."
                />
              ) : detailsError ? (
                <div
                  role="alert"
                  className="app-alert app-alert-error flex items-start gap-3"
                >
                  <AlertCircle
                    size={19}
                    className="shrink-0"
                    aria-hidden="true"
                  />

                  <span>
                    {detailsError}
                  </span>
                </div>
              ) : dialogMode === "view" &&
                viewingPriceList ? (
                <PriceListDetails
                  priceList={viewingPriceList}
                  products={products}
                  onClose={closeDialog}
                />
              ) : dialogMode !== "view" &&
                (dialogMode === "create" ||
                  editingPriceList) ? (
                <PriceListForm
                  key={
                    editingPriceList?.id ??
                    "new-price-list"
                  }
                  initialPriceList={
                    editingPriceList
                  }
                  products={products}
                  productsLoading={
                    productsLoading
                  }
                  productsError={
                    productsError
                  }
                  saving={saving}
                  error={formError}
                  onCancel={closeDialog}
                  onSubmit={handleSave}
                />
              ) : null}
            </div>
          </section>
        </div>
      )}

      {!canManagePriceLists && (
        <p className="flex items-start gap-2 text-xs text-text-muted">
          <Tags
            size={15}
            className="shrink-0"
            aria-hidden="true"
          />

          Price list information is available
          in read-only mode for this account.
        </p>
      )}
    </div>
  );
}

export default PriceListsPage;