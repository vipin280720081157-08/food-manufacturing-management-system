/**
 * Shared HTTP client for the FastAPI backend.
 *
 * Authentication tokens are retained in memory. API responses are not
 * cached by the service worker, and mutation requests are never retried
 * automatically. Offline synchronization manages its own retry policy.
 */

export const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL ||
  "http://localhost:8000/api/v1"
).replace(/\/+$/, "");

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export type ApiErrorCategory =
  | "network"
  | "timeout"
  | "authentication"
  | "authorization"
  | "validation"
  | "conflict"
  | "not_found"
  | "rate_limit"
  | "server"
  | "unknown";

export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE";

export type QueryParameterValue =
  | string
  | number
  | boolean
  | null
  | undefined;

export type QueryParameters = Record<
  string,
  QueryParameterValue | readonly QueryParameterValue[]
>;

export interface ApiValidationError {
  loc: Array<string | number>;
  msg: string;
  type: string;
}

export interface ApiErrorResponse {
  detail?:
    | string
    | ApiValidationError[]
    | Record<string, unknown>;
  message?: string;
  code?: string;
  errors?: ApiValidationError[];
}

export interface ApiRequestOptions
  extends Omit<
    RequestInit,
    "method" | "body" | "headers" | "signal"
  > {
  headers?: HeadersInit;
  signal?: AbortSignal;
  timeoutMs?: number;
  query?: QueryParameters;
  skipAuth?: boolean;
  idempotencyKey?: string;
}

export interface ApiMutationOptions
  extends ApiRequestOptions {
  contentType?: string;
}

export interface ApiClientConfig {
  baseUrl?: string;
  timeoutMs?: number;
  getAccessToken?: () => string | null;
  onUnauthorized?: () => void;
}

export class ApiError extends Error {
  readonly status: number | null;
  readonly category: ApiErrorCategory;
  readonly code: string | null;
  readonly details: unknown;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: {
      status?: number | null;
      category?: ApiErrorCategory;
      code?: string | null;
      details?: unknown;
      retryable?: boolean;
    } = {},
  ) {
    super(message);

    this.name = "ApiError";
    this.status = options.status ?? null;
    this.category = options.category ?? "unknown";
    this.code = options.code ?? null;
    this.details = options.details ?? null;
    this.retryable = options.retryable ?? false;

    Object.setPrototypeOf(
      this,
      new.target.prototype,
    );
  }
}

let accessToken: string | null = null;
let unauthorizedHandler: (() => void) | null = null;

export function setAccessToken(
  token: string | null,
): void {
  accessToken = token?.trim() || null;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function clearAccessToken(): void {
  accessToken = null;
}

export function setUnauthorizedHandler(
  handler: (() => void) | null,
): void {
  unauthorizedHandler = handler;
}

export function isApiError(
  error: unknown,
): error is ApiError {
  return error instanceof ApiError;
}

export function isAuthenticationError(
  error: unknown,
): boolean {
  return (
    error instanceof ApiError &&
    error.category === "authentication"
  );
}

export function isNetworkError(
  error: unknown,
): boolean {
  return (
    error instanceof ApiError &&
    (
      error.category === "network" ||
      error.category === "timeout"
    )
  );
}

export function isRetryableApiError(
  error: unknown,
): boolean {
  return (
    error instanceof ApiError &&
    error.retryable
  );
}

function getErrorCategory(
  status: number,
): ApiErrorCategory {
  switch (status) {
    case 400:
    case 422:
      return "validation";

    case 401:
      return "authentication";

    case 403:
      return "authorization";

    case 404:
      return "not_found";

    case 409:
      return "conflict";

    case 429:
      return "rate_limit";

    default:
      return status >= 500
        ? "server"
        : "unknown";
  }
}

function isRetryableHttpStatus(
  status: number,
): boolean {
  return (
    status === 408 ||
    status === 429 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

function isValidationError(
  value: unknown,
): value is ApiValidationError {
  if (
    typeof value !== "object" ||
    value === null
  ) {
    return false;
  }

  const candidate = value as Record<
    string,
    unknown
  >;

  return (
    Array.isArray(candidate.loc) &&
    candidate.loc.every(
      (part) =>
        typeof part === "string" ||
        typeof part === "number",
    ) &&
    typeof candidate.msg === "string" &&
    typeof candidate.type === "string"
  );
}

function getValidationMessage(
  errors: readonly ApiValidationError[],
): string {
  if (errors.length === 0) {
    return "The submitted information is invalid.";
  }

  return errors
    .map((error) => {
      const field = error.loc
        .filter(
          (part) =>
            part !== "body" &&
            part !== "query" &&
            part !== "path",
        )
        .join(".");

      return field
        ? `${field}: ${error.msg}`
        : error.msg;
    })
    .join("; ");
}

function extractErrorMessage(
  payload: unknown,
  status: number,
): string {
  if (
    typeof payload === "object" &&
    payload !== null
  ) {
    const response = payload as ApiErrorResponse;

    if (
      typeof response.detail === "string" &&
      response.detail.trim()
    ) {
      return response.detail;
    }

    if (
      Array.isArray(response.detail) &&
      response.detail.every(isValidationError)
    ) {
      return getValidationMessage(
        response.detail,
      );
    }

    if (
      response.detail &&
      typeof response.detail === "object" &&
      !Array.isArray(response.detail)
    ) {
      const nestedMessage = (
        response.detail as Record<string, unknown>
      ).message;

      if (
        typeof nestedMessage === "string" &&
        nestedMessage.trim()
      ) {
        return nestedMessage;
      }
    }

    if (
      typeof response.message === "string" &&
      response.message.trim()
    ) {
      return response.message;
    }

    if (
      Array.isArray(response.errors) &&
      response.errors.every(isValidationError)
    ) {
      return getValidationMessage(
        response.errors,
      );
    }
  }

  switch (status) {
    case 400:
      return "The request could not be processed.";

    case 401:
      return "Authentication is required or the session has expired.";

    case 403:
      return "Access to this operation is not permitted.";

    case 404:
      return "The requested resource was not found.";

    case 408:
      return "The server timed out while processing the request.";

    case 409:
      return "The request conflicts with the current resource state.";

    case 422:
      return "The submitted information failed validation.";

    case 429:
      return "Too many requests. Try again later.";

    case 500:
      return "The server encountered an error.";

    case 502:
    case 503:
    case 504:
      return "The backend service is temporarily unavailable.";

    default:
      return `The request failed with HTTP status ${status}.`;
  }
}

function extractErrorCode(
  payload: unknown,
): string | null {
  if (
    typeof payload !== "object" ||
    payload === null
  ) {
    return null;
  }

  const response = payload as ApiErrorResponse;

  if (
    typeof response.code === "string" &&
    response.code.trim()
  ) {
    return response.code;
  }

  if (
    response.detail &&
    typeof response.detail === "object" &&
    !Array.isArray(response.detail)
  ) {
    const nestedCode = (
      response.detail as Record<string, unknown>
    ).code;

    if (
      typeof nestedCode === "string" &&
      nestedCode.trim()
    ) {
      return nestedCode;
    }
  }

  return null;
}

async function parseResponseBody(
  response: Response,
): Promise<unknown> {
  if (
    response.status === 204 ||
    response.status === 205
  ) {
    return null;
  }

  const text = await response.text();

  if (!text.trim()) {
    return null;
  }

  const contentType =
    response.headers.get("content-type") ?? "";

  if (
    contentType.includes("application/json") ||
    contentType.includes("+json")
  ) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ApiError(
        "The server returned an invalid JSON response.",
        {
          status: response.status,
          category: "server",
          retryable: false,
        },
      );
    }
  }

  return text;
}

function createHttpError(
  response: Response,
  payload: unknown,
): ApiError {
  return new ApiError(
    extractErrorMessage(
      payload,
      response.status,
    ),
    {
      status: response.status,
      category: getErrorCategory(
        response.status,
      ),
      code: extractErrorCode(payload),
      details: payload,
      retryable: isRetryableHttpStatus(
        response.status,
      ),
    },
  );
}

export function buildQueryString(
  parameters?: QueryParameters,
): string {
  if (!parameters) {
    return "";
  }

  const searchParams = new URLSearchParams();

  for (
    const [key, rawValue] of
    Object.entries(parameters)
  ) {
    if (
      rawValue === null ||
      rawValue === undefined
    ) {
      continue;
    }

    const values = Array.isArray(rawValue)
      ? rawValue
      : [rawValue];

    for (const value of values) {
      if (
        value !== null &&
        value !== undefined
      ) {
        searchParams.append(
          key,
          String(value),
        );
      }
    }
  }

  return searchParams.toString();
}

function normalizeBaseUrl(
  baseUrl: string,
): string {
  const normalized = baseUrl
    .trim()
    .replace(/\/+$/, "");

  if (!normalized) {
    throw new Error(
      "An API base URL is required.",
    );
  }

  return normalized;
}

export function buildApiUrl(
  path: string,
  query?: QueryParameters,
  baseUrl = API_BASE_URL,
): string {
  const normalizedBaseUrl =
    normalizeBaseUrl(baseUrl);

  const normalizedPath = path.trim();

  if (
    /^[a-z][a-z\d+.-]*:/i.test(normalizedPath) ||
    normalizedPath.startsWith("//") ||
    normalizedPath.includes("#")
  ) {
    throw new Error(
      "API paths must be relative to the configured backend.",
    );
  }

  const [pathname = "", existingQuery = ""] =
    normalizedPath.split("?", 2);

  const segments = pathname
    .split("/")
    .filter(Boolean);

  if (
    segments.some(
      (segment) =>
        segment === "." ||
        segment === ".." ||
        /%2f|%5c|%2e/i.test(segment),
    )
  ) {
    throw new Error(
      "The API path contains an invalid segment.",
    );
  }

  const suffix = segments.join("/");

  const url = suffix
    ? `${normalizedBaseUrl}/${suffix}`
    : normalizedBaseUrl;

  const parameters = new URLSearchParams(
    existingQuery,
  );

  const additionalQuery =
    buildQueryString(query);

  if (additionalQuery) {
    new URLSearchParams(
      additionalQuery,
    ).forEach((value, key) => {
      parameters.append(key, value);
    });
  }

  const queryString = parameters.toString();

  return queryString
    ? `${url}?${queryString}`
    : url;
}

function createRequestSignal(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): {
  signal: AbortSignal;
  cleanup: () => void;
  didTimeout: () => boolean;
} {
  const controller = new AbortController();

  let timedOut = false;

  const abortFromExternalSignal = () => {
    controller.abort(
      externalSignal?.reason,
    );
  };

  if (externalSignal?.aborted) {
    abortFromExternalSignal();
  } else {
    externalSignal?.addEventListener(
      "abort",
      abortFromExternalSignal,
      { once: true },
    );
  }

  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,

    cleanup: () => {
      clearTimeout(timeoutId);

      externalSignal?.removeEventListener(
        "abort",
        abortFromExternalSignal,
      );
    },

    didTimeout: () => timedOut,
  };
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly tokenProvider:
    () => string | null;
  private readonly unauthorizedCallback:
    () => void;

  constructor(config: ApiClientConfig = {}) {
    this.baseUrl = normalizeBaseUrl(
      config.baseUrl ?? API_BASE_URL,
    );

    this.timeoutMs =
      config.timeoutMs ??
      DEFAULT_REQUEST_TIMEOUT_MS;

    if (
      !Number.isFinite(this.timeoutMs) ||
      this.timeoutMs <= 0
    ) {
      throw new Error(
        "API request timeout must be greater than zero.",
      );
    }

    this.tokenProvider =
      config.getAccessToken ??
      getAccessToken;

    this.unauthorizedCallback =
      config.onUnauthorized ??
      (() => {
        unauthorizedHandler?.();
      });
  }

  async request<TResponse>(
    method: HttpMethod,
    path: string,
    body?: unknown,
    options: ApiMutationOptions = {},
  ): Promise<TResponse> {
    const {
      headers: customHeaders,
      signal: externalSignal,
      timeoutMs = this.timeoutMs,
      query,
      skipAuth = false,
      idempotencyKey,
      contentType,
      credentials = "omit",
      cache: _cache,
      ...requestOptions
    } = options;

    if (
      !Number.isFinite(timeoutMs) ||
      timeoutMs <= 0
    ) {
      throw new Error(
        "Request timeout must be greater than zero.",
      );
    }

    if (
      (method === "GET" || method === "DELETE") &&
      body !== undefined
    ) {
      throw new Error(
        `${method} requests cannot contain a JSON request body.`,
      );
    }

    const headers = new Headers(
      customHeaders,
    );

    if (!headers.has("Accept")) {
      headers.set(
        "Accept",
        "application/json",
      );
    }

    if (body !== undefined) {
      headers.set(
        "Content-Type",
        contentType ??
          "application/json",
      );
    }

    if (!skipAuth) {
      const token = this.tokenProvider();

      if (token) {
        headers.set(
          "Authorization",
          `Bearer ${token}`,
        );
      }
    }

    if (idempotencyKey !== undefined) {
      const normalizedKey =
        idempotencyKey.trim();

      if (
        !normalizedKey ||
        /[\r\n]/.test(normalizedKey)
      ) {
        throw new Error(
          "A valid idempotency key is required.",
        );
      }

      headers.set(
        "Idempotency-Key",
        normalizedKey,
      );
    }

    const requestSignal =
      createRequestSignal(
        externalSignal,
        timeoutMs,
      );

    try {
      const response = await fetch(
        buildApiUrl(
          path,
          query,
          this.baseUrl,
        ),
        {
          ...requestOptions,
          method,
          headers,
          credentials,
          cache: "no-store",
          signal: requestSignal.signal,
          ...(body !== undefined
            ? {
                body:
                  body instanceof FormData ||
                  body instanceof Blob ||
                  typeof body === "string"
                    ? body
                    : JSON.stringify(body),
              }
            : {}),
        },
      );

      const payload =
        await parseResponseBody(response);

      if (!response.ok) {
        const error = createHttpError(
          response,
          payload,
        );

        if (
          response.status === 401 &&
          !skipAuth
        ) {
          try {
            this.unauthorizedCallback();
          } catch {
            // Authentication notifications must not mask API errors.
          }
        }

        throw error;
      }

      return payload as TResponse;
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }

      if (requestSignal.didTimeout()) {
        throw new ApiError(
          "The request timed out. The server may still have processed the operation.",
          {
            category: "timeout",
            code: "REQUEST_TIMEOUT",
            details: error,
            retryable: true,
          },
        );
      }

      if (
        externalSignal?.aborted ||
        (
          error instanceof DOMException &&
          error.name === "AbortError"
        )
      ) {
        throw error;
      }

      if (
        error instanceof TypeError ||
        error instanceof DOMException
      ) {
        throw new ApiError(
          "Unable to reach the backend. Check the network connection.",
          {
            category: "network",
            code: "NETWORK_ERROR",
            details: error,
            retryable: true,
          },
        );
      }

      throw error;
    } finally {
      requestSignal.cleanup();
    }
  }

  get<TResponse>(
    path: string,
    options?: ApiRequestOptions,
  ): Promise<TResponse> {
    return this.request<TResponse>(
      "GET",
      path,
      undefined,
      options,
    );
  }

  post<TResponse>(
    path: string,
    body?: unknown,
    options?: ApiMutationOptions,
  ): Promise<TResponse> {
    return this.request<TResponse>(
      "POST",
      path,
      body,
      options,
    );
  }

  put<TResponse>(
    path: string,
    body?: unknown,
    options?: ApiMutationOptions,
  ): Promise<TResponse> {
    return this.request<TResponse>(
      "PUT",
      path,
      body,
      options,
    );
  }

  patch<TResponse>(
    path: string,
    body?: unknown,
    options?: ApiMutationOptions,
  ): Promise<TResponse> {
    return this.request<TResponse>(
      "PATCH",
      path,
      body,
      options,
    );
  }

  delete<TResponse = void>(
    path: string,
    options?: ApiRequestOptions,
  ): Promise<TResponse> {
    return this.request<TResponse>(
      "DELETE",
      path,
      undefined,
      options,
    );
  }
}

export const apiClient = new ApiClient();

export const api = apiClient;

export function getApiErrorMessage(
  error: unknown,
): string {
  if (error instanceof ApiError) {
    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "An unexpected error occurred.";
}
