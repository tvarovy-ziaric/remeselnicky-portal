import type { JobDashboard, JobDashboardSummary } from "@portal/db";
import type { UserId } from "@portal/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export const JOB_DASHBOARD_PATHS = Object.freeze({
  collection: "/v1/me/jobs",
  detail: "/v1/me/jobs/:jobId",
});

interface Guard {
  evaluate(
    request: FastifyRequest,
  ): Promise<
    | { readonly status: "ACTIVE"; readonly user: { readonly id: UserId } }
    | { readonly status: "ACCOUNT_NOT_ACTIVE" | "AUTHENTICATION_REQUIRED" }
  >;
}

export interface JobDashboardRouteDependencies {
  readonly dashboard: {
    listForPrimaryParty(input: {
      readonly actorUserId: string;
    }): Promise<readonly JobDashboardSummary[]>;
    readForPrimaryParty(input: {
      readonly actorUserId: string;
      readonly jobId: string;
    }): Promise<JobDashboard | null>;
  };
  readonly guard: Guard;
  readonly rateLimit: { readonly max: number; readonly timeWindowMs: number };
}

export function registerJobDashboardRoutes(
  app: FastifyInstance,
  dependencies: JobDashboardRouteDependencies,
): void {
  const options = {
    config: {
      rateLimit: {
        max: dependencies.rateLimit.max,
        timeWindow: dependencies.rateLimit.timeWindowMs,
      },
    },
    onSend: privateHeaders,
  };
  app.get(JOB_DASHBOARD_PATHS.collection, options, async (request, reply) => {
    const actor = await dependencies.guard.evaluate(request);
    if (actor.status !== "ACTIVE")
      return reply
        .code(actor.status === "AUTHENTICATION_REQUIRED" ? 401 : 403)
        .send({ code: actor.status });
    try {
      const jobs = await dependencies.dashboard.listForPrimaryParty({
        actorUserId: actor.user.id,
      });
      return reply.send({ jobs });
    } catch {
      return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
    }
  });
  app.get<{ Params: { jobId: string } }>(
    JOB_DASHBOARD_PATHS.detail,
    {
      ...options,
      schema: {
        params: {
          additionalProperties: false,
          properties: {
            jobId: {
              pattern:
                "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
              type: "string",
            },
          },
          required: ["jobId"],
          type: "object",
        },
      },
    },
    async (request, reply) => {
      const actor = await dependencies.guard.evaluate(request);
      if (actor.status !== "ACTIVE")
        return reply
          .code(actor.status === "AUTHENTICATION_REQUIRED" ? 401 : 403)
          .send({ code: actor.status });
      try {
        const job = await dependencies.dashboard.readForPrimaryParty({
          actorUserId: actor.user.id,
          jobId: request.params.jobId,
        });
        return job === null
          ? reply.code(404).send({ code: "NOT_FOUND" })
          : reply.send(job);
      } catch {
        return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
      }
    },
  );
}

function privateHeaders(
  _request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
  done: (error: Error | null, payload?: unknown) => void,
): void {
  void reply.header("cache-control", "private, no-store");
  void reply.header("x-robots-tag", "noindex, nofollow");
  done(null, payload);
}
