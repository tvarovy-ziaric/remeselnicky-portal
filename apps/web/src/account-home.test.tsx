import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AccountHome } from "./account-home";
import AccountPage from "./app/ucet/page";

describe("account home", () => {
  it("starts from authoritative session loading", () => {
    const markup = renderToStaticMarkup(<AccountHome />);
    expect(markup).toContain("Načítavam váš účet");
  });

  it("uses a session-aware shell instead of assuming either account context", () => {
    const markup = renderToStaticMarkup(<AccountPage />);
    expect(markup).toContain('id="main-content"');
    expect(markup).not.toContain("Prihlásiť sa");
    expect(markup).not.toContain("Pokračovať v dopyte");
  });
});
