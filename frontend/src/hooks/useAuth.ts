import { useContext } from "react";

import type {
  AuthContextValue,
  AuthUser,
  UserRole,
} from "../types/auth";

import {
  isReadOnlyRole,
  USER_ROLES,
} from "../types/auth";

import {
  AuthContext,
} from "../app/providers/AuthProvider";

/**
 * Provides access to authentication state and role-based
 * presentation helpers. Backend authorization remains authoritative.
 */

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);

  if (context === null) {
    throw new Error(
      "useAuth must be used within an AuthProvider.",
    );
  }

  return context;
}

export interface AuthUserState {
  user: AuthUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
}

export function useAuthUser(): AuthUserState {
  const {
    user,
    isAuthenticated,
    isLoading,
  } = useAuth();

  return {
    user,
    isAuthenticated,
    isLoading,
  };
}

export interface RoleAccess {
  role: UserRole | null;
  isSalesman: boolean;
  isFactoryAdmin: boolean;
  isProductionSupervisor: boolean;
  isAccountantAuditor: boolean;
  isOwner: boolean;
  isReadOnly: boolean;
  canManageSales: boolean;
  canManageMasters: boolean;
  canManagePurchasing: boolean;
  canManageInventory: boolean;
  canManageProduction: boolean;
  canManageDispatch: boolean;
  canManagePayments: boolean;
  canViewReports: boolean;
  canCaptureOfflineOrders: boolean;
  hasRole: (
    roles: UserRole | readonly UserRole[],
  ) => boolean;
}

export function useRoleAccess(): RoleAccess {
  const {
    user,
    isAuthenticated,
    hasRole,
  } = useAuth();

  const role = isAuthenticated
    ? (user?.role ?? null)
    : null;

  const isSalesman =
    role === USER_ROLES.SALESMAN;

  const isFactoryAdmin =
    role === USER_ROLES.FACTORY_ADMIN;

  const isProductionSupervisor =
    role === USER_ROLES.PRODUCTION_SUPERVISOR;

  const isAccountantAuditor =
    role === USER_ROLES.ACCOUNTANT_AUDITOR;

  const isOwner =
    role === USER_ROLES.OWNER;

  const isReadOnly =
    role !== null &&
    isReadOnlyRole(role);

  return {
    role,
    isSalesman,
    isFactoryAdmin,
    isProductionSupervisor,
    isAccountantAuditor,
    isOwner,
    isReadOnly,

    canManageSales:
      isSalesman || isFactoryAdmin,

    canManageMasters:
      isFactoryAdmin,

    canManagePurchasing:
      isFactoryAdmin,

    canManageInventory:
      isFactoryAdmin,

    canManageProduction:
      isFactoryAdmin ||
      isProductionSupervisor,

    canManageDispatch:
      isFactoryAdmin,

    canManagePayments:
      isFactoryAdmin,

    canViewReports:
      role !== null,

    canCaptureOfflineOrders:
      isSalesman,

    hasRole,
  };
}

export function useHasRole(
  roles: UserRole | readonly UserRole[],
): boolean {
  const { hasRole } = useAuth();

  return hasRole(roles);
}

export function useIsReadOnly(): boolean {
  const { isReadOnly } = useRoleAccess();

  return isReadOnly;
}

export default useAuth;