import type {
  AuthTokenResponse,
  AuthUser,
  ChangePasswordRequest,
  CreateUserRequest,
  LoginCredentials,
  UpdateUserRequest,
  UserAccount,
  UserListResponse,
} from "../../types/auth";

import type {
  PaginationParams,
  UUID,
} from "../../types/business";

import {
  ApiError,
  apiClient,
  clearAccessToken,
  getAccessToken,
  setAccessToken,
  type ApiRequestOptions,
} from "./client";

/**
 * Authentication and user-management API integration.
 *
 * Access tokens remain in memory and are not persisted in
 * localStorage, sessionStorage, or IndexedDB.
 *
 * The backend remains authoritative for authentication,
 * account status, role assignments, and permissions.
 */

export const AUTH_API_PATHS = {
  LOGIN: "/auth/login",
  LOGOUT: "/auth/logout",
  CURRENT_USER: "/auth/me",
  CHANGE_PASSWORD: "/auth/change-password",
  USERS: "/users",
} as const;

export interface LoginResult {
  user: AuthUser;
  accessToken: string;
  expiresAt: number | null;
}

export type AuthApiRequestOptions = Pick<ApiRequestOptions, "signal" | "timeoutMs">;

export interface DemoLoginOptions {
  enabled: boolean;
  password: string | null;
  accounts: Array<{ username: string; label: string; role: string }>;
}

export async function getDemoLoginOptions(
  options: AuthApiRequestOptions = {},
): Promise<DemoLoginOptions | null> {
  try {
    const result = await apiClient.get<DemoLoginOptions>(
      "/auth/demo-options",
      { ...options, skipAuth: true },
    );
    return result.enabled && result.password && result.accounts.length === 6
      ? result
      : null;
  } catch {
    return null;
  }
}

export interface UserListParams
  extends PaginationParams {
  role?: string;
  is_active?: boolean;
}

function requireNonEmptyString(
  value: string,
  fieldName: string,
): string {
  const normalized = value.trim();

  if (!normalized) {
    throw new ApiError(
      `${fieldName} is required.`,
      {
        category: "validation",
        code: "REQUIRED_FIELD",
      },
    );
  }

  return normalized;
}

function validateLoginCredentials(
  credentials: LoginCredentials,
): LoginCredentials {
  const username = requireNonEmptyString(
    credentials.username,
    "Username",
  );

  if (!credentials.password) {
    throw new ApiError(
      "Password is required.",
      {
        category: "validation",
        code: "REQUIRED_PASSWORD",
      },
    );
  }

  return {
    username,
    password: credentials.password,
  };
}

function validateAuthTokenResponse(
  response: AuthTokenResponse,
): AuthTokenResponse {
  if (
    !response ||
    typeof response.access_token !== "string" ||
    !response.access_token.trim() ||
    response.token_type?.toLowerCase() !==
      "bearer"
  ) {
    throw new ApiError(
      "The backend returned an invalid authentication response.",
      {
        category: "authentication",
        code: "INVALID_AUTH_RESPONSE",
      },
    );
  }

  if (
    response.expires_in !== undefined &&
    (
      !Number.isFinite(response.expires_in) ||
      response.expires_in <= 0
    )
  ) {
    throw new ApiError(
      "The backend returned an invalid token expiration.",
      {
        category: "authentication",
        code: "INVALID_TOKEN_EXPIRATION",
      },
    );
  }

  return response;
}

function validateAuthenticatedUser(
  user: AuthUser,
): AuthUser {
  if (
    !user ||
    typeof user.id !== "string" ||
    !user.id.trim() ||
    typeof user.username !== "string" ||
    !user.username.trim() ||
    typeof user.full_name !== "string" ||
    typeof user.role !== "string" ||
    typeof user.is_active !== "boolean"
  ) {
    throw new ApiError(
      "The backend returned an invalid user profile.",
      {
        category: "authentication",
        code: "INVALID_USER_PROFILE",
      },
    );
  }

  if (!user.is_active) {
    throw new ApiError(
      "This user account is inactive.",
      {
        category: "authorization",
        code: "INACTIVE_USER",
      },
    );
  }

  return user;
}

function requireAuthenticatedSession(): void {
  if (!getAccessToken()) {
    throw new ApiError(
      "Authentication is required.",
      {
        status: 401,
        category: "authentication",
        code: "AUTHENTICATION_REQUIRED",
      },
    );
  }
}

function buildUserPath(userId: UUID): string {
  const normalizedId = requireNonEmptyString(
    userId,
    "User ID",
  );

  return `${AUTH_API_PATHS.USERS}/${encodeURIComponent(
    normalizedId,
  )}`;
}

export async function login(
  credentials: LoginCredentials,
  options: AuthApiRequestOptions = {},
): Promise<LoginResult> {
  const validatedCredentials =
    validateLoginCredentials(credentials);

  clearAccessToken();

  const formBody = new URLSearchParams();

  formBody.set(
    "username",
    validatedCredentials.username,
  );

  formBody.set(
    "password",
    validatedCredentials.password,
  );

  formBody.set(
    "grant_type",
    "password",
  );

  const tokenResponse =
    await apiClient.post<AuthTokenResponse>(
      AUTH_API_PATHS.LOGIN,
      formBody.toString(),
      {
        ...options,
        skipAuth: true,
        contentType:
          "application/x-www-form-urlencoded",
      },
    );

  const validatedToken =
    validateAuthTokenResponse(tokenResponse);

  const expiresAt =
    validatedToken.expires_in !== undefined
      ? Date.now() +
        validatedToken.expires_in * 1000
      : null;

  setAccessToken(
    validatedToken.access_token,
  );

  try {
    const user = await getCurrentUser(options);

    return {
      user,
      accessToken:
        validatedToken.access_token,
      expiresAt,
    };
  } catch (error) {
    clearAccessToken();
    throw error;
  }
}

export async function getCurrentUser(
  options: AuthApiRequestOptions = {},
): Promise<AuthUser> {
  requireAuthenticatedSession();

  const user = await apiClient.get<AuthUser>(
    AUTH_API_PATHS.CURRENT_USER,
    options,
  );

  return validateAuthenticatedUser(user);
}

export async function logout(
  options: AuthApiRequestOptions = {},
): Promise<void> {
  const token = getAccessToken();

  if (!token) {
    clearAccessToken();
    return;
  }

  try {
    await apiClient.post<void>(
      AUTH_API_PATHS.LOGOUT,
      undefined,
      options,
    );
  } finally {
    clearAccessToken();
  }
}

export async function changePassword(
  request: ChangePasswordRequest,
  options: AuthApiRequestOptions = {},
): Promise<void> {
  requireAuthenticatedSession();

  if (!request.current_password) {
    throw new ApiError(
      "Current password is required.",
      {
        category: "validation",
        code: "CURRENT_PASSWORD_REQUIRED",
      },
    );
  }

  if (!request.new_password) {
    throw new ApiError(
      "New password is required.",
      {
        category: "validation",
        code: "NEW_PASSWORD_REQUIRED",
      },
    );
  }

  if (
    request.current_password ===
    request.new_password
  ) {
    throw new ApiError(
      "The new password must differ from the current password.",
      {
        category: "validation",
        code: "PASSWORD_UNCHANGED",
      },
    );
  }

  await apiClient.post<void>(
    AUTH_API_PATHS.CHANGE_PASSWORD,
    request,
    options,
  );
}

export async function getUsers(
  params: UserListParams = {},
  options: AuthApiRequestOptions = {},
): Promise<UserListResponse> {
  requireAuthenticatedSession();

  return apiClient.get<UserListResponse>(
    AUTH_API_PATHS.USERS,
    {
      ...options,
      query: {
        page: params.page,
        page_size: params.page_size,
        search: params.search,
        sort_by: params.sort_by,
        sort_direction:
          params.sort_direction,
        role: params.role,
        is_active: params.is_active,
      },
    },
  );
}

export async function getUserById(
  userId: UUID,
  options: AuthApiRequestOptions = {},
): Promise<UserAccount> {
  requireAuthenticatedSession();

  return apiClient.get<UserAccount>(
    buildUserPath(userId),
    options,
  );
}

export async function createUser(
  request: CreateUserRequest,
  options: AuthApiRequestOptions = {},
): Promise<UserAccount> {
  requireAuthenticatedSession();

  const username = requireNonEmptyString(
    request.username,
    "Username",
  );

  const fullName = requireNonEmptyString(
    request.full_name,
    "Full name",
  );

  if (!request.password) {
    throw new ApiError(
      "Password is required.",
      {
        category: "validation",
        code: "PASSWORD_REQUIRED",
      },
    );
  }

  return apiClient.post<UserAccount>(
    AUTH_API_PATHS.USERS,
    {
      ...request,
      username,
      full_name: fullName,
    },
    options,
  );
}

export async function updateUser(
  userId: UUID,
  request: UpdateUserRequest,
  options: AuthApiRequestOptions = {},
): Promise<UserAccount> {
  requireAuthenticatedSession();

  if (
    Object.keys(request).length === 0
  ) {
    throw new ApiError(
      "At least one user field must be provided.",
      {
        category: "validation",
        code: "EMPTY_UPDATE",
      },
    );
  }

  const normalizedRequest: UpdateUserRequest = {
    ...request,
  };

  if (
    normalizedRequest.full_name !== undefined
  ) {
    normalizedRequest.full_name =
      requireNonEmptyString(
        normalizedRequest.full_name,
        "Full name",
      );
  }

  return apiClient.patch<UserAccount>(
    buildUserPath(userId),
    normalizedRequest,
    options,
  );
}

export async function setUserActiveStatus(
  userId: UUID,
  isActive: boolean,
  options: AuthApiRequestOptions = {},
): Promise<UserAccount> {
  return updateUser(
    userId,
    {
      is_active: isActive,
    },
    options,
  );
}

export const authApi = {
  login,
  logout,
  getCurrentUser,
  changePassword,
  getUsers,
  getUserById,
  createUser,
  updateUser,
  setUserActiveStatus,
} as const;
