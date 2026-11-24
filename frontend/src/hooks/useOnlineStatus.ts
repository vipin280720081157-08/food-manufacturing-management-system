import {
  useCallback,
  useEffect,
  useSyncExternalStore,
} from "react";

import {
  checkBackendConnectivity,
  getSyncServiceState,
  subscribeToSyncState,
} from "../services/synchronization/syncService";

export type ConnectivityStatus =
  | "offline"
  | "online"
  | "checking"
  | "backend_unavailable"
  | "connected";

export interface OnlineStatus {
  isOnline: boolean;
  isOffline: boolean;
  isBackendReachable: boolean | null;
  isChecking: boolean;
  status: ConnectivityStatus;
  lastCheckedAt: string | null;
  error: string | null;
  checkConnection: () => Promise<boolean>;
}

interface ConnectivitySnapshot {
  isOnline: boolean;
  lastChangedAt: string | null;
}

let connectivitySnapshot: ConnectivitySnapshot = {
  isOnline:
    typeof navigator !== "undefined"
      ? navigator.onLine
      : false,
  lastChangedAt: null,
};

const connectivityListeners = new Set<
  () => void
>();

let browserListenersAttached = false;

function notifyConnectivityListeners(): void {
  for (const listener of connectivityListeners) {
    listener();
  }
}

function updateBrowserConnectivity(
  isOnline: boolean,
): void {
  if (
    connectivitySnapshot.isOnline === isOnline
  ) {
    return;
  }

  connectivitySnapshot = {
    isOnline,
    lastChangedAt: new Date().toISOString(),
  };

  notifyConnectivityListeners();
}

function handleBrowserOnline(): void {
  updateBrowserConnectivity(true);
}

function handleBrowserOffline(): void {
  updateBrowserConnectivity(false);
}

function attachBrowserListeners(): void {
  if (
    browserListenersAttached ||
    typeof window === "undefined"
  ) {
    return;
  }

  window.addEventListener(
    "online",
    handleBrowserOnline,
  );

  window.addEventListener(
    "offline",
    handleBrowserOffline,
  );

  browserListenersAttached = true;

  updateBrowserConnectivity(
    navigator.onLine,
  );
}

function detachBrowserListeners(): void {
  if (
    !browserListenersAttached ||
    typeof window === "undefined"
  ) {
    return;
  }

  window.removeEventListener(
    "online",
    handleBrowserOnline,
  );

  window.removeEventListener(
    "offline",
    handleBrowserOffline,
  );

  browserListenersAttached = false;
}

function subscribeToBrowserConnectivity(
  listener: () => void,
): () => void {
  connectivityListeners.add(listener);

  attachBrowserListeners();

  return () => {
    connectivityListeners.delete(listener);

    if (
      connectivityListeners.size === 0
    ) {
      detachBrowserListeners();
    }
  };
}

function getConnectivitySnapshot(): ConnectivitySnapshot {
  return connectivitySnapshot;
}

const SERVER_CONNECTIVITY_SNAPSHOT: ConnectivitySnapshot = {
  isOnline: false,
  lastChangedAt: null,
};

function getServerConnectivitySnapshot(): ConnectivitySnapshot {
  return SERVER_CONNECTIVITY_SNAPSHOT;
}

interface BackendStatusSnapshot {
  reachable: boolean | null;
  lastError: string | null;
}

let backendStatusSnapshot: BackendStatusSnapshot = {
  reachable:
    getSyncServiceState().backendReachable,
  lastError:
    getSyncServiceState().lastError,
};

const backendStatusListeners = new Set<
  () => void
>();

let unsubscribeFromSyncState:
  | (() => void)
  | null = null;

function subscribeToBackendStatus(
  listener: () => void,
): () => void {
  backendStatusListeners.add(listener);

  if (!unsubscribeFromSyncState) {
    unsubscribeFromSyncState =
      subscribeToSyncState((state) => {
        if (
          backendStatusSnapshot.reachable ===
            state.backendReachable &&
          backendStatusSnapshot.lastError ===
            state.lastError
        ) {
          return;
        }

        backendStatusSnapshot = {
          reachable:
            state.backendReachable,
          lastError: state.lastError,
        };

        for (const subscriber of backendStatusListeners) {
          subscriber();
        }
      });
  }

  return () => {
    backendStatusListeners.delete(listener);

    if (
      backendStatusListeners.size === 0
    ) {
      unsubscribeFromSyncState?.();
      unsubscribeFromSyncState = null;
    }
  };
}

function getBackendStatusSnapshot(): BackendStatusSnapshot {
  return backendStatusSnapshot;
}

const SERVER_BACKEND_STATUS_SNAPSHOT: BackendStatusSnapshot = {
  reachable: null,
  lastError: null,
};

function getServerBackendStatusSnapshot(): BackendStatusSnapshot {
  return SERVER_BACKEND_STATUS_SNAPSHOT;
}

export function useOnlineStatus(): OnlineStatus {
  const connectivity = useSyncExternalStore(
    subscribeToBrowserConnectivity,
    getConnectivitySnapshot,
    getServerConnectivitySnapshot,
  );

  const backend = useSyncExternalStore(
    subscribeToBackendStatus,
    getBackendStatusSnapshot,
    getServerBackendStatusSnapshot,
  );

  const isOnline = connectivity.isOnline;

  const isBackendReachable = isOnline
    ? backend.reachable
    : false;

  const checkConnection = useCallback(
    async (): Promise<boolean> => {
      if (!navigator.onLine) {
        return false;
      }

      return checkBackendConnectivity();
    },
    [],
  );

  const status: ConnectivityStatus =
    !isOnline
      ? "offline"
      : isBackendReachable === true
        ? "connected"
        : isBackendReachable === false
          ? "backend_unavailable"
          : "online";

  return {
    isOnline,
    isOffline: !isOnline,
    isBackendReachable,
    isChecking: false,
    status,
    lastCheckedAt:
      connectivity.lastChangedAt,
    error: backend.lastError,
    checkConnection,
  };
}

export function useBrowserOnlineStatus(): boolean {
  const connectivity = useSyncExternalStore(
    subscribeToBrowserConnectivity,
    getConnectivitySnapshot,
    getServerConnectivitySnapshot,
  );

  return connectivity.isOnline;
}

export function useOnlineEffect(
  callback: () => void,
): void {
  const isOnline = useBrowserOnlineStatus();

  useEffect(() => {
    if (isOnline) {
      callback();
    }
  }, [isOnline, callback]);
}

export default useOnlineStatus;