import {
  useId,
  useMemo,
  type ReactNode,
} from "react";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipProps,
} from "recharts";

import {
  AlertCircle,
  BarChart3,
} from "lucide-react";

import { LoadingState } from "../common/LoadingState";

export type DashboardChartType =
  | "bar"
  | "line"
  | "pie";

export type DashboardChartValueType =
  | "number"
  | "currency"
  | "percentage"
  | "quantity";

export interface DashboardChartDataPoint {
  [key: string]: string | number | null | undefined;
}

export interface DashboardChartSeries {
  key: string;
  name: string;
  color?: string;
  valueType?: DashboardChartValueType;
  unit?: string;
  stackId?: string;
}

export interface DashboardChartProps {
  title: string;
  description?: string;
  type: DashboardChartType;
  data: readonly DashboardChartDataPoint[];
  series: readonly DashboardChartSeries[];
  xAxisKey?: string;
  height?: number;
  loading?: boolean;
  loadingMessage?: string;
  error?: string | null;
  emptyMessage?: string;
  showLegend?: boolean;
  showGrid?: boolean;
  showTooltip?: boolean;
  showYAxis?: boolean;
  showXAxis?: boolean;
  showDataLabels?: boolean;
  currency?: string;
  locale?: string;
  className?: string;
  chartClassName?: string;
  actions?: ReactNode;
  testId?: string;
}

export interface DashboardMetricCardProps {
  label: string;
  value: string | number | null | undefined;
  description?: string;
  unit?: string;
  icon?: ReactNode;
  loading?: boolean;
  error?: string | null;
  className?: string;
  testId?: string;
}

const CHART_COLORS = [
  "#3F4E5C",
  "#2D6A96",
  "#5E6C7A",
  "#25704A",
  "#8A5300",
  "#66717C",
  "#B0362B",
] as const;

const CHART_GRID_COLOR = "#D5DCE2";
const CHART_TEXT_COLOR = "#66717C";
const CHART_TOOLTIP_BORDER = "#D5DCE2";

const DEFAULT_CHART_HEIGHT = 300;

function joinClasses(
  ...classes: Array<
    string | false | null | undefined
  >
): string {
  return classes.filter(Boolean).join(" ");
}

function getSeriesColor(
  series: DashboardChartSeries,
  index: number,
): string {
  return (
    series.color ??
    CHART_COLORS[index % CHART_COLORS.length] ??
    CHART_COLORS[0]
  );
}

function formatChartValue(
  value: number,
  valueType: DashboardChartValueType = "number",
  locale = "en-IN",
  currency = "INR",
  unit?: string,
): string {
  if (!Number.isFinite(value)) {
    return "—";
  }

  switch (valueType) {
    case "currency":
      return new Intl.NumberFormat(locale, {
        style: "currency",
        currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(value);

    case "percentage":
      return `${new Intl.NumberFormat(locale, {
        maximumFractionDigits: 2,
      }).format(value)}%`;

    case "quantity": {
      const formatted = new Intl.NumberFormat(locale, {
        maximumFractionDigits: 3,
      }).format(value);

      return unit
        ? `${formatted} ${unit}`
        : formatted;
    }

    case "number":
    default:
      return new Intl.NumberFormat(locale, {
        maximumFractionDigits: 2,
      }).format(value);
  }
}

function toFiniteNumber(
  value: unknown,
): number | null {
  if (
    typeof value === "number" &&
    Number.isFinite(value)
  ) {
    return value;
  }

  if (
    typeof value === "string" &&
    value.trim() !== ""
  ) {
    const parsed = Number(value);

    return Number.isFinite(parsed)
      ? parsed
      : null;
  }

  return null;
}

function hasChartData(
  data: readonly DashboardChartDataPoint[],
  series: readonly DashboardChartSeries[],
): boolean {
  if (data.length === 0 || series.length === 0) {
    return false;
  }

  return data.some((point) =>
    series.some(
      (item) =>
        toFiniteNumber(point[item.key]) !== null,
    ),
  );
}

interface ChartTooltipContentProps {
  active?: boolean;
  label?: string | number;
  payload?: TooltipProps<
    number,
    string
  >["payload"];
  series: readonly DashboardChartSeries[];
  locale: string;
  currency: string;
}

function ChartTooltipContent({
  active,
  label,
  payload,
  series,
  locale,
  currency,
}: ChartTooltipContentProps) {
  if (
    !active ||
    !payload ||
    payload.length === 0
  ) {
    return null;
  }

  return (
    <div
      className="max-w-xs rounded-control border border-border bg-surface px-3 py-2 shadow-card"
      style={{
        borderColor: CHART_TOOLTIP_BORDER,
      }}
    >
      {label !== undefined &&
        label !== null &&
        String(label).trim() !== "" && (
          <p className="mb-2 text-xs font-semibold text-text-primary">
            {String(label)}
          </p>
        )}

      <div className="space-y-1.5">
        {payload.map((entry, index) => {
          const key = String(
            entry.dataKey ?? "",
          );

          const matchingSeries = series.find(
            (item) => item.key === key,
          );

          const value = toFiniteNumber(
            entry.value,
          );

          if (value === null) {
            return null;
          }

          return (
            <div
              key={`${key}-${index}`}
              className="flex items-center justify-between gap-4 text-xs"
            >
              <span className="flex min-w-0 items-center gap-2 text-text-muted">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{
                    backgroundColor:
                      entry.color ??
                      matchingSeries?.color ??
                      CHART_COLORS[0],
                  }}
                  aria-hidden="true"
                />

                <span className="truncate">
                  {matchingSeries?.name ??
                    entry.name ??
                    key}
                </span>
              </span>

              <span className="shrink-0 font-semibold tabular-nums text-text-primary">
                {formatChartValue(
                  value,
                  matchingSeries?.valueType,
                  locale,
                  currency,
                  matchingSeries?.unit,
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ChartEmptyState({
  message,
}: {
  message: string;
}) {
  return (
    <div className="flex min-h-48 flex-col items-center justify-center gap-3 px-4 text-center">
      <BarChart3
        size={30}
        strokeWidth={1.5}
        className="text-text-muted"
        aria-hidden="true"
      />

      <p className="text-sm text-text-muted">
        {message}
      </p>
    </div>
  );
}

function ChartErrorState({
  message,
}: {
  message: string;
}) {
  return (
    <div
      role="alert"
      className="flex min-h-48 flex-col items-center justify-center gap-3 px-4 text-center"
    >
      <AlertCircle
        size={28}
        strokeWidth={1.8}
        className="text-error"
        aria-hidden="true"
      />

      <p className="max-w-md text-sm text-error">
        {message}
      </p>
    </div>
  );
}

/**
 * Displays server-provided dashboard and report data.
 * Chart rendering does not calculate authoritative business totals.
 */
export function DashboardChart({
  title,
  description,
  type,
  data,
  series,
  xAxisKey = "label",
  height = DEFAULT_CHART_HEIGHT,
  loading = false,
  loadingMessage = "Loading chart...",
  error,
  emptyMessage = "No chart data is available for the selected period.",
  showLegend = true,
  showGrid = true,
  showTooltip = true,
  showYAxis = true,
  showXAxis = true,
  showDataLabels = false,
  currency = "INR",
  locale = "en-IN",
  className,
  chartClassName,
  actions,
  testId,
}: DashboardChartProps) {
  const generatedId = useId();

  const titleId = `${generatedId}-title`;
  const descriptionId =
    `${generatedId}-description`;

  const chartHeight = Math.max(
    180,
    Number.isFinite(height)
      ? height
      : DEFAULT_CHART_HEIGHT,
  );

  const normalizedData = useMemo(
    () =>
      data.map((point) => {
        const normalized: DashboardChartDataPoint = {
          ...point,
        };

        for (const item of series) {
          normalized[item.key] =
            toFiniteNumber(point[item.key]);
        }

        return normalized;
      }),
    [data, series],
  );

  const hasData = useMemo(
    () => hasChartData(normalizedData, series),
    [normalizedData, series],
  );

  const pieSeries = series[0];

  const pieData = useMemo(() => {
    if (!pieSeries) {
      return [];
    }

    return normalizedData
      .map((point) => ({
        name: String(
          point[xAxisKey] ?? "Unlabelled",
        ),
        value: toFiniteNumber(
          point[pieSeries.key],
        ),
      }))
      .filter(
        (
          point,
        ): point is {
          name: string;
          value: number;
        } =>
          point.value !== null &&
          point.value > 0,
      );
  }, [
    normalizedData,
    pieSeries,
    xAxisKey,
  ]);

  const hasRenderableData =
    type === "pie"
      ? pieData.length > 0
      : hasData;

  const tooltipContent = (
    <ChartTooltipContent
      series={series}
      locale={locale}
      currency={currency}
    />
  );

  const commonAxisProps = {
    tick: {
      fill: CHART_TEXT_COLOR,
      fontSize: 12,
    },
    axisLine: false,
    tickLine: false,
  };

  const renderChart = (): ReactNode => {
    if (type === "pie") {
      if (!pieSeries) {
        return null;
      }

      return (
        <PieChart
          margin={{
            top: 8,
            right: 12,
            bottom: 8,
            left: 12,
          }}
        >
          {showTooltip && (
            <Tooltip
              content={tooltipContent}
            />
          )}

          {showLegend && (
            <Legend
              verticalAlign="bottom"
              iconType="circle"
              wrapperStyle={{
                fontSize: 12,
                color: CHART_TEXT_COLOR,
              }}
            />
          )}

          <Pie
            data={pieData}
            dataKey="value"
            nameKey="name"
            cx="50%"
            cy="45%"
            innerRadius="45%"
            outerRadius="70%"
            paddingAngle={2}
            stroke="#FFFFFF"
            strokeWidth={2}
            isAnimationActive={false}
            label={
              showDataLabels
                ? ({
                    name,
                    percent,
                  }: {
                    name?: string;
                    percent?: number;
                  }) =>
                    `${name ?? ""} ${formatChartValue(
                      (percent ?? 0) * 100,
                      "percentage",
                      locale,
                    )}`
                : false
            }
          >
            {pieData.map((point, index) => (
              <Cell
                key={`${point.name}-${index}`}
                fill={
                  CHART_COLORS[
                    index % CHART_COLORS.length
                  ] ?? CHART_COLORS[0]
                }
              />
            ))}
          </Pie>
        </PieChart>
      );
    }

    if (type === "line") {
      return (
        <LineChart
          data={normalizedData}
          margin={{
            top: 12,
            right: 16,
            bottom: 8,
            left: 4,
          }}
        >
          {showGrid && (
            <CartesianGrid
              stroke={CHART_GRID_COLOR}
              strokeDasharray="3 3"
              vertical={false}
            />
          )}

          {showXAxis && (
            <XAxis
              {...commonAxisProps}
              dataKey={xAxisKey}
              minTickGap={20}
            />
          )}

          {showYAxis && (
            <YAxis
              {...commonAxisProps}
              width={64}
              tickFormatter={(value: number) =>
                formatChartValue(
                  value,
                  "number",
                  locale,
                )
              }
            />
          )}

          {showTooltip && (
            <Tooltip
              content={tooltipContent}
            />
          )}

          {showLegend && (
            <Legend
              verticalAlign="bottom"
              iconType="line"
              wrapperStyle={{
                fontSize: 12,
                color: CHART_TEXT_COLOR,
              }}
            />
          )}

          {series.map((item, index) => (
            <Line
              key={item.key}
              type="monotone"
              dataKey={item.key}
              name={item.name}
              stroke={getSeriesColor(
                item,
                index,
              )}
              strokeWidth={2.5}
              dot={false}
              activeDot={{
                r: 5,
              }}
              connectNulls={false}
              isAnimationActive={false}
              label={
                showDataLabels
                  ? {
                      position: "top",
                      fill: CHART_TEXT_COLOR,
                      fontSize: 11,
                    }
                  : false
              }
            />
          ))}
        </LineChart>
      );
    }

    return (
      <BarChart
        data={normalizedData}
        margin={{
          top: 12,
          right: 16,
          bottom: 8,
          left: 4,
        }}
      >
        {showGrid && (
          <CartesianGrid
            stroke={CHART_GRID_COLOR}
            strokeDasharray="3 3"
            vertical={false}
          />
        )}

        {showXAxis && (
          <XAxis
            {...commonAxisProps}
            dataKey={xAxisKey}
            minTickGap={20}
          />
        )}

        {showYAxis && (
          <YAxis
            {...commonAxisProps}
            width={64}
            tickFormatter={(value: number) =>
              formatChartValue(
                value,
                "number",
                locale,
              )
            }
          />
        )}

        {showTooltip && (
          <Tooltip
            content={tooltipContent}
          />
        )}

        {showLegend && (
          <Legend
            verticalAlign="bottom"
            iconType="rect"
            wrapperStyle={{
              fontSize: 12,
              color: CHART_TEXT_COLOR,
            }}
          />
        )}

        {series.map((item, index) => (
          <Bar
            key={item.key}
            dataKey={item.key}
            name={item.name}
            fill={getSeriesColor(
              item,
              index,
            )}
            stackId={item.stackId}
            maxBarSize={56}
            radius={
              item.stackId
                ? 0
                : [4, 4, 0, 0]
            }
            isAnimationActive={false}
            label={
              showDataLabels
                ? {
                    position: "top",
                    fill: CHART_TEXT_COLOR,
                    fontSize: 11,
                  }
                : false
            }
          />
        ))}
      </BarChart>
    );
  };

  return (
    <section
      className={joinClasses(
        "app-card min-w-0 rounded-card border border-border bg-surface p-4 shadow-card sm:p-5",
        className,
      )}
      aria-labelledby={titleId}
      aria-describedby={
        description
          ? descriptionId
          : undefined
      }
      aria-busy={loading}
      data-testid={testId}
    >
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2
            id={titleId}
            className="text-base font-semibold text-text-primary"
          >
            {title}
          </h2>

          {description && (
            <p
              id={descriptionId}
              className="mt-1 text-sm leading-5 text-text-muted"
            >
              {description}
            </p>
          )}
        </div>

        {actions && (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {actions}
          </div>
        )}
      </div>

      {loading ? (
        <LoadingState
          variant="page"
          size="md"
          message={loadingMessage}
          minHeight={chartHeight}
        />
      ) : error ? (
        <ChartErrorState message={error} />
      ) : !hasRenderableData ? (
        <ChartEmptyState
          message={emptyMessage}
        />
      ) : (
        <div
          className={joinClasses(
            "w-full min-w-0",
            chartClassName,
          )}
          role="img"
          aria-label={`${title}. ${type} chart containing ${normalizedData.length} data points.`}
        >
          <ResponsiveContainer
            width="100%"
            height={chartHeight}
            minWidth={0}
          >
            {renderChart() as React.ReactElement}
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}

/**
 * Displays a metric returned by the backend or a report service.
 * Missing values are not replaced with fabricated totals.
 */
export function DashboardMetricCard({
  label,
  value,
  description,
  unit,
  icon,
  loading = false,
  error,
  className,
  testId,
}: DashboardMetricCardProps) {
  const displayValue =
    value === null ||
    value === undefined ||
    value === ""
      ? "—"
      : String(value);

  return (
    <section
      className={joinClasses(
        "app-card min-w-0 rounded-card border border-border bg-surface p-4 shadow-card sm:p-5",
        className,
      )}
      aria-busy={loading}
      data-testid={testId}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-text-muted">
            {label}
          </p>

          {loading ? (
            <div className="mt-3">
              <LoadingState
                variant="inline"
                size="sm"
                message="Loading..."
              />
            </div>
          ) : error ? (
            <p
              role="alert"
              className="mt-3 flex items-start gap-2 text-sm text-error"
            >
              <AlertCircle
                size={16}
                className="mt-0.5 shrink-0"
                aria-hidden="true"
              />

              <span>{error}</span>
            </p>
          ) : (
            <div className="mt-2 flex flex-wrap items-baseline gap-2">
              <p className="break-words text-2xl font-semibold tracking-tight tabular-nums text-text-primary sm:text-3xl">
                {displayValue}
              </p>

              {unit && (
                <span className="text-sm text-text-muted">
                  {unit}
                </span>
              )}
            </div>
          )}

          {description && (
            <p className="mt-2 text-xs leading-5 text-text-muted">
              {description}
            </p>
          )}
        </div>

        {icon && (
          <span
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-control bg-background text-primary"
            aria-hidden="true"
          >
            {icon}
          </span>
        )}
      </div>
    </section>
  );
}

export default DashboardChart;