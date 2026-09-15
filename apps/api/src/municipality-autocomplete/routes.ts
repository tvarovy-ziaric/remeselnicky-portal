import type { MunicipalityAutocompletePersistence } from "@portal/db";
import type { FastifyInstance } from "fastify";

import type { PublicSearchAdmission } from "../public-search-cards/routes.js";

export const MUNICIPALITY_AUTOCOMPLETE_PATH =
  "/v1/public/municipalities/suggestions" as const;

export interface MunicipalityAutocompleteRouteDependencies {
  readonly admission: PublicSearchAdmission;
  readonly municipalities: MunicipalityAutocompletePersistence;
}

export function registerMunicipalityAutocompleteRoutes(
  app: FastifyInstance,
  dependencies: MunicipalityAutocompleteRouteDependencies,
): void {
  app.get<{
    Querystring: Record<string, string | readonly string[] | undefined>;
  }>(MUNICIPALITY_AUTOCOMPLETE_PATH, async (request, reply) => {
    void reply.header("cache-control", "no-store");
    void reply.header("x-robots-tag", "noindex, nofollow");
    const keys = Object.keys(request.query);
    if (
      keys.length !== 1 ||
      keys[0] !== "q" ||
      typeof request.query.q !== "string" ||
      request.query.q.length < 2 ||
      request.query.q.length > 80 ||
      /[\r\n\p{Cc}]/u.test(request.query.q)
    ) {
      return reply.code(400).send({ code: "INVALID_MUNICIPALITY_QUERY" });
    }
    try {
      const admission = await dependencies.admission.admit({ ip: request.ip });
      if (admission === "RATE_LIMITED") {
        return reply.code(429).send({ code: "RATE_LIMITED" });
      }
      const suggestions = await dependencies.municipalities.suggest(
        request.query.q,
      );
      return reply.send({ suggestions });
    } catch {
      return reply
        .code(503)
        .send({ code: "MUNICIPALITY_AUTOCOMPLETE_UNAVAILABLE" });
    }
  });
}
