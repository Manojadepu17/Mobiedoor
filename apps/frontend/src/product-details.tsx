import { useState } from "react";
import { ArrowRight, PackageCheck } from "lucide-react";
import { Link } from "react-router-dom";
import { discountPercent, formatInr } from "./price";

export type ProductDetailsData = {
  name: string;
  slug: string;
  sku?: string | null;
  brand: string;
  model: string;
  description: string;
  priceInPaise: number;
  originalPriceInPaise?: number | null;
  condition: "LIKE_NEW" | "EXCELLENT" | "GOOD" | "FAIR";
  stockQuantity: number;
  warrantyMonths?: number | null;
  imageUrls: string[];
  specifications?: unknown;
};

export function clampGalleryIndex(index: number, imageCount: number) {
  return imageCount === 0 ? 0 : Math.max(0, Math.min(index, imageCount - 1));
}

export function getSpecificationEntries(specifications: unknown): Array<[string, string]> {
  if (!specifications || typeof specifications !== "object" || Array.isArray(specifications)) return [];
  return Object.entries(specifications).flatMap(([name, value]) => {
    if (value === null || value === undefined || value === "") return [];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return [[name, String(value)]];
    }
    return [[name, JSON.stringify(value)]];
  });
}

function ProductImage({ src, alt }: { src?: string; alt: string }) {
  const [failed, setFailed] = useState(!src);
  return failed
    ? <div className="image-fallback" role="img" aria-label={alt}><PackageCheck size={28} /><span>Image unavailable</span></div>
    : <img src={src} alt={alt} onError={() => setFailed(true)} />;
}

export function ProductDetailContent({ product }: { product: ProductDetailsData }) {
  const images = product.imageUrls.filter(image => typeof image === "string" && image.trim().length > 0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const activeIndex = clampGalleryIndex(selectedIndex, images.length);
  const specifications = getSpecificationEntries(product.specifications);

  return <section className="section detail-page"><div className="container detail-layout">
    <div className="detail-gallery">
      <div className="detail-image">
        <ProductImage key={images[activeIndex] ?? "missing-image"} src={images[activeIndex]} alt={`${product.name}${images.length > 1 ? `, image ${activeIndex + 1} of ${images.length}` : ""}`} />
      </div>
      {images.length > 1 && <div className="detail-thumbnails" role="group" aria-label="Product images">
        {images.map((image, index) => <button
          type="button"
          className={`detail-thumbnail${index === activeIndex ? " active" : ""}`}
          key={`${image}-${index}`}
          aria-label={`Show image ${index + 1} of ${images.length} for ${product.name}`}
          aria-pressed={index === activeIndex}
          onClick={() => setSelectedIndex(clampGalleryIndex(index, images.length))}
        ><ProductImage src={image} alt="" /></button>)}
      </div>}
    </div>
    <div className="detail-copy">
      <p className="eyebrow">{product.condition.replace("_", " ")} condition</p>
      <h1>{product.name}</h1>
      <p className="detail-model">{product.brand} · {product.model}</p>
      {product.sku && <p className="detail-sku">SKU: {product.sku}</p>}
      <p className="detail-description">{product.description}</p>
      <strong className="detail-price">{formatInr(product.priceInPaise)}</strong>
      {product.originalPriceInPaise && product.originalPriceInPaise > product.priceInPaise &&
        <p className="original-price">{formatInr(product.originalPriceInPaise)} · {discountPercent(product.priceInPaise, product.originalPriceInPaise)}% off</p>}
      <p className={`availability${product.stockQuantity > 0 ? " in-stock" : " out-of-stock"}`} role="status">
        {product.stockQuantity > 0 ? `In Stock · ${product.stockQuantity} available` : "Out of Stock"}
        {product.warrantyMonths ? ` · ${product.warrantyMonths}-month warranty` : ""}
      </p>
      <Link className="button primary" to="/contact">Enquire about this device<ArrowRight size={16} /></Link>
      <section className="detail-specifications" aria-labelledby="specifications-title">
        <h2 id="specifications-title">Specifications</h2>
        {specifications.length > 0
          ? <dl>{specifications.map(([name, value]) => <div className="specification-row" key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>
          : <p className="specifications-empty">Specifications are not available for this device.</p>}
      </section>
    </div>
  </div></section>;
}
