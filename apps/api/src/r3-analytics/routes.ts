import type { R3AnalyticsObservationPersistence } from "@portal/analytics";
import type { UserId } from "@portal/domain";
import type {
  FastifyInstance,
  FastifyRequest,
  onRequestHookHandler,
} from "fastify";

export const R3_ANALYTICS_OBSERVATION_PATH =
  "/v1/me/analytics/r3-observations" as const;

interface Guard {
  evaluate(
    request: FastifyRequest,
  ): Promise<
    | { readonly status: "ACTIVE"; readonly user: { readonly id: UserId } }
    | { readonly status: "ACCOUNT_NOT_ACTIVE" | "AUTHENTICATION_REQUIRED" }
  >;
}

export interface R3AnalyticsRouteDependencies {
  readonly csrfProtection: onRequestHookHandler;
  readonly guard: Guard;
  readonly observations: R3AnalyticsObservationPersistence;
  readonly rateLimit: {
    readonly max: number;
    readonly timeWindowMs: number;
  };
}

export function registerR3AnalyticsRoutes(
  app: FastifyInstance,
  dependencies: R3AnalyticsRouteDependencies,
): void {
  app.post<{
    Body: {
      readonly commandId: string;
      readonly jobRequestId: string;
      readonly invitationId?: string;
      readonly kind:
        "INVITATION_VIEWED" | "QUOTE_VIEWED" | "QUOTE_COMPARISON_OPENED";
      readonly quoteId?: string;
      readonly quoteRevision?: number;
    };
  }>(
    R3_ANALYTICS_OBSERVATION_PATH,
    {
      config: {
        rateLimit: {
          max: dependencies.rateLimit.max,
          timeWindow: dependencies.rateLimit.timeWindowMs,
        },
      },
      onRequest: dependencies.csrfProtection,
      preValidation(request, reply, done) {
        const body = request.body as Record<string, unknown>;
        const allowed = new Set([
          "commandId",
          "jobRequestId",
          "invitationId",
          "kind",
          "quoteId",
          "quoteRevision",
        ]);
        if (Object.keys(body).some((key) => !allowed.has(key))) {
          void reply.code(400).send({ code: "INVALID_REQUEST" });
          return;
        }
        done();
      },
      schema: { body: bodySchema },
    },
    async (request, reply) => {
      const actor = await dependencies.guard.evaluate(request);
      if (actor.status !== "ACTIVE") {
        return reply
          .code(actor.status === "AUTHENTICATION_REQUIRED" ? 401 : 403)
          .send({ code: actor.status });
      }
      try {
        await dependencies.observations.record({
          actorUserId: actor.user.id,
          commandId: request.body.commandId,
          jobRequestId: request.body.jobRequestId,
          ...(request.body.invitationId === undefined
            ? {}
            : { invitationId: request.body.invitationId }),
          kind: request.body.kind,
          ...(request.body.quoteId === undefined
            ? {}
            : { quoteId: request.body.quoteId }),
          ...(request.body.quoteRevision === undefined
            ? {}
            : { quoteRevision: request.body.quoteRevision }),
        });
        return reply.code(204).send();
      } catch (error) {
        if (error instanceof TypeError) {
          return reply.code(400).send({ code: "INVALID_REQUEST" });
        }
        if (
          error instanceof Error &&
          error.message.includes("command id was reused")
        ) {
          return reply.code(409).send({ code: "IDEMPOTENCY_CONFLICT" });
        }
        return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
      }
    },
  );
}

const uuid = { format: "uuid", type: "string" } as const;
const bodySchema = {
  additionalProperties: false,
  properties: {
    commandId: uuid,
    jobRequestId: uuid,
    invitationId: uuid,
    kind: {
      enum: ["QUOTE_VIEWED", "INVITATION_VIEWED", "QUOTE_COMPARISON_OPENED"],
      type: "string",
    },
    quoteId: uuid,
    quoteRevision: { minimum: 1, type: "integer" },
  },
  required: ["commandId", "jobRequestId", "kind"],
  type: "object",
} as const;
