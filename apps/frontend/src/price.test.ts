import { describe, expect, it } from "vitest";
import { discountPercent, formatInr, inrToPaise, paiseToInr } from "./price";

describe("price conversion", () => {
  it("converts admin INR input to integer paise", () => {
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
    expect(formatInr(100000)).toBe("₹1,000");
  });

  it("calculates a discount from original and selling prices", () => {
    expect(discountPercent(80000, 100000)).toBe(20);
    expect(discountPercent(100000, 90000)).toBe(0);
    expect(discountPercent(90000, null)).toBe(0);
  });
});
