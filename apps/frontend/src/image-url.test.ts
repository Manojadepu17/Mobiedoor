import { describe, expect, it } from "vitest";
import { isValidProductImageUrl, optimizedProductImageUrl, PRODUCT_IMAGE_FALLBACK } from "./image-url";

describe("product image URLs", () => {
  it("accepts only HTTPS Cloudinary image URLs", () => {
    expect(isValidProductImageUrl("https://res.cloudinary.com/demo/image/upload/sample.jpg")).toBe(true);
    expect(isValidProductImageUrl("http://res.cloudinary.com/demo/image/upload/sample.jpg")).toBe(false);
    expect(isValidProductImageUrl("https://example.com/sample.jpg")).toBe(false);
  });

  it("adds responsive delivery transformations without replacing the asset", () => {
    expect(optimizedProductImageUrl("https://res.cloudinary.com/demo/image/upload/v1/mobiedoor/products/phone.jpg"))
      .toBe("https://res.cloudinary.com/demo/image/upload/f_auto,q_auto,dpr_auto,c_limit,w_900/v1/mobiedoor/products/phone.jpg");
  });

  it("uses the existing local fallback for invalid URLs", () => {
    expect(optimizedProductImageUrl("https://example.com/phone.jpg")).toBeUndefined();
    expect(PRODUCT_IMAGE_FALLBACK).toBe("/categories/mobiles-photo.jpg");
  });
});
