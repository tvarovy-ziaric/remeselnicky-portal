import {
  JobPropertyPhotoConsentIdempotencyError,
  type createJobPropertyPhotoConsentRepository,
} from "@portal/db";
import type { UserId } from "@portal/domain";
import { JOB_PROPERTY_PHOTO_CONSENT_ACTION_VALUES } from "@portal/privacy";
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

type ConsentRepository = ReturnType<
  typeof createJobPropertyPhotoConsentRepository
>;

export const JOB_PROPERTY_PHOTO_CONSENT_PATHS = Object.freeze({
  item: "/v1/me/jobs/:jobId/property-photo-consents/:mediaAssetId",
  list: "/v1/me/jobs/:jobId/property-photo-consents",
} as const);

export interface JobPropertyPhotoConsentRouteDependencies {
  readonly consent: Pick<
    ConsentRepository,
    "appendDecision" | "listForCustomerJob"
  >;
  readonly csrfProtection: onRequestHookHandler;
  readonly guard: {
    evaluate(
      request: FastifyRequest,
      scope?: SessionAuthorizationScope,
    ): Promise<SessionGuardResult>;
  };
  readonly rateLimit: { readonly max: number; readonly timeWindowMs: number };
}

interface DecisionBody {
  readonly action: "DECLINED" | "GRANTED" | "WITHDRAWN";
  readonly correlationId: string;
  readonly eventId: string;
  readonly expectedRevision: number;
  readonly policyVersionId: string;
}

export function registerJobPropertyPhotoConsentRoutes(
  app: FastifyInstance,
  dependencies: JobPropertyPhotoConsentRouteDependencies,
): void {
  app.get<{ Params: { jobId: string } }>(
    JOB_PROPERTY_PHOTO_CONSENT_PATHS.list,
    { onRequest: rejectQuery, onSend: privateHeaders },
    async (request, reply) => {
      const customerUserId = await consentActor(request, reply, dependencies);
      if (customerUserId === undefined) return;
      if (!validId(request.params.jobId))
        return reply.code(400).send({ code: "INVALID_REQUEST" });
      try {
        const result = await dependencies.consent.listForCustomerJob({
          customerUserId,
          jobId: request.params.jobId,
        });
        if (result === null) return reply.code(404).send({ code: "NOT_FOUND" });
        return reply.send({
          items: result.items.map((item) => ({
            ...item,
            downloadPath: `/v1/media/${item.mediaAssetId}/download`,
            occurredAt: item.occurredAt?.toISOString() ?? null,
          })),
          policy: result.policy,
        });
      } catch {
        return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
      }
    },
  );

  app.post<{
    Body: DecisionBody;
    Params: { jobId: string; mediaAssetId: string };
  }>(
    JOB_PROPERTY_PHOTO_CONSENT_PATHS.item,
    {
      config: {
        rateLimit: {
          max: Math.min(20, dependencies.rateLimit.max),
          timeWindow: dependencies.rateLimit.timeWindowMs,
        },
      },
      onRequest: [rejectQuery, dependencies.csrfProtection],
      onSend: privateHeaders,
    },
    async (request, reply) => {
      const customerUserId = await consentActor(request, reply, dependencies);
      if (customerUserId === undefined) return;
      if (
        !validId(request.params.jobId) ||
        !validId(request.params.mediaAssetId) ||
        !validDecision(request.body)
      )
        return reply.code(400).send({ code: "INVALID_REQUEST" });
      try {
        const result = await dependencies.consent.appendDecision({
          ...request.body,
          customerUserId,
          jobId: request.params.jobId,
          mediaAssetId: request.params.mediaAssetId,
        });
        if (result.status === "NOT_FOUND")
          return reply.code(404).send({ code: "NOT_FOUND" });
        if (result.status === "POLICY_NOT_APPROVED")
          return reply.code(409).send({ code: "CONSENT_POLICY_UNAVAILABLE" });
        if (result.status === "STALE")
          return reply.code(409).send({
            code: "STALE_STATE",
            currentRevision: result.currentRevision,
          });
        if (result.status === "UNCHANGED")
          return reply.send({
            currentRevision: result.currentRevision,
            status: result.status,
          });
        return reply.code(result.status === "APPENDED" ? 201 : 200).send({
          event: {
            action: result.event.action,
            eventId: result.event.eventId,
            mediaAssetId: result.event.mediaAssetId,
            occurredAt: result.event.occurredAt.toISOString(),
            policyVersionId: result.event.policyVersionId,
            revision: result.event.revision,
          },
          status: result.status,
        });
      } catch (error) {
        if (error instanceof JobPropertyPhotoConsentIdempotencyError)
          return reply.code(409).send({ code: "IDEMPOTENCY_CONFLICT" });
        return error instanceof TypeError
          ? reply.code(400).send({ code: "INVALID_REQUEST" })
          : reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
      }
    },
  );
}

async function consentActor(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: JobPropertyPhotoConsentRouteDependencies,
): Promise<UserId | undefined> {
  const result = await dependencies.guard.evaluate(request, "PRIVACY_REQUEST");
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

function validDecision(value: unknown): value is DecisionBody {
  if (!record(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [
    "action",
    "correlationId",
    "eventId",
    "expectedRevision",
    "policyVersionId",
  ];
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]) &&
    JOB_PROPERTY_PHOTO_CONSENT_ACTION_VALUES.includes(
      value.action as DecisionBody["action"],
    ) &&
    validId(value.correlationId) &&
    validId(value.eventId) &&
    Number.isSafeInteger(value.expectedRevision) &&
    (value.expectedRevision as number) >= 0 &&
    validId(value.policyVersionId)
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
function validId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}
