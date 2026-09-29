import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import CraftsmanProfilePage from "./page";

describe("craftsman profile account page", () => {
  it("keeps private authoring inside the authenticated application shell", () => {
    const html = renderToStaticMarkup(<CraftsmanProfilePage />);

    expect(html).toContain('class="app-shell"');
    expect(html).toContain('class="site-header site-header--authenticated"');
    expect(html).toContain('id="main-content"');
    expect(html).toContain("Načítavam profil remeselníka");
    expect(html).toContain('href="/ucet/portfolio"');
    expect(html).toContain('href="/ucet/doklady"');
    expect(html).toMatch(
      /aria-current="page" href="\/ucet\/profil-remeselnika">Profil a účet<\/a>/,
    );
  });
});
