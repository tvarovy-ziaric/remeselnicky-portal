import {
  JobRequestLifecycleIdempotencyError,
  type JobRequestCancellationReason,
  type JobRequestId,
  type JobRequestLifecycleService,
  type UserId,
} from "@portal/domain";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
} from "fastify";

export const JOB_REQUEST_LIFECYCLE_PATHS = Object.freeze({
  cancel: "/v1/me/job-requests/:jobRequestId/cancel",
  duplicate: "/v1/me/job-requests/:jobRequestId/duplicate",
  extend: "/v1/me/job-requests/:jobRequestId/extend",
  reactivate: "/v1/me/job-requests/:jobRequestId/reactivate",
  collection: "/v1/me/job-requests",
});

interface Guard {
  evaluate(
    request: FastifyRequest,
  ): Promise<
    | { readonly status: "ACTIVE"; readonly user: { readonly id: UserId } }
    | { readonly status: "ACCOUNT_NOT_ACTIVE" }
    | { readonly status: "AUTHENTICATION_REQUIRED" }
  >;
}

export interface JobRequestLifecycleRouteDependencies {
  readonly csrfProtection: onRequestHookHandler;
  readonly guard: Guard;
  readonly lifecycle: JobRequestLifecycleService;
}

interface CommandBody {
  readonly commandId: string;
  readonly expectedRevision: number;
}

interface CancelBody extends CommandBody {
  readonly reason: JobRequestCancellationReason;
}

export function registerJobRequestLifecycleRoutes(
  app: FastifyInstance,
  dependencies: JobRequestLifecycleRouteDependencies,
): void {
  app.addHook("onSend", (request, reply, payload, done) => {
    if (request.url.startsWith("/v1/me/job-requests/")) {
      void reply.header("cache-control", "no-store");
      void reply.header("x-robots-tag", "noindex, nofollow");
    }
    done(null, payload);
  });
  const options = { onRequest: dependencies.csrfProtection } as const;
  app.get(JOB_REQUEST_LIFECYCLE_PATHS.collection, async (request, reply) => {
    const actor = await requireActor(request, reply, dependencies.guard);
    if (actor === undefined) return;
    const result = await dependencies.lifecycle.list(actor);
    if (result.status !== "OK") {
      return reply.code(403).send({ code: "ACCOUNT_NOT_ACTIVE" });
    }
    return reply.send({
      requests: result.requests.map((item) => ({
        activatedAt: item.activatedAt?.toISOString() ?? null,
        cancellationReason: item.cancellationReason,
        changedAt: item.changedAt.toISOString(),
        expiresAt: item.expiresAt?.toISOString() ?? null,
        id: item.id,
        revision: item.revision,
        state: item.state,
        warningAt: item.warningAt?.toISOString() ?? null,
      })),
    });
  });
  const registerCommand = (
    path: string,
    operation: "extend" | "reactivate",
  ) => {
    app.post<{
      Body: CommandBody;
      Params: { jobRequestId: string };
    }>(
      path,
      { ...options, schema: { body: commandSchema, params: paramsSchema } },
      async (request, reply) => {
        const actor = await requireActor(request, reply, dependencies.guard);
        if (actor === undefined) return;
        try {
          const result = await dependencies.lifecycle[operation]({
            actorUserId: actor,
            commandId: request.body.commandId,
            expectedRevision: request.body.expectedRevision,
            jobRequestId: request.params.jobRequestId as JobRequestId,
          });
          return sendLifecycleResult(reply, result);
        } catch (error: unknown) {
          return sendError(reply, error);
        }
      },
    );
  };
  registerCommand(JOB_REQUEST_LIFECYCLE_PATHS.extend, "extend");
  registerCommand(JOB_REQUEST_LIFECYCLE_PATHS.reactivate, "reactivate");

  app.post<{ Body: CancelBody; Params: { jobRequestId: string } }>(
    JOB_REQUEST_LIFECYCLE_PATHS.cancel,
    { ...options, schema: { body: cancelSchema, params: paramsSchema } },
    async (request, reply) => {
      const actor = await requireActor(request, reply, dependencies.guard);
      if (actor === undefined) return;
      try {
        return sendLifecycleResult(
          reply,
          await dependencies.lifecycle.cancel({
            actorUserId: actor,
            commandId: request.body.commandId,
            expectedRevision: request.body.expectedRevision,
            jobRequestId: request.params.jobRequestId as JobRequestId,
            reason: request.body.reason,
          }),
        );
      } catch (error: unknown) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{
    Body: { readonly commandId: string };
    Params: { jobRequestId: string };
  }>(
    JOB_REQUEST_LIFECYCLE_PATHS.duplicate,
    { ...options, schema: { body: duplicateSchema, params: paramsSchema } },
    async (request, reply) => {
      const actor = await requireActor(request, reply, dependencies.guard);
      if (actor === undefined) return;
      try {
        const result = await dependencies.lifecycle.duplicate({
          actorUserId: actor,
          commandId: request.body.commandId,
          sourceJobRequestId: request.params.jobRequestId as JobRequestId,
        });
        if ("jobRequestId" in result) {
          return reply.code(result.status === "APPLIED" ? 201 : 200).send({
            id: result.jobRequestId,
            revision: result.revision,
            status: result.status,
          });
        }
        return sendDenial(reply, result.status);
      } catch (error: unknown) {
        return sendError(reply, error);
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

function sendLifecycleResult(
  reply: FastifyReply,
  result: Awaited<ReturnType<JobRequestLifecycleService["extend"]>>,
) {
  if ("jobRequest" in result) {
    return reply.send({
      activatedAt: result.jobRequest.activatedAt?.toISOString() ?? null,
      cancellationReason: result.jobRequest.cancellationReason,
      expiresAt: result.jobRequest.expiresAt?.toISOString() ?? null,
      id: result.jobRequest.id,
      revision: result.jobRequest.revision,
      state: result.jobRequest.state,
      status: result.status,
      warningAt: result.jobRequest.warningAt?.toISOString() ?? null,
    });
  }
  return sendDenial(
    reply,
    result.status,
    result.currentRevision,
    result.activeLimit,
  );
}

function sendDenial(
  reply: FastifyReply,
  status: string,
  currentRevision?: number,
  activeLimit?: number,
) {
  if (status === "ACCOUNT_NOT_ACTIVE") {
    return reply.code(403).send({ code: status });
  }
  if (status === "NOT_FOUND") return reply.code(404).send({ code: status });
  if (status === "STALE_REVISION") {
    return reply.code(409).send({ code: status, currentRevision });
  }
  if (status === "ACTIVE_LIMIT_REACHED") {
    return reply.code(409).send({ activeLimit, code: status });
  }
  if (status === "INVALID_TRANSITION" || status === "NOT_READY") {
    return reply.code(409).send({ code: status });
  }
  return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
}

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof JobRequestLifecycleIdempotencyError) {
    return reply.code(409).send({ code: "IDEMPOTENCY_CONFLICT" });
  }
  if (error instanceof TypeError) {
    return reply.code(400).send({ code: "INVALID_REQUEST" });
  }
  return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
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
  properties: {
    commandId: uuid,
    expectedRevision: { minimum: 1, type: "integer" },
  },
  required: ["commandId", "expectedRevision"],
  type: "object",
} as const;
const cancelSchema = {
  ...commandSchema,
  properties: {
    ...commandSchema.properties,
    reason: {
      enum: ["DUPLICATE", "NO_LONGER_NEEDED", "OTHER", "PLANS_CHANGED"],
      type: "string",
    },
  },
  required: [...commandSchema.required, "reason"],
} as const;
const duplicateSchema = {
  additionalProperties: false,
  properties: { commandId: uuid },
  required: ["commandId"],
  type: "object",
} as const;
