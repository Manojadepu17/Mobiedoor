export const SHOP_ROUTE = "/products";
export const ALL_DEVICES_CATEGORY = "All devices";

export type ShopSort = "Featured" | "Newest" | "Price: low to high" | "Price: high to low";

export type ShopCondition = "LIKE_NEW" | "EXCELLENT" | "GOOD" | "FAIR";
export type ShopAvailability = "" | "in-stock" | "out-of-stock";
export type ShopRefinements = {
  brand: string;
  minPrice: number | null;
  maxPrice: number | null;
  condition: ShopCondition | "";
  availability: ShopAvailability;
};

const categoryAliases: Record<string, string[]> = {
  mobiles: ["mobile", "mobiles", "phone", "phones"],
  laptops: ["laptop", "laptops"],
  tablets: ["tablet", "tablets"],
  smartwatches: ["smartwatch", "smartwatches", "watch", "watches"],
  accessories: ["accessory", "accessories"],
  gaming: ["gaming", "gaming device", "gaming devices", "console", "consoles"],
};

const categoryFallbacks: Record<string, string> = {
  mobiles: "phones",
  laptops: "laptops",
  tablets: "tablets",
  smartwatches: "smartwatches",
  accessories: "accessories",
  gaming: "gaming devices",
};

export function displayShopCategory(category: string) {
  switch (category.trim().toLocaleLowerCase()) {
    case ALL_DEVICES_CATEGORY.toLocaleLowerCase():
      return "All Devices";
    case "mobile":
    case "mobiles":
    case "phone":
    case "phones":
      return "Mobiles";
    case "laptop":
    case "laptops":
      return "laptops";
    case "tablet":
    case "tablets":
      return "Tablets";
    case "smartwatch":
    case "smartwatches":
    case "watch":
    case "watches":
      return "Smartwatches";
    case "accessory":
    case "accessories":
      return "Accessories";
    case "gaming":
    case "gaming device":
    case "gaming devices":
    case "console":
    case "consoles":
      return "Gaming Devices";
    default:
      return category;
  }
}

export type ShopFilters = {
  search: string;
  category: string;
  sort: ShopSort;
};

export function readShopPage(params: URLSearchParams) {
  const requestedPage = Number(params.get("page"));
  return Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
}

export function resolveShopCategory(requestedCategory: string | null | undefined, categories: string[]) {
  const requested = requestedCategory?.trim().toLocaleLowerCase();
  if (!requested) return ALL_DEVICES_CATEGORY;

  const exact = categories.find(value => value.toLocaleLowerCase() === requested);
  if (exact) return exact;

  const alias = Object.entries(categoryAliases).find(([key, values]) => key === requested || values.includes(requested));
  if (!alias) return ALL_DEVICES_CATEGORY;

  const match = categories.find(value => alias[1].includes(value.toLocaleLowerCase()));
  return match ?? categoryFallbacks[alias[0]];
}

export function readShopFilters(params: URLSearchParams, categories: string[]): ShopFilters {
  const category = resolveShopCategory(params.get("category"), categories);
  const sortValue = params.get("sort");
  const sort: ShopSort = sortValue === "price_asc" || sortValue === "Price: low to high"
    ? "Price: low to high"
    : sortValue === "price_desc" || sortValue === "Price: high to low"
      ? "Price: high to low"
      : sortValue === "newest" || sortValue === "Newest"
        ? "Newest"
      : "Featured";

  return {
    search: params.get("search") ?? "",
    category,
    sort,
  };
}

function readPriceInPaise(value: string | null) {
  if (value === null || value.trim() === "") return null;
  const rupees = Number(value);
  if (!Number.isFinite(rupees) || rupees < 0) return null;
  const paise = Math.round(rupees * 100);
  return Number.isSafeInteger(paise) ? paise : null;
}

export function readShopRefinements(params: URLSearchParams): ShopRefinements {
  const condition = params.get("condition");
  const availability = params.get("availability");
  return {
    brand: params.get("brand") ?? "",
    minPrice: readPriceInPaise(params.get("minPrice")),
    maxPrice: readPriceInPaise(params.get("maxPrice")),
    condition: condition === "LIKE_NEW" || condition === "EXCELLENT" || condition === "GOOD" || condition === "FAIR"
      ? condition
      : "",
    availability: availability === "in-stock" || availability === "out-of-stock" ? availability : "",
  };
}

export function updateShopRefinement(
  params: URLSearchParams,
  key: "brand" | "minPrice" | "maxPrice" | "condition" | "availability",
  value: string,
) {
  const next = new URLSearchParams(params);
  const normalizedValue = value.trim();
  if (normalizedValue) next.set(key, normalizedValue);
  else next.delete(key);
  next.delete("page");
  return next;
}

type ShopFilterableProduct = {
  brand: string;
  priceInPaise: number;
  condition: string;
  stockQuantity: number;
};

export function filterShopProducts<T extends ShopFilterableProduct>(products: T[], refinements: ShopRefinements) {
  const brand = refinements.brand.toLocaleLowerCase();
  return products.filter(product =>
    (!brand || product.brand.toLocaleLowerCase() === brand)
    && (refinements.minPrice === null || product.priceInPaise >= refinements.minPrice)
    && (refinements.maxPrice === null || product.priceInPaise <= refinements.maxPrice)
    && (!refinements.condition || product.condition === refinements.condition)
    && (!refinements.availability || (refinements.availability === "in-stock" ? product.stockQuantity > 0 : product.stockQuantity <= 0))
  );
}

export type ShopBudgetRange = { minPrice: number | null; maxPrice: number | null };

export function buildShopBudgetRanges(pricesInPaise: number[]): ShopBudgetRange[] {
  const prices = [...new Set(pricesInPaise.filter(price => Number.isSafeInteger(price) && price >= 0))]
    .sort((left, right) => left - right);
  if (prices.length === 0) return [];
  if (prices.length === 1) return [{ minPrice: prices[0], maxPrice: prices[0] }];

  const boundaries = [...new Set([
    prices[Math.floor((prices.length - 1) / 3)],
    prices[Math.floor(2 * (prices.length - 1) / 3)],
  ])];
  const ranges: ShopBudgetRange[] = [];
  let minPrice: number | null = null;
  for (const boundary of boundaries) {
    ranges.push({ minPrice, maxPrice: boundary });
    minPrice = boundary + 1;
  }
  ranges.push({ minPrice, maxPrice: null });
  return ranges;
}

export function productsQuery(filters: ShopFilters, page = 1) {
  const params = new URLSearchParams();
  if (filters.search.trim()) params.set("search", filters.search.trim());
  if (filters.category !== ALL_DEVICES_CATEGORY) params.set("category", filters.category);
  if (filters.sort === "Newest") params.set("sort", "newest");
  if (filters.sort === "Price: low to high") params.set("sort", "price_asc");
  if (filters.sort === "Price: high to low") params.set("sort", "price_desc");
  if (page > 1) params.set("page", String(page));
  return params;
}

export function updateShopFilter(params: URLSearchParams, key: "search" | "category" | "sort", value: string) {
  const next = new URLSearchParams(params);
  if (value && !(key === "category" && value === ALL_DEVICES_CATEGORY) && !(key === "sort" && value === "Featured")) next.set(key, value);
  else next.delete(key);
  next.delete("page");
  return next;
}

export function updateShopPage(params: URLSearchParams, page: number) {
  const next = new URLSearchParams(params);
  if (page > 1) next.set("page", String(page));
  else next.delete("page");
  return next;
}

export function clearShopFilters(params: URLSearchParams) {
  const next = new URLSearchParams(params);
  for (const key of ["search", "category", "sort", "brand", "minPrice", "maxPrice", "condition", "availability", "page"]) next.delete(key);
  return next;
}
