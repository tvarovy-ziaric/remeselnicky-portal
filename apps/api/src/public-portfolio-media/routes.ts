import {
  PUBLIC_PORTFOLIO_MEDIA_PATH,
  type PublicPortfolioDeliveryResolver,
} from "@portal/media";
import type { FastifyInstance } from "fastify";

export interface PublicPortfolioMediaRouteDependencies {
  readonly delivery: PublicPortfolioDeliveryResolver;
}

const notFoundBody = Object.freeze({ code: "MEDIA_NOT_FOUND" as const });

export function registerPublicPortfolioMediaRoutes(
  app: FastifyInstance,
  dependencies: PublicPortfolioMediaRouteDependencies,
): void {
  app.get<{ Params: { mediaAssetId: string } }>(
    PUBLIC_PORTFOLIO_MEDIA_PATH,
    async (request, reply) => {
      void reply.header("cache-control", "private, no-store");
      void reply.header("x-content-type-options", "nosniff");

      try {
        const response = await dependencies.delivery.resolve(
          request.params.mediaAssetId,
        );
        if (response.statusCode !== 302) {
          return reply.code(404).send(notFoundBody);
        }
        void reply.header("location", response.headers.location);
        return reply.code(302).send();
      } catch {
        return reply.code(404).send(notFoundBody);
      }
    },
  );
}
