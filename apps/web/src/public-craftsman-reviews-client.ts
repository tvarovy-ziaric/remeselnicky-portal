import { isPublicDisplayTextSafe } from "@portal/domain";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const professionCode = /^(?:PROF|TEST):[A-Z0-9][A-Z0-9_]{1,62}$/u;
const reviewedMonth = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const cursor =
  /^v1\.[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type Dict = Record<string, unknown>;
export type PublicCraftsmanReviewRating = 1 | 2 | 3 | 4 | 5 | null;

export const publicCraftsmanReviewDimensions = Object.freeze([
  ["work_quality", "Kvalita práce"],
  ["price_adherence", "Dodržanie dohodnutej ceny"],
  ["schedule_adherence", "Dodržanie termínu"],
  ["communication", "Komunikácia"],
  ["cleanliness", "Čistota a poriadok"],
  ["problem_solving", "Riešenie problémov"],
  ["would_hire_again", "Znovu by si zákazník vybral tohto poskytovateľa"],
] as const);

export type PublicCraftsmanReviewRatings = Readonly<
  Record<
    (typeof publicCraftsmanReviewDimensions)[number][0],
    PublicCraftsmanReviewRating
  >
>;

export interface PublicCraftsmanReview {
  readonly reviewId: string;
  readonly professionCode: string;
  readonly ratings: PublicCraftsmanReviewRatings;
  readonly score: number;
  readonly comment: string | null;
  readonly reviewedMonth: string;
}

export interface PublicCraftsmanReviewsPage {
  readonly reviews: readonly PublicCraftsmanReview[];
  readonly nextCursor: string | null;
}

interface PublicCraftsmanReviewsLoaderDependencies {
  readonly apiOrigin: string;
  readonly fetch: typeof fetch;
}

const record = (value: unknown): value is Dict =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const exact = (value: Dict, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

export function isPublicCraftsmanReviewsCursor(
  value: unknown,
): value is string {
  return typeof value === "string" && cursor.test(value);
}

export function parsePublicCraftsmanReviewsPage(
  value: unknown,
): PublicCraftsmanReviewsPage | null {
  if (
    !record(value) ||
    !exact(value, ["reviews", "nextCursor"]) ||
    !Array.isArray(value.reviews) ||
    value.reviews.length > 10 ||
    (value.nextCursor !== null &&
      !isPublicCraftsmanReviewsCursor(value.nextCursor))
  ) {
    return null;
  }

  const parsed: PublicCraftsmanReview[] = [];
  const reviewIds = new Set<string>();
  for (const candidate of value.reviews as unknown[]) {
    const review = parseReview(candidate);
    if (review === null || reviewIds.has(review.reviewId)) return null;
    reviewIds.add(review.reviewId);
    parsed.push(review);
  }
  if (parsed.length === 0 && value.nextCursor !== null) return null;
  return { reviews: parsed, nextCursor: value.nextCursor };
}

export function createPublicCraftsmanReviewsLoader(
  dependencies: PublicCraftsmanReviewsLoaderDependencies,
) {
  const origin = internalApiOrigin(dependencies.apiOrigin);
  return async (
    profileId: string,
    pageCursor?: string,
  ): Promise<PublicCraftsmanReviewsPage | null> => {
    if (
      origin === null ||
      !uuid.test(profileId) ||
      (pageCursor !== undefined && !isPublicCraftsmanReviewsCursor(pageCursor))
    ) {
      return null;
    }
    try {
      const endpoint = new URL(
        `/v1/public/craftsmen/${encodeURIComponent(profileId)}/reviews`,
        origin,
      );
      endpoint.searchParams.set("limit", "10");
      if (pageCursor !== undefined)
        endpoint.searchParams.set("cursor", pageCursor);
      const response = await dependencies.fetch(endpoint, {
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      if (!response.ok) return null;
      return parsePublicCraftsmanReviewsPage(await response.json());
    } catch {
      return null;
    }
  };
}

export const loadPublicCraftsmanReviews = createPublicCraftsmanReviewsLoader({
  apiOrigin: process.env.PORTAL_API_ORIGIN ?? "http://127.0.0.1:3001",
  fetch,
});

function parseReview(value: unknown): PublicCraftsmanReview | null {
  if (
    !record(value) ||
    !exact(value, [
      "reviewId",
      "professionCode",
      "ratings",
      "score",
      "comment",
      "reviewedMonth",
    ]) ||
    typeof value.reviewId !== "string" ||
    !uuid.test(value.reviewId) ||
    typeof value.professionCode !== "string" ||
    !professionCode.test(value.professionCode) ||
    typeof value.score !== "number" ||
    !Number.isFinite(value.score) ||
    value.score < 1 ||
    value.score > 5 ||
    (value.comment !== null &&
      (typeof value.comment !== "string" ||
        value.comment.length > 2_000 ||
        !isPublicReviewCommentSafe(value.comment))) ||
    typeof value.reviewedMonth !== "string" ||
    !reviewedMonth.test(value.reviewedMonth)
  ) {
    return null;
  }
  const ratings = parseRatings(value.ratings);
  if (ratings === null) return null;
  const answered = Object.values(ratings).filter(
    (rating): rating is Exclude<PublicCraftsmanReviewRating, null> =>
      rating !== null,
  );
  const derivedScore =
    Math.round(
      (answered.reduce((total, rating) => total + rating, 0) /
        answered.length) *
        100,
    ) / 100;
  if (value.score !== derivedScore) return null;
  return {
    reviewId: value.reviewId,
    professionCode: value.professionCode,
    ratings,
    score: value.score,
    comment: value.comment,
    reviewedMonth: value.reviewedMonth,
  };
}

function parseRatings(value: unknown): PublicCraftsmanReviewRatings | null {
  if (!record(value)) return null;
  const fields = publicCraftsmanReviewDimensions.map(([field]) => field);
  if (
    !exact(value, fields) ||
    !Object.values(value).some((rating) => rating !== null) ||
    Object.values(value).some(
      (rating) =>
        rating !== null &&
        (!Number.isSafeInteger(rating) ||
          Number(rating) < 1 ||
          Number(rating) > 5),
    )
  ) {
    return null;
  }
  return Object.fromEntries(
    fields.map((field) => [field, value[field]]),
  ) as PublicCraftsmanReviewRatings;
}

function isPublicReviewCommentSafe(value: string): boolean {
  return (
    isPublicDisplayTextSafe(value) &&
    !/\b(?:adres(?:a|e|u|y|ou|ách)|ulic(?:a|i|u|e|ou)|námest(?:ie|í|iu)|tried(?:a|e|u|y|ou))\b[^\n]{0,80}\d/iu.test(
      value,
    )
  );
}

function internalApiOrigin(value: string): URL | null {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}
