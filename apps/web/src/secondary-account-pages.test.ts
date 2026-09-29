import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import PrivacyPage from "./app/ucet/sukromie/page";
import NotificationsPage from "./app/ucet/upozornenia/page";

function visibleText(markup: string): string {
  return markup
    .replace(/<[^>]*>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

describe("secondary account pages", () => {
  it("renders the canonical notification inbox with explicit read semantics", () => {
    const markup = renderToStaticMarkup(React.createElement(NotificationsPage));
    const text = visibleText(markup);

    expect(markup).toContain('href="#main-content"');
    expect(markup).toContain('id="main-content"');
    expect(markup).toContain('aria-label="Navigácia účtu"');
    expect(markup).toContain('aria-label="Mobilná navigácia"');
    expect(text).toContain("Hlavný prehľad udalostí");
    expect(text).toContain("Všetky");
    expect(text).toContain("Neprečítané");
    expect(text).toContain("Označiť všetky ako prečítané");
    expect(text).toContain("nikdy nepotvrdzuje ponuku");
    expect(text).toContain("povinné transakčné a bezpečnostné správy");
    expect(text).not.toMatch(/\b(?:ALL|UNREAD|IMPORTANT|CRITICAL)\b/u);
  });

  it("renders privacy requests as controlled workflows without cascade-delete promises", () => {
    const markup = renderToStaticMarkup(React.createElement(PrivacyPage));
    const text = visibleText(markup);

    expect(markup).toContain('id="main-content"');
    expect(text).toContain("Súkromie a moje údaje");
    expect(text).toContain("kontrolovaný workflow");
    expect(text).toContain("samo osebe nič okamžite nemaže");
    expect(text).toContain("Moje žiadosti");
    expect(text).toContain("Prístup k mojim údajom");
    expect(text).toContain("Zatvorenie účtu");
    expect(text).not.toMatch(
      /\b(?:ACCOUNT_CLOSURE|IDENTITY_VERIFICATION_PENDING|IN_REVIEW)\b/u,
    );
  });
});
