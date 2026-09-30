import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  AccountContextSwitch,
  AuthenticatedHeader,
  MobileBottomNavigation,
  PublicHeader,
  SessionAwareHeader,
  accountContextForPath,
  accountNavigation,
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
      "Remeselníci",
      "Zákazky",
      "Správy",
      "Zákazník",
      "Remeselník",
      "Odhlásiť sa",
    ]) {
      expect(markup).toContain(label);
    }
    expect(markup).not.toContain("Prihlásiť sa");
  });

  it("keeps both account contexts explicit and maps role-specific paths", () => {
    expect(accountContextForPath("/dopyt")).toBe("CUSTOMER");
    expect(accountContextForPath("/ucet/profil-remeselnika")).toBe("CRAFTSMAN");
    expect(accountContextForPath("/zakazky")).toBeNull();
    expect(accountNavigation("CUSTOMER").map((item) => item.label)).toContain(
      "Dopyty",
    );
    expect(accountNavigation("CRAFTSMAN").map((item) => item.label)).toContain(
      "Pozvánky",
    );
    const switchMarkup = renderToStaticMarkup(
      <AccountContextSwitch context="CRAFTSMAN" />,
    );
    expect(switchMarkup).toContain('href="/dopyt"');
    expect(switchMarkup).toContain('href="/ucet/profil-remeselnika"');
    expect(switchMarkup).toContain('aria-current="page"');
  });

  it("does not flash a login action while session state is loading", () => {
    const markup = renderToStaticMarkup(<SessionAwareHeader />);
    expect(markup).not.toContain("Prihlásiť sa");
    expect(markup).not.toContain("Vytvoriť dopyt");
  });

  it("marks the current mobile destination semantically", () => {
    const markup = renderToStaticMarkup(
      <MobileBottomNavigation current="Zákazky" />,
    );

    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain('aria-label="Mobilná navigácia"');
  });
});
