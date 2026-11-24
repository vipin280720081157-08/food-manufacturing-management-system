import {
  useState,
  type ReactNode,
} from "react";

import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock3,
  CloudOff,
  CloudUpload,
  Database,
  RefreshCw,
  ShieldAlert,
  Wifi,
  WifiOff,
} from "lucide-react";

import { Link } from "react-router-dom";

import type {
  OfflineSyncStatus,
} from "../../types/offline";

import { USER_ROLES } from "../../types/auth";
import { useAuth } from "../../hooks/useAuth";
import { useOnlineStatus } from "../../hooks/useOnlineStatus";

import { formatDateTime } from "../../utils/formatters";

export interface SyncStatusCounts {
  localDraft: number;
  pendingSync: number;
  syncing: number;
  synced: number;
  syncFailed: number;
  conflict: number;
}

export interface SyncStatusOrder {
  localId: string;
  customerName: string;
  status: OfflineSyncStatus;
  updatedAt: string;
  errorMessage?: string | null;
}

export interface SyncStatusProps {
  counts: SyncStatusCounts;
  orders?: readonly SyncStatusOrder[];
  isSyncing?: boolean;
  isLoading?: boolean;
  isBackendReachable?: boolean | null;
  lastSyncedAt?: string | null;
  lastAttemptedAt?: string | null;
  error?: string | null;
  onSync?: () => void | Promise<void>;
  onRetryOrder?: (localId: string) => void | Promise<void>;
  onRefresh?: () => void | Promise<void>;
  compact?: boolean;
  className?: string;
}

type StatusTone = "success" | "warning" | "error" | "neutral";

interface StatusDescription {
  label: string;
  description: string;
  tone: StatusTone;
  icon: typeof Clock3;
}

const STATUS_DESCRIPTIONS: Record<
  OfflineSyncStatus,
  StatusDescription
> = {
  local_draft: {
    label: "Local draft",
    description: "Saved locally and not queued for synchronization.",
    tone: "neutral",
    icon: Database,
  },
  pending_sync: {
    label: "Pending sync",
    description: "Queued locally and awaiting backend confirmation.",
    tone: "warning",
    icon: Clock3,
  },
  syncing: {
    label: "Syncing",
    description: "A synchronization attempt is in progress.",
    tone: "warning",
    icon: RefreshCw,
  },
  synced: {
    label: "Synced",
    description: "The backend has confirmed the order.",
    tone: "success",
    icon: CheckCircle2,
  },
  sync_failed: {
    label: "Sync failed",
    description: "Synchronization failed; the local record is retained.",
    tone: "error",
    icon: AlertCircle,
  },
  conflict: {
    label: "Conflict",
    description: "Backend validation requires review or correction.",
    tone: "error",
    icon: ShieldAlert,
  },
};

const TONE_CLASSES: Record<StatusTone, string> = {
  success: "border-success/20 bg-success/10 text-success",
  warning: "border-warning/20 bg-warning/10 text-warning",
  error: "border-error/20 bg-error/10 text-error",
  neutral: "border-border bg-background text-text-muted",
};

function normalizeCount(value: number): number {
  return Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function formatTimestamp(
  value: string | null | undefined,
): string {
  if (!value) {
    return "Not available";
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return "Not available";
  }

  return formatDateTime(value);
}

function StatusPill({
  status,
}: {
  status: OfflineSyncStatus;
}) {
  const description = STATUS_DESCRIPTIONS[status];
  const Icon = description.icon;

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${TONE_CLASSES[description.tone]}`}
    >
      <Icon
        size={13}
        aria-hidden="true"
        className={
          status === "syncing"
            ? "motion-safe:animate-spin"
            : ""
        }
      />

      {description.label}
    </span>
  );
}

interface SummaryCardProps {
  label: string;
  count: number;
  icon: typeof Clock3;
  tone?: StatusTone;
}

function SummaryCard({
  label,
  count,
  icon: Icon,
  tone = "neutral",
}: SummaryCardProps) {
  return (
    <div className="rounded-card border border-border bg-surface p-4 shadow-card">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium text-text-muted">
          {label}
        </p>

        <Icon
          size={18}
          className={
            tone === "success"
              ? "text-success"
              : tone === "warning"
                ? "text-warning"
                : tone === "error"
                  ? "text-error"
                  : "text-primary"
          }
          aria-hidden="true"
        />
      </div>

      <p className="mt-3 text-2xl font-semibold text-text-primary app-numeric">
        {normalizeCount(count)}
      </p>
    </div>
  );
}

function InformationRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 border-b border-border py-3 last:border-b-0">
      <dt className="text-sm text-text-muted">
        {label}
      </dt>

      <dd className="text-sm font-medium text-text-primary">
        {children}
      </dd>
    </div>
  );
}

export function SyncStatus({
  counts,
  orders = [],
  isSyncing = false,
  isLoading = false,
  isBackendReachable = null,
  lastSyncedAt = null,
  lastAttemptedAt = null,
  error = null,
  onSync,
  onRetryOrder,
  onRefresh,
  compact = false,
  className = "",
}: SyncStatusProps) {
  const { user } = useAuth();
  const { isOnline } = useOnlineStatus();

  const [showDetails, setShowDetails] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [activeRetryId, setActiveRetryId] =
    useState<string | null>(null);
  const [actionError, setActionError] =
    useState<string | null>(null);

  const canAccess =
    user?.role === USER_ROLES.SALESMAN;

  const localDraft = normalizeCount(counts.localDraft);
  const pendingSync = normalizeCount(counts.pendingSync);
  const syncing = normalizeCount(counts.syncing);
  const synced = normalizeCount(counts.synced);
  const syncFailed = normalizeCount(counts.syncFailed);
  const conflict = normalizeCount(counts.conflict);

  const unsynchronizedCount =
    localDraft +
    pendingSync +
    syncing +
    syncFailed +
    conflict;

  const needsAttentionCount = syncFailed + conflict;

  const backendAvailable =
    isOnline && isBackendReachable === true;

  const synchronizationActive =
    isSyncing || syncing > 0;

  const canStartSync =
    canAccess &&
    backendAvailable &&
    !synchronizationActive &&
    !actionBusy &&
    !isLoading &&
    pendingSync + syncFailed > 0 &&
    onSync !== undefined;

  const canRetry =
    canAccess &&
    backendAvailable &&
    !synchronizationActive &&
    !actionBusy &&
    !isLoading &&
    onRetryOrder !== undefined;

  const connectivityLabel = !isOnline
    ? "Device offline"
    : isBackendReachable === true
      ? "Backend connected"
      : isBackendReachable === false
        ? "Backend unavailable"
        : "Backend connection unverified";

  const connectivityDescription = !isOnline
    ? "Local drafts and pending orders remain stored on this device."
    : isBackendReachable === true
      ? "The backend connection has been confirmed."
      : isBackendReachable === false
        ? "The device is online, but the backend is not reachable."
        : "Device connectivity does not confirm backend availability.";

  const runAction = async (
    action: () => void | Promise<void>,
    retryId?: string,
  ): Promise<void> => {
    if (actionBusy) {
      return;
    }

    setActionBusy(true);
    setActiveRetryId(retryId ?? null);
    setActionError(null);

    try {
      await action();
    } catch (failure) {
      setActionError(
        failure instanceof Error
          ? failure.message
          : "The requested synchronization action failed.",
      );
    } finally {
      setActionBusy(false);
      setActiveRetryId(null);
    }
  };

  if (!canAccess) {
    return (
      <div
        className={`rounded-card border border-border bg-surface p-5 ${className}`}
      >
        <div
          role="alert"
          className="app-alert app-alert-error"
        >
          Offline order synchronization is available only
          to the Salesman role.
        </div>
      </div>
    );
  }

  return (
    <section
      aria-labelledby="sync-status-title"
      className={`space-y-5 ${className}`}
    >
      <div className="rounded-card border border-border bg-surface p-5 shadow-card">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="rounded-control bg-background p-2.5">
              {synchronizationActive ? (
                <RefreshCw
                  size={22}
                  className="motion-safe:animate-spin text-accent"
                  aria-hidden="true"
                />
              ) : backendAvailable ? (
                <CloudUpload
                  size={22}
                  className="text-primary"
                  aria-hidden="true"
                />
              ) : (
                <CloudOff
                  size={22}
                  className="text-warning"
                  aria-hidden="true"
                />
              )}
            </div>

            <div>
              <h2
                id="sync-status-title"
                className="text-lg font-semibold text-text-primary"
              >
                Offline synchronization
              </h2>

              <p className="mt-1 text-sm text-text-muted">
                {synchronizationActive
                  ? "Synchronization is in progress."
                  : unsynchronizedCount === 0
                    ? "No unsynchronized local orders are currently reported."
                    : `${unsynchronizedCount} local order${
                        unsynchronizedCount === 1 ? "" : "s"
                      } not yet confirmed by the backend.`}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {onRefresh && (
              <button
                type="button"
                onClick={() => {
                  void runAction(onRefresh);
                }}
                disabled={actionBusy || isLoading}
                className="app-button app-button-secondary inline-flex items-center gap-2"
              >
                <RefreshCw
                  size={16}
                  className={
                    isLoading
                      ? "motion-safe:animate-spin"
                      : ""
                  }
                  aria-hidden="true"
                />

                Refresh status
              </button>
            )}

            {onSync && (
              <button
                type="button"
                onClick={() => {
                  if (canStartSync) {
                    void runAction(onSync);
                  }
                }}
                disabled={!canStartSync}
                className="app-button app-button-primary inline-flex items-center gap-2"
              >
                <CloudUpload
                  size={17}
                  aria-hidden="true"
                />

                {synchronizationActive
                  ? "Syncing..."
                  : "Sync pending orders"}
              </button>
            )}
          </div>
        </div>

        <div
          role="status"
          aria-live="polite"
          className={`mt-5 flex items-start gap-3 rounded-control border p-4 ${
            backendAvailable
              ? TONE_CLASSES.success
              : TONE_CLASSES.warning
          }`}
        >
          {backendAvailable ? (
            <Wifi
              size={19}
              className="shrink-0"
              aria-hidden="true"
            />
          ) : (
            <WifiOff
              size={19}
              className="shrink-0"
              aria-hidden="true"
            />
          )}

          <div>
            <p className="text-sm font-semibold">
              {connectivityLabel}
            </p>

            <p className="mt-1 text-xs leading-5">
              {connectivityDescription}
            </p>
          </div>
        </div>

        {(error || actionError) && (
          <div
            role="alert"
            className="app-alert app-alert-error mt-4"
          >
            {actionError ?? error}
          </div>
        )}

        {needsAttentionCount > 0 && (
          <div
            role="status"
            className="app-alert app-alert-warning mt-4 flex items-start gap-3"
          >
            <ShieldAlert
              size={19}
              className="shrink-0"
              aria-hidden="true"
            />

            <div>
              <p className="font-medium">
                {needsAttentionCount} order
                {needsAttentionCount === 1 ? "" : "s"} require
                attention
              </p>

              <p className="mt-1 text-sm">
                Failed orders remain stored locally. Validation
                conflicts require review before another
                synchronization attempt.
              </p>
            </div>
          </div>
        )}

        {isLoading && (
          <p
            role="status"
            className="mt-4 text-sm text-text-muted"
          >
            Loading local synchronization status...
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        <SummaryCard
          label="Local drafts"
          count={localDraft}
          icon={Database}
        />

        <SummaryCard
          label="Pending sync"
          count={pendingSync}
          icon={Clock3}
          tone="warning"
        />

        <SummaryCard
          label="Syncing"
          count={syncing}
          icon={RefreshCw}
          tone="warning"
        />

        <SummaryCard
          label="Synced"
          count={synced}
          icon={CheckCircle2}
          tone="success"
        />

        <SummaryCard
          label="Sync failed"
          count={syncFailed}
          icon={AlertCircle}
          tone="error"
        />

        <SummaryCard
          label="Conflicts"
          count={conflict}
          icon={ShieldAlert}
          tone="error"
        />
      </div>

      {!compact && (
        <div className="rounded-card border border-border bg-surface p-5 shadow-card">
          <h3 className="text-base font-semibold text-text-primary">
            Synchronization information
          </h3>

          <dl className="mt-3">
            <InformationRow label="Connection">
              {connectivityLabel}
            </InformationRow>

            <InformationRow label="Last successful sync">
              {formatTimestamp(lastSyncedAt)}
            </InformationRow>

            <InformationRow label="Last sync attempt">
              {formatTimestamp(lastAttemptedAt)}
            </InformationRow>

            <InformationRow label="Unsynchronized orders">
              <span className="app-numeric">
                {unsynchronizedCount}
              </span>
            </InformationRow>

            <InformationRow label="Orders requiring attention">
              <span className="app-numeric">
                {needsAttentionCount}
              </span>
            </InformationRow>
          </dl>
        </div>
      )}

      {orders.length > 0 && (
        <div className="rounded-card border border-border bg-surface shadow-card">
          <div className="flex flex-wrap items-center justify-between gap-3 p-5">
            <div>
              <h3 className="text-base font-semibold text-text-primary">
                Local order synchronization details
              </h3>

              <p className="mt-1 text-sm text-text-muted">
                Review the current locally recorded status of
                individual orders.
              </p>
            </div>

            <button
              type="button"
              onClick={() => setShowDetails((current) => !current)}
              aria-expanded={showDetails}
              aria-controls="sync-order-details"
              className="app-button app-button-secondary inline-flex items-center gap-2"
            >
              {showDetails ? (
                <>
                  <ChevronUp
                    size={16}
                    aria-hidden="true"
                  />
                  Hide details
                </>
              ) : (
                <>
                  <ChevronDown
                    size={16}
                    aria-hidden="true"
                  />
                  Show details
                </>
              )}
            </button>
          </div>

          {showDetails && (
            <div
              id="sync-order-details"
              className="border-t border-border"
            >
              <div className="divide-y divide-border">
                {orders.map((order) => {
                  const description =
                    STATUS_DESCRIPTIONS[order.status];

                  const retryable =
                    order.status === "sync_failed" ||
                    order.status === "pending_sync";

                  const retryDisabled =
                    !canRetry ||
                    !retryable ||
                    activeRetryId === order.localId;

                  return (
                    <div
                      key={order.localId}
                      className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:justify-between"
                    >
                      <div className="min-w-0 space-y-2">
                        <p className="break-words text-sm font-semibold text-text-primary">
                          {order.customerName}
                        </p>

                        <p className="break-all text-xs text-text-muted">
                          Local reference: {order.localId}
                        </p>

                        <StatusPill status={order.status} />

                        <p className="text-xs leading-5 text-text-muted">
                          {description.description}
                        </p>

                        <p className="text-xs text-text-muted">
                          Updated:{" "}
                          {formatTimestamp(order.updatedAt)}
                        </p>

                        {order.errorMessage && (
                          <p
                            role="alert"
                            className="max-w-2xl whitespace-pre-wrap text-xs leading-5 text-error"
                          >
                            {order.errorMessage}
                          </p>
                        )}
                      </div>

                      {retryable && onRetryOrder && (
                        <button
                          type="button"
                          onClick={() => {
                            if (!retryDisabled) {
                              void runAction(
                                () => onRetryOrder(order.localId),
                                order.localId,
                              );
                            }
                          }}
                          disabled={retryDisabled}
                          className="app-button app-button-secondary inline-flex shrink-0 items-center gap-2"
                        >
                          <RefreshCw
                            size={15}
                            className={
                              activeRetryId === order.localId
                                ? "motion-safe:animate-spin"
                                : ""
                            }
                            aria-hidden="true"
                          />

                          Retry
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {!compact && (
        <div className="rounded-card border border-border bg-surface p-5 shadow-card">
          <h3 className="text-base font-semibold text-text-primary">
            Local data protection
          </h3>

          <div className="mt-3 space-y-3 text-sm leading-6 text-text-muted">
            <p>
              Local drafts and unsynchronized orders are not
              official backend orders. An order is considered
              synchronized only after the backend confirms its
              successful creation.
            </p>

            <p>
              Failed requests and conflicts must retain their
              local records. Retrying a submission must preserve
              its original idempotency key to prevent duplicate
              backend orders.
            </p>

            <p>
              Pending records remain on this device until their
              synchronization status is resolved. Logout and
              account switching must not delete or expose another
              Salesman's local orders.
            </p>
          </div>

          <div className="mt-5">
            <Link
              to="/offline/orders"
              className="app-button app-button-secondary inline-flex items-center gap-2"
            >
              <Database
                size={16}
                aria-hidden="true"
              />

              Manage offline orders
            </Link>
          </div>
        </div>
      )}
    </section>
  );
}

export default SyncStatus;