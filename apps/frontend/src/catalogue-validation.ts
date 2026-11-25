import type { Product } from "./main";
import { isValidProductImageUrl } from "./image-url";

export type CatalogueMeta = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
};

export type CatalogueEnvelope = {
  data: Product[];
  meta: CatalogueMeta;
};

const conditions = new Set(["LIKE_NEW", "EXCELLENT", "GOOD", "FAIR"]);
const availability = new Set(["IN_STOCK", "LOW_STOCK", "OUT_OF_STOCK", "DISCONTINUED"]);
const approvedLocalCatalogueImages = new Set([
  "/categories/accessories-photo.jpg",
  "/categories/deals-phone.jpg",
  "/categories/hero-phone.jpg",
  "/categories/hero-smartphone.jpg",
  "/categories/laptops-photo.jpg",
  "/categories/mobiles-photo.jpg",
  "/categories/smartwatches-photo.jpg",
  "/categories/smartwatches.png",
  "/categories/tablets-photo.jpg",
  "/categories/trade-in-phone.jpg",
  "/assets/promos/best-selling-android-phones.png",
  "/assets/promos/best-selling-apple-phones.png",
]);

function isValidCatalogueImageUrl(value: unknown): value is string {
  if (isValidProductImageUrl(value)) return true;
  if (typeof value !== "string") return false;
  return approvedLocalCatalogueImages.has(value)
    || /^\/uploads\/[A-Za-z0-9][A-Za-z0-9._-]*\.(?:avif|gif|jpe?g|png|webp)$/i.test(value);
}

export function isValidCatalogueMeta(value: unknown): value is CatalogueMeta {
  if (typeof value !== "object" || value === null) return false;
  const meta = value as Partial<CatalogueMeta>;
  return Number.isSafeInteger(meta.page)
    && Number.isSafeInteger(meta.limit)
    && Number.isSafeInteger(meta.total)
    && Number.isSafeInteger(meta.totalPages)
    && meta.page! >= 1
    && meta.limit! >= 1
    && meta.limit! <= 50
    && meta.total! >= 0
    && meta.totalPages! >= 0
    && meta.totalPages === Math.ceil(meta.total! / meta.limit!)
    && (meta.total === 0
      ? meta.page === 1 && meta.totalPages === 0
      : meta.page! <= meta.totalPages);
}

export function isValidCatalogueProduct(value: unknown): value is Product {
  if (typeof value !== "object" || value === null) return false;
  const product = value as Partial<Product>;
  return typeof product.id === "string"
    && product.id.trim().length > 0
    && typeof product.name === "string"
    && product.name.trim().length >= 2
    && typeof product.slug === "string"
    && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(product.slug)
    && typeof product.brand === "string"
    && product.brand.trim().length > 0
    && typeof product.model === "string"
    && product.model.trim().length > 0
    && typeof product.description === "string"
    && product.description.trim().length >= 10
    && Number.isSafeInteger(product.priceInPaise)
    && product.priceInPaise! >= 0
    && Number.isSafeInteger(product.stockQuantity)
    && product.stockQuantity! >= 0
    && typeof product.category === "string"
    && product.category.trim().length > 0
    && conditions.has(product.condition as string)
    && (product.originalPriceInPaise === undefined
      || product.originalPriceInPaise === null
      || (Number.isSafeInteger(product.originalPriceInPaise)
        && product.originalPriceInPaise > product.priceInPaise!))
    && (product.availability === undefined || availability.has(product.availability))
    && Array.isArray(product.imageUrls)
    && product.imageUrls.every(isValidCatalogueImageUrl);
}

export function validateCatalogueEnvelope(value: unknown): CatalogueEnvelope | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const envelope = value as { data?: unknown; meta?: unknown };
  if (!Array.isArray(envelope.data) || !isValidCatalogueMeta(envelope.meta)) return undefined;
  if (!envelope.data.every(isValidCatalogueProduct)) return undefined;

  const meta = envelope.meta;
  if (meta.total === 0 && envelope.data.length !== 0) return undefined;
  if (meta.page > 1 && envelope.data.length === 0) return undefined;
  if (meta.total > 0 && meta.totalPages === 1 && envelope.data.length !== meta.total) return undefined;
  if (meta.total > 0) {
    const expectedCount = meta.page < meta.totalPages
      ? meta.limit
      : meta.total - ((meta.page - 1) * meta.limit);
    if (expectedCount < 0 || envelope.data.length !== expectedCount) return undefined;
  }

  return { data: envelope.data as Product[], meta };
}

export function catalogueRetryCount(
  failureCount: number,
  status: number | undefined,
  isNetworkOrTimeout: boolean,
) {
  if (failureCount >= 2) return false;
  if (status !== undefined) return [408, 429, 502, 503, 504].includes(status);
  return isNetworkOrTimeout;
}

export function catalogueRetryDelay(attempt: number, retryAfterSeconds?: number) {
  if (retryAfterSeconds !== undefined) return Math.min(retryAfterSeconds * 1000, 30_000);
  const exponential = Math.min(750 * 2 ** attempt, 3_000);
  return exponential + Math.floor(Math.random() * 250);
}
