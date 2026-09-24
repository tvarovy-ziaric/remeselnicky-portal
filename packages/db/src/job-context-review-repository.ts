import type { Sql, TransactionSql } from "postgres";

type RootSql = Sql | TransactionSql;

export type JobContextReviewTargetKind = "PARTICIPANT" | "WORK_GROUP";
export type JobContextReviewRating = 1 | 2 | 3 | 4 | 5 | null;
export type JobContextReviewRatings = Readonly<
  Record<string, JobContextReviewRating>
>;
export type VerifiedJobParticipantRole =
  "MEMBER" | "LEAD" | "COORDINATOR" | "SITE_MANAGER";

export interface JobContextReviewContent {
  readonly revisionId: string;
  readonly version: number;
  readonly submittedAt: Date;
  readonly revisedAt: Date;
  readonly editDeadline: Date;
  readonly ratings: JobContextReviewRatings;
  readonly comment: string | null;
}

export interface JobParticipantReviewTarget {
  readonly targetKind: "PARTICIPANT";
  readonly participantId: string;
  readonly participantProfileId: string;
  readonly displayName: string;
  readonly participationStartedAt: Date;
  readonly participationEndedAt: Date;
  readonly verifiedProfessionCodes: readonly string[];
  readonly verifiedRoles: readonly VerifiedJobParticipantRole[];
  readonly review: JobContextReviewContent | null;
}

export interface JobWorkGroupReviewMember {
  readonly assignmentId: string;
  readonly participantId: string;
  readonly participantProfileId: string;
  readonly displayName: string;
  readonly overlapStartedAt: Date;
  readonly overlapEndedAt: Date;
}

export interface JobWorkGroupReviewTarget {
  readonly targetKind: "WORK_GROUP";
  readonly workGroupId: string;
  readonly name: string;
  readonly members: readonly JobWorkGroupReviewMember[];
  readonly review: JobContextReviewContent | null;
}

export interface JobContextReviewPage {
  readonly jobId: string;
  readonly completedAt: Date;
  readonly submissionDeadline: Date;
  readonly participants: readonly JobParticipantReviewTarget[];
  readonly workGroups: readonly JobWorkGroupReviewTarget[];
}

export interface SubmitJobContextReviewInput {
  readonly actorUserId: string;
  readonly jobId: string;
  readonly targetKind: JobContextReviewTargetKind;
  readonly targetId: string;
  readonly commandId: string;
  readonly expectedVersion: number;
  readonly ratings: JobContextReviewRatings;
  readonly comment?: string | null;
}

export type SubmitJobContextReviewResult =
  | Readonly<{
      readonly status: "APPLIED" | "DEDUPLICATED";
      readonly targetKind: JobContextReviewTargetKind;
      readonly targetId: string;
      readonly revisionId: string;
      readonly version: number;
      readonly recordedAt: Date;
    }>
  | Readonly<{
      readonly status:
        "NOT_FOUND" | "WINDOW_CLOSED" | "EDIT_LOCKED" | "STALE_VERSION";
    }>;

export class JobContextReviewIdempotencyError extends Error {}

interface ScopeRow {
  readonly completedAt: Date;
  readonly submissionDeadline: Date;
}

interface ParticipantRow {
  readonly participantId: string;
  readonly participantProfileId: string;
  readonly nickname: string | null;
  readonly realFirstName: string | null;
  readonly realLastName: string | null;
  readonly participationStartedAt: Date;
  readonly participationEndedAt: Date;
  readonly verifiedProfessionCodes: string[];
  readonly verifiedRoles: string[];
  readonly revisionId: string | null;
  readonly version: number | null;
  readonly submittedAt: Date | null;
  readonly revisedAt: Date | null;
  readonly editDeadline: Date | null;
  readonly ratings: unknown;
  readonly comment: string | null;
}

interface WorkGroupRow {
  readonly workGroupId: string;
  readonly name: string;
  readonly revisionId: string | null;
  readonly version: number | null;
  readonly submittedAt: Date | null;
  readonly revisedAt: Date | null;
  readonly editDeadline: Date | null;
  readonly ratings: unknown;
  readonly comment: string | null;
}

interface WorkGroupMemberRow {
  readonly workGroupId: string;
  readonly assignmentId: string;
  readonly participantId: string;
  readonly participantProfileId: string;
  readonly nickname: string | null;
  readonly realFirstName: string | null;
  readonly realLastName: string | null;
  readonly overlapStartedAt: Date;
  readonly overlapEndedAt: Date;
}

interface OpportunityRow {
  readonly participantId: string | null;
  readonly workGroupId: string | null;
  readonly completionDecisionId: string;
  readonly completedAt: Date;
  readonly submissionDeadline: Date;
  readonly nowAt: Date;
}

interface ExistingRevisionRow {
  readonly actorUserId: string;
  readonly jobId: string;
  readonly targetKind: JobContextReviewTargetKind;
  readonly targetId: string;
  readonly version: number;
  readonly ratings: unknown;
  readonly comment: string | null;
  readonly recordedAt: Date;
}

interface ReviewStateRow {
  readonly reviewId: string;
  readonly latestVersion: number;
  readonly firstAt: Date;
}

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const professionCode = /^(?:PROF|TEST):[A-Z0-9][A-Z0-9_]{1,62}$/u;
const control = /[\p{Cc}]/u;

export const participantReviewDimensions = Object.freeze([
  "work_quality",
  "price_adherence",
  "schedule_adherence",
  "communication",
  "cleanliness",
  "problem_solving",
  "would_hire_again",
] as const);

export const workGroupReviewDimensions = Object.freeze([
  "result_quality",
  "coordination",
  "timing",
  "communication",
  "cleanliness",
  "problem_solving",
] as const);

export function createJobContextReviewRepository(sql: RootSql) {
  async function getForCustomer(input: {
    readonly actorUserId: string;
    readonly jobId: string;
  }): Promise<JobContextReviewPage | null> {
    validIds(input.actorUserId, input.jobId);
    return transaction(sql, async (tx) => {
      const [scope] = await tx<ScopeRow[]>`
        SELECT min(opportunity.completed_at) AS "completedAt",
          min(opportunity.submission_deadline) AS "submissionDeadline"
        FROM job_context_review_opportunities opportunity
        JOIN users actor ON actor.id = opportunity.author_user_id
          AND actor.id = ${input.actorUserId}
          AND actor.account_state = 'ACTIVE'
        JOIN auth_credentials credential ON credential.user_id = actor.id
          AND credential.email_verified_at IS NOT NULL
          AND credential.phone_verified_at IS NOT NULL
        WHERE opportunity.job_id = ${input.jobId}
        HAVING count(*) > 0
      `;
      if (scope === undefined) return null;
      if (
        !validDate(scope.completedAt) ||
        !validDate(scope.submissionDeadline) ||
        scope.submissionDeadline <= scope.completedAt
      )
        throw new Error("Invalid Job context review scope provenance.");

      const participantRows = await tx<ParticipantRow[]>`
        SELECT opportunity.participant_id AS "participantId",
          opportunity.participant_profile_id AS "participantProfileId",
          profile.nickname, profile.real_first_name AS "realFirstName",
          profile.real_last_name AS "realLastName",
          participation.participation_started_at AS "participationStartedAt",
          participation.participation_ended_at AS "participationEndedAt",
          ARRAY(
            SELECT DISTINCT capability.profession_code
            FROM verified_completed_job_capabilities capability
            WHERE capability.job_id = opportunity.job_id
              AND capability.participant_id = opportunity.participant_id
              AND capability.kind = 'PROFESSION'
            ORDER BY capability.profession_code
          ) AS "verifiedProfessionCodes",
          ARRAY(
            SELECT DISTINCT role.role
            FROM verified_completed_job_roles role
            WHERE role.job_id = opportunity.job_id
              AND role.participant_id = opportunity.participant_id
            ORDER BY role.role
          ) AS "verifiedRoles",
          review.revision_id AS "revisionId", review.version,
          review.submitted_at AS "submittedAt",
          review.revised_at AS "revisedAt",
          review.edit_deadline AS "editDeadline",
          review.ratings, review.comment
        FROM job_context_review_opportunities opportunity
        JOIN verified_individual_completed_job_participation participation
          ON participation.job_id = opportunity.job_id
          AND participation.participant_id = opportunity.participant_id
        JOIN craftsman_profiles profile
          ON profile.id = opportunity.participant_profile_id
        LEFT JOIN current_job_context_reviews review
          ON review.job_id = opportunity.job_id
          AND review.target_kind = opportunity.target_kind
          AND review.participant_id = opportunity.participant_id
        WHERE opportunity.job_id = ${input.jobId}
          AND opportunity.author_user_id = ${input.actorUserId}
          AND opportunity.target_kind = 'PARTICIPANT'
        ORDER BY opportunity.participant_id
      `;
      const workGroupRows = await tx<WorkGroupRow[]>`
        SELECT opportunity.work_group_id AS "workGroupId", group_row.name,
          review.revision_id AS "revisionId", review.version,
          review.submitted_at AS "submittedAt",
          review.revised_at AS "revisedAt",
          review.edit_deadline AS "editDeadline",
          review.ratings, review.comment
        FROM job_context_review_opportunities opportunity
        JOIN job_work_groups group_row
          ON group_row.job_id = opportunity.job_id
          AND group_row.id = opportunity.work_group_id
        LEFT JOIN current_job_context_reviews review
          ON review.job_id = opportunity.job_id
          AND review.target_kind = opportunity.target_kind
          AND review.work_group_id = opportunity.work_group_id
        WHERE opportunity.job_id = ${input.jobId}
          AND opportunity.author_user_id = ${input.actorUserId}
          AND opportunity.target_kind = 'WORK_GROUP'
        ORDER BY group_row.name, opportunity.work_group_id
      `;
      const workGroupIds = workGroupRows.map((row) => row.workGroupId);
      const memberRows =
        workGroupIds.length === 0
          ? []
          : await tx<WorkGroupMemberRow[]>`
              SELECT assignment.work_group_id AS "workGroupId",
                assignment.assignment_id AS "assignmentId",
                assignment.participant_id AS "participantId",
                assignment.individual_profile_id AS "participantProfileId",
                profile.nickname, profile.real_first_name AS "realFirstName",
                profile.real_last_name AS "realLastName",
                assignment.overlap_started_at AS "overlapStartedAt",
                assignment.overlap_ended_at AS "overlapEndedAt"
              FROM verified_completed_job_work_group_assignments assignment
              JOIN craftsman_profiles profile
                ON profile.id = assignment.individual_profile_id
              WHERE assignment.job_id = ${input.jobId}
                AND assignment.work_group_id = ANY(${workGroupIds}::uuid[])
              ORDER BY assignment.work_group_id,
                assignment.overlap_started_at, assignment.assignment_id
            `;
      const members = groupMembers(memberRows, workGroupIds);
      const participants = participantRows.map(projectParticipant);
      const workGroups = workGroupRows.map((row) => {
        if (!validWorkGroupRow(row))
          throw new Error("Invalid Job work-group review target provenance.");
        const groupMembersForTarget = members.get(row.workGroupId) ?? [];
        if (groupMembersForTarget.length === 0)
          throw new Error("Verified Job work-group review roster missing.");
        return Object.freeze({
          targetKind: "WORK_GROUP" as const,
          workGroupId: row.workGroupId,
          name: row.name,
          members: Object.freeze(groupMembersForTarget),
          review: projectReview(row, "WORK_GROUP"),
        });
      });
      return Object.freeze({
        jobId: input.jobId,
        completedAt: scope.completedAt,
        submissionDeadline: scope.submissionDeadline,
        participants: Object.freeze(participants),
        workGroups: Object.freeze(workGroups),
      });
    });
  }

  async function submit(
    input: SubmitJobContextReviewInput,
  ): Promise<SubmitJobContextReviewResult> {
    validateSubmit(input);
    const ratings = normalizeRatings(input.targetKind, input.ratings);
    const comment = normalizeComment(input.comment);
    return transaction(sql, async (tx) => {
      await tx`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${input.commandId}::text, 518018)
        )
      `;
      const [locked] = await tx<Array<{ readonly id: string }>>`
        SELECT id FROM jobs WHERE id = ${input.jobId} FOR UPDATE
      `;
      if (locked === undefined) return { status: "NOT_FOUND" };
      const [opportunity] = await tx<OpportunityRow[]>`
        SELECT opportunity.participant_id AS "participantId",
          opportunity.work_group_id AS "workGroupId",
          opportunity.completion_decision_id AS "completionDecisionId",
          opportunity.completed_at AS "completedAt",
          opportunity.submission_deadline AS "submissionDeadline",
          clock_timestamp() AS "nowAt"
        FROM job_context_review_opportunities opportunity
        JOIN users actor ON actor.id = opportunity.author_user_id
          AND actor.id = ${input.actorUserId}
          AND actor.account_state = 'ACTIVE'
        JOIN auth_credentials credential ON credential.user_id = actor.id
          AND credential.email_verified_at IS NOT NULL
          AND credential.phone_verified_at IS NOT NULL
        WHERE opportunity.job_id = ${input.jobId}
          AND opportunity.target_kind = ${input.targetKind}::job_context_review_target_kind
          AND (${input.targetKind} <> 'PARTICIPANT'
            OR opportunity.participant_id = ${input.targetId})
          AND (${input.targetKind} <> 'WORK_GROUP'
            OR opportunity.work_group_id = ${input.targetId})
      `;
      if (opportunity === undefined) return { status: "NOT_FOUND" };
      const targetId =
        input.targetKind === "PARTICIPANT"
          ? opportunity.participantId
          : opportunity.workGroupId;
      if (
        targetId !== input.targetId ||
        !uuid.test(opportunity.completionDecisionId) ||
        !validDate(opportunity.completedAt) ||
        !validDate(opportunity.submissionDeadline) ||
        !validDate(opportunity.nowAt)
      )
        throw new Error("Invalid Job context review opportunity provenance.");

      const [existing] = await tx<ExistingRevisionRow[]>`
        SELECT revision.actor_user_id AS "actorUserId",
          review.job_id AS "jobId", review.target_kind::text AS "targetKind",
          coalesce(review.participant_id, review.work_group_id) AS "targetId",
          revision.version, revision.ratings, revision.comment,
          revision.recorded_at AS "recordedAt"
        FROM job_context_review_revisions revision
        JOIN job_context_reviews review ON review.review_id = revision.review_id
        WHERE revision.event_id = ${input.commandId}
      `;
      if (existing !== undefined) {
        if (existing.actorUserId !== input.actorUserId)
          return { status: "NOT_FOUND" };
        if (
          existing.jobId !== input.jobId ||
          existing.targetKind !== input.targetKind ||
          existing.targetId !== input.targetId ||
          existing.version !== input.expectedVersion + 1 ||
          existing.comment !== comment ||
          !sameRatings(existing.ratings, ratings, input.targetKind)
        )
          throw new JobContextReviewIdempotencyError(
            "Job context review command ID was reused for another intent.",
          );
        return Object.freeze({
          status: "DEDUPLICATED" as const,
          targetKind: input.targetKind,
          targetId: input.targetId,
          revisionId: input.commandId,
          version: existing.version,
          recordedAt: existing.recordedAt,
        });
      }

      const [state] = await tx<ReviewStateRow[]>`
        SELECT review.review_id AS "reviewId",
          max(revision.version)::integer AS "latestVersion",
          min(revision.recorded_at) AS "firstAt"
        FROM job_context_reviews review
        JOIN job_context_review_revisions revision
          ON revision.review_id = review.review_id
        WHERE review.job_id = ${input.jobId}
          AND review.target_kind = ${input.targetKind}::job_context_review_target_kind
          AND (${input.targetKind} <> 'PARTICIPANT'
            OR review.participant_id = ${input.targetId})
          AND (${input.targetKind} <> 'WORK_GROUP'
            OR review.work_group_id = ${input.targetId})
        GROUP BY review.review_id
      `;
      if ((state?.latestVersion ?? 0) !== input.expectedVersion)
        return { status: "STALE_VERSION" };
      if (opportunity.nowAt >= opportunity.submissionDeadline)
        return { status: "WINDOW_CLOSED" };
      if (
        state !== undefined &&
        opportunity.nowAt.getTime() >=
          Math.min(
            state.firstAt.getTime() + 60 * 60 * 1_000,
            opportunity.submissionDeadline.getTime(),
          )
      )
        return { status: "EDIT_LOCKED" };

      const reviewId = state?.reviewId ?? input.commandId;
      if (state === undefined) {
        await tx`
          INSERT INTO job_context_reviews (
            review_id, create_command_id, job_id, target_kind,
            participant_id, work_group_id, participant_profile_id,
            author_user_id, completion_decision_id,
            completed_at, submission_deadline
          ) VALUES (
            ${reviewId}, ${input.commandId}, ${input.jobId},
            ${input.targetKind}::job_context_review_target_kind,
            ${input.targetKind === "PARTICIPANT" ? input.targetId : null},
            ${input.targetKind === "WORK_GROUP" ? input.targetId : null},
            NULL, ${input.actorUserId},
            ${opportunity.completionDecisionId},
            ${opportunity.completedAt}, ${opportunity.submissionDeadline}
          )
        `;
      }
      const version = input.expectedVersion + 1;
      const [inserted] = await tx<Array<{ readonly recordedAt: Date }>>`
        INSERT INTO job_context_review_revisions (
          event_id, review_id, version, actor_user_id, ratings, comment
        ) VALUES (
          ${input.commandId}, ${reviewId}, ${version}, ${input.actorUserId},
          ${tx.json(ratings)}, ${comment}
        ) RETURNING recorded_at AS "recordedAt"
      `;
      if (inserted === undefined || !validDate(inserted.recordedAt))
        throw new Error("Job context review revision effect missing.");
      return Object.freeze({
        status: "APPLIED" as const,
        targetKind: input.targetKind,
        targetId: input.targetId,
        revisionId: input.commandId,
        version,
        recordedAt: inserted.recordedAt,
      });
    });
  }

  return Object.freeze({ getForCustomer, submit });
}

export type JobContextReviewRepository = ReturnType<
  typeof createJobContextReviewRepository
>;

function projectParticipant(row: ParticipantRow): JobParticipantReviewTarget {
  if (!validParticipantRow(row))
    throw new Error("Invalid Job participant review target provenance.");
  return Object.freeze({
    targetKind: "PARTICIPANT",
    participantId: row.participantId,
    participantProfileId: row.participantProfileId,
    displayName: displayName(row, row.participantProfileId),
    participationStartedAt: row.participationStartedAt,
    participationEndedAt: row.participationEndedAt,
    verifiedProfessionCodes: Object.freeze([...row.verifiedProfessionCodes]),
    verifiedRoles: Object.freeze([
      ...row.verifiedRoles,
    ] as VerifiedJobParticipantRole[]),
    review: projectReview(row, "PARTICIPANT"),
  });
}

function projectReview(
  row: Pick<
    ParticipantRow,
    | "revisionId"
    | "version"
    | "submittedAt"
    | "revisedAt"
    | "editDeadline"
    | "ratings"
    | "comment"
  >,
  targetKind: JobContextReviewTargetKind,
): JobContextReviewContent | null {
  const absent =
    row.revisionId === null &&
    row.version === null &&
    row.submittedAt === null &&
    row.revisedAt === null &&
    row.editDeadline === null &&
    row.ratings === null &&
    row.comment === null;
  if (absent) return null;
  if (
    typeof row.revisionId !== "string" ||
    !uuid.test(row.revisionId) ||
    !Number.isSafeInteger(row.version) ||
    (row.version ?? 0) < 1 ||
    !validDate(row.submittedAt) ||
    !validDate(row.revisedAt) ||
    !validDate(row.editDeadline) ||
    row.revisedAt < row.submittedAt ||
    row.editDeadline <= row.submittedAt ||
    (row.comment !== null && !validComment(row.comment))
  )
    throw new Error("Invalid Job context review content provenance.");
  return Object.freeze({
    revisionId: row.revisionId,
    version: row.version as number,
    submittedAt: row.submittedAt,
    revisedAt: row.revisedAt,
    editDeadline: row.editDeadline,
    ratings: Object.freeze(normalizeRatings(targetKind, row.ratings)),
    comment: row.comment,
  });
}

function groupMembers(
  rows: readonly WorkGroupMemberRow[],
  workGroupIds: readonly string[],
): Map<string, JobWorkGroupReviewMember[]> {
  const allowed = new Set(workGroupIds);
  const grouped = new Map<string, JobWorkGroupReviewMember[]>();
  for (const row of rows) {
    if (!validWorkGroupMemberRow(row) || !allowed.has(row.workGroupId))
      throw new Error("Invalid verified Job work-group roster provenance.");
    const members = grouped.get(row.workGroupId) ?? [];
    members.push(
      Object.freeze({
        assignmentId: row.assignmentId,
        participantId: row.participantId,
        participantProfileId: row.participantProfileId,
        displayName: displayName(row, row.participantProfileId),
        overlapStartedAt: row.overlapStartedAt,
        overlapEndedAt: row.overlapEndedAt,
      }),
    );
    grouped.set(row.workGroupId, members);
  }
  return grouped;
}

function validParticipantRow(row: ParticipantRow): boolean {
  return (
    uuid.test(row.participantId) &&
    uuid.test(row.participantProfileId) &&
    namesValid(row) &&
    validDate(row.participationStartedAt) &&
    validDate(row.participationEndedAt) &&
    row.participationEndedAt > row.participationStartedAt &&
    Array.isArray(row.verifiedProfessionCodes) &&
    row.verifiedProfessionCodes.length <= 32 &&
    row.verifiedProfessionCodes.every((code) => professionCode.test(code)) &&
    new Set(row.verifiedProfessionCodes).size ===
      row.verifiedProfessionCodes.length &&
    Array.isArray(row.verifiedRoles) &&
    row.verifiedRoles.length >= 1 &&
    row.verifiedRoles.length <= 4 &&
    row.verifiedRoles.every((role) => validRole(role)) &&
    row.verifiedRoles.includes("MEMBER") &&
    new Set(row.verifiedRoles).size === row.verifiedRoles.length
  );
}

function validWorkGroupRow(row: WorkGroupRow): boolean {
  return (
    uuid.test(row.workGroupId) &&
    typeof row.name === "string" &&
    row.name === row.name.trim() &&
    row.name.length >= 1 &&
    row.name.length <= 120 &&
    !control.test(row.name)
  );
}

function validWorkGroupMemberRow(row: WorkGroupMemberRow): boolean {
  return (
    uuid.test(row.workGroupId) &&
    uuid.test(row.assignmentId) &&
    uuid.test(row.participantId) &&
    uuid.test(row.participantProfileId) &&
    namesValid(row) &&
    validDate(row.overlapStartedAt) &&
    validDate(row.overlapEndedAt) &&
    row.overlapEndedAt > row.overlapStartedAt
  );
}

function namesValid(value: {
  readonly nickname: string | null;
  readonly realFirstName: string | null;
  readonly realLastName: string | null;
}): boolean {
  return [value.nickname, value.realFirstName, value.realLastName].every(
    (item) => item === null || typeof item === "string",
  );
}

function displayName(
  value: {
    readonly nickname: string | null;
    readonly realFirstName: string | null;
    readonly realLastName: string | null;
  },
  profileId: string,
): string {
  return (
    value.nickname?.trim() ||
    (value.realFirstName?.trim() && value.realLastName?.trim()
      ? `${value.realFirstName.trim()} ${value.realLastName.trim()}`
      : `Remeselník ${profileId.slice(0, 8)}`)
  );
}

function validateSubmit(input: SubmitJobContextReviewInput): void {
  validIds(input.actorUserId, input.jobId, input.targetId, input.commandId);
  if (!validTargetKind(input.targetKind))
    throw new TypeError("Invalid Job context review target kind.");
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0)
    throw new TypeError("Invalid Job context review expected version.");
  if (!plainObject(input.ratings))
    throw new TypeError("Invalid Job context review ratings.");
  normalizeRatings(input.targetKind, input.ratings);
  normalizeComment(input.comment);
}

function normalizeRatings(
  targetKind: JobContextReviewTargetKind,
  value: unknown,
): Record<string, JobContextReviewRating> {
  if (!plainObject(value))
    throw new TypeError("Invalid Job context review ratings.");
  const expected =
    targetKind === "PARTICIPANT"
      ? participantReviewDimensions
      : workGroupReviewDimensions;
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => !expected.includes(key as never)) ||
    !expected.some((key) => value[key] !== null) ||
    Object.values(value).some(
      (rating) =>
        rating !== null &&
        (!Number.isInteger(rating) || Number(rating) < 1 || Number(rating) > 5),
    )
  )
    throw new TypeError("Exact substantive target-specific ratings required.");
  return Object.fromEntries(
    expected.map((key) => [key, value[key] as JobContextReviewRating]),
  );
}

function sameRatings(
  stored: unknown,
  requested: JobContextReviewRatings,
  targetKind: JobContextReviewTargetKind,
): boolean {
  try {
    return (
      JSON.stringify(normalizeRatings(targetKind, stored)) ===
      JSON.stringify(requested)
    );
  } catch {
    return false;
  }
}

function normalizeComment(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (!validComment(value))
    throw new TypeError("Invalid Job context review comment.");
  return value;
}

function validComment(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 2_000 &&
    value === value.trim() &&
    !control.test(value)
  );
}

function validRole(value: unknown): value is VerifiedJobParticipantRole {
  return (
    value === "MEMBER" ||
    value === "LEAD" ||
    value === "COORDINATOR" ||
    value === "SITE_MANAGER"
  );
}

function validTargetKind(value: unknown): value is JobContextReviewTargetKind {
  return value === "PARTICIPANT" || value === "WORK_GROUP";
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
    throw new TypeError("Invalid Job context review identity.");
}

function transaction<T>(
  sql: RootSql,
  callback: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return ("savepoint" in sql
    ? sql.savepoint(callback)
    : sql.begin(callback)) as unknown as Promise<T>;
}
