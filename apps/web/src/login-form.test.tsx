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
  it("offers invitation registration and safe autocomplete", () => {
    const markup = renderToStaticMarkup(<LoginForm />);
    expect(markup).toContain('autoComplete="username"');
    expect(markup).toContain('autoComplete="current-password"');
    expect(markup).toContain('href="/registracia"');
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
