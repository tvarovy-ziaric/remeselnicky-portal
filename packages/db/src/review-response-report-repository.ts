import { isPublicDisplayTextSafe } from "@portal/domain";
import type { Sql, TransactionSql } from "postgres";

type RootSql = Sql | TransactionSql;

export type ModerationReportTargetType =
  | "CRAFTSMAN_PROFILE"
  | "PORTFOLIO_PROJECT"
  | "MEDIA_ASSET"
  | "MAIN_REVIEW"
  | "REVIEW_RESPONSE"
  | "JOB_CONTEXT_REVIEW"
  | "SUPERVISOR_EVALUATION"
  | "MESSAGE"
  | "CONVERSATION"
  | "JOB_ATTACHMENT"
  | "JOB_REQUEST"
  | "USER_BEHAVIOR";
export type ModerationReportReason =
  | "SPAM_SCAM"
  | "PERSONAL_DATA_PRIVACY"
  | "HARASSMENT_ABUSE"
  | "INAPPROPRIATE_CONTENT"
  | "IMPERSONATION_MISREPRESENTATION"
  | "FRAUD"
  | "ILLEGAL_SUSPICIOUS_ACTIVITY"
  | "CONTACT_BYPASS_ABUSE"
  | "EXTORTION_RETALIATION"
  | "IRRELEVANT_CONTENT"
  | "SUSPECTED_FRAUD_FAKE_REVIEW"
  | "FALSE_QUALIFICATION"
  | "FALSE_IDENTITY"
  | "MISLEADING_CLAIM"
  | "NOT_THEIR_WORK"
  | "CUSTOMER_PRIVACY"
  | "STOLEN_IMAGES"
  | "THREATS"
  | "PLATFORM_BYPASS_ATTEMPT"
  | "SUSPICIOUS_PAYMENT_SCAM"
  | "OTHER";

export interface JobMainReviewResponse {
  readonly responseId: string;
  readonly reviewId: string;
  readonly revisionId: string;
  readonly version: number;
  readonly body: string;
  readonly respondedAt: Date;
  readonly revisedAt: Date;
  readonly editDeadline: Date;
}

export interface SubmitJobMainReviewResponseInput {
  readonly actorUserId: string;
  readonly commandId: string;
  readonly expectedVersion: number;
  readonly reviewId: string;
  readonly body: string;
}

export type SubmitJobMainReviewResponseResult =
  | Readonly<{
      status: "APPLIED" | "DEDUPLICATED";
      responseId: string;
      revisionId: string;
      version: number;
      recordedAt: Date;
    }>
  | Readonly<{ status: "NOT_FOUND" | "STALE_VERSION" | "EDIT_LOCKED" }>;

export interface CreateModerationReportInput {
  readonly actorUserId: string;
  readonly commandId: string;
  readonly targetType: ModerationReportTargetType;
  readonly targetId: string;
  readonly reason: ModerationReportReason;
  readonly details?: string | null;
  readonly evidenceReferenceType?: string | null;
  readonly evidenceReferenceId?: string | null;
}

export type CreateModerationReportResult =
  | Readonly<{
      status: "APPLIED" | "DEDUPLICATED";
      reportId: string;
      state: "OPEN";
      recordedAt: Date;
    }>
  | Readonly<{ status: "NOT_FOUND" | "ALREADY_REPORTED" }>;

export type ReviewResponseReportRepository = ReturnType<
  typeof createReviewResponseReportRepository
>;

export class ReviewResponseIdempotencyError extends Error {}
export class ModerationReportIdempotencyError extends Error {}

interface ResponseRow {
  readonly responseId: string;
  readonly reviewId: string;
  readonly revisionId: string;
  readonly version: number;
  readonly body: string;
  readonly respondedAt: Date;
  readonly revisedAt: Date;
  readonly lockedAt: Date;
}

interface ExistingResponseEventRow {
  readonly actorUserId: string;
  readonly responseId: string;
  readonly reviewId: string;
  readonly version: number;
  readonly body: string;
  readonly recordedAt: Date;
}

interface ReviewScopeRow {
  readonly authorUserId: string;
  readonly direction: "CUSTOMER_TO_PROVIDER";
  readonly jobId: string;
  readonly nowAt: Date;
}

interface ExistingReportRow {
  readonly reportId: string;
  readonly reporterUserId: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly reason: string;
  readonly details: string | null;
  readonly evidenceReferenceType: string | null;
  readonly evidenceReferenceId: string | null;
  readonly reportedAt: Date;
}

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const control = /[\p{Cc}]/u;
const targetTypes = new Set<ModerationReportTargetType>([
  "CRAFTSMAN_PROFILE",
  "PORTFOLIO_PROJECT",
  "MEDIA_ASSET",
  "MAIN_REVIEW",
  "REVIEW_RESPONSE",
  "JOB_CONTEXT_REVIEW",
  "SUPERVISOR_EVALUATION",
  "MESSAGE",
  "CONVERSATION",
  "JOB_ATTACHMENT",
  "JOB_REQUEST",
  "USER_BEHAVIOR",
]);
const reasons = new Set<ModerationReportReason>([
  "SPAM_SCAM",
  "PERSONAL_DATA_PRIVACY",
  "HARASSMENT_ABUSE",
  "INAPPROPRIATE_CONTENT",
  "IMPERSONATION_MISREPRESENTATION",
  "FRAUD",
  "ILLEGAL_SUSPICIOUS_ACTIVITY",
  "CONTACT_BYPASS_ABUSE",
  "EXTORTION_RETALIATION",
  "IRRELEVANT_CONTENT",
  "SUSPECTED_FRAUD_FAKE_REVIEW",
  "FALSE_QUALIFICATION",
  "FALSE_IDENTITY",
  "MISLEADING_CLAIM",
  "NOT_THEIR_WORK",
  "CUSTOMER_PRIVACY",
  "STOLEN_IMAGES",
  "THREATS",
  "PLATFORM_BYPASS_ATTEMPT",
  "SUSPICIOUS_PAYMENT_SCAM",
  "OTHER",
]);

export function createReviewResponseReportRepository(sql: RootSql) {
  async function getResponseForOwner(input: {
    readonly actorUserId: string;
    readonly reviewId: string;
  }): Promise<JobMainReviewResponse | null> {
    validIds(input.actorUserId, input.reviewId);
    const [row] = await sql<ResponseRow[]>`
      SELECT response.response_id AS "responseId",
        response.review_revision_id AS "reviewId",
        response.revision_id AS "revisionId", response.version,
        response.body, response.responded_at AS "respondedAt",
        response.revised_at AS "revisedAt",
        response.locked_at AS "lockedAt"
      FROM current_job_main_review_responses response
      JOIN current_unlocked_job_main_reviews review
        ON review.revision_id = response.review_revision_id
      JOIN craftsman_profiles profile
        ON profile.id = review.target_profile_id
        AND profile.owner_user_id = ${input.actorUserId}
      JOIN users actor ON actor.id = profile.owner_user_id
        AND actor.account_state = 'ACTIVE'
      JOIN auth_credentials credential ON credential.user_id = actor.id
        AND credential.email_verified_at IS NOT NULL
        AND credential.phone_verified_at IS NOT NULL
      WHERE response.review_revision_id = ${input.reviewId}
        AND review.direction = 'CUSTOMER_TO_PROVIDER'
        AND review.target_kind = 'CRAFTSMAN_PROFILE'
    `;
    return row === undefined ? null : projectResponse(row);
  }

  async function submitResponse(
    input: SubmitJobMainReviewResponseInput,
  ): Promise<SubmitJobMainReviewResponseResult> {
    validateResponseInput(input);
    return transaction(sql, async (tx) => {
      await tx`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${input.commandId}::text, 520020)
        )
      `;
      const [existingEvent] = await tx<ExistingResponseEventRow[]>`
        SELECT event.actor_user_id AS "actorUserId",
          response.response_id AS "responseId",
          response.review_revision_id AS "reviewId",
          event.version, event.body, event.recorded_at AS "recordedAt"
        FROM job_main_review_response_events event
        JOIN job_main_review_responses response
          ON response.response_id = event.response_id
        WHERE event.event_id = ${input.commandId}
      `;
      if (existingEvent !== undefined) {
        if (existingEvent.actorUserId !== input.actorUserId)
          return { status: "NOT_FOUND" };
        if (
          existingEvent.reviewId !== input.reviewId ||
          existingEvent.version !== input.expectedVersion + 1 ||
          existingEvent.body !== input.body
        )
          throw new ReviewResponseIdempotencyError(
            "Review response command ID was reused for another intent.",
          );
        return Object.freeze({
          status: "DEDUPLICATED" as const,
          responseId: existingEvent.responseId,
          revisionId: input.commandId,
          version: existingEvent.version,
          recordedAt: existingEvent.recordedAt,
        });
      }

      const [scope] = await tx<ReviewScopeRow[]>`
        SELECT review.job_id AS "jobId", review.direction::text AS direction,
          profile.owner_user_id AS "authorUserId",
          clock_timestamp() AS "nowAt"
        FROM current_unlocked_job_main_reviews review
        JOIN craftsman_profiles profile
          ON profile.id = review.target_profile_id
          AND profile.owner_user_id = ${input.actorUserId}
        JOIN users actor ON actor.id = profile.owner_user_id
          AND actor.account_state = 'ACTIVE'
        JOIN auth_credentials credential ON credential.user_id = actor.id
          AND credential.email_verified_at IS NOT NULL
          AND credential.phone_verified_at IS NOT NULL
        WHERE review.revision_id = ${input.reviewId}
          AND review.direction = 'CUSTOMER_TO_PROVIDER'
          AND review.target_kind = 'CRAFTSMAN_PROFILE'
      `;
      if (scope === undefined) return { status: "NOT_FOUND" };
      const [locked] = await tx<Array<{ readonly id: string }>>`
        SELECT id FROM jobs WHERE id = ${scope.jobId} FOR UPDATE
      `;
      if (locked === undefined) return { status: "NOT_FOUND" };

      const [current] = await tx<ResponseRow[]>`
        SELECT response.response_id AS "responseId",
          response.review_revision_id AS "reviewId",
          response.revision_id AS "revisionId", response.version,
          response.body, response.responded_at AS "respondedAt",
          response.revised_at AS "revisedAt",
          response.locked_at AS "lockedAt"
        FROM current_job_main_review_responses response
        WHERE response.review_revision_id = ${input.reviewId}
      `;
      if ((current?.version ?? 0) !== input.expectedVersion)
        return { status: "STALE_VERSION" };
      if (current !== undefined && scope.nowAt >= current.lockedAt)
        return { status: "EDIT_LOCKED" };

      const responseId = current?.responseId ?? input.commandId;
      if (current === undefined) {
        await tx`
          INSERT INTO job_main_review_responses (
            response_id, review_revision_id, job_id, direction,
            author_user_id, create_command_id
          ) VALUES (
            ${responseId}, ${input.reviewId}, ${scope.jobId}, ${scope.direction},
            ${input.actorUserId}, ${input.commandId}
          )
        `;
      }
      const version = input.expectedVersion + 1;
      const [inserted] = await tx<Array<{ readonly recordedAt: Date }>>`
        INSERT INTO job_main_review_response_events (
          event_id, response_id, version, actor_user_id, body
        ) VALUES (
          ${input.commandId}, ${responseId}, ${version},
          ${input.actorUserId}, ${input.body}
        ) RETURNING recorded_at AS "recordedAt"
      `;
      if (inserted === undefined || !validDate(inserted.recordedAt))
        throw new Error("Review response revision effect missing.");
      return Object.freeze({
        status: "APPLIED" as const,
        responseId,
        revisionId: input.commandId,
        version,
        recordedAt: inserted.recordedAt,
      });
    });
  }

  async function createReport(
    input: CreateModerationReportInput,
  ): Promise<CreateModerationReportResult> {
    const normalized = validateReportInput(input);
    return transaction(sql, async (tx) => {
      await tx`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${input.commandId}::text, 524020)
        )
      `;
      const [existing] = await tx<ExistingReportRow[]>`
        SELECT report_id AS "reportId", reporter_user_id AS "reporterUserId",
          target_type::text AS "targetType", target_id AS "targetId",
          reason::text, details,
          evidence_reference_type AS "evidenceReferenceType",
          evidence_reference_id AS "evidenceReferenceId",
          reported_at AS "reportedAt"
        FROM moderation_reports WHERE report_id = ${input.commandId}
      `;
      if (existing !== undefined) {
        if (existing.reporterUserId !== input.actorUserId)
          return { status: "NOT_FOUND" };
        if (
          existing.targetType !== input.targetType ||
          existing.targetId !== input.targetId ||
          existing.reason !== input.reason ||
          existing.details !== normalized.details ||
          existing.evidenceReferenceType !== normalized.evidenceType ||
          existing.evidenceReferenceId !== normalized.evidenceId
        )
          throw new ModerationReportIdempotencyError(
            "Moderation report command ID was reused for another intent.",
          );
        return Object.freeze({
          status: "DEDUPLICATED" as const,
          reportId: existing.reportId,
          state: "OPEN" as const,
          recordedAt: existing.reportedAt,
        });
      }

      const [scope] = await tx<Array<{ readonly reportable: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM users actor
          JOIN auth_credentials credential ON credential.user_id = actor.id
            AND credential.email_verified_at IS NOT NULL
            AND credential.phone_verified_at IS NOT NULL
          WHERE actor.id = ${input.actorUserId}
            AND actor.account_state = 'ACTIVE'
            AND moderation_target_is_reportable(
              ${input.targetType}::moderation_report_target_type,
              ${input.targetId}::uuid,
              ${input.actorUserId}::uuid
            )
        ) AS reportable
      `;
      if (scope?.reportable !== true) return { status: "NOT_FOUND" };
      const [duplicate] = await tx<Array<{ readonly reportId: string }>>`
        SELECT report_id AS "reportId" FROM moderation_reports
        WHERE reporter_user_id = ${input.actorUserId}
          AND target_type = ${input.targetType}
          AND target_id = ${input.targetId}
      `;
      if (duplicate !== undefined) return { status: "ALREADY_REPORTED" };

      const [inserted] = await tx<Array<{ readonly recordedAt: Date }>>`
        INSERT INTO moderation_reports (
          report_id, reporter_user_id, target_type, target_id, reason, details,
          evidence_reference_type, evidence_reference_id
        ) VALUES (
          ${input.commandId}, ${input.actorUserId}, ${input.targetType},
          ${input.targetId}, ${input.reason}, ${normalized.details},
          ${normalized.evidenceType}, ${normalized.evidenceId}
        ) RETURNING reported_at AS "recordedAt"
      `;
      if (inserted === undefined || !validDate(inserted.recordedAt))
        throw new Error("Moderation report effect missing.");
      return Object.freeze({
        status: "APPLIED" as const,
        reportId: input.commandId,
        state: "OPEN" as const,
        recordedAt: inserted.recordedAt,
      });
    });
  }

  return Object.freeze({ getResponseForOwner, submitResponse, createReport });
}

function projectResponse(row: ResponseRow): JobMainReviewResponse {
  if (
    !uuid.test(row.responseId) ||
    !uuid.test(row.reviewId) ||
    !uuid.test(row.revisionId) ||
    !Number.isSafeInteger(row.version) ||
    row.version < 1 ||
    !validBody(row.body) ||
    !validDate(row.respondedAt) ||
    !validDate(row.revisedAt) ||
    !validDate(row.lockedAt) ||
    row.revisedAt < row.respondedAt ||
    row.lockedAt <= row.respondedAt
  )
    throw new Error("Invalid review response projection.");
  return Object.freeze({
    responseId: row.responseId,
    reviewId: row.reviewId,
    revisionId: row.revisionId,
    version: row.version,
    body: row.body,
    respondedAt: row.respondedAt,
    revisedAt: row.revisedAt,
    editDeadline: row.lockedAt,
  });
}

function validateResponseInput(input: SubmitJobMainReviewResponseInput): void {
  validIds(input.actorUserId, input.commandId, input.reviewId);
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0)
    throw new TypeError("Invalid review response expected version.");
  if (!validBody(input.body))
    throw new TypeError("Invalid review response body.");
}

function validateReportInput(input: CreateModerationReportInput): {
  details: string | null;
  evidenceType: string | null;
  evidenceId: string | null;
} {
  validIds(input.actorUserId, input.commandId, input.targetId);
  if (!targetTypes.has(input.targetType) || !reasons.has(input.reason))
    throw new TypeError("Invalid moderation report category.");
  const details = input.details ?? null;
  if (
    details !== null &&
    (details !== details.trim() ||
      details.length < 1 ||
      details.length > 1_000 ||
      control.test(details))
  )
    throw new TypeError("Invalid moderation report details.");
  const evidenceType = input.evidenceReferenceType ?? null;
  const evidenceId = input.evidenceReferenceId ?? null;
  if ((evidenceType === null) !== (evidenceId === null))
    throw new TypeError("Incomplete moderation evidence reference.");
  if (
    evidenceType !== null &&
    (!/^[A-Z][A-Z0-9_]{1,63}$/u.test(evidenceType) ||
      !uuid.test(evidenceId ?? ""))
  )
    throw new TypeError("Invalid moderation evidence reference.");
  return { details, evidenceType, evidenceId };
}

function validBody(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length >= 1 &&
    value.length <= 2_000 &&
    !control.test(value) &&
    isPublicDisplayTextSafe(value)
  );
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function validIds(...values: string[]): void {
  if (values.some((value) => !uuid.test(value)))
    throw new TypeError("Invalid review response/report identifier.");
}

function transaction<T>(
  sql: RootSql,
  callback: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return ("savepoint" in sql
    ? callback(sql)
    : sql.begin(callback)) as unknown as Promise<T>;
}
