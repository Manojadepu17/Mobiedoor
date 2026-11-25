import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRequest, ApiError } from "./api-client";
import {
  AUTH_USER_QUERY_KEY,
  authenticationErrorMessage,
  clearAuthenticatedQueryCache,
  clearPrivateDataAfterUnauthorized,
  resolveAuthQueryState,
  runAuthSubmission,
} from "./auth-reliability";

const user = { id: "customer-1", name: "Test Customer", email: "customer@example.test", role: "CUSTOMER" };

function apiFailure(status: number, message: string) {
  return new Response(JSON.stringify({ error: { code: "SERVICE_UNAVAILABLE", message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function captureApiError(path: string, method = "POST") {
  try {
    await apiRequest(path, { method, body: method === "GET" ? undefined : JSON.stringify({ email: user.email }) });
  } catch (error) {
    return error;
  }
  throw new Error("Expected the API request to fail.");
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("authentication error handling", () => {
  it("uses a sign-in-specific message for an actual HTTP 503", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(apiFailure(503, "The live catalogue service is temporarily unavailable.")));

    const error = await captureApiError("/auth/login");

    expect(error).toBeInstanceOf(ApiError);
    expect(authenticationErrorMessage(error, "login")).toBe("The sign-in service is temporarily unavailable. Please try again shortly.");
    expect(authenticationErrorMessage(error, "login")).not.toContain("catalogue");
  });

  it("uses an account-creation-specific message for an actual HTTP 503", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(apiFailure(503, "The live catalogue service is temporarily unavailable.")));

    const error = await captureApiError("/auth/register");

    expect(error).toBeInstanceOf(ApiError);
    expect(authenticationErrorMessage(error, "registration")).toContain("Account creation is temporarily unavailable.");
    expect(authenticationErrorMessage(error, "registration")).not.toContain("catalogue");
  });

  it("preserves the existing login 401 and registration 409 messages", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(apiFailure(401, "Email or password is incorrect."))
      .mockResolvedValueOnce(apiFailure(409, "An account with that email already exists.")));

    const loginError = await captureApiError("/auth/login");
    const registrationError = await captureApiError("/auth/register");

    expect(authenticationErrorMessage(loginError, "login")).toBe("Email or password is incorrect.");
    expect(authenticationErrorMessage(registrationError, "registration")).toBe("An account with that email already exists.");
  });

  it("reports failed fetches without exposing low-level browser error text", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    const loginError = await captureApiError("/auth/login");
    const registrationError = await captureApiError("/auth/register");

    expect(authenticationErrorMessage(loginError, "login"))
      .toBe("Could not reach the sign-in service. Check your connection and try again.");
    expect(authenticationErrorMessage(registrationError, "registration"))
      .toContain("Could not reach the account service.");
  });
});

describe("authentication query state and cache", () => {
  it("coalesces repeated concurrent /auth/me requests and sends session cookies", async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      new Promise<Response>(resolve => { resolveFetch = resolve; }));
    vi.stubGlobal("fetch", fetchMock);

    const first = apiRequest<typeof user>("/auth/me", { method: "GET" });
    const second = apiRequest<typeof user>("/auth/me", { method: "GET" });
    expect(fetchMock).toHaveBeenCalledOnce();

    resolveFetch(new Response(JSON.stringify({ data: user }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.data).toEqual(user);
    expect(secondResult.data).toEqual(user);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: "include" });
  });

  it("does not automatically retry a failed login POST request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(apiFailure(503, "Temporary authentication failure."));
    vi.stubGlobal("fetch", fetchMock);

    const error = await captureApiError("/auth/login");

    expect(error).toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each(["/auth/login", "/auth/register"])("%s times out and releases the pending request", async path => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Request aborted.", "AbortError")), { once: true });
      }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = apiRequest(path, { method: "POST", body: "{}" }).then(
      () => undefined,
      error => error,
    );
    await vi.advanceTimersByTimeAsync(30_000);
    const error = await pending;

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 408 });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it("preserves caller cancellation instead of reporting it as a timeout", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Request aborted.", "AbortError")), { once: true });
      }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = apiRequest("/auth/login", { method: "POST", body: "{}", signal: controller.signal }).then(
      () => undefined,
      error => error,
    );
    controller.abort();
    const error = await pending;

    expect(error).toBeInstanceOf(DOMException);
    expect(error).toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps a previously verified user authenticated when /auth/me temporarily fails", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(AUTH_USER_QUERY_KEY, user);
    queryClient.setQueryData(["products", "phones"], [{ id: "product-1" }]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(apiFailure(503, "Temporary backend failure.")));

    const error = await queryClient.fetchQuery({
      queryKey: AUTH_USER_QUERY_KEY,
      queryFn: () => apiRequest("/auth/me", { method: "GET" }).then(result => result.data),
      retry: false,
    }).then(() => undefined, requestError => requestError);
    const queryState = queryClient.getQueryState(AUTH_USER_QUERY_KEY);
    const state = resolveAuthQueryState({
      data: queryClient.getQueryData<typeof user>(AUTH_USER_QUERY_KEY),
      error: queryState?.error ?? error,
      isError: queryState?.status === "error",
      isLoading: queryState?.status === "pending",
    });

    expect(state).toEqual({ status: "authenticated", user, verificationFailed: true });
    expect(queryClient.getQueryData(AUTH_USER_QUERY_KEY)).toEqual(user);
    expect(queryClient.getQueryData(["products", "phones"])).toEqual([{ id: "product-1" }]);
    queryClient.clear();
  });

  it("does not mistake an initial temporary /auth/me failure for a confirmed logout", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(apiFailure(503, "Temporary backend failure.")));

    const error = await captureApiError("/auth/me", "GET");

    expect(resolveAuthQueryState({ data: undefined, error, isError: true, isLoading: false }))
      .toEqual({ status: "unavailable" });
  });

  it("treats an actual HTTP 401 as unauthenticated, separately from a temporary failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(apiFailure(401, "Authentication is required.")));

    const error = await captureApiError("/auth/me", "GET");

    expect(resolveAuthQueryState({ data: user, error, isError: true, isLoading: false }))
      .toEqual({ status: "unauthenticated" });
  });

  it("clears private auth data without clearing cached catalogue data", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(AUTH_USER_QUERY_KEY, user);
    queryClient.setQueryData(["admin-dashboard"], { totalProducts: 4 });
    queryClient.setQueryData(["products", "phones"], [{ id: "product-1" }]);
    queryClient.setQueryData(["home-catalogue"], [{ id: "product-2" }]);

    clearAuthenticatedQueryCache(queryClient);

    expect(queryClient.getQueryData(AUTH_USER_QUERY_KEY)).toBeUndefined();
    expect(queryClient.getQueryData(["admin-dashboard"])).toBeUndefined();
    expect(queryClient.getQueryData(["products", "phones"])).toEqual([{ id: "product-1" }]);
    expect(queryClient.getQueryData(["home-catalogue"])).toEqual([{ id: "product-2" }]);
    queryClient.clear();
  });

  it("preserves private and catalogue data after a temporary authentication failure", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(AUTH_USER_QUERY_KEY, user);
    queryClient.setQueryData(["admin-dashboard"], { totalProducts: 4 });
    queryClient.setQueryData(["products", "phones"], [{ id: "product-1" }]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(apiFailure(503, "Temporary backend failure.")));
    const error = await captureApiError("/auth/me", "GET");

    expect(clearPrivateDataAfterUnauthorized(error, queryClient)).toBe(false);
    expect(queryClient.getQueryData(AUTH_USER_QUERY_KEY)).toEqual(user);
    expect(queryClient.getQueryData(["admin-dashboard"])).toEqual({ totalProducts: 4 });
    expect(queryClient.getQueryData(["products", "phones"])).toEqual([{ id: "product-1" }]);
    queryClient.clear();
  });

  it("clears stale auth identity and admin data after confirmed unauthorized access but preserves the catalogue", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(AUTH_USER_QUERY_KEY, user);
    queryClient.setQueryData(["admin-dashboard"], { totalProducts: 4 });
    queryClient.setQueryData(["inventory-history", "product-1"], [{ id: "adjustment-1" }]);
    queryClient.setQueryData(["products", "phones"], [{ id: "product-1" }]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(apiFailure(401, "Authentication is required.")));
    const error = await captureApiError("/auth/me", "GET");

    expect(clearPrivateDataAfterUnauthorized(error, queryClient)).toBe(true);

    expect(queryClient.getQueryData(AUTH_USER_QUERY_KEY)).toBeUndefined();
    expect(queryClient.getQueryData(["admin-dashboard"])).toBeUndefined();
    expect(queryClient.getQueryData(["inventory-history", "product-1"])).toBeUndefined();
    expect(queryClient.getQueryData(["products", "phones"])).toEqual([{ id: "product-1" }]);
    queryClient.clear();
  });
});

describe("authentication submission protection", () => {
  it.each(["login", "registration"])("%s allows a later submission after success", async flow => {
    const lock = { current: false };
    let resolveRequest!: (value: string) => void;
    const submit = vi.fn(() => new Promise<string>(resolve => { resolveRequest = resolve; }));

    const firstSubmission = runAuthSubmission(lock, submit);
    expect(lock.current).toBe(true);
    expect(await runAuthSubmission(lock, submit)).toEqual({ started: false });
    expect(submit).toHaveBeenCalledOnce();

    resolveRequest(`${flow}-success`);
    await expect(firstSubmission).resolves.toEqual({ started: true, value: `${flow}-success` });
    expect(lock.current).toBe(false);
    await expect(runAuthSubmission(lock, async () => `${flow}-again`))
      .resolves.toEqual({ started: true, value: `${flow}-again` });
  });

  it.each(["login", "registration"])("%s allows a later submission after failure", async flow => {
    const lock = { current: false };
    const failure = new Error(`${flow} failed`);
    const submit = vi.fn().mockRejectedValueOnce(failure);

    await expect(runAuthSubmission(lock, submit)).rejects.toBe(failure);
    expect(lock.current).toBe(false);
    await expect(runAuthSubmission(lock, async () => `${flow}-again`))
      .resolves.toEqual({ started: true, value: `${flow}-again` });
  });
});
