import { ApiError, apiRequest, getApiErrorStatus, type ApiEnvelope } from "./api-client";
import { readCatalogueCache, writeCatalogueCache } from "./catalogue-cache";
import {
  catalogueRetryCount as shouldRetryCatalogue,
  catalogueRetryDelay as getCatalogueRetryDelay,
  isValidCatalogueProduct,
  validateCatalogueEnvelope,
} from "./catalogue-validation";
import { productsQuery, type ShopFilters } from "./shop-state";
import type { Product } from "./main";

export class ApiTimeoutError extends Error {
  constructor() {
    super("The catalogue request timed out.");
    this.name = "ApiTimeoutError";
  }
}

function isCachedProduct(value: unknown): value is Product {
  return isValidCatalogueProduct(value);
}

export function catalogueRetryCount(failureCount: number, error: unknown) {
  const status = getApiErrorStatus(error);
  return shouldRetryCatalogue(
    failureCount,
    status,
    error instanceof TypeError || error instanceof ApiTimeoutError,
  );
}

export function catalogueRetryDelay(attempt: number, error: unknown) {
  const retryAfter = error instanceof ApiError ? error.retryAfterSeconds : undefined;
  return getCatalogueRetryDelay(attempt, retryAfter);
}

export function readCatalogueInitialData(filters: ShopFilters) {
  const query = productsQuery(filters);
  query.set("limit", "50");
  const snapshot = readCatalogueCache<Product>(query.toString(), isCachedProduct);
  return snapshot
    ? { data: { data: snapshot.data } as ApiEnvelope<Product[]>, createdAt: snapshot.createdAt }
    : undefined;
}

export async function fetchAllCatalogueProducts(filters: ShopFilters, signal?: AbortSignal) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 30_000);
  const abortRequest = () => controller.abort();
  if (signal?.aborted) abortRequest();
  else signal?.addEventListener("abort", abortRequest, { once: true });

  try {
    const query = productsQuery(filters);
    query.set("limit", "50");
    const firstResponse = await apiRequest<Product[]>(`/products?${query}`, { signal: controller.signal });
    const firstPage = validateCatalogueEnvelope(firstResponse);
    if (!firstPage) {
      throw new ApiError("The API returned an invalid catalogue response.", 502);
    }
    const { total, limit, totalPages, page } = firstPage.meta;
    if (page !== 1) throw new ApiError("The API returned inconsistent pagination metadata.", 502);
    const allData = [...firstPage.data] as Product[];
    for (let page = 2; page <= totalPages; page += 1) {
      const pageQuery = new URLSearchParams(query);
      pageQuery.set("page", String(page));
      const nextResponse = await apiRequest<Product[]>(`/products?${pageQuery}`, { signal: controller.signal });
      const nextPage = validateCatalogueEnvelope(nextResponse);
      if (!nextPage) {
        throw new ApiError("The API returned an invalid catalogue response.", 502);
      }
      if (nextPage.meta.page !== page
        || nextPage.meta.limit !== limit
        || nextPage.meta.total !== total
        || nextPage.meta.totalPages !== totalPages) {
        throw new ApiError("The API returned inconsistent pagination metadata.", 502);
      }
      allData.push(...nextPage.data as Product[]);
    }
    const uniqueIds = new Set(allData.map(product => product.id));
    const uniqueSlugs = new Set(allData.map(product => product.slug));
    if (uniqueIds.size !== allData.length || uniqueSlugs.size !== allData.length) {
      throw new ApiError("The API returned duplicate catalogue records.", 502);
    }
    if (allData.length !== total) {
      throw new ApiError("The API returned an incomplete catalogue response.", 502);
    }
    const result = {
      ...firstPage,
      data: allData,
    };
    writeCatalogueCache(query.toString(), allData, isCachedProduct);
    return result;
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) throw new ApiTimeoutError();
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
    signal?.removeEventListener("abort", abortRequest);
  }
}
