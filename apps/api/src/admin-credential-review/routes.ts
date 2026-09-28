import type { AdminAccessService } from "@portal/admin-auth";
import {
  CredentialClaimIdempotencyError,
  type AdminCredentialReviewHistoryItem,
  type AdminCredentialReviewItem,
  type CredentialReviewService,
} from "@portal/db";
import type { CredentialReviewReasonCategory, UserId } from "@portal/domain";
import type { PrivateMediaEndpointResponse } from "@portal/media";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
} from "fastify";

import type { SessionGuardResult } from "../auth/guard.js";

export const ADMIN_CREDENTIAL_REVIEW_PATHS = Object.freeze({
  approve: "/v1/admin/credential-claims/:claimId/approve",
  detail: "/v1/admin/credential-claims/:claimId/review",
  evidence: "/v1/admin/credential-claims/:claimId/evidence/:mediaAssetId",
  history: "/v1/admin/credential-claims/review-history",
  queue: "/v1/admin/credential-claims/review-queue",
  reject: "/v1/admin/credential-claims/:claimId/reject",
  revoke: "/v1/admin/credential-claims/:claimId/revoke",
});

export interface AdminCredentialReviewRouteDependencies {
  readonly adminAccess: Pick<AdminAccessService, "authorize">;
  readonly credentialReview: Pick<CredentialReviewService, "review">;
  readonly csrfProtection: onRequestHookHandler;
  readonly evidenceDelivery?: {
    handleDownload(input: {
      readonly actorUserId: string;
      readonly mediaAssetId: string;
    }): Promise<PrivateMediaEndpointResponse>;
  };
  readonly guard: {
    evaluate(request: FastifyRequest): Promise<SessionGuardResult>;
  };
  readonly rateLimit: { readonly max: number; readonly timeWindowMs: number };
  readonly reviews: {
    findReviewable(claimId: string): Promise<AdminCredentialReviewItem | null>;
    listPending(input: {
      readonly cursor?: string;
      readonly limit: number;
    }): Promise<{
      readonly items: readonly AdminCredentialReviewItem[];
      readonly nextCursor: string | null;
    }>;
    listReviewed(input: {
      readonly cursor?: string;
      readonly limit: number;
      readonly state: AdminCredentialReviewHistoryItem["state"];
    }): Promise<{
      readonly items: readonly AdminCredentialReviewHistoryItem[];
      readonly nextCursor: string | null;
    }>;
  };
}

const uuid =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const reasonCategories = [
  "INSUFFICIENT_EVIDENCE",
  "FALSE_QUALIFICATION",
  "FALSE_IDENTITY",
  "MISLEADING_CLAIM",
  "EXPIRED_OR_INVALID",
  "OTHER",
] as const satisfies readonly CredentialReviewReasonCategory[];

const claimParamsSchema = {
  type: "object",
  additionalProperties: false,
  properties: { claimId: { type: "string", pattern: uuid } },
  required: ["claimId"],
} as const;

export function registerAdminCredentialReviewRoutes(
  app: FastifyInstance,
  dependencies: AdminCredentialReviewRouteDependencies,
): void {
  const readConfig = Object.freeze({
    rateLimit: {
      max: Math.min(10, dependencies.rateLimit.max),
      timeWindow: dependencies.rateLimit.timeWindowMs,
    },
  });

  app.get<{ Querystring: { cursor?: string; limit?: number } }>(
    ADMIN_CREDENTIAL_REVIEW_PATHS.queue,
    {
      config: readConfig,
      onSend: noStore,
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            cursor: { type: "string", pattern: uuid },
            limit: { type: "integer", minimum: 1, maximum: 50 },
          },
        },
      },
    },
    async (request, reply) => {
      const actorUserId = await requireAuthorized(request, reply, dependencies);
      if (actorUserId === undefined) return;
      try {
        const page = await dependencies.reviews.listPending({
          ...(request.query.cursor === undefined
            ? {}
            : { cursor: request.query.cursor }),
          limit: request.query.limit ?? 20,
        });
        if ((await authorizedActor(request, dependencies)) !== actorUserId) {
          return reply.code(403).send({ code: "PRIVILEGED_ACCESS_DENIED" });
        }
        return reply.code(200).send({
          items: page.items.map(serializeReview),
          nextCursor: page.nextCursor,
        });
      } catch (error) {
        return readError(reply, error);
      }
    },
  );

  app.get<{
    Querystring: {
      cursor?: string;
      limit?: number;
      state: AdminCredentialReviewHistoryItem["state"];
    };
  }>(
    ADMIN_CREDENTIAL_REVIEW_PATHS.history,
    {
      config: readConfig,
      onSend: noStore,
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            cursor: { type: "string", pattern: uuid },
            limit: { type: "integer", minimum: 1, maximum: 50 },
            state: {
              type: "string",
              enum: ["APPROVED", "REJECTED", "REVOKED"],
            },
          },
          required: ["state"],
        },
      },
    },
    async (request, reply) => {
      const actorUserId = await requireAuthorized(request, reply, dependencies);
      if (actorUserId === undefined) return;
      try {
        const page = await dependencies.reviews.listReviewed({
          ...(request.query.cursor === undefined
            ? {}
            : { cursor: request.query.cursor }),
          limit: request.query.limit ?? 20,
          state: request.query.state,
        });
        if ((await authorizedActor(request, dependencies)) !== actorUserId) {
          return reply.code(403).send({ code: "PRIVILEGED_ACCESS_DENIED" });
        }
        return reply.code(200).send({
          items: page.items.map((item) =>
            serializeHistory(item, request.query.state),
          ),
          nextCursor: page.nextCursor,
        });
      } catch (error) {
        return readError(reply, error);
      }
    },
  );

  app.get<{ Params: { claimId: string } }>(
    ADMIN_CREDENTIAL_REVIEW_PATHS.detail,
    {
      config: readConfig,
      onSend: noStore,
      schema: { params: claimParamsSchema },
    },
    async (request, reply) => {
      const actorUserId = await requireAuthorized(request, reply, dependencies);
      if (actorUserId === undefined) return;
      try {
        const item = await dependencies.reviews.findReviewable(
          request.params.claimId,
        );
        if (item === null) return reply.code(404).send({ code: "NOT_FOUND" });
        if ((await authorizedActor(request, dependencies)) !== actorUserId) {
          return reply.code(403).send({ code: "PRIVILEGED_ACCESS_DENIED" });
        }
        return reply.code(200).send(serializeReview(item));
      } catch (error) {
        return readError(reply, error);
      }
    },
  );

  app.get<{ Params: { claimId: string; mediaAssetId: string } }>(
    ADMIN_CREDENTIAL_REVIEW_PATHS.evidence,
    {
      config: readConfig,
      onSend: noStore,
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          properties: {
            claimId: { type: "string", pattern: uuid },
            mediaAssetId: { type: "string", pattern: uuid },
          },
          required: ["claimId", "mediaAssetId"],
        },
      },
    },
    async (request, reply) => {
      void reply.header("x-content-type-options", "nosniff");
      const actorUserId = await requireAuthorized(request, reply, dependencies);
      if (actorUserId === undefined) return;
      if (dependencies.evidenceDelivery === undefined) {
        return reply.code(503).send({ code: "MEDIA_DELIVERY_UNAVAILABLE" });
      }
      try {
        if (
          !(await isExactReviewEvidence(
            request.params.claimId,
            request.params.mediaAssetId,
            dependencies,
          ))
        ) {
          return reply.code(404).send({ code: "MEDIA_NOT_FOUND" });
        }
        const result = await dependencies.evidenceDelivery.handleDownload({
          actorUserId,
          mediaAssetId: request.params.mediaAssetId,
        });
        if (result.statusCode !== 303) {
          reply.headers(result.headers);
          return reply.code(result.statusCode).send(result.body);
        }

        const stillAuthorized = await authorizedActor(request, dependencies);
        if (
          stillAuthorized !== actorUserId ||
          !(await isExactReviewEvidence(
            request.params.claimId,
            request.params.mediaAssetId,
            dependencies,
          ))
        ) {
          return reply.code(404).send({ code: "MEDIA_NOT_FOUND" });
        }
        reply.headers(result.headers);
        return reply.code(303).send();
      } catch {
        return reply.code(503).send({ code: "MEDIA_DELIVERY_UNAVAILABLE" });
      }
    },
  );

  registerDecisionRoute(app, dependencies, "APPROVE");
  registerDecisionRoute(app, dependencies, "REJECT");
  registerDecisionRoute(app, dependencies, "REVOKE");
}

function registerDecisionRoute(
  app: FastifyInstance,
  dependencies: AdminCredentialReviewRouteDependencies,
  decision: "APPROVE" | "REJECT" | "REVOKE",
): void {
  const needsReason = decision !== "APPROVE";
  const keys = needsReason
    ? ["commandId", "expectedRevision", "reasonCategory", "reason"]
    : ["commandId", "expectedRevision"];
  const path =
    decision === "APPROVE"
      ? ADMIN_CREDENTIAL_REVIEW_PATHS.approve
      : decision === "REJECT"
        ? ADMIN_CREDENTIAL_REVIEW_PATHS.reject
        : ADMIN_CREDENTIAL_REVIEW_PATHS.revoke;

  app.post<{
    Body: {
      commandId: string;
      expectedRevision: number;
      reason?: string;
      reasonCategory?: CredentialReviewReasonCategory;
    };
    Params: { claimId: string };
  }>(
    path,
    {
      config: {
        rateLimit: {
          max: Math.min(5, dependencies.rateLimit.max),
          timeWindow: dependencies.rateLimit.timeWindowMs,
        },
      },
      onRequest: dependencies.csrfProtection,
      onSend: noStore,
      preValidation: exactBody(keys),
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            commandId: { type: "string", pattern: uuid },
            expectedRevision: {
              type: "integer",
              minimum: 1,
              maximum: 2_147_483_647,
            },
            reason: { type: "string", minLength: 8, maxLength: 500 },
            reasonCategory: { type: "string", enum: reasonCategories },
          },
          required: keys,
        },
        params: claimParamsSchema,
      },
    },
    async (request, reply) => {
      const actorUserId = await requireAuthorized(request, reply, dependencies);
      if (actorUserId === undefined) return;
      try {
        const result = await dependencies.credentialReview.review({
          actorUserId: actorUserId as UserId,
          privilegedSessionId: request.session.sessionId,
          command:
            decision === "APPROVE"
              ? {
                  claimId: request.params.claimId as never,
                  commandId: request.body.commandId,
                  decision,
                  expectedRevision: request.body.expectedRevision,
                }
              : {
                  claimId: request.params.claimId as never,
                  commandId: request.body.commandId,
                  decision,
                  expectedRevision: request.body.expectedRevision,
                  reason: request.body.reason!,
                  reasonCategory: request.body.reasonCategory!,
                },
        });
        return decisionReply(reply, result);
      } catch (error) {
        return commandError(reply, error);
      }
    },
  );
}

async function requireAuthorized(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: AdminCredentialReviewRouteDependencies,
): Promise<string | undefined> {
  const identity = await dependencies.guard.evaluate(request);
  if (identity.status === "AUTHENTICATION_REQUIRED") {
    await reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" });
    return undefined;
  }
  if (identity.status === "ACCOUNT_NOT_ACTIVE") {
    await reply.code(403).send({ code: "ACCOUNT_NOT_ACTIVE" });
    return undefined;
  }
  const actor = await authorizeIdentity(
    identity.user.id,
    request.session.sessionId,
    dependencies,
  );
  if (actor === undefined) {
    await reply.code(403).send({ code: "PRIVILEGED_ACCESS_DENIED" });
  }
  return actor;
}

async function authorizedActor(
  request: FastifyRequest,
  dependencies: AdminCredentialReviewRouteDependencies,
): Promise<string | undefined> {
  const identity = await dependencies.guard.evaluate(request);
  if (identity.status !== "ACTIVE") return undefined;
  return authorizeIdentity(
    identity.user.id,
    request.session.sessionId,
    dependencies,
  );
}

async function authorizeIdentity(
  userId: string,
  sessionId: string,
  dependencies: AdminCredentialReviewRouteDependencies,
): Promise<string | undefined> {
  const decision = await dependencies.adminAccess.authorize({
    capability: "admin.credentials.review",
    requireRecentMfa: true,
    sessionId,
    userId: userId as UserId,
  });
  if (
    decision.status !== "AUTHORIZED" ||
    decision.actor.userId !== userId ||
    !decision.actor.capabilities.has("admin.credentials.review")
  ) {
    return undefined;
  }
  return userId;
}

async function isExactReviewEvidence(
  claimId: string,
  mediaAssetId: string,
  dependencies: AdminCredentialReviewRouteDependencies,
): Promise<boolean> {
  const claim = await dependencies.reviews.findReviewable(claimId);
  return (
    claim !== null &&
    claim.evidence.some((evidence) => evidence.assetId === mediaAssetId)
  );
}

function serializeReview(
  item: AdminCredentialReviewItem | AdminCredentialReviewHistoryItem,
) {
  return {
    claimId: item.claimId,
    createdAt: item.createdAt.toISOString(),
    credentialTypeCode: item.credentialTypeCode,
    evidence: item.evidence.map((evidence) => ({
      assetId: evidence.assetId,
      attachedAt: evidence.attachedAt.toISOString(),
      mediaKind: evidence.mediaKind,
    })),
    evidenceRequirement: item.evidenceRequirement,
    expiresOn: item.expiresOn,
    profession: item.profession,
    profile: item.profile,
    revision: item.revision,
    state: item.state,
    updatedAt: item.updatedAt.toISOString(),
  };
}

function serializeHistory(
  item: AdminCredentialReviewHistoryItem,
  expectedState: AdminCredentialReviewHistoryItem["state"],
) {
  if (item.state !== expectedState)
    throw new Error("Credential-review history state mismatch.");
  return {
    ...serializeReview(item),
    reviewReason: item.reviewReason,
    reviewReasonCategory: item.reviewReasonCategory,
    reviewedAt: item.reviewedAt.toISOString(),
  };
}

function decisionReply(
  reply: FastifyReply,
  result: Awaited<ReturnType<CredentialReviewService["review"]>>,
) {
  if (result.status === "AUTHORIZATION_DENIED")
    return reply.code(403).send({ code: "PRIVILEGED_ACCESS_DENIED" });
  if (result.status === "CLAIM_UNAVAILABLE")
    return reply.code(404).send({ code: "NOT_FOUND" });
  if (
    result.status === "STALE_REVISION" ||
    result.status === "INVALID_TRANSITION" ||
    result.status === "REQUIRED_EVIDENCE_MISSING"
  ) {
    return reply.code(409).send({ code: result.status });
  }
  if (!("claim" in result))
    return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
  return reply.code(result.status === "APPLIED" ? 201 : 200).send({
    claim: {
      claimId: result.claim.id,
      reviewReason: result.claim.reviewReason,
      reviewReasonCategory: result.claim.reviewReasonCategory,
      reviewedAt: result.claim.reviewedAt?.toISOString() ?? null,
      revision: result.claim.revision,
      state: result.claim.state,
    },
    status: result.status,
  });
}

function exactBody(keys: readonly string[]) {
  return (
    request: FastifyRequest,
    reply: FastifyReply,
    done: (error?: Error) => void,
  ): void => {
    const body = request.body;
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      Object.keys(body).length !== keys.length ||
      !keys.every((key) => Object.hasOwn(body, key))
    ) {
      void reply.code(400).send({ code: "INVALID_REQUEST" });
      return;
    }
    done();
  };
}

function readError(reply: FastifyReply, error: unknown) {
  if (error instanceof TypeError)
    return reply.code(400).send({ code: "INVALID_REQUEST" });
  return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
}

function commandError(reply: FastifyReply, error: unknown) {
  if (error instanceof TypeError)
    return reply.code(400).send({ code: "INVALID_REQUEST" });
  if (error instanceof CredentialClaimIdempotencyError)
    return reply.code(409).send({ code: "IDEMPOTENCY_CONFLICT" });
  return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
}

function noStore(
  _request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
  done: (error: Error | null, payload?: unknown) => void,
): void {
  void reply.header("cache-control", "private, no-store");
  void reply.header("x-robots-tag", "noindex, nofollow");
  done(null, payload);
}
