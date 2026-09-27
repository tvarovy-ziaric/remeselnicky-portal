import type { AdminAccessService, PrivilegedActor } from "@portal/admin-auth";
import type { AlphaAnalyticsDashboardRepository } from "@portal/db";
import type { UserId } from "@portal/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { SessionGuardResult } from "../auth/guard.js";

export const ADMIN_ALPHA_ANALYTICS_PATH = "/v1/admin/analytics/alpha";

export interface AdminAnalyticsRouteDependencies {
  readonly analytics: AlphaAnalyticsDashboardRepository;
  readonly guard: {
    evaluate(request: FastifyRequest): Promise<SessionGuardResult>;
  };
  readonly service: Pick<AdminAccessService, "authorize">;
}

export function registerAdminAnalyticsRoutes(
  app: FastifyInstance,
  dependencies: AdminAnalyticsRouteDependencies,
): void {
  app.addHook("onSend", (request, reply, payload, done) => {
    if (request.url.startsWith(ADMIN_ALPHA_ANALYTICS_PATH)) {
      void reply.header("cache-control", "no-store");
      void reply.header("x-robots-tag", "noindex, nofollow");
    }
    done(null, payload);
  });

  app.get<{ Querystring: { from: string; to: string } }>(
    ADMIN_ALPHA_ANALYTICS_PATH,
    {
      schema: {
        querystring: {
          additionalProperties: false,
          properties: {
            from: { type: "string", maxLength: 32 },
            to: { type: "string", maxLength: 32 },
          },
          required: ["from", "to"],
          type: "object",
        },
      },
    },
    async (request, reply) => {
      const actor = await requireAdmin(request, reply, dependencies);
      if (actor === undefined) return;
      const range = parseRange(request.query, request.raw.url);
      if (range === undefined) {
        return reply.code(400).send({ code: "INVALID_ANALYTICS_RANGE" });
      }
      const dashboard = await dependencies.analytics.load(range);
      return reply.send({
        dashboard,
        range: {
          from: range.from.toISOString(),
          to: range.to.toISOString(),
        },
      });
    },
  );
}

function parseRange(
  input: {
    readonly from: string;
    readonly to: string;
  },
  rawUrl: string | undefined,
): { readonly from: Date; readonly to: Date } | undefined {
  const query = new URL(rawUrl ?? "", "http://localhost").searchParams;
  const keys = [...query.keys()];
  if (
    keys.length !== 2 ||
    !query.has("from") ||
    !query.has("to") ||
    keys.some((key) => key !== "from" && key !== "to")
  ) {
    return undefined;
  }
  const from = new Date(input.from);
  const to = new Date(input.to);
  if (
    !Number.isFinite(from.getTime()) ||
    !Number.isFinite(to.getTime()) ||
    from.toISOString() !== input.from ||
    to.toISOString() !== input.to ||
    from >= to ||
    to.getTime() - from.getTime() > 366 * 24 * 60 * 60 * 1_000
  ) {
    return undefined;
  }
  return { from, to };
}

async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: AdminAnalyticsRouteDependencies,
): Promise<PrivilegedActor | undefined> {
  const identity = await dependencies.guard.evaluate(request);
  if (identity.status === "AUTHENTICATION_REQUIRED") {
    await reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" });
    return undefined;
  }
  if (identity.status === "ACCOUNT_NOT_ACTIVE") {
    await reply.code(403).send({ code: "ACCOUNT_NOT_ACTIVE" });
    return undefined;
  }
  return authorize(request, reply, dependencies.service, identity.user.id);
}

async function authorize(
  request: FastifyRequest,
  reply: FastifyReply,
  service: Pick<AdminAccessService, "authorize">,
  userId: UserId,
): Promise<PrivilegedActor | undefined> {
  const decision = await service.authorize({
    capability: "admin.access",
    requireRecentMfa: false,
    sessionId: request.session.sessionId,
    userId,
  });
  if (decision.status !== "AUTHORIZED" || decision.actor.userId !== userId) {
    await reply.code(403).send({ code: "PRIVILEGED_ACCESS_DENIED" });
    return undefined;
  }
  return decision.actor;
}
