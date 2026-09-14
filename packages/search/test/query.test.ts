import { describe, expect, it } from "vitest";

import {
  normalizeTaxonomySearchText,
  parseTaxonomyAutocompleteQuery,
  TAXONOMY_AUTOCOMPLETE_DEFAULT_LIMIT,
  TAXONOMY_AUTOCOMPLETE_MAX_QUERY_LENGTH,
  TAXONOMY_AUTOCOMPLETE_MAX_TOKENS,
} from "../src/index.js";

describe("taxonomy autocomplete query parser", () => {
  it("normalizes Slovak diacritics, case, punctuation, and duplicate tokens", () => {
    expect(normalizeTaxonomySearchText("  ŠTUKATÉR / murár  ")).toBe(
      "stukater murar",
    );
    expect(
      parseTaxonomyAutocompleteQuery({ query: "  ŠTUKATÉR, štukatér " }),
    ).toEqual({
      query: {
        limit: TAXONOMY_AUTOCOMPLETE_DEFAULT_LIMIT,
        normalizedText: "stukater stukater",
        tokens: ["stukater"],
      },
      status: "VALID",
    });
  });

  it.each([
    undefined,
    null,
    "",
    "   ",
    "\u0000murár",
    "🎨",
    "private@example.test",
    "+421 900 123 456",
    "www.example.test",
    "@majster",
    "ulica Hlavná 10",
    "api key abc123",
    "a b c d e f g h i",
    "x".repeat(TAXONOMY_AUTOCOMPLETE_MAX_QUERY_LENGTH + 1),
  ])(
    "rejects malformed or oversized query input without echoing it: %j",
    (query) => {
      expect(parseTaxonomyAutocompleteQuery({ query })).toEqual({
        status: "INVALID_QUERY",
      });
    },
  );

  it("enforces token and result limits instead of truncating", () => {
    const tooManyTokens = Array.from(
      { length: TAXONOMY_AUTOCOMPLETE_MAX_TOKENS + 1 },
      (_, index) => `t${index}`,
    ).join(" ");
    expect(parseTaxonomyAutocompleteQuery({ query: tooManyTokens })).toEqual({
      status: "INVALID_QUERY",
    });
    for (const limit of [0, 21, 1.5, "02", "x", ["2", "3"]]) {
      expect(parseTaxonomyAutocompleteQuery({ limit, query: "murár" })).toEqual(
        { status: "INVALID_QUERY" },
      );
    }
    expect(
      parseTaxonomyAutocompleteQuery({ limit: "20", query: "murár" }),
    ).toMatchObject({ query: { limit: 20 }, status: "VALID" });
  });
});
