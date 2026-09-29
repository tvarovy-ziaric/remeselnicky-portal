import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AccountVerification } from "./account-verification";
import {
  EmailVerificationResult,
  takeEmailVerificationTokenFromFragment,
} from "./email-verification-result";
import { RegistrationForm } from "./registration-form";

describe("auth onboarding UI", () => {
  it("renders accessible invitation registration without provider or secret fields", () => {
    const markup = renderToStaticMarkup(<RegistrationForm />);
    expect(markup).toContain('href="#main-content"');
    expect(markup).toContain('id="main-content"');
    expect(markup).toContain("Vytvorte si účet");
    expect(markup).toContain("Registrácia je len na pozvanie");
    expect(markup).toContain(
      "jeden účet pre zákaznícke aj remeselnícke aktivity",
    );
    expect(markup).toContain('autoComplete="email"');
    expect(markup).toContain('autoComplete="new-password"');
    expect(markup).toContain('minLength="12"');
    expect(markup).toContain("Potvrdzujem, že mám aspoň 18 rokov.");
    expect(markup).toContain('href="/prihlasenie"');
    expect(markup).not.toMatch(/token|claim|signing|sink/iu);
  });

  it("starts verification from authoritative session loading", () => {
    const markup = renderToStaticMarkup(<AccountVerification />);
    expect(markup).toContain("Overenie účtu");
    expect(markup).toContain("Načítavam stav overenia");
    expect(markup).toContain("Stav účtu");
    expect(markup).not.toContain("Pokračovať v dopyte");
  });

  it("presents email verification without exposing implementation states", () => {
    const markup = renderToStaticMarkup(<EmailVerificationResult />);
    expect(markup).toContain("Overenie e-mailu");
    expect(markup).toContain("Kontrolujem odkaz");
    expect(markup).toContain("jednorazový");
    expect(markup).not.toMatch(/LOADING|INVALID|RATE_LIMITED|UNAVAILABLE/);
  });

  it("strips the fragment before returning a one-time email token", () => {
    const replace = vi.fn();
    const token = "a".repeat(48);
    const liveLocation = {
      hash: `#token=${token}`,
      pathname: "/overenie-emailu",
      search: "",
    };
    expect(
      takeEmailVerificationTokenFromFragment(
        liveLocation,
        vi.fn(() => {
          liveLocation.hash = "";
        }),
      ),
    ).toBe(token);
    expect(liveLocation.hash).toBe("");
    takeEmailVerificationTokenFromFragment(
      {
        hash: `#token=${token}`,
        pathname: "/overenie-emailu",
        search: "",
      },
      replace,
    );
    expect(replace).toHaveBeenCalledWith("/overenie-emailu");
    expect(
      takeEmailVerificationTokenFromFragment(
        {
          hash: `#token=${token}&extra=1`,
          pathname: "/overenie-emailu",
          search: "?token=ignored",
        },
        replace,
      ),
    ).toBeNull();
    expect(replace).toHaveBeenLastCalledWith("/overenie-emailu");
  });
});
