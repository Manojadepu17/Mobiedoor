import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CataloguePagination, CatalogueStatus } from "./catalogue-components";

vi.mock("react-router-dom", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
}));

function renderStatus(props: React.ComponentProps<typeof CatalogueStatus>) {
  return renderToStaticMarkup(<CatalogueStatus {...props} />);
}

describe("catalogue loading, error, and empty states", () => {
  it("renders a clear loading status", () => {
    const markup = renderStatus({ state: "loading" });
    expect(markup).toContain('role="status"');
    expect(markup).toContain("Loading the collection");
  });

  it("renders an actionable error state", () => {
    const markup = renderStatus({ state: "error" });
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("The live collection is currently unavailable.");
    expect(markup).toContain('href="/contact"');
  });

  it("distinguishes an empty catalogue from empty filter results", () => {
    expect(renderStatus({ state: "empty" })).toContain("No published devices yet.");
    const filtered = renderStatus({ state: "empty", hasFilters: true, onClear: () => {} });
    expect(filtered).toContain("No devices match these filters.");
    expect(filtered).toContain("Clear filters");
  });

  it("displays the current page and disables navigation at page boundaries", () => {
    const firstPage = renderToStaticMarkup(<CataloguePagination page={1} totalPages={4} onPrevious={() => {}} onNext={() => {}} />);
    expect(firstPage).toContain("Page 1 of 4");
    expect(firstPage).toContain('aria-label="Product pages"');
    expect(firstPage.match(/disabled=""/g)).toHaveLength(1);
    const lastPage = renderToStaticMarkup(<CataloguePagination page={4} totalPages={4} onPrevious={() => {}} onNext={() => {}} />);
    expect(lastPage).toContain("Page 4 of 4");
    expect(lastPage.match(/disabled=""/g)).toHaveLength(1);
    expect(renderToStaticMarkup(<CataloguePagination page={1} totalPages={1} onPrevious={() => {}} onNext={() => {}} />))
      .toContain("Page 1 of 1");
  });
});
