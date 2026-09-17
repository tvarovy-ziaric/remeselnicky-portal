import { JobParticipantRoleDecisionIdempotencyError } from "@portal/db";
import type { UserId } from "@portal/domain";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
} from "fastify";

export const JOB_PARTICIPATION_ROLE_DECISION_PATHS = Object.freeze({
  pending: "/v1/me/job-participations/:participantId/role-assignments",
  decide:
    "/v1/me/job-participations/:participantId/role-assignments/:assignmentEventId/decision",
});

type Role = "LEAD" | "COORDINATOR" | "SITE_MANAGER";
type Decision = "CONFIRM" | "REQUEST_CORRECTION";

interface Guard {
  evaluate(
    request: FastifyRequest,
  ): Promise<
    | { readonly status: "ACTIVE"; readonly user: { readonly id: UserId } }
    | { readonly status: "ACCOUNT_NOT_ACTIVE" | "AUTHENTICATION_REQUIRED" }
  >;
}

export interface JobParticipationRoleDecisionRouteDependencies {
  readonly roles: {
    listPending(input: {
      readonly actorUserId: string;
      readonly participantId: string;
    }): Promise<
      | readonly {
          readonly assignmentEventId: string;
          readonly participantId: string;
          readonly role: Role;
          readonly assignedAt: Date;
        }[]
      | null
    >;
    decide(input: {
      readonly actorUserId: string;
      readonly commandId: string;
      readonly participantId: string;
      readonly assignmentEventId: string;
      readonly decision: Decision;
      readonly reason?: string;
    }): Promise<
      | {
          readonly status: "APPLIED" | "DEDUPLICATED";
          readonly decisionId: string;
          readonly decision: Decision;
          readonly decidedAt: Date;
        }
      | { readonly status: "NOT_FOUND" | "STALE_STATE" }
    >;
  };
  readonly csrfProtection: onRequestHookHandler;
  readonly guard: Guard;
  readonly rateLimit: { readonly max: number; readonly timeWindowMs: number };
}

export function registerJobParticipationRoleDecisionRoutes(
  app: FastifyInstance,
  dependencies: JobParticipationRoleDecisionRouteDependencies,
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

  app.get<{ Params: { participantId: string } }>(
    JOB_PARTICIPATION_ROLE_DECISION_PATHS.pending,
    {
      ...common,
      onRequest: rejectQuery,
      schema: { params: participantParams },
    },
    async (request, reply) => {
      const actor = await dependencies.guard.evaluate(request);
      if (actor.status !== "ACTIVE") return denyActor(reply, actor.status);
      try {
        const items = await dependencies.roles.listPending({
          actorUserId: actor.user.id,
          participantId: request.params.participantId,
        });
        if (items === null) return reply.code(404).send({ code: "NOT_FOUND" });
        return reply.send({
          items: items.map((item) => ({
            assignmentEventId: item.assignmentEventId,
            participantId: item.participantId,
            role: item.role,
            assignedAt: item.assignedAt.toISOString(),
          })),
        });
      } catch {
        return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
      }
    },
  );

  app.post<{
    Params: { participantId: string; assignmentEventId: string };
    Body: { commandId: string; decision: Decision; reason?: string };
  }>(
    JOB_PARTICIPATION_ROLE_DECISION_PATHS.decide,
    {
      ...common,
      onRequest: dependencies.csrfProtection,
      preValidation: exactDecisionBody,
      schema: { params: decisionParams, body: decisionBody },
    },
    async (request, reply) => {
      const actor = await dependencies.guard.evaluate(request);
      if (actor.status !== "ACTIVE") return denyActor(reply, actor.status);
      try {
        const result = await dependencies.roles.decide({
          actorUserId: actor.user.id,
          commandId: request.body.commandId,
          participantId: request.params.participantId,
          assignmentEventId: request.params.assignmentEventId,
          decision: request.body.decision,
          ...(request.body.reason === undefined
            ? {}
            : { reason: request.body.reason }),
        });
        if (result.status === "NOT_FOUND")
          return reply.code(404).send({ code: "NOT_FOUND" });
        if (result.status === "STALE_STATE")
          return reply.code(409).send({ code: "STALE_STATE" });
        if (result.status === "APPLIED" || result.status === "DEDUPLICATED")
          return reply.code(result.status === "APPLIED" ? 201 : 200).send({
            status: result.status,
            decisionId: result.decisionId,
            decision: result.decision,
            decidedAt: result.decidedAt.toISOString(),
          });
        return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
      } catch (error) {
        if (error instanceof JobParticipantRoleDecisionIdempotencyError)
          return reply.code(409).send({ code: "IDEMPOTENCY_CONFLICT" });
        if (error instanceof TypeError)
          return reply.code(400).send({ code: "INVALID_REQUEST" });
        return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
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

function rejectQuery(
  request: FastifyRequest,
  reply: FastifyReply,
  done: () => void,
): void {
  if (new URL(request.raw.url ?? "", "http://localhost").search) {
    void reply.code(400).send({ code: "INVALID_QUERY" });
    return;
  }
  done();
}

function exactDecisionBody(
  request: FastifyRequest,
  reply: FastifyReply,
  done: () => void,
): void {
  const body = request.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    void reply.code(400).send({ code: "INVALID_REQUEST" });
    return;
  }
  const record = body as Record<string, unknown>;
  if (
    !("commandId" in record) ||
    !("decision" in record) ||
    Object.keys(record).some(
      (key) => !["commandId", "decision", "reason"].includes(key),
    ) ||
    (record.decision === "REQUEST_CORRECTION" && !("reason" in record)) ||
    (record.decision === "CONFIRM" && "reason" in record)
  ) {
    void reply.code(400).send({ code: "INVALID_REQUEST" });
    return;
  }
  done();
}

const uuidSchema = {
  type: "string",
  pattern:
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
} as const;
const participantParams = {
  type: "object",
  additionalProperties: false,
  required: ["participantId"],
  properties: { participantId: uuidSchema },
} as const;
const decisionParams = {
  type: "object",
  additionalProperties: false,
  required: ["participantId", "assignmentEventId"],
  properties: {
    participantId: uuidSchema,
    assignmentEventId: uuidSchema,
  },
} as const;
const decisionBody = {
  type: "object",
  additionalProperties: false,
  required: ["commandId", "decision"],
  properties: {
    commandId: uuidSchema,
    decision: { type: "string", enum: ["CONFIRM", "REQUEST_CORRECTION"] },
    reason: { type: "string", minLength: 8, maxLength: 500 },
  },
} as const;
