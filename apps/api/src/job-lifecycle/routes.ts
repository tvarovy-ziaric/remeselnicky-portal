import {
  JobLifecycleIdempotencyError,
  type CancelJobInput,
  type JobLifecycleResult,
  type StartJobInput,
} from "@portal/db";
import type { UserId } from "@portal/domain";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
} from "fastify";

export const JOB_START_PATH = "/v1/me/jobs/:jobId/start" as const;
export const JOB_CANCEL_PATH = "/v1/me/jobs/:jobId/cancel" as const;

interface Guard {
  evaluate(
    request: FastifyRequest,
  ): Promise<
    | { readonly status: "ACTIVE"; readonly user: { readonly id: UserId } }
    | { readonly status: "ACCOUNT_NOT_ACTIVE" | "AUTHENTICATION_REQUIRED" }
  >;
}

export interface JobLifecycleRouteDependencies {
  readonly lifecycle: {
    start(input: StartJobInput): Promise<JobLifecycleResult>;
    cancel(input: CancelJobInput): Promise<JobLifecycleResult>;
  };
  readonly csrfProtection: onRequestHookHandler;
  readonly guard: Guard;
  readonly rateLimit: { readonly max: number; readonly timeWindowMs: number };
}

export function registerJobLifecycleRoutes(
  app: FastifyInstance,
  dependencies: JobLifecycleRouteDependencies,
): void {
  const options = {
    config: {
      rateLimit: {
        max: dependencies.rateLimit.max,
        timeWindow: dependencies.rateLimit.timeWindowMs,
      },
    },
    onRequest: dependencies.csrfProtection,
    onSend: privateHeaders,
    schema: { params: paramsSchema },
  };
  app.post<{
    Body: { commandId: string };
    Params: { jobId: string };
  }>(
    JOB_START_PATH,
    {
      ...options,
      preValidation: exactBody(["commandId"]),
      schema: { ...options.schema, body: startBodySchema },
    },
    async (request, reply) => {
      const actor = await dependencies.guard.evaluate(request);
      if (actor.status !== "ACTIVE") return denyActor(reply, actor.status);
      try {
        return sendResult(
          reply,
          await dependencies.lifecycle.start({
            actorUserId: actor.user.id,
            commandId: request.body.commandId,
            jobId: request.params.jobId,
          }),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
  app.post<{
    Body: Omit<CancelJobInput, "actorUserId" | "jobId">;
    Params: { jobId: string };
  }>(
    JOB_CANCEL_PATH,
    {
      ...options,
      preValidation: exactBody(["commandId", "expectedState", "reason"]),
      schema: { ...options.schema, body: cancelBodySchema },
    },
    async (request, reply) => {
      const actor = await dependencies.guard.evaluate(request);
      if (actor.status !== "ACTIVE") return denyActor(reply, actor.status);
      try {
        return sendResult(
          reply,
          await dependencies.lifecycle.cancel({
            actorUserId: actor.user.id,
            commandId: request.body.commandId,
            expectedState: request.body.expectedState,
            jobId: request.params.jobId,
            reason: request.body.reason,
          }),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
}

function denyActor(
  reply: FastifyReply,
  status: "ACCOUNT_NOT_ACTIVE" | "AUTHENTICATION_REQUIRED",
) {
  return reply
    .code(status === "AUTHENTICATION_REQUIRED" ? 401 : 403)
    .send({ code: status });
}

function sendResult(reply: FastifyReply, result: JobLifecycleResult) {
  if (result.status === "APPLIED" || result.status === "DEDUPLICATED")
    return reply.code(result.status === "APPLIED" ? 201 : 200).send({
      recordedAt: result.recordedAt.toISOString(),
      state: result.state,
      status: result.status,
    });
  return reply
    .code(result.status === "NOT_FOUND" ? 404 : 409)
    .send({ code: result.status });
}

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof JobLifecycleIdempotencyError)
    return reply.code(409).send({ code: "IDEMPOTENCY_CONFLICT" });
  if (error instanceof TypeError)
    return reply.code(400).send({ code: "INVALID_REQUEST" });
  return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
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

function exactBody(expected: readonly string[]) {
  return (request: FastifyRequest, reply: FastifyReply, done: () => void) => {
    const body = request.body;
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      Object.keys(body).sort().join(",") !== [...expected].sort().join(",")
    ) {
      void reply.code(400).send({ code: "INVALID_REQUEST" });
      return;
    }
    done();
  };
}

const uuidSchema = {
  pattern:
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
  type: "string",
} as const;
const paramsSchema = {
  additionalProperties: false,
  properties: { jobId: uuidSchema },
  required: ["jobId"],
  type: "object",
} as const;
const startBodySchema = {
  additionalProperties: false,
  properties: { commandId: uuidSchema },
  required: ["commandId"],
  type: "object",
} as const;
const cancelBodySchema = {
  additionalProperties: false,
  properties: {
    commandId: uuidSchema,
    expectedState: { enum: ["CONFIRMED", "IN_PROGRESS"], type: "string" },
    reason: { maxLength: 1000, minLength: 8, type: "string" },
  },
  required: ["commandId", "expectedState", "reason"],
  type: "object",
} as const;
