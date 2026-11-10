import { describe, expect, it } from "vitest";
import { adminPricesToPaise, discountPercent, formatInr, inrToPaise, paiseToInr } from "./price";

describe("price conversion", () => {
  it.each([
    ["₹650", "650", 65_000, "₹650"],
    ["₹6,500", "6500", 650_000, "₹6,500"],
    ["₹65,000", "65000", 6_500_000, "₹65,000"],
    ["₹1,00,000", "100000", 10_000_000, "₹1,00,000"],
  ])("converts and formats %s without double conversion", (_label, inr, paise, formatted) => {
    expect(inrToPaise(inr)).toBe(paise);
    expect(paiseToInr(paise)).toBe(Number(inr));
    expect(formatInr(paise)).toBe(formatted);
  });

  it("builds the same paise payload for adding and editing products", () => {
    expect(adminPricesToPaise("65000")).toEqual({
      priceInPaise: 6_500_000,
      originalPriceInPaise: undefined,
    });
    expect(adminPricesToPaise("65000", "100000")).toEqual({
      priceInPaise: 6_500_000,
      originalPriceInPaise: 10_000_000,
    });
    expect(adminPricesToPaise("65000", null)).toEqual({
      priceInPaise: 6_500_000,
      originalPriceInPaise: null,
    });
  });

  it("converts decimal INR input to integer paise", () => {
    expect(inrToPaise("1299.50")).toBe(129950);
    expect(inrToPaise(0)).toBe(0);
  });

  it("rejects amounts that cannot be represented in paise or the database", () => {
    expect(() => inrToPaise("1.234")).toThrow();
    expect(() => inrToPaise("-1")).toThrow();
    expect(() => inrToPaise("21474836.48")).toThrow();
  });

  it("converts stored paise to INR for display", () => {
    expect(paiseToInr(129950)).toBe(1299.5);
    expect(formatInr(129950)).toBe("₹1,299.5");
  });

  it("calculates a discount from original and selling prices", () => {
    expect(discountPercent(80000, 100000)).toBe(20);
    expect(discountPercent(6_500_000, 10_000_000)).toBe(35);
    expect(discountPercent(100000, 90000)).toBe(0);
    expect(discountPercent(90000, null)).toBe(0);
  });
});
