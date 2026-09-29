import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AuthenticatedPageShell } from "./authenticated-page-shell";

describe("authenticated page shell", () => {
  it("wraps private detail content in consistent navigation landmarks", () => {
    const markup = renderToStaticMarkup(
      <AuthenticatedPageShell current="Zákazky">
        <p>Súkromný detail</p>
      </AuthenticatedPageShell>,
    );

    expect(markup).toContain('aria-label="Navigácia účtu"');
    expect(markup).toContain('aria-label="Mobilná navigácia"');
    expect(markup).toContain('id="main-content"');
    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain("Súkromný detail");
  });
});
