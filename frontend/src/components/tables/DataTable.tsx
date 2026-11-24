import {
  useId,
  useMemo,
  useState,
  type Key,
  type ReactNode,
} from "react";

import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Search,
} from "lucide-react";

import type {
  SortDirection,
} from "../../types/business";

import { LoadingState } from "../common/LoadingState";

export type DataTableAlignment =
  | "left"
  | "center"
  | "right";

export type DataTableSortDirection =
  SortDirection;

export interface DataTableSort {
  key: string;
  direction: DataTableSortDirection;
}

export interface DataTableColumn<T> {
  key: string;
  header: ReactNode;
  accessor?: keyof T;
  render?: (
    row: T,
    index: number,
  ) => ReactNode;
  sortable?: boolean;
  align?: DataTableAlignment;
  width?: string;
  minWidth?: string;
  className?: string;
  headerClassName?: string;
  cellClassName?: string;
  numeric?: boolean;
  hideOnMobile?: boolean;
}

export interface DataTablePagination {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (
    pageSize: number,
  ) => void;
  pageSizeOptions?: readonly number[];
}

export interface DataTableProps<T> {
  columns: readonly DataTableColumn<T>[];
  data: readonly T[];
  getRowId: (
    row: T,
    index: number,
  ) => Key;
  caption?: string;
  description?: string;
  loading?: boolean;
  loadingMessage?: string;
  emptyMessage?: string;
  emptyDescription?: string;
  error?: string | null;
  onRetry?: () => void | Promise<void>;
  sort?: DataTableSort | null;
  onSortChange?: (
    sort: DataTableSort,
  ) => void;
  pagination?: DataTablePagination;
  searchable?: boolean;
  searchValue?: string;
  onSearchChange?: (
    value: string,
  ) => void;
  searchPlaceholder?: string;
  searchLabel?: string;
  actions?: ReactNode;
  onRowClick?: (
    row: T,
    index: number,
  ) => void;
  rowClassName?: (
    row: T,
    index: number,
  ) => string;
  selectedRowIds?: readonly Key[];
  onSelectionChange?: (
    selectedIds: Key[],
  ) => void;
  selectable?: boolean;
  className?: string;
  tableClassName?: string;
  containerClassName?: string;
  compact?: boolean;
  stickyHeader?: boolean;
  testId?: string;
}

const DEFAULT_PAGE_SIZE_OPTIONS = [
  10,
  20,
  50,
  100,
] as const;

function joinClasses(
  ...classes: Array<
    string | false | null | undefined
  >
): string {
  return classes.filter(Boolean).join(" ");
}

function getAlignmentClass(
  alignment: DataTableAlignment,
): string {
  switch (alignment) {
    case "center":
      return "text-center";

    case "right":
      return "text-right";

    case "left":
    default:
      return "text-left";
  }
}

function getCellValue<T>(
  row: T,
  column: DataTableColumn<T>,
  index: number,
): ReactNode {
  if (column.render) {
    return column.render(row, index);
  }

  if (column.accessor === undefined) {
    return null;
  }

  const value = row[column.accessor];

  if (value === null || value === undefined) {
    return "—";
  }

  if (
    typeof value === "string" ||
    typeof value === "number"
  ) {
    return value;
  }

  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? "—"
      : value.toLocaleDateString();
  }

  return String(value);
}

function getSearchableValue<T>(
  row: T,
  columns: readonly DataTableColumn<T>[],
): string {
  return columns
    .filter(
      (column) =>
        column.accessor !== undefined,
    )
    .map((column) => {
      if (column.accessor === undefined) {
        return "";
      }

      const value = row[column.accessor];

      if (
        value === null ||
        value === undefined
      ) {
        return "";
      }

      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        return String(value);
      }

      return "";
    })
    .join(" ")
    .toLocaleLowerCase();
}

function compareValues(
  first: unknown,
  second: unknown,
): number {
  if (first === second) {
    return 0;
  }

  if (
    first === null ||
    first === undefined
  ) {
    return 1;
  }

  if (
    second === null ||
    second === undefined
  ) {
    return -1;
  }

  if (
    typeof first === "number" &&
    typeof second === "number"
  ) {
    return first - second;
  }

  if (
    typeof first === "boolean" &&
    typeof second === "boolean"
  ) {
    return Number(first) - Number(second);
  }

  return String(first).localeCompare(
    String(second),
    undefined,
    {
      numeric: true,
      sensitivity: "base",
    },
  );
}

function SortIndicator({
  active,
  direction,
}: {
  active: boolean;
  direction?: DataTableSortDirection;
}) {
  if (!active) {
    return (
      <ArrowUpDown
        size={14}
        aria-hidden="true"
        className="shrink-0 text-text-muted"
      />
    );
  }

  if (direction === "asc") {
    return (
      <ArrowUp
        size={14}
        aria-hidden="true"
        className="shrink-0 text-accent"
      />
    );
  }

  return (
    <ArrowDown
      size={14}
      aria-hidden="true"
      className="shrink-0 text-accent"
    />
  );
}

function getPageCount(
  total: number,
  pageSize: number,
): number {
  return Math.max(
    1,
    Math.ceil(
      Math.max(0, total) /
        Math.max(1, pageSize),
    ),
  );
}

/**
 * Reusable table supporting client-side operations or
 * externally controlled server-side sorting and pagination.
 *
 * When pagination is supplied, data is treated as the current
 * server-provided page and is not sliced locally.
 */
export function DataTable<T>({
  columns,
  data,
  getRowId,
  caption,
  description,
  loading = false,
  loadingMessage = "Loading records...",
  emptyMessage = "No records found",
  emptyDescription,
  error,
  onRetry,
  sort,
  onSortChange,
  pagination,
  searchable = false,
  searchValue,
  onSearchChange,
  searchPlaceholder = "Search records...",
  searchLabel = "Search records",
  actions,
  onRowClick,
  rowClassName,
  selectedRowIds,
  onSelectionChange,
  selectable = false,
  className,
  tableClassName,
  containerClassName,
  compact = false,
  stickyHeader = false,
  testId,
}: DataTableProps<T>) {
  const generatedId = useId();
  const searchInputId =
    `${generatedId}-search`;
  const descriptionId =
    `${generatedId}-description`;

  const [internalSearch, setInternalSearch] =
    useState("");

  const [internalSort, setInternalSort] =
    useState<DataTableSort | null>(null);

  const [internalSelection, setInternalSelection] =
    useState<Key[]>([]);

  const [retrying, setRetrying] =
    useState(false);

  const [retryError, setRetryError] =
    useState<string | null>(null);

  const effectiveSearch =
    searchValue ?? internalSearch;

  const effectiveSort =
    sort === undefined
      ? internalSort
      : sort;

  const effectiveSelection =
    selectedRowIds ?? internalSelection;

  const selectedSet = useMemo(
    () => new Set(effectiveSelection),
    [effectiveSelection],
  );

  const isServerSearch =
    onSearchChange !== undefined;

  const isServerSort =
    onSortChange !== undefined;

  const isServerPagination =
    pagination !== undefined;

  const processedData = useMemo(() => {
    let rows = [...data];

    if (
      searchable &&
      !isServerSearch &&
      effectiveSearch.trim()
    ) {
      const query = effectiveSearch
        .trim()
        .toLocaleLowerCase();

      rows = rows.filter((row) =>
        getSearchableValue(
          row,
          columns,
        ).includes(query),
      );
    }

    if (
      effectiveSort &&
      !isServerSort
    ) {
      const column = columns.find(
        (candidate) =>
          candidate.key ===
          effectiveSort.key,
      );

      if (
        column &&
        column.sortable &&
        column.accessor !== undefined
      ) {
        const accessor = column.accessor;
        const direction =
          effectiveSort.direction;

        rows.sort((first, second) => {
          const result = compareValues(
            first[accessor],
            second[accessor],
          );

          return direction === "asc"
            ? result
            : -result;
        });
      }
    }

    return rows;
  }, [
    data,
    columns,
    searchable,
    isServerSearch,
    effectiveSearch,
    effectiveSort,
    isServerSort,
  ]);

  const visibleData = processedData;

  const visibleRowIds = useMemo(
    () =>
      visibleData.map((row, index) =>
        getRowId(row, index),
      ),
    [visibleData, getRowId],
  );

  const allVisibleSelected =
    visibleRowIds.length > 0 &&
    visibleRowIds.every((id) =>
      selectedSet.has(id),
    );

  const someVisibleSelected =
    visibleRowIds.some((id) =>
      selectedSet.has(id),
    );

  const handleSearchChange = (
    value: string,
  ): void => {
    if (onSearchChange) {
      onSearchChange(value);
    } else {
      setInternalSearch(value);
    }
  };

  const handleSort = (
    column: DataTableColumn<T>,
  ): void => {
    if (!column.sortable) {
      return;
    }

    const nextDirection:
      DataTableSortDirection =
      effectiveSort?.key ===
        column.key &&
      effectiveSort.direction === "asc"
        ? "desc"
        : "asc";

    const nextSort: DataTableSort = {
      key: column.key,
      direction: nextDirection,
    };

    if (onSortChange) {
      onSortChange(nextSort);
    } else {
      setInternalSort(nextSort);
    }
  };

  const updateSelection = (
    nextSelection: Key[],
  ): void => {
    if (onSelectionChange) {
      onSelectionChange(nextSelection);
    } else {
      setInternalSelection(nextSelection);
    }
  };

  const toggleRowSelection = (
    rowId: Key,
  ): void => {
    const nextSelection = new Set(
      effectiveSelection,
    );

    if (nextSelection.has(rowId)) {
      nextSelection.delete(rowId);
    } else {
      nextSelection.add(rowId);
    }

    updateSelection(
      Array.from(nextSelection),
    );
  };

  const toggleVisibleSelection =
    (): void => {
      const nextSelection = new Set(
        effectiveSelection,
      );

      if (allVisibleSelected) {
        visibleRowIds.forEach((id) => {
          nextSelection.delete(id);
        });
      } else {
        visibleRowIds.forEach((id) => {
          nextSelection.add(id);
        });
      }

      updateSelection(
        Array.from(nextSelection),
      );
    };

  const handleRetry = async (): Promise<void> => {
    if (!onRetry || retrying) {
      return;
    }

    setRetrying(true);
    setRetryError(null);

    try {
      await onRetry();
    } catch (failure) {
      setRetryError(
        failure instanceof Error
          ? failure.message
          : "Unable to retry the request.",
      );
    } finally {
      setRetrying(false);
    }
  };

  const totalRecords =
    pagination?.total ??
    visibleData.length;

  const currentPage =
    pagination
      ? Math.max(1, pagination.page)
      : 1;

  const pageSize =
    pagination
      ? Math.max(1, pagination.pageSize)
      : Math.max(1, visibleData.length);

  const pageCount =
    getPageCount(
      totalRecords,
      pageSize,
    );

  const firstRecord =
    totalRecords === 0
      ? 0
      : isServerPagination
        ? (currentPage - 1) *
            pageSize +
          1
        : 1;

  const lastRecord =
    totalRecords === 0
      ? 0
      : isServerPagination
        ? Math.min(
            currentPage * pageSize,
            totalRecords,
          )
        : visibleData.length;

  const colSpan =
    columns.length +
    (selectable ? 1 : 0);

  const pageSizeOptions =
    pagination?.pageSizeOptions ??
    DEFAULT_PAGE_SIZE_OPTIONS;

  return (
    <section
      className={joinClasses(
        "min-w-0",
        className,
      )}
      aria-busy={loading}
      aria-describedby={
        description
          ? descriptionId
          : undefined
      }
      data-testid={testId}
    >
      {(searchable || actions) && (
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          {searchable && (
            <div className="relative w-full sm:max-w-sm">
              <label
                htmlFor={searchInputId}
                className="app-sr-only"
              >
                {searchLabel}
              </label>

              <Search
                size={17}
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
              />

              <input
                id={searchInputId}
                type="search"
                value={effectiveSearch}
                onChange={(event) => {
                  handleSearchChange(
                    event.target.value,
                  );
                }}
                placeholder={
                  searchPlaceholder
                }
                className="app-input w-full pl-10"
              />
            </div>
          )}

          {actions && (
            <div className="flex flex-wrap items-center gap-2">
              {actions}
            </div>
          )}
        </div>
      )}

      {description && (
        <p
          id={descriptionId}
          className="mb-3 text-sm text-text-muted"
        >
          {description}
        </p>
      )}

      {error && !loading && (
        <div
          role="alert"
          className="app-alert app-alert-error mb-4"
        >
          <p className="text-sm">
            {error}
          </p>

          {onRetry && (
            <button
              type="button"
              className="app-button app-button-secondary mt-3"
              disabled={retrying}
              onClick={() => {
                void handleRetry();
              }}
            >
              {retrying
                ? "Retrying..."
                : "Try again"}
            </button>
          )}

          {retryError && (
            <p className="mt-2 text-sm text-error">
              {retryError}
            </p>
          )}
        </div>
      )}

      <div
        className={joinClasses(
          "app-table-container w-full overflow-x-auto",
          "rounded-card border border-border bg-surface",
          containerClassName,
        )}
      >
        <table
          className={joinClasses(
            "app-table w-full min-w-max border-collapse",
            "text-sm text-text-primary",
            tableClassName,
          )}
        >
          {caption && (
            <caption className="px-4 py-3 text-left text-sm font-semibold text-text-primary">
              {caption}
            </caption>
          )}

          <thead
            className={joinClasses(
              "bg-background text-secondary",
              stickyHeader &&
                "sticky top-0 z-10",
            )}
          >
            <tr>
              {selectable && (
                <th
                  scope="col"
                  className="w-12 border-b border-border px-3 py-3 text-center"
                >
                  <input
                    type="checkbox"
                    aria-label="Select all visible rows"
                    checked={
                      allVisibleSelected
                    }
                    ref={(element) => {
                      if (element) {
                        element.indeterminate =
                          someVisibleSelected &&
                          !allVisibleSelected;
                      }
                    }}
                    disabled={
                      loading ||
                      visibleData.length === 0
                    }
                    onChange={
                      toggleVisibleSelection
                    }
                    className="h-4 w-4 rounded border-border accent-primary"
                  />
                </th>
              )}

              {columns.map((column) => {
                const alignment =
                  column.align ??
                  (column.numeric
                    ? "right"
                    : "left");

                const activeSort =
                  effectiveSort?.key ===
                  column.key;

                const ariaSort =
                  column.sortable
                    ? activeSort
                      ? effectiveSort?.direction ===
                        "asc"
                        ? "ascending"
                        : "descending"
                      : "none"
                    : undefined;

                return (
                  <th
                    key={column.key}
                    scope="col"
                    aria-sort={ariaSort}
                    style={{
                      width: column.width,
                      minWidth:
                        column.minWidth,
                    }}
                    className={joinClasses(
                      "border-b border-border",
                      "font-semibold",
                      compact
                        ? "px-3 py-2"
                        : "px-4 py-3",
                      getAlignmentClass(
                        alignment,
                      ),
                      column.hideOnMobile &&
                        "hidden sm:table-cell",
                      column.headerClassName,
                      column.className,
                    )}
                  >
                    {column.sortable ? (
                      <button
                        type="button"
                        onClick={() => {
                          handleSort(column);
                        }}
                        disabled={loading}
                        className={joinClasses(
                          "inline-flex max-w-full items-center gap-1.5",
                          "rounded-control text-inherit",
                          "hover:text-accent",
                          "focus-visible:outline-2",
                          "focus-visible:outline-offset-2",
                          "focus-visible:outline-accent",
                          "disabled:cursor-not-allowed",
                          alignment ===
                            "right" &&
                            "ml-auto",
                          alignment ===
                            "center" &&
                            "mx-auto",
                        )}
                      >
                        <span>
                          {column.header}
                        </span>

                        <SortIndicator
                          active={activeSort}
                          direction={
                            effectiveSort?.direction
                          }
                        />
                      </button>
                    ) : (
                      column.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>

          <tbody>
            {loading ? (
              <tr>
                <td
                  colSpan={colSpan}
                  className="p-0"
                >
                  <LoadingState
                    variant="page"
                    size="md"
                    message={loadingMessage}
                    minHeight={180}
                  />
                </td>
              </tr>
            ) : error ? (
              <tr>
                <td
                  colSpan={colSpan}
                  className="px-4 py-10 text-center text-sm text-text-muted"
                >
                  Records could not be loaded.
                </td>
              </tr>
            ) : visibleData.length === 0 ? (
              <tr>
                <td
                  colSpan={colSpan}
                  className="px-6 py-12 text-center"
                >
                  <p className="font-medium text-text-primary">
                    {emptyMessage}
                  </p>

                  {emptyDescription && (
                    <p className="mt-1 text-sm text-text-muted">
                      {emptyDescription}
                    </p>
                  )}
                </td>
              </tr>
            ) : (
              visibleData.map(
                (row, rowIndex) => {
                  const rowId =
                    getRowId(
                      row,
                      rowIndex,
                    );

                  const selected =
                    selectedSet.has(rowId);

                  return (
                    <tr
                      key={rowId}
                      aria-selected={
                        selectable
                          ? selected
                          : undefined
                      }
                      className={joinClasses(
                        "border-b border-border/70 last:border-b-0",
                        "transition-colors hover:bg-background/60",
                        selected &&
                          "bg-accent/5",
                        onRowClick &&
                          "cursor-pointer",
                        rowClassName?.(
                          row,
                          rowIndex,
                        ),
                      )}
                      onClick={
                        onRowClick
                          ? () => {
                              onRowClick(
                                row,
                                rowIndex,
                              );
                            }
                          : undefined
                      }
                    >
                      {selectable && (
                        <td
                          className="px-3 py-3 text-center"
                          onClick={(
                            event,
                          ) => {
                            event.stopPropagation();
                          }}
                        >
                          <input
                            type="checkbox"
                            aria-label={`Select row ${rowIndex + 1}`}
                            checked={selected}
                            onChange={() => {
                              toggleRowSelection(
                                rowId,
                              );
                            }}
                            className="h-4 w-4 rounded border-border accent-primary"
                          />
                        </td>
                      )}

                      {columns.map(
                        (column) => {
                          const alignment =
                            column.align ??
                            (column.numeric
                              ? "right"
                              : "left");

                          return (
                            <td
                              key={column.key}
                              style={{
                                width:
                                  column.width,
                                minWidth:
                                  column.minWidth,
                              }}
                              className={joinClasses(
                                compact
                                  ? "px-3 py-2"
                                  : "px-4 py-3",
                                "align-middle",
                                getAlignmentClass(
                                  alignment,
                                ),
                                column.numeric &&
                                  "app-numeric tabular-nums",
                                column.hideOnMobile &&
                                  "hidden sm:table-cell",
                                column.cellClassName,
                                column.className,
                              )}
                            >
                              {getCellValue(
                                row,
                                column,
                                rowIndex,
                              )}
                            </td>
                          );
                        },
                      )}
                    </tr>
                  );
                },
              )
            )}
          </tbody>
        </table>
      </div>

      {pagination && (
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-text-muted">
            Showing{" "}
            <span className="font-medium text-text-primary">
              {firstRecord}
            </span>
            {"–"}
            <span className="font-medium text-text-primary">
              {lastRecord}
            </span>
            {" of "}
            <span className="font-medium text-text-primary">
              {totalRecords}
            </span>
            {" records"}
          </p>

          <div className="flex flex-wrap items-center gap-3">
            {pagination.onPageSizeChange && (
              <label className="flex items-center gap-2 text-sm text-text-muted">
                <span>
                  Rows per page
                </span>

                <select
                  value={pagination.pageSize}
                  onChange={(event) => {
                    pagination.onPageSizeChange?.(
                      Number(
                        event.target.value,
                      ),
                    );
                  }}
                  disabled={loading}
                  className="app-select min-h-9"
                  aria-label="Rows per page"
                >
                  {Array.from(
                    new Set([
                      ...pageSizeOptions,
                      pagination.pageSize,
                    ]),
                  )
                    .sort(
                      (first, second) =>
                        first - second,
                    )
                    .map((size) => (
                      <option
                        key={size}
                        value={size}
                      >
                        {size}
                      </option>
                    ))}
                </select>
              </label>
            )}

            <div className="flex items-center gap-2">
              <span className="text-sm text-text-muted">
                Page {currentPage} of{" "}
                {pageCount}
              </span>

              <button
                type="button"
                aria-label="Previous page"
                title="Previous page"
                disabled={
                  loading ||
                  currentPage <= 1
                }
                onClick={() => {
                  pagination.onPageChange(
                    currentPage - 1,
                  );
                }}
                className="app-button app-button-secondary inline-flex h-9 w-9 items-center justify-center p-0"
              >
                <ChevronLeft
                  size={18}
                  aria-hidden="true"
                />
              </button>

              <button
                type="button"
                aria-label="Next page"
                title="Next page"
                disabled={
                  loading ||
                  currentPage >= pageCount
                }
                onClick={() => {
                  pagination.onPageChange(
                    currentPage + 1,
                  );
                }}
                className="app-button app-button-secondary inline-flex h-9 w-9 items-center justify-center p-0"
              >
                <ChevronRight
                  size={18}
                  aria-hidden="true"
                />
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

export default DataTable;