import type {
  TaxonomyAutocomplete,
  TaxonomyAutocompleteSuggestion,
} from "@portal/search";
import { createTaxonomyAutocompleteService } from "@portal/search";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  registerTaxonomyAutocompleteRoutes,
  TAXONOMY_AUTOCOMPLETE_PATH,
} from "./routes.js";

const openApps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe("taxonomy autocomplete route", () => {
  it("returns bounded public suggestions without echoing the query", async () => {
    const autocomplete = service({
      status: "OK",
      suggestions: [suggestion()],
    });
    const response = await appWith(autocomplete).inject({
      method: "GET",
      url: `${TAXONOMY_AUTOCOMPLETE_PATH}?q=kachlickar&limit=5`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(response.json()).toEqual({ suggestions: [suggestion()] });
    expect(response.body).not.toMatch(/kachlickar|query/iu);
    expect(autocomplete.autocomplete.mock.calls).toEqual([
      [{ limit: "5", query: "kachlickar" }],
    ]);
  });

  it.each([
    "",
    "?q=obkladac&q=murar",
    "?q=obkladac&limit=5&limit=6",
    "?q=obkladac&debug=true",
    "?limit=5",
  ])(
    "rejects missing, duplicate, or unknown parameters: %s",
    async (suffix) => {
      const autocomplete = service({ status: "OK", suggestions: [] });
      const response = await appWith(autocomplete).inject({
        method: "GET",
        url: `${TAXONOMY_AUTOCOMPLETE_PATH}${suffix}`,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ code: "INVALID_TAXONOMY_QUERY" });
      expect(autocomplete.autocomplete.mock.calls).toEqual([]);
    },
  );

  it("uses a query-free error response for malformed content", async () => {
    const findCandidates = vi.fn(() => Promise.resolve([]));
    const autocomplete = createTaxonomyAutocompleteService({ findCandidates });
    const response = await appWith(autocomplete).inject({
      method: "GET",
      url: `${TAXONOMY_AUTOCOMPLETE_PATH}?q=private%40example.test`,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: "INVALID_TAXONOMY_QUERY" });
    expect(response.body).not.toMatch(/private|example|query.*@/iu);
    expect(findCandidates.mock.calls).toEqual([]);
  });

  it("does not expose persistence errors", async () => {
    const autocomplete = {
      autocomplete: vi.fn(() =>
        Promise.reject(
          new Error("postgres://owner:secret@db/raw-taxonomy-query"),
        ),
      ),
    };
    const response = await appWith(autocomplete).inject({
      method: "GET",
      url: `${TAXONOMY_AUTOCOMPLETE_PATH}?q=obkladac`,
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      code: "TAXONOMY_AUTOCOMPLETE_UNAVAILABLE",
    });
    expect(response.body).not.toMatch(/secret|postgres|obkladac/iu);
  });
});

function appWith(autocomplete: TaxonomyAutocomplete) {
  const app = Fastify({ logger: false });
  registerTaxonomyAutocompleteRoutes(app, { autocomplete });
  openApps.push(app);
  return app;
}

function service(
  result:
    | { readonly status: "INVALID_QUERY" }
    | {
        readonly status: "OK";
        readonly suggestions: readonly TaxonomyAutocompleteSuggestion[];
      },
): TaxonomyAutocomplete & {
  readonly autocomplete: ReturnType<typeof vi.fn>;
} {
  return { autocomplete: vi.fn(() => Promise.resolve(result)) };
}

function suggestion(): TaxonomyAutocompleteSuggestion {
  return {
    code: "PROF:TILER",
    kind: "PROFESSION",
    label: "Obkladač",
    matchedBy: "EXACT_CANONICAL",
    professionCodes: ["PROF:TILER"],
  };
}
