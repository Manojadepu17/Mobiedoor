import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { clampGalleryIndex, ProductDetailContent, type ProductDetailsData } from "./product-details";

vi.mock("react-router-dom", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
}));

const product: ProductDetailsData = {
  name: "Refurbished Phone",
  slug: "refurbished-phone",
  sku: "MD-PHONE-01",
  brand: "Example",
  model: "X1",
  description: "A carefully verified device.\nBattery condition checked.",
  priceInPaise: 6500000,
  originalPriceInPaise: 8125000,
  condition: "EXCELLENT",
  stockQuantity: 3,
  warrantyMonths: 6,
  imageUrls: ["https://example.com/front.jpg", "https://example.com/back.jpg"],
  specifications: { Display: "6.1-inch OLED", Storage: "128 GB" },
};

function renderProductDetails(value: ProductDetailsData) {
  return renderToStaticMarkup(<ProductDetailContent product={value} />);
}

describe("product details presentation", () => {
  it("renders product specifications, price, SKU, condition, and stock", () => {
    const markup = renderProductDetails(product);
    expect(markup).toContain("Display");
    expect(markup).toContain("6.1-inch OLED");
    expect(markup).toContain("Storage");
    expect(markup).toContain("MD-PHONE-01");
    expect(markup).toContain("₹65,000");
    expect(markup).toContain("₹81,250");
    expect(markup).toContain("20% off");
    expect(markup).toContain("MobieDoor Verified");
    expect(markup).toContain("In Stock · 3 available");
    expect(markup).toContain("EXCELLENT condition");
  });

  it("renders all image thumbnails and marks the initial image selected", () => {
    const markup = renderProductDetails(product);
    expect(markup).toContain('src="https://example.com/front.jpg"');
    expect(markup).toContain('src="https://example.com/back.jpg"');
    expect(markup).toContain('aria-label="Show image 1 of 2 for Refurbished Phone"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('aria-pressed="false"');
    expect(clampGalleryIndex(1, product.imageUrls.length)).toBe(1);
    expect(clampGalleryIndex(8, product.imageUrls.length)).toBe(1);
    expect(clampGalleryIndex(-1, product.imageUrls.length)).toBe(0);
    expect(clampGalleryIndex(0, 0)).toBe(0);
  });

  it("renders out-of-stock status and gracefully handles missing image and specifications", () => {
    const markup = renderProductDetails({
      ...product,
      imageUrls: [],
      specifications: {},
      stockQuantity: 0,
      sku: null,
      originalPriceInPaise: null,
    });
    expect(markup).toContain("Out of Stock");
    expect(markup).not.toContain("In Stock ·");
    expect(markup).toContain('aria-label="Refurbished Phone"');
    expect(markup).toContain("Specifications are not available for this device.");
    expect(markup).not.toContain("MD-PHONE-01");
    expect(markup).not.toContain("% off");
  });
});
