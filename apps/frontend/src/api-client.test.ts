import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "./api-client";

function apiResponse(data: unknown) {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("deduplicated GET requests", () => {
  it("shares one in-flight request and clones its response for each caller", async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>(resolve => { resolveFetch = resolve; }));
    vi.stubGlobal("fetch", fetchMock);

    const first = apiRequest<{ value: string }>("/shared");
    const second = apiRequest<{ value: string }>("/shared");
    expect(fetchMock).toHaveBeenCalledOnce();

    resolveFetch(apiResponse({ value: "shared response" }));
    await expect(Promise.all([first, second])).resolves.toEqual([
      { data: { value: "shared response" } },
      { data: { value: "shared response" } },
    ]);
  });

  it("keeps the shared request active when the first caller cancels", async () => {
    let resolveFetch!: (response: Response) => void;
    let sharedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_input: RequestInfo | URL, options?: RequestInit) => {
      sharedSignal = options?.signal ?? undefined;
      return new Promise<Response>((resolve, reject) => {
        sharedSignal?.addEventListener("abort", () => reject(sharedSignal?.reason), { once: true });
        resolveFetch = resolve;
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = apiRequest("/shared", { signal: firstController.signal }).then(
      () => undefined,
      error => error,
    );
    const second = apiRequest<{ value: string }>("/shared", { signal: secondController.signal });
    firstController.abort();

    expect(await first).toMatchObject({ name: "AbortError" });
    expect(sharedSignal?.aborted).toBe(false);
    resolveFetch(apiResponse({ value: "still active" }));
    await expect(second).resolves.toMatchObject({ data: { value: "still active" } });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps the shared request active when the second caller cancels independently", async () => {
    let resolveFetch!: (response: Response) => void;
    let sharedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_input: RequestInfo | URL, options?: RequestInit) => {
      sharedSignal = options?.signal ?? undefined;
      return new Promise<Response>((resolve, reject) => {
        sharedSignal?.addEventListener("abort", () => reject(sharedSignal?.reason), { once: true });
        resolveFetch = resolve;
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = apiRequest<{ value: string }>("/shared", { signal: firstController.signal });
    const second = apiRequest("/shared", { signal: secondController.signal }).then(
      () => undefined,
      error => error,
    );
    secondController.abort();

    expect(await second).toMatchObject({ name: "AbortError" });
    expect(sharedSignal?.aborted).toBe(false);
    resolveFetch(apiResponse({ value: "first remains active" }));
    await expect(first).resolves.toMatchObject({ data: { value: "first remains active" } });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("aborts shared network work when all callers cancel and allows a later request", async () => {
    let sharedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_input: RequestInfo | URL, options?: RequestInit) => {
      if (fetchMock.mock.calls.length > 1) return Promise.resolve(apiResponse({ value: "recovered" }));
      sharedSignal = options?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        sharedSignal?.addEventListener("abort", () => reject(sharedSignal?.reason), { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = apiRequest("/shared", { signal: firstController.signal }).then(
      () => undefined,
      error => error,
    );
    const second = apiRequest("/shared", { signal: secondController.signal }).then(
      () => undefined,
      error => error,
    );
    firstController.abort();
    secondController.abort();

    expect(await first).toMatchObject({ name: "AbortError" });
    expect(await second).toMatchObject({ name: "AbortError" });
    expect(sharedSignal?.aborted).toBe(true);

    await expect(apiRequest("/shared")).resolves.toMatchObject({ data: { value: "recovered" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("cleans up after network failure so a subsequent request can succeed", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("Network unavailable"))
      .mockResolvedValueOnce(apiResponse({ value: "recovered" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiRequest("/recover")).rejects.toThrow("Network unavailable");
    await expect(apiRequest("/recover")).resolves.toMatchObject({ data: { value: "recovered" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("cleans up after a caller timeout so a subsequent request can succeed", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_input: RequestInfo | URL, options?: RequestInit) => {
      if (fetchMock.mock.calls.length > 1) return Promise.resolve(apiResponse({ value: "recovered" }));
      return new Promise<Response>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    const pending = apiRequest("/timeout", { signal: controller.signal }).then(
      () => undefined,
      error => error,
    );

    await vi.advanceTimersByTimeAsync(30_000);
    clearTimeout(timeout);
    expect(await pending).toMatchObject({ name: "AbortError" });
    await expect(apiRequest("/timeout")).resolves.toMatchObject({ data: { value: "recovered" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
