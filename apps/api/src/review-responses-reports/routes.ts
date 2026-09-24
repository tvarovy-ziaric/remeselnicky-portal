import {
  ModerationReportIdempotencyError,
  ReviewResponseIdempotencyError,
  type CreateModerationReportResult,
  type ReviewResponseReportRepository,
  type SubmitJobMainReviewResponseResult,
} from "@portal/db";
import { isPublicDisplayTextSafe, type UserId } from "@portal/domain";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
} from "fastify";

export const REVIEW_RESPONSE_REPORT_PATHS = Object.freeze({
  response: "/v1/me/reviews/:reviewId/response",
  reports: "/v1/me/moderation/reports",
} as const);

interface RouteRateLimit {
  readonly max: number;
  readonly timeWindowMs: number;
}

export interface ReviewResponseReportRouteDependencies {
  readonly persistence: Pick<
    ReviewResponseReportRepository,
    "createReport" | "getResponseForOwner" | "submitResponse"
  >;
  readonly guard: {
    evaluate(
      request: FastifyRequest,
    ): Promise<
      | { readonly status: "ACTIVE"; readonly user: { readonly id: UserId } }
      | { readonly status: "ACCOUNT_NOT_ACTIVE" | "AUTHENTICATION_REQUIRED" }
    >;
  };
  readonly csrfProtection: onRequestHookHandler;
  readonly rateLimit: {
    readonly read: RouteRateLimit;
    readonly write: RouteRateLimit;
  };
}

interface ResponseBody {
  readonly body: string;
  readonly commandId: string;
  readonly expectedVersion: number;
}

interface ReportBody {
  readonly commandId: string;
  readonly targetType:
    "MAIN_REVIEW" | "REVIEW_RESPONSE" | "SUPERVISOR_EVALUATION";
  readonly targetId: string;
  readonly reason:
    | "PERSONAL_DATA_PRIVACY"
    | "HARASSMENT_ABUSE"
    | "EXTORTION_RETALIATION"
    | "IRRELEVANT_CONTENT"
    | "SUSPECTED_FRAUD_FAKE_REVIEW"
    | "OTHER";
  readonly details?: string | null;
}

export function registerReviewResponseReportRoutes(
  app: FastifyInstance,
  dependencies: ReviewResponseReportRouteDependencies,
): void {
  app.get<{ Params: { reviewId: string } }>(
    REVIEW_RESPONSE_REPORT_PATHS.response,
    {
      config: {
        rateLimit: {
          max: dependencies.rateLimit.read.max,
          timeWindow: dependencies.rateLimit.read.timeWindowMs,
        },
      },
      onRequest: rejectQuery,
      onSend: privateHeaders,
      schema: { params: reviewParams },
    },
    async (request, reply) => {
      const actorUserId = await activeActor(request, reply, dependencies);
      if (actorUserId === null) return;
      try {
        const response = await dependencies.persistence.getResponseForOwner({
          actorUserId,
          reviewId: request.params.reviewId,
        });
        return response === null
          ? reply.code(404).send({ code: "NOT_FOUND" })
          : reply.send({
              responseId: response.responseId,
              reviewId: response.reviewId,
              revisionId: response.revisionId,
              version: response.version,
              body: response.body,
              respondedAt: response.respondedAt.toISOString(),
              revisedAt: response.revisedAt.toISOString(),
              editDeadline: response.editDeadline.toISOString(),
            });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{ Params: { reviewId: string }; Body: ResponseBody }>(
    REVIEW_RESPONSE_REPORT_PATHS.response,
    {
      config: {
        rateLimit: {
          max: dependencies.rateLimit.write.max,
          timeWindow: dependencies.rateLimit.write.timeWindowMs,
        },
      },
      onRequest: [rejectQuery, dependencies.csrfProtection],
      onSend: privateHeaders,
      preValidation: exactResponseBody,
      schema: { params: reviewParams, body: responseBody },
    },
    async (request, reply) => {
      const actorUserId = await activeActor(request, reply, dependencies);
      if (actorUserId === null) return;
      try {
        return sendResponseResult(
          reply,
          await dependencies.persistence.submitResponse({
            actorUserId,
            reviewId: request.params.reviewId,
            ...request.body,
          }),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{ Body: ReportBody }>(
    REVIEW_RESPONSE_REPORT_PATHS.reports,
    {
      config: {
        rateLimit: {
          max: dependencies.rateLimit.write.max,
          timeWindow: dependencies.rateLimit.write.timeWindowMs,
        },
      },
      onRequest: [rejectQuery, dependencies.csrfProtection],
      onSend: privateHeaders,
      preValidation: exactReportBody,
      schema: { body: reportBody },
    },
    async (request, reply) => {
      const actorUserId = await activeActor(request, reply, dependencies);
      if (actorUserId === null) return;
      try {
        return sendReportResult(
          reply,
          await dependencies.persistence.createReport({
            actorUserId,
            ...request.body,
          }),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
}

function sendResponseResult(
  reply: FastifyReply,
  result: SubmitJobMainReviewResponseResult,
) {
  if (result.status === "APPLIED" || result.status === "DEDUPLICATED") {
    return reply.code(result.status === "APPLIED" ? 201 : 200).send({
      status: result.status,
      responseId: result.responseId,
      revisionId: result.revisionId,
      version: result.version,
      recordedAt: result.recordedAt.toISOString(),
    });
  }
  return reply
    .code(result.status === "NOT_FOUND" ? 404 : 409)
    .send({ code: result.status });
}

function sendReportResult(
  reply: FastifyReply,
  result: CreateModerationReportResult,
) {
  if (result.status === "APPLIED" || result.status === "DEDUPLICATED") {
    return reply.code(result.status === "APPLIED" ? 201 : 200).send({
      status: result.status,
      reportId: result.reportId,
      state: result.state,
      recordedAt: result.recordedAt.toISOString(),
    });
  }
  return reply
    .code(result.status === "NOT_FOUND" ? 404 : 409)
    .send({ code: result.status });
}

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof TypeError)
    return reply.code(400).send({ code: "INVALID_REQUEST" });
  if (
    error instanceof ReviewResponseIdempotencyError ||
    error instanceof ModerationReportIdempotencyError
  ) {
    return reply.code(409).send({ code: "IDEMPOTENCY_CONFLICT" });
  }
  return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
}

async function activeActor(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: ReviewResponseReportRouteDependencies,
): Promise<string | null> {
  const actor = await dependencies.guard.evaluate(request);
  if (actor.status === "ACTIVE") return actor.user.id;
  void reply
    .code(actor.status === "AUTHENTICATION_REQUIRED" ? 401 : 403)
    .send({ code: actor.status });
  return null;
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

function exactResponseBody(
  request: FastifyRequest,
  reply: FastifyReply,
  done: () => void,
): void {
  const body = request.body;
  if (
    !record(body) ||
    !exact(body, ["body", "commandId", "expectedVersion"]) ||
    typeof body["body"] !== "string" ||
    body["body"].length > 2_000 ||
    !isPublicDisplayTextSafe(body["body"])
  ) {
    void reply.code(400).send({ code: "INVALID_REQUEST" });
    return;
  }
  done();
}

function exactReportBody(
  request: FastifyRequest,
  reply: FastifyReply,
  done: () => void,
): void {
  const body = request.body;
  if (
    !record(body) ||
    !["commandId", "reason", "targetId", "targetType"].every((key) =>
      Object.hasOwn(body, key),
    ) ||
    Object.keys(body).some(
      (key) =>
        !["commandId", "details", "reason", "targetId", "targetType"].includes(
          key,
        ),
    ) ||
    !validDetails(body["details"], Object.hasOwn(body, "details"))
  ) {
    void reply.code(400).send({ code: "INVALID_REQUEST" });
    return;
  }
  done();
}

function validDetails(value: unknown, supplied: boolean): boolean {
  if (!supplied || value === null) return true;
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 1_000 &&
    value === value.trim() &&
    !/[\p{Cc}]/u.test(value)
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]) {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
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

const uuid = {
  type: "string",
  pattern:
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
} as const;
const reviewParams = {
  type: "object",
  additionalProperties: false,
  required: ["reviewId"],
  properties: { reviewId: uuid },
} as const;
const responseBody = {
  type: "object",
  additionalProperties: false,
  required: ["body", "commandId", "expectedVersion"],
  properties: {
    body: { type: "string", minLength: 1, maxLength: 2_000 },
    commandId: uuid,
    expectedVersion: { type: "integer", minimum: 0 },
  },
} as const;
const reportBody = {
  type: "object",
  additionalProperties: false,
  required: ["commandId", "reason", "targetId", "targetType"],
  properties: {
    commandId: uuid,
    targetId: uuid,
    targetType: {
      enum: ["MAIN_REVIEW", "REVIEW_RESPONSE", "SUPERVISOR_EVALUATION"],
    },
    reason: {
      enum: [
        "PERSONAL_DATA_PRIVACY",
        "HARASSMENT_ABUSE",
        "EXTORTION_RETALIATION",
        "IRRELEVANT_CONTENT",
        "SUSPECTED_FRAUD_FAKE_REVIEW",
        "OTHER",
      ],
    },
    details: {
      anyOf: [
        { type: "string", minLength: 1, maxLength: 1_000 },
        { type: "null" },
      ],
    },
  },
} as const;
