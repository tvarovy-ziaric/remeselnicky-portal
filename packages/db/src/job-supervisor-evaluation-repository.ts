import type { Sql, TransactionSql } from "postgres";

type RootSql = Sql | TransactionSql;

export type JobSupervisorRelationshipKind =
  "PRIMARY_CONTRACTOR" | "LEAD" | "COORDINATOR" | "SITE_MANAGER";
export type JobSupervisorEvaluationRating = 1 | 2 | 3 | 4 | 5 | null;
export type JobSupervisorEvaluationRatings = Readonly<
  Record<string, JobSupervisorEvaluationRating>
>;
export type JobSupervisorTargetRole =
  "MEMBER" | "LEAD" | "COORDINATOR" | "SITE_MANAGER";

export const jobSupervisorEvaluationDimensions = Object.freeze([
  "competence_quality",
  "reliability",
  "independence",
  "productivity",
  "collaboration",
  "problem_solving",
  "would_take_into_crew_again",
] as const);

export interface JobSupervisorEvaluationContent {
  readonly evaluationId: string;
  readonly revisionId: string;
  readonly version: number;
  readonly submittedAt: Date;
  readonly revisedAt: Date;
  readonly editDeadline: Date;
  readonly ratings: JobSupervisorEvaluationRatings;
  readonly comment: string | null;
}

export interface JobSupervisorEvaluationTarget {
  readonly targetParticipantId: string;
  readonly targetProfileId: string;
  readonly displayName: string;
  readonly relationshipKind: JobSupervisorRelationshipKind;
  readonly overlapStartedAt: Date;
  readonly overlapEndedAt: Date;
  readonly verifiedProfessionCodes: readonly string[];
  readonly verifiedRoles: readonly JobSupervisorTargetRole[];
  readonly evaluation: JobSupervisorEvaluationContent | null;
}

export interface JobSupervisorEvaluationPage {
  readonly jobId: string;
  readonly completedAt: Date;
  readonly submissionDeadline: Date;
  readonly targets: readonly JobSupervisorEvaluationTarget[];
}

export interface ReceivedJobSupervisorEvaluation {
  readonly evaluationId: string;
  readonly jobId: string;
  readonly targetParticipantId: string;
  readonly targetProfileId: string;
  readonly evaluatorDisplayName: string;
  readonly relationshipKind: JobSupervisorRelationshipKind;
  readonly overlapStartedAt: Date;
  readonly overlapEndedAt: Date;
  readonly verifiedProfessionCodes: readonly string[];
  readonly verifiedRoles: readonly JobSupervisorTargetRole[];
  readonly content: JobSupervisorEvaluationContent;
}

export interface ReceivedJobSupervisorEvaluationPage {
  readonly jobId: string;
  readonly evaluations: readonly ReceivedJobSupervisorEvaluation[];
}

export type JobSupervisorEvaluationDetail = ReceivedJobSupervisorEvaluation;

export interface SubmitJobSupervisorEvaluationInput {
  readonly actorUserId: string;
  readonly commandId: string;
  readonly expectedVersion: number;
  readonly jobId: string;
  readonly targetParticipantId: string;
  readonly ratings: JobSupervisorEvaluationRatings;
  readonly comment?: string | null;
}

export type SubmitJobSupervisorEvaluationResult =
  | Readonly<{
      readonly status: "APPLIED" | "DEDUPLICATED";
      readonly evaluationId: string;
      readonly revisionId: string;
      readonly version: number;
      readonly recordedAt: Date;
    }>
  | Readonly<{
      readonly status:
        "NOT_FOUND" | "WINDOW_CLOSED" | "EDIT_LOCKED" | "STALE_VERSION";
    }>;

export class JobSupervisorEvaluationIdempotencyError extends Error {}

interface OpportunityRow {
  readonly targetProfileId: string;
  readonly relationshipKind: string;
  readonly evaluatorParticipantId: string | null;
  readonly evaluatorRoleAssignmentEventId: string | null;
  readonly sharedWorkGroupId: string | null;
  readonly overlapStartedAt: Date;
  readonly overlapEndedAt: Date;
  readonly completionDecisionId: string;
  readonly completedAt: Date;
  readonly submissionDeadline: Date;
  readonly nowAt: Date;
}

interface TargetRow {
  readonly targetParticipantId: string;
  readonly targetProfileId: string;
  readonly nickname: string | null;
  readonly realFirstName: string | null;
  readonly realLastName: string | null;
  readonly relationshipKind: string;
  readonly overlapStartedAt: Date;
  readonly overlapEndedAt: Date;
  readonly verifiedProfessionCodes: string[];
  readonly verifiedRoles: string[];
  readonly evaluationId: string | null;
  readonly revisionId: string | null;
  readonly version: number | null;
  readonly submittedAt: Date | null;
  readonly revisedAt: Date | null;
  readonly editDeadline: Date | null;
  readonly ratings: unknown;
  readonly comment: string | null;
}

interface DetailRow {
  readonly evaluationId: string;
  readonly jobId: string;
  readonly targetParticipantId: string;
  readonly targetProfileId: string;
  readonly evaluatorNickname: string | null;
  readonly evaluatorFirstName: string | null;
  readonly evaluatorLastName: string | null;
  readonly evaluatorCompanyName: string | null;
  readonly relationshipKind: string;
  readonly overlapStartedAt: Date;
  readonly overlapEndedAt: Date;
  readonly verifiedProfessionCodes: string[];
  readonly verifiedRoles: string[];
  readonly revisionId: string;
  readonly version: number;
  readonly submittedAt: Date;
  readonly revisedAt: Date;
  readonly editDeadline: Date;
  readonly ratings: unknown;
  readonly comment: string | null;
}

interface ExistingRevisionRow {
  readonly evaluatorUserId: string;
  readonly evaluationId: string;
  readonly jobId: string;
  readonly targetParticipantId: string;
  readonly version: number;
  readonly ratings: unknown;
  readonly comment: string | null;
  readonly recordedAt: Date;
}

interface EvaluationStateRow {
  readonly evaluationId: string;
  readonly latestVersion: number;
  readonly firstAt: Date;
}

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const professionCode = /^(?:PROF|TEST):[A-Z0-9][A-Z0-9_]{1,62}$/u;
const control = /[\p{Cc}]/u;

export function createJobSupervisorEvaluationRepository(sql: RootSql) {
  async function getForEvaluator(input: {
    readonly actorUserId: string;
    readonly jobId: string;
  }): Promise<JobSupervisorEvaluationPage | null> {
    validIds(input.actorUserId, input.jobId);
    return transaction(sql, async (tx) => {
      const [scope] = await tx<
        Array<{
          readonly completedAt: Date;
          readonly submissionDeadline: Date;
        }>
      >`
        SELECT min(opportunity.completed_at) AS "completedAt",
          min(opportunity.submission_deadline) AS "submissionDeadline"
        FROM job_supervisor_evaluation_opportunities opportunity
        JOIN users actor ON actor.id = opportunity.evaluator_user_id
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
        throw new Error("Invalid supervisor evaluation scope provenance.");

      const rows = await tx<TargetRow[]>`
        SELECT opportunity.target_participant_id AS "targetParticipantId",
          opportunity.target_profile_id AS "targetProfileId",
          target.nickname, target.real_first_name AS "realFirstName",
          target.real_last_name AS "realLastName",
          opportunity.relationship_kind::text AS "relationshipKind",
          opportunity.overlap_started_at AS "overlapStartedAt",
          opportunity.overlap_ended_at AS "overlapEndedAt",
          ARRAY(
            SELECT DISTINCT capability.profession_code
            FROM verified_completed_job_capabilities capability
            WHERE capability.job_id = opportunity.job_id
              AND capability.participant_id = opportunity.target_participant_id
              AND capability.kind = 'PROFESSION'
            ORDER BY capability.profession_code
          ) AS "verifiedProfessionCodes",
          ARRAY(
            SELECT DISTINCT role.role
            FROM verified_completed_job_roles role
            WHERE role.job_id = opportunity.job_id
              AND role.participant_id = opportunity.target_participant_id
            ORDER BY role.role
          ) AS "verifiedRoles",
          evaluation.evaluation_id AS "evaluationId",
          evaluation.revision_id AS "revisionId", evaluation.version,
          evaluation.submitted_at AS "submittedAt",
          evaluation.revised_at AS "revisedAt",
          evaluation.edit_deadline AS "editDeadline",
          evaluation.ratings, evaluation.comment
        FROM job_supervisor_evaluation_opportunities opportunity
        JOIN craftsman_profiles target
          ON target.id = opportunity.target_profile_id
        LEFT JOIN current_job_supervisor_evaluations evaluation
          ON evaluation.job_id = opportunity.job_id
          AND evaluation.evaluator_user_id = opportunity.evaluator_user_id
          AND evaluation.target_participant_id =
            opportunity.target_participant_id
        WHERE opportunity.job_id = ${input.jobId}
          AND opportunity.evaluator_user_id = ${input.actorUserId}
        ORDER BY opportunity.target_participant_id
      `;
      return Object.freeze({
        jobId: input.jobId,
        completedAt: scope.completedAt,
        submissionDeadline: scope.submissionDeadline,
        targets: Object.freeze(rows.map(projectTarget)),
      });
    });
  }

  async function getReceivedForTarget(input: {
    readonly actorUserId: string;
    readonly jobId: string;
  }): Promise<ReceivedJobSupervisorEvaluationPage | null> {
    validIds(input.actorUserId, input.jobId);
    const rows = await selectDetails(sql, {
      actorUserId: input.actorUserId,
      jobId: input.jobId,
      evaluationId: null,
      requireTarget: true,
    });
    if (rows.length === 0) return null;
    return Object.freeze({
      jobId: input.jobId,
      evaluations: Object.freeze(rows.map(projectDetail)),
    });
  }

  async function getById(input: {
    readonly actorUserId: string;
    readonly jobId: string;
    readonly evaluationId: string;
  }): Promise<JobSupervisorEvaluationDetail | null> {
    validIds(input.actorUserId, input.jobId, input.evaluationId);
    const rows = await selectDetails(sql, {
      actorUserId: input.actorUserId,
      jobId: input.jobId,
      evaluationId: input.evaluationId,
      requireTarget: false,
    });
    if (rows.length === 0) return null;
    if (rows.length !== 1)
      throw new Error("Duplicate supervisor evaluation detail.");
    return projectDetail(rows[0]!);
  }

  async function submit(
    input: SubmitJobSupervisorEvaluationInput,
  ): Promise<SubmitJobSupervisorEvaluationResult> {
    validateSubmit(input);
    const ratings = normalizeRatings(input.ratings);
    const comment = normalizeComment(input.comment);
    return transaction(sql, async (tx) => {
      await tx`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${input.commandId}::text, 519019)
        )
      `;
      const [locked] = await tx<Array<{ readonly id: string }>>`
        SELECT id FROM jobs WHERE id = ${input.jobId} FOR UPDATE
      `;
      if (locked === undefined) return { status: "NOT_FOUND" };

      const [opportunity] = await tx<OpportunityRow[]>`
        SELECT opportunity.target_profile_id AS "targetProfileId",
          opportunity.relationship_kind::text AS "relationshipKind",
          opportunity.evaluator_participant_id AS "evaluatorParticipantId",
          opportunity.evaluator_role_assignment_event_id
            AS "evaluatorRoleAssignmentEventId",
          opportunity.shared_work_group_id AS "sharedWorkGroupId",
          opportunity.overlap_started_at AS "overlapStartedAt",
          opportunity.overlap_ended_at AS "overlapEndedAt",
          opportunity.completion_decision_id AS "completionDecisionId",
          opportunity.completed_at AS "completedAt",
          opportunity.submission_deadline AS "submissionDeadline",
          clock_timestamp() AS "nowAt"
        FROM job_supervisor_evaluation_opportunities opportunity
        JOIN users actor ON actor.id = opportunity.evaluator_user_id
          AND actor.id = ${input.actorUserId}
          AND actor.account_state = 'ACTIVE'
        JOIN auth_credentials credential ON credential.user_id = actor.id
          AND credential.email_verified_at IS NOT NULL
          AND credential.phone_verified_at IS NOT NULL
        WHERE opportunity.job_id = ${input.jobId}
          AND opportunity.target_participant_id = ${input.targetParticipantId}
      `;
      if (opportunity === undefined) return { status: "NOT_FOUND" };
      if (!validOpportunity(opportunity))
        throw new Error(
          "Invalid supervisor evaluation opportunity provenance.",
        );

      const [existing] = await tx<ExistingRevisionRow[]>`
        SELECT evaluation.evaluator_user_id AS "evaluatorUserId",
          evaluation.evaluation_id AS "evaluationId",
          evaluation.job_id AS "jobId",
          evaluation.target_participant_id AS "targetParticipantId",
          revision.version, revision.ratings, revision.comment,
          revision.recorded_at AS "recordedAt"
        FROM job_supervisor_evaluation_revisions revision
        JOIN job_supervisor_evaluations evaluation
          ON evaluation.evaluation_id = revision.evaluation_id
        WHERE revision.event_id = ${input.commandId}
      `;
      if (existing !== undefined) {
        if (existing.evaluatorUserId !== input.actorUserId)
          return { status: "NOT_FOUND" };
        if (
          existing.jobId !== input.jobId ||
          existing.targetParticipantId !== input.targetParticipantId ||
          existing.version !== input.expectedVersion + 1 ||
          existing.comment !== comment ||
          !sameRatings(existing.ratings, ratings)
        )
          throw new JobSupervisorEvaluationIdempotencyError(
            "Supervisor evaluation command ID was reused for another intent.",
          );
        return Object.freeze({
          status: "DEDUPLICATED" as const,
          evaluationId: existing.evaluationId,
          revisionId: input.commandId,
          version: existing.version,
          recordedAt: existing.recordedAt,
        });
      }

      const [state] = await tx<EvaluationStateRow[]>`
        SELECT evaluation.evaluation_id AS "evaluationId",
          max(revision.version)::integer AS "latestVersion",
          min(revision.recorded_at) AS "firstAt"
        FROM job_supervisor_evaluations evaluation
        JOIN job_supervisor_evaluation_revisions revision
          ON revision.evaluation_id = evaluation.evaluation_id
        WHERE evaluation.job_id = ${input.jobId}
          AND evaluation.evaluator_user_id = ${input.actorUserId}
          AND evaluation.target_participant_id = ${input.targetParticipantId}
        GROUP BY evaluation.evaluation_id
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

      const evaluationId = state?.evaluationId ?? input.commandId;
      if (state === undefined) {
        await tx`
          INSERT INTO job_supervisor_evaluations (
            evaluation_id, create_command_id, job_id,
            target_participant_id, target_profile_id, evaluator_user_id,
            relationship_kind, evaluator_participant_id,
            evaluator_role_assignment_event_id, shared_work_group_id,
            overlap_started_at, overlap_ended_at,
            completion_decision_id, completed_at, submission_deadline
          ) VALUES (
            ${evaluationId}, ${input.commandId}, ${input.jobId},
            ${input.targetParticipantId}, ${opportunity.targetProfileId},
            ${input.actorUserId},
            ${opportunity.relationshipKind}::job_supervisor_relationship_kind,
            ${opportunity.evaluatorParticipantId},
            ${opportunity.evaluatorRoleAssignmentEventId},
            ${opportunity.sharedWorkGroupId}, ${opportunity.overlapStartedAt},
            ${opportunity.overlapEndedAt},
            ${opportunity.completionDecisionId}, ${opportunity.completedAt},
            ${opportunity.submissionDeadline}
          )
        `;
      }
      const version = input.expectedVersion + 1;
      const [inserted] = await tx<Array<{ readonly recordedAt: Date }>>`
        INSERT INTO job_supervisor_evaluation_revisions (
          event_id, evaluation_id, version, actor_user_id, ratings, comment
        ) VALUES (
          ${input.commandId}, ${evaluationId}, ${version},
          ${input.actorUserId}, ${tx.json(ratings)}, ${comment}
        ) RETURNING recorded_at AS "recordedAt"
      `;
      if (inserted === undefined || !validDate(inserted.recordedAt))
        throw new Error("Supervisor evaluation revision effect missing.");
      return Object.freeze({
        status: "APPLIED" as const,
        evaluationId,
        revisionId: input.commandId,
        version,
        recordedAt: inserted.recordedAt,
      });
    });
  }

  return Object.freeze({
    getForEvaluator,
    getReceivedForTarget,
    getById,
    submit,
  });
}

export type JobSupervisorEvaluationRepository = ReturnType<
  typeof createJobSupervisorEvaluationRepository
>;

async function selectDetails(
  sql: RootSql,
  input: {
    readonly actorUserId: string;
    readonly jobId: string;
    readonly evaluationId: string | null;
    readonly requireTarget: boolean;
  },
): Promise<DetailRow[]> {
  return sql<DetailRow[]>`
    SELECT evaluation.evaluation_id AS "evaluationId",
      evaluation.job_id AS "jobId",
      evaluation.target_participant_id AS "targetParticipantId",
      evaluation.target_profile_id AS "targetProfileId",
      evaluator.nickname AS "evaluatorNickname",
      evaluator.real_first_name AS "evaluatorFirstName",
      evaluator.real_last_name AS "evaluatorLastName",
      evaluator.official_company_name AS "evaluatorCompanyName",
      evaluation.relationship_kind::text AS "relationshipKind",
      evaluation.overlap_started_at AS "overlapStartedAt",
      evaluation.overlap_ended_at AS "overlapEndedAt",
      ARRAY(
        SELECT DISTINCT snapshot.profession_code
        FROM job_supervisor_evaluation_profession_snapshots snapshot
        WHERE snapshot.evaluation_id = evaluation.evaluation_id
        ORDER BY snapshot.profession_code
      ) AS "verifiedProfessionCodes",
      ARRAY(
        SELECT DISTINCT snapshot.role
        FROM job_supervisor_evaluation_role_snapshots snapshot
        WHERE snapshot.evaluation_id = evaluation.evaluation_id
        ORDER BY snapshot.role
      ) AS "verifiedRoles",
      evaluation.revision_id AS "revisionId", evaluation.version,
      evaluation.submitted_at AS "submittedAt",
      evaluation.revised_at AS "revisedAt",
      evaluation.edit_deadline AS "editDeadline",
      evaluation.ratings, evaluation.comment
    FROM current_job_supervisor_evaluations evaluation
    JOIN craftsman_profiles target ON target.id = evaluation.target_profile_id
    JOIN users viewer ON viewer.id = ${input.actorUserId}
      AND viewer.account_state = 'ACTIVE'
    JOIN auth_credentials credential ON credential.user_id = viewer.id
      AND credential.email_verified_at IS NOT NULL
      AND credential.phone_verified_at IS NOT NULL
    JOIN craftsman_profiles evaluator
      ON evaluator.owner_user_id = evaluation.evaluator_user_id
    WHERE evaluation.job_id = ${input.jobId}
      AND (${input.evaluationId}::uuid IS NULL
        OR evaluation.evaluation_id = ${input.evaluationId})
      AND ((${input.requireTarget} AND target.owner_user_id = viewer.id)
        OR (NOT ${input.requireTarget} AND
          (target.owner_user_id = viewer.id
            OR evaluation.evaluator_user_id = viewer.id)))
    ORDER BY evaluation.submitted_at DESC, evaluation.evaluation_id
  `;
}

function projectTarget(row: TargetRow): JobSupervisorEvaluationTarget {
  if (
    !uuid.test(row.targetParticipantId) ||
    !uuid.test(row.targetProfileId) ||
    !validRelationship(row.relationshipKind) ||
    !validDate(row.overlapStartedAt) ||
    !validDate(row.overlapEndedAt) ||
    row.overlapEndedAt <= row.overlapStartedAt ||
    !validProfessions(row.verifiedProfessionCodes) ||
    !validRoles(row.verifiedRoles)
  )
    throw new Error("Invalid supervisor evaluation target provenance.");
  return Object.freeze({
    targetParticipantId: row.targetParticipantId,
    targetProfileId: row.targetProfileId,
    displayName: individualDisplayName(row),
    relationshipKind: row.relationshipKind,
    overlapStartedAt: row.overlapStartedAt,
    overlapEndedAt: row.overlapEndedAt,
    verifiedProfessionCodes: Object.freeze([...row.verifiedProfessionCodes]),
    verifiedRoles: Object.freeze([...row.verifiedRoles]),
    evaluation: projectContent(row),
  });
}

function projectDetail(row: DetailRow): ReceivedJobSupervisorEvaluation {
  if (
    !uuid.test(row.evaluationId) ||
    !uuid.test(row.jobId) ||
    !uuid.test(row.targetParticipantId) ||
    !uuid.test(row.targetProfileId) ||
    !validRelationship(row.relationshipKind) ||
    !validDate(row.overlapStartedAt) ||
    !validDate(row.overlapEndedAt) ||
    row.overlapEndedAt <= row.overlapStartedAt ||
    !validProfessions(row.verifiedProfessionCodes) ||
    !validRoles(row.verifiedRoles)
  )
    throw new Error("Invalid received supervisor evaluation provenance.");
  const content = projectContent({ ...row, evaluationId: row.evaluationId });
  if (content === null)
    throw new Error("Received supervisor evaluation content missing.");
  return Object.freeze({
    evaluationId: row.evaluationId,
    jobId: row.jobId,
    targetParticipantId: row.targetParticipantId,
    targetProfileId: row.targetProfileId,
    evaluatorDisplayName: evaluatorDisplayName(row),
    relationshipKind: row.relationshipKind,
    overlapStartedAt: row.overlapStartedAt,
    overlapEndedAt: row.overlapEndedAt,
    verifiedProfessionCodes: Object.freeze([...row.verifiedProfessionCodes]),
    verifiedRoles: Object.freeze([...row.verifiedRoles]),
    content,
  });
}

function projectContent(row: {
  readonly evaluationId: string | null;
  readonly revisionId: string | null;
  readonly version: number | null;
  readonly submittedAt: Date | null;
  readonly revisedAt: Date | null;
  readonly editDeadline: Date | null;
  readonly ratings: unknown;
  readonly comment: string | null;
}): JobSupervisorEvaluationContent | null {
  if (
    row.evaluationId === null &&
    row.revisionId === null &&
    row.version === null &&
    row.submittedAt === null &&
    row.revisedAt === null &&
    row.editDeadline === null &&
    row.ratings === null &&
    row.comment === null
  )
    return null;
  if (
    typeof row.evaluationId !== "string" ||
    !uuid.test(row.evaluationId) ||
    typeof row.revisionId !== "string" ||
    !uuid.test(row.revisionId) ||
    !Number.isSafeInteger(row.version) ||
    (row.version ?? 0) < 1 ||
    !validDate(row.submittedAt) ||
    !validDate(row.revisedAt) ||
    !validDate(row.editDeadline) ||
    row.revisedAt < row.submittedAt ||
    row.editDeadline <= row.submittedAt ||
    !validComment(row.comment)
  )
    throw new Error("Invalid supervisor evaluation content.");
  return Object.freeze({
    evaluationId: row.evaluationId,
    revisionId: row.revisionId,
    version: row.version as number,
    submittedAt: row.submittedAt,
    revisedAt: row.revisedAt,
    editDeadline: row.editDeadline,
    ratings: normalizeRatings(row.ratings),
    comment: row.comment,
  });
}

function validateSubmit(input: SubmitJobSupervisorEvaluationInput): void {
  validIds(
    input.actorUserId,
    input.commandId,
    input.jobId,
    input.targetParticipantId,
  );
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0)
    throw new TypeError("Invalid supervisor evaluation expected version.");
  normalizeRatings(input.ratings);
  normalizeComment(input.comment);
}

function normalizeRatings(value: unknown): JobSupervisorEvaluationRatings {
  if (!plainObject(value)) throw new TypeError("Invalid supervisor ratings.");
  const keys = Object.keys(value);
  if (
    keys.length !== jobSupervisorEvaluationDimensions.length ||
    keys.some(
      (key) =>
        !jobSupervisorEvaluationDimensions.includes(
          key as (typeof jobSupervisorEvaluationDimensions)[number],
        ),
    )
  )
    throw new TypeError("Invalid supervisor rating dimensions.");
  const result: Record<string, JobSupervisorEvaluationRating> = {};
  let substantive = false;
  for (const key of jobSupervisorEvaluationDimensions) {
    const rating = value[key];
    if (rating !== null && ![1, 2, 3, 4, 5].includes(rating as number))
      throw new TypeError("Invalid supervisor rating value.");
    if (rating !== null) substantive = true;
    result[key] = rating as JobSupervisorEvaluationRating;
  }
  if (!substantive)
    throw new TypeError("Supervisor ratings cannot all be N/A.");
  return Object.freeze(result);
}

function sameRatings(
  left: unknown,
  right: JobSupervisorEvaluationRatings,
): boolean {
  try {
    const normalized = normalizeRatings(left);
    return jobSupervisorEvaluationDimensions.every(
      (key) => normalized[key] === right[key],
    );
  } catch {
    return false;
  }
}

function normalizeComment(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (!validComment(value) || value.length === 0)
    throw new TypeError("Invalid supervisor evaluation comment.");
  return value;
}

function validComment(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" &&
      value === value.trim() &&
      value.length >= 1 &&
      value.length <= 2000 &&
      !control.test(value))
  );
}

function validOpportunity(row: OpportunityRow): boolean {
  return (
    uuid.test(row.targetProfileId) &&
    validRelationship(row.relationshipKind) &&
    (row.evaluatorParticipantId === null ||
      uuid.test(row.evaluatorParticipantId)) &&
    (row.evaluatorRoleAssignmentEventId === null ||
      uuid.test(row.evaluatorRoleAssignmentEventId)) &&
    (row.sharedWorkGroupId === null || uuid.test(row.sharedWorkGroupId)) &&
    uuid.test(row.completionDecisionId) &&
    validDate(row.overlapStartedAt) &&
    validDate(row.overlapEndedAt) &&
    row.overlapEndedAt > row.overlapStartedAt &&
    validDate(row.completedAt) &&
    validDate(row.submissionDeadline) &&
    row.submissionDeadline > row.completedAt &&
    validDate(row.nowAt)
  );
}

function validRelationship(
  value: unknown,
): value is JobSupervisorRelationshipKind {
  return (
    value === "PRIMARY_CONTRACTOR" ||
    value === "LEAD" ||
    value === "COORDINATOR" ||
    value === "SITE_MANAGER"
  );
}

function validProfessions(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) => typeof item === "string" && professionCode.test(item),
    ) &&
    new Set(value).size === value.length
  );
}

function validRoles(value: unknown): value is JobSupervisorTargetRole[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        item === "MEMBER" ||
        item === "LEAD" ||
        item === "COORDINATOR" ||
        item === "SITE_MANAGER",
    ) &&
    new Set(value).size === value.length
  );
}

function individualDisplayName(row: {
  readonly nickname: string | null;
  readonly realFirstName: string | null;
  readonly realLastName: string | null;
}): string {
  if (safeName(row.nickname)) return row.nickname;
  const full = [row.realFirstName, row.realLastName]
    .filter((value): value is string => safeName(value))
    .join(" ");
  return full.length > 0 ? full : "Remeselník";
}

function evaluatorDisplayName(row: DetailRow): string {
  if (safeName(row.evaluatorCompanyName)) return row.evaluatorCompanyName;
  if (safeName(row.evaluatorNickname)) return row.evaluatorNickname;
  const full = [row.evaluatorFirstName, row.evaluatorLastName]
    .filter((value): value is string => safeName(value))
    .join(" ");
  return full.length > 0 ? full : "Remeselník";
}

function safeName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length > 0 &&
    value.length <= 200 &&
    !control.test(value)
  );
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validIds(...values: string[]): void {
  if (values.some((value) => !uuid.test(value)))
    throw new TypeError("Invalid supervisor evaluation identifier.");
}

function transaction<T>(
  sql: RootSql,
  callback: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return ("savepoint" in sql
    ? callback(sql)
    : sql.begin(callback)) as unknown as Promise<T>;
}
