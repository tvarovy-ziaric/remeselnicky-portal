import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import JobsPage from "./page";

describe("jobs overview page", () => {
  it("uses the authenticated application shell", () => {
    const html = renderToStaticMarkup(<JobsPage />);

    expect(html).toContain('class="app-shell"');
    expect(html).toContain('class="site-header site-header--authenticated"');
    expect(html).toContain('aria-label="Navigácia účtu"');
    expect(html).toContain('id="main-content"');
    expect(html).toContain("Moje zákazky");
    expect(html).toContain('aria-label="Mobilná navigácia"');
    expect(html).toMatch(/aria-current="page" href="\/zakazky">Zákazky<\/a>/);
  });
});
