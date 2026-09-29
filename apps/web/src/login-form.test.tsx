import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AuthOnboardingSession } from "./auth-onboarding-client";
import { LoginForm, loginDestination } from "./login-form";

const session = {
  csrfToken: "csrf-token-with-safe-length",
  user: {
    accountState: "ACTIVE",
    adultAttestedAt: "2026-09-28T08:00:00.000Z",
    emailVerified: true,
    id: "97000000-0000-4000-8000-000000000203",
    phoneVerified: true,
  },
} as const satisfies AuthOnboardingSession;

describe("login form", () => {
  it("offers a clear, accessible continuation without losing draft context", () => {
    const markup = renderToStaticMarkup(<LoginForm />);
    expect(markup).toContain('href="#main-content"');
    expect(markup).toContain('id="main-content"');
    expect(markup).toContain("Vitajte späť");
    expect(markup).toContain("Rozpracovaný dopyt zostane zachovaný.");
    expect(markup).toContain('autoComplete="username"');
    expect(markup).toContain('autoComplete="current-password"');
    expect(markup).toContain('href="/registracia"');
    expect(markup).toContain("Zaregistrovať sa s pozvánkou");
    expect(markup).not.toMatch(
      /AUTHENTICATED|INVALID_CREDENTIALS|RATE_LIMITED/,
    );
  });

  it("routes incomplete verification to onboarding", () => {
    expect(loginDestination(session)).toBe("/dopyt");
    expect(
      loginDestination({
        ...session,
        user: { ...session.user, phoneVerified: false },
      }),
    ).toBe("/overenie");
  });
});
