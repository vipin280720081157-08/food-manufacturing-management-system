import type { ReactNode } from "react";

import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  CloudOff,
  LoaderCircle,
  MinusCircle,
  XCircle,
} from "lucide-react";

import type {
  OrderApprovalStatus,
  OrderFulfillmentStatus,
  PaymentStatus,
  ProductionStatus,
  TransactionStatus,
} from "../../types/business";

import type {
  OfflineSyncStatus,
} from "../../types/offline";

export type StatusBadgeVariant =
  | "success"
  | "warning"
  | "error"
  | "neutral"
  | "info";

export type StatusBadgeSize =
  | "sm"
  | "md";

export type StatusBadgeCategory =
  | "automatic"
  | "order"
  | "fulfillment"
  | "production"
  | "transaction"
  | "payment"
  | "offline"
  | "government";

export type StatusBadgeValue =
  | OrderApprovalStatus
  | OrderFulfillmentStatus
  | ProductionStatus
  | TransactionStatus
  | PaymentStatus
  | OfflineSyncStatus
  | "not_generated"
  | "generated"
  | "failed"
  | string;

export interface StatusBadgeProps {
  status: StatusBadgeValue;
  category?: StatusBadgeCategory;
  label?: string;
  variant?: StatusBadgeVariant;
  size?: StatusBadgeSize;
  showIcon?: boolean;
  showDot?: boolean;
  pulse?: boolean;
  title?: string;
  className?: string;
  children?: ReactNode;
  testId?: string;
}

interface StatusDefinition {
  label: string;
  variant: StatusBadgeVariant;
  icon:
    | "success"
    | "warning"
    | "error"
    | "pending"
    | "offline"
    | "syncing"
    | "neutral";
}

const STATUS_DEFINITIONS: Record<
  string,
  StatusDefinition
> = {
  draft: {
    label: "Draft",
    variant: "neutral",
    icon: "neutral",
  },

  submitted: {
    label: "Submitted",
    variant: "info",
    icon: "pending",
  },

  approved: {
    label: "Approved",
    variant: "success",
    icon: "success",
  },

  rejected: {
    label: "Rejected",
    variant: "error",
    icon: "error",
  },

  cancelled: {
    label: "Cancelled",
    variant: "neutral",
    icon: "neutral",
  },

  not_dispatched: {
    label: "Not dispatched",
    variant: "warning",
    icon: "pending",
  },

  partially_dispatched: {
    label: "Partially dispatched",
    variant: "warning",
    icon: "warning",
  },

  dispatched: {
    label: "Dispatched",
    variant: "success",
    icon: "success",
  },

  in_progress: {
    label: "In progress",
    variant: "info",
    icon: "pending",
  },

  completed: {
    label: "Completed",
    variant: "success",
    icon: "success",
  },

  posted: {
    label: "Posted",
    variant: "success",
    icon: "success",
  },

  pending: {
    label: "Pending",
    variant: "warning",
    icon: "pending",
  },

  partially_paid: {
    label: "Partially paid",
    variant: "warning",
    icon: "warning",
  },

  paid: {
    label: "Paid",
    variant: "success",
    icon: "success",
  },

  local_draft: {
    label: "Local draft",
    variant: "neutral",
    icon: "offline",
  },

  pending_sync: {
    label: "Pending sync",
    variant: "warning",
    icon: "offline",
  },

  syncing: {
    label: "Syncing",
    variant: "info",
    icon: "syncing",
  },

  synced: {
    label: "Synced",
    variant: "success",
    icon: "success",
  },

  sync_failed: {
    label: "Sync failed",
    variant: "error",
    icon: "error",
  },

  conflict: {
    label: "Needs review",
    variant: "warning",
    icon: "warning",
  },

  not_generated: {
    label: "Not generated",
    variant: "neutral",
    icon: "neutral",
  },

  generated: {
    label: "Generated",
    variant: "success",
    icon: "success",
  },

  failed: {
    label: "Failed",
    variant: "error",
    icon: "error",
  },

  active: {
    label: "Active",
    variant: "success",
    icon: "success",
  },

  inactive: {
    label: "Inactive",
    variant: "neutral",
    icon: "neutral",
  },

  online: {
    label: "Online",
    variant: "success",
    icon: "success",
  },

  offline: {
    label: "Offline",
    variant: "warning",
    icon: "offline",
  },

  connected: {
    label: "Connected",
    variant: "success",
    icon: "success",
  },

  backend_unavailable: {
    label: "Backend unavailable",
    variant: "warning",
    icon: "offline",
  },

  checking: {
    label: "Checking",
    variant: "info",
    icon: "syncing",
  },

  overdue: {
    label: "Overdue",
    variant: "error",
    icon: "error",
  },
};

const VARIANT_CLASSES: Record<
  StatusBadgeVariant,
  string
> = {
  success:
    "border-success/20 bg-success/10 text-success",

  warning:
    "border-warning/20 bg-warning/10 text-warning",

  error:
    "border-error/20 bg-error/10 text-error",

  neutral:
    "border-border bg-background text-secondary",

  info:
    "border-accent/20 bg-accent/10 text-accent",
};

const DOT_CLASSES: Record<
  StatusBadgeVariant,
  string
> = {
  success: "bg-success",
  warning: "bg-warning",
  error: "bg-error",
  neutral: "bg-secondary",
  info: "bg-accent",
};

const SIZE_CLASSES: Record<
  StatusBadgeSize,
  string
> = {
  sm: "gap-1 px-2 py-0.5 text-xs",
  md: "gap-1.5 px-2.5 py-1 text-xs",
};

function joinClasses(
  ...classes: Array<
    string | false | null | undefined
  >
): string {
  return classes.filter(Boolean).join(" ");
}

function normalizeStatus(
  status: string,
): string {
  return status
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function humanizeStatus(
  status: string,
): string {
  const normalized = normalizeStatus(status);

  if (!normalized) {
    return "Unknown";
  }

  return normalized
    .split("_")
    .filter(Boolean)
    .map((part) => {
      return (
        part.charAt(0).toUpperCase() +
        part.slice(1)
      );
    })
    .join(" ");
}

function resolveStatusDefinition(
  status: string,
  category: StatusBadgeCategory,
): StatusDefinition {
  const normalized = normalizeStatus(status);

  if (
    category === "offline" &&
    normalized === "draft"
  ) {
    return STATUS_DEFINITIONS.local_draft!;
  }

  if (
    category === "payment" &&
    normalized === "pending"
  ) {
    return STATUS_DEFINITIONS.pending!;
  }

  const definition =
    STATUS_DEFINITIONS[normalized];

  if (definition) {
    return definition;
  }

  return {
    label: humanizeStatus(status),
    variant: "neutral",
    icon: "neutral",
  };
}

function StatusIcon({
  icon,
  size,
  animated,
}: {
  icon: StatusDefinition["icon"];
  size: number;
  animated: boolean;
}) {
  const props = {
    size,
    strokeWidth: 2,
    "aria-hidden": true as const,
  };

  switch (icon) {
    case "success":
      return <CheckCircle2 {...props} />;

    case "warning":
      return <AlertTriangle {...props} />;

    case "error":
      return <XCircle {...props} />;

    case "pending":
      return <Clock3 {...props} />;

    case "offline":
      return <CloudOff {...props} />;

    case "syncing":
      return (
        <LoaderCircle
          {...props}
          className={
            animated
              ? "motion-safe:animate-spin"
              : ""
          }
        />
      );

    case "neutral":
    default:
      return <MinusCircle {...props} />;
  }
}

/**
 * Presents backend and offline workflow statuses consistently.
 * The badge is informational and does not change business state.
 */
export function StatusBadge({
  status,
  category = "automatic",
  label,
  variant,
  size = "sm",
  showIcon = false,
  showDot = true,
  pulse = false,
  title,
  className,
  children,
  testId,
}: StatusBadgeProps) {
  const definition =
    resolveStatusDefinition(
      status,
      category,
    );

  const effectiveVariant =
    variant ?? definition.variant;

  const displayLabel =
    label?.trim() ||
    definition.label;

  const isSyncing =
    normalizeStatus(status) === "syncing";

  const iconSize =
    size === "sm" ? 12 : 14;

  return (
    <span
      className={joinClasses(
        "inline-flex max-w-full items-center",
        "rounded-full border font-medium",
        "leading-5 whitespace-nowrap",
        VARIANT_CLASSES[effectiveVariant],
        SIZE_CLASSES[size],
        className,
      )}
      title={title}
      data-testid={testId}
      data-status={normalizeStatus(status)}
      data-status-category={category}
    >
      {showIcon ? (
        <span
          className="inline-flex shrink-0 items-center justify-center"
          aria-hidden="true"
        >
          <StatusIcon
            icon={definition.icon}
            size={iconSize}
            animated={isSyncing}
          />
        </span>
      ) : (
        showDot && (
          <span
            className={joinClasses(
              "relative inline-flex h-1.5 w-1.5 shrink-0 rounded-full",
              DOT_CLASSES[effectiveVariant],
              pulse &&
                "motion-safe:animate-pulse",
            )}
            aria-hidden="true"
          />
        )
      )}

      <span className="min-w-0 truncate">
        {children ?? displayLabel}
      </span>
    </span>
  );
}

export interface OfflineStatusBadgeProps
  extends Omit<
    StatusBadgeProps,
    "category" | "status"
  > {
  status: OfflineSyncStatus;
}

export function OfflineStatusBadge({
  status,
  ...props
}: OfflineStatusBadgeProps) {
  return (
    <StatusBadge
      {...props}
      status={status}
      category="offline"
      showIcon={props.showIcon ?? true}
      showDot={props.showDot ?? false}
    />
  );
}

export interface PaymentStatusBadgeProps
  extends Omit<
    StatusBadgeProps,
    "category" | "status"
  > {
  status: PaymentStatus;
}

export function PaymentStatusBadge({
  status,
  ...props
}: PaymentStatusBadgeProps) {
  return (
    <StatusBadge
      {...props}
      status={status}
      category="payment"
    />
  );
}

export interface ProductionStatusBadgeProps
  extends Omit<
    StatusBadgeProps,
    "category" | "status"
  > {
  status: ProductionStatus;
}

export function ProductionStatusBadge({
  status,
  ...props
}: ProductionStatusBadgeProps) {
  return (
    <StatusBadge
      {...props}
      status={status}
      category="production"
    />
  );
}

export interface TransactionStatusBadgeProps
  extends Omit<
    StatusBadgeProps,
    "category" | "status"
  > {
  status: TransactionStatus;
}

export function TransactionStatusBadge({
  status,
  ...props
}: TransactionStatusBadgeProps) {
  return (
    <StatusBadge
      {...props}
      status={status}
      category="transaction"
    />
  );
}

export interface OrderStatusBadgeProps
  extends Omit<
    StatusBadgeProps,
    "category" | "status"
  > {
  status: OrderApprovalStatus;
}

export function OrderStatusBadge({
  status,
  ...props
}: OrderStatusBadgeProps) {
  return (
    <StatusBadge
      {...props}
      status={status}
      category="order"
    />
  );
}

export interface FulfillmentStatusBadgeProps
  extends Omit<
    StatusBadgeProps,
    "category" | "status"
  > {
  status: OrderFulfillmentStatus;
}

export function FulfillmentStatusBadge({
  status,
  ...props
}: FulfillmentStatusBadgeProps) {
  return (
    <StatusBadge
      {...props}
      status={status}
      category="fulfillment"
    />
  );
}

export interface StatusMessageProps {
  status: StatusBadgeValue;
  message: string;
  variant?: StatusBadgeVariant;
  className?: string;
}

export function StatusMessage({
  status,
  message,
  variant,
  className,
}: StatusMessageProps) {
  return (
    <div
      className={joinClasses(
        "flex flex-wrap items-center gap-2",
        className,
      )}
    >
      <StatusBadge
        status={status}
        variant={variant}
      />

      <span className="text-sm text-text-muted">
        {message}
      </span>

      {normalizeStatus(status) ===
        "sync_failed" && (
        <AlertCircle
          size={14}
          className="text-error"
          aria-hidden="true"
        />
      )}
    </div>
  );
}

export default StatusBadge;