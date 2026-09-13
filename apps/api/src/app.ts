import { platformContract } from "@portal/contracts";
import type { DatabaseHealthProbe } from "@portal/db";
import Fastify, { type FastifyInstance } from "fastify";

export interface ApiDependencies {
  readonly database: DatabaseHealthProbe;
}

export function buildApi(dependencies: ApiDependencies): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get("/", () => ({
    apiVersion: platformContract.apiVersion,
    service: "api",
    status: "ok",
  }));

  app.get("/health/live", () => ({ status: "ok" }));

  app.get("/health/ready", async (_request, reply) => {
    try {
      await dependencies.database.ping();

      return {
        checks: { database: "available" },
        status: "ready",
      };
    } catch {
      return reply.code(503).send({
        checks: { database: "unavailable" },
        status: "not_ready",
      });
    }
  });

  return app;
}
