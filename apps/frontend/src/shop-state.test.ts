import { describe, expect, it } from "vitest";
import {
  ALL_DEVICES_CATEGORY,
  clearShopFilters,
  productsQuery,
  readShopPage,
  readShopFilters,
  SHOP_ROUTE,
  updateShopFilter,
  updateShopPage,
} from "./shop-state";

const categories = ["phones", "LAPTOP"];

describe("shop navigation and filters", () => {
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
    expect(clearShopFilters(new URLSearchParams("search=iphone&category=phones&sort=price_desc&page=3&campaign=spring")).toString())
      .toBe("campaign=spring");
  });
});
