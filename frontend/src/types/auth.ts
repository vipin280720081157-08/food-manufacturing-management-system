
/**
 * Authentication and role-based access types.
 *
 * Backend authorization remains authoritative for every protected operation.
 */

export const USER_ROLES = {
  SALESMAN: "salesman",
  FACTORY_ADMIN: "factory_admin",
  PRODUCTION_SUPERVISOR: "production_supervisor",
  ACCOUNTANT_AUDITOR: "accountant_auditor",
  OWNER: "owner",
} as const;

export type UserRole = (typeof USER_ROLES)[keyof typeof USER_ROLES];

export const USER_ROLE_LABELS: Record<UserRole, string> = {
  [USER_ROLES.SALESMAN]: "Salesman",
  [USER_ROLES.FACTORY_ADMIN]: "Factory Admin",
  [USER_ROLES.PRODUCTION_SUPERVISOR]: "Production Supervisor",
  [USER_ROLES.ACCOUNTANT_AUDITOR]: "Accountant / Auditor",
  [USER_ROLES.OWNER]: "Owner",
};

export const ALL_USER_ROLES: readonly UserRole[] =
  Object.values(USER_ROLES);

export function isUserRole(value: unknown): value is UserRole {
  return (
    typeof value === "string" &&
    ALL_USER_ROLES.some((role) => role === value)
  );
}

export interface AuthUser {
  id: string;
  username: string;
  full_name: string;
  role: UserRole;
  is_active: boolean;
}

export interface UserAccount extends AuthUser {
  created_at: string;
  updated_at: string | null;
}

export interface LoginCredentials {
  username: string;
  password: string;
}

export interface AuthTokenResponse {
  access_token: string;
  token_type: "bearer";
  expires_in?: number;
}

export interface AuthSession {
  user: AuthUser;
  accessToken: string;
  expiresAt: number | null;
}

export type AuthenticationStatus =
  | "initializing"
  | "authenticated"
  | "unauthenticated";

export interface AuthState {
  status: AuthenticationStatus;
  user: AuthUser | null;
  error: string | null;
}

export interface AuthContextValue extends AuthState {
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (credentials: LoginCredentials) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  hasRole: (roles: UserRole | readonly UserRole[]) => boolean;
}

export interface CreateUserRequest {
  username: string;
  full_name: string;
  password: string;
  role: UserRole;
  is_active?: boolean;
}

export interface UpdateUserRequest {
  full_name?: string;
  role?: UserRole;
  is_active?: boolean;
}

export interface ChangePasswordRequest {
  current_password: string;
  new_password: string;
}

export interface UserListResponse {
  items: UserAccount[];
  total: number;
  page: number;
  page_size: number;
}

export function isReadOnlyRole(role: UserRole): boolean {
  return (
    role === USER_ROLES.ACCOUNTANT_AUDITOR ||
    role === USER_ROLES.OWNER
  );
}

export function hasAnyRole(
  user: Pick<AuthUser, "role"> | null | undefined,
  allowedRoles: UserRole | readonly UserRole[],
): boolean {
  if (!user) {
    return false;
  }

  const roles = Array.isArray(allowedRoles)
    ? allowedRoles
    : [allowedRoles];

  return roles.some((role) => role === user.role);
}
