import { describe, expect, it } from "vitest";
import { CATEGORY_IMAGES, HERO_IMAGES } from "./homepageImages";

describe("homepage image mappings", () => {
  it("keeps a unique static image for every homepage category", () => {
    const categories = ["mobiles", "laptops", "tablets", "smartwatches", "accessories"];
    const expectedFilenames = [
      "category-mobiles.png",
      "category-laptops.png",
      "category-tablets.png",
      "category-smartwatches.png",
      "category-accessories.png",
    ];
    const sources = categories.map(category => CATEGORY_IMAGES[category].src);

    expect(new Set(sources).size).toBe(categories.length);
    for (const [index, category] of categories.entries()) {
      expect(sources[index]).toContain(expectedFilenames[index]);
      expect(CATEGORY_IMAGES[category].name.toLowerCase()).toBe(category);
    }
  });

  it("keeps the original phone, tablet, and laptop artwork assigned in carousel order", () => {
    expect(HERO_IMAGES.map(image => image.src)).toEqual([
      expect.stringContaining("hero-iphone"),
      expect.stringContaining("hero-tablet"),
      expect.stringContaining("hero-laptop"),
    ]);
  });
});
