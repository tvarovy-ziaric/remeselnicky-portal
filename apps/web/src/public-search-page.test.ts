import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import CraftsmanSearchPage, {
  publicSearchNextPageHref,
} from "./app/remeselnici/page";

const nextCursor = "99000000-0000-4000-8000-000000000099";

describe("public search pagination", () => {
  it("uses the public shell and a labelled main content boundary", async () => {
    const page = await CraftsmanSearchPage({
      searchParams: Promise.resolve({}),
    });
    expect(React.isValidElement(page)).toBe(true);
    const html = renderToStaticMarkup(page);

    expect(html).toContain('href="#main-content"');
    expect(html).toContain('id="main-content"');
    expect(html).toContain('aria-label="Hlavná navigácia"');
    expect(html).toContain("Nájdite remeselníka pre svoju prácu");
    expect(html).toContain('aria-label="Filtre vyhľadávania"');
    expect(html).toContain('id="public-search-results-title"');
    expect(html).toContain("Jednoduchšie hľadanie remeselníkov");
  });

  it("replaces the cursor while preserving governed filters and request context", () => {
    const href = publicSearchNextPageHref({
      jobRequestId: "99000000-0000-4000-8000-000000000010",
      nextCursor,
      searchParameters: {
        afterProfileId: "99000000-0000-4000-8000-000000000001",
        municipalityCode: "SK-BA",
        professionCode: "PROF:TILER",
        skillCodes: ["SKILL:CUT", "SKILL:GROUT"],
        sort: "RECOMMENDED",
      },
    });
    const url = new URL(href, "http://portal.local");

    expect(url.pathname).toBe("/remeselnici");
    expect(url.searchParams.get("afterProfileId")).toBe(nextCursor);
    expect(url.searchParams.get("professionCode")).toBe("PROF:TILER");
    expect(url.searchParams.get("municipalityCode")).toBe("SK-BA");
    expect(url.searchParams.getAll("skillCodes")).toEqual([
      "SKILL:CUT",
      "SKILL:GROUT",
    ]);
    expect(url.searchParams.get("sort")).toBe("RECOMMENDED");
    expect(url.searchParams.get("jobRequestId")).toBe(
      "99000000-0000-4000-8000-000000000010",
    );
    expect(url.searchParams.has("jobId")).toBe(false);
  });

  it("preserves only one unambiguous job context", () => {
    const jobHref = publicSearchNextPageHref({
      jobId: "99000000-0000-4000-8000-000000000020",
      nextCursor,
      searchParameters: { professionCode: "PROF:TILER" },
    });
    const ambiguousHref = publicSearchNextPageHref({
      jobId: "99000000-0000-4000-8000-000000000020",
      jobRequestId: "99000000-0000-4000-8000-000000000010",
      nextCursor,
      searchParameters: { professionCode: "PROF:TILER" },
    });

    expect(
      new URL(jobHref, "http://portal.local").searchParams.get("jobId"),
    ).toBe("99000000-0000-4000-8000-000000000020");
    const ambiguous = new URL(ambiguousHref, "http://portal.local");
    expect(ambiguous.searchParams.has("jobId")).toBe(false);
    expect(ambiguous.searchParams.has("jobRequestId")).toBe(false);
  });
});
