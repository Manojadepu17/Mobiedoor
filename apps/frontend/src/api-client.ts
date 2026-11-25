export type ApiEnvelope<T> = {
  data: T;
  meta?: { page: number; limit: number; total: number; totalPages: number };
  message?: string;
  error?: { code?: string; message?: string };
};

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly retryAfterSeconds?: number) {
    super(message);
    this.name = "ApiError";
  }
}

export function getApiErrorStatus(error: unknown) {
  if (error instanceof ApiError) return error.status;
  return typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
    ? error.status
    : undefined;
}

export function describeApiError(error: unknown) {
  const status = getApiErrorStatus(error);
  const message = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
        ? error.message
        : "No additional request details were provided.";
  return `${status === undefined ? "" : `HTTP ${status}: `}${message}`;
}

const configuredApiUrl = import.meta.env.VITE_API_URL?.trim();
if (import.meta.env.PROD && configuredApiUrl !== "/api") {
  throw new Error('VITE_API_URL must be exactly "/api" in production.');
}
const API_URL = (configuredApiUrl ?? "http://localhost:4000").replace(/\/+$/, "");

function apiRequestUrl(path: string) {
  const normalizedPath = `/${path.replace(/^\/+/, "")}`;
  const baseHasApiPrefix = API_URL === "/api" || API_URL.endsWith("/api");
  const requestPath = baseHasApiPrefix && (normalizedPath === "/api" || normalizedPath.startsWith("/api/"))
    ? normalizedPath.slice(4) || "/"
    : normalizedPath;
  return `${API_URL}${requestPath}`;
}

export async function apiRequest<T>(path: string, options?: RequestInit): Promise<ApiEnvelope<T>> {
  const isFormData = options?.body instanceof FormData;
  const requestUrl = apiRequestUrl(path);
  const method = (options?.method ?? "GET").toUpperCase();
  const requestKey = `${method}:${requestUrl}:${isFormData ? "form" : typeof options?.body === "string" ? options.body : ""}`;
  const sharedGetRequests = apiRequest as typeof apiRequest & { getRequests?: Map<string, Promise<Response>> };
  sharedGetRequests.getRequests ??= new Map();
  let response: Response;
  if (method === "GET" && sharedGetRequests.getRequests.has(requestKey)) {
    response = (await sharedGetRequests.getRequests.get(requestKey)!).clone();
  } else {
    const request = fetch(requestUrl, {
      ...options,
      credentials: "include",
      headers: { ...(isFormData ? {} : { "Content-Type": "application/json" }), ...(options?.headers ?? {}) },
    });
    if (method === "GET") {
      sharedGetRequests.getRequests.set(requestKey, request);
      void request.finally(() => sharedGetRequests.getRequests?.delete(requestKey)).catch(() => undefined);
    }
    response = await request;
  }
  if (response.status === 204) return { data: null as T };
  let body: ApiEnvelope<T> & { error?: { message?: string } };
  try {
    body = await response.json() as ApiEnvelope<T> & { error?: { message?: string } };
  } catch (error) {
    if (options?.signal?.aborted) throw error;
    if (!response.ok) throw new ApiError(`The API request failed with HTTP ${response.status}.`, response.status);
    throw new ApiError("The API returned an invalid response.", response.status);
  }
  if (!response.ok) {
    const retryAfterHeader = response.headers.get("Retry-After");
    const retryAfterSeconds = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : undefined;
    throw new ApiError(
      body.error?.message ?? "The request could not be completed.",
      response.status,
      body.error?.code,
      Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
    );
  }
  return body;
}
