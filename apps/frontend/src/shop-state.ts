export const SHOP_ROUTE = "/products";
export const ALL_DEVICES_CATEGORY = "All devices";

export type ShopSort = "Featured" | "Price: low to high" | "Price: high to low";

export type ShopFilters = {
  search: string;
  category: string;
  sort: ShopSort;
};

export function readShopPage(params: URLSearchParams) {
  const requestedPage = Number(params.get("page"));
  return Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
}

const categoryAliases: Record<string, string[]> = {
  mobiles: ["mobile", "mobiles", "phone", "phones"],
  laptops: ["laptop", "laptops"],
  tablets: ["tablet", "tablets"],
};

export function readShopFilters(params: URLSearchParams, categories: string[]): ShopFilters {
  const requestedCategory = params.get("category")?.trim();
  const category = categories.find(value => value.toLocaleLowerCase() === requestedCategory?.toLocaleLowerCase())
    ?? categories.find(value => categoryAliases[requestedCategory?.toLocaleLowerCase() ?? ""]?.includes(value.toLocaleLowerCase()))
    ?? ALL_DEVICES_CATEGORY;
  const sortValue = params.get("sort");
  const sort: ShopSort = sortValue === "price_asc" || sortValue === "Price: low to high"
    ? "Price: low to high"
    : sortValue === "price_desc" || sortValue === "Price: high to low"
      ? "Price: high to low"
      : "Featured";

  return {
    search: params.get("search") ?? "",
    category,
    sort,
  };
}

export function productsQuery(filters: ShopFilters, page = 1) {
  const params = new URLSearchParams();
  if (filters.search.trim()) params.set("search", filters.search.trim());
  if (filters.category !== ALL_DEVICES_CATEGORY) params.set("category", filters.category);
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
  for (const key of ["search", "category", "sort", "page"]) next.delete(key);
  return next;
}
