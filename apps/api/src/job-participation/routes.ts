import {
  JobParticipationIdempotencyError,
  type ChangeJobParticipantRoleInput,
  type ChangeJobParticipantRoleResult,
  type DecideJobParticipationInput,
  type DecideJobParticipationResult,
  type InviteJobParticipantInput,
  type InviteJobParticipantResult,
  type JobParticipationInboxCursor,
  type JobParticipationInboxPage,
  type OwnJobParticipationHistoryPage,
} from "@portal/db";
import type { UserId } from "@portal/domain";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
} from "fastify";

export const JOB_PARTICIPATION_PATHS = Object.freeze({
  invite: "/v1/me/jobs/:jobId/participants",
  inbox: "/v1/me/job-participations/invitations",
  history: "/v1/me/job-participations/history",
  decide: "/v1/me/job-participations/:participantId/decision",
  role: "/v1/me/job-participations/:participantId/roles",
});

interface Guard {
  evaluate(
    request: FastifyRequest,
  ): Promise<
    | { readonly status: "ACTIVE"; readonly user: { readonly id: UserId } }
    | { readonly status: "ACCOUNT_NOT_ACTIVE" | "AUTHENTICATION_REQUIRED" }
  >;
}

export interface JobParticipationRouteDependencies {
  readonly participation: {
    listPendingForInvitee(input: {
      readonly actorUserId: string;
      readonly cursor?: JobParticipationInboxCursor;
      readonly limit: number;
    }): Promise<JobParticipationInboxPage>;
    listOwnHistory(input: {
      readonly actorUserId: string;
      readonly cursor?: JobParticipationInboxCursor;
      readonly limit: number;
    }): Promise<OwnJobParticipationHistoryPage>;
    invite(
      input: InviteJobParticipantInput,
    ): Promise<InviteJobParticipantResult>;
    decide(
      input: DecideJobParticipationInput,
    ): Promise<DecideJobParticipationResult>;
    changeRole(
      input: ChangeJobParticipantRoleInput,
    ): Promise<ChangeJobParticipantRoleResult>;
  };
  readonly csrfProtection: onRequestHookHandler;
  readonly guard: Guard;
  readonly rateLimit: { readonly max: number; readonly timeWindowMs: number };
}

export function registerJobParticipationRoutes(
  app: FastifyInstance,
  dependencies: JobParticipationRouteDependencies,
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
  app.get<{
    Querystring: { limit?: number; beforeAt?: string; beforeId?: string };
  }>(
    JOB_PARTICIPATION_PATHS.history,
    {
      ...common,
      onRequest: rejectUnknownQuery,
      schema: { querystring: inboxQuerySchema },
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
        return reply.send(
          await dependencies.participation.listOwnHistory({
            actorUserId: actor.user.id,
            ...(date === null
              ? {}
              : { cursor: { invitedAt: date, id: beforeId! } }),
            limit: request.query.limit ?? 20,
          }),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
  app.get<{
    Querystring: { limit?: number; beforeAt?: string; beforeId?: string };
  }>(
    JOB_PARTICIPATION_PATHS.inbox,
    {
      ...common,
      onRequest: rejectUnknownQuery,
      schema: { querystring: inboxQuerySchema },
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
        return reply.send(
          await dependencies.participation.listPendingForInvitee({
            actorUserId: actor.user.id,
            ...(date === null
              ? {}
              : { cursor: { invitedAt: date, id: beforeId! } }),
            limit: request.query.limit ?? 20,
          }),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
  app.post<{
    Body: { commandId: string; craftsmanProfileId: string };
    Params: { jobId: string };
  }>(
    JOB_PARTICIPATION_PATHS.invite,
    {
      ...common,
      onRequest: dependencies.csrfProtection,
      preValidation: exactBody(["commandId", "craftsmanProfileId"]),
      schema: { params: jobParamsSchema, body: inviteBodySchema },
    },
    async (request, reply) => {
      const actor = await dependencies.guard.evaluate(request);
      if (actor.status !== "ACTIVE") return denyActor(reply, actor.status);
      try {
        return sendInvitation(
          reply,
          await dependencies.participation.invite({
            actorUserId: actor.user.id,
            commandId: request.body.commandId,
            craftsmanProfileId: request.body.craftsmanProfileId,
            jobId: request.params.jobId,
          }),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
  app.post<{
    Body: {
      commandId: string;
      decision: "ACCEPT" | "DECLINE" | "LEAVE" | "REMOVE";
      reason?: string;
    };
    Params: { participantId: string };
  }>(
    JOB_PARTICIPATION_PATHS.decide,
    {
      ...common,
      onRequest: dependencies.csrfProtection,
      preValidation: exactBody(["commandId", "decision"], ["reason"]),
      schema: { params: participantParamsSchema, body: decisionBodySchema },
    },
    async (request, reply) => {
      const actor = await dependencies.guard.evaluate(request);
      if (actor.status !== "ACTIVE") return denyActor(reply, actor.status);
      try {
        return sendDecision(
          reply,
          await dependencies.participation.decide({
            actorUserId: actor.user.id,
            commandId: request.body.commandId,
            decision: request.body.decision,
            participantId: request.params.participantId,
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
  app.post<{
    Body: {
      commandId: string;
      role: "LEAD" | "COORDINATOR" | "SITE_MANAGER";
      action: "ASSIGN" | "REVOKE";
    };
    Params: { participantId: string };
  }>(
    JOB_PARTICIPATION_PATHS.role,
    {
      ...common,
      onRequest: dependencies.csrfProtection,
      preValidation: exactBody(["commandId", "role", "action"]),
      schema: { params: participantParamsSchema, body: roleBodySchema },
    },
    async (request, reply) => {
      const actor = await dependencies.guard.evaluate(request);
      if (actor.status !== "ACTIVE") return denyActor(reply, actor.status);
      try {
        return sendRoleResult(
          reply,
          await dependencies.participation.changeRole({
            actorUserId: actor.user.id,
            commandId: request.body.commandId,
            participantId: request.params.participantId,
            role: request.body.role,
            action: request.body.action,
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

function sendInvitation(
  reply: FastifyReply,
  result: InviteJobParticipantResult,
) {
  if (result.status === "APPLIED" || result.status === "DEDUPLICATED")
    return reply.code(result.status === "APPLIED" ? 201 : 200).send({
      status: result.status,
      participantId: result.participantId,
      invitedAt: result.invitedAt.toISOString(),
    });
  return reply
    .code(
      result.status === "NOT_FOUND" || result.status === "TARGET_UNAVAILABLE"
        ? 404
        : 409,
    )
    .send({ code: result.status });
}

function sendDecision(
  reply: FastifyReply,
  result: DecideJobParticipationResult,
) {
  if (result.status === "APPLIED" || result.status === "DEDUPLICATED")
    return reply.code(result.status === "APPLIED" ? 201 : 200).send({
      status: result.status,
      state: result.state,
      recordedAt: result.recordedAt.toISOString(),
    });
  return reply
    .code(result.status === "NOT_FOUND" ? 404 : 409)
    .send({ code: result.status });
}

function sendRoleResult(
  reply: FastifyReply,
  result: ChangeJobParticipantRoleResult,
) {
  if (result.status === "APPLIED" || result.status === "DEDUPLICATED")
    return reply.code(result.status === "APPLIED" ? 201 : 200).send({
      status: result.status,
      role: result.role,
      active: result.active,
      recordedAt: result.recordedAt.toISOString(),
    });
  return reply
    .code(result.status === "NOT_FOUND" ? 404 : 409)
    .send({ code: result.status });
}

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof JobParticipationIdempotencyError)
    return reply.code(409).send({ code: "IDEMPOTENCY_CONFLICT" });
  if (error instanceof TypeError)
    return reply.code(400).send({ code: "INVALID_REQUEST" });
  return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
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
const participantParamsSchema = {
  additionalProperties: false,
  properties: { participantId: uuidSchema },
  required: ["participantId"],
  type: "object",
} as const;
const inboxQuerySchema = {
  additionalProperties: false,
  properties: {
    beforeAt: { format: "date-time", type: "string" },
    beforeId: uuidSchema,
    limit: { maximum: 50, minimum: 1, type: "integer" },
  },
  type: "object",
} as const;
const inviteBodySchema = {
  additionalProperties: false,
  properties: { commandId: uuidSchema, craftsmanProfileId: uuidSchema },
  required: ["commandId", "craftsmanProfileId"],
  type: "object",
} as const;
const decisionBodySchema = {
  additionalProperties: false,
  properties: {
    commandId: uuidSchema,
    decision: {
      enum: ["ACCEPT", "DECLINE", "LEAVE", "REMOVE"],
      type: "string",
    },
    reason: { minLength: 8, maxLength: 500, type: "string" },
  },
  required: ["commandId", "decision"],
  type: "object",
} as const;
const roleBodySchema = {
  additionalProperties: false,
  properties: {
    commandId: uuidSchema,
    role: { enum: ["LEAD", "COORDINATOR", "SITE_MANAGER"], type: "string" },
    action: { enum: ["ASSIGN", "REVOKE"], type: "string" },
  },
  required: ["commandId", "role", "action"],
  type: "object",
} as const;
