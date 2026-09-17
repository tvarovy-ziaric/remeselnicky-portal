import { createHash } from "node:crypto";

import type { Sql, TransactionSql } from "postgres";

type RootSql = Sql | TransactionSql;
type RoleDecision = "CONFIRM" | "REQUEST_CORRECTION";
type OperationalRole = "LEAD" | "COORDINATOR" | "SITE_MANAGER";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface PendingJobParticipantRoleAssignment {
  readonly assignmentEventId: string;
  readonly participantId: string;
  readonly role: OperationalRole;
  readonly assignedAt: Date;
}

export interface DecideJobParticipantRoleInput {
  readonly actorUserId: string;
  readonly commandId: string;
  readonly participantId: string;
  readonly assignmentEventId: string;
  readonly decision: RoleDecision;
  readonly reason?: string;
}

export type DecideJobParticipantRoleResult =
  | Readonly<{
      readonly status: "APPLIED" | "DEDUPLICATED";
      readonly decisionId: string;
      readonly decision: RoleDecision;
      readonly decidedAt: Date;
    }>
  | Readonly<{ readonly status: "NOT_FOUND" | "STALE_STATE" }>;

export class JobParticipantRoleDecisionIdempotencyError extends Error {}

interface ExistingDecision {
  readonly decisionId: string;
  readonly assignmentEventId: string;
  readonly actorUserId: string;
  readonly decision: RoleDecision;
  readonly reason: string | null;
  readonly payloadFingerprint: string;
  readonly decidedAt: Date;
}

export function createJobParticipantRoleDecisionRepository(sql: RootSql) {
  return Object.freeze({
    async listPending(input: {
      readonly actorUserId: string;
      readonly participantId: string;
    }): Promise<readonly PendingJobParticipantRoleAssignment[] | null> {
      validIds(input.actorUserId, input.participantId);
      return transaction(sql, async (tx) => {
        if (!(await authorizedParticipant(tx, input, true))) return null;
        const rows = await tx<PendingJobParticipantRoleAssignment[]>`
          SELECT assignment.event_id AS "assignmentEventId",
            assignment.participant_id AS "participantId",
            assignment.role::text AS role,
            assignment.recorded_at AS "assignedAt"
          FROM job_participant_role_events assignment
          JOIN job_participant_role_intervals role_interval
            ON role_interval.assignment_event_id = assignment.event_id
            AND role_interval.active
          LEFT JOIN job_participant_role_decisions decision
            ON decision.assignment_event_id = assignment.event_id
          WHERE assignment.participant_id = ${input.participantId}
            AND assignment.action = 'ASSIGN'
            AND decision.decision_id IS NULL
          ORDER BY assignment.recorded_at, assignment.event_id
        `;
        return Object.freeze(rows.map(validatePending));
      });
    },

    async decide(
      input: DecideJobParticipantRoleInput,
    ): Promise<DecideJobParticipantRoleResult> {
      validateDecision(input);
      const reason = input.reason?.trim() ?? null;
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify({
            actorUserId: input.actorUserId,
            participantId: input.participantId,
            assignmentEventId: input.assignmentEventId,
            decision: input.decision,
            reason,
          }),
        )
        .digest("hex");
      return transaction(sql, async (tx) => {
        await tx`
          SELECT pg_advisory_xact_lock(hashtextextended(${input.commandId}::text, 51010))
        `;
        const [participant] = await tx<Array<{ jobId: string }>>`
          SELECT job_id AS "jobId" FROM job_participants
          WHERE id = ${input.participantId}
        `;
        if (participant === undefined) return { status: "NOT_FOUND" };
        await tx`SELECT id FROM jobs WHERE id = ${participant.jobId} FOR UPDATE`;
        const [assignment] = await tx<
          Array<{
            participantId: string;
            actorUserId: string;
          }>
        >`
          SELECT participant_id AS "participantId",
            actor_user_id AS "actorUserId"
          FROM job_participant_role_events
          WHERE event_id = ${input.assignmentEventId}
            AND action = 'ASSIGN'
          FOR UPDATE
        `;
        if (assignment?.participantId !== input.participantId)
          return { status: "NOT_FOUND" };
        if (!(await authorizedParticipant(tx, input, false)))
          return { status: "NOT_FOUND" };
        const [existing] = await tx<ExistingDecision[]>`
          SELECT decision_id AS "decisionId",
            assignment_event_id AS "assignmentEventId",
            actor_user_id AS "actorUserId",
            decision_kind::text AS decision, reason,
            payload_fingerprint AS "payloadFingerprint",
            decided_at AS "decidedAt"
          FROM job_participant_role_decisions
          WHERE decision_id = ${input.commandId}
        `;
        if (existing !== undefined) {
          if (existing.actorUserId !== input.actorUserId)
            return { status: "NOT_FOUND" };
          if (
            existing.assignmentEventId !== input.assignmentEventId ||
            existing.decision !== input.decision ||
            existing.reason !== reason ||
            existing.payloadFingerprint !== fingerprint
          )
            throw new JobParticipantRoleDecisionIdempotencyError(
              "Job participant role decision command ID was reused.",
            );
          return Object.freeze({
            status: "DEDUPLICATED" as const,
            decisionId: input.commandId,
            decision: existing.decision,
            decidedAt: existing.decidedAt,
          });
        }
        const [current] = await tx<Array<{ active: boolean }>>`
          SELECT role_interval.active
          FROM job_participant_role_intervals role_interval
          WHERE role_interval.assignment_event_id = ${input.assignmentEventId}
            AND role_interval.participant_id = ${input.participantId}
        `;
        if (current?.active !== true) return { status: "STALE_STATE" };
        if (
          input.decision === "CONFIRM" &&
          assignment.actorUserId === input.actorUserId
        )
          return { status: "STALE_STATE" };
        const [previous] = await tx<Array<{ decisionId: string }>>`
          SELECT decision_id AS "decisionId"
          FROM job_participant_role_decisions
          WHERE assignment_event_id = ${input.assignmentEventId}
        `;
        if (previous !== undefined) return { status: "STALE_STATE" };
        const [created] = await tx<Array<{ decidedAt: Date }>>`
          INSERT INTO job_participant_role_decisions (
            decision_id, assignment_event_id, actor_user_id,
            decision_kind, reason, payload_fingerprint
          ) VALUES (
            ${input.commandId}, ${input.assignmentEventId},
            ${input.actorUserId}, ${input.decision}, ${reason}, ${fingerprint}
          ) RETURNING decided_at AS "decidedAt"
        `;
        if (created === undefined)
          throw new Error("Job participant role decision effect missing.");
        return Object.freeze({
          status: "APPLIED" as const,
          decisionId: input.commandId,
          decision: input.decision,
          decidedAt: created.decidedAt,
        });
      });
    },
  });
}

async function authorizedParticipant(
  tx: TransactionSql,
  input: { readonly actorUserId: string; readonly participantId: string },
  requireActive: boolean,
): Promise<boolean> {
  const [row] = await tx<Array<{ id: string }>>`
    SELECT participant.id FROM job_participants participant
    JOIN craftsman_profiles profile
      ON profile.id = participant.craftsman_profile_id
      AND profile.profile_type = 'INDIVIDUAL'
      AND profile.owner_user_id = ${input.actorUserId}
    JOIN users actor ON actor.id = profile.owner_user_id
      AND actor.account_state = 'ACTIVE'
    JOIN auth_credentials credential ON credential.user_id = actor.id
      AND credential.email_verified_at IS NOT NULL
      AND credential.phone_verified_at IS NOT NULL
    LEFT JOIN current_job_participants current
      ON current.id = participant.id
    LEFT JOIN current_job_states state ON state.job_id = participant.job_id
    WHERE participant.id = ${input.participantId}
      AND (NOT ${requireActive}::boolean OR (
        current.state = 'ACCEPTED'
        AND current.verified_participation
        AND state.state IN ('CONFIRMED', 'IN_PROGRESS')
      ))
  `;
  return row !== undefined;
}

function validatePending(
  row: PendingJobParticipantRoleAssignment,
): PendingJobParticipantRoleAssignment {
  if (
    !uuid.test(row.assignmentEventId) ||
    !uuid.test(row.participantId) ||
    !["LEAD", "COORDINATOR", "SITE_MANAGER"].includes(row.role) ||
    !(row.assignedAt instanceof Date) ||
    !Number.isFinite(row.assignedAt.getTime())
  )
    throw new Error("Invalid pending Job participant role provenance.");
  return Object.freeze({ ...row });
}

function validIds(...ids: string[]): void {
  if (!ids.every((id) => typeof id === "string" && uuid.test(id)))
    throw new TypeError("Invalid Job participant role request.");
}

function validateDecision(input: DecideJobParticipantRoleInput): void {
  validIds(
    input.actorUserId,
    input.commandId,
    input.participantId,
    input.assignmentEventId,
  );
  if (!["CONFIRM", "REQUEST_CORRECTION"].includes(input.decision))
    throw new TypeError("Invalid Job participant role decision.");
  if (input.reason !== undefined && typeof input.reason !== "string")
    throw new TypeError("Invalid Job participant role reason.");
  const reason = input.reason?.trim() ?? null;
  if (
    (input.decision === "CONFIRM" && reason !== null) ||
    (input.decision === "REQUEST_CORRECTION" &&
      (reason === null ||
        reason.length < 8 ||
        reason.length > 500 ||
        /[\p{Cc}]/u.test(reason)))
  )
    throw new TypeError("Invalid Job participant role reason.");
}

function transaction<T>(
  sql: RootSql,
  callback: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return ("savepoint" in sql
    ? sql.savepoint(callback)
    : sql.begin(callback)) as unknown as Promise<T>;
}
