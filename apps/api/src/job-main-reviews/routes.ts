import {
  JobMainReviewIdempotencyError,
  type JobMainReviewOpportunity,
  type JobMainReviewRepository,
  type SubmitJobMainReviewResult,
} from "@portal/db";
import type { UserId } from "@portal/domain";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
} from "fastify";
import type { SessionAuthorizationScope } from "../auth/guard.js";

export const JOB_MAIN_REVIEW_PATH = "/v1/me/jobs/:jobId/reviews/main";

type Rating = 1 | 2 | 3 | 4 | 5 | null;
type CustomerToProviderRatings = Readonly<{
  work_quality: Rating;
  price_adherence: Rating;
  schedule_adherence: Rating;
  communication: Rating;
  cleanliness: Rating;
  problem_solving: Rating;
  would_hire_again: Rating;
}>;
type ProviderToCustomerRatings = Readonly<{
  agreement_payment_experience: Rating;
  site_readiness: Rating;
  brief_clarity: Rating;
  communication: Rating;
  unplanned_changes: Rating;
  fairness: Rating;
}>;
type Ratings = CustomerToProviderRatings | ProviderToCustomerRatings;

export interface JobMainReviewRouteDependencies {
  readonly reviews: Pick<JobMainReviewRepository, "get" | "submit">;
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
  readonly rateLimit: { readonly max: number; readonly timeWindowMs: number };
}

interface SubmitBody {
  readonly commandId: string;
  readonly expectedVersion: number;
  readonly ratings: Ratings;
  readonly comment?: string | null;
}

const customerRatingKeys = Object.freeze([
  "work_quality",
  "price_adherence",
  "schedule_adherence",
  "communication",
  "cleanliness",
  "problem_solving",
  "would_hire_again",
] as const);
const providerRatingKeys = Object.freeze([
  "agreement_payment_experience",
  "site_readiness",
  "brief_clarity",
  "communication",
  "unplanned_changes",
  "fairness",
] as const);

export function registerJobMainReviewRoutes(
  app: FastifyInstance,
  dependencies: JobMainReviewRouteDependencies,
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
    JOB_MAIN_REVIEW_PATH,
    {
      ...common,
      onRequest: rejectQuery,
      schema: { params: jobParams },
    },
    async (request, reply) => {
      const actorUserId = await activeActor(request, reply, dependencies);
      if (actorUserId === null) return;
      try {
        const page = await dependencies.reviews.get({
          actorUserId,
          jobId: request.params.jobId,
        });
        return page === null
          ? reply.code(404).send({ code: "NOT_FOUND" })
          : reply.send(serializeOpportunity(page));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{ Params: { jobId: string }; Body: SubmitBody }>(
    JOB_MAIN_REVIEW_PATH,
    {
      ...common,
      onRequest: [rejectQuery, dependencies.csrfProtection],
      preValidation: exactSubmitBody,
      schema: { params: jobParams, body: submitBody },
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
          await dependencies.reviews.submit({
            actorUserId,
            jobId: request.params.jobId,
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
  result: SubmitJobMainReviewResult,
) {
  if (result.status === "APPLIED" || result.status === "DEDUPLICATED") {
    return reply.code(result.status === "APPLIED" ? 201 : 200).send({
      status: result.status,
      direction: result.direction,
      revisionId: result.revisionId,
      version: result.version,
      recordedAt: result.recordedAt.toISOString(),
    });
  }
  return reply
    .code(result.status === "NOT_FOUND" ? 404 : 409)
    .send({ code: result.status });
}

function serializeOpportunity(page: JobMainReviewOpportunity) {
  return {
    jobId: page.jobId,
    direction: page.direction,
    targetProfileId: page.targetProfileId,
    targetKind: page.targetKind,
    acceptedProfessionCode: page.acceptedProfessionCode,
    completedAt: page.completedAt.toISOString(),
    submissionDeadline: page.submissionDeadline.toISOString(),
    state: page.state,
    ownReview:
      page.ownReview === null
        ? null
        : {
            revisionId: page.ownReview.revisionId,
            version: page.ownReview.version,
            submittedAt: page.ownReview.submittedAt.toISOString(),
            revisedAt: page.ownReview.revisedAt.toISOString(),
            ratings: page.ownReview.ratings,
            comment: page.ownReview.comment,
          },
    counterpartyReview:
      page.counterpartyReview === null
        ? null
        : {
            direction: page.counterpartyReview.direction,
            revisionId: page.counterpartyReview.revisionId,
            submittedAt: page.counterpartyReview.submittedAt.toISOString(),
            revisedAt: page.counterpartyReview.revisedAt.toISOString(),
            unlockedAt: page.counterpartyReview.unlockedAt.toISOString(),
            ratings: page.counterpartyReview.ratings,
            comment: page.counterpartyReview.comment,
          },
  };
}

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof TypeError)
    return reply.code(400).send({ code: "INVALID_REQUEST" });
  if (error instanceof JobMainReviewIdempotencyError)
    return reply.code(409).send({ code: "IDEMPOTENCY_CONFLICT" });
  return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
}

async function activeActor(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: JobMainReviewRouteDependencies,
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

function validRatings(value: unknown): value is Ratings {
  if (!record(value)) return false;
  const keys = Object.keys(value);
  const exact = (expected: readonly string[]) =>
    keys.length === expected.length &&
    keys.every((key) => expected.includes(key));
  if (!exact(customerRatingKeys) && !exact(providerRatingKeys)) return false;
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
const submitBody = {
  type: "object",
  additionalProperties: false,
  required: ["commandId", "expectedVersion", "ratings"],
  properties: {
    commandId: uuid,
    expectedVersion: { type: "integer", minimum: 0 },
    ratings: {
      anyOf: [
        ratingObject(customerRatingKeys),
        ratingObject(providerRatingKeys),
      ],
    },
    comment: {
      anyOf: [
        { type: "string", minLength: 1, maxLength: 2_000 },
        { type: "null" },
      ],
    },
  },
} as const;
