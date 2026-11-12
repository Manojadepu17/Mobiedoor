import { describe, expect, it } from "vitest";
import {
  ALL_DEVICES_CATEGORY,
  buildShopBudgetRanges,
  clearShopFilters,
  displayShopCategory,
  filterShopProducts,
  productsQuery,
  readShopPage,
  readShopFilters,
  readShopRefinements,
  resolveShopCategory,
  SHOP_ROUTE,
  updateShopFilter,
  updateShopPage,
  updateShopRefinement,
} from "./shop-state";

const categories = ["phones", "LAPTOP"];

describe("shop navigation and filters", () => {
  it("uses the requested visible category labels without changing API category values", () => {
    expect(displayShopCategory(ALL_DEVICES_CATEGORY)).toBe("All Devices");
    expect(displayShopCategory("Phones")).toBe("Mobiles");
    expect(displayShopCategory("LAPTOP")).toBe("laptops");
    expect(displayShopCategory("Tablets")).toBe("Tablets");
    expect(displayShopCategory("Gaming devices")).toBe("Gaming Devices");
  });

  it("resolves category labels to exact catalogue values without changing category values", () => {
    expect(resolveShopCategory("mobiles", ["phones", "LAPTOP"])).toBe("phones");
    expect(resolveShopCategory("laptops", ["phones", "LAPTOP"])).toBe("LAPTOP");
    expect(resolveShopCategory("gaming devices", [])).toBe("gaming devices");
    expect(resolveShopCategory("unknown", ["phones", "LAPTOP"])).toBe(ALL_DEVICES_CATEGORY);
  });

  it("reads and updates catalogue refinements while resetting the page", () => {
    const updated = updateShopRefinement(
      new URLSearchParams("page=4&category=phones"),
      "minPrice",
      "1250.50",
    );
    expect(updated.toString()).toBe("category=phones&minPrice=1250.50");
    expect(readShopRefinements(new URLSearchParams(
      "brand=Acme&minPrice=1250.50&maxPrice=2000&condition=EXCELLENT&availability=in-stock",
    ))).toEqual({
      brand: "Acme",
      minPrice: 125050,
      maxPrice: 200000,
      condition: "EXCELLENT",
      availability: "in-stock",
    });
  });

  it("filters real catalogue products by brand, price, condition, and stock", () => {
    const products = [
      { brand: "Acme", priceInPaise: 125000, condition: "EXCELLENT", stockQuantity: 2 },
      { brand: "Acme", priceInPaise: 210000, condition: "GOOD", stockQuantity: 0 },
      { brand: "Other", priceInPaise: 150000, condition: "EXCELLENT", stockQuantity: 1 },
    ];
    expect(filterShopProducts(products, {
      brand: "ACME",
      minPrice: 100000,
      maxPrice: 200000,
      condition: "EXCELLENT",
      availability: "in-stock",
    })).toEqual([products[0]]);
  });

  it("builds useful price ranges from actual catalogue prices", () => {
    expect(buildShopBudgetRanges([6500000, 9500000])).toEqual([
      { minPrice: null, maxPrice: 6500000 },
      { minPrice: 6500001, maxPrice: null },
    ]);
    expect(buildShopBudgetRanges([5000000, 5000000])).toEqual([
      { minPrice: 5000000, maxPrice: 5000000 },
    ]);
    expect(buildShopBudgetRanges([])).toEqual([]);
    expect(buildShopBudgetRanges([10000, 20000, 30000, 40000, 50000, 60000])).toEqual([
      { minPrice: null, maxPrice: 20000 },
      { minPrice: 20001, maxPrice: 40000 },
      { minPrice: 40001, maxPrice: null },
    ]);
  });

  it("uses the unfiltered shop route for homepage shop actions", () => {
    expect(SHOP_ROUTE).toBe("/products");
    expect(readShopFilters(new URLSearchParams(), categories)).toEqual({
      search: "",
      category: ALL_DEVICES_CATEGORY,
      sort: "Featured",
    });
    expect(productsQuery(readShopFilters(new URLSearchParams(), categories)).toString()).toBe("");
  });

  it("does not carry a category filter when navigation returns to the shop default", () => {
    const categoryPage = readShopFilters(new URLSearchParams("category=mobiles"), categories);
    expect(categoryPage.category).toBe("phones");

    const shopPage = readShopFilters(new URLSearchParams(), categories);
    expect(shopPage).toEqual({ search: "", category: ALL_DEVICES_CATEGORY, sort: "Featured" });
    expect(productsQuery(shopPage).toString()).toBe("");
  });

  it("keeps explicit API category filters and sorting", () => {
    const filters = readShopFilters(
      new URLSearchParams("search=iphone&category=phones&sort=price_asc"),
      categories,
    );
    expect(filters).toEqual({
      search: "iphone",
      category: "phones",
      sort: "Price: low to high",
    });
    expect(productsQuery(filters).toString()).toBe("search=iphone&category=phones&sort=price_asc");
  });

  it("supports newest-first catalogue ordering", () => {
    const filters = readShopFilters(new URLSearchParams("sort=newest"), categories);
    expect(filters.sort).toBe("Newest");
    expect(productsQuery(filters).toString()).toBe("sort=newest");
  });

  it("requests the selected page while preserving search, category, and sorting", () => {
    const filters = readShopFilters(
      new URLSearchParams("search=iphone&category=phones&sort=price_desc&page=3"),
      categories,
    );
    expect(readShopPage(new URLSearchParams("page=3"))).toBe(3);
    expect(productsQuery(filters, readShopPage(new URLSearchParams("page=3"))).toString())
      .toBe("search=iphone&category=phones&sort=price_desc&page=3");
  });

  it("resets pagination when any filter or search value changes", () => {
    const updated = updateShopFilter(new URLSearchParams("search=iphone&category=phones&sort=price_desc&page=4&campaign=spring"), "search", "pixel");
    expect(updated.toString()).toBe("search=pixel&category=phones&sort=price_desc&campaign=spring");
    expect(readShopPage(updated)).toBe(1);
    expect(updateShopFilter(new URLSearchParams("page=4"), "category", "LAPTOP").has("page")).toBe(false);
    expect(updateShopFilter(new URLSearchParams("page=4"), "sort", "Price: low to high").has("page")).toBe(false);
  });

  it("changes pages without losing the active filters", () => {
    const pageTwo = updateShopPage(new URLSearchParams("search=iphone&category=phones&sort=price_asc"), 2);
    expect(pageTwo.toString()).toBe("search=iphone&category=phones&sort=price_asc&page=2");
    expect(updateShopPage(pageTwo, 1).toString()).toBe("search=iphone&category=phones&sort=price_asc");
  });

  it("defaults invalid or missing page numbers to page one", () => {
    expect(readShopPage(new URLSearchParams())).toBe(1);
    expect(readShopPage(new URLSearchParams("page=0"))).toBe(1);
    expect(readShopPage(new URLSearchParams("page=1.5"))).toBe(1);
    expect(readShopPage(new URLSearchParams("page=not-a-number"))).toBe(1);
  });

  it("defaults unknown or empty URL filters instead of hiding all products", () => {
    const filters = readShopFilters(new URLSearchParams("search=&category=unknown&sort=bogus"), categories);
    expect(filters).toEqual({ search: "", category: ALL_DEVICES_CATEGORY, sort: "Featured" });
    expect(productsQuery(filters).toString()).toBe("");
    expect(productsQuery({ ...filters, search: "   " }).toString()).toBe("");
  });

  it("clears filter and pagination parameters while preserving unrelated URL state", () => {
    expect(clearShopFilters(new URLSearchParams("search=iphone&category=phones&sort=price_desc&brand=Acme&minPrice=10&condition=GOOD&availability=in-stock&page=3&campaign=spring")).toString())
      .toBe("campaign=spring");
  });
});
