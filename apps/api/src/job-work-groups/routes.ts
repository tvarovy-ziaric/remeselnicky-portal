import {
  JobWorkGroupIdempotencyError,
  type AssignJobWorkGroupInput,
  type AssignJobWorkGroupResult,
  type CreateJobWorkGroupInput,
  type CreateJobWorkGroupResult,
  type DepartJobWorkGroupInput,
  type DepartJobWorkGroupResult,
  type JobWorkGroupCursor,
  type JobWorkGroupListPage,
} from "@portal/db";
import type { UserId } from "@portal/domain";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
} from "fastify";

export const JOB_WORK_GROUP_PATHS = Object.freeze({
  create: "/v1/me/jobs/:jobId/work-groups",
  assign: "/v1/me/job-work-groups/:workGroupId/assignments",
  depart: "/v1/me/job-work-group-assignments/:assignmentId/departure",
});

interface Guard {
  evaluate(
    request: FastifyRequest,
  ): Promise<
    | { readonly status: "ACTIVE"; readonly user: { readonly id: UserId } }
    | { readonly status: "ACCOUNT_NOT_ACTIVE" | "AUTHENTICATION_REQUIRED" }
  >;
}

export interface JobWorkGroupRouteDependencies {
  readonly workGroups: {
    listForPrimaryParty(input: {
      readonly actorUserId: string;
      readonly jobId: string;
      readonly cursor?: JobWorkGroupCursor;
      readonly limit: number;
    }): Promise<JobWorkGroupListPage | null>;
    create(input: CreateJobWorkGroupInput): Promise<CreateJobWorkGroupResult>;
    assign(input: AssignJobWorkGroupInput): Promise<AssignJobWorkGroupResult>;
    depart(input: DepartJobWorkGroupInput): Promise<DepartJobWorkGroupResult>;
  };
  readonly csrfProtection: onRequestHookHandler;
  readonly guard: Guard;
  readonly rateLimit: { readonly max: number; readonly timeWindowMs: number };
}

export function registerJobWorkGroupRoutes(
  app: FastifyInstance,
  dependencies: JobWorkGroupRouteDependencies,
): void {
  const common = {
    config: {
      rateLimit: {
        max: dependencies.rateLimit.max,
        timeWindow: dependencies.rateLimit.timeWindowMs,
      },
    },
    onRequest: dependencies.csrfProtection,
    onSend: privateHeaders,
  };
  app.get<{
    Params: { jobId: string };
    Querystring: { limit?: number; beforeAt?: string; beforeId?: string };
  }>(
    JOB_WORK_GROUP_PATHS.create,
    {
      config: common.config,
      onRequest: rejectUnknownQuery,
      onSend: privateHeaders,
      schema: { params: jobParamsSchema, querystring: listQuerySchema },
    },
    async (request, reply) => {
      const actor = await dependencies.guard.evaluate(request);
      if (actor.status !== "ACTIVE") return denyActor(reply, actor.status);
      const { beforeAt, beforeId } = request.query;
      if ((beforeAt === undefined) !== (beforeId === undefined))
        return reply.code(400).send({ code: "INVALID_CURSOR" });
      const date = beforeAt === undefined ? null : new Date(beforeAt);
      if (date !== null && !Number.isFinite(date.getTime()))
        return reply.code(400).send({ code: "INVALID_CURSOR" });
      try {
        const result = await dependencies.workGroups.listForPrimaryParty({
          actorUserId: actor.user.id,
          jobId: request.params.jobId,
          ...(date === null
            ? {}
            : { cursor: { createdAt: date, id: beforeId! } }),
          limit: request.query.limit ?? 20,
        });
        if (result === null) return reply.code(404).send({ code: "NOT_FOUND" });
        return reply.send({
          groups: result.groups.map((group) => ({
            id: group.id,
            name: group.name,
            crewName: group.crewName,
            createdAt: group.createdAt.toISOString(),
          })),
          nextCursor:
            result.nextCursor === null
              ? null
              : {
                  createdAt: result.nextCursor.createdAt.toISOString(),
                  id: result.nextCursor.id,
                },
        });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
  app.post<{
    Params: { jobId: string };
    Body: { commandId: string; name: string };
  }>(
    JOB_WORK_GROUP_PATHS.create,
    {
      ...common,
      preValidation: exactBody(["commandId", "name"]),
      schema: { params: jobParamsSchema, body: createBodySchema },
    },
    async (request, reply) => {
      const actor = await dependencies.guard.evaluate(request);
      if (actor.status !== "ACTIVE") return denyActor(reply, actor.status);
      try {
        return sendCreate(
          reply,
          await dependencies.workGroups.create({
            actorUserId: actor.user.id,
            commandId: request.body.commandId,
            jobId: request.params.jobId,
            name: request.body.name,
          }),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
  app.post<{
    Params: { workGroupId: string };
    Body: { commandId: string; participantId: string };
  }>(
    JOB_WORK_GROUP_PATHS.assign,
    {
      ...common,
      preValidation: exactBody(["commandId", "participantId"]),
      schema: { params: groupParamsSchema, body: assignBodySchema },
    },
    async (request, reply) => {
      const actor = await dependencies.guard.evaluate(request);
      if (actor.status !== "ACTIVE") return denyActor(reply, actor.status);
      try {
        return sendAssign(
          reply,
          await dependencies.workGroups.assign({
            actorUserId: actor.user.id,
            commandId: request.body.commandId,
            workGroupId: request.params.workGroupId,
            participantId: request.body.participantId,
          }),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
  app.post<{
    Params: { assignmentId: string };
    Body: { commandId: string; action: "LEAVE" | "REMOVE"; reason?: string };
  }>(
    JOB_WORK_GROUP_PATHS.depart,
    {
      ...common,
      preValidation: exactBody(["commandId", "action"], ["reason"]),
      schema: { params: assignmentParamsSchema, body: departBodySchema },
    },
    async (request, reply) => {
      const actor = await dependencies.guard.evaluate(request);
      if (actor.status !== "ACTIVE") return denyActor(reply, actor.status);
      try {
        return sendDepart(
          reply,
          await dependencies.workGroups.depart({
            actorUserId: actor.user.id,
            commandId: request.body.commandId,
            assignmentId: request.params.assignmentId,
            action: request.body.action,
            ...(request.body.reason === undefined
              ? {}
              : { reason: request.body.reason }),
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

function sendCreate(reply: FastifyReply, result: CreateJobWorkGroupResult) {
  if (result.status === "APPLIED" || result.status === "DEDUPLICATED")
    return reply.code(result.status === "APPLIED" ? 201 : 200).send({
      status: result.status,
      workGroupId: result.workGroupId,
      createdAt: result.createdAt.toISOString(),
    });
  return reply
    .code(result.status === "NOT_FOUND" ? 404 : 409)
    .send({ code: result.status });
}

function sendAssign(reply: FastifyReply, result: AssignJobWorkGroupResult) {
  if (result.status === "APPLIED" || result.status === "DEDUPLICATED")
    return reply.code(result.status === "APPLIED" ? 201 : 200).send({
      status: result.status,
      assignmentId: result.assignmentId,
      assignedAt: result.assignedAt.toISOString(),
    });
  return reply
    .code(result.status === "NOT_FOUND" ? 404 : 409)
    .send({ code: result.status });
}

function sendDepart(reply: FastifyReply, result: DepartJobWorkGroupResult) {
  if (result.status === "APPLIED" || result.status === "DEDUPLICATED")
    return reply.code(result.status === "APPLIED" ? 201 : 200).send({
      status: result.status,
      endedAt: result.endedAt.toISOString(),
    });
  return reply
    .code(result.status === "NOT_FOUND" ? 404 : 409)
    .send({ code: result.status });
}

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof JobWorkGroupIdempotencyError)
    return reply.code(409).send({ code: "IDEMPOTENCY_CONFLICT" });
  if (error instanceof TypeError)
    return reply.code(400).send({ code: "INVALID_REQUEST" });
  return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
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
      required.some((key) => !(key in body)) ||
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

function rejectUnknownQuery(
  request: FastifyRequest,
  reply: FastifyReply,
  done: () => void,
): void {
  const parameters = new URL(request.raw.url ?? "", "http://localhost")
    .searchParams;
  const allowed = new Set(["limit", "beforeAt", "beforeId"]);
  const keys = [...parameters.keys()];
  if (
    keys.some((key) => !allowed.has(key)) ||
    new Set(keys).size !== keys.length
  ) {
    void reply.code(400).send({ code: "INVALID_QUERY" });
    return;
  }
  done();
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

const uuidSchema = {
  pattern:
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
  type: "string",
} as const;
const jobParamsSchema = {
  additionalProperties: false,
  properties: { jobId: uuidSchema },
  required: ["jobId"],
  type: "object",
} as const;
const groupParamsSchema = {
  additionalProperties: false,
  properties: { workGroupId: uuidSchema },
  required: ["workGroupId"],
  type: "object",
} as const;
const assignmentParamsSchema = {
  additionalProperties: false,
  properties: { assignmentId: uuidSchema },
  required: ["assignmentId"],
  type: "object",
} as const;
const createBodySchema = {
  additionalProperties: false,
  properties: {
    commandId: uuidSchema,
    name: { type: "string", minLength: 2, maxLength: 120 },
  },
  required: ["commandId", "name"],
  type: "object",
} as const;
const assignBodySchema = {
  additionalProperties: false,
  properties: { commandId: uuidSchema, participantId: uuidSchema },
  required: ["commandId", "participantId"],
  type: "object",
} as const;
const departBodySchema = {
  additionalProperties: false,
  properties: {
    commandId: uuidSchema,
    action: { enum: ["LEAVE", "REMOVE"], type: "string" },
    reason: { type: "string", minLength: 8, maxLength: 500 },
  },
  required: ["commandId", "action"],
  type: "object",
} as const;
const listQuerySchema = {
  additionalProperties: false,
  properties: {
    beforeAt: { format: "date-time", type: "string" },
    beforeId: uuidSchema,
    limit: { maximum: 50, minimum: 1, type: "integer" },
  },
  type: "object",
} as const;
