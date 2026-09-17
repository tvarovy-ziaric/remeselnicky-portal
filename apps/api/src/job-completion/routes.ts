import { JobCompletionIdempotencyError } from "@portal/db";
import type { UserId } from "@portal/domain";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
} from "fastify";

export const JOB_COMPLETION_PATHS = Object.freeze({
  collection: "/v1/me/jobs/:jobId/completion",
  request: "/v1/me/jobs/:jobId/completion/request",
  accept: "/v1/me/jobs/:jobId/completion/:attemptId/accept",
  reject: "/v1/me/jobs/:jobId/completion/:attemptId/reject",
  withdraw: "/v1/me/jobs/:jobId/completion/:attemptId/withdraw",
});

type CompletionResult =
  | {
      readonly status: "APPLIED" | "DEDUPLICATED";
      readonly jobState: string;
      readonly attemptId: string;
      readonly recordedAt: Date;
    }
  | { readonly status: "NOT_FOUND" | "STALE_STATE" | "STALE_ATTEMPT" };
type CompletionAttempt = {
  readonly id: string;
  readonly attemptNumber: number;
  readonly requestedAt: Date;
  readonly requestedByUserId: string;
  readonly note: string | null;
  readonly physicalWorkFinishedOn: string | null;
  readonly finalMediaAssetIds: readonly string[];
  readonly outcome: "PENDING" | "ACCEPTED" | "REJECTED" | "WITHDRAWN";
  readonly decidedAt: Date | null;
  readonly decidedByUserId: string | null;
  readonly rejectionCategory:
    "UNFINISHED_SCOPE" | "DEFECT" | "MISSING_OUTPUT" | "OTHER" | null;
  readonly rejectionReason: string | null;
  readonly objectionMediaAssetIds: readonly string[];
};
type CompletionPage = {
  readonly jobState: string;
  readonly attempts: readonly CompletionAttempt[];
};
type RequestBody = {
  readonly commandId: string;
  readonly note?: string | null;
  readonly physicalWorkFinishedOn?: string | null;
  readonly finalMediaAssetIds?: readonly string[];
};
type RejectBody = {
  readonly commandId: string;
  readonly category: "UNFINISHED_SCOPE" | "DEFECT" | "MISSING_OUTPUT" | "OTHER";
  readonly reason: string;
  readonly evidenceMediaAssetIds?: readonly string[];
};

export interface JobCompletionRouteDependencies {
  readonly completion: {
    list(input: {
      actorUserId: string;
      jobId: string;
    }): Promise<CompletionPage | null>;
    request(
      input: RequestBody & { actorUserId: string; jobId: string },
    ): Promise<CompletionResult>;
    accept(input: {
      actorUserId: string;
      commandId: string;
      jobId: string;
      attemptId: string;
    }): Promise<CompletionResult>;
    reject(
      input: RejectBody & {
        actorUserId: string;
        jobId: string;
        attemptId: string;
      },
    ): Promise<CompletionResult>;
    withdraw(input: {
      actorUserId: string;
      commandId: string;
      jobId: string;
      attemptId: string;
      reason: string;
    }): Promise<CompletionResult>;
  };
  readonly guard: {
    evaluate(
      request: FastifyRequest,
    ): Promise<
      | { readonly status: "ACTIVE"; readonly user: { readonly id: UserId } }
      | { readonly status: "ACCOUNT_NOT_ACTIVE" | "AUTHENTICATION_REQUIRED" }
    >;
  };
  readonly csrfProtection: onRequestHookHandler;
  readonly rateLimit: { readonly max: number; readonly timeWindowMs: number };
}

export function registerJobCompletionRoutes(
  app: FastifyInstance,
  dependencies: JobCompletionRouteDependencies,
): void {
  const common = {
    config: {
      rateLimit: {
        max: dependencies.rateLimit.max,
        timeWindow: dependencies.rateLimit.timeWindowMs,
      },
    },
    onSend: privateHeaders,
  };
  const command = { ...common, onRequest: dependencies.csrfProtection };
  app.get<{ Params: { jobId: string } }>(
    JOB_COMPLETION_PATHS.collection,
    { ...common, schema: { params: jobParams } },
    async (request, reply) => {
      const actor = await activeActor(request, reply, dependencies);
      if (actor === null) return;
      try {
        const page = await dependencies.completion.list({
          actorUserId: actor,
          jobId: request.params.jobId,
        });
        if (page === null) return reply.code(404).send({ code: "NOT_FOUND" });
        return reply.send({
          jobState: page.jobState,
          attempts: page.attempts.map((attempt) => ({
            id: attempt.id,
            attemptNumber: attempt.attemptNumber,
            requestedAt: attempt.requestedAt.toISOString(),
            note: attempt.note,
            physicalWorkFinishedOn: attempt.physicalWorkFinishedOn,
            finalMediaDownloadPaths:
              attempt.finalMediaAssetIds.map(downloadPath),
            outcome: attempt.outcome,
            decidedAt: attempt.decidedAt?.toISOString() ?? null,
            rejectionCategory: attempt.rejectionCategory,
            rejectionReason: attempt.rejectionReason,
            objectionMediaDownloadPaths:
              attempt.objectionMediaAssetIds.map(downloadPath),
          })),
        });
      } catch {
        return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
      }
    },
  );
  app.post<{ Params: { jobId: string }; Body: RequestBody }>(
    JOB_COMPLETION_PATHS.request,
    {
      ...command,
      preValidation: exactBody(
        ["commandId"],
        ["note", "physicalWorkFinishedOn", "finalMediaAssetIds"],
      ),
      schema: { params: jobParams, body: requestBody },
    },
    async (request, reply) => {
      const actor = await activeActor(request, reply, dependencies);
      if (actor === null) return;
      try {
        return sendResult(
          reply,
          await dependencies.completion.request({
            ...request.body,
            actorUserId: actor,
            jobId: request.params.jobId,
          }),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
  app.post<{
    Params: { jobId: string; attemptId: string };
    Body: { commandId: string };
  }>(
    JOB_COMPLETION_PATHS.accept,
    {
      ...command,
      preValidation: exactBody(["commandId"]),
      schema: { params: attemptParams, body: acceptBody },
    },
    async (request, reply) => {
      const actor = await activeActor(request, reply, dependencies);
      if (actor === null) return;
      try {
        return sendResult(
          reply,
          await dependencies.completion.accept({
            actorUserId: actor,
            commandId: request.body.commandId,
            jobId: request.params.jobId,
            attemptId: request.params.attemptId,
          }),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
  app.post<{ Params: { jobId: string; attemptId: string }; Body: RejectBody }>(
    JOB_COMPLETION_PATHS.reject,
    {
      ...command,
      preValidation: exactBody(
        ["commandId", "category", "reason"],
        ["evidenceMediaAssetIds"],
      ),
      schema: { params: attemptParams, body: rejectBody },
    },
    async (request, reply) => {
      const actor = await activeActor(request, reply, dependencies);
      if (actor === null) return;
      try {
        return sendResult(
          reply,
          await dependencies.completion.reject({
            ...request.body,
            actorUserId: actor,
            jobId: request.params.jobId,
            attemptId: request.params.attemptId,
          }),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
  app.post<{
    Params: { jobId: string; attemptId: string };
    Body: { commandId: string; reason: string };
  }>(
    JOB_COMPLETION_PATHS.withdraw,
    {
      ...command,
      preValidation: exactBody(["commandId", "reason"]),
      schema: { params: attemptParams, body: withdrawBody },
    },
    async (request, reply) => {
      const actor = await activeActor(request, reply, dependencies);
      if (actor === null) return;
      try {
        return sendResult(
          reply,
          await dependencies.completion.withdraw({
            ...request.body,
            actorUserId: actor,
            jobId: request.params.jobId,
            attemptId: request.params.attemptId,
          }),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
}

const downloadPath = (id: string) => `/v1/media/${id}/download`;
function sendResult(reply: FastifyReply, result: CompletionResult) {
  if (result.status === "APPLIED" || result.status === "DEDUPLICATED")
    return reply.code(result.status === "APPLIED" ? 201 : 200).send({
      status: result.status,
      jobState: result.jobState,
      attemptId: result.attemptId,
      recordedAt: result.recordedAt.toISOString(),
    });
  return reply
    .code(result.status === "NOT_FOUND" ? 404 : 409)
    .send({ code: result.status });
}
function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof TypeError)
    return reply.code(400).send({ code: "INVALID_REQUEST" });
  if (error instanceof JobCompletionIdempotencyError)
    return reply.code(409).send({ code: "IDEMPOTENCY_CONFLICT" });
  return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
}
async function activeActor(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: JobCompletionRouteDependencies,
): Promise<string | null> {
  const actor = await dependencies.guard.evaluate(request);
  if (actor.status === "ACTIVE") return actor.user.id;
  void reply
    .code(actor.status === "AUTHENTICATION_REQUIRED" ? 401 : 403)
    .send({ code: actor.status });
  return null;
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
function exactBody(
  required: readonly string[],
  optional: readonly string[] = [],
) {
  return (request: FastifyRequest, reply: FastifyReply, done: () => void) => {
    const body = request.body;
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      required.some((key) => !Object.hasOwn(body, key)) ||
      Object.keys(body).some(
        (key) => !required.includes(key) && !optional.includes(key),
      )
    ) {
      void reply.code(400).send({ code: "INVALID_REQUEST" });
      return;
    }
    done();
  };
}
const uuid = {
  type: "string",
  pattern:
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
} as const;
const nullable = (schema: object) =>
  ({ anyOf: [schema, { type: "null" }] }) as const;
const text = (minimum: number, maximum: number) =>
  ({ type: "string", minLength: minimum, maxLength: maximum }) as const;
const mediaIds = {
  type: "array",
  items: uuid,
  maxItems: 10,
  uniqueItems: true,
} as const;
const day = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } as const;
const jobParams = {
  type: "object",
  additionalProperties: false,
  required: ["jobId"],
  properties: { jobId: uuid },
} as const;
const attemptParams = {
  type: "object",
  additionalProperties: false,
  required: ["jobId", "attemptId"],
  properties: { jobId: uuid, attemptId: uuid },
} as const;
const requestBody = {
  type: "object",
  additionalProperties: false,
  required: ["commandId"],
  properties: {
    commandId: uuid,
    note: nullable(text(1, 1000)),
    physicalWorkFinishedOn: nullable(day),
    finalMediaAssetIds: mediaIds,
  },
} as const;
const acceptBody = {
  type: "object",
  additionalProperties: false,
  required: ["commandId"],
  properties: { commandId: uuid },
} as const;
const rejectBody = {
  type: "object",
  additionalProperties: false,
  required: ["commandId", "category", "reason"],
  properties: {
    commandId: uuid,
    category: {
      type: "string",
      enum: ["UNFINISHED_SCOPE", "DEFECT", "MISSING_OUTPUT", "OTHER"],
    },
    reason: text(8, 1000),
    evidenceMediaAssetIds: mediaIds,
  },
} as const;
const withdrawBody = {
  type: "object",
  additionalProperties: false,
  required: ["commandId", "reason"],
  properties: { commandId: uuid, reason: text(8, 1000) },
} as const;
