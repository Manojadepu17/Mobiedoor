import { CircleHelp, Search, Sparkles, X } from "lucide-react";
import { Link } from "react-router-dom";

type CatalogueStatusProps = {
  state: "loading" | "error" | "empty";
  hasFilters?: boolean;
  onClear?: () => void;
};

export function CataloguePagination({ page, totalPages, onPrevious, onNext }: {
  page: number;
  totalPages: number;
  onPrevious: () => void;
  onNext: () => void;
}) {
  return <nav className="catalogue-pagination" aria-label="Product pages">
    <button type="button" disabled={page <= 1} onClick={onPrevious}>Previous</button>
    <span aria-live="polite">Page {page} of {totalPages}</span>
    <button type="button" disabled={page >= totalPages} onClick={onNext}>Next</button>
  </nav>;
}

export function CatalogueSkeletonGrid({ count = 8 }: { count?: number }) {
  return <div className="product-grid product-skeleton-grid" role="status" aria-label="Loading devices" aria-busy="true">
    {Array.from({ length: count }, (_, index) => <div className="product-skeleton-card" key={index} aria-hidden="true">
      <div className="product-skeleton-image" />
      <div className="product-skeleton-copy"><span /><span /><span /></div>
    </div>)}
  </div>;
}

export function CatalogueStatus({ state, hasFilters = false, onClear }: CatalogueStatusProps) {
  if (state === "loading") {
    return <div className="catalogue-state" role="status"><Sparkles size={25} /><h2>Loading the collection</h2><p>Checking the latest verified devices.</p></div>;
  }
  if (state === "error") {
    return <div className="catalogue-state pending" role="alert"><CircleHelp size={27} /><h2>The live collection is currently unavailable.</h2><p>We could not load the verified collection. Please try again or ask our team about availability.</p><Link className="button text" to="/contact">Ask about availability</Link></div>;
  }
  return <div className="catalogue-state" role="status"><Search size={25} /><h2>{hasFilters ? "No devices match these filters." : "No published devices yet."}</h2><p>{hasFilters ? "Try a different brand, model or category." : "The live catalogue is being prepared. Check back soon or ask our team about availability."}</p>{hasFilters && onClear && <button type="button" className="button text" onClick={onClear}>Clear filters <X size={16} /></button>}</div>;
}
