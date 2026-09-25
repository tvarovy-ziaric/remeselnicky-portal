import type { AdminAccessService, PrivilegedActor } from "@portal/admin-auth";
import {
  PrivacyAccountClosureIdempotencyError,
  type PrivacyRequestSummary,
  type TransitionPrivacyRequestInput,
  type createPrivacyOperationsRepository,
} from "@portal/db";
import type { UserId } from "@portal/domain";
import { PRIVACY_REQUEST_STATE_VALUES } from "@portal/privacy";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
} from "fastify";

import type { SessionGuardResult } from "../auth/guard.js";

type Operations = ReturnType<typeof createPrivacyOperationsRepository>;

export const ADMIN_PRIVACY_PATHS = Object.freeze({
  accountClosure:
    "/v1/admin/privacy/requests/:caseId/account-closure/deactivate",
  queue: "/v1/admin/privacy/requests",
  transition: "/v1/admin/privacy/requests/:caseId/transition",
} as const);

export interface AdminPrivacyRouteDependencies {
  readonly adminAccess: Pick<AdminAccessService, "authorize">;
  readonly csrfProtection: onRequestHookHandler;
  readonly guard: {
    evaluate(request: FastifyRequest): Promise<SessionGuardResult>;
  };
  readonly operations: Pick<
    Operations,
    "executeAccountClosure" | "listQueue" | "transitionRequest"
  >;
  readonly rateLimit: { readonly max: number; readonly timeWindowMs: number };
}

interface TransitionBody {
  readonly actionCode: string;
  readonly commandId: string;
  readonly deadlineAt: string | null;
  readonly expectedRevision: number;
  readonly expectedState: TransitionPrivacyRequestInput["expectedState"];
  readonly reason: string;
  readonly resultingState: TransitionPrivacyRequestInput["resultingState"];
}

interface ClosureBody {
  readonly commandId: string;
  readonly expectedRequestRevision: number;
  readonly expectedRequestState: "IN_REVIEW";
  readonly reason: string;
  readonly reasonCode: string;
  readonly subjectUserId: UserId;
}

export function registerAdminPrivacyRoutes(
  app: FastifyInstance,
  dependencies: AdminPrivacyRouteDependencies,
): void {
  app.get<{ Querystring: { limit?: string; state?: string } }>(
    ADMIN_PRIVACY_PATHS.queue,
    { onSend: privateHeaders },
    async (request, reply) => {
      const actor = await authorize(request, reply, dependencies);
      if (actor === undefined) return;
      const limit = parseLimit(request.query.limit);
      const state = request.query.state;
      if (
        limit === null ||
        (state !== undefined &&
          !PRIVACY_REQUEST_STATE_VALUES.includes(
            state as PrivacyRequestSummary["state"],
          ))
      )
        return reply.code(400).send({ code: "INVALID_REQUEST" });
      try {
        const items = await dependencies.operations.listQueue({
          actor,
          limit,
          privilegedSessionId: request.session.sessionId,
          ...(state === undefined
            ? {}
            : { state: state as PrivacyRequestSummary["state"] }),
        });
        return reply.send({ items: items.map(adminRequestDto) });
      } catch {
        return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
      }
    },
  );

  app.post<{ Body: TransitionBody; Params: { caseId: string } }>(
    ADMIN_PRIVACY_PATHS.transition,
    writeOptions(dependencies),
    async (request, reply) => {
      const actor = await authorize(request, reply, dependencies);
      if (actor === undefined) return;
      if (!validTransition(request.params.caseId, request.body))
        return reply.code(400).send({ code: "INVALID_REQUEST" });
      try {
        const result = await dependencies.operations.transitionRequest({
          actionCode: request.body.actionCode,
          actor,
          caseId: request.params.caseId,
          commandId: request.body.commandId,
          deadlineAt:
            request.body.deadlineAt === null
              ? null
              : new Date(request.body.deadlineAt),
          expectedRevision: request.body.expectedRevision,
          expectedState: request.body.expectedState,
          privilegedSessionId: request.session.sessionId,
          reason: request.body.reason,
          resultingState: request.body.resultingState,
        });
        if (result.status === "NOT_FOUND")
          return reply.code(404).send({ code: "NOT_FOUND" });
        if (result.status === "STALE_STATE")
          return reply.code(409).send({ code: "STALE_STATE" });
        return reply.code(result.status === "APPLIED" ? 201 : 200).send({
          ...result,
          occurredAt: result.occurredAt.toISOString(),
        });
      } catch (error) {
        return errorReply(reply, error);
      }
    },
  );

  app.post<{ Body: ClosureBody; Params: { caseId: string } }>(
    ADMIN_PRIVACY_PATHS.accountClosure,
    writeOptions(dependencies),
    async (request, reply) => {
      const actor = await authorize(request, reply, dependencies);
      if (actor === undefined) return;
      if (!validClosure(request.params.caseId, request.body))
        return reply.code(400).send({ code: "INVALID_REQUEST" });
      try {
        const result = await dependencies.operations.executeAccountClosure({
          actor,
          caseId: request.params.caseId,
          commandId: request.body.commandId,
          expectedRequestRevision: request.body.expectedRequestRevision,
          expectedRequestState: request.body.expectedRequestState,
          privilegedSessionId: request.session.sessionId,
          reason: request.body.reason,
          reasonCode: request.body.reasonCode,
          subjectUserId: request.body.subjectUserId,
        });
        if (result.status === "NOT_FOUND")
          return reply.code(404).send({ code: "NOT_FOUND" });
        if (
          result.status === "STALE_STATE" ||
          result.status === "OPEN_OBLIGATIONS" ||
          result.status === "ACCOUNT_NOT_ACTIVE" ||
          result.status === "ALREADY_DEACTIVATED"
        )
          return reply.code(409).send({ code: result.status });
        return reply.code(result.status === "APPLIED" ? 201 : 200).send({
          ...result,
          occurredAt: result.occurredAt.toISOString(),
          dispositions: result.dispositions.map((item) => ({
            ...item,
            occurredAt: item.occurredAt.toISOString(),
          })),
        });
      } catch (error) {
        return errorReply(reply, error);
      }
    },
  );
}

function writeOptions(dependencies: AdminPrivacyRouteDependencies) {
  return {
    config: {
      rateLimit: {
        max: Math.min(10, dependencies.rateLimit.max),
        timeWindow: dependencies.rateLimit.timeWindowMs,
      },
    },
    onRequest: [rejectQuery, dependencies.csrfProtection],
    onSend: privateHeaders,
  };
}

async function authorize(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: AdminPrivacyRouteDependencies,
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
    capability: "admin.privacy.manage",
    requireRecentMfa: true,
    sessionId: request.session.sessionId,
    userId: identity.user.id,
  });
  if (
    decision.status !== "AUTHORIZED" ||
    decision.actor.userId !== identity.user.id
  ) {
    await reply.code(403).send({ code: "PRIVILEGED_ACCESS_DENIED" });
    return undefined;
  }
  return decision.actor;
}

function adminRequestDto(item: PrivacyRequestSummary) {
  return {
    actionCode: item.actionCode,
    caseId: item.caseId,
    deadlineAt: item.deadlineAt?.toISOString() ?? null,
    occurredAt: item.occurredAt.toISOString(),
    receivedAt: item.receivedAt.toISOString(),
    requestType: item.requestType,
    revision: item.revision,
    state: item.state,
    subjectUserId: item.subjectUserId,
  };
}

function validTransition(
  caseId: string,
  body: unknown,
): body is TransitionBody {
  if (
    !validId(caseId) ||
    !record(body) ||
    !exactKeys(body, [
      "actionCode",
      "commandId",
      "deadlineAt",
      "expectedRevision",
      "expectedState",
      "reason",
      "resultingState",
    ])
  )
    return false;
  return (
    validId(body["commandId"]) &&
    validCode(body["actionCode"]) &&
    Number.isSafeInteger(body["expectedRevision"]) &&
    (body["expectedRevision"] as number) > 0 &&
    PRIVACY_REQUEST_STATE_VALUES.includes(
      body["expectedState"] as PrivacyRequestSummary["state"],
    ) &&
    body["resultingState"] !== "RECEIVED" &&
    PRIVACY_REQUEST_STATE_VALUES.includes(
      body["resultingState"] as PrivacyRequestSummary["state"],
    ) &&
    validDeadline(body["deadlineAt"]) &&
    validReason(body["reason"])
  );
}

function validClosure(caseId: string, body: unknown): body is ClosureBody {
  if (
    !validId(caseId) ||
    !record(body) ||
    !exactKeys(body, [
      "commandId",
      "expectedRequestRevision",
      "expectedRequestState",
      "reason",
      "reasonCode",
      "subjectUserId",
    ])
  )
    return false;
  return (
    validId(body["commandId"]) &&
    validId(body["subjectUserId"]) &&
    Number.isSafeInteger(body["expectedRequestRevision"]) &&
    (body["expectedRequestRevision"] as number) > 0 &&
    body["expectedRequestState"] === "IN_REVIEW" &&
    validCode(body["reasonCode"]) &&
    validReason(body["reason"])
  );
}

function errorReply(reply: FastifyReply, error: unknown) {
  if (error instanceof PrivacyAccountClosureIdempotencyError)
    return reply.code(409).send({ code: "IDEMPOTENCY_CONFLICT" });
  return error instanceof TypeError || error instanceof RangeError
    ? reply.code(400).send({ code: "INVALID_REQUEST" })
    : reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
}
function parseLimit(value: string | undefined): number | null {
  if (value === undefined) return 50;
  if (!/^\d{1,3}$/u.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return parsed >= 1 && parsed <= 100 ? parsed : null;
}
function validDeadline(value: unknown): boolean {
  if (value === null) return true;
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) &&
    Number.isFinite(new Date(value).valueOf())
  );
}
function validReason(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length >= 8 &&
    value.length <= 500 &&
    !/[\p{Cc}]/u.test(value)
  );
}
function validCode(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{2,63}$/u.test(value);
}
function validId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}
function rejectQuery(
  request: FastifyRequest,
  reply: FastifyReply,
  done: () => void,
): void {
  if (Object.keys(request.query as object).length !== 0) {
    void reply.code(400).send({ code: "INVALID_REQUEST" });
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
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}
