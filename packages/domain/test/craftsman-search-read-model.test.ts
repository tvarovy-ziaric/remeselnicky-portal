import { describe, expect, it } from "vitest";

import {
  CraftsmanSearchValidationError,
  normalizeSearchCraftsmanCandidatesInput,
  SEARCH_CANDIDATE_DEFAULT_LIMIT,
} from "../src/craftsman-search-read-model.js";

describe("craftsman search read-model input", () => {
  it("normalizes identity text and applies a bounded default page", () => {
    expect(
      normalizeSearchCraftsmanCandidatesInput({
        identityQuery: "  Jozef\tRemeselník  ",
      }),
    ).toEqual({
      afterProfileId: null,
      identityQuery: "Jozef Remeselník",
      limit: SEARCH_CANDIDATE_DEFAULT_LIMIT,
    });
    expect(
      normalizeSearchCraftsmanCandidatesInput({ identityQuery: "  " }),
    ).toMatchObject({ identityQuery: null });
  });

  it.each([
    { limit: 0 },
    { limit: 51 },
    { limit: 1.5 },
    { afterProfileId: "not-a-uuid" },
    { identityQuery: "x".repeat(121) },
    { identityQuery: "bad\nquery" },
  ])("rejects malformed or technically unsafe input %#", (input) => {
    expect(() => normalizeSearchCraftsmanCandidatesInput(input)).toThrow(
      CraftsmanSearchValidationError,
    );
  });
});
