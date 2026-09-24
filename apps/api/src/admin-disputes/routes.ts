import type { AdminAccessService, PrivilegedActor } from "@portal/admin-auth";
import {
  AdminDisputeIdempotencyError,
  type AdminDisputeState,
  type createAdminDisputeRepository,
} from "@portal/db";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
} from "fastify";

import type { SessionGuardResult } from "../auth/guard.js";

export const ADMIN_DISPUTE_PATHS = Object.freeze({
  queue: "/v1/admin/disputes",
  access: "/v1/admin/disputes/:disputeId/access",
  startReview: "/v1/admin/disputes/:disputeId/start-review",
  requestInformation: "/v1/admin/disputes/:disputeId/request-information",
  internalNotes: "/v1/admin/disputes/:disputeId/internal-notes",
  outcomes: "/v1/admin/disputes/:disputeId/outcomes",
  close: "/v1/admin/disputes/:disputeId/close",
  reopen: "/v1/admin/disputes/:disputeId/reopen",
  setInvestigationHold: "/v1/admin/disputes/:disputeId/investigation-hold",
  clearInvestigationHold:
    "/v1/admin/disputes/:disputeId/investigation-hold/clear",
});

type Repository = ReturnType<typeof createAdminDisputeRepository>;
export interface AdminDisputeRouteDependencies {
  readonly adminAccess: Pick<AdminAccessService, "authorize">;
  readonly disputes: Pick<
    Repository,
    | "listQueue"
    | "getCase"
    | "startReview"
    | "requestInformation"
    | "addInternalNote"
    | "recordOutcome"
    | "close"
    | "reopen"
    | "setInvestigationHold"
    | "clearInvestigationHold"
  >;
  readonly guard: {
    evaluate(request: FastifyRequest): Promise<SessionGuardResult>;
  };
  readonly csrfProtection: onRequestHookHandler;
  readonly rateLimit: { readonly max: number; readonly timeWindowMs: number };
}

type JsonObject = Record<string, unknown>;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const states = new Set<AdminDisputeState>([
  "OPEN",
  "WAITING_FOR_PARTY",
  "UNDER_REVIEW",
  "RESOLVED",
  "CLOSED",
]);

export function registerAdminDisputeRoutes(
  app: FastifyInstance,
  dependencies: AdminDisputeRouteDependencies,
): void {
  const privateResponse = (
    _request: FastifyRequest,
    reply: FastifyReply,
    payload: unknown,
    done: (error: Error | null, payload?: unknown) => void,
  ) => {
    void reply.header("cache-control", "no-store");
    void reply.header("x-robots-tag", "noindex, nofollow");
    done(null, payload);
  };
  const writeOptions = {
    config: {
      rateLimit: {
        max: Math.min(10, dependencies.rateLimit.max),
        timeWindow: dependencies.rateLimit.timeWindowMs,
      },
    },
    onRequest: dependencies.csrfProtection,
    onSend: privateResponse,
  } as const;

  app.get<{ Querystring: { state?: string; limit?: string } }>(
    ADMIN_DISPUTE_PATHS.queue,
    { onSend: privateResponse },
    async (request, reply) => {
      const actor = await authorize(request, reply, dependencies);
      if (!actor) return;
      const state = request.query.state;
      if (state !== undefined && !states.has(state as AdminDisputeState))
        return reply.code(400).send({ code: "INVALID_REQUEST" });
      const limit =
        request.query.limit === undefined
          ? undefined
          : Number.parseInt(request.query.limit, 10);
      if (
        limit !== undefined &&
        (!/^\d{1,3}$/u.test(request.query.limit ?? "") ||
          limit < 1 ||
          limit > 100)
      )
        return reply.code(400).send({ code: "INVALID_REQUEST" });
      try {
        const items = await dependencies.disputes.listQueue({
          actor,
          privilegedSessionId: request.session.sessionId,
          ...(state === undefined ? {} : { state: state as AdminDisputeState }),
          ...(limit === undefined ? {} : { limit }),
        });
        return reply.send({ items });
      } catch {
        return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
      }
    },
  );

  app.post<{ Params: { disputeId: string } }>(
    ADMIN_DISPUTE_PATHS.access,
    writeOptions,
    async (request, reply) => {
      const actor = await authorize(request, reply, dependencies);
      if (!actor) return;
      const body = exactBody(request.body, ["accessId", "reason"]);
      if (
        !body ||
        !validId(request.params.disputeId) ||
        !validId(body.accessId) ||
        !validReason(body.reason)
      )
        return reply.code(400).send({ code: "INVALID_REQUEST" });
      try {
        const detail = await dependencies.disputes.getCase({
          actor,
          privilegedSessionId: request.session.sessionId,
          disputeId: request.params.disputeId,
          accessId: body.accessId,
          reason: body.reason,
        });
        if (!detail) return reply.code(404).send({ code: "NOT_FOUND" });
        return reply.send({ detail });
      } catch {
        return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
      }
    },
  );

  app.post<{ Params: { disputeId: string } }>(
    ADMIN_DISPUTE_PATHS.startReview,
    writeOptions,
    async (request, reply) =>
      handleSimpleCommand(request, reply, dependencies, "startReview"),
  );
  app.post<{ Params: { disputeId: string } }>(
    ADMIN_DISPUTE_PATHS.close,
    writeOptions,
    async (request, reply) =>
      handleSimpleCommand(request, reply, dependencies, "close"),
  );
  app.post<{ Params: { disputeId: string } }>(
    ADMIN_DISPUTE_PATHS.reopen,
    writeOptions,
    async (request, reply) =>
      handleSimpleCommand(request, reply, dependencies, "reopen"),
  );
  app.post<{ Params: { disputeId: string } }>(
    ADMIN_DISPUTE_PATHS.setInvestigationHold,
    writeOptions,
    async (request, reply) =>
      handleSimpleCommand(request, reply, dependencies, "setInvestigationHold"),
  );
  app.post<{ Params: { disputeId: string } }>(
    ADMIN_DISPUTE_PATHS.clearInvestigationHold,
    writeOptions,
    async (request, reply) =>
      handleSimpleCommand(
        request,
        reply,
        dependencies,
        "clearInvestigationHold",
      ),
  );

  app.post<{ Params: { disputeId: string } }>(
    ADMIN_DISPUTE_PATHS.requestInformation,
    writeOptions,
    async (request, reply) => {
      const actor = await authorize(request, reply, dependencies);
      if (!actor) return;
      const body = exactBody(request.body, [
        "commandId",
        "expectedState",
        "reason",
        "recipient",
        "requestText",
        "replyDeadline",
      ]);
      if (!body || !validBase(request.params.disputeId, body))
        return reply.code(400).send({ code: "INVALID_REQUEST" });
      if (
        typeof body.recipient !== "string" ||
        !["CUSTOMER", "PRIMARY_PROVIDER", "BOTH"].includes(body.recipient) ||
        !validText(body.requestText, 1, 2000) ||
        !(body.replyDeadline === null || validDate(body.replyDeadline))
      )
        return reply.code(400).send({ code: "INVALID_REQUEST" });
      const replyDeadline =
        body.replyDeadline === null ? null : new Date(body.replyDeadline);
      return commandReply(reply, () =>
        dependencies.disputes.requestInformation({
          actor,
          privilegedSessionId: request.session.sessionId,
          commandId: body.commandId,
          disputeId: request.params.disputeId,
          expectedState: body.expectedState,
          reason: body.reason,
          recipient: body.recipient as "CUSTOMER" | "PRIMARY_PROVIDER" | "BOTH",
          requestText: body.requestText as string,
          replyDeadline,
        }),
      );
    },
  );

  app.post<{ Params: { disputeId: string } }>(
    ADMIN_DISPUTE_PATHS.internalNotes,
    writeOptions,
    async (request, reply) => {
      const actor = await authorize(request, reply, dependencies);
      if (!actor) return;
      const body = exactBody(request.body, [
        "commandId",
        "expectedState",
        "reason",
        "note",
      ]);
      if (
        !body ||
        !validBase(request.params.disputeId, body) ||
        !validText(body.note, 1, 4000)
      )
        return reply.code(400).send({ code: "INVALID_REQUEST" });
      return commandReply(reply, () =>
        dependencies.disputes.addInternalNote({
          actor,
          privilegedSessionId: request.session.sessionId,
          commandId: body.commandId,
          disputeId: request.params.disputeId,
          expectedState: body.expectedState,
          reason: body.reason,
          note: body.note as string,
        }),
      );
    },
  );

  app.post<{ Params: { disputeId: string } }>(
    ADMIN_DISPUTE_PATHS.outcomes,
    writeOptions,
    async (request, reply) => {
      const actor = await authorize(request, reply, dependencies);
      if (!actor) return;
      const body = exactBody(request.body, [
        "commandId",
        "expectedState",
        "reason",
        "category",
        "basis",
        "summary",
      ]);
      if (!body || !validBase(request.params.disputeId, body))
        return reply.code(400).send({ code: "INVALID_REQUEST" });
      const categories = [
        "RESOLVED_BY_PARTIES",
        "OPERATIONAL_ADMIN_RESOLUTION",
        "NO_ACTION",
        "REFERRED_OUTSIDE_PLATFORM",
        "ACCOUNT_POLICY_ACTION",
        "OTHER",
      ];
      if (
        typeof body.category !== "string" ||
        !categories.includes(body.category) ||
        typeof body.basis !== "string" ||
        !["MUTUAL_PARTY_AGREEMENT", "ADMINISTRATIVE_CLOSURE"].includes(
          body.basis,
        ) ||
        !validText(body.summary, 1, 4000)
      )
        return reply.code(400).send({ code: "INVALID_REQUEST" });
      return commandReply(reply, () =>
        dependencies.disputes.recordOutcome({
          actor,
          privilegedSessionId: request.session.sessionId,
          commandId: body.commandId,
          disputeId: request.params.disputeId,
          expectedState: body.expectedState,
          reason: body.reason,
          category: body.category as Parameters<
            Repository["recordOutcome"]
          >[0]["category"],
          basis: body.basis as Parameters<
            Repository["recordOutcome"]
          >[0]["basis"],
          summary: body.summary as string,
        }),
      );
    },
  );
}

async function handleSimpleCommand(
  request: FastifyRequest<{ Params: { disputeId: string } }>,
  reply: FastifyReply,
  dependencies: AdminDisputeRouteDependencies,
  operation:
    | "startReview"
    | "close"
    | "reopen"
    | "setInvestigationHold"
    | "clearInvestigationHold",
): Promise<unknown> {
  const actor = await authorize(request, reply, dependencies);
  if (!actor) return;
  const body = exactBody(request.body, [
    "commandId",
    "expectedState",
    "reason",
  ]);
  if (!body || !validBase(request.params.disputeId, body))
    return reply.code(400).send({ code: "INVALID_REQUEST" });
  return commandReply(reply, () =>
    dependencies.disputes[operation]({
      actor,
      privilegedSessionId: request.session.sessionId,
      commandId: body.commandId,
      disputeId: request.params.disputeId,
      expectedState: body.expectedState,
      reason: body.reason,
    }),
  );
}

async function authorize(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: AdminDisputeRouteDependencies,
): Promise<PrivilegedActor | undefined> {
  const identity = await dependencies.guard.evaluate(request);
  if (identity.status === "AUTHENTICATION_REQUIRED") {
    await reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" });
    return undefined;
  }
  if (identity.status === "ACCOUNT_NOT_ACTIVE") {
    await reply.code(403).send({ code: "ACCOUNT_NOT_ACTIVE" });
    return undefined;
  }
  const decision = await dependencies.adminAccess.authorize({
    capability: "admin.disputes.manage",
    requireRecentMfa: true,
    sessionId: request.session.sessionId,
    userId: identity.user.id,
  });
  if (
    decision.status !== "AUTHORIZED" ||
    decision.actor.userId !== identity.user.id ||
    !decision.actor.capabilities.has("admin.disputes.manage")
  ) {
    await reply.code(403).send({ code: "PRIVILEGED_ACCESS_DENIED" });
    return undefined;
  }
  return decision.actor;
}

async function commandReply(
  reply: FastifyReply,
  execute: () => Promise<Awaited<ReturnType<Repository["startReview"]>>>,
): Promise<unknown> {
  try {
    const result = await execute();
    if (result.status === "NOT_FOUND")
      return reply.code(404).send({ code: "NOT_FOUND" });
    if (result.status === "STALE_STATE")
      return reply.code(409).send({ code: "STALE_STATE" });
    if (!("recordedAt" in result))
      throw new Error("Unexpected administrative dispute result.");
    return reply.code(result.status === "APPLIED" ? 201 : 200).send({
      ...result,
      recordedAt: result.recordedAt.toISOString(),
    });
  } catch (error) {
    if (error instanceof TypeError)
      return reply.code(400).send({ code: "INVALID_REQUEST" });
    if (error instanceof AdminDisputeIdempotencyError)
      return reply.code(409).send({ code: "IDEMPOTENCY_CONFLICT" });
    return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
  }
}

function exactBody(value: unknown, keys: readonly string[]): JsonObject | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const body = value as JsonObject;
  const actual = Object.keys(body).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
    ? body
    : null;
}
function validBase(
  disputeId: string,
  body: JsonObject,
): body is JsonObject & {
  commandId: string;
  expectedState: AdminDisputeState;
  reason: string;
} {
  return (
    validId(disputeId) &&
    validId(body.commandId) &&
    typeof body.expectedState === "string" &&
    states.has(body.expectedState as AdminDisputeState) &&
    validReason(body.reason)
  );
}
function validId(value: unknown): value is string {
  return typeof value === "string" && uuid.test(value);
}
function validReason(value: unknown): value is string {
  return validText(value, 8, 500);
}
function validText(
  value: unknown,
  minimum: number,
  maximum: number,
): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length >= minimum &&
    value.length <= maximum &&
    !/[\p{Cc}]/u.test(value)
  );
}
function validDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
