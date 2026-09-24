import {
  JobSupervisorEvaluationIdempotencyError,
  jobSupervisorEvaluationDimensions,
  type JobSupervisorEvaluationContent,
  type JobSupervisorEvaluationPage,
  type JobSupervisorEvaluationRatings,
  type JobSupervisorEvaluationRepository,
  type ReceivedJobSupervisorEvaluation,
  type ReceivedJobSupervisorEvaluationPage,
  type SubmitJobSupervisorEvaluationResult,
} from "@portal/db";
import type { UserId } from "@portal/domain";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
} from "fastify";
import type { SessionAuthorizationScope } from "../auth/guard.js";

export const JOB_SUPERVISOR_EVALUATION_PATHS = Object.freeze({
  evaluator: "/v1/me/jobs/:jobId/supervisor-evaluations",
  received: "/v1/me/jobs/:jobId/supervisor-evaluations/received",
  detail: "/v1/me/jobs/:jobId/supervisor-evaluations/:evaluationId",
  participant:
    "/v1/me/jobs/:jobId/supervisor-evaluations/participants/:participantId",
} as const);

interface RouteRateLimit {
  readonly max: number;
  readonly timeWindowMs: number;
}

export interface JobSupervisorEvaluationRouteDependencies {
  readonly evaluations: Pick<
    JobSupervisorEvaluationRepository,
    "getForEvaluator" | "getReceivedForTarget" | "getById" | "submit"
  >;
  readonly guard: {
    evaluate(
      request: FastifyRequest,
      scope?: SessionAuthorizationScope,
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

interface SubmitBody {
  readonly commandId: string;
  readonly expectedVersion: number;
  readonly ratings: JobSupervisorEvaluationRatings;
  readonly comment?: string | null;
}

export function registerJobSupervisorEvaluationRoutes(
  app: FastifyInstance,
  dependencies: JobSupervisorEvaluationRouteDependencies,
): void {
  const readRoute = {
    config: {
      rateLimit: {
        max: dependencies.rateLimit.read.max,
        timeWindow: dependencies.rateLimit.read.timeWindowMs,
      },
    },
    onRequest: rejectQuery,
    onSend: privateHeaders,
  };

  app.get<{ Params: { jobId: string } }>(
    JOB_SUPERVISOR_EVALUATION_PATHS.evaluator,
    { ...readRoute, schema: { params: jobParams } },
    async (request, reply) => {
      const actorUserId = await activeActor(request, reply, dependencies);
      if (actorUserId === null) return;
      try {
        const page = await dependencies.evaluations.getForEvaluator({
          actorUserId,
          jobId: request.params.jobId,
        });
        return page === null
          ? reply.code(404).send({ code: "NOT_FOUND" })
          : reply.send(serializeEvaluatorPage(page));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get<{ Params: { jobId: string } }>(
    JOB_SUPERVISOR_EVALUATION_PATHS.received,
    { ...readRoute, schema: { params: jobParams } },
    async (request, reply) => {
      const actorUserId = await activeActor(request, reply, dependencies);
      if (actorUserId === null) return;
      try {
        const page = await dependencies.evaluations.getReceivedForTarget({
          actorUserId,
          jobId: request.params.jobId,
        });
        return page === null
          ? reply.code(404).send({ code: "NOT_FOUND" })
          : reply.send(serializeReceivedPage(page));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get<{ Params: { jobId: string; evaluationId: string } }>(
    JOB_SUPERVISOR_EVALUATION_PATHS.detail,
    { ...readRoute, schema: { params: detailParams } },
    async (request, reply) => {
      const actorUserId = await activeActor(request, reply, dependencies);
      if (actorUserId === null) return;
      try {
        const detail = await dependencies.evaluations.getById({
          actorUserId,
          jobId: request.params.jobId,
          evaluationId: request.params.evaluationId,
        });
        return detail === null
          ? reply.code(404).send({ code: "NOT_FOUND" })
          : reply.send(serializeReceivedEvaluation(detail));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{
    Params: { jobId: string; participantId: string };
    Body: SubmitBody;
  }>(
    JOB_SUPERVISOR_EVALUATION_PATHS.participant,
    {
      config: {
        rateLimit: {
          max: dependencies.rateLimit.write.max,
          timeWindow: dependencies.rateLimit.write.timeWindowMs,
        },
      },
      onRequest: [rejectQuery, dependencies.csrfProtection],
      onSend: privateHeaders,
      preValidation: exactSubmitBody,
      schema: { params: participantParams, body: submitBody },
    },
    async (request, reply) => {
      const actorUserId = await activeActor(
        request,
        reply,
        dependencies,
        "REVIEWS",
      );
      if (actorUserId === null) return;
      try {
        return sendSubmitResult(
          reply,
          await dependencies.evaluations.submit({
            actorUserId,
            commandId: request.body.commandId,
            expectedVersion: request.body.expectedVersion,
            jobId: request.params.jobId,
            targetParticipantId: request.params.participantId,
            ratings: request.body.ratings,
            ...(Object.hasOwn(request.body, "comment")
              ? { comment: request.body.comment }
              : {}),
          }),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
}

function serializeEvaluatorPage(page: JobSupervisorEvaluationPage) {
  return {
    jobId: page.jobId,
    completedAt: page.completedAt.toISOString(),
    submissionDeadline: page.submissionDeadline.toISOString(),
    targets: page.targets.map((target) => ({
      participantId: target.targetParticipantId,
      participantProfileId: target.targetProfileId,
      displayName: target.displayName,
      relationshipKind: target.relationshipKind,
      overlapStartedAt: target.overlapStartedAt.toISOString(),
      overlapEndedAt: target.overlapEndedAt.toISOString(),
      verifiedProfessionCodes: target.verifiedProfessionCodes,
      verifiedRoles: target.verifiedRoles,
      evaluation: serializeContent(target.evaluation),
    })),
  };
}

function serializeReceivedPage(page: ReceivedJobSupervisorEvaluationPage) {
  return {
    jobId: page.jobId,
    evaluations: page.evaluations.map(serializeReceivedEvaluation),
  };
}

function serializeReceivedEvaluation(
  evaluation: ReceivedJobSupervisorEvaluation,
) {
  return {
    sourceType: "SUPERVISOR_EVALUATION" as const,
    evaluationId: evaluation.evaluationId,
    targetParticipantId: evaluation.targetParticipantId,
    targetProfileId: evaluation.targetProfileId,
    evaluatorDisplayName: evaluation.evaluatorDisplayName,
    relationshipKind: evaluation.relationshipKind,
    overlapStartedAt: evaluation.overlapStartedAt.toISOString(),
    overlapEndedAt: evaluation.overlapEndedAt.toISOString(),
    verifiedProfessionCodes: evaluation.verifiedProfessionCodes,
    verifiedTargetRoles: evaluation.verifiedRoles,
    submittedAt: evaluation.content.submittedAt.toISOString(),
    revisedAt: evaluation.content.revisedAt.toISOString(),
    ratings: evaluation.content.ratings,
    comment: evaluation.content.comment,
  };
}

function serializeContent(content: JobSupervisorEvaluationContent | null) {
  return content === null
    ? null
    : {
        evaluationId: content.evaluationId,
        revisionId: content.revisionId,
        version: content.version,
        submittedAt: content.submittedAt.toISOString(),
        revisedAt: content.revisedAt.toISOString(),
        editDeadline: content.editDeadline.toISOString(),
        ratings: content.ratings,
        comment: content.comment,
      };
}

function sendSubmitResult(
  reply: FastifyReply,
  result: SubmitJobSupervisorEvaluationResult,
) {
  if (result.status === "APPLIED" || result.status === "DEDUPLICATED") {
    return reply.code(result.status === "APPLIED" ? 201 : 200).send({
      status: result.status,
      evaluationId: result.evaluationId,
      revisionId: result.revisionId,
      version: result.version,
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
  if (error instanceof JobSupervisorEvaluationIdempotencyError)
    return reply.code(409).send({ code: "IDEMPOTENCY_CONFLICT" });
  return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
}

async function activeActor(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: JobSupervisorEvaluationRouteDependencies,
  scope?: SessionAuthorizationScope,
): Promise<string | null> {
  const actor = await dependencies.guard.evaluate(request, scope);
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

function exactSubmitBody(
  request: FastifyRequest,
  reply: FastifyReply,
  done: () => void,
): void {
  const body = request.body;
  if (
    !record(body) ||
    !["commandId", "expectedVersion", "ratings"].every((key) =>
      Object.hasOwn(body, key),
    ) ||
    Object.keys(body).some(
      (key) =>
        !["commandId", "expectedVersion", "ratings", "comment"].includes(key),
    ) ||
    !validRatings(body["ratings"]) ||
    !validComment(body["comment"], Object.hasOwn(body, "comment"))
  ) {
    void reply.code(400).send({ code: "INVALID_REQUEST" });
    return;
  }
  done();
}

function validRatings(value: unknown): value is JobSupervisorEvaluationRatings {
  if (!record(value)) return false;
  const keys = Object.keys(value);
  if (
    keys.length !== jobSupervisorEvaluationDimensions.length ||
    keys.some(
      (key) =>
        !jobSupervisorEvaluationDimensions.includes(
          key as (typeof jobSupervisorEvaluationDimensions)[number],
        ),
    ) ||
    jobSupervisorEvaluationDimensions.some((key) => !Object.hasOwn(value, key))
  )
    return false;
  const ratings = Object.values(value);
  return (
    ratings.some((rating) => rating !== null) &&
    ratings.every(
      (rating) =>
        rating === null ||
        (Number.isInteger(rating) &&
          Number(rating) >= 1 &&
          Number(rating) <= 5),
    )
  );
}

function validComment(value: unknown, supplied: boolean): boolean {
  if (!supplied || value === null) return true;
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 2_000 &&
    value === value.trim() &&
    !/[\p{Cc}]/u.test(value)
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
const rating = {
  anyOf: [{ type: "integer", minimum: 1, maximum: 5 }, { type: "null" }],
} as const;
const ratingObject = {
  type: "object",
  additionalProperties: false,
  required: jobSupervisorEvaluationDimensions,
  properties: Object.fromEntries(
    jobSupervisorEvaluationDimensions.map((key) => [key, rating]),
  ),
} as const;
const jobParams = {
  type: "object",
  additionalProperties: false,
  required: ["jobId"],
  properties: { jobId: uuid },
} as const;
const detailParams = {
  type: "object",
  additionalProperties: false,
  required: ["jobId", "evaluationId"],
  properties: { jobId: uuid, evaluationId: uuid },
} as const;
const participantParams = {
  type: "object",
  additionalProperties: false,
  required: ["jobId", "participantId"],
  properties: { jobId: uuid, participantId: uuid },
} as const;
const submitBody = {
  type: "object",
  additionalProperties: false,
  required: ["commandId", "expectedVersion", "ratings"],
  properties: {
    commandId: uuid,
    expectedVersion: { type: "integer", minimum: 0 },
    ratings: ratingObject,
    comment: {
      anyOf: [
        { type: "string", minLength: 1, maxLength: 2_000 },
        { type: "null" },
      ],
    },
  },
} as const;
