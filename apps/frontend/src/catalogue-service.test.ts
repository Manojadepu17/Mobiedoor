import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api-client";
import {
  ApiTimeoutError,
  catalogueRetryCount,
  catalogueRetryDelay,
  fetchAllCatalogueProducts,
  readCatalogueInitialData,
} from "./catalogue-service";
import { catalogueCacheKey, readCatalogueCache, writeCatalogueCache } from "./catalogue-cache";
import { isValidCatalogueProduct } from "./catalogue-validation";
import { ALL_DEVICES_CATEGORY, type ShopFilters } from "./shop-state";
import type { Product } from "./main";

const filters: ShopFilters = {
  search: "",
  category: ALL_DEVICES_CATEGORY,
  sort: "Featured",
};
const cacheKey = "limit=50";
const queryClients: QueryClient[] = [];

function makeProduct(index: number): Product {
  return {
    id: `product-${index}`,
    name: `Phone model ${index}`,
    slug: `phone-model-${index}`,
    brand: "Example",
    model: `Model ${index}`,
    description: "A verified and tested device.",
    priceInPaise: 100_000,
    originalPriceInPaise: 120_000,
    condition: "EXCELLENT",
    category: "phones",
    stockQuantity: 3,
    imageUrls: ["/uploads/phone.jpg"],
  };
}

function pageResponse(data: Product[], page: number, total: number, overrides: Record<string, number> = {}) {
  const limit = overrides.limit ?? 50;
  const totalPages = overrides.totalPages ?? Math.ceil(total / limit);
  return new Response(JSON.stringify({
    data,
    meta: {
      page: overrides.page ?? page,
      limit,
      total: overrides.total ?? total,
      totalPages,
    },
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(status: number, retryAfter?: string) {
  return new Response(JSON.stringify({ error: { message: `Service returned ${status}.` } }), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...(retryAfter === undefined ? {} : { "Retry-After": retryAfter }),
    },
  });
}

function installBrowserStorage() {
  const values = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
  vi.stubGlobal("window", {
    localStorage,
    setTimeout: (callback: () => void, delay: number) => globalThis.setTimeout(callback, delay),
    clearTimeout: (timeout: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(timeout),
  });
  return values;
}

function cacheSnapshot(data: Product[]) {
  expect(writeCatalogueCache(cacheKey, data, isValidCatalogueProduct)).toBe(true);
}

function productPage(data: Product[]) {
  return pageResponse(data, 1, data.length);
}

async function flushPromises() {
  for (let attempt = 0; attempt < 10; attempt += 1) await Promise.resolve();
}

function createRetryRequest(queryKey: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClients.push(client);
  return client.fetchQuery({
    queryKey: ["catalogue-retry", queryKey],
    queryFn: () => fetchAllCatalogueProducts(filters),
    retry: catalogueRetryCount,
    retryDelay: catalogueRetryDelay,
  });
}

afterEach(() => {
  for (const client of queryClients.splice(0)) client.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("catalogue service network recovery", () => {
  it("keeps cached products and the original snapshot after an actual failed fetch", async () => {
    const storage = installBrowserStorage();
    const cachedProducts = [makeProduct(1)];
    cacheSnapshot(cachedProducts);
    const originalSnapshot = storage.get(catalogueCacheKey(cacheKey));
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new TypeError("Failed to fetch")));

    await expect(fetchAllCatalogueProducts(filters)).rejects.toThrow("Failed to fetch");

    expect(storage.get(catalogueCacheKey(cacheKey))).toBe(originalSnapshot);
    expect(readCatalogueInitialData(filters)?.data.data).toEqual(cachedProducts);
  });

  it("aborts a stalled fetch at the timeout and preserves cached products", async () => {
    vi.useFakeTimers();
    const storage = installBrowserStorage();
    const cachedProducts = [makeProduct(2)];
    cacheSnapshot(cachedProducts);
    const originalSnapshot = storage.get(catalogueCacheKey(cacheKey));
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    }));

    const pending = fetchAllCatalogueProducts(filters).catch(error => error);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(pending).resolves.toBeInstanceOf(ApiTimeoutError);

    expect(requestSignal?.aborted).toBe(true);
    expect(storage.get(catalogueCacheKey(cacheKey))).toBe(originalSnapshot);
    expect(readCatalogueInitialData(filters)?.data.data).toEqual(cachedProducts);
  });

  it.each([429, 502, 503, 504])("preserves cached products after actual HTTP %i", async status => {
    const storage = installBrowserStorage();
    const cachedProducts = [makeProduct(status)];
    cacheSnapshot(cachedProducts);
    const originalSnapshot = storage.get(catalogueCacheKey(cacheKey));
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(errorResponse(status, status === 429 ? "2" : undefined)));

    await expect(fetchAllCatalogueProducts(filters)).rejects.toMatchObject({ status });

    expect(storage.get(catalogueCacheKey(cacheKey))).toBe(originalSnapshot);
    expect(readCatalogueInitialData(filters)?.data.data).toEqual(cachedProducts);
  });
});

describe("catalogue pagination and cache snapshots", () => {
  it("fetches every page and replaces the cache only after the complete catalogue succeeds", async () => {
    const storage = installBrowserStorage();
    const products = Array.from({ length: 51 }, (_, index) => makeProduct(index));
    const requestedPages: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const page = Number(url.searchParams.get("page") ?? "1");
      requestedPages.push(page);
      return page === 1
        ? pageResponse(products.slice(0, 50), 1, products.length)
        : pageResponse(products.slice(50), 2, products.length);
    }));

    const result = await fetchAllCatalogueProducts(filters);

    expect(requestedPages).toEqual([1, 2]);
    expect(result.data).toEqual(products);
    expect(readCatalogueCache<Product>(cacheKey, isValidCatalogueProduct)?.data).toEqual(products);
    expect(storage.has(catalogueCacheKey(cacheKey))).toBe(true);
  });

  it("keeps the previous snapshot when a later page fails", async () => {
    const storage = installBrowserStorage();
    const cachedProducts = [makeProduct(80)];
    cacheSnapshot(cachedProducts);
    const originalSnapshot = storage.get(catalogueCacheKey(cacheKey));
    const firstPageProducts = Array.from({ length: 50 }, (_, index) => makeProduct(index));
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const page = new URL(String(input)).searchParams.get("page");
      return page === "2"
        ? errorResponse(503)
        : pageResponse(firstPageProducts, 1, 51);
    }));

    await expect(fetchAllCatalogueProducts(filters)).rejects.toMatchObject({ status: 503 });

    expect(storage.get(catalogueCacheKey(cacheKey))).toBe(originalSnapshot);
    expect(readCatalogueInitialData(filters)?.data.data).toEqual(cachedProducts);
  });

  it.each([
    { name: "duplicate product IDs", duplicate: (first: Product) => ({ ...makeProduct(51), id: first.id }) },
    { name: "duplicate product slugs", duplicate: (first: Product) => ({ ...makeProduct(51), slug: first.slug }) },
  ])("rejects $name without replacing the snapshot", async ({ duplicate }) => {
    const storage = installBrowserStorage();
    const cachedProducts = [makeProduct(90)];
    cacheSnapshot(cachedProducts);
    const originalSnapshot = storage.get(catalogueCacheKey(cacheKey));
    const firstPageProducts = Array.from({ length: 50 }, (_, index) => makeProduct(index));
    const secondPageProduct = duplicate(firstPageProducts[0]);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const page = new URL(String(input)).searchParams.get("page");
      return page === "2"
        ? pageResponse([secondPageProduct], 2, 51)
        : pageResponse(firstPageProducts, 1, 51);
    }));

    await expect(fetchAllCatalogueProducts(filters)).rejects.toMatchObject({ status: 502 });

    expect(storage.get(catalogueCacheKey(cacheKey))).toBe(originalSnapshot);
    expect(readCatalogueInitialData(filters)?.data.data).toEqual(cachedProducts);
  });

  it("rejects inconsistent page metadata and preserves the old cache snapshot", async () => {
    const storage = installBrowserStorage();
    const cachedProducts = [makeProduct(91)];
    cacheSnapshot(cachedProducts);
    const originalSnapshot = storage.get(catalogueCacheKey(cacheKey));
    const firstPageProducts = Array.from({ length: 50 }, (_, index) => makeProduct(index));
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const page = new URL(String(input)).searchParams.get("page");
      return page === "2"
        ? pageResponse([makeProduct(51), makeProduct(52)], 2, 52)
        : pageResponse(firstPageProducts, 1, 51);
    }));

    await expect(fetchAllCatalogueProducts(filters)).rejects.toMatchObject({ status: 502 });

    expect(storage.get(catalogueCacheKey(cacheKey))).toBe(originalSnapshot);
  });

  it("replaces a snapshot only after valid complete data and preserves it for invalid or incomplete responses", async () => {
    const storage = installBrowserStorage();
    const oldProducts = [makeProduct(92)];
    cacheSnapshot(oldProducts);
    const originalSnapshot = storage.get(catalogueCacheKey(cacheKey));
    const invalidProduct = { ...makeProduct(93), imageUrls: ["javascript:alert(1)"] } as Product;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(productPage([invalidProduct])));

    await expect(fetchAllCatalogueProducts(filters)).rejects.toMatchObject({ status: 502 });
    expect(storage.get(catalogueCacheKey(cacheKey))).toBe(originalSnapshot);

    const incompleteProducts = Array.from({ length: 49 }, (_, index) => makeProduct(index));
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(pageResponse(incompleteProducts, 1, 51)));
    await expect(fetchAllCatalogueProducts(filters)).rejects.toMatchObject({ status: 502 });
    expect(storage.get(catalogueCacheKey(cacheKey))).toBe(originalSnapshot);

    const newProducts = [makeProduct(94)];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(productPage(newProducts)));
    await expect(fetchAllCatalogueProducts(filters)).resolves.toMatchObject({ data: newProducts });
    expect(readCatalogueCache<Product>(cacheKey, isValidCatalogueProduct)?.data).toEqual(newProducts);
  });
});

describe("catalogue React Query retry behavior", () => {
  it("keeps cached products in the active query result when revalidation fails", async () => {
    vi.useFakeTimers();
    installBrowserStorage();
    const cachedProducts = [makeProduct(99)];
    cacheSnapshot(cachedProducts);
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("Network unavailable"));
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClients.push(client);
    const observer = new QueryObserver(client, {
      queryKey: ["catalogue-cache-revalidation"],
      queryFn: () => fetchAllCatalogueProducts(filters),
      initialData: readCatalogueInitialData(filters)?.data,
      retry: catalogueRetryCount,
      retryDelay: catalogueRetryDelay,
    });

    expect(observer.getCurrentResult().data?.data).toEqual(cachedProducts);
    const pending = observer.refetch();
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(observer.getCurrentResult().data?.data).toEqual(cachedProducts);

    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result.isError).toBe(true);
    expect(result.data?.data).toEqual(cachedProducts);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("respects the Retry-After delay from an actual HTTP 429 response", async () => {
    vi.useFakeTimers();
    installBrowserStorage();
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(errorResponse(429, "2"))
      .mockResolvedValueOnce(productPage([makeProduct(100)]));
    vi.stubGlobal("fetch", fetchMock);
    const pending = createRetryRequest("retry-after");
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ data: [makeProduct(100)] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([502, 503, 504])("retries HTTP %i with the configured catalogue policy", async status => {
    vi.useFakeTimers();
    installBrowserStorage();
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(errorResponse(status))
      .mockResolvedValueOnce(productPage([makeProduct(status)]));
    vi.stubGlobal("fetch", fetchMock);
    const pending = createRetryRequest(`retry-${status}`);
    await flushPromises();
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toMatchObject({ data: [makeProduct(status)] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("caps retries at two retries and does not retry ordinary client errors", async () => {
    vi.useFakeTimers();
    installBrowserStorage();
    const repeatedFailure = vi.fn<typeof fetch>().mockResolvedValue(errorResponse(503));
    vi.stubGlobal("fetch", repeatedFailure);
    const boundedRequest = createRetryRequest("bounded").catch(error => error);
    await flushPromises();
    await vi.runAllTimersAsync();
    await expect(boundedRequest).resolves.toBeInstanceOf(ApiError);
    expect(repeatedFailure).toHaveBeenCalledTimes(3);

    const clientError = vi.fn<typeof fetch>().mockResolvedValue(errorResponse(404));
    vi.stubGlobal("fetch", clientError);
    const noRetryRequest = createRetryRequest("client-error").catch(error => error);
    await flushPromises();
    await expect(noRetryRequest).resolves.toBeInstanceOf(ApiError);
    expect(clientError).toHaveBeenCalledTimes(1);
    expect(catalogueRetryCount(2, new ApiError("Busy", 503))).toBe(false);
  });
});
