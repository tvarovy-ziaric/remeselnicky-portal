import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { TaxonomySuggestionDetail } from "./taxonomy-suggestion-detail";
import type { TaxonomySuggestionClient } from "./taxonomy-suggestion-client";

describe("taxonomy suggestion owner detail", () => {
  it("starts with a private bounded loading state", () => {
    const client: TaxonomySuggestionClient = {
      load: vi.fn(
        () =>
          new Promise<never>(() => {
            // Deliberately pending so the server-rendered state stays LOADING.
          }),
      ),
      submit: vi.fn(),
    };
    const html = renderToStaticMarkup(
      <TaxonomySuggestionDetail
        client={client}
        suggestionId="10000000-0000-4000-8000-000000000001"
      />,
    );
    expect(html).toContain("Načítavam výsledok posúdenia");
    expect(html).not.toMatch(/adminDecisionNote|requesterUserId/u);
  });
});
