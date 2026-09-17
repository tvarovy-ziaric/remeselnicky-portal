import { createHash, randomUUID } from "node:crypto";

import type { Sql, TransactionSql } from "postgres";

type RootSql = Sql | TransactionSql;
type Decision = "ACCEPT" | "DECLINE" | "LEAVE" | "REMOVE";
type OperationalRole = "LEAD" | "COORDINATOR" | "SITE_MANAGER";
type RoleAction = "ASSIGN" | "REVOKE";
type ParticipationState =
  "INVITED" | "ACCEPTED" | "DECLINED" | "LEFT" | "REMOVED";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface InviteJobParticipantInput {
  readonly actorUserId: string;
  readonly commandId: string;
  readonly jobId: string;
  readonly craftsmanProfileId: string;
}

export interface DecideJobParticipationInput {
  readonly actorUserId: string;
  readonly commandId: string;
  readonly participantId: string;
  readonly decision: Decision;
  readonly reason?: string;
}

export interface ChangeJobParticipantRoleInput {
  readonly actorUserId: string;
  readonly commandId: string;
  readonly participantId: string;
  readonly role: OperationalRole;
  readonly action: RoleAction;
}

export type ChangeJobParticipantRoleResult =
  | Readonly<{
      readonly status: "APPLIED" | "DEDUPLICATED";
      readonly role: OperationalRole;
      readonly active: boolean;
      readonly recordedAt: Date;
    }>
  | Readonly<{ readonly status: "NOT_FOUND" | "STALE_STATE" }>;

export interface JobParticipationInboxCursor {
  readonly invitedAt: Date;
  readonly id: string;
}

export interface PendingJobParticipationInvitation {
  readonly participantId: string;
  readonly jobId: string;
  readonly providerDisplayName: string;
  readonly municipalityName: string;
  readonly primaryProfessionCode: string;
  readonly invitedAt: Date;
}

export interface JobParticipationInboxPage {
  readonly items: readonly PendingJobParticipationInvitation[];
  readonly nextCursor: JobParticipationInboxCursor | null;
}

export interface OwnJobParticipationHistoryItem extends PendingJobParticipationInvitation {
  readonly jobState: "CONFIRMED" | "IN_PROGRESS" | "CANCELLED";
  readonly state: Exclude<ParticipationState, "INVITED">;
  readonly acceptedAt: Date | null;
  readonly leftAt: Date | null;
}

export interface OwnJobParticipationHistoryPage {
  readonly items: readonly OwnJobParticipationHistoryItem[];
  readonly nextCursor: JobParticipationInboxCursor | null;
}

export type InviteJobParticipantResult =
  | Readonly<{
      readonly status: "APPLIED" | "DEDUPLICATED";
      readonly participantId: string;
      readonly invitedAt: Date;
    }>
  | Readonly<{
      readonly status:
        "NOT_FOUND" | "JOB_CLOSED" | "ALREADY_INVITED" | "TARGET_UNAVAILABLE";
    }>;

export type DecideJobParticipationResult =
  | Readonly<{
      readonly status: "APPLIED" | "DEDUPLICATED";
      readonly state: ParticipationState;
      readonly recordedAt: Date;
    }>
  | Readonly<{ readonly status: "NOT_FOUND" | "STALE_STATE" }>;

export class JobParticipationIdempotencyError extends Error {}

interface ExistingInvitation {
  readonly id: string;
  readonly jobId: string;
  readonly craftsmanProfileId: string;
  readonly invitedByUserId: string;
  readonly invitedAt: Date;
}

interface ExistingDecision {
  readonly participantId: string;
  readonly eventKind: Decision;
  readonly actorUserId: string;
  readonly reason: string | null;
  readonly recordedAt: Date;
}

interface ExistingRoleCommand {
  readonly participantId: string;
  readonly actorUserId: string;
  readonly role: OperationalRole;
  readonly action: RoleAction;
  readonly recordedAt: Date;
}

interface PendingInvitationRow extends PendingJobParticipationInvitation {
  readonly providerProfileId: string;
}

interface OwnHistoryRow extends PendingInvitationRow {
  readonly jobState: string;
  readonly state: string;
  readonly acceptedAt: Date | null;
  readonly leftAt: Date | null;
}

const decisionState: Readonly<Record<Decision, ParticipationState>> = {
  ACCEPT: "ACCEPTED",
  DECLINE: "DECLINED",
  LEAVE: "LEFT",
  REMOVE: "REMOVED",
};

export function createJobParticipationRepository(sql: RootSql) {
  return Object.freeze({
    async listOwnHistory(input: {
      readonly actorUserId: string;
      readonly cursor?: JobParticipationInboxCursor;
      readonly limit: number;
    }): Promise<OwnJobParticipationHistoryPage> {
      validateListInput(input);
      return transaction(sql, async (tx) => {
        const [viewer] = await tx<Array<{ id: string }>>`
          SELECT id FROM users WHERE id = ${input.actorUserId}
            AND account_state = 'ACTIVE' FOR SHARE
        `;
        if (viewer === undefined)
          return Object.freeze({ items: Object.freeze([]), nextCursor: null });
        const beforeAt = input.cursor?.invitedAt ?? null;
        const beforeId = input.cursor?.id ?? null;
        const rows = await tx<OwnHistoryRow[]>`
          SELECT participant.id AS "participantId",
            participant.job_id AS "jobId",
            provider.id AS "providerProfileId",
            CASE WHEN provider.profile_type = 'COMPANY'
              THEN provider.official_company_name
              ELSE coalesce(provider.nickname,
                provider.real_first_name || ' ' || provider.real_last_name)
            END AS "providerDisplayName",
            municipality.name_sk AS "municipalityName",
            snapshot.request_snapshot->'sections'->'request.core'
              ->'payload'->>'primaryProfessionCode'
              AS "primaryProfessionCode",
            participant.invited_at AS "invitedAt",
            job_state.state::text AS "jobState",
            participant.state, participant.accepted_at AS "acceptedAt",
            participant.left_at AS "leftAt"
          FROM current_job_participants participant
          JOIN craftsman_profiles invitee
            ON invitee.id = participant.craftsman_profile_id
            AND invitee.owner_user_id = ${input.actorUserId}
          JOIN jobs job ON job.id = participant.job_id
          JOIN current_job_states job_state ON job_state.job_id = job.id
          JOIN craftsman_profiles provider
            ON provider.id = job.primary_craftsman_profile_id
          JOIN job_agreement_snapshots snapshot ON snapshot.job_id = job.id
          JOIN location_municipalities municipality
            ON municipality.code = snapshot.request_snapshot
              ->'sections'->'request.location'->'payload'
              ->>'municipalityCode'
          WHERE participant.state <> 'INVITED'
            AND (${beforeAt}::timestamptz IS NULL
              OR (participant.invited_at, participant.id) <
                (${beforeAt}::timestamptz, ${beforeId}::uuid))
          ORDER BY participant.invited_at DESC, participant.id DESC
          LIMIT ${input.limit + 1}
        `;
        const items = rows.slice(0, input.limit).map((row) => {
          const common = validateInvitationRow(row);
          if (
            !["CONFIRMED", "IN_PROGRESS", "CANCELLED"].includes(row.jobState) ||
            !["ACCEPTED", "DECLINED", "LEFT", "REMOVED"].includes(row.state) ||
            (row.acceptedAt !== null &&
              (!(row.acceptedAt instanceof Date) ||
                !Number.isFinite(row.acceptedAt.getTime()))) ||
            (row.leftAt !== null &&
              (!(row.leftAt instanceof Date) ||
                !Number.isFinite(row.leftAt.getTime()))) ||
            (row.state === "DECLINED" &&
              (row.acceptedAt !== null || row.leftAt !== null)) ||
            (row.state !== "DECLINED" && row.acceptedAt === null) ||
            (["LEFT", "REMOVED"].includes(row.state) && row.leftAt === null)
          )
            throw new Error("Invalid own Job participation provenance.");
          return Object.freeze({
            ...common,
            jobState:
              row.jobState as OwnJobParticipationHistoryItem["jobState"],
            state: row.state as OwnJobParticipationHistoryItem["state"],
            acceptedAt: row.acceptedAt,
            leftAt: row.leftAt,
          });
        });
        const last = rows.length > input.limit ? items.at(-1) : undefined;
        return Object.freeze({
          items: Object.freeze(items),
          nextCursor:
            last === undefined
              ? null
              : Object.freeze({
                  invitedAt: last.invitedAt,
                  id: last.participantId,
                }),
        });
      });
    },

    async changeRole(
      input: ChangeJobParticipantRoleInput,
    ): Promise<ChangeJobParticipantRoleResult> {
      if (
        !uuid.test(input.actorUserId) ||
        !uuid.test(input.commandId) ||
        !uuid.test(input.participantId) ||
        !["LEAD", "COORDINATOR", "SITE_MANAGER"].includes(input.role) ||
        !["ASSIGN", "REVOKE"].includes(input.action)
      )
        throw new TypeError("Invalid Job participant role command.");
      return transaction(sql, async (tx) => {
        await commandLock(tx, input.commandId);
        const [participant] = await tx<Array<{ jobId: string }>>`
          SELECT job_id AS "jobId" FROM job_participants
          WHERE id = ${input.participantId}
        `;
        if (participant === undefined) return { status: "NOT_FOUND" };
        await tx`SELECT id FROM jobs WHERE id = ${participant.jobId} FOR UPDATE`;
        await tx`
          SELECT id FROM job_participants
          WHERE id = ${input.participantId} FOR UPDATE
        `;
        const [authorized] = await tx<Array<{ id: string }>>`
          SELECT actor.id FROM jobs job
          JOIN craftsman_profiles provider
            ON provider.id = job.primary_craftsman_profile_id
          JOIN users actor ON actor.id = provider.owner_user_id
          JOIN auth_credentials credential ON credential.user_id = actor.id
          JOIN job_acceptance_events accepted ON accepted.job_id = job.id
          JOIN job_agreement_snapshots snapshot ON snapshot.job_id = job.id
          WHERE job.id = ${participant.jobId}
            AND actor.id = ${input.actorUserId}
            AND actor.account_state = 'ACTIVE'
            AND credential.email_verified_at IS NOT NULL
            AND credential.phone_verified_at IS NOT NULL
        `;
        if (authorized === undefined) return { status: "NOT_FOUND" };
        const [existing] = await tx<ExistingRoleCommand[]>`
          SELECT participant_id AS "participantId",
            actor_user_id AS "actorUserId", role::text,
            action::text, recorded_at AS "recordedAt"
          FROM job_participant_role_events
          WHERE event_id = ${input.commandId}
        `;
        if (existing !== undefined) {
          if (existing.actorUserId !== input.actorUserId)
            return { status: "NOT_FOUND" };
          if (
            existing.participantId !== input.participantId ||
            existing.role !== input.role ||
            existing.action !== input.action
          )
            throw new JobParticipationIdempotencyError(
              "Job participant role command ID was reused.",
            );
          return Object.freeze({
            status: "DEDUPLICATED" as const,
            role: input.role,
            active: input.action === "ASSIGN",
            recordedAt: existing.recordedAt,
          });
        }
        const [current] = await tx<Array<{ state: string; jobState: string }>>`
          SELECT participant.state, state.state::text AS "jobState"
          FROM current_job_participants participant
          JOIN current_job_states state ON state.job_id = participant.job_id
          WHERE participant.id = ${input.participantId}
        `;
        if (
          current?.state !== "ACCEPTED" ||
          (current.jobState !== "CONFIRMED" &&
            current.jobState !== "IN_PROGRESS")
        )
          return { status: "STALE_STATE" };
        const [prior] = await tx<Array<{ action: RoleAction; next: number }>>`
          SELECT action::text,
            role_sequence + 1 AS next
          FROM job_participant_role_events
          WHERE participant_id = ${input.participantId}
            AND role = ${input.role}
          ORDER BY role_sequence DESC LIMIT 1
        `;
        if (
          (input.action === "ASSIGN" && prior?.action === "ASSIGN") ||
          (input.action === "REVOKE" && prior?.action !== "ASSIGN")
        )
          return { status: "STALE_STATE" };
        const fingerprint = createHash("sha256")
          .update(
            JSON.stringify({
              actorUserId: input.actorUserId,
              participantId: input.participantId,
              role: input.role,
              action: input.action,
            }),
          )
          .digest("hex");
        const [created] = await tx<Array<{ recordedAt: Date }>>`
          INSERT INTO job_participant_role_events (
            event_id, participant_id, role, role_sequence, action,
            actor_user_id, payload_fingerprint
          ) VALUES (
            ${input.commandId}, ${input.participantId}, ${input.role},
            ${prior?.next ?? 1}, ${input.action}, ${input.actorUserId},
            ${fingerprint}
          ) RETURNING recorded_at AS "recordedAt"
        `;
        if (created === undefined)
          throw new Error("Job participant role effect missing.");
        return Object.freeze({
          status: "APPLIED" as const,
          role: input.role,
          active: input.action === "ASSIGN",
          recordedAt: created.recordedAt,
        });
      });
    },

    async listPendingForInvitee(input: {
      readonly actorUserId: string;
      readonly cursor?: JobParticipationInboxCursor;
      readonly limit: number;
    }): Promise<JobParticipationInboxPage> {
      validateListInput(input);
      return transaction(sql, async (tx) => {
        const [viewer] = await tx<Array<{ id: string }>>`
          SELECT id FROM users WHERE id = ${input.actorUserId}
            AND account_state = 'ACTIVE' FOR SHARE
        `;
        if (viewer === undefined)
          return Object.freeze({ items: Object.freeze([]), nextCursor: null });
        const beforeAt = input.cursor?.invitedAt ?? null;
        const beforeId = input.cursor?.id ?? null;
        const rows = await tx<PendingInvitationRow[]>`
          SELECT participant.id AS "participantId",
            participant.job_id AS "jobId",
            provider.id AS "providerProfileId",
            CASE WHEN provider.profile_type = 'COMPANY'
              THEN provider.official_company_name
              ELSE coalesce(provider.nickname,
                provider.real_first_name || ' ' || provider.real_last_name)
            END AS "providerDisplayName",
            municipality.name_sk AS "municipalityName",
            snapshot.request_snapshot->'sections'->'request.core'
              ->'payload'->>'primaryProfessionCode'
              AS "primaryProfessionCode",
            participant.invited_at AS "invitedAt"
          FROM current_job_participants participant
          JOIN craftsman_profiles invitee
            ON invitee.id = participant.craftsman_profile_id
            AND invitee.owner_user_id = ${input.actorUserId}
          JOIN jobs job ON job.id = participant.job_id
          JOIN current_job_states state ON state.job_id = job.id
            AND state.state IN ('CONFIRMED', 'IN_PROGRESS')
          JOIN craftsman_profiles provider
            ON provider.id = job.primary_craftsman_profile_id
          JOIN job_agreement_snapshots snapshot ON snapshot.job_id = job.id
          JOIN location_municipalities municipality
            ON municipality.code = snapshot.request_snapshot
              ->'sections'->'request.location'->'payload'
              ->>'municipalityCode'
          WHERE participant.state = 'INVITED'
            AND (${beforeAt}::timestamptz IS NULL
              OR (participant.invited_at, participant.id) <
                (${beforeAt}::timestamptz, ${beforeId}::uuid))
          ORDER BY participant.invited_at DESC, participant.id DESC
          LIMIT ${input.limit + 1}
        `;
        const items = rows.slice(0, input.limit).map(validateInvitationRow);
        const last = rows.length > input.limit ? items.at(-1) : undefined;
        return Object.freeze({
          items: Object.freeze(items),
          nextCursor:
            last === undefined
              ? null
              : Object.freeze({
                  invitedAt: last.invitedAt,
                  id: last.participantId,
                }),
        });
      });
    },

    async invite(
      input: InviteJobParticipantInput,
    ): Promise<InviteJobParticipantResult> {
      if (
        !uuid.test(input.actorUserId) ||
        !uuid.test(input.commandId) ||
        !uuid.test(input.jobId) ||
        !uuid.test(input.craftsmanProfileId)
      )
        throw new TypeError("Invalid Job participant invitation.");
      return transaction(sql, async (tx) => {
        await commandLock(tx, input.commandId);
        const [owned] = await tx<Array<{ id: string }>>`
          SELECT job.id FROM jobs job
          JOIN craftsman_profiles provider
            ON provider.id = job.primary_craftsman_profile_id
          JOIN users actor ON actor.id = provider.owner_user_id
          JOIN auth_credentials credential ON credential.user_id = actor.id
          JOIN job_acceptance_events accepted ON accepted.job_id = job.id
          JOIN job_agreement_snapshots snapshot ON snapshot.job_id = job.id
          WHERE job.id = ${input.jobId}
            AND actor.id = ${input.actorUserId}
            AND actor.account_state = 'ACTIVE'
            AND credential.email_verified_at IS NOT NULL
            AND credential.phone_verified_at IS NOT NULL
        `;
        if (owned === undefined) return { status: "NOT_FOUND" };
        await tx`SELECT id FROM jobs WHERE id = ${input.jobId} FOR UPDATE`;
        const [existing] = await tx<ExistingInvitation[]>`
          SELECT id, job_id AS "jobId",
            craftsman_profile_id AS "craftsmanProfileId",
            invited_by_user_id AS "invitedByUserId",
            invited_at AS "invitedAt"
          FROM job_participants
          WHERE invitation_command_id = ${input.commandId}
        `;
        if (existing !== undefined) {
          if (existing.invitedByUserId !== input.actorUserId)
            return { status: "NOT_FOUND" };
          if (
            existing.jobId !== input.jobId ||
            existing.craftsmanProfileId !== input.craftsmanProfileId
          )
            throw new JobParticipationIdempotencyError(
              "Job participant invitation command ID was reused.",
            );
          return Object.freeze({
            status: "DEDUPLICATED" as const,
            participantId: existing.id,
            invitedAt: existing.invitedAt,
          });
        }
        const [state] = await tx<Array<{ state: string }>>`
          SELECT state::text FROM current_job_states
          WHERE job_id = ${input.jobId}
        `;
        if (state?.state !== "CONFIRMED" && state?.state !== "IN_PROGRESS")
          return { status: "JOB_CLOSED" };
        const [target] = await tx<Array<{ id: string }>>`
          SELECT profile.id FROM craftsman_profiles profile
          JOIN users owner ON owner.id = profile.owner_user_id
          JOIN auth_credentials credential ON credential.user_id = owner.id
          WHERE profile.id = ${input.craftsmanProfileId}
            AND profile.profile_type = 'INDIVIDUAL'
            AND owner.account_state = 'ACTIVE'
            AND credential.email_verified_at IS NOT NULL
            AND credential.phone_verified_at IS NOT NULL
          FOR SHARE OF profile, owner, credential
        `;
        if (target === undefined) return { status: "TARGET_UNAVAILABLE" };
        const [current] = await tx<Array<{ id: string }>>`
          SELECT id FROM current_job_participants
          WHERE job_id = ${input.jobId}
            AND craftsman_profile_id = ${input.craftsmanProfileId}
            AND state IN ('INVITED', 'ACCEPTED') LIMIT 1
        `;
        if (current !== undefined) return { status: "ALREADY_INVITED" };
        const [sequence] = await tx<Array<{ next: number }>>`
          SELECT coalesce(max(invitation_sequence), 0) + 1 AS next
          FROM job_participants WHERE job_id = ${input.jobId}
            AND craftsman_profile_id = ${input.craftsmanProfileId}
        `;
        const participantId = randomUUID();
        const [created] = await tx<Array<{ invitedAt: Date }>>`
          INSERT INTO job_participants (
            id, job_id, craftsman_profile_id, invitation_sequence,
            invited_by_user_id, invitation_command_id
          ) VALUES (
            ${participantId}, ${input.jobId}, ${input.craftsmanProfileId},
            ${sequence?.next ?? 1}, ${input.actorUserId}, ${input.commandId}
          ) RETURNING invited_at AS "invitedAt"
        `;
        if (created === undefined)
          throw new Error("Job participant invitation effect missing.");
        return Object.freeze({
          status: "APPLIED" as const,
          participantId,
          invitedAt: created.invitedAt,
        });
      });
    },

    async decide(
      input: DecideJobParticipationInput,
    ): Promise<DecideJobParticipationResult> {
      validateDecision(input);
      const reason = input.reason?.trim() ?? null;
      return transaction(sql, async (tx) => {
        await commandLock(tx, input.commandId);
        const [participant] = await tx<Array<{ jobId: string }>>`
          SELECT job_id AS "jobId" FROM job_participants
          WHERE id = ${input.participantId}
        `;
        if (participant === undefined) return { status: "NOT_FOUND" };
        await tx`SELECT id FROM jobs WHERE id = ${participant.jobId} FOR UPDATE`;
        await tx`
          SELECT id FROM job_participants
          WHERE id = ${input.participantId} FOR UPDATE
        `;
        const [authorized] = await tx<Array<{ id: string }>>`
          SELECT viewer.id FROM job_participants participant
          JOIN jobs job ON job.id = participant.job_id
          JOIN craftsman_profiles target
            ON target.id = participant.craftsman_profile_id
          JOIN craftsman_profiles provider
            ON provider.id = job.primary_craftsman_profile_id
          JOIN users viewer ON viewer.id = ${input.actorUserId}
          JOIN auth_credentials credential ON credential.user_id = viewer.id
          WHERE participant.id = ${input.participantId}
            AND viewer.account_state = 'ACTIVE'
            AND credential.email_verified_at IS NOT NULL
            AND credential.phone_verified_at IS NOT NULL
            AND ((${input.decision} = 'REMOVE'
              AND provider.owner_user_id = viewer.id)
              OR (${input.decision} <> 'REMOVE'
                AND target.owner_user_id = viewer.id))
        `;
        if (authorized === undefined) return { status: "NOT_FOUND" };
        const [existing] = await tx<ExistingDecision[]>`
          SELECT participant_id AS "participantId",
            event_kind::text AS "eventKind",
            actor_user_id AS "actorUserId", reason,
            recorded_at AS "recordedAt"
          FROM job_participant_events WHERE event_id = ${input.commandId}
        `;
        if (existing !== undefined) {
          if (existing.actorUserId !== input.actorUserId)
            return { status: "NOT_FOUND" };
          if (
            existing.participantId !== input.participantId ||
            existing.eventKind !== input.decision ||
            existing.reason !== reason
          )
            throw new JobParticipationIdempotencyError(
              "Job participation command ID was reused.",
            );
          return Object.freeze({
            status: "DEDUPLICATED" as const,
            state: decisionState[input.decision],
            recordedAt: existing.recordedAt,
          });
        }
        const [current] = await tx<Array<{ state: ParticipationState }>>`
          SELECT state FROM current_job_participants
          WHERE id = ${input.participantId}
        `;
        const needed =
          input.decision === "ACCEPT" || input.decision === "DECLINE"
            ? "INVITED"
            : "ACCEPTED";
        if (current?.state !== needed) return { status: "STALE_STATE" };
        if (input.decision === "ACCEPT") {
          const [jobState] = await tx<Array<{ state: string }>>`
            SELECT state::text FROM current_job_states
            WHERE job_id = ${participant.jobId}
          `;
          if (
            jobState?.state !== "CONFIRMED" &&
            jobState?.state !== "IN_PROGRESS"
          )
            return { status: "STALE_STATE" };
        }
        const [sequence] = await tx<Array<{ next: number }>>`
          SELECT coalesce(max(event_sequence), 0) + 1 AS next
          FROM job_participant_events
          WHERE participant_id = ${input.participantId}
        `;
        const fingerprint = createHash("sha256")
          .update(
            JSON.stringify({
              actorUserId: input.actorUserId,
              decision: input.decision,
              participantId: input.participantId,
              reason,
            }),
          )
          .digest("hex");
        const [created] = await tx<Array<{ recordedAt: Date }>>`
          INSERT INTO job_participant_events (
            event_id, participant_id, event_sequence, event_kind,
            actor_user_id, reason, payload_fingerprint
          ) VALUES (
            ${input.commandId}, ${input.participantId},
            ${sequence?.next ?? 1}, ${input.decision},
            ${input.actorUserId}, ${reason}, ${fingerprint}
          ) RETURNING recorded_at AS "recordedAt"
        `;
        if (created === undefined)
          throw new Error("Job participation decision effect missing.");
        return Object.freeze({
          status: "APPLIED" as const,
          state: decisionState[input.decision],
          recordedAt: created.recordedAt,
        });
      });
    },
  });
}

function validateListInput(input: {
  readonly actorUserId: string;
  readonly cursor?: JobParticipationInboxCursor;
  readonly limit: number;
}): void {
  if (
    !uuid.test(input.actorUserId) ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 50 ||
    (input.cursor !== undefined &&
      (!uuid.test(input.cursor.id) ||
        !(input.cursor.invitedAt instanceof Date) ||
        !Number.isFinite(input.cursor.invitedAt.getTime())))
  )
    throw new TypeError("Invalid Job participation list query.");
}

function validateInvitationRow(
  row: PendingInvitationRow,
): PendingJobParticipationInvitation {
  if (
    !uuid.test(row.participantId) ||
    !uuid.test(row.jobId) ||
    !uuid.test(row.providerProfileId) ||
    !(row.invitedAt instanceof Date) ||
    !Number.isFinite(row.invitedAt.getTime()) ||
    typeof row.municipalityName !== "string" ||
    row.municipalityName.trim().length === 0 ||
    typeof row.primaryProfessionCode !== "string" ||
    !/^(?:PROF|TEST):[A-Z0-9][A-Z0-9_]{1,62}$/u.test(row.primaryProfessionCode)
  )
    throw new Error("Invalid Job participation list provenance.");
  const providerDisplayName =
    typeof row.providerDisplayName === "string" &&
    row.providerDisplayName.trim().length > 0
      ? row.providerDisplayName.trim()
      : `Remeselník ${row.providerProfileId.slice(0, 8)}`;
  return Object.freeze({
    participantId: row.participantId,
    jobId: row.jobId,
    providerDisplayName,
    municipalityName: row.municipalityName,
    primaryProfessionCode: row.primaryProfessionCode,
    invitedAt: row.invitedAt,
  });
}

function validateDecision(input: DecideJobParticipationInput): void {
  if (
    !uuid.test(input.actorUserId) ||
    !uuid.test(input.commandId) ||
    !uuid.test(input.participantId) ||
    !["ACCEPT", "DECLINE", "LEAVE", "REMOVE"].includes(input.decision) ||
    (input.reason !== undefined && typeof input.reason !== "string")
  )
    throw new TypeError("Invalid Job participation decision.");
  const reason = input.reason?.trim() ?? null;
  if (
    ((input.decision === "ACCEPT" || input.decision === "DECLINE") &&
      reason !== null) ||
    (input.decision === "REMOVE" && reason === null) ||
    (reason !== null &&
      (reason.length < 8 || reason.length > 500 || /[\p{Cc}]/u.test(reason)))
  )
    throw new TypeError("Invalid Job participation reason.");
}

async function commandLock(tx: TransactionSql, commandId: string) {
  await tx`
    SELECT pg_advisory_xact_lock(hashtextextended(${commandId}::text, 51009))
  `;
}

function transaction<T>(
  sql: RootSql,
  callback: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return ("savepoint" in sql
    ? sql.savepoint(callback)
    : sql.begin(callback)) as unknown as Promise<T>;
}
