import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import QuoteComparisonPage from "./app/ziadosti/[jobRequestId]/ponuky/page";

const jobRequestId = "83000000-0000-4000-8000-000000000001";

describe("quote comparison page shell", () => {
  it("renders the authenticated navigation and one labelled main boundary", async () => {
    const page = await QuoteComparisonPage({
      params: Promise.resolve({ jobRequestId }),
    });
    expect(React.isValidElement(page)).toBe(true);
    const html = renderToStaticMarkup(page);

    expect(html).toContain('href="#main-content"');
    expect(html).toContain('id="main-content"');
    expect(html).toContain('aria-label="Navigácia účtu"');
    expect(html).toContain('aria-label="Mobilná navigácia"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("Porovnanie ponúk");
    expect(html).toContain("Portál neurčuje víťaza");
    expect(html).toContain("Načítavam ponuky");
  });
});
