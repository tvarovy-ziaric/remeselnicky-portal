import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  AuthenticatedHeader,
  MobileBottomNavigation,
  PublicHeader,
} from "./site-shell";

describe("site shell", () => {
  it("keeps public navigation focused on the four primary destinations", () => {
    const markup = renderToStaticMarkup(<PublicHeader />);

    expect(markup).toContain("Remeselníci");
    expect(markup).toContain("Ako to funguje");
    expect(markup).toContain("Vytvoriť dopyt");
    expect(markup).toContain("Prihlásiť sa");
    expect(markup).not.toContain("Administrácia");
    expect(markup).not.toContain("Súkromie a moje údaje");
  });

  it("uses the product mental model in authenticated navigation", () => {
    const markup = renderToStaticMarkup(<AuthenticatedHeader />);

    for (const label of [
      "Prehľad",
      "Dopyty",
      "Zákazky",
      "Správy",
      "Profil a účet",
    ]) {
      expect(markup).toContain(label);
    }
  });

  it("marks the current mobile destination semantically", () => {
    const markup = renderToStaticMarkup(
      <MobileBottomNavigation current="Zákazky" />,
    );

    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain('aria-label="Mobilná navigácia"');
  });
});
