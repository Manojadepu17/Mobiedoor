import { describe, expect, it, vi } from "vitest";
import {
  catalogueRetryCount,
  catalogueRetryDelay,
  isValidCatalogueProduct,
  validateCatalogueEnvelope,
} from "./catalogue-validation";

const product = {
  id: "phone-1",
  name: "Verified Phone",
  slug: "verified-phone",
  brand: "Test",
  model: "One",
  description: "A verified and tested device.",
  priceInPaise: 100000,
  originalPriceInPaise: 120000,
  condition: "EXCELLENT",
  category: "phones",
  stockQuantity: 3,
  availability: "IN_STOCK",
  imageUrls: ["https://res.cloudinary.com/demo/image/upload/phone.jpg"],
};

describe("catalogue response validation", () => {
  it("rejects products missing each required catalogue field", () => {
    const requiredFields = [
      "id",
      "name",
      "slug",
      "brand",
      "model",
      "description",
      "priceInPaise",
      "condition",
      "category",
      "stockQuantity",
      "imageUrls",
    ] as const;

    for (const field of requiredFields) {
      const incomplete: Partial<typeof product> = { ...product };
      delete incomplete[field];
      expect(isValidCatalogueProduct(incomplete), `missing ${field}`).toBe(false);
    }
  });

  it("rejects malformed identifiers and blank product text fields", () => {
    for (const invalid of [
      { id: "" },
      { id: "   " },
      { id: 12 },
      { name: "" },
      { name: "A" },
      { name: "   " },
      { slug: "" },
      { slug: "Invalid Slug" },
      { brand: "" },
      { brand: "   " },
      { model: "" },
      { model: "   " },
      { category: "" },
      { category: "   " },
    ]) {
      expect(isValidCatalogueProduct({ ...product, ...invalid })).toBe(false);
    }
  });

  it("rejects invalid stock, original prices, and image URL entries", () => {
    for (const stockQuantity of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "3"]) {
      expect(isValidCatalogueProduct({ ...product, stockQuantity })).toBe(false);
    }
    for (const originalPriceInPaise of [-1, 1.5, product.priceInPaise, Number.MAX_SAFE_INTEGER + 1]) {
      expect(isValidCatalogueProduct({ ...product, originalPriceInPaise })).toBe(false);
    }
  });

  it("accepts HTTPS Cloudinary image URLs", () => {
    expect(isValidCatalogueProduct({
      ...product,
      imageUrls: ["https://res.cloudinary.com/demo/image/upload/phone.jpg"],
    })).toBe(true);
  });

  it("accepts approved local application assets and existing upload paths", () => {
    expect(isValidCatalogueProduct({
      ...product,
      imageUrls: ["/categories/mobiles-photo.jpg", "/assets/promos/best-selling-apple-phones.png"],
    })).toBe(true);
    expect(isValidCatalogueProduct({ ...product, imageUrls: ["/uploads/phone.jpg"] })).toBe(true);
  });

  it("rejects protocol-relative image URLs", () => {
    expect(isValidCatalogueProduct({ ...product, imageUrls: ["//example.com/image.jpg"] })).toBe(false);
  });

  it("rejects javascript image URLs", () => {
    expect(isValidCatalogueProduct({ ...product, imageUrls: ["javascript:alert(1)"] })).toBe(false);
  });

  it("rejects unsupported external and HTTP image URLs", () => {
    for (const imageUrl of [
      "https://example.com/image.jpg",
      "http://res.cloudinary.com/demo/image/upload/phone.jpg",
    ]) {
      expect(isValidCatalogueProduct({ ...product, imageUrls: [imageUrl] })).toBe(false);
    }
  });

  it("rejects missing and malformed image values while allowing an empty image list", () => {
    const { imageUrls: _imageUrls, ...missingImageUrls } = product;
    expect(isValidCatalogueProduct(missingImageUrls)).toBe(false);

    for (const imageUrls of [null, "", [""], [null], [12], ["/unapproved/image.jpg"], ["/uploads/../image.jpg"]]) {
      expect(isValidCatalogueProduct({ ...product, imageUrls })).toBe(false);
    }
    expect(isValidCatalogueProduct({ ...product, imageUrls: [] })).toBe(true);
  });

  it("rejects missing pagination metadata", () => {
    expect(validateCatalogueEnvelope({ data: [product] })).toBeUndefined();
  });

  it("rejects invalid product records, image URLs, and enum values", () => {
    expect(isValidCatalogueProduct({ ...product, priceInPaise: -1 })).toBe(false);
    expect(isValidCatalogueProduct({ ...product, condition: "UNKNOWN" })).toBe(false);
    expect(isValidCatalogueProduct({ ...product, availability: "UNKNOWN" })).toBe(false);
  });

  it("validates legitimate, empty, and incomplete catalogue pagination", () => {
    expect(validateCatalogueEnvelope({
      data: [product],
      meta: { page: 1, limit: 50, total: 1, totalPages: 1 },
    })?.data).toEqual([product]);

    expect(validateCatalogueEnvelope({
      data: [],
      meta: { page: 1, limit: 50, total: 0, totalPages: 0 },
    })?.data).toEqual([]);

    expect(validateCatalogueEnvelope({
      data: [],
      meta: { page: 1, limit: 50, total: 2, totalPages: 1 },
    })).toBeUndefined();

    expect(validateCatalogueEnvelope({
      data: [product],
      meta: { page: 1, limit: 50, total: 2, totalPages: 1 },
    })).toBeUndefined();
  });

  it("rejects inconsistent and duplicate pagination metadata", () => {
    expect(validateCatalogueEnvelope({
      data: [product],
      meta: { page: 2, limit: 50, total: 1, totalPages: 1 },
    })).toBeUndefined();
    expect(validateCatalogueEnvelope({
      data: [product],
      meta: { page: 1, limit: 50, total: 51, totalPages: 2 },
    })).toBeUndefined();
  });

  it("uses bounded retries and respects Retry-After", () => {
    expect(catalogueRetryCount(0, 429, false)).toBe(true);
    expect(catalogueRetryCount(1, 429, false)).toBe(true);
    expect(catalogueRetryCount(2, 429, false)).toBe(false);
    expect(catalogueRetryCount(0, 404, false)).toBe(false);
    expect(catalogueRetryDelay(0, 12)).toBe(12000);
  });

  it("bounds Retry-After and adds jitter to ordinary backoff", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      expect(catalogueRetryDelay(0, 120)).toBe(30000);
      expect(catalogueRetryDelay(0)).toBe(750);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
