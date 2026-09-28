import { createHash } from "node:crypto";

import type { AdminAccessService } from "@portal/admin-auth";
import { CraftsmanPublicationIdempotencyError } from "@portal/db";
import type {
  CraftsmanPublicationPersistence,
  ProfilePublicationCommandResult,
} from "@portal/domain";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
} from "fastify";

import type { SessionGuardResult } from "../auth/guard.js";

export const ADMIN_PROFILE_REVIEW_PATHS = Object.freeze({
  approve: "/v1/admin/craftsman-profiles/:profileId/approve",
  detail: "/v1/admin/craftsman-profiles/:profileId/review",
  queue: "/v1/admin/craftsman-profiles/review-queue",
  reject: "/v1/admin/craftsman-profiles/:profileId/reject",
});

export interface AdminProfileReviewView {
  readonly about: string | null;
  readonly baseMunicipality: Readonly<{
    readonly code: string;
    readonly name: string;
  }> | null;
  readonly identity: Readonly<{
    readonly primaryName: string | null;
    readonly profileType: "INDIVIDUAL" | "COMPANY";
    readonly secondaryName: string | null;
  }>;
  readonly normalRadiusMeters: number | null;
  readonly professions: readonly Readonly<{
    readonly code: string;
    readonly declaredLevel: "BEGINNER" | "ADVANCED" | "MASTER";
    readonly label: string;
  }>[];
  readonly profileId: string;
  readonly publicationRevision: number;
  readonly readiness: Readonly<{
    readonly isReady: boolean;
    readonly missing: readonly string[];
  }>;
  readonly submittedAt: Date;
}

export interface AdminProfileReviewRouteDependencies {
  readonly adminAccess: Pick<AdminAccessService, "authorize">;
  readonly csrfProtection: onRequestHookHandler;
  readonly guard: {
    evaluate(request: FastifyRequest): Promise<SessionGuardResult>;
  };
  readonly publications: Pick<
    CraftsmanPublicationPersistence,
    "approve" | "reject"
  >;
  readonly rateLimit: { readonly max: number; readonly timeWindowMs: number };
  readonly reviews: {
    findPending(profileId: string): Promise<AdminProfileReviewView | null>;
    listPending(input: {
      readonly cursor?: string;
      readonly limit: number;
    }): Promise<{
      readonly items: readonly AdminProfileReviewView[];
      readonly nextCursor: string | null;
    }>;
  };
}

const uuid =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const decisionProperties = {
  commandId: { type: "string", pattern: uuid },
  correlationId: { type: "string", pattern: uuid },
  expectedRevision: { type: "integer", minimum: 1, maximum: 2_147_483_647 },
  reason: { type: "string", minLength: 8, maxLength: 500 },
} as const;

export function registerAdminProfileReviewRoutes(
  app: FastifyInstance,
  dependencies: AdminProfileReviewRouteDependencies,
): void {
  const routeConfig = Object.freeze({
    rateLimit: {
      max: Math.min(10, dependencies.rateLimit.max),
      timeWindow: dependencies.rateLimit.timeWindowMs,
    },
  });

  app.get<{ Querystring: { cursor?: string; limit?: number } }>(
    ADMIN_PROFILE_REVIEW_PATHS.queue,
    {
      config: routeConfig,
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
      if ((await authorize(request, reply, dependencies)) === undefined) return;
      try {
        const page = await dependencies.reviews.listPending({
          ...(request.query.cursor === undefined
            ? {}
            : { cursor: request.query.cursor }),
          limit: request.query.limit ?? 20,
        });
        return reply.code(200).send(serializePage(page));
      } catch (error) {
        return readError(reply, error);
      }
    },
  );

  app.get<{ Params: { profileId: string } }>(
    ADMIN_PROFILE_REVIEW_PATHS.detail,
    {
      config: routeConfig,
      onSend: noStore,
      schema: { params: profileParamsSchema },
    },
    async (request, reply) => {
      if ((await authorize(request, reply, dependencies)) === undefined) return;
      try {
        const detail = await dependencies.reviews.findPending(
          request.params.profileId,
        );
        if (detail === null) return reply.code(404).send({ code: "NOT_FOUND" });
        return reply.code(200).send(serializeReview(detail));
      } catch (error) {
        return readError(reply, error);
      }
    },
  );

  app.post<{
    Body: {
      commandId: string;
      correlationId: string;
      expectedRevision: number;
      reason: string;
    };
    Params: { profileId: string };
  }>(
    ADMIN_PROFILE_REVIEW_PATHS.approve,
    decisionOptions(
      dependencies,
      ["commandId", "correlationId", "expectedRevision", "reason"],
      decisionProperties,
    ),
    async (request, reply) => {
      const actorUserId = await authorize(request, reply, dependencies);
      if (actorUserId === undefined) return;
      try {
        const result = await dependencies.publications.approve({
          actorSessionIdDigest: sessionDigest(request.session.sessionId),
          actorUserId: actorUserId as never,
          commandId: request.body.commandId,
          correlationId: request.body.correlationId,
          craftsmanProfileId: request.params.profileId as never,
          expectedRevision: request.body.expectedRevision,
          reason: request.body.reason,
        });
        return decisionReply(reply, result);
      } catch (error) {
        return commandError(reply, error);
      }
    },
  );

  app.post<{
    Body: {
      commandId: string;
      correlationId: string;
      expectedRevision: number;
      reason: string;
      reasonCode: string;
      userFacingReason: string;
    };
    Params: { profileId: string };
  }>(
    ADMIN_PROFILE_REVIEW_PATHS.reject,
    decisionOptions(
      dependencies,
      [
        "commandId",
        "correlationId",
        "expectedRevision",
        "reason",
        "reasonCode",
        "userFacingReason",
      ],
      {
        ...decisionProperties,
        reasonCode: { type: "string", pattern: "^[A-Z][A-Z0-9_]{2,63}$" },
        userFacingReason: { type: "string", minLength: 8, maxLength: 500 },
      },
    ),
    async (request, reply) => {
      const actorUserId = await authorize(request, reply, dependencies);
      if (actorUserId === undefined) return;
      try {
        const result = await dependencies.publications.reject({
          actorSessionIdDigest: sessionDigest(request.session.sessionId),
          actorUserId: actorUserId as never,
          commandId: request.body.commandId,
          correlationId: request.body.correlationId,
          craftsmanProfileId: request.params.profileId as never,
          expectedRevision: request.body.expectedRevision,
          reason: request.body.reason,
          reasonCode: request.body.reasonCode,
          userFacingReason: request.body.userFacingReason,
        });
        return decisionReply(reply, result);
      } catch (error) {
        return commandError(reply, error);
      }
    },
  );
}

async function authorize(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: AdminProfileReviewRouteDependencies,
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
  const decision = await dependencies.adminAccess.authorize({
    capability: "admin.profiles.review",
    requireRecentMfa: true,
    sessionId: request.session.sessionId,
    userId: identity.user.id,
  });
  if (
    decision.status !== "AUTHORIZED" ||
    decision.actor.userId !== identity.user.id ||
    !decision.actor.capabilities.has("admin.profiles.review")
  ) {
    await reply.code(403).send({ code: "PRIVILEGED_ACCESS_DENIED" });
    return undefined;
  }
  return identity.user.id;
}

function decisionOptions(
  dependencies: AdminProfileReviewRouteDependencies,
  keys: readonly string[],
  properties: Readonly<Record<string, unknown>>,
) {
  return {
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
        properties,
        required: keys,
      },
      params: profileParamsSchema,
    },
  } as const;
}

const profileParamsSchema = {
  type: "object",
  additionalProperties: false,
  properties: { profileId: { type: "string", pattern: uuid } },
  required: ["profileId"],
} as const;

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

function serializePage(page: {
  readonly items: readonly AdminProfileReviewView[];
  readonly nextCursor: string | null;
}) {
  return {
    items: page.items.map(serializeReview),
    nextCursor: page.nextCursor,
  };
}

function serializeReview(item: AdminProfileReviewView) {
  return {
    about: item.about,
    baseMunicipality: item.baseMunicipality,
    identity: item.identity,
    normalRadiusMeters: item.normalRadiusMeters,
    professions: item.professions,
    profileId: item.profileId,
    publicationRevision: item.publicationRevision,
    readiness: item.readiness,
    submittedAt: item.submittedAt.toISOString(),
  };
}

function decisionReply(
  reply: FastifyReply,
  result: ProfilePublicationCommandResult,
) {
  if (result.status === "PROFILE_UNAVAILABLE")
    return reply.code(404).send({ code: "NOT_FOUND" });
  if (result.status === "ADMIN_AUTHORIZATION_REQUIRED")
    return reply.code(403).send({ code: "PRIVILEGED_ACCESS_DENIED" });
  if (result.status === "STALE_REVISION")
    return reply.code(409).send({ code: "STALE_REVISION" });
  if (result.status === "INVALID_TRANSITION")
    return reply.code(409).send({ code: "INVALID_TRANSITION" });
  if (result.status === "NOT_READY")
    return reply.code(409).send({
      code: "PROFILE_NOT_READY",
      readiness: result.readiness,
    });
  if (!("publication" in result))
    return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
  return reply.code(result.status === "APPLIED" ? 201 : 200).send({
    publication: {
      profileId: result.publication.craftsmanProfileId,
      revision: result.publication.revision,
      reviewState: result.publication.reviewState,
    },
    status: result.status,
  });
}

function readError(reply: FastifyReply, error: unknown) {
  if (error instanceof TypeError)
    return reply.code(400).send({ code: "INVALID_REQUEST" });
  return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
}

function commandError(reply: FastifyReply, error: unknown) {
  if (error instanceof TypeError)
    return reply.code(400).send({ code: "INVALID_REQUEST" });
  if (error instanceof CraftsmanPublicationIdempotencyError)
    return reply.code(409).send({ code: "IDEMPOTENCY_CONFLICT" });
  return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
}

function sessionDigest(sessionId: string): string {
  return createHash("sha256").update(sessionId, "utf8").digest("hex");
}

function noStore(
  _request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
  done: (error: Error | null, payload?: unknown) => void,
): void {
  void reply.header("cache-control", "no-store");
  void reply.header("x-robots-tag", "noindex, nofollow");
  done(null, payload);
}
