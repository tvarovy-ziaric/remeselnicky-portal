import {
  serializePublicCraftsmanProfile,
  type PublicCraftsmanProfilePersistence,
} from "@portal/domain";
import type { FastifyInstance } from "fastify";

export const PUBLIC_CRAFTSMAN_PROFILE_PATH =
  "/v1/public/craftsmen/:profileId" as const;

export interface PublicCraftsmanProfileRouteDependencies {
  readonly profiles: PublicCraftsmanProfilePersistence;
}

export function registerPublicCraftsmanProfileRoutes(
  app: FastifyInstance,
  dependencies: PublicCraftsmanProfileRouteDependencies,
): void {
  app.get<{ Params: { profileId: string } }>(
    PUBLIC_CRAFTSMAN_PROFILE_PATH,
    async (request, reply) => {
      void reply.header("cache-control", "no-store");
      void reply.header("x-robots-tag", "noindex, nofollow");

      try {
        const candidate = await dependencies.profiles.findPublic(
          request.params.profileId,
        );
        const profile =
          candidate === null
            ? null
            : serializePublicCraftsmanProfile(candidate);
        if (profile === null) {
          return reply.code(404).send({ code: "NOT_FOUND" });
        }
        void reply.header("x-robots-tag", "index, follow");
        return reply.send(profile);
      } catch {
        return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
      }
    },
  );
}
