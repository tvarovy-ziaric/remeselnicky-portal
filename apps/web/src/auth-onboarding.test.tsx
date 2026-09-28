import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AccountVerification } from "./account-verification";
import { takeEmailVerificationTokenFromFragment } from "./email-verification-result";
import { RegistrationForm } from "./registration-form";

describe("auth onboarding UI", () => {
  it("renders accessible invitation registration without provider or secret fields", () => {
    const markup = renderToStaticMarkup(<RegistrationForm />);
    expect(markup).toContain("Registrácia do Web Alpha");
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
    expect(markup).not.toContain("/dopyt");
  });

  it("strips the fragment before returning a one-time email token", () => {
    const replace = vi.fn();
    const token = "a".repeat(48);
    expect(
      takeEmailVerificationTokenFromFragment(
        {
          hash: `#token=${token}`,
          pathname: "/overenie-emailu",
          search: "",
        },
        replace,
      ),
    ).toBe(token);
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
