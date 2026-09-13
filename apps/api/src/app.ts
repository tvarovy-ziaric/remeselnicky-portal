import { platformContract } from "@portal/contracts";
import Fastify, { type FastifyInstance } from "fastify";

export function buildApi(): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get("/", () => ({
    apiVersion: platformContract.apiVersion,
    service: "api",
    status: "ok",
  }));

  return app;
}
