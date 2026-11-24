import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type {
  AuthContextValue,
  AuthUser,
  LoginCredentials,
  UserRole,
} from "../../types/auth";

import {
  hasAnyRole,
} from "../../types/auth";

import {
  getCurrentUser,
  login as loginRequest,
  logout as logoutRequest,
} from "../../services/api/authApi";

import {
  clearAccessToken,
  getAccessToken,
  setUnauthorizedHandler,
} from "../../services/api/client";

import {
  clearSalesmanReferenceCache,
  closeOfflineDatabase,
} from "../../services/local-storage/offlineDb";

import {
  createAutomaticSyncController,
  recoverPendingSynchronization,
  type AutomaticSyncController,
} from "../../services/synchronization/syncService";

/**
 * Authentication state is maintained in memory.
 *
 * Access tokens are not persisted in local storage or IndexedDB.
 * Offline orders remain stored across logout and session expiry.
 * Backend authorization remains authoritative for every API request.
 */

export interface AuthProviderProps {
  children: ReactNode;
}

export const AuthContext =
  createContext<AuthContextValue | null>(null);

interface InternalAuthState {
  status:
    | "initializing"
    | "authenticated"
    | "unauthenticated";
  user: AuthUser | null;
  error: string | null;
}

const INITIAL_AUTH_STATE: InternalAuthState = {
  status: "initializing",
  user: null,
  error: null,
};

function getErrorMessage(
  error: unknown,
): string {
  if (
    error instanceof Error &&
    error.message.trim()
  ) {
    return error.message;
  }

  return "Authentication failed. Please try again.";
}

function isActiveUser(
  user: AuthUser,
): boolean {
  return user.is_active === true;
}

export function AuthProvider({
  children,
}: AuthProviderProps) {
  const [authState, setAuthState] =
    useState<InternalAuthState>(
      INITIAL_AUTH_STATE,
    );

  const mountedRef = useRef(false);

  const sessionVersionRef = useRef(0);

  const userRef = useRef<AuthUser | null>(
    null,
  );

  const syncControllerRef =
    useRef<AutomaticSyncController | null>(
      null,
    );

  const syncOwnerRef = useRef<
    string | null
  >(null);

  const stopAutomaticSync =
    useCallback((): void => {
      syncControllerRef.current?.stop();

      syncControllerRef.current = null;
      syncOwnerRef.current = null;
    }, []);

  const updateAuthState = useCallback(
    (nextState: InternalAuthState): void => {
      userRef.current = nextState.user;

      if (mountedRef.current) {
        setAuthState(nextState);
      }
    },
    [],
  );

  const clearSession = useCallback(
    (
      error: string | null = null,
    ): void => {
      sessionVersionRef.current += 1;

      stopAutomaticSync();
      clearAccessToken();

      updateAuthState({
        status: "unauthenticated",
        user: null,
        error,
      });
    },
    [
      stopAutomaticSync,
      updateAuthState,
    ],
  );

  const startAutomaticSync =
    useCallback(
      (user: AuthUser): void => {
        if (
          user.role !== "salesman" ||
          !user.is_active
        ) {
          stopAutomaticSync();
          return;
        }

        if (
          syncControllerRef.current &&
          syncOwnerRef.current === user.id
        ) {
          return;
        }

        stopAutomaticSync();

        const controller =
          createAutomaticSyncController(
            user.id,
          );

        syncControllerRef.current =
          controller;

        syncOwnerRef.current = user.id;

        controller.start();

        void recoverPendingSynchronization(
          user.id,
        ).catch(() => {
          // Recovery failures must not invalidate authentication.
        });
      },
      [stopAutomaticSync],
    );

  useEffect(() => {
    mountedRef.current = true;

    const initializeSession =
      async (): Promise<void> => {
        const token = getAccessToken();

        if (!token) {
          updateAuthState({
            status: "unauthenticated",
            user: null,
            error: null,
          });

          return;
        }

        const version =
          sessionVersionRef.current;

        try {
          const user =
            await getCurrentUser();

          if (
            !mountedRef.current ||
            version !==
              sessionVersionRef.current
          ) {
            return;
          }

          if (!isActiveUser(user)) {
            clearSession(
              "This user account is inactive.",
            );

            return;
          }

          updateAuthState({
            status: "authenticated",
            user,
            error: null,
          });

          startAutomaticSync(user);
        } catch (error) {
          if (
            !mountedRef.current ||
            version !==
              sessionVersionRef.current
          ) {
            return;
          }

          clearSession(
            getErrorMessage(error),
          );
        }
      };

    void initializeSession();

    return () => {
      mountedRef.current = false;
      sessionVersionRef.current += 1;

      stopAutomaticSync();
    };
  }, [
    clearSession,
    startAutomaticSync,
    stopAutomaticSync,
    updateAuthState,
  ]);

  useEffect(() => {
    const handleUnauthorized = (): void => {
      if (!mountedRef.current) {
        return;
      }

      clearSession(
        "The session has expired. Please sign in again.",
      );
    };

    setUnauthorizedHandler(
      handleUnauthorized,
    );

    return () => {
      setUnauthorizedHandler(null);
    };
  }, [clearSession]);

  const login = useCallback(
    async (
      credentials: LoginCredentials,
    ): Promise<void> => {
      const username =
        credentials.username.trim();

      if (!username) {
        throw new Error(
          "Username is required.",
        );
      }

      if (!credentials.password) {
        throw new Error(
          "Password is required.",
        );
      }

      const version =
        ++sessionVersionRef.current;

      stopAutomaticSync();
      clearAccessToken();

      updateAuthState({
        status: "initializing",
        user: null,
        error: null,
      });

      try {
        const result =
          await loginRequest({
            username,
            password:
              credentials.password,
          });

        if (
          !mountedRef.current ||
          version !==
            sessionVersionRef.current
        ) {
          clearAccessToken();
          return;
        }

        if (
          !isActiveUser(result.user)
        ) {
          clearSession(
            "This user account is inactive.",
          );

          throw new Error(
            "This user account is inactive.",
          );
        }

        updateAuthState({
          status: "authenticated",
          user: result.user,
          error: null,
        });

        startAutomaticSync(
          result.user,
        );
      } catch (error) {
        if (
          mountedRef.current &&
          version ===
            sessionVersionRef.current
        ) {
          clearSession(
            getErrorMessage(error),
          );
        }

        throw error;
      }
    },
    [
      clearSession,
      startAutomaticSync,
      stopAutomaticSync,
      updateAuthState,
    ],
  );

  const logout = useCallback(
    async (): Promise<void> => {
      const currentUser =
        userRef.current;

      const version =
        ++sessionVersionRef.current;

      stopAutomaticSync();

      try {
        await logoutRequest();
      } finally {
        if (
          version ===
          sessionVersionRef.current
        ) {
          clearSession();
        }

        if (
          currentUser?.role ===
          "salesman"
        ) {
          try {
            await clearSalesmanReferenceCache(
              currentUser.id,
            );
          } catch {
            // Cached reference data may be cleared on a later session.
          }
        }

        try {
          await closeOfflineDatabase();
        } catch {
          // Database closure must not prevent logout.
        }
      }
    },
    [
      clearSession,
      stopAutomaticSync,
    ],
  );

  const refreshUser = useCallback(
    async (): Promise<void> => {
      if (!getAccessToken()) {
        clearSession();
        return;
      }

      const version =
        sessionVersionRef.current;

      try {
        const user =
          await getCurrentUser();

        if (
          !mountedRef.current ||
          version !==
            sessionVersionRef.current
        ) {
          return;
        }

        if (!isActiveUser(user)) {
          clearSession(
            "This user account is inactive.",
          );

          return;
        }

        updateAuthState({
          status: "authenticated",
          user,
          error: null,
        });

        startAutomaticSync(user);
      } catch (error) {
        if (
          !mountedRef.current ||
          version !==
            sessionVersionRef.current
        ) {
          return;
        }

        const message =
          getErrorMessage(error);

        updateAuthState({
          status: userRef.current
            ? "authenticated"
            : "unauthenticated",
          user: userRef.current,
          error: message,
        });

        throw error;
      }
    },
    [
      clearSession,
      startAutomaticSync,
      updateAuthState,
    ],
  );

  const hasRole = useCallback(
    (
      roles:
        | UserRole
        | readonly UserRole[],
    ): boolean => {
      return hasAnyRole(
        userRef.current,
        roles,
      );
    },
    [],
  );

  const contextValue =
    useMemo<AuthContextValue>(
      () => ({
        status: authState.status,
        user: authState.user,
        error: authState.error,

        isAuthenticated:
          authState.status ===
            "authenticated" &&
          authState.user !== null,

        isLoading:
          authState.status ===
          "initializing",

        login,
        logout,
        refreshUser,
        hasRole,
      }),
      [
        authState,
        login,
        logout,
        refreshUser,
        hasRole,
      ],
    );

  return (
    <AuthContext.Provider
      value={contextValue}
    >
      {children}
    </AuthContext.Provider>
  );
}

export default AuthProvider;