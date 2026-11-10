const MAX_DATABASE_PRICE_IN_PAISE = 2_147_483_647;

export function inrToPaise(value: string | number) {
  const input = String(value).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(input)) {
    throw new Error("Price must be a non-negative amount with at most two decimal places.");
  }
  if (input.length > 11) throw new Error("Price is too large.");
  const [rupees, fraction = ""] = input.split(".");
  const paise = BigInt(rupees) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (paise > BigInt(MAX_DATABASE_PRICE_IN_PAISE)) throw new Error("Price is too large.");
  const amount = Number(paise);
  if (!Number.isSafeInteger(amount)) throw new Error("Price is too large.");
  return amount;
}

export function paiseToInr(paise: number) {
  if (!Number.isSafeInteger(paise) || paise < 0 || paise > MAX_DATABASE_PRICE_IN_PAISE) {
    throw new Error("Stored price must be a non-negative integer.");
  }
  return paise / 100;
}

const inrFormatter = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

export function formatInr(paise: number) {
  return inrFormatter.format(paiseToInr(paise));
}

export function discountPercent(priceInPaise: number, originalPriceInPaise?: number | null) {
  if (!originalPriceInPaise || originalPriceInPaise <= priceInPaise) return 0;
  return Math.round((1 - priceInPaise / originalPriceInPaise) * 100);
}
