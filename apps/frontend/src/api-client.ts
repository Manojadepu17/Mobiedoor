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

type SharedGetRequest = {
  controller: AbortController;
  activeCallers: number;
  settled: boolean;
  promise: Promise<Response>;
};

const sharedGetRequests = new Map<string, SharedGetRequest>();

function apiRequestUrl(path: string) {
  const normalizedPath = `/${path.replace(/^\/+/, "")}`;
  const baseHasApiPrefix = API_URL === "/api" || API_URL.endsWith("/api");
  const requestPath = baseHasApiPrefix && (normalizedPath === "/api" || normalizedPath.startsWith("/api/"))
    ? normalizedPath.slice(4) || "/"
    : normalizedPath;
  return `${API_URL}${requestPath}`;
}

function getAbortReason(signal: AbortSignal) {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function fetchWithAbortSignal(requestUrl: string, options: RequestInit, signal: AbortSignal) {
  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const finish = (result: { ok: true; response: Response } | { ok: false; error: unknown }) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (result.ok) resolve(result.response);
      else reject(result.error);
    };
    const onAbort = () => finish({ ok: false, error: getAbortReason(signal) });

    if (signal.aborted) {
      onAbort();
      return;
    }

    signal.addEventListener("abort", onAbort, { once: true });
    let request: Promise<Response>;
    try {
      request = fetch(requestUrl, options);
    } catch (error) {
      finish({ ok: false, error });
      return;
    }
    void request.then(
      response => finish({ ok: true, response }),
      error => finish({ ok: false, error }),
    );
  });
}

function requestSharedGet(
  requestKey: string,
  requestUrl: string,
  options: RequestInit,
  callerSignal?: AbortSignal | null,
) {
  if (callerSignal?.aborted) return Promise.reject(getAbortReason(callerSignal));

  let sharedRequest = sharedGetRequests.get(requestKey);
  if (!sharedRequest) {
    const controller = new AbortController();
    const request: SharedGetRequest = {
      controller,
      activeCallers: 0,
      settled: false,
      promise: fetchWithAbortSignal(
        requestUrl,
        { ...options, signal: controller.signal },
        controller.signal,
      ),
    };
    request.promise = request.promise.then(
      response => {
        request.settled = true;
        return response;
      },
      error => {
        request.settled = true;
        throw error;
      },
    ).finally(() => {
      if (sharedGetRequests.get(requestKey) === request) sharedGetRequests.delete(requestKey);
    });
    sharedRequest = request;
    sharedGetRequests.set(requestKey, sharedRequest);
  }

  const activeRequest = sharedRequest;
  activeRequest.activeCallers += 1;
  return new Promise<Response>((resolve, reject) => {
    let released = false;
    const release = () => {
      if (released) return false;
      released = true;
      callerSignal?.removeEventListener("abort", onAbort);
      activeRequest.activeCallers -= 1;
      if (activeRequest.activeCallers === 0 && !activeRequest.settled) {
        if (sharedGetRequests.get(requestKey) === activeRequest) sharedGetRequests.delete(requestKey);
        activeRequest.controller.abort();
      }
      return true;
    };
    const onAbort = () => {
      if (callerSignal && release()) reject(getAbortReason(callerSignal));
    };

    callerSignal?.addEventListener("abort", onAbort, { once: true });
    if (callerSignal?.aborted) {
      onAbort();
      return;
    }
    activeRequest.promise.then(
      response => {
        if (!release()) return;
        try {
          resolve(response.clone());
        } catch (error) {
          reject(error);
        }
      },
      error => {
        if (release()) reject(error);
      },
    );
  });
}

export async function apiRequest<T>(path: string, options?: RequestInit): Promise<ApiEnvelope<T>> {
  const isFormData = options?.body instanceof FormData;
  const requestUrl = apiRequestUrl(path);
  const method = (options?.method ?? "GET").toUpperCase();
  const normalizedPath = `/${path.replace(/^\/+/, "")}`;
  const isAuthSubmission = method === "POST" && (normalizedPath === "/auth/login" || normalizedPath === "/auth/register");
  const timeoutController = isAuthSubmission ? new AbortController() : undefined;
  const forwardCallerAbort = () => timeoutController?.abort(options?.signal?.reason);
  if (timeoutController && options?.signal?.aborted) forwardCallerAbort();
  else if (timeoutController && options?.signal) options.signal.addEventListener("abort", forwardCallerAbort, { once: true });
  const timeoutId = timeoutController ? setTimeout(() => timeoutController.abort(), 30_000) : undefined;
  const requestKey = `${method}:${requestUrl}:${isFormData ? "form" : typeof options?.body === "string" ? options.body : ""}`;
  try {
    let response: Response;
    const requestOptions = {
      ...options,
      credentials: "include" as const,
      headers: { ...(isFormData ? {} : { "Content-Type": "application/json" }), ...(options?.headers ?? {}) },
      ...(timeoutController ? { signal: timeoutController.signal } : {}),
    };
    response = method === "GET"
      ? await requestSharedGet(requestKey, requestUrl, requestOptions, options?.signal)
      : await fetch(requestUrl, requestOptions);
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
  } catch (error) {
    if (timeoutController?.signal.aborted && !options?.signal?.aborted) {
      throw new ApiError("The authentication request timed out. Please try again.", 408);
    }
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    options?.signal?.removeEventListener("abort", forwardCallerAbort);
  }
}
