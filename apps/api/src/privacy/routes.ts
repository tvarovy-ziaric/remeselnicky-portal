import type {
  PrivacyRepository,
  createPrivacyOperationsRepository,
  createPrivacySubjectExportRepository,
} from "@portal/db";
import type { UserId } from "@portal/domain";
import {
  PRIVACY_REQUEST_TYPE_VALUES,
  type PrivacyRequestType,
} from "@portal/privacy";
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

type Operations = ReturnType<typeof createPrivacyOperationsRepository>;
type SubjectExports = ReturnType<typeof createPrivacySubjectExportRepository>;

export const PRIVACY_REQUEST_PATHS = Object.freeze({
  accountClosureReadiness: "/v1/me/privacy/account-closure/readiness",
  export: "/v1/me/privacy/requests/:caseId/export",
  requests: "/v1/me/privacy/requests",
} as const);

export interface PrivacyRequestRouteDependencies {
  readonly csrfProtection: onRequestHookHandler;
  readonly guard: {
    evaluate(
      request: FastifyRequest,
      scope?: SessionAuthorizationScope,
    ): Promise<SessionGuardResult>;
  };
  readonly operations: Pick<
    Operations,
    "hasOpenObligations" | "listForSubject"
  >;
  readonly privacy: Pick<PrivacyRepository, "createPrivacyRequestCase">;
  readonly subjectExports: Pick<SubjectExports, "createForSubject">;
  readonly rateLimit: { readonly max: number; readonly timeWindowMs: number };
}

interface OpenRequestBody {
  readonly caseId: string;
  readonly correlationId: string;
  readonly eventId: string;
  readonly requestType: PrivacyRequestType;
}

export function registerPrivacyRequestRoutes(
  app: FastifyInstance,
  dependencies: PrivacyRequestRouteDependencies,
): void {
  app.get(
    PRIVACY_REQUEST_PATHS.requests,
    { onRequest: rejectQuery, onSend: privateHeaders },
    async (request, reply) => {
      const subjectUserId = await privacyActor(request, reply, dependencies);
      if (subjectUserId === undefined) return;
      try {
        const items = await dependencies.operations.listForSubject({
          subjectUserId,
        });
        return reply.send({
          items: items.map((item) => ({
            actionCode: item.actionCode,
            caseId: item.caseId,
            deadlineAt: item.deadlineAt?.toISOString() ?? null,
            occurredAt: item.occurredAt.toISOString(),
            receivedAt: item.receivedAt.toISOString(),
            requestType: item.requestType,
            revision: item.revision,
            state: item.state,
          })),
        });
      } catch {
        return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
      }
    },
  );

  app.get(
    PRIVACY_REQUEST_PATHS.accountClosureReadiness,
    { onRequest: rejectQuery, onSend: privateHeaders },
    async (request, reply) => {
      const subjectUserId = await privacyActor(request, reply, dependencies);
      if (subjectUserId === undefined) return;
      try {
        const openObligations =
          await dependencies.operations.hasOpenObligations(subjectUserId);
        return reply.send({
          canRequestClosure: true,
          executionBlockedByOpenObligations: openObligations,
        });
      } catch {
        return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
      }
    },
  );

  app.get<{ Params: { caseId: string } }>(
    PRIVACY_REQUEST_PATHS.export,
    {
      config: {
        rateLimit: {
          max: Math.min(10, dependencies.rateLimit.max),
          timeWindow: dependencies.rateLimit.timeWindowMs,
        },
      },
      onRequest: rejectQuery,
      onSend: privateHeaders,
    },
    async (request, reply) => {
      const subjectUserId = await privacyActor(request, reply, dependencies);
      if (subjectUserId === undefined) return;
      if (!validId(request.params.caseId))
        return reply.code(400).send({ code: "INVALID_REQUEST" });
      try {
        const result = await dependencies.subjectExports.createForSubject({
          caseId: request.params.caseId,
          subjectUserId,
        });
        if (result.status !== "READY") {
          if (result.status === "NOT_FOUND")
            return reply.code(404).send({ code: "NOT_FOUND" });
          return reply.code(409).send({
            code:
              result.status === "NOT_AVAILABLE"
                ? "EXPORT_NOT_AVAILABLE"
                : result.status,
          });
        }
        void reply.header(
          "content-disposition",
          `attachment; filename="privacy-${request.params.caseId}.json"`,
        );
        return reply.send(result.document);
      } catch (error) {
        return error instanceof TypeError
          ? reply.code(400).send({ code: "INVALID_REQUEST" })
          : reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
      }
    },
  );

  app.post<{ Body: OpenRequestBody }>(
    PRIVACY_REQUEST_PATHS.requests,
    {
      config: {
        rateLimit: {
          max: Math.min(10, dependencies.rateLimit.max),
          timeWindow: dependencies.rateLimit.timeWindowMs,
        },
      },
      onRequest: [rejectQuery, dependencies.csrfProtection],
      onSend: privateHeaders,
      schema: { body: openRequestSchema },
      preValidation: exactOpenRequest,
    },
    async (request, reply) => {
      const subjectUserId = await privacyActor(request, reply, dependencies);
      if (subjectUserId === undefined) return;
      try {
        const result = await dependencies.privacy.createPrivacyRequestCase({
          caseId: request.body.caseId,
          correlationId: request.body.correlationId,
          eventId: request.body.eventId,
          requestType: request.body.requestType,
          subjectUserId,
        });
        return reply.code(result.status === "CREATED" ? 201 : 200).send({
          caseId: result.caseId,
          receivedAt: result.receivedAt.toISOString(),
          requestType: result.requestType,
          revision: result.event.revision,
          state: result.event.state,
          status: result.status,
        });
      } catch (error) {
        return error instanceof TypeError
          ? reply.code(400).send({ code: "INVALID_REQUEST" })
          : reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
      }
    },
  );
}

async function privacyActor(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: PrivacyRequestRouteDependencies,
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

function exactOpenRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  done: () => void,
): void {
  const body = request.body;
  if (
    !record(body) ||
    Object.keys(body).length !== 4 ||
    !validId(body["caseId"]) ||
    !validId(body["correlationId"]) ||
    !validId(body["eventId"]) ||
    !PRIVACY_REQUEST_TYPE_VALUES.includes(
      body["requestType"] as PrivacyRequestType,
    )
  ) {
    void reply.code(400).send({ code: "INVALID_REQUEST" });
    return;
  }
  done();
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

const uuidSchema = {
  type: "string",
  pattern:
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
} as const;
const openRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["caseId", "correlationId", "eventId", "requestType"],
  properties: {
    caseId: uuidSchema,
    correlationId: uuidSchema,
    eventId: uuidSchema,
    requestType: { enum: PRIVACY_REQUEST_TYPE_VALUES },
  },
} as const;
