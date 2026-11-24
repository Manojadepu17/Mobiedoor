export const PRODUCT_IMAGE_FALLBACK = "/categories/mobiles-photo.jpg";

export function isValidProductImageUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "res.cloudinary.com";
  } catch {
    return false;
  }
}

export function optimizedProductImageUrl(value: unknown): string | undefined {
  if (!isValidProductImageUrl(value)) return undefined;
  const url = new URL(value);
  const marker = "/image/upload/";
  if (!url.pathname.includes(marker)) return value;
  const [prefix, remainder] = url.pathname.split(marker);
  if (!remainder) return value;
  url.pathname = `${prefix}${marker}f_auto,q_auto,dpr_auto,c_limit,w_900/${remainder}`;
  return url.toString();
}
