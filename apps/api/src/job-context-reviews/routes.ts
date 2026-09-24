import {
  JobContextReviewIdempotencyError,
  participantReviewDimensions,
  type JobContextReviewPage,
  type JobContextReviewRatings,
  type JobContextReviewRepository,
  type JobContextReviewTargetKind,
  type SubmitJobContextReviewResult,
  workGroupReviewDimensions,
} from "@portal/db";
import type { UserId } from "@portal/domain";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
} from "fastify";

export const JOB_CONTEXT_REVIEW_PATHS = Object.freeze({
  list: "/v1/me/jobs/:jobId/reviews/secondary",
  participant: "/v1/me/jobs/:jobId/reviews/participants/:participantId",
  workGroup: "/v1/me/jobs/:jobId/reviews/work-groups/:workGroupId",
} as const);

export interface JobContextReviewRouteDependencies {
  readonly reviews: Pick<
    JobContextReviewRepository,
    "getForCustomer" | "submit"
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
  readonly rateLimit: { readonly max: number; readonly timeWindowMs: number };
}

interface SubmitBody {
  readonly commandId: string;
  readonly expectedVersion: number;
  readonly ratings: JobContextReviewRatings;
  readonly comment?: string | null;
}

export function registerJobContextReviewRoutes(
  app: FastifyInstance,
  dependencies: JobContextReviewRouteDependencies,
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

  app.get<{ Params: { jobId: string } }>(
    JOB_CONTEXT_REVIEW_PATHS.list,
    {
      ...common,
      onRequest: rejectQuery,
      schema: { params: jobParams },
    },
    async (request, reply) => {
      const actorUserId = await activeActor(request, reply, dependencies);
      if (actorUserId === null) return;
      try {
        const page = await dependencies.reviews.getForCustomer({
          actorUserId,
          jobId: request.params.jobId,
        });
        return page === null
          ? reply.code(404).send({ code: "NOT_FOUND" })
          : reply.send(serializePage(page));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  registerSubmitRoute(
    app,
    dependencies,
    "PARTICIPANT",
    JOB_CONTEXT_REVIEW_PATHS.participant,
    "participantId",
  );
  registerSubmitRoute(
    app,
    dependencies,
    "WORK_GROUP",
    JOB_CONTEXT_REVIEW_PATHS.workGroup,
    "workGroupId",
  );
}

function registerSubmitRoute(
  app: FastifyInstance,
  dependencies: JobContextReviewRouteDependencies,
  targetKind: JobContextReviewTargetKind,
  path: string,
  targetParam: "participantId" | "workGroupId",
): void {
  const dimensions =
    targetKind === "PARTICIPANT"
      ? participantReviewDimensions
      : workGroupReviewDimensions;
  app.post<{
    Params: { jobId: string; participantId?: string; workGroupId?: string };
    Body: SubmitBody;
  }>(
    path,
    {
      config: {
        rateLimit: {
          max: dependencies.rateLimit.max,
          timeWindow: dependencies.rateLimit.timeWindowMs,
        },
      },
      onRequest: [rejectQuery, dependencies.csrfProtection],
      onSend: privateHeaders,
      preValidation: exactSubmitBody(dimensions),
      schema: {
        params: targetParams(targetParam),
        body: submitBody(dimensions),
      },
    },
    async (request, reply) => {
      const actorUserId = await activeActor(request, reply, dependencies);
      if (actorUserId === null) return;
      const targetId = request.params[targetParam];
      if (targetId === undefined)
        return reply.code(400).send({ code: "INVALID_REQUEST" });
      try {
        return sendSubmitResult(
          reply,
          await dependencies.reviews.submit({
            actorUserId,
            jobId: request.params.jobId,
            targetKind,
            targetId,
            ...request.body,
          }),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
}

function sendSubmitResult(
  reply: FastifyReply,
  result: SubmitJobContextReviewResult,
) {
  if (result.status === "APPLIED" || result.status === "DEDUPLICATED") {
    return reply.code(result.status === "APPLIED" ? 201 : 200).send({
      status: result.status,
      targetKind: result.targetKind,
      targetId: result.targetId,
      revisionId: result.revisionId,
      version: result.version,
      recordedAt: result.recordedAt.toISOString(),
    });
  }
  return reply
    .code(result.status === "NOT_FOUND" ? 404 : 409)
    .send({ code: result.status });
}

function serializePage(page: JobContextReviewPage) {
  return {
    jobId: page.jobId,
    completedAt: page.completedAt.toISOString(),
    submissionDeadline: page.submissionDeadline.toISOString(),
    participants: page.participants.map((target) => ({
      targetKind: target.targetKind,
      participantId: target.participantId,
      participantProfileId: target.participantProfileId,
      displayName: target.displayName,
      participationStartedAt: target.participationStartedAt.toISOString(),
      participationEndedAt: target.participationEndedAt.toISOString(),
      verifiedProfessionCodes: target.verifiedProfessionCodes,
      verifiedRoles: target.verifiedRoles,
      review: serializeReview(target.review),
    })),
    workGroups: page.workGroups.map((target) => ({
      targetKind: target.targetKind,
      workGroupId: target.workGroupId,
      name: target.name,
      members: target.members.map((member) => ({
        assignmentId: member.assignmentId,
        participantId: member.participantId,
        participantProfileId: member.participantProfileId,
        displayName: member.displayName,
        overlapStartedAt: member.overlapStartedAt.toISOString(),
        overlapEndedAt: member.overlapEndedAt.toISOString(),
      })),
      review: serializeReview(target.review),
    })),
  };
}

function serializeReview(
  review: JobContextReviewPage["participants"][number]["review"],
) {
  return review === null
    ? null
    : {
        revisionId: review.revisionId,
        version: review.version,
        submittedAt: review.submittedAt.toISOString(),
        revisedAt: review.revisedAt.toISOString(),
        editDeadline: review.editDeadline.toISOString(),
        ratings: review.ratings,
        comment: review.comment,
      };
}

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof TypeError)
    return reply.code(400).send({ code: "INVALID_REQUEST" });
  if (error instanceof JobContextReviewIdempotencyError)
    return reply.code(409).send({ code: "IDEMPOTENCY_CONFLICT" });
  return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
}

async function activeActor(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: JobContextReviewRouteDependencies,
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

function exactSubmitBody(dimensions: readonly string[]) {
  return (
    request: FastifyRequest,
    reply: FastifyReply,
    done: () => void,
  ): void => {
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
      !validRatings(body["ratings"], dimensions) ||
      !validComment(body["comment"], Object.hasOwn(body, "comment"))
    ) {
      void reply.code(400).send({ code: "INVALID_REQUEST" });
      return;
    }
    done();
  };
}

function validRatings(value: unknown, dimensions: readonly string[]): boolean {
  if (!record(value)) return false;
  const keys = Object.keys(value);
  if (
    keys.length !== dimensions.length ||
    keys.some((key) => !dimensions.includes(key)) ||
    dimensions.some((key) => !Object.hasOwn(value, key))
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
const ratingObject = (keys: readonly string[]) => ({
  type: "object",
  additionalProperties: false,
  required: keys,
  properties: Object.fromEntries(keys.map((key) => [key, rating])),
});
const jobParams = {
  type: "object",
  additionalProperties: false,
  required: ["jobId"],
  properties: { jobId: uuid },
} as const;
const targetParams = (targetParam: "participantId" | "workGroupId") => ({
  type: "object",
  additionalProperties: false,
  required: ["jobId", targetParam],
  properties: { jobId: uuid, [targetParam]: uuid },
});
const submitBody = (dimensions: readonly string[]) => ({
  type: "object",
  additionalProperties: false,
  required: ["commandId", "expectedVersion", "ratings"],
  properties: {
    commandId: uuid,
    expectedVersion: { type: "integer", minimum: 0 },
    ratings: ratingObject(dimensions),
    comment: {
      anyOf: [
        { type: "string", minLength: 1, maxLength: 2_000 },
        { type: "null" },
      ],
    },
  },
});
