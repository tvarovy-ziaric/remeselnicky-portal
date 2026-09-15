import {
  JobInvitationIdempotencyError,
  type CraftsmanProfileId,
  type JobInvitationPersistence,
  type JobRequestId,
  type UserId,
} from "@portal/domain";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
} from "fastify";

export const JOB_INVITATION_PATH =
  "/v1/me/job-requests/:jobRequestId/invitations";

interface Guard {
  evaluate(
    request: FastifyRequest,
  ): Promise<
    | { readonly status: "ACTIVE"; readonly user: { readonly id: UserId } }
    | { readonly status: "ACCOUNT_NOT_ACTIVE" }
    | { readonly status: "AUTHENTICATION_REQUIRED" }
  >;
}

export interface JobInvitationRouteDependencies {
  readonly csrfProtection: onRequestHookHandler;
  readonly guard: Guard;
  readonly invitations: Pick<JobInvitationPersistence, "sendOwned">;
  readonly rateLimit: {
    readonly max: number;
    readonly timeWindowMs: number;
  };
}

export function registerJobInvitationRoutes(
  app: FastifyInstance,
  dependencies: JobInvitationRouteDependencies,
): void {
  app.addHook("onSend", (request, reply, payload, done) => {
    if (
      request.url.startsWith("/v1/me/job-requests/") &&
      request.url.includes("/invitations")
    ) {
      void reply.header("cache-control", "no-store");
      void reply.header("x-robots-tag", "noindex, nofollow");
    }
    done(null, payload);
  });

  app.post<{
    Body: { readonly commandId: string; readonly craftsmanProfileId: string };
    Params: { readonly jobRequestId: string };
  }>(
    JOB_INVITATION_PATH,
    {
      bodyLimit: 4 * 1024,
      config: {
        rateLimit: {
          max: dependencies.rateLimit.max,
          timeWindow: dependencies.rateLimit.timeWindowMs,
        },
      },
      onRequest: dependencies.csrfProtection,
      schema: { body: commandSchema, params: paramsSchema },
    },
    async (request, reply) => {
      const actorUserId = await requireActor(
        request,
        reply,
        dependencies.guard,
      );
      if (actorUserId === undefined) return;
      try {
        const result = await dependencies.invitations.sendOwned({
          actorUserId,
          commandId: request.body.commandId,
          craftsmanProfileId: request.body
            .craftsmanProfileId as CraftsmanProfileId,
          jobRequestId: request.params.jobRequestId as JobRequestId,
        });
        if ("invitation" in result) {
          return reply.code(result.status === "APPLIED" ? 201 : 200).send({
            id: result.invitation.id,
            revision: result.invitation.revision,
            state: result.invitation.state,
            status: result.status,
          });
        }
        if (result.status === "ALREADY_INVITED") {
          return reply.send({ status: result.status });
        }
        if (result.status === "ACCOUNT_NOT_ELIGIBLE") {
          return reply.code(403).send({ code: result.status });
        }
        if (
          result.status === "NOT_FOUND" ||
          result.status === "TARGET_NOT_ELIGIBLE"
        ) {
          return reply.code(404).send({ code: "NOT_FOUND" });
        }
        if (result.status === "ACTIVE_LIMIT_REACHED") {
          return reply
            .code(409)
            .send({ activeLimit: result.activeLimit, code: result.status });
        }
        return reply.code(409).send({ code: "INVITATION_CONFLICT" });
      } catch (error: unknown) {
        if (error instanceof JobInvitationIdempotencyError) {
          return reply.code(409).send({ code: "IDEMPOTENCY_CONFLICT" });
        }
        if (error instanceof TypeError) {
          return reply.code(400).send({ code: "INVALID_REQUEST" });
        }
        return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
      }
    },
  );
}

async function requireActor(
  request: FastifyRequest,
  reply: FastifyReply,
  guard: Guard,
): Promise<UserId | undefined> {
  const result = await guard.evaluate(request);
  if (result.status === "AUTHENTICATION_REQUIRED") {
    await reply.code(401).send({ code: result.status });
    return undefined;
  }
  if (result.status === "ACCOUNT_NOT_ACTIVE") {
    await reply.code(403).send({ code: result.status });
    return undefined;
  }
  return result.user.id;
}

const uuid = {
  pattern:
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
  type: "string",
} as const;
const paramsSchema = {
  additionalProperties: false,
  properties: { jobRequestId: uuid },
  required: ["jobRequestId"],
  type: "object",
} as const;
const commandSchema = {
  additionalProperties: false,
  properties: { commandId: uuid, craftsmanProfileId: uuid },
  required: ["commandId", "craftsmanProfileId"],
  type: "object",
} as const;
