import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import HomePage from "./app/page";

describe("public home page", () => {
  it("shows both primary journeys with truthful destinations", () => {
    const markup = renderToStaticMarkup(<HomePage />);

    expect(markup).toContain("Potrebujem remeselníka");
    expect(markup).toContain('href="/dopyt"');
    expect(markup).toContain("Som remeselník");
    expect(markup).toContain('href="/prihlasenie"');
    expect(markup).toContain("prístup remeselníkov do alfy je na pozvánku");
  });

  it("explains the five-step customer journey", () => {
    const markup = renderToStaticMarkup(<HomePage />);

    for (const title of [
      "Opíšete, čo potrebujete",
      "Vyberiete si remeselníkov",
      "Porovnáte ponuky",
      "Potvrdíte dohodu",
      "Máte priebeh na jednom mieste",
    ]) {
      expect(markup).toContain(title);
    }
  });

  it("does not expose implementation terminology or invented proof", () => {
    const markup = renderToStaticMarkup(<HomePage />);

    expect(markup).not.toContain("Web Alpha");
    expect(markup).not.toContain("Zdieľaný kontrakt API");
    expect(markup).not.toMatch(/\d+\s*(hodnotení|remeselníkov|zákaziek)/i);
    expect(markup).not.toContain("98 %");
  });

  it("contains a skip link and labelled primary landmarks", () => {
    const markup = renderToStaticMarkup(<HomePage />);

    expect(markup).toContain('href="#main-content"');
    expect(markup).toContain('id="main-content"');
    expect(markup).toContain('aria-label="Hlavná navigácia"');
    expect(markup).toContain('aria-labelledby="home-title"');
  });
});
