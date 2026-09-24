import {
  isPublicCraftsmanProfileId,
  isPublicDisplayTextSafe,
} from "@portal/domain";
import type { Sql, TransactionSql } from "postgres";

export const PUBLIC_CRAFTSMAN_REVIEW_DEFAULT_LIMIT = 10;
export const PUBLIC_CRAFTSMAN_REVIEW_MAX_LIMIT = 20;

const customerToProviderDimensions = Object.freeze([
  "work_quality",
  "price_adherence",
  "schedule_adherence",
  "communication",
  "cleanliness",
  "problem_solving",
  "would_hire_again",
] as const);

type PublicCraftsmanReviewDimension =
  (typeof customerToProviderDimensions)[number];

export type PublicCraftsmanReviewRatings = Readonly<
  Record<PublicCraftsmanReviewDimension, 1 | 2 | 3 | 4 | 5 | null>
>;

export interface PublicCraftsmanReviewItem {
  /** Opaque public revision identity; never a Job or reviewer identity. */
  readonly reviewId: string;
  readonly professionCode: string;
  readonly ratings: PublicCraftsmanReviewRatings;
  /** Equal-weight mean of answered dimensions, rounded to two decimals. */
  readonly score: number;
  readonly comment: string | null;
  /** Bratislava-local publication month, deliberately without exact time. */
  readonly reviewedMonth: string;
}

export interface PublicCraftsmanReviewPage {
  readonly items: readonly PublicCraftsmanReviewItem[];
  readonly nextCursor: string | null;
}

export interface ListPublicCraftsmanReviewsInput {
  readonly craftsmanProfileId: string;
  readonly cursor?: string | null;
  readonly limit?: number;
}

export class PublicCraftsmanReviewQueryValidationError extends Error {
  override readonly name = "PublicCraftsmanReviewQueryValidationError";
}

export class PublicCraftsmanReviewProjectionError extends Error {
  override readonly name = "PublicCraftsmanReviewProjectionError";
}

interface PublicProfileGateRow {
  readonly profileId: string;
}

interface CursorAnchorRow {
  readonly revisionId: string;
  readonly unlockedAt: Date;
}

interface PublicReviewRow {
  readonly revisionId: string;
  readonly professionCode: string;
  readonly ratings: unknown;
  readonly comment: string | null;
  readonly reviewedMonth: string;
}

interface NormalizedListInput {
  readonly craftsmanProfileId: string;
  readonly cursorRevisionId: string | null;
  readonly limit: number;
}

export function createPublicCraftsmanReviewRepository(sql: Sql) {
  return Object.freeze({
    async list(
      input: ListPublicCraftsmanReviewsInput,
    ): Promise<PublicCraftsmanReviewPage | null> {
      const normalized = normalizeInput(input);
      return sql.begin(
        "isolation level repeatable read read only",
        async (transaction) => listInSnapshot(transaction, normalized),
      );
    },
  });
}

async function listInSnapshot(
  sql: TransactionSql,
  input: NormalizedListInput,
): Promise<PublicCraftsmanReviewPage | null> {
  const [profile] = await sql<PublicProfileGateRow[]>`
    SELECT profile.id AS "profileId"
    FROM current_craftsman_profile_publications publication
    JOIN craftsman_profiles profile
      ON profile.id = publication.craftsman_profile_id
    JOIN users owner ON owner.id = profile.owner_user_id
    WHERE profile.id = ${input.craftsmanProfileId}
      AND publication.effectively_public
      AND publication.review_state = 'APPROVED'
      AND publication.owner_visibility = 'PUBLIC'
      AND publication.moderation_state = 'ALLOWED'
      AND owner.account_state = 'ACTIVE'
  `;
  if (profile === undefined) return null;

  let anchor: CursorAnchorRow | null = null;
  if (input.cursorRevisionId !== null) {
    const [cursorAnchor] = await sql<CursorAnchorRow[]>`
      SELECT review.revision_id AS "revisionId",
        review.unlocked_at AS "unlockedAt"
      FROM current_unlocked_job_main_reviews review
      WHERE review.target_profile_id = ${input.craftsmanProfileId}
        AND review.direction = 'CUSTOMER_TO_PROVIDER'
        AND review.target_kind = 'CRAFTSMAN_PROFILE'
        AND review.revision_id = ${input.cursorRevisionId}
    `;
    if (cursorAnchor === undefined) {
      throw new PublicCraftsmanReviewQueryValidationError(
        "Public review cursor is invalid for this profile.",
      );
    }
    anchor = cursorAnchor;
  }

  const rows =
    anchor === null
      ? await selectFirstPage(sql, input)
      : await selectAfterCursor(sql, input, anchor);
  const projected = rows.map(projectRow);
  const hasMore = projected.length > input.limit;
  const items = Object.freeze(projected.slice(0, input.limit));
  const last = items.at(-1);
  return Object.freeze({
    items,
    nextCursor:
      hasMore && last !== undefined ? encodeCursor(last.reviewId) : null,
  });
}

async function selectFirstPage(
  sql: TransactionSql,
  input: NormalizedListInput,
): Promise<PublicReviewRow[]> {
  return sql<PublicReviewRow[]>`
    SELECT review.revision_id AS "revisionId",
      review.accepted_profession_code AS "professionCode",
      review.ratings,
      review.comment,
      to_char(
        review.unlocked_at AT TIME ZONE 'Europe/Bratislava',
        'YYYY-MM'
      ) AS "reviewedMonth"
    FROM current_unlocked_job_main_reviews review
    WHERE review.target_profile_id = ${input.craftsmanProfileId}
      AND review.direction = 'CUSTOMER_TO_PROVIDER'
      AND review.target_kind = 'CRAFTSMAN_PROFILE'
    ORDER BY review.unlocked_at DESC, review.revision_id DESC
    LIMIT ${input.limit + 1}
  `;
}

async function selectAfterCursor(
  sql: TransactionSql,
  input: NormalizedListInput,
  anchor: CursorAnchorRow,
): Promise<PublicReviewRow[]> {
  return sql<PublicReviewRow[]>`
    SELECT review.revision_id AS "revisionId",
      review.accepted_profession_code AS "professionCode",
      review.ratings,
      review.comment,
      to_char(
        review.unlocked_at AT TIME ZONE 'Europe/Bratislava',
        'YYYY-MM'
      ) AS "reviewedMonth"
    FROM current_unlocked_job_main_reviews review
    WHERE review.target_profile_id = ${input.craftsmanProfileId}
      AND review.direction = 'CUSTOMER_TO_PROVIDER'
      AND review.target_kind = 'CRAFTSMAN_PROFILE'
      AND (review.unlocked_at, review.revision_id)
        < (${anchor.unlockedAt}, ${anchor.revisionId}::uuid)
    ORDER BY review.unlocked_at DESC, review.revision_id DESC
    LIMIT ${input.limit + 1}
  `;
}

function normalizeInput(
  input: ListPublicCraftsmanReviewsInput,
): NormalizedListInput {
  if (!isPublicCraftsmanProfileId(input.craftsmanProfileId)) {
    throw new PublicCraftsmanReviewQueryValidationError(
      "Public craftsman profile identifier is invalid.",
    );
  }
  const limit = input.limit ?? PUBLIC_CRAFTSMAN_REVIEW_DEFAULT_LIMIT;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > PUBLIC_CRAFTSMAN_REVIEW_MAX_LIMIT
  ) {
    throw new PublicCraftsmanReviewQueryValidationError(
      "Public review page size is invalid.",
    );
  }
  return Object.freeze({
    craftsmanProfileId: input.craftsmanProfileId,
    cursorRevisionId: decodeCursor(input.cursor),
    limit,
  });
}

function decodeCursor(cursor: string | null | undefined): string | null {
  if (cursor === undefined || cursor === null) return null;
  const match =
    /^v1\.([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu.exec(
      cursor,
    );
  if (match?.[1] === undefined) {
    throw new PublicCraftsmanReviewQueryValidationError(
      "Public review cursor is malformed.",
    );
  }
  return match[1].toLowerCase();
}

function encodeCursor(revisionId: string): string {
  return `v1.${revisionId}`;
}

function projectRow(row: PublicReviewRow): PublicCraftsmanReviewItem {
  if (
    !isUuid(row.revisionId) ||
    !isProfessionCode(row.professionCode) ||
    !/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(row.reviewedMonth)
  ) {
    throw new PublicCraftsmanReviewProjectionError(
      "Public review projection is malformed.",
    );
  }
  const ratings = normalizeRatings(row.ratings);
  const answered = Object.values(ratings).filter(
    (value): value is 1 | 2 | 3 | 4 | 5 => value !== null,
  );
  if (answered.length === 0) {
    throw new PublicCraftsmanReviewProjectionError(
      "Public review has no answered dimension.",
    );
  }
  const score =
    Math.round(
      (answered.reduce((total, value) => total + value, 0) / answered.length) *
        100,
    ) / 100;
  return Object.freeze({
    reviewId: row.revisionId,
    professionCode: row.professionCode,
    ratings,
    score,
    comment: publicComment(row.comment),
    reviewedMonth: row.reviewedMonth,
  });
}

function normalizeRatings(value: unknown): PublicCraftsmanReviewRatings {
  if (!isRecord(value)) {
    throw new PublicCraftsmanReviewProjectionError(
      "Public review ratings are malformed.",
    );
  }
  const keys = Object.keys(value).sort();
  const expected = [...customerToProviderDimensions].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index]) ||
    customerToProviderDimensions.some((key) => !isRating(value[key]))
  ) {
    throw new PublicCraftsmanReviewProjectionError(
      "Public review ratings are malformed.",
    );
  }
  return Object.freeze(
    Object.fromEntries(
      customerToProviderDimensions.map((key) => [key, value[key]]),
    ) as unknown as PublicCraftsmanReviewRatings,
  );
}

function publicComment(comment: string | null): string | null {
  if (comment === null) return null;
  return comment.length <= 2_000 && isPublicDisplayTextSafe(comment)
    ? comment
    : null;
}

function isRating(value: unknown): value is 1 | 2 | 3 | 4 | 5 | null {
  return (
    value === null ||
    value === 1 ||
    value === 2 ||
    value === 3 ||
    value === 4 ||
    value === 5
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProfessionCode(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(?:PROF|TEST):[A-Z0-9][A-Z0-9_]{1,62}$/u.test(value)
  );
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}
