import { platformContract } from "@portal/contracts";
import type { DatabaseHealthProbe } from "@portal/db";
import Fastify, { type FastifyInstance } from "fastify";

import {
  registerAuthModule,
  type AuthModuleDependencies,
} from "./auth/index.js";

export interface ApiDependencies {
  readonly auth?: AuthModuleDependencies;
  readonly database: DatabaseHealthProbe;
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

  if (dependencies.auth !== undefined) {
    registerAuthModule(app, dependencies.auth);
  }

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
