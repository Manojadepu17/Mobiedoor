import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CATALOGUE_CACHE_KEY_PREFIX,
  catalogueCacheKey,
  readCatalogueCache,
  writeCatalogueCache,
} from "./catalogue-cache";

type TestProduct = { id: string; name: string };

const isTestProduct = (value: unknown): value is TestProduct =>
  typeof value === "object"
  && value !== null
  && typeof (value as TestProduct).id === "string"
  && typeof (value as TestProduct).name === "string";

function installStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const storage = {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => { values.delete(key); },
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
  vi.stubGlobal("window", { localStorage: storage });
  return values;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("catalogue cache", () => {
  it("stores and restores a versioned valid snapshot", () => {
    installStorage();
    expect(writeCatalogueCache("limit=50", [{ id: "1", name: "Phone" }], isTestProduct)).toBe(true);
    const snapshot = readCatalogueCache<TestProduct>("limit=50", isTestProduct);
    expect(snapshot?.version).toBe(1);
    expect(snapshot?.data).toEqual([{ id: "1", name: "Phone" }]);
  });

  it("replaces a fresh valid snapshot while preserving the old snapshot until success", () => {
    installStorage();
    expect(writeCatalogueCache("limit=50", [{ id: "1", name: "Old Phone" }], isTestProduct)).toBe(true);
    expect(writeCatalogueCache("limit=50", [{ id: "2", name: "New Phone" }], isTestProduct)).toBe(true);
    expect(readCatalogueCache<TestProduct>("limit=50", isTestProduct)?.data)
      .toEqual([{ id: "2", name: "New Phone" }]);
  });

  it("leaves a valid snapshot unchanged when an invalid value is rejected", () => {
    installStorage();
    expect(writeCatalogueCache("limit=50", [{ id: "1", name: "Old Phone" }], isTestProduct)).toBe(true);
    expect(writeCatalogueCache("limit=50", [{ id: 2, name: "Invalid" }] as unknown as TestProduct[], isTestProduct)).toBe(false);
    expect(readCatalogueCache<TestProduct>("limit=50", isTestProduct)?.data)
      .toEqual([{ id: "1", name: "Old Phone" }]);
  });

  it("does not restore expired or corrupted snapshots", () => {
    const key = catalogueCacheKey("limit=50");
    installStorage({
      [key]: JSON.stringify({ version: 1, createdAt: 1, expiresAt: 1, data: [] }),
    });
    expect(readCatalogueCache<TestProduct>("limit=50", isTestProduct)).toBeUndefined();

    const values = installStorage({ [key]: "{corrupt" });
    expect(readCatalogueCache<TestProduct>("limit=50", isTestProduct)).toBeUndefined();
    expect(values.has(key)).toBe(false);
  });

  it("rejects invalid items and handles unavailable or quota-limited storage", () => {
    installStorage();
    expect(writeCatalogueCache("limit=50", [{ id: 1, name: "Invalid" }] as unknown as TestProduct[], isTestProduct)).toBe(false);

    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => null,
        removeItem: () => undefined,
        setItem: () => { throw new Error("QuotaExceededError"); },
      },
    });
    expect(writeCatalogueCache("limit=50", [{ id: "1", name: "Phone" }], isTestProduct)).toBe(false);

    vi.stubGlobal("window", {
      get localStorage() {
        throw new Error("Storage unavailable");
      },
    });
    expect(readCatalogueCache<TestProduct>("limit=50", isTestProduct)).toBeUndefined();
    expect(writeCatalogueCache("limit=50", [{ id: "1", name: "Phone" }], isTestProduct)).toBe(false);
  });

  it("uses one versioned key prefix", () => {
    expect(catalogueCacheKey("category=phones")).toBe(`${CATALOGUE_CACHE_KEY_PREFIX}category=phones`);
  });
});
