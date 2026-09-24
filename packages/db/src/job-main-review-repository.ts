import type { Sql, TransactionSql } from "postgres";

type RootSql = Sql | TransactionSql;

export type JobMainReviewDirection =
  "CUSTOMER_TO_PROVIDER" | "PROVIDER_TO_CUSTOMER";

export type CustomerToProviderReviewDimension =
  | "work_quality"
  | "price_adherence"
  | "schedule_adherence"
  | "communication"
  | "cleanliness"
  | "problem_solving"
  | "would_hire_again";

export type ProviderToCustomerReviewDimension =
  | "agreement_payment_experience"
  | "site_readiness"
  | "brief_clarity"
  | "communication"
  | "unplanned_changes"
  | "fairness";

export type JobMainReviewDimension =
  CustomerToProviderReviewDimension | ProviderToCustomerReviewDimension;

export type JobMainReviewRatings = Readonly<
  Partial<Record<JobMainReviewDimension, 1 | 2 | 3 | 4 | 5 | null>>
>;

export interface JobMainReviewContent {
  readonly revisionId: string;
  readonly version: number;
  readonly submittedAt: Date;
  readonly revisedAt: Date;
  readonly ratings: JobMainReviewRatings;
  readonly comment: string | null;
}

export interface UnlockedCounterpartyJobMainReview {
  readonly direction: JobMainReviewDirection;
  readonly revisionId: string;
  readonly submittedAt: Date;
  readonly revisedAt: Date;
  readonly unlockedAt: Date;
  readonly ratings: JobMainReviewRatings;
  readonly comment: string | null;
}

export interface JobMainReviewOpportunity {
  readonly jobId: string;
  readonly direction: JobMainReviewDirection;
  readonly targetProfileId: string;
  readonly targetKind: "CRAFTSMAN_PROFILE" | "CUSTOMER_PROFILE";
  readonly acceptedProfessionCode: string;
  readonly completedAt: Date;
  readonly submissionDeadline: Date;
  readonly state:
    "OPEN" | "SUBMITTED_SEALED" | "UNLOCKED" | "EXPIRED_UNSUBMITTED";
  readonly ownReview: JobMainReviewContent | null;
  readonly counterpartyReview: UnlockedCounterpartyJobMainReview | null;
}

export interface SubmitJobMainReviewInput {
  readonly actorUserId: string;
  readonly jobId: string;
  readonly commandId: string;
  /** Zero creates the first revision; otherwise this must match the latest version. */
  readonly expectedVersion: number;
  readonly ratings: JobMainReviewRatings;
  readonly comment?: string | null;
}

export type SubmitJobMainReviewResult =
  | Readonly<{
      readonly status: "APPLIED" | "DEDUPLICATED";
      readonly direction: JobMainReviewDirection;
      readonly revisionId: string;
      readonly version: number;
      readonly recordedAt: Date;
    }>
  | Readonly<{
      readonly status:
        "NOT_FOUND" | "WINDOW_CLOSED" | "EDIT_LOCKED" | "STALE_VERSION";
    }>;

export class JobMainReviewIdempotencyError extends Error {}

interface ReviewOpportunityRow {
  readonly jobId: string;
  readonly direction: JobMainReviewDirection;
  readonly targetProfileId: string;
  readonly targetKind: "CRAFTSMAN_PROFILE" | "CUSTOMER_PROFILE";
  readonly acceptedProfessionCode: string;
  readonly completedAt: Date;
  readonly submissionDeadline: Date;
  readonly deadlinePassed: boolean;
  readonly ownRevisionId: string | null;
  readonly ownVersion: number | null;
  readonly ownSubmittedAt: Date | null;
  readonly ownRevisedAt: Date | null;
  readonly ownRatings: unknown;
  readonly ownComment: string | null;
  readonly ownUnlockedAt: Date | null;
  readonly counterpartyDirection: JobMainReviewDirection | null;
  readonly counterpartyRevisionId: string | null;
  readonly counterpartySubmittedAt: Date | null;
  readonly counterpartyRevisedAt: Date | null;
  readonly counterpartyUnlockedAt: Date | null;
  readonly counterpartyRatings: unknown;
  readonly counterpartyComment: string | null;
}

interface AuthorizedOpportunity {
  readonly direction: JobMainReviewDirection;
  readonly submissionDeadline: Date;
}

interface ExistingEvent {
  readonly jobId: string;
  readonly direction: JobMainReviewDirection;
  readonly version: number;
  readonly actorUserId: string;
  readonly ratings: unknown;
  readonly comment: string | null;
  readonly recordedAt: Date;
}

interface ReviewState {
  readonly firstAt: Date | null;
  readonly latestVersion: number;
  readonly oppositeSubmitted: boolean;
  readonly nowAt: Date;
}

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const professionCode = /^(?:PROF|TEST):[A-Z0-9][A-Z0-9_]{1,62}$/u;
const control = /[\p{Cc}]/u;

const customerToProviderDimensions = Object.freeze([
  "work_quality",
  "price_adherence",
  "schedule_adherence",
  "communication",
  "cleanliness",
  "problem_solving",
  "would_hire_again",
] as const);

const providerToCustomerDimensions = Object.freeze([
  "agreement_payment_experience",
  "site_readiness",
  "brief_clarity",
  "communication",
  "unplanned_changes",
  "fairness",
] as const);

export function createJobMainReviewRepository(sql: RootSql) {
  async function listForActor(input: {
    readonly actorUserId: string;
  }): Promise<readonly JobMainReviewOpportunity[]> {
    validIds(input.actorUserId);
    const rows = await selectOpportunities(sql, input.actorUserId);
    return Object.freeze(rows.map(projectOpportunity));
  }

  async function get(input: {
    readonly actorUserId: string;
    readonly jobId: string;
  }): Promise<JobMainReviewOpportunity | null> {
    validIds(input.actorUserId, input.jobId);
    const [row] = await selectOpportunities(
      sql,
      input.actorUserId,
      input.jobId,
    );
    return row === undefined ? null : projectOpportunity(row);
  }

  async function submit(
    input: SubmitJobMainReviewInput,
  ): Promise<SubmitJobMainReviewResult> {
    validateSubmit(input);
    const comment = normalizeComment(input.comment);
    return transaction(sql, async (tx) => {
      await tx`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${input.commandId}::text, 517017)
        )
      `;
      let opportunity = await authorizedOpportunity(
        tx,
        input.actorUserId,
        input.jobId,
      );
      if (opportunity === undefined) return { status: "NOT_FOUND" };

      await tx`SELECT id FROM jobs WHERE id = ${input.jobId} FOR UPDATE`;
      opportunity = await authorizedOpportunity(
        tx,
        input.actorUserId,
        input.jobId,
      );
      if (opportunity === undefined) return { status: "NOT_FOUND" };

      const ratings = normalizeRatings(opportunity.direction, input.ratings);
      const [existing] = await tx<ExistingEvent[]>`
        SELECT event_id AS "revisionId", job_id AS "jobId",
          direction::text, version, actor_user_id AS "actorUserId",
          ratings, comment, recorded_at AS "recordedAt"
        FROM job_main_review_events WHERE event_id = ${input.commandId}
      `;
      if (existing !== undefined) {
        if (existing.actorUserId !== input.actorUserId)
          return { status: "NOT_FOUND" };
        const requestedVersion = input.expectedVersion + 1;
        if (
          existing.jobId !== input.jobId ||
          existing.direction !== opportunity.direction ||
          existing.version !== requestedVersion ||
          existing.comment !== comment ||
          !sameRatings(existing.ratings, ratings, opportunity.direction)
        )
          throw new JobMainReviewIdempotencyError(
            "Job main review command ID was reused for another intent.",
          );
        return Object.freeze({
          status: "DEDUPLICATED" as const,
          direction: opportunity.direction,
          revisionId: input.commandId,
          version: existing.version,
          recordedAt: existing.recordedAt,
        });
      }

      const [state] = await tx<ReviewState[]>`
        SELECT min(recorded_at) AS "firstAt",
          coalesce(max(version), 0)::integer AS "latestVersion",
          EXISTS (
            SELECT 1 FROM job_main_review_events other
            WHERE other.job_id = ${input.jobId}
              AND other.direction <> ${opportunity.direction}::job_main_review_direction
              AND other.version = 1
          ) AS "oppositeSubmitted",
          clock_timestamp() AS "nowAt"
        FROM job_main_review_events
        WHERE job_id = ${input.jobId}
          AND direction = ${opportunity.direction}::job_main_review_direction
      `;
      if (state === undefined)
        throw new Error("Job main review state projection missing.");
      if (state.latestVersion !== input.expectedVersion)
        return { status: "STALE_VERSION" };
      if (state.nowAt >= opportunity.submissionDeadline)
        return { status: "WINDOW_CLOSED" };
      if (
        state.firstAt !== null &&
        (state.oppositeSubmitted ||
          state.nowAt.getTime() >= state.firstAt.getTime() + 60 * 60 * 1000)
      )
        return { status: "EDIT_LOCKED" };

      const version = input.expectedVersion + 1;
      const [inserted] = await tx<Array<{ recordedAt: Date }>>`
        INSERT INTO job_main_review_events (
          event_id, job_id, direction, version, actor_user_id, ratings, comment
        ) VALUES (
          ${input.commandId}, ${input.jobId},
          ${opportunity.direction}::job_main_review_direction,
          ${version}, ${input.actorUserId}, ${tx.json(ratings)}, ${comment}
        ) RETURNING recorded_at AS "recordedAt"
      `;
      if (inserted === undefined)
        throw new Error("Job main review effect missing.");
      return Object.freeze({
        status: "APPLIED" as const,
        direction: opportunity.direction,
        revisionId: input.commandId,
        version,
        recordedAt: inserted.recordedAt,
      });
    });
  }

  return Object.freeze({ listForActor, get, submit });
}

export type JobMainReviewRepository = ReturnType<
  typeof createJobMainReviewRepository
>;

async function selectOpportunities(
  sql: RootSql,
  actorUserId: string,
  jobId?: string,
): Promise<ReviewOpportunityRow[]> {
  return sql<ReviewOpportunityRow[]>`
    SELECT opportunity.job_id AS "jobId", opportunity.direction::text,
      opportunity.target_profile_id AS "targetProfileId",
      opportunity.target_kind AS "targetKind",
      opportunity.accepted_profession_code AS "acceptedProfessionCode",
      opportunity.completed_at AS "completedAt",
      opportunity.submission_deadline AS "submissionDeadline",
      clock_timestamp() >= opportunity.submission_deadline AS "deadlinePassed",
      own.event_id AS "ownRevisionId", own.version AS "ownVersion",
      own_first.recorded_at AS "ownSubmittedAt",
      own.recorded_at AS "ownRevisedAt", own.ratings AS "ownRatings",
      own.comment AS "ownComment",
      own_unlocked.unlocked_at AS "ownUnlockedAt",
      counterparty.direction::text AS "counterpartyDirection",
      counterparty.revision_id AS "counterpartyRevisionId",
      counterparty.submitted_at AS "counterpartySubmittedAt",
      counterparty.revised_at AS "counterpartyRevisedAt",
      counterparty.unlocked_at AS "counterpartyUnlockedAt",
      counterparty.ratings AS "counterpartyRatings",
      counterparty.comment AS "counterpartyComment"
    FROM job_main_review_opportunities opportunity
    JOIN users actor ON actor.id = opportunity.author_user_id
      AND actor.id = ${actorUserId} AND actor.account_state = 'ACTIVE'
    JOIN auth_credentials credential ON credential.user_id = actor.id
      AND credential.email_verified_at IS NOT NULL
      AND credential.phone_verified_at IS NOT NULL
    LEFT JOIN LATERAL (
      SELECT event_id, version, recorded_at, ratings, comment
      FROM job_main_review_events event
      WHERE event.job_id = opportunity.job_id
        AND event.direction = opportunity.direction
        AND event.actor_user_id = opportunity.author_user_id
      ORDER BY event.version DESC LIMIT 1
    ) own ON true
    LEFT JOIN job_main_review_events own_first
      ON own_first.job_id = opportunity.job_id
      AND own_first.direction = opportunity.direction
      AND own_first.version = 1
      AND own_first.actor_user_id = opportunity.author_user_id
    LEFT JOIN current_unlocked_job_main_reviews own_unlocked
      ON own_unlocked.job_id = opportunity.job_id
      AND own_unlocked.direction = opportunity.direction
      AND own_unlocked.actor_user_id = opportunity.author_user_id
    LEFT JOIN current_unlocked_job_main_reviews counterparty
      ON counterparty.job_id = opportunity.job_id
      AND counterparty.direction <> opportunity.direction
    WHERE (${jobId ?? null}::uuid IS NULL OR opportunity.job_id = ${jobId ?? null})
    ORDER BY opportunity.completed_at DESC, opportunity.job_id
  `;
}

async function authorizedOpportunity(
  tx: TransactionSql,
  actorUserId: string,
  jobId: string,
): Promise<AuthorizedOpportunity | undefined> {
  const [row] = await tx<AuthorizedOpportunity[]>`
    SELECT opportunity.direction::text,
      opportunity.submission_deadline AS "submissionDeadline"
    FROM job_main_review_opportunities opportunity
    JOIN users actor ON actor.id = opportunity.author_user_id
      AND actor.id = ${actorUserId} AND actor.account_state = 'ACTIVE'
    JOIN auth_credentials credential ON credential.user_id = actor.id
      AND credential.email_verified_at IS NOT NULL
      AND credential.phone_verified_at IS NOT NULL
    WHERE opportunity.job_id = ${jobId}
  `;
  if (row !== undefined && !validDirection(row.direction))
    throw new Error("Invalid Job main review opportunity direction.");
  if (row !== undefined && !validDate(row.submissionDeadline))
    throw new Error("Invalid Job main review opportunity deadline.");
  return row;
}

function projectOpportunity(
  row: ReviewOpportunityRow,
): JobMainReviewOpportunity {
  if (!validOpportunityRow(row))
    throw new Error("Invalid Job main review opportunity provenance.");
  const ownReview =
    row.ownRevisionId === null
      ? null
      : Object.freeze({
          revisionId: row.ownRevisionId,
          version: row.ownVersion as number,
          submittedAt: row.ownSubmittedAt as Date,
          revisedAt: row.ownRevisedAt as Date,
          ratings: freezeRatings(row.ownRatings, row.direction, "own review"),
          comment: row.ownComment,
        });
  const counterpartyReview =
    row.counterpartyRevisionId === null
      ? null
      : Object.freeze({
          direction: row.counterpartyDirection as JobMainReviewDirection,
          revisionId: row.counterpartyRevisionId,
          submittedAt: row.counterpartySubmittedAt as Date,
          revisedAt: row.counterpartyRevisedAt as Date,
          unlockedAt: row.counterpartyUnlockedAt as Date,
          ratings: freezeRatings(
            row.counterpartyRatings,
            row.counterpartyDirection as JobMainReviewDirection,
            "counterparty review",
          ),
          comment: row.counterpartyComment,
        });
  return Object.freeze({
    jobId: row.jobId,
    direction: row.direction,
    targetProfileId: row.targetProfileId,
    targetKind: row.targetKind,
    acceptedProfessionCode: row.acceptedProfessionCode,
    completedAt: row.completedAt,
    submissionDeadline: row.submissionDeadline,
    state:
      ownReview !== null && row.ownUnlockedAt !== null
        ? ("UNLOCKED" as const)
        : ownReview !== null
          ? ("SUBMITTED_SEALED" as const)
          : row.deadlinePassed
            ? ("EXPIRED_UNSUBMITTED" as const)
            : ("OPEN" as const),
    ownReview,
    counterpartyReview,
  });
}

function validOpportunityRow(row: ReviewOpportunityRow): boolean {
  const ownAbsent =
    row.ownRevisionId === null &&
    row.ownVersion === null &&
    row.ownSubmittedAt === null &&
    row.ownRevisedAt === null &&
    row.ownRatings === null &&
    row.ownComment === null &&
    row.ownUnlockedAt === null;
  const ownPresent =
    typeof row.ownRevisionId === "string" &&
    uuid.test(row.ownRevisionId) &&
    Number.isSafeInteger(row.ownVersion) &&
    (row.ownVersion ?? 0) > 0 &&
    validDate(row.ownSubmittedAt) &&
    validDate(row.ownRevisedAt) &&
    (row.ownComment === null || validComment(row.ownComment)) &&
    (row.ownUnlockedAt === null || validDate(row.ownUnlockedAt));
  const counterpartyAbsent =
    row.counterpartyDirection === null &&
    row.counterpartyRevisionId === null &&
    row.counterpartySubmittedAt === null &&
    row.counterpartyRevisedAt === null &&
    row.counterpartyUnlockedAt === null &&
    row.counterpartyRatings === null &&
    row.counterpartyComment === null;
  const counterpartyPresent =
    validDirection(row.counterpartyDirection) &&
    row.counterpartyDirection !== row.direction &&
    typeof row.counterpartyRevisionId === "string" &&
    uuid.test(row.counterpartyRevisionId) &&
    validDate(row.counterpartySubmittedAt) &&
    validDate(row.counterpartyRevisedAt) &&
    validDate(row.counterpartyUnlockedAt) &&
    (row.counterpartyComment === null || validComment(row.counterpartyComment));
  return (
    uuid.test(row.jobId) &&
    uuid.test(row.targetProfileId) &&
    validDirection(row.direction) &&
    ((row.direction === "CUSTOMER_TO_PROVIDER" &&
      row.targetKind === "CRAFTSMAN_PROFILE") ||
      (row.direction === "PROVIDER_TO_CUSTOMER" &&
        row.targetKind === "CUSTOMER_PROFILE")) &&
    professionCode.test(row.acceptedProfessionCode) &&
    validDate(row.completedAt) &&
    validDate(row.submissionDeadline) &&
    row.submissionDeadline > row.completedAt &&
    typeof row.deadlinePassed === "boolean" &&
    (ownAbsent || ownPresent) &&
    (counterpartyAbsent || counterpartyPresent) &&
    (row.ownUnlockedAt === null || row.ownRevisionId !== null) &&
    (row.counterpartyRevisionId === null || row.counterpartyUnlockedAt !== null)
  );
}

function validateSubmit(input: SubmitJobMainReviewInput): void {
  validIds(input.actorUserId, input.jobId, input.commandId);
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0)
    throw new TypeError("Invalid Job main review expected version.");
  if (!plainObject(input.ratings))
    throw new TypeError("Invalid Job main review ratings.");
  for (const [key, value] of Object.entries(input.ratings)) {
    if (
      ![
        ...customerToProviderDimensions,
        ...providerToCustomerDimensions,
      ].includes(key as JobMainReviewDimension) ||
      (value !== null &&
        (!Number.isInteger(value) ||
          (value as number) < 1 ||
          (value as number) > 5))
    )
      throw new TypeError("Invalid Job main review ratings.");
  }
  normalizeComment(input.comment);
}

function normalizeRatings(
  direction: JobMainReviewDirection,
  value: JobMainReviewRatings,
): Record<string, 1 | 2 | 3 | 4 | 5 | null> {
  const expected = dimensions(direction);
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => !expected.includes(key as never)) ||
    !expected.some((key) => value[key] !== null)
  )
    throw new TypeError("Exact substantive directional ratings are required.");
  return Object.fromEntries(expected.map((key) => [key, value[key] ?? null]));
}

function freezeRatings(
  value: unknown,
  direction: JobMainReviewDirection,
  label: string,
): JobMainReviewRatings {
  if (!plainObject(value))
    throw new Error(`Invalid ${label} ratings provenance.`);
  try {
    return Object.freeze(
      normalizeRatings(direction, value as JobMainReviewRatings),
    );
  } catch {
    throw new Error(`Invalid ${label} ratings provenance.`);
  }
}

function sameRatings(
  stored: unknown,
  requested: JobMainReviewRatings,
  direction: JobMainReviewDirection,
): boolean {
  if (!plainObject(stored)) return false;
  try {
    return (
      JSON.stringify(normalizeRatings(direction, stored)) ===
      JSON.stringify(requested)
    );
  } catch {
    return false;
  }
}

function dimensions(direction: JobMainReviewDirection) {
  return direction === "CUSTOMER_TO_PROVIDER"
    ? customerToProviderDimensions
    : providerToCustomerDimensions;
}

function normalizeComment(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (!validComment(value))
    throw new TypeError("Invalid Job main review comment.");
  return value;
}

function validComment(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 2000 &&
    value === value.trim() &&
    !control.test(value)
  );
}

function validDirection(value: unknown): value is JobMainReviewDirection {
  return value === "CUSTOMER_TO_PROVIDER" || value === "PROVIDER_TO_CUSTOMER";
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function validIds(...values: string[]): void {
  if (values.some((value) => typeof value !== "string" || !uuid.test(value)))
    throw new TypeError("Invalid Job main review identity.");
}

function transaction<T>(
  sql: RootSql,
  callback: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return ("savepoint" in sql
    ? sql.savepoint(callback)
    : sql.begin(callback)) as unknown as Promise<T>;
}
