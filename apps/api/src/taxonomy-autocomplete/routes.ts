import type { TaxonomyAutocomplete } from "@portal/search";
import type { FastifyInstance } from "fastify";

export const TAXONOMY_AUTOCOMPLETE_PATH =
  "/v1/public/taxonomy/suggestions" as const;

export interface TaxonomyAutocompleteRouteDependencies {
  readonly autocomplete: TaxonomyAutocomplete;
}

type QueryString = Record<string, string | readonly string[] | undefined>;

export function registerTaxonomyAutocompleteRoutes(
  app: FastifyInstance,
  dependencies: TaxonomyAutocompleteRouteDependencies,
): void {
  app.get<{ Querystring: QueryString }>(
    TAXONOMY_AUTOCOMPLETE_PATH,
    async (request, reply) => {
      void reply.header("cache-control", "no-store");
      void reply.header("x-robots-tag", "noindex, nofollow");

      if (!hasOnlyKnownScalarParameters(request.query)) {
        return reply.code(400).send({ code: "INVALID_TAXONOMY_QUERY" });
      }

      try {
        const result = await dependencies.autocomplete.autocomplete({
          limit: request.query.limit,
          query: request.query.q,
        });
        if (result.status === "INVALID_QUERY") {
          return reply.code(400).send({ code: "INVALID_TAXONOMY_QUERY" });
        }
        return reply.send({ suggestions: result.suggestions });
      } catch {
        return reply
          .code(503)
          .send({ code: "TAXONOMY_AUTOCOMPLETE_UNAVAILABLE" });
      }
    },
  );
}

function hasOnlyKnownScalarParameters(query: QueryString): boolean {
  const keys = Object.keys(query);
  return (
    keys.length >= 1 &&
    keys.length <= 2 &&
    keys.includes("q") &&
    keys.every((key) => key === "q" || key === "limit") &&
    typeof query.q === "string" &&
    (query.limit === undefined || typeof query.limit === "string")
  );
}
