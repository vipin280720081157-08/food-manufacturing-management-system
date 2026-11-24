import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";

import {
  ArrowRight,
  BarChart3,
  CalendarDays,
  ClipboardList,
  Factory,
  FileBarChart2,
  FileText,
  FilterX,
  Package,
  RefreshCw,
  Search,
  ShieldCheck,
  ShoppingCart,
  Truck,
  Wallet,
  WifiOff,
} from "lucide-react";

import { Link } from "react-router-dom";

import { useAuth } from "../../hooks/useAuth";
import { useOnlineStatus } from "../../hooks/useOnlineStatus";

import {
  apiClient,
  getApiErrorMessage,
} from "../../services/api/client";

import { LoadingState } from "../../components/common/LoadingState";
import { ErrorState } from "../../components/common/ErrorState";

type ReportCategory =
  | "sales"
  | "purchasing"
  | "inventory"
  | "production"
  | "finance"
  | "taxation"
  | "audit";

type CategoryFilter = "all" | ReportCategory;

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

interface ReportCatalogResponse {
  items: ReportDefinition[];
}

interface CategoryDefinition {
  value: ReportCategory;
  label: string;
  description: string;
  icon: typeof FileText;
}

const CATEGORY_DEFINITIONS: readonly CategoryDefinition[] = [
  {
    value: "sales",
    label: "Sales",
    description: "Customer orders and sales performance",
    icon: ShoppingCart,
  },
  {
    value: "purchasing",
    label: "Purchasing",
    description: "Purchase orders and supplier receipts",
    icon: Truck,
  },
  {
    value: "inventory",
    label: "Inventory",
    description: "Stock balances, batches, and movements",
    icon: Package,
  },
  {
    value: "production",
    label: "Production",
    description: "Production output, variance, and costing",
    icon: Factory,
  },
  {
    value: "finance",
    label: "Finance",
    description: "Payments and outstanding receivables",
    icon: Wallet,
  },
  {
    value: "taxation",
    label: "GST and Taxation",
    description: "GST invoices and tax summaries",
    icon: FileBarChart2,
  },
  {
    value: "audit",
    label: "Audit",
    description: "Transaction history and accountability",
    icon: ShieldCheck,
  },
];

const CATEGORY_LABELS: Record<ReportCategory, string> = {
  sales: "Sales",
  purchasing: "Purchasing",
  inventory: "Inventory",
  production: "Production",
  finance: "Finance",
  taxation: "GST and Taxation",
  audit: "Audit",
};

const CATEGORY_ICONS: Record<
  ReportCategory,
  typeof FileText
> = {
  sales: ShoppingCart,
  purchasing: Truck,
  inventory: Package,
  production: Factory,
  finance: Wallet,
  taxation: FileBarChart2,
  audit: ShieldCheck,
};

const CATEGORY_ORDER: readonly ReportCategory[] = [
  "sales",
  "purchasing",
  "inventory",
  "production",
  "finance",
  "taxation",
  "audit",
];

function isReportCategory(
  value: unknown,
): value is ReportCategory {
  return (
    typeof value === "string" &&
    CATEGORY_ORDER.some((category) => category === value)
  );
}

function normalizeCatalog(
  response: ReportCatalogResponse | ReportDefinition[],
): ReportDefinition[] {
  const entries = Array.isArray(response)
    ? response
    : response.items;

  if (!Array.isArray(entries)) {
    throw new Error(
      "The report catalog response has an invalid format.",
    );
  }

  const seenIds = new Set<string>();

  return entries.filter((entry) => {
    if (
      !entry ||
      typeof entry.id !== "string" ||
      !entry.id.trim() ||
      typeof entry.code !== "string" ||
      typeof entry.name !== "string" ||
      !entry.name.trim() ||
      typeof entry.description !== "string" ||
      !isReportCategory(entry.category) ||
      typeof entry.is_available !== "boolean" ||
      typeof entry.supports_date_range !== "boolean" ||
      typeof entry.supports_export !== "boolean" ||
      seenIds.has(entry.id)
    ) {
      return false;
    }

    seenIds.add(entry.id);
    return true;
  });
}

function getReportUrl(reportId: string): string {
  return `/reports/${encodeURIComponent(reportId)}`;
}

function CategoryIcon({
  category,
  size = 20,
}: {
  category: ReportCategory;
  size?: number;
}) {
  const Icon = CATEGORY_ICONS[category];

  return <Icon size={size} aria-hidden="true" />;
}

export function ReportsPage() {
  const { user } = useAuth();
  const { isOnline } = useOnlineStatus();

  const [reports, setReports] = useState<
    ReportDefinition[]
  >([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  const [categoryFilter, setCategoryFilter] =
    useState<CategoryFilter>("all");

  const [availableOnly, setAvailableOnly] =
    useState(false);

  const [lastLoadedAt, setLastLoadedAt] =
    useState<string | null>(null);

  const canAccess = user !== null && user.is_active;

  const loadReports = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      if (!canAccess) {
        setReports([]);
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const response = await apiClient.get<
          ReportCatalogResponse | ReportDefinition[]
        >("/reports", { signal });

        if (signal?.aborted) {
          return;
        }

        setReports(normalizeCatalog(response));
        setLastLoadedAt(new Date().toISOString());
      } catch (failure) {
        if (signal?.aborted) {
          return;
        }

        setError(getApiErrorMessage(failure));
        setReports([]);
      } finally {
        if (!signal?.aborted) {
          setLoading(false);
        }
      }
    },
    [canAccess],
  );

  useEffect(() => {
    const controller = new AbortController();

    void loadReports(controller.signal);

    return () => controller.abort();
  }, [loadReports]);

  const filteredReports = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();

    return reports
      .filter((report) => {
        if (
          categoryFilter !== "all" &&
          report.category !== categoryFilter
        ) {
          return false;
        }

        if (availableOnly && !report.is_available) {
          return false;
        }

        if (!query) {
          return true;
        }

        return [
          report.name,
          report.description,
          report.code,
          CATEGORY_LABELS[report.category],
        ].some((value) =>
          value.toLocaleLowerCase().includes(query),
        );
      })
      .sort((left, right) => {
        const categoryDifference =
          CATEGORY_ORDER.indexOf(left.category) -
          CATEGORY_ORDER.indexOf(right.category);

        if (categoryDifference !== 0) {
          return categoryDifference;
        }

        return left.name.localeCompare(right.name);
      });
  }, [reports, search, categoryFilter, availableOnly]);

  const groupedReports = useMemo(
    () =>
      CATEGORY_ORDER.map((category) => ({
        category,
        reports: filteredReports.filter(
          (report) => report.category === category,
        ),
      })).filter((group) => group.reports.length > 0),
    [filteredReports],
  );

  const availableCount = useMemo(
    () =>
      reports.filter((report) => report.is_available)
        .length,
    [reports],
  );

  const categoryCounts = useMemo(() => {
    const counts: Record<ReportCategory, number> = {
      sales: 0,
      purchasing: 0,
      inventory: 0,
      production: 0,
      finance: 0,
      taxation: 0,
      audit: 0,
    };

    for (const report of reports) {
      counts[report.category] += 1;
    }

    return counts;
  }, [reports]);

  const applySearch = (
    event: FormEvent<HTMLFormElement>,
  ): void => {
    event.preventDefault();
    setSearch(searchInput.trim());
  };

  const clearFilters = (): void => {
    setSearchInput("");
    setSearch("");
    setCategoryFilter("all");
    setAvailableOnly(false);
  };

  const hasActiveFilters =
    search !== "" ||
    categoryFilter !== "all" ||
    availableOnly;

  if (!canAccess) {
    return (
      <div className="app-page space-y-5">
        <h2 className="app-page-title">
          Reports
        </h2>

        <div
          role="alert"
          className="app-alert app-alert-error"
        >
          Report access requires an active, authenticated
          user account.
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
            <BarChart3
              size={28}
              className="shrink-0 text-primary"
              aria-hidden="true"
            />

            <h2 className="app-page-title">
              Reports
            </h2>
          </div>

          <p className="app-page-description">
            Access authorized operational, financial,
            production, inventory, GST, and audit reports
            generated from backend business records.
          </p>
        </div>

        <button
          type="button"
          onClick={() => {
            void loadReports();
          }}
          disabled={loading || !isOnline}
          className="app-button app-button-secondary inline-flex items-center justify-center gap-2"
        >
          <RefreshCw
            size={17}
            className={
              loading ? "motion-safe:animate-spin" : ""
            }
            aria-hidden="true"
          />
          Refresh catalog
        </button>
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
            The device is offline. Report generation,
            current financial figures, and report exports
            require a backend connection. Reports are not
            generated from offline order drafts.
          </p>
        </div>
      )}

      <section
        aria-label="Report catalog overview"
        className="grid gap-4 sm:grid-cols-3"
      >
        <div className="rounded-card border border-border bg-surface p-5 shadow-card">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium text-text-muted">
              Reports in catalog
            </p>

            <ClipboardList
              size={21}
              className="text-primary"
              aria-hidden="true"
            />
          </div>

          <p className="app-numeric mt-3 text-2xl font-bold text-text-primary">
            {loading ? "—" : reports.length}
          </p>

          <p className="mt-2 text-xs text-text-muted">
            Reports returned for the current account
          </p>
        </div>

        <div className="rounded-card border border-border bg-surface p-5 shadow-card">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium text-text-muted">
              Available reports
            </p>

            <FileBarChart2
              size={21}
              className="text-primary"
              aria-hidden="true"
            />
          </div>

          <p className="app-numeric mt-3 text-2xl font-bold text-text-primary">
            {loading ? "—" : availableCount}
          </p>

          <p className="mt-2 text-xs text-text-muted">
            Reports enabled by the backend
          </p>
        </div>

        <div className="rounded-card border border-border bg-surface p-5 shadow-card">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium text-text-muted">
              Report categories
            </p>

            <CalendarDays
              size={21}
              className="text-primary"
              aria-hidden="true"
            />
          </div>

          <p className="app-numeric mt-3 text-2xl font-bold text-text-primary">
            {loading
              ? "—"
              : CATEGORY_ORDER.filter(
                  (category) =>
                    categoryCounts[category] > 0,
                ).length}
          </p>

          <p className="mt-2 text-xs text-text-muted">
            Categories represented in the catalog
          </p>
        </div>
      </section>

      <section className="app-card space-y-5">
        <div>
          <h3 className="text-base font-semibold text-text-primary">
            Find a report
          </h3>

          <p className="mt-1 text-sm text-text-muted">
            Filter the catalog by report name, category,
            or availability.
          </p>
        </div>

        <form
          onSubmit={applySearch}
          className="space-y-4"
        >
          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(220px,0.55fr)]">
            <div>
              <label
                htmlFor="report-search"
                className="app-field-label mb-2 block"
              >
                Search reports
              </label>

              <div className="relative">
                <Search
                  size={17}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
                  aria-hidden="true"
                />

                <input
                  id="report-search"
                  type="search"
                  value={searchInput}
                  onChange={(event) =>
                    setSearchInput(event.target.value)
                  }
                  placeholder="Search by name, code, or description..."
                  className="app-input w-full pl-10"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="report-category"
                className="app-field-label mb-2 block"
              >
                Category
              </label>

              <select
                id="report-category"
                value={categoryFilter}
                onChange={(event) =>
                  setCategoryFilter(
                    event.target.value as CategoryFilter,
                  )
                }
                className="app-select w-full"
              >
                <option value="all">
                  All categories
                </option>

                {CATEGORY_DEFINITIONS.map((category) => (
                  <option
                    key={category.value}
                    value={category.value}
                  >
                    {category.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-4">
            <label className="inline-flex cursor-pointer items-center gap-3 text-sm text-text-primary">
              <input
                type="checkbox"
                checked={availableOnly}
                onChange={(event) =>
                  setAvailableOnly(event.target.checked)
                }
                className="h-4 w-4 rounded border-border accent-primary"
              />

              Show available reports only
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
                Search
              </button>
            </div>
          </div>
        </form>
      </section>

      <section
        aria-labelledby="report-catalog-title"
        className="space-y-5"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3
              id="report-catalog-title"
              className="text-base font-semibold text-text-primary"
            >
              Report catalog
            </h3>

            <p className="mt-1 text-sm text-text-muted">
              {loading
                ? "Loading authorized reports..."
                : `${filteredReports.length} of ${reports.length} reports shown`}
            </p>
          </div>

          {lastLoadedAt && (
            <p className="text-xs text-text-muted">
              Last loaded:{" "}
              {new Date(lastLoadedAt).toLocaleString(
                "en-IN",
              )}
            </p>
          )}
        </div>

        {loading ? (
          <LoadingState
            variant="section"
            message="Loading report catalog..."
          />
        ) : error ? (
          <ErrorState
            title="Unable to load reports"
            message={error}
            onRetry={() => {
              void loadReports();
            }}
          />
        ) : groupedReports.length === 0 ? (
          <div className="rounded-card border border-border bg-surface px-6 py-12 text-center">
            <FileText
              size={36}
              className="mx-auto text-text-muted"
              aria-hidden="true"
            />

            <h4 className="mt-4 text-base font-semibold text-text-primary">
              {hasActiveFilters
                ? "No matching reports"
                : "No reports available"}
            </h4>

            <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-text-muted">
              {hasActiveFilters
                ? "No reports match the selected filters. Adjust the search or clear the filters."
                : "The backend has not returned any reports for the current account. Report availability and access are controlled by the server."}
            </p>

            {hasActiveFilters && (
              <button
                type="button"
                onClick={clearFilters}
                className="app-button app-button-secondary mt-5"
              >
                Clear filters
              </button>
            )}
          </div>
        ) : (
          groupedReports.map((group) => {
            const categoryDefinition =
              CATEGORY_DEFINITIONS.find(
                (definition) =>
                  definition.value === group.category,
              );

            if (!categoryDefinition) {
              return null;
            }

            const Icon = categoryDefinition.icon;

            return (
              <section
                key={group.category}
                aria-labelledby={`report-category-${group.category}`}
                className="space-y-3"
              >
                <div className="flex flex-wrap items-center gap-3">
                  <div className="rounded-control bg-primary/10 p-2 text-primary">
                    <Icon
                      size={20}
                      aria-hidden="true"
                    />
                  </div>

                  <div>
                    <h4
                      id={`report-category-${group.category}`}
                      className="font-semibold text-text-primary"
                    >
                      {categoryDefinition.label}
                    </h4>

                    <p className="text-xs text-text-muted">
                      {categoryDefinition.description}
                    </p>
                  </div>

                  <span className="ml-auto rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium text-text-muted">
                    {group.reports.length}{" "}
                    {group.reports.length === 1
                      ? "report"
                      : "reports"}
                  </span>
                </div>

                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {group.reports.map((report) => (
                    <article
                      key={report.id}
                      className="flex min-w-0 flex-col rounded-card border border-border bg-surface p-5 shadow-card"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="rounded-control bg-background p-2.5 text-primary">
                          <CategoryIcon
                            category={report.category}
                            size={21}
                          />
                        </div>

                        <span
                          className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                            report.is_available
                              ? "bg-success/10 text-success"
                              : "bg-background text-text-muted"
                          }`}
                        >
                          {report.is_available
                            ? "Available"
                            : "Unavailable"}
                        </span>
                      </div>

                      <div className="mt-4 flex-1">
                        <h5 className="text-base font-semibold text-text-primary">
                          {report.name}
                        </h5>

                        <p className="mt-1 break-all text-xs text-text-muted">
                          {report.code}
                        </p>

                        <p className="mt-3 text-sm leading-6 text-text-muted">
                          {report.description}
                        </p>
                      </div>

                      <div className="mt-5 flex flex-wrap gap-2 border-t border-border pt-4">
                        {report.supports_date_range && (
                          <span className="inline-flex items-center gap-1 rounded-control bg-background px-2 py-1 text-xs text-text-muted">
                            <CalendarDays
                              size={13}
                              aria-hidden="true"
                            />
                            Date filters
                          </span>
                        )}

                        {report.supports_export && (
                          <span className="rounded-control bg-background px-2 py-1 text-xs text-text-muted">
                            Export supported
                          </span>
                        )}
                      </div>

                      {report.is_available ? (
                        <Link
                          to={getReportUrl(report.id)}
                          aria-label={`Open ${report.name} report`}
                          className="app-button app-button-secondary mt-4 inline-flex items-center justify-center gap-2"
                        >
                          Open report
                          <ArrowRight
                            size={16}
                            aria-hidden="true"
                          />
                        </Link>
                      ) : (
                        <div
                          aria-label={`${report.name} is unavailable`}
                          className="app-button app-button-secondary mt-4 flex cursor-not-allowed items-center justify-center opacity-60"
                        >
                          Report unavailable
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              </section>
            );
          })
        )}
      </section>

      <footer className="rounded-card border border-border bg-surface p-4">
        <div className="flex items-start gap-3">
          <ShieldCheck
            size={21}
            className="mt-0.5 shrink-0 text-primary"
            aria-hidden="true"
          />

          <div>
            <h3 className="text-sm font-semibold text-text-primary">
              Report accuracy and access
            </h3>

            <p className="mt-1 text-xs leading-5 text-text-muted">
              Report visibility, record-level permissions,
              calculations, GST amounts, stock valuation,
              production costing, and financial balances
              are determined by the backend. The catalog
              displays only report definitions returned
              by the server. Opening or exporting a report
              requires a fresh authorization check and
              current backend data.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}

export default ReportsPage;