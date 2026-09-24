import { platformContract } from "@portal/contracts";
import type { DatabaseHealthProbe } from "@portal/db";
import Fastify, { type FastifyInstance } from "fastify";

import {
  registerAuthModule,
  type AuthModuleDependencies,
} from "./auth/index.js";
import {
  registerApiObservability,
  type ApiObservabilityDependencies,
} from "./observability.js";
import {
  registerPublicCraftsmanProfileRoutes,
  type PublicCraftsmanProfileRouteDependencies,
} from "./public-craftsman-profile/routes.js";
import {
  registerPublicCraftsmanReviewRoutes,
  type PublicCraftsmanReviewRouteDependencies,
} from "./public-craftsman-reviews/routes.js";
import {
  registerPublicPortfolioMediaRoutes,
  type PublicPortfolioMediaRouteDependencies,
} from "./public-portfolio-media/routes.js";
import {
  registerTaxonomyAutocompleteRoutes,
  type TaxonomyAutocompleteRouteDependencies,
} from "./taxonomy-autocomplete/routes.js";
import {
  registerPublicSearchCardRoutes,
  type PublicSearchCardRouteDependencies,
} from "./public-search-cards/routes.js";
import {
  registerMunicipalityAutocompleteRoutes,
  type MunicipalityAutocompleteRouteDependencies,
} from "./municipality-autocomplete/routes.js";

export interface ApiDependencies {
  readonly auth?: AuthModuleDependencies;
  readonly database: DatabaseHealthProbe;
  readonly observability?: ApiObservabilityDependencies;
  readonly publicCraftsmanProfiles?: PublicCraftsmanProfileRouteDependencies;
  readonly publicCraftsmanReviews?: PublicCraftsmanReviewRouteDependencies;
  readonly publicPortfolioMedia?: PublicPortfolioMediaRouteDependencies;
  readonly publicSearchCards?: PublicSearchCardRouteDependencies;
  readonly taxonomyAutocomplete?: TaxonomyAutocompleteRouteDependencies;
  readonly municipalityAutocomplete?: MunicipalityAutocompleteRouteDependencies;
}

export function buildApi(dependencies: ApiDependencies): FastifyInstance {
  const trustProxyHops = dependencies.auth?.config.trustProxyHops ?? 0;
  const app = Fastify({
    logger: false,
    trustProxy:
      trustProxyHops === 0
        ? false
        : (_address: string, hop: number) => hop < trustProxyHops,
  });

  const metrics = registerApiObservability(app, dependencies.observability);

  if (dependencies.auth !== undefined) {
    registerAuthModule(app, dependencies.auth);
  }
  if (dependencies.publicCraftsmanProfiles !== undefined) {
    registerPublicCraftsmanProfileRoutes(
      app,
      dependencies.publicCraftsmanProfiles,
    );
  }
  if (dependencies.publicCraftsmanReviews !== undefined) {
    registerPublicCraftsmanReviewRoutes(
      app,
      dependencies.publicCraftsmanReviews,
    );
  }
  if (dependencies.publicPortfolioMedia !== undefined) {
    registerPublicPortfolioMediaRoutes(app, dependencies.publicPortfolioMedia);
  }
  if (dependencies.publicSearchCards !== undefined) {
    registerPublicSearchCardRoutes(app, dependencies.publicSearchCards);
  }
  if (dependencies.taxonomyAutocomplete !== undefined) {
    registerTaxonomyAutocompleteRoutes(app, dependencies.taxonomyAutocomplete);
  }
  if (dependencies.municipalityAutocomplete !== undefined) {
    registerMunicipalityAutocompleteRoutes(
      app,
      dependencies.municipalityAutocomplete,
    );
  }

  app.get("/", () => ({
    apiVersion: platformContract.apiVersion,
    service: "api",
    status: "ok",
  }));

  app.get("/health/live", () => ({ status: "ok" }));

  app.get("/health/ready", async (_request, reply) => {
    const startedAt = performance.now();
    try {
      await dependencies.database.ping();
      recordDatabaseProbe(metrics, "available", performance.now() - startedAt);

      return {
        checks: { database: "available" },
        status: "ready",
      };
    } catch {
      recordDatabaseProbe(
        metrics,
        "unavailable",
        performance.now() - startedAt,
      );
      return reply.code(503).send({
        checks: { database: "unavailable" },
        status: "not_ready",
      });
    }
  });

  return app;
}

function recordDatabaseProbe(
  metrics: ReturnType<typeof registerApiObservability>,
  result: "available" | "unavailable",
  durationMs: number,
): void {
  try {
    metrics.recordDatabaseProbe({ durationMs, result });
  } catch {
    // Health checks reflect the dependency, never telemetry availability.
  }
}
