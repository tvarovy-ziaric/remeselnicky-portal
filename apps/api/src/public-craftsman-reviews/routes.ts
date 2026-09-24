import {
  PublicCraftsmanReviewQueryValidationError,
  type PublicCraftsmanReviewPage,
} from "@portal/db";
import type { FastifyInstance, FastifyReply } from "fastify";

import type { PublicSearchAdmission } from "../public-search-cards/routes.js";

export const PUBLIC_CRAFTSMAN_REVIEWS_PATH =
  "/v1/public/craftsmen/:profileId/reviews" as const;

interface PublicCraftsmanReviews {
  list(input: {
    readonly craftsmanProfileId: string;
    readonly cursor?: string;
    readonly limit: number;
  }): Promise<PublicCraftsmanReviewPage | null>;
}

export interface PublicCraftsmanReviewRouteDependencies {
  readonly admission: PublicSearchAdmission;
  readonly reviews: PublicCraftsmanReviews;
}

type QueryString = Record<string, string | readonly string[] | undefined>;

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const limit = /^(?:[1-9]|1\d|20)$/u;

export function registerPublicCraftsmanReviewRoutes(
  app: FastifyInstance,
  dependencies: PublicCraftsmanReviewRouteDependencies,
): void {
  app.get<{
    Params: { profileId: string };
    Querystring: QueryString;
  }>(PUBLIC_CRAFTSMAN_REVIEWS_PATH, async (request, reply) => {
    publicHeaders(reply);

    const query = parseQuery(request.query);
    if (!uuid.test(request.params.profileId) || query === null) {
      return reply.code(400).send({ code: "INVALID_REQUEST" });
    }

    try {
      if (dependencies.admission === undefined) {
        return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
      }
      const admission = await dependencies.admission.admit({ ip: request.ip });
      if (admission === "RATE_LIMITED") {
        return reply.code(429).send({ code: "RATE_LIMITED" });
      }

      const page = await dependencies.reviews.list({
        craftsmanProfileId: request.params.profileId,
        limit: query.limit,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      });
      if (page === null) {
        return reply.code(404).send({ code: "NOT_FOUND" });
      }
      return reply.send(serializePage(page));
    } catch (error) {
      if (error instanceof PublicCraftsmanReviewQueryValidationError) {
        return reply.code(400).send({ code: "INVALID_REQUEST" });
      }
      return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
    }
  });
}

function parseQuery(
  query: QueryString,
): Readonly<{ cursor?: string; limit: number }> | null {
  const keys = Object.keys(query);
  if (
    keys.length > 2 ||
    keys.some((key) => key !== "cursor" && key !== "limit") ||
    (query.limit !== undefined && typeof query.limit !== "string") ||
    (query.cursor !== undefined && typeof query.cursor !== "string")
  ) {
    return null;
  }
  if (typeof query.limit === "string" && !limit.test(query.limit)) return null;
  if (
    typeof query.cursor === "string" &&
    (query.cursor.length < 1 ||
      query.cursor.length > 128 ||
      query.cursor !== query.cursor.trim() ||
      /[\p{Cc}\p{Z}]/u.test(query.cursor))
  ) {
    return null;
  }
  return {
    limit: query.limit === undefined ? 10 : Number(query.limit),
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
  };
}

function serializePage(page: PublicCraftsmanReviewPage) {
  return {
    reviews: page.items.map((review) => ({
      reviewId: review.reviewId,
      professionCode: review.professionCode,
      ratings: {
        work_quality: review.ratings.work_quality,
        price_adherence: review.ratings.price_adherence,
        schedule_adherence: review.ratings.schedule_adherence,
        communication: review.ratings.communication,
        cleanliness: review.ratings.cleanliness,
        problem_solving: review.ratings.problem_solving,
        would_hire_again: review.ratings.would_hire_again,
      },
      score: review.score,
      comment: review.comment,
      reviewedMonth: review.reviewedMonth,
    })),
    nextCursor: page.nextCursor,
  };
}

function publicHeaders(reply: FastifyReply): void {
  void reply.header("cache-control", "no-store");
  void reply.header("x-robots-tag", "noindex, nofollow");
}
