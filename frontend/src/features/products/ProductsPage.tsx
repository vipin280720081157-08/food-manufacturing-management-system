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
  Package,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  X,
} from "lucide-react";

import type {
  Product,
  UnitOfMeasure,
} from "../../types/business";

import {
  USER_ROLES,
} from "../../types/auth";

import {
  useAuth,
} from "../../hooks/useAuth";

import {
  getProducts,
  createProduct,
  updateProduct,
} from "../../services/api/mastersApi";

import {
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
  ConfirmDialog,
} from "../../components/common/ConfirmDialog";

import {
  FormField,
  SelectField,
  TextareaField,
} from "../../components/forms/FormField";

import {
  formatQuantity,
} from "../../utils/formatters";

const PAGE_SIZE = 20;

const UNIT_OPTIONS: ReadonlyArray<{
  value: UnitOfMeasure;
  label: string;
}> = [
  { value: "kg", label: "Kilograms (kg)" },
  { value: "g", label: "Grams (g)" },
  { value: "l", label: "Litres (l)" },
  { value: "ml", label: "Millilitres (ml)" },
  { value: "pcs", label: "Pieces (pcs)" },
  { value: "packets", label: "Packets" },
  { value: "cartons", label: "Cartons" },
];

const PRODUCT_ITEM_TYPE = "finished_product" as const;

interface ProductFormValues {
  item_code: string;
  name: string;
  description: string;
  sku: string;
  hsn_code: string;
  base_unit: UnitOfMeasure;
  package_size: string;
  package_unit: UnitOfMeasure;
  gst_rate: string;
  is_active: boolean;
}

type ProductFormErrors = Partial<
  Record<keyof ProductFormValues, string>
>;

interface ProductFormProps {
  product: Product | null;
  saving: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (
    values: ProductFormValues,
  ) => Promise<void>;
}

interface ProductDetailsProps {
  product: Product;
  onClose: () => void;
}

function joinClasses(
  ...classes: Array<string | false | null | undefined>
): string {
  return classes.filter(Boolean).join(" ");
}

function createEmptyForm(): ProductFormValues {
  return {
    item_code: "",
    name: "",
    description: "",
    sku: "",
    hsn_code: "",
    base_unit: "packets",
    package_size: "",
    package_unit: "g",
    gst_rate: "",
    is_active: true,
  };
}

function toFormValues(
  product: Product,
): ProductFormValues {
  return {
    item_code: product.item_code,
    name: product.name,
    description: product.description ?? "",
    sku: product.sku,
    hsn_code: product.hsn_code,
    base_unit: product.base_unit,
    package_size: product.package_size,
    package_unit: product.package_unit,
    gst_rate: product.gst_rate,
    is_active: product.is_active,
  };
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

function isPositiveDecimal(
  value: string,
): boolean {
  const normalized = normalizeDecimal(value);

  if (!/^\d+(?:\.\d+)?$/.test(normalized)) {
    return false;
  }

  return /[1-9]/.test(normalized);
}

function isValidPercentage(
  value: string,
): boolean {
  const normalized = normalizeDecimal(value);

  if (!/^\d+(?:\.\d+)?$/.test(normalized)) {
    return false;
  }

  const numericValue = Number(normalized);

  return (
    Number.isFinite(numericValue) &&
    numericValue >= 0 &&
    numericValue <= 100
  );
}

function validateForm(
  values: ProductFormValues,
): ProductFormErrors {
  const errors: ProductFormErrors = {};

  if (!values.item_code.trim()) {
    errors.item_code =
      "Item code is required.";
  }

  if (!values.name.trim()) {
    errors.name =
      "Product name is required.";
  }

  if (!values.sku.trim()) {
    errors.sku =
      "SKU is required.";
  }

  if (!values.hsn_code.trim()) {
    errors.hsn_code =
      "HSN code is required.";
  } else if (
    !/^\d{4}(?:\d{2})?(?:\d{2})?$/.test(
      values.hsn_code.trim(),
    )
  ) {
    errors.hsn_code =
      "Enter a valid 4-, 6-, or 8-digit HSN code.";
  }

  if (
    !UNIT_OPTIONS.some(
      (option) =>
        option.value === values.base_unit,
    )
  ) {
    errors.base_unit =
      "Select a valid base unit.";
  }

  if (
    !isPositiveDecimal(
      values.package_size,
    )
  ) {
    errors.package_size =
      "Package size must be greater than zero.";
  }

  if (
    !UNIT_OPTIONS.some(
      (option) =>
        option.value === values.package_unit,
    )
  ) {
    errors.package_unit =
      "Select a valid package unit.";
  }

  if (!isValidPercentage(values.gst_rate)) {
    errors.gst_rate =
      "GST rate must be between 0 and 100.";
  }

  return errors;
}

function getUnitLabel(
  unit: UnitOfMeasure,
): string {
  return (
    UNIT_OPTIONS.find(
      (option) => option.value === unit,
    )?.label ?? unit
  );
}

function ProductForm({
  product,
  saving,
  error,
  onCancel,
  onSubmit,
}: ProductFormProps) {
  const [values, setValues] =
    useState<ProductFormValues>(() =>
      product
        ? toFormValues(product)
        : createEmptyForm(),
    );

  const [errors, setErrors] =
    useState<ProductFormErrors>({});

  const submittingRef = useRef(false);

  const updateField = <
    K extends keyof ProductFormValues,
  >(
    field: K,
    value: ProductFormValues[K],
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

  const handleSubmit = async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();

    if (saving || submittingRef.current) {
      return;
    }

    const normalized: ProductFormValues = {
      ...values,
      item_code: values.item_code.trim(),
      name: values.name.trim(),
      description: values.description.trim(),
      sku: values.sku.trim(),
      hsn_code: values.hsn_code.trim(),
      package_size: normalizeDecimal(
        values.package_size,
      ),
      gst_rate: normalizeDecimal(
        values.gst_rate,
      ),
    };

    const validationErrors =
      validateForm(normalized);

    setErrors(validationErrors);

    if (
      Object.keys(validationErrors).length > 0
    ) {
      return;
    }

    submittingRef.current = true;

    try {
      await onSubmit(normalized);
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
          Product identification
        </legend>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            label="Item code"
            name="item_code"
            value={values.item_code}
            onChange={(event) =>
              updateField(
                "item_code",
                event.target.value,
              )
            }
            error={errors.item_code}
            required
            disabled={
              saving || product !== null
            }
            maxLength={50}
          />

          <FormField
            label="SKU"
            name="sku"
            value={values.sku}
            onChange={(event) =>
              updateField(
                "sku",
                event.target.value,
              )
            }
            error={errors.sku}
            required
            disabled={saving}
            maxLength={100}
          />
        </div>

        <FormField
          label="Product name"
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

        <TextareaField
          label="Description"
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
        />
      </fieldset>

      <fieldset className="space-y-4 border-t border-border pt-5">
        <legend className="text-sm font-semibold text-text-primary">
          Units and packaging
        </legend>

        <p className="text-xs leading-5 text-text-muted">
          The base unit identifies the inventory
          quantity unit. Package size and package
          unit describe the physical contents of
          one finished product package.
        </p>

        <SelectField
          label="Base inventory unit"
          name="base_unit"
          value={values.base_unit}
          options={UNIT_OPTIONS}
          onChange={(event) =>
            updateField(
              "base_unit",
              event.target.value as UnitOfMeasure,
            )
          }
          error={errors.base_unit}
          required
          disabled={saving}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            label="Package size"
            name="package_size"
            type="text"
            inputMode="decimal"
            value={values.package_size}
            onChange={(event) =>
              updateField(
                "package_size",
                event.target.value,
              )
            }
            error={errors.package_size}
            helperText="Positive decimal quantity."
            required
            disabled={saving}
            placeholder="e.g. 500"
          />

          <SelectField
            label="Package unit"
            name="package_unit"
            value={values.package_unit}
            options={UNIT_OPTIONS}
            onChange={(event) =>
              updateField(
                "package_unit",
                event.target.value as UnitOfMeasure,
              )
            }
            error={errors.package_unit}
            required
            disabled={saving}
          />
        </div>
      </fieldset>

      <fieldset className="space-y-4 border-t border-border pt-5">
        <legend className="text-sm font-semibold text-text-primary">
          Tax classification and status
        </legend>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            label="HSN code"
            name="hsn_code"
            value={values.hsn_code}
            onChange={(event) =>
              updateField(
                "hsn_code",
                event.target.value,
              )
            }
            error={errors.hsn_code}
            helperText="4, 6, or 8 numeric digits."
            required
            disabled={saving}
            maxLength={8}
            inputMode="numeric"
          />

          <FormField
            label="GST rate (%)"
            name="gst_rate"
            type="text"
            inputMode="decimal"
            value={values.gst_rate}
            onChange={(event) =>
              updateField(
                "gst_rate",
                event.target.value,
              )
            }
            error={errors.gst_rate}
            helperText="Enter the configured tax rate."
            required
            disabled={saving}
            placeholder="e.g. 5"
          />

          <SelectField
            label="Product status"
            name="is_active"
            value={
              values.is_active
                ? "active"
                : "inactive"
            }
            options={[
              {
                value: "active",
                label: "Active",
              },
              {
                value: "inactive",
                label: "Inactive",
              },
            ]}
            onChange={(event) =>
              updateField(
                "is_active",
                event.target.value === "active",
              )
            }
            disabled={saving}
          />
        </div>

        <p className="text-xs leading-5 text-text-muted">
          GST amounts are calculated and validated
          by the backend when taxable transactions
          are processed.
        </p>
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
          disabled={saving}
          className="app-button app-button-primary"
        >
          {saving
            ? "Saving..."
            : product
              ? "Save changes"
              : "Create product"}
        </button>
      </div>
    </form>
  );
}

function ProductDetails({
  product,
  onClose,
}: ProductDetailsProps) {
  return (
    <div className="space-y-6">
      <dl className="grid gap-5 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-text-muted">
            Item code
          </dt>
          <dd className="mt-1 font-medium text-text-primary">
            {product.item_code}
          </dd>
        </div>

        <div>
          <dt className="text-text-muted">
            SKU
          </dt>
          <dd className="mt-1 font-medium text-text-primary">
            {product.sku}
          </dd>
        </div>

        <div className="sm:col-span-2">
          <dt className="text-text-muted">
            Product name
          </dt>
          <dd className="mt-1 font-medium text-text-primary">
            {product.name}
          </dd>
        </div>

        <div>
          <dt className="text-text-muted">
            Item type
          </dt>
          <dd className="mt-1 text-text-primary">
            Finished product
          </dd>
        </div>

        <div>
          <dt className="text-text-muted">
            Base inventory unit
          </dt>
          <dd className="mt-1 text-text-primary">
            {getUnitLabel(product.base_unit)}
          </dd>
        </div>

        <div>
          <dt className="text-text-muted">
            Package size
          </dt>
          <dd className="mt-1 text-text-primary">
            {formatQuantity(
              product.package_size,
            )}{" "}
            {product.package_unit}
          </dd>
        </div>

        <div>
          <dt className="text-text-muted">
            HSN code
          </dt>
          <dd className="mt-1 text-text-primary">
            {product.hsn_code}
          </dd>
        </div>

        <div>
          <dt className="text-text-muted">
            GST rate
          </dt>
          <dd className="mt-1 text-text-primary">
            {product.gst_rate}%
          </dd>
        </div>

        <div>
          <dt className="text-text-muted">
            Status
          </dt>
          <dd className="mt-1">
            <StatusBadge
              status={
                product.is_active
                  ? "active"
                  : "inactive"
              }
              label={
                product.is_active
                  ? "Active"
                  : "Inactive"
              }
              variant={
                product.is_active
                  ? "success"
                  : "neutral"
              }
              showDot
            />
          </dd>
        </div>
      </dl>

      <div className="border-t border-border pt-4">
        <h4 className="text-sm font-semibold text-text-primary">
          Description
        </h4>

        <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-text-muted">
          {product.description || "No description provided."}
        </p>
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
 * Finished product master management.
 * Backend services enforce authorization, tax validation,
 * inventory relationships, and product business rules.
 */
export function ProductsPage() {
  const { user } = useAuth();

  const canManageProducts =
    user?.role === USER_ROLES.FACTORY_ADMIN;

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

  const [statusFilter, setStatusFilter] =
    useState("all");

  const [loading, setLoading] =
    useState(true);

  const [error, setError] =
    useState<string | null>(null);

  const [successMessage, setSuccessMessage] =
    useState<string | null>(null);

  const [formOpen, setFormOpen] =
    useState(false);

  const [editingProduct, setEditingProduct] =
    useState<Product | null>(null);

  const [viewingProduct, setViewingProduct] =
    useState<Product | null>(null);

  const [saving, setSaving] =
    useState(false);

  const [formError, setFormError] =
    useState<string | null>(null);

  const [statusProduct, setStatusProduct] =
    useState<Product | null>(null);

  const [changingStatus, setChangingStatus] =
    useState(false);

  const [statusError, setStatusError] =
    useState<string | null>(null);

  const loadProducts = useCallback(
    async (
      signal?: AbortSignal,
    ): Promise<void> => {
      setLoading(true);
      setError(null);

      try {
        const response = await getProducts(
          {
            page,
            page_size: PAGE_SIZE,
            search: search || undefined,
          },
          { signal },
        );

        if (signal?.aborted) {
          return;
        }

        setProducts(response.items);
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

  useEffect(() => {
    const controller = new AbortController();

    void loadProducts(controller.signal);

    return () => {
      controller.abort();
    };
  }, [loadProducts]);

  const visibleProducts = useMemo(() => {
    if (statusFilter === "active") {
      return products.filter(
        (product) => product.is_active,
      );
    }

    if (statusFilter === "inactive") {
      return products.filter(
        (product) => !product.is_active,
      );
    }

    return products;
  }, [products, statusFilter]);

  const closeForm = (): void => {
    if (saving) {
      return;
    }

    setFormOpen(false);
    setEditingProduct(null);
    setFormError(null);
  };

  const openCreateForm = (): void => {
    if (!canManageProducts) {
      return;
    }

    setEditingProduct(null);
    setFormError(null);
    setFormOpen(true);
  };

  const openEditForm = (
    product: Product,
  ): void => {
    if (!canManageProducts) {
      return;
    }

    setEditingProduct(product);
    setFormError(null);
    setFormOpen(true);
  };

  const handleSave = async (
    values: ProductFormValues,
  ): Promise<void> => {
    if (!canManageProducts || saving) {
      return;
    }

    setSaving(true);
    setFormError(null);
    setSuccessMessage(null);

    const payload = {
      name: values.name,
      description:
        values.description || null,
      sku: values.sku,
      hsn_code: values.hsn_code,
      base_unit: values.base_unit,
      package_size: values.package_size,
      package_unit: values.package_unit,
      gst_rate: values.gst_rate,
      is_active: values.is_active,
    };

    try {
      if (editingProduct) {
        await updateProduct(
          editingProduct.id,
          payload,
        );

        setSuccessMessage(
          "Product updated successfully.",
        );
      } else {
        await createProduct({
          ...payload,
          item_code: values.item_code,
          item_type: PRODUCT_ITEM_TYPE,
        });

        setSuccessMessage(
          "Product created successfully.",
        );
      }

      setFormOpen(false);
      setEditingProduct(null);

      await loadProducts();
    } catch (failure) {
      setFormError(
        getApiErrorMessage(failure),
      );
    } finally {
      setSaving(false);
    }
  };

  const handleStatusChange =
    async (): Promise<void> => {
      if (
        !statusProduct ||
        !canManageProducts ||
        changingStatus
      ) {
        return;
      }

      setChangingStatus(true);
      setStatusError(null);
      setSuccessMessage(null);

      try {
        await updateProduct(
          statusProduct.id,
          {
            is_active:
              !statusProduct.is_active,
          },
        );

        setSuccessMessage(
          statusProduct.is_active
            ? "Product deactivated successfully."
            : "Product activated successfully.",
        );

        setStatusProduct(null);

        await loadProducts();
      } catch (failure) {
        setStatusError(
          getApiErrorMessage(failure),
        );
      } finally {
        setChangingStatus(false);
      }
    };

  const columns = useMemo<
    DataTableColumn<Product>[]
  >(
    () => [
      {
        key: "item_code",
        header: "Item code",
        accessor: "item_code",
        sortable: true,
      },
      {
        key: "name",
        header: "Product",
        accessor: "name",
        sortable: true,
        render: (product) => (
          <div className="min-w-40">
            <p className="font-medium text-text-primary">
              {product.name}
            </p>

            <p className="mt-1 text-xs text-text-muted">
              SKU: {product.sku}
            </p>
          </div>
        ),
      },
      {
        key: "package_size",
        header: "Package",
        render: (product) => (
          <span className="app-nowrap">
            {formatQuantity(
              product.package_size,
            )}{" "}
            {product.package_unit}
          </span>
        ),
      },
      {
        key: "base_unit",
        header: "Stock unit",
        render: (product) =>
          product.base_unit,
        hideOnMobile: true,
      },
      {
        key: "hsn_code",
        header: "HSN",
        accessor: "hsn_code",
        hideOnMobile: true,
      },
      {
        key: "gst_rate",
        header: "GST",
        render: (product) => (
          <span className="app-numeric">
            {product.gst_rate}%
          </span>
        ),
        numeric: true,
        hideOnMobile: true,
      },
      {
        key: "is_active",
        header: "Status",
        render: (product) => (
          <StatusBadge
            status={
              product.is_active
                ? "active"
                : "inactive"
            }
            label={
              product.is_active
                ? "Active"
                : "Inactive"
            }
            variant={
              product.is_active
                ? "success"
                : "neutral"
            }
            showDot
          />
        ),
      },
      {
        key: "actions",
        header: "Actions",
        align: "right",
        render: (product) => (
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setViewingProduct(product);
              }}
              className="app-button app-button-secondary inline-flex items-center gap-1.5"
              aria-label={`View ${product.name}`}
            >
              <Eye
                size={15}
                aria-hidden="true"
              />

              View
            </button>

            {canManageProducts && (
              <>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    openEditForm(product);
                  }}
                  className="app-button app-button-secondary inline-flex items-center gap-1.5"
                  aria-label={`Edit ${product.name}`}
                >
                  <Pencil
                    size={15}
                    aria-hidden="true"
                  />

                  Edit
                </button>

                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    setStatusError(null);
                    setStatusProduct(product);
                  }}
                  className="app-button app-button-secondary"
                  aria-label={
                    product.is_active
                      ? `Deactivate ${product.name}`
                      : `Activate ${product.name}`
                  }
                >
                  {product.is_active
                    ? "Deactivate"
                    : "Activate"}
                </button>
              </>
            )}
          </div>
        ),
      },
    ],
    [canManageProducts],
  );

  const handleSearch = (
    event: FormEvent<HTMLFormElement>,
  ): void => {
    event.preventDefault();

    setPage(1);
    setSearch(searchInput.trim());
  };

  return (
    <div className="app-page space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="app-page-title">
            Products
          </h2>

          <p className="app-page-description">
            Maintain finished product information,
            stock units, packaging specifications,
            HSN codes, and GST rates.
          </p>
        </div>

        {canManageProducts && (
          <button
            type="button"
            onClick={openCreateForm}
            className="app-button app-button-primary inline-flex items-center justify-center gap-2"
          >
            <Plus
              size={18}
              aria-hidden="true"
            />

            Add product
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
              htmlFor="product-search"
              className="app-sr-only"
            >
              Search products
            </label>

            <div className="relative min-w-0 flex-1">
              <Search
                size={17}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
                aria-hidden="true"
              />

              <input
                id="product-search"
                type="search"
                value={searchInput}
                onChange={(event) =>
                  setSearchInput(
                    event.target.value,
                  )
                }
                placeholder="Search products..."
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

          <div className="flex flex-wrap items-center gap-3">
            <label
              htmlFor="product-status-filter"
              className="text-sm font-medium text-secondary"
            >
              Status
            </label>

            <select
              id="product-status-filter"
              value={statusFilter}
              onChange={(event) =>
                setStatusFilter(
                  event.target.value,
                )
              }
              className="app-select min-w-32"
            >
              <option value="all">
                All
              </option>

              <option value="active">
                Active
              </option>

              <option value="inactive">
                Inactive
              </option>
            </select>

            <button
              type="button"
              onClick={() => {
                void loadProducts();
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
        </div>

        {statusFilter !== "all" && (
          <p className="text-xs text-text-muted">
            Status filtering applies to the
            currently loaded page.
          </p>
        )}

        {loading && products.length === 0 ? (
          <LoadingState
            variant="section"
            message="Loading products..."
          />
        ) : (
          <DataTable<Product>
            columns={columns}
            data={visibleProducts}
            getRowId={(product) =>
              product.id
            }
            loading={loading}
            error={error}
            onRetry={() => loadProducts()}
            emptyMessage="No products found"
            emptyDescription={
              search
                ? "Try another search term."
                : statusFilter !== "all"
                  ? "No products match the selected status on this page."
                  : "No product records are available."
            }
            pagination={{
              page,
              pageSize: PAGE_SIZE,
              total,
              onPageChange: setPage,
            }}
            testId="products-table"
          />
        )}
      </section>

      {(formOpen || viewingProduct) && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-text-primary/60 p-3 sm:p-6"
          role="presentation"
          onMouseDown={(event) => {
            if (
              event.target !==
              event.currentTarget
            ) {
              return;
            }

            if (viewingProduct) {
              setViewingProduct(null);
            } else {
              closeForm();
            }
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="product-dialog-title"
            className={joinClasses(
              "flex max-h-[95vh] w-full max-w-3xl flex-col",
              "overflow-hidden rounded-card bg-surface shadow-xl",
            )}
          >
            <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-5 py-4 sm:px-6">
              <div>
                <h3
                  id="product-dialog-title"
                  className="text-lg font-semibold text-text-primary"
                >
                  {viewingProduct
                    ? "Product details"
                    : editingProduct
                      ? "Edit product"
                      : "Add product"}
                </h3>

                {(viewingProduct ||
                  editingProduct) && (
                  <p className="mt-1 text-sm text-text-muted">
                    {(
                      viewingProduct ??
                      editingProduct
                    )?.item_code}
                  </p>
                )}
              </div>

              <button
                type="button"
                onClick={() => {
                  if (viewingProduct) {
                    setViewingProduct(null);
                  } else {
                    closeForm();
                  }
                }}
                disabled={saving}
                aria-label="Close product dialog"
                className="rounded-control p-2 text-text-muted hover:bg-background focus-visible:outline-2 focus-visible:outline-accent"
              >
                <X
                  size={20}
                  aria-hidden="true"
                />
              </button>
            </div>

            <div className="min-h-0 overflow-y-auto px-5 py-5 sm:px-6">
              {viewingProduct ? (
                <ProductDetails
                  product={viewingProduct}
                  onClose={() =>
                    setViewingProduct(null)
                  }
                />
              ) : (
                <ProductForm
                  key={
                    editingProduct?.id ??
                    "new-product"
                  }
                  product={editingProduct}
                  saving={saving}
                  error={formError}
                  onCancel={closeForm}
                  onSubmit={handleSave}
                />
              )}
            </div>
          </section>
        </div>
      )}

      <ConfirmDialog
        open={statusProduct !== null}
        title={
          statusProduct?.is_active
            ? "Deactivate product?"
            : "Activate product?"
        }
        message={
          statusProduct?.is_active
            ? "The product will become inactive. Existing inventory, production, and sales transaction records will be preserved."
            : "The product will become active again."
        }
        variant={
          statusProduct?.is_active
            ? "warning"
            : "default"
        }
        confirmLabel={
          statusProduct?.is_active
            ? "Deactivate"
            : "Activate"
        }
        isLoading={changingStatus}
        onCancel={() => {
          if (!changingStatus) {
            setStatusProduct(null);
            setStatusError(null);
          }
        }}
        onConfirm={handleStatusChange}
      >
        {statusError && (
          <p
            role="alert"
            className="mt-3 flex items-start gap-2 text-sm text-error"
          >
            <AlertCircle
              size={16}
              className="shrink-0"
              aria-hidden="true"
            />

            {statusError}
          </p>
        )}
      </ConfirmDialog>

      {!canManageProducts && (
        <p className="flex items-start gap-2 text-xs text-text-muted">
          <Package
            size={15}
            className="shrink-0"
            aria-hidden="true"
          />

          Product master information is available
          in read-only mode for this account.
        </p>
      )}
    </div>
  );
}

export default ProductsPage;
