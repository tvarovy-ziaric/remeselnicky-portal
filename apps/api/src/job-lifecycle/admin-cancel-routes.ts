import type { AdminAccessService, PrivilegedActor } from "@portal/admin-auth";
import { AdminJobCancellationIdempotencyError } from "@portal/db";
import type {
  FastifyInstance,
  FastifyRequest,
  onRequestHookHandler,
} from "fastify";

import type { SessionGuardResult } from "../auth/guard.js";

export const ADMIN_JOB_CANCELLATION_PATH = "/v1/admin/jobs/:jobId/force-cancel";

export interface AdminJobCancellationRouteDependencies {
  readonly adminAccess: Pick<AdminAccessService, "authorize">;
  readonly cancellation: {
    forceCancel(input: {
      actor: PrivilegedActor;
      privilegedSessionId: string;
      commandId: string;
      jobId: string;
      expectedState: "CONFIRMED" | "IN_PROGRESS" | "COMPLETION_REQUESTED";
      reason: string;
      userFacingReason: string;
    }): Promise<
      | {
          status: "APPLIED" | "DEDUPLICATED";
          commandId: string;
          recordedAt: Date;
        }
      | { status: "NOT_FOUND" | "STALE_STATE" }
    >;
  };
  readonly guard: {
    evaluate(request: FastifyRequest): Promise<SessionGuardResult>;
  };
  readonly csrfProtection: onRequestHookHandler;
  readonly rateLimit: { readonly max: number; readonly timeWindowMs: number };
}

const uuid =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

export function registerAdminJobCancellationRoutes(
  app: FastifyInstance,
  dependencies: AdminJobCancellationRouteDependencies,
): void {
  app.post<{
    Params: { jobId: string };
    Body: {
      commandId: string;
      expectedState: "CONFIRMED" | "IN_PROGRESS" | "COMPLETION_REQUESTED";
      reason: string;
      userFacingReason: string;
    };
  }>(
    ADMIN_JOB_CANCELLATION_PATH,
    {
      config: {
        rateLimit: {
          max: Math.min(5, dependencies.rateLimit.max),
          timeWindow: dependencies.rateLimit.timeWindowMs,
        },
      },
      onRequest: dependencies.csrfProtection,
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["jobId"],
          properties: { jobId: { type: "string", pattern: uuid } },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: [
            "commandId",
            "expectedState",
            "reason",
            "userFacingReason",
          ],
          properties: {
            commandId: { type: "string", pattern: uuid },
            expectedState: {
              type: "string",
              enum: ["CONFIRMED", "IN_PROGRESS", "COMPLETION_REQUESTED"],
            },
            reason: { type: "string", minLength: 8, maxLength: 500 },
            userFacingReason: { type: "string", minLength: 8, maxLength: 1000 },
          },
        },
      },
      onSend(_request, reply, payload, done) {
        void reply.header("cache-control", "no-store");
        void reply.header("x-robots-tag", "noindex, nofollow");
        done(null, payload);
      },
    },
    async (request, reply) => {
      const identity = await dependencies.guard.evaluate(request);
      if (identity.status === "AUTHENTICATION_REQUIRED")
        return reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" });
      if (identity.status === "ACCOUNT_NOT_ACTIVE")
        return reply.code(403).send({ code: "ACCOUNT_NOT_ACTIVE" });
      const decision = await dependencies.adminAccess.authorize({
        capability: "admin.jobs.correct",
        requireRecentMfa: true,
        sessionId: request.session.sessionId,
        userId: identity.user.id,
      });
      if (
        decision.status !== "AUTHORIZED" ||
        decision.actor.userId !== identity.user.id ||
        !decision.actor.capabilities.has("admin.jobs.correct")
      )
        return reply.code(403).send({ code: "PRIVILEGED_ACCESS_DENIED" });
      try {
        const result = await dependencies.cancellation.forceCancel({
          actor: decision.actor,
          privilegedSessionId: request.session.sessionId,
          commandId: request.body.commandId,
          jobId: request.params.jobId,
          expectedState: request.body.expectedState,
          reason: request.body.reason,
          userFacingReason: request.body.userFacingReason,
        });
        if (result.status === "NOT_FOUND")
          return reply.code(404).send({ code: "NOT_FOUND" });
        if (result.status === "STALE_STATE")
          return reply.code(409).send({ code: "STALE_STATE" });
        if (!("recordedAt" in result))
          throw new Error("Unexpected administrative cancellation result.");
        return reply.code(result.status === "APPLIED" ? 201 : 200).send({
          ...result,
          jobState: "CANCELLED",
          recordedAt: result.recordedAt.toISOString(),
        });
      } catch (error) {
        if (error instanceof TypeError)
          return reply.code(400).send({ code: "INVALID_REQUEST" });
        if (error instanceof AdminJobCancellationIdempotencyError)
          return reply.code(409).send({ code: "IDEMPOTENCY_CONFLICT" });
        return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
      }
    },
  );
}
