export const CATALOGUE_CACHE_KEY_PREFIX = "mobiedoor.catalogue.v1:";
export const CATALOGUE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const CATALOGUE_CACHE_MAX_ITEMS = 2000;

export type CatalogueCacheEnvelope<T> = {
  version: 1;
  createdAt: number;
  expiresAt: number;
  data: T[];
};

function storage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function catalogueCacheKey(query: string) {
  return `${CATALOGUE_CACHE_KEY_PREFIX}${query}`;
}

export function readCatalogueCache<T>(
  query: string,
  isValidItem: (value: unknown) => value is T,
): CatalogueCacheEnvelope<T> | undefined {
  const cache = storage();
  if (!cache) return undefined;
  const key = catalogueCacheKey(query);
  try {
    const raw = cache.getItem(key);
    if (!raw) return undefined;
    const value = JSON.parse(raw) as Partial<CatalogueCacheEnvelope<unknown>>;
    if (
      value.version !== 1
      || !Array.isArray(value.data)
      || typeof value.createdAt !== "number"
      || typeof value.expiresAt !== "number"
      || !Number.isFinite(value.createdAt)
      || !Number.isFinite(value.expiresAt)
      || value.createdAt > value.expiresAt
      || value.expiresAt <= Date.now()
      || value.data.length > CATALOGUE_CACHE_MAX_ITEMS
      || !value.data.every(isValidItem)
    ) {
      cache.removeItem(key);
      return undefined;
    }
    return value as CatalogueCacheEnvelope<T>;
  } catch {
    try {
      cache.removeItem(key);
    } catch {
      // Storage remains unavailable or read-only.
    }
    return undefined;
  }
}

export function writeCatalogueCache<T>(
  query: string,
  data: T[],
  isValidItem: (value: unknown) => value is T,
): boolean {
  if (data.length > CATALOGUE_CACHE_MAX_ITEMS || !data.every(isValidItem)) return false;
  const cache = storage();
  if (!cache) return false;
  const now = Date.now();
  const snapshot: CatalogueCacheEnvelope<T> = {
    version: 1,
    createdAt: now,
    expiresAt: now + CATALOGUE_CACHE_TTL_MS,
    data,
  };
  try {
    cache.setItem(catalogueCacheKey(query), JSON.stringify(snapshot));
    return true;
  } catch {
    return false;
  }
}
