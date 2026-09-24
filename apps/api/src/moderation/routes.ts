import type { AdminAccessService, PrivilegedActor } from "@portal/admin-auth";
import {
  ModerationAppealIdempotencyError,
  ModerationIdempotencyError,
  type ModerationEnforcementScope,
  type ModerationReportState,
  type createModerationRepository,
} from "@portal/db";
import type { UserId } from "@portal/domain";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
} from "fastify";

import type {
  SessionAuthorizationScope,
  SessionGuardResult,
} from "../auth/guard.js";

type Repository = ReturnType<typeof createModerationRepository>;
type JsonObject = Record<string, unknown>;

export const MODERATION_APPEAL_PATH =
  "/v1/me/moderation/actions/:actionId/appeals";
export const MODERATION_ACTIONS_PATH = "/v1/me/moderation/actions";
export const ADMIN_MODERATION_PATHS = Object.freeze({
  queue: "/v1/admin/moderation/reports",
  access: "/v1/admin/moderation/reports/:reportId/access",
  startReview: "/v1/admin/moderation/reports/:reportId/start-review",
  noViolation: "/v1/admin/moderation/reports/:reportId/no-violation",
  warning: "/v1/admin/moderation/reports/:reportId/actions/warning",
  hideContent: "/v1/admin/moderation/reports/:reportId/actions/hide-content",
  excludeReviewEvidence:
    "/v1/admin/moderation/reports/:reportId/actions/exclude-review-evidence",
  restrictFeature:
    "/v1/admin/moderation/reports/:reportId/actions/restrict-feature",
  suspendTemporarily:
    "/v1/admin/moderation/reports/:reportId/actions/suspend-temporarily",
  suspendIndefinitely:
    "/v1/admin/moderation/reports/:reportId/actions/suspend-indefinitely",
  close: "/v1/admin/moderation/reports/:reportId/close",
  reopen: "/v1/admin/moderation/reports/:reportId/reopen",
  appealUphold: "/v1/admin/moderation/appeals/:appealId/uphold",
  appealReduce: "/v1/admin/moderation/appeals/:appealId/reduce",
  appealReverse: "/v1/admin/moderation/appeals/:appealId/reverse",
  appeals: "/v1/admin/moderation/appeals",
  appealAccess: "/v1/admin/moderation/appeals/:appealId/access",
});

interface CommonDependencies {
  readonly guard: {
    evaluate(
      request: FastifyRequest,
      scope?: SessionAuthorizationScope,
    ): Promise<SessionGuardResult>;
  };
  readonly csrfProtection: onRequestHookHandler;
  readonly rateLimit: { readonly max: number; readonly timeWindowMs: number };
}

export interface ModerationAppealRouteDependencies extends CommonDependencies {
  readonly moderation: Pick<Repository, "listMyActions" | "submitAppeal">;
}

export interface AdminModerationRouteDependencies extends CommonDependencies {
  readonly adminAccess: Pick<AdminAccessService, "authorize">;
  readonly moderation: Pick<
    Repository,
    | "listQueue"
    | "listAppeals"
    | "getReport"
    | "getAppeal"
    | "startReview"
    | "findNoViolation"
    | "warn"
    | "hideContent"
    | "excludeReviewEvidence"
    | "restrictFeature"
    | "suspendTemporarily"
    | "suspendIndefinitely"
    | "close"
    | "reopen"
    | "decideAppeal"
  >;
}

export function registerModerationAppealRoutes(
  app: FastifyInstance,
  dependencies: ModerationAppealRouteDependencies,
): void {
  app.get(
    MODERATION_ACTIONS_PATH,
    { onSend: privateHeaders },
    async (request, reply) => {
      const actorUserId = await appealActor(request, reply, dependencies);
      if (actorUserId === undefined) return;
      try {
        const items = await dependencies.moderation.listMyActions(actorUserId);
        return reply.send({ items });
      } catch {
        return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
      }
    },
  );

  app.post<{ Params: { actionId: string } }>(
    MODERATION_APPEAL_PATH,
    {
      config: {
        rateLimit: {
          max: Math.min(10, dependencies.rateLimit.max),
          timeWindow: dependencies.rateLimit.timeWindowMs,
        },
      },
      onRequest: dependencies.csrfProtection,
      onSend: privateHeaders,
    },
    async (request, reply) => {
      const actorUserId = await appealActor(request, reply, dependencies);
      if (actorUserId === undefined) return;
      const body = exactBody(request.body, [
        "appealId",
        "explanation",
        "evidenceReferenceType?",
        "evidenceReferenceId?",
      ]);
      if (
        !body ||
        !validId(request.params.actionId) ||
        !validId(body.appealId) ||
        !validText(body.explanation, 1, 4_000) ||
        !validEvidence(body)
      )
        return reply.code(400).send({ code: "INVALID_REQUEST" });
      try {
        const result = await dependencies.moderation.submitAppeal({
          actorUserId,
          appealId: body.appealId,
          actionId: request.params.actionId,
          explanation: body.explanation,
          ...(Object.hasOwn(body, "evidenceReferenceType")
            ? {
                evidenceReferenceType: body.evidenceReferenceType as
                  string | null,
                evidenceReferenceId: body.evidenceReferenceId as string | null,
              }
            : {}),
        });
        if (result.status === "NOT_FOUND")
          return reply.code(404).send({ code: "NOT_FOUND" });
        if (result.status === "ALREADY_APPEALED")
          return reply.code(409).send({ code: "ALREADY_APPEALED" });
        if (!("submittedAt" in result))
          throw new Error("Unexpected moderation appeal result.");
        return reply.code(result.status === "APPLIED" ? 201 : 200).send({
          ...result,
          submittedAt: result.submittedAt.toISOString(),
        });
      } catch (error) {
        return errorReply(reply, error);
      }
    },
  );
}

export function registerAdminModerationRoutes(
  app: FastifyInstance,
  dependencies: AdminModerationRouteDependencies,
): void {
  const writeOptions = {
    config: {
      rateLimit: {
        max: Math.min(10, dependencies.rateLimit.max),
        timeWindow: dependencies.rateLimit.timeWindowMs,
      },
    },
    onRequest: dependencies.csrfProtection,
    onSend: privateHeaders,
  } as const;

  app.get<{ Querystring: { state?: string; limit?: string } }>(
    ADMIN_MODERATION_PATHS.queue,
    { onSend: privateHeaders },
    async (request, reply) => {
      const actor = await authorize(request, reply, dependencies);
      if (!actor) return;
      const state = request.query.state;
      if (state !== undefined && !states.has(state as ModerationReportState))
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
        const items = await dependencies.moderation.listQueue({
          actor,
          privilegedSessionId: request.session.sessionId,
          ...(state === undefined
            ? {}
            : { state: state as ModerationReportState }),
          ...(limit === undefined ? {} : { limit }),
        });
        return reply.send({ items });
      } catch {
        return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
      }
    },
  );

  app.post<{ Params: { reportId: string } }>(
    ADMIN_MODERATION_PATHS.access,
    writeOptions,
    async (request, reply) => {
      const actor = await authorize(request, reply, dependencies);
      if (!actor) return;
      const body = exactBody(request.body, ["accessId", "reason"]);
      if (
        !body ||
        !validId(request.params.reportId) ||
        !validId(body.accessId) ||
        !validReason(body.reason)
      )
        return reply.code(400).send({ code: "INVALID_REQUEST" });
      try {
        const detail = await dependencies.moderation.getReport({
          actor,
          privilegedSessionId: request.session.sessionId,
          reportId: request.params.reportId,
          accessId: body.accessId,
          reason: body.reason,
        });
        return detail === null
          ? reply.code(404).send({ code: "NOT_FOUND" })
          : reply.send({ detail });
      } catch {
        return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
      }
    },
  );

  app.get<{ Querystring: { state?: string; limit?: string } }>(
    ADMIN_MODERATION_PATHS.appeals,
    { onSend: privateHeaders },
    async (request, reply) => {
      const actor = await authorize(request, reply, dependencies);
      if (!actor) return;
      const state = request.query.state;
      if (
        state !== undefined &&
        !["OPEN", "UPHELD", "REDUCED", "REVERSED"].includes(state)
      )
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
        const items = await dependencies.moderation.listAppeals({
          actor,
          privilegedSessionId: request.session.sessionId,
          ...(state === undefined
            ? {}
            : {
                state: state as "OPEN" | "UPHELD" | "REDUCED" | "REVERSED",
              }),
          ...(limit === undefined ? {} : { limit }),
        });
        return reply.send({ items });
      } catch {
        return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
      }
    },
  );

  app.post<{ Params: { appealId: string } }>(
    ADMIN_MODERATION_PATHS.appealAccess,
    writeOptions,
    async (request, reply) => {
      const actor = await authorize(request, reply, dependencies);
      if (!actor) return;
      const body = exactBody(request.body, ["accessId", "reason"]);
      if (
        !body ||
        !validId(request.params.appealId) ||
        !validId(body.accessId) ||
        !validReason(body.reason)
      )
        return reply.code(400).send({ code: "INVALID_REQUEST" });
      try {
        const detail = await dependencies.moderation.getAppeal({
          actor,
          privilegedSessionId: request.session.sessionId,
          appealId: request.params.appealId,
          accessId: body.accessId,
          reason: body.reason,
        });
        return detail === null
          ? reply.code(404).send({ code: "NOT_FOUND" })
          : reply.send({ detail });
      } catch {
        return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
      }
    },
  );

  for (const [path, operation] of [
    [ADMIN_MODERATION_PATHS.startReview, "startReview"],
    [ADMIN_MODERATION_PATHS.close, "close"],
    [ADMIN_MODERATION_PATHS.reopen, "reopen"],
  ] as const) {
    app.post<{ Params: { reportId: string } }>(
      path,
      writeOptions,
      async (request, reply) => {
        const actor = await authorize(request, reply, dependencies);
        if (!actor) return;
        const body = baseBody(request.params.reportId, request.body);
        if (!body) return reply.code(400).send({ code: "INVALID_REQUEST" });
        return commandReply(reply, () =>
          dependencies.moderation[operation]({
            actor,
            privilegedSessionId: request.session.sessionId,
            ...body,
          }),
        );
      },
    );
  }

  app.post<{ Params: { reportId: string } }>(
    ADMIN_MODERATION_PATHS.noViolation,
    writeOptions,
    async (request, reply) => {
      const actor = await authorize(request, reply, dependencies);
      if (!actor) return;
      const body = policyBody(request.params.reportId, request.body, false);
      if (!body) return reply.code(400).send({ code: "INVALID_REQUEST" });
      return commandReply(reply, () =>
        dependencies.moderation.findNoViolation({
          actor,
          privilegedSessionId: request.session.sessionId,
          ...body,
        }),
      );
    },
  );

  const effects = [
    [ADMIN_MODERATION_PATHS.warning, "warn", "CONTENT", false],
    [ADMIN_MODERATION_PATHS.hideContent, "hideContent", "CONTENT", false],
    [
      ADMIN_MODERATION_PATHS.excludeReviewEvidence,
      "excludeReviewEvidence",
      "CONTENT",
      false,
    ],
    [ADMIN_MODERATION_PATHS.restrictFeature, "restrictFeature", null, false],
    [
      ADMIN_MODERATION_PATHS.suspendTemporarily,
      "suspendTemporarily",
      null,
      true,
    ],
    [
      ADMIN_MODERATION_PATHS.suspendIndefinitely,
      "suspendIndefinitely",
      "ACCOUNT",
      false,
    ],
  ] as const;
  for (const [path, operation, fixedScope, expiryRequired] of effects) {
    app.post<{ Params: { reportId: string } }>(
      path,
      writeOptions,
      async (request, reply) => {
        const actor = await authorize(request, reply, dependencies);
        if (!actor) return;
        const body = effectBody(
          request.params.reportId,
          request.body,
          fixedScope,
          expiryRequired,
        );
        if (!body) return reply.code(400).send({ code: "INVALID_REQUEST" });
        return commandReply(reply, () =>
          dependencies.moderation[operation]({
            actor,
            privilegedSessionId: request.session.sessionId,
            ...body,
          }),
        );
      },
    );
  }

  for (const [path, decision] of [
    [ADMIN_MODERATION_PATHS.appealUphold, "UPHOLD"],
    [ADMIN_MODERATION_PATHS.appealReduce, "REDUCE"],
    [ADMIN_MODERATION_PATHS.appealReverse, "REVERSE"],
  ] as const) {
    app.post<{ Params: { appealId: string } }>(
      path,
      writeOptions,
      async (request, reply) => {
        const actor = await authorize(request, reply, dependencies);
        if (!actor) return;
        const body = appealDecisionBody(
          request.params.appealId,
          request.body,
          decision,
        );
        if (!body) return reply.code(400).send({ code: "INVALID_REQUEST" });
        return appealCommandReply(reply, () =>
          dependencies.moderation.decideAppeal({
            actor,
            privilegedSessionId: request.session.sessionId,
            ...body,
          }),
        );
      },
    );
  }
}

async function appealActor(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: CommonDependencies,
): Promise<UserId | undefined> {
  const result = await dependencies.guard.evaluate(
    request,
    "RESTRICTED_ACCOUNT_APPEAL",
  );
  if (result.status === "AUTHENTICATION_REQUIRED") {
    await reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" });
    return undefined;
  }
  if (
    result.status === "ACCOUNT_NOT_ACTIVE" &&
    result.user.accountState !== "SUSPENDED"
  ) {
    await reply.code(403).send({ code: "ACCOUNT_NOT_ACTIVE" });
    return undefined;
  }
  return result.user.id;
}

async function authorize(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: AdminModerationRouteDependencies,
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
    capability: "admin.reviews.moderate",
    requireRecentMfa: true,
    sessionId: request.session.sessionId,
    userId: identity.user.id,
  });
  if (
    decision.status !== "AUTHORIZED" ||
    decision.actor.userId !== identity.user.id ||
    !decision.actor.capabilities.has("admin.reviews.moderate")
  ) {
    await reply.code(403).send({ code: "PRIVILEGED_ACCESS_DENIED" });
    return undefined;
  }
  return decision.actor;
}

async function commandReply(
  reply: FastifyReply,
  execute: () => Promise<Awaited<ReturnType<Repository["startReview"]>>>,
) {
  try {
    const result = await execute();
    if (result.status === "NOT_FOUND")
      return reply.code(404).send({ code: "NOT_FOUND" });
    if (result.status === "STALE_STATE")
      return reply.code(409).send({ code: "STALE_STATE" });
    if (!("recordedAt" in result))
      throw new Error("Unexpected moderation command result.");
    return reply.code(result.status === "APPLIED" ? 201 : 200).send({
      ...result,
      recordedAt: result.recordedAt.toISOString(),
    });
  } catch (error) {
    return errorReply(reply, error);
  }
}

async function appealCommandReply(
  reply: FastifyReply,
  execute: () => Promise<Awaited<ReturnType<Repository["decideAppeal"]>>>,
) {
  try {
    const result = await execute();
    if (result.status === "NOT_FOUND")
      return reply.code(404).send({ code: "NOT_FOUND" });
    if (result.status === "STALE_STATE")
      return reply.code(409).send({ code: "STALE_STATE" });
    if (!("recordedAt" in result))
      throw new Error("Unexpected moderation appeal decision result.");
    return reply.code(result.status === "APPLIED" ? 201 : 200).send({
      ...result,
      recordedAt: result.recordedAt.toISOString(),
    });
  } catch (error) {
    return errorReply(reply, error);
  }
}

function errorReply(reply: FastifyReply, error: unknown) {
  if (error instanceof TypeError)
    return reply.code(400).send({ code: "INVALID_REQUEST" });
  if (
    error instanceof ModerationIdempotencyError ||
    error instanceof ModerationAppealIdempotencyError
  )
    return reply.code(409).send({ code: "IDEMPOTENCY_CONFLICT" });
  return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
}

function baseBody(reportId: string, value: unknown) {
  const body = exactBody(value, ["commandId", "expectedState", "reason"]);
  if (
    !body ||
    !validId(reportId) ||
    !validId(body.commandId) ||
    typeof body.expectedState !== "string" ||
    !states.has(body.expectedState as ModerationReportState) ||
    !validReason(body.reason)
  )
    return null;
  return {
    commandId: body.commandId,
    reportId,
    expectedState: body.expectedState as ModerationReportState,
    reason: body.reason,
  };
}

function policyBody(reportId: string, value: unknown, effect: boolean) {
  const optional = effect
    ? ["privateAdminNote?", "restrictionExpiresAt?"]
    : ["privateAdminNote?"];
  const required = effect
    ? [
        "commandId",
        "expectedState",
        "reason",
        "policyCategory",
        "policyReasonCode",
        "policyVersion",
        "subjectUserId",
        "enforcementScope",
        "userFacingReason",
        "priorState",
        ...optional,
      ]
    : [
        "commandId",
        "expectedState",
        "reason",
        "policyCategory",
        "policyReasonCode",
        "policyVersion",
        ...optional,
      ];
  const body = exactBody(value, required);
  if (!body) return null;
  const base = baseFields(reportId, body);
  if (
    !base ||
    !validCode(body.policyCategory) ||
    !validCode(body.policyReasonCode) ||
    !validPolicyVersion(body.policyVersion) ||
    !validOptionalText(body.privateAdminNote, 1, 4_000)
  )
    return null;
  return {
    ...base,
    policyCategory: body.policyCategory,
    policyReasonCode: body.policyReasonCode,
    policyVersion: body.policyVersion,
    ...(Object.hasOwn(body, "privateAdminNote")
      ? { privateAdminNote: body.privateAdminNote as string | null }
      : {}),
  };
}

function effectBody(
  reportId: string,
  value: unknown,
  fixedScope: ModerationEnforcementScope | null,
  expiryRequired: boolean,
) {
  const body = policyBody(reportId, value, true);
  if (!body || !isRecord(value)) return null;
  const scope = fixedScope ?? value.enforcementScope;
  if (
    !validId(value.subjectUserId) ||
    typeof scope !== "string" ||
    !scopes.has(scope as ModerationEnforcementScope) ||
    (fixedScope !== null && value.enforcementScope !== fixedScope) ||
    !validText(value.userFacingReason, 8, 1_000) ||
    !validPriorState(value.priorState)
  )
    return null;
  const expires = Object.hasOwn(value, "restrictionExpiresAt")
    ? parseDate(value.restrictionExpiresAt)
    : null;
  if (expiryRequired && expires === null) return null;
  if (!expiryRequired && value.restrictionExpiresAt != null) return null;
  return {
    ...body,
    subjectUserId: value.subjectUserId,
    enforcementScope: scope as ModerationEnforcementScope,
    restrictionExpiresAt: expires,
    userFacingReason: value.userFacingReason,
    priorState: value.priorState as Record<
      string,
      boolean | number | string | null
    >,
  };
}

function appealDecisionBody(
  appealId: string,
  value: unknown,
  decision: "UPHOLD" | "REDUCE" | "REVERSE",
) {
  const body = exactBody(value, [
    "commandId",
    "expectedState",
    "reason",
    "policyReasonCode",
    "policyVersion",
    "userFacingReason",
    "privateAdminNote?",
    "reducedScope?",
    "reducedExpiresAt?",
  ]);
  if (
    !body ||
    !validId(appealId) ||
    !validId(body.commandId) ||
    body.expectedState !== "OPEN" ||
    !validReason(body.reason) ||
    !validCode(body.policyReasonCode) ||
    !validPolicyVersion(body.policyVersion) ||
    !validText(body.userFacingReason, 8, 1_000) ||
    !validOptionalText(body.privateAdminNote, 1, 4_000)
  )
    return null;
  const reducedScope = Object.hasOwn(body, "reducedScope")
    ? body.reducedScope
    : null;
  const reducedExpiresAt = Object.hasOwn(body, "reducedExpiresAt")
    ? parseDate(body.reducedExpiresAt)
    : null;
  if (
    (decision === "REDUCE" &&
      (typeof reducedScope !== "string" ||
        !scopes.has(reducedScope as ModerationEnforcementScope))) ||
    (decision !== "REDUCE" &&
      (reducedScope !== null || reducedExpiresAt !== null))
  )
    return null;
  return {
    appealId,
    commandId: body.commandId,
    expectedState: "OPEN" as const,
    decision,
    reason: body.reason,
    policyReasonCode: body.policyReasonCode,
    policyVersion: body.policyVersion,
    userFacingReason: body.userFacingReason,
    ...(Object.hasOwn(body, "privateAdminNote")
      ? { privateAdminNote: body.privateAdminNote as string | null }
      : {}),
    ...(decision === "REDUCE"
      ? {
          reducedScope: reducedScope as ModerationEnforcementScope,
          reducedExpiresAt,
        }
      : {}),
  };
}

function baseFields(reportId: string, body: JsonObject) {
  if (
    !validId(reportId) ||
    !validId(body.commandId) ||
    typeof body.expectedState !== "string" ||
    !states.has(body.expectedState as ModerationReportState) ||
    !validReason(body.reason)
  )
    return null;
  return {
    commandId: body.commandId,
    reportId,
    expectedState: body.expectedState as ModerationReportState,
    reason: body.reason,
  };
}

function exactBody(value: unknown, keys: readonly string[]): JsonObject | null {
  if (!isRecord(value)) return null;
  const required = keys.filter((key) => !key.endsWith("?"));
  const allowed = keys.map((key) => key.replace(/\?$/u, ""));
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.includes(key))
    ? value
    : null;
}

function validEvidence(body: JsonObject): boolean {
  const hasType = Object.hasOwn(body, "evidenceReferenceType");
  const hasId = Object.hasOwn(body, "evidenceReferenceId");
  if (!hasType && !hasId) return true;
  if (hasType !== hasId) return false;
  if (body.evidenceReferenceType === null)
    return body.evidenceReferenceId === null;
  return (
    typeof body.evidenceReferenceType === "string" &&
    /^[A-Z][A-Z0-9_]{1,63}$/u.test(body.evidenceReferenceType) &&
    validId(body.evidenceReferenceId)
  );
}

function validPriorState(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).length > 12) return false;
  return Object.entries(value).every(
    ([key, item]) =>
      /^[a-z][a-z0-9_]{0,47}$/u.test(key) &&
      (item === null ||
        typeof item === "boolean" ||
        typeof item === "number" ||
        (typeof item === "string" && /^[A-Z0-9_.:-]{1,96}$/u.test(item))),
  );
}

function validReason(value: unknown): value is string {
  return validText(value, 8, 500) && !unsafeReason.test(value);
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
function validOptionalText(
  value: unknown,
  minimum: number,
  maximum: number,
): boolean {
  return (
    value === undefined || value === null || validText(value, minimum, maximum)
  );
}
function validCode(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z][A-Z0-9_.:-]{2,95}$/u.test(value);
}
function validPolicyVersion(value: unknown): value is string {
  return (
    typeof value === "string" && /^[A-Z0-9][A-Z0-9_.:-]{0,63}$/u.test(value)
  );
}
function validId(value: unknown): value is string {
  return typeof value === "string" && uuid.test(value);
}
function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/u.test(value))
    return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}
function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const states = new Set<ModerationReportState>([
  "OPEN",
  "UNDER_REVIEW",
  "ACTIONED",
  "NO_VIOLATION",
  "CLOSED",
]);
const scopes = new Set<ModerationEnforcementScope>([
  "CONTENT",
  "MESSAGING",
  "PUBLISHING",
  "QUOTING",
  "REVIEWS",
  "ACCOUNT",
]);
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const unsafeReason =
  /(?:[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|https?:\/\/|bearer\s+\S+|(?:\+?\d[\d ().-]{6,}\d))/iu;

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
