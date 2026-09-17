import {
  JobParticipantCapabilityIdempotencyError,
  type ConfirmJobParticipantCapabilityInput,
  type ConfirmJobParticipantCapabilityResult,
  type JobParticipantCapabilityCursor,
  type JobParticipantCapabilityPage,
  type ProposeJobParticipantCapabilityInput,
  type ProposeJobParticipantCapabilityResult,
} from "@portal/db";
import type { UserId } from "@portal/domain";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
} from "fastify";

export const JOB_PARTICIPANT_CAPABILITY_PATHS = Object.freeze({
  collection: "/v1/me/job-participations/:participantId/capabilities",
  confirm:
    "/v1/me/job-participations/:participantId/capabilities/:claimId/confirm",
});

interface Guard {
  evaluate(
    request: FastifyRequest,
  ): Promise<
    | { readonly status: "ACTIVE"; readonly user: { readonly id: UserId } }
    | { readonly status: "ACCOUNT_NOT_ACTIVE" | "AUTHENTICATION_REQUIRED" }
  >;
}

export interface JobParticipantCapabilityRouteDependencies {
  readonly capabilities: {
    list(input: {
      readonly actorUserId: string;
      readonly participantId: string;
      readonly limit: number;
      readonly cursor?: JobParticipantCapabilityCursor;
    }): Promise<JobParticipantCapabilityPage | null>;
    propose(
      input: ProposeJobParticipantCapabilityInput,
    ): Promise<ProposeJobParticipantCapabilityResult>;
    confirm(
      input: ConfirmJobParticipantCapabilityInput,
    ): Promise<ConfirmJobParticipantCapabilityResult>;
  };
  readonly csrfProtection: onRequestHookHandler;
  readonly guard: Guard;
  readonly rateLimit: { readonly max: number; readonly timeWindowMs: number };
}

export function registerJobParticipantCapabilityRoutes(
  app: FastifyInstance,
  dependencies: JobParticipantCapabilityRouteDependencies,
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
    Params: { participantId: string };
    Querystring: { limit?: number; beforeAt?: string; beforeId?: string };
  }>(
    JOB_PARTICIPANT_CAPABILITY_PATHS.collection,
    {
      ...common,
      onRequest: rejectUnknownQuery,
      schema: { params: participantParams, querystring: listQuery },
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
        const page = await dependencies.capabilities.list({
          actorUserId: actor.user.id,
          participantId: request.params.participantId,
          limit: request.query.limit ?? 20,
          ...(date === null
            ? {}
            : { cursor: { proposedAt: date, id: beforeId! } }),
        });
        if (page === null) return reply.code(404).send({ code: "NOT_FOUND" });
        return reply.send({
          items: page.items.map((item) => ({
            ...item,
            proposedAt: item.proposedAt.toISOString(),
            confirmedAt: item.confirmedAt?.toISOString() ?? null,
          })),
          canAct: page.canAct,
          canPropose: page.canPropose,
          nextCursor:
            page.nextCursor === null
              ? null
              : {
                  proposedAt: page.nextCursor.proposedAt.toISOString(),
                  id: page.nextCursor.id,
                },
        });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{
    Params: { participantId: string };
    Body: {
      commandId: string;
      kind: "PROFESSION" | "CANONICAL_SKILL" | "CUSTOM_SKILL";
      professionCode?: string;
      skillCode?: string;
      customSkillText?: string;
    };
  }>(
    JOB_PARTICIPANT_CAPABILITY_PATHS.collection,
    {
      ...common,
      onRequest: dependencies.csrfProtection,
      preValidation: validateProposalBody,
      schema: { params: participantParams, body: proposalBody },
    },
    async (request, reply) => {
      const actor = await dependencies.guard.evaluate(request);
      if (actor.status !== "ACTIVE") return denyActor(reply, actor.status);
      try {
        const result = await dependencies.capabilities.propose({
          actorUserId: actor.user.id,
          participantId: request.params.participantId,
          ...request.body,
        });
        if (result.status === "NOT_FOUND")
          return reply.code(404).send({ code: "NOT_FOUND" });
        if (result.status === "STALE_STATE")
          return reply.code(409).send({ code: "STALE_STATE" });
        if (result.status === "INVALID_CAPABILITY")
          return reply.code(400).send({ code: "INVALID_CAPABILITY" });
        if (result.status === "APPLIED" || result.status === "DEDUPLICATED")
          return reply.code(result.status === "APPLIED" ? 201 : 200).send({
            ...result,
            proposedAt: result.proposedAt.toISOString(),
          });
        throw new Error("Unknown capability proposal result.");
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{
    Params: { participantId: string; claimId: string };
    Body: { commandId: string };
  }>(
    JOB_PARTICIPANT_CAPABILITY_PATHS.confirm,
    {
      ...common,
      onRequest: dependencies.csrfProtection,
      preValidation: exactBody(["commandId"]),
      schema: { params: confirmParams, body: confirmBody },
    },
    async (request, reply) => {
      const actor = await dependencies.guard.evaluate(request);
      if (actor.status !== "ACTIVE") return denyActor(reply, actor.status);
      try {
        const result = await dependencies.capabilities.confirm({
          actorUserId: actor.user.id,
          participantId: request.params.participantId,
          claimId: request.params.claimId,
          commandId: request.body.commandId,
        });
        if (result.status === "NOT_FOUND")
          return reply.code(404).send({ code: "NOT_FOUND" });
        if (result.status === "STALE_STATE")
          return reply.code(409).send({ code: "STALE_STATE" });
        if (result.status === "APPLIED" || result.status === "DEDUPLICATED")
          return reply.send({
            ...result,
            confirmedAt: result.confirmedAt.toISOString(),
          });
        throw new Error("Unknown capability confirmation result.");
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
}

function denyActor(reply: FastifyReply, status: string) {
  return reply
    .code(status === "AUTHENTICATION_REQUIRED" ? 401 : 403)
    .send({ code: status });
}

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof JobParticipantCapabilityIdempotencyError)
    return reply.code(409).send({ code: "IDEMPOTENCY_CONFLICT" });
  if (error instanceof TypeError)
    return reply.code(400).send({ code: "INVALID_REQUEST" });
  throw error;
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

function exactBody(required: readonly string[]) {
  return (request: FastifyRequest, reply: FastifyReply, done: () => void) => {
    const body = request.body;
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      required.some((key) => !(key in body)) ||
      Object.keys(body).some((key) => !required.includes(key))
    ) {
      void reply.code(400).send({ code: "INVALID_REQUEST" });
      return;
    }
    done();
  };
}

function validateProposalBody(
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
  const identity =
    record.kind === "PROFESSION"
      ? "professionCode"
      : record.kind === "CANONICAL_SKILL"
        ? "skillCode"
        : record.kind === "CUSTOM_SKILL"
          ? "customSkillText"
          : null;
  if (
    identity === null ||
    !("commandId" in record) ||
    !(identity in record) ||
    Object.keys(record).some(
      (key) => !["commandId", "kind", identity].includes(key),
    )
  ) {
    void reply.code(400).send({ code: "INVALID_REQUEST" });
    return;
  }
  done();
}

function rejectUnknownQuery(
  request: FastifyRequest,
  reply: FastifyReply,
  done: () => void,
): void {
  const parameters = new URL(request.raw.url ?? "", "http://localhost")
    .searchParams;
  const keys = [...parameters.keys()];
  if (
    keys.some((key) => !["limit", "beforeAt", "beforeId"].includes(key)) ||
    new Set(keys).size !== keys.length
  ) {
    void reply.code(400).send({ code: "INVALID_QUERY" });
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
const confirmParams = {
  type: "object",
  additionalProperties: false,
  required: ["participantId", "claimId"],
  properties: {
    participantId: uuidSchema,
    claimId: uuidSchema,
  },
} as const;
const listQuery = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: { type: "integer", minimum: 1, maximum: 50 },
    beforeAt: { type: "string", format: "date-time" },
    beforeId: uuidSchema,
  },
} as const;
const proposalBody = {
  type: "object",
  additionalProperties: false,
  required: ["commandId", "kind"],
  properties: {
    commandId: uuidSchema,
    kind: {
      type: "string",
      enum: ["PROFESSION", "CANONICAL_SKILL", "CUSTOM_SKILL"],
    },
    professionCode: {
      type: "string",
      pattern: "^(PROF|TEST):[A-Z0-9][A-Z0-9_]{1,62}$",
    },
    skillCode: {
      type: "string",
      pattern: "^(SKILL|TEST):[A-Z0-9][A-Z0-9_]{1,62}$",
    },
    customSkillText: { type: "string", minLength: 2, maxLength: 160 },
  },
} as const;
const confirmBody = {
  type: "object",
  additionalProperties: false,
  required: ["commandId"],
  properties: { commandId: uuidSchema },
} as const;
