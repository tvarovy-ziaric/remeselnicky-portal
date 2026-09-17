import { createHash } from "node:crypto";

import type { Sql, TransactionSql } from "postgres";

type RootSql = Sql | TransactionSql;
type DepartureAction = "LEAVE" | "REMOVE";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface CreateJobWorkGroupInput {
  readonly actorUserId: string;
  readonly commandId: string;
  readonly jobId: string;
  readonly name: string;
}

export interface AssignJobWorkGroupInput {
  readonly actorUserId: string;
  readonly commandId: string;
  readonly workGroupId: string;
  readonly participantId: string;
}

export interface DepartJobWorkGroupInput {
  readonly actorUserId: string;
  readonly commandId: string;
  readonly assignmentId: string;
  readonly action: DepartureAction;
  readonly reason?: string;
}

export interface JobWorkGroupCursor {
  readonly createdAt: Date;
  readonly id: string;
}

export interface JobWorkGroupListPage {
  readonly groups: readonly Readonly<{
    readonly id: string;
    readonly name: string;
    readonly crewName: string | null;
    readonly createdAt: Date;
  }>[];
  readonly nextCursor: JobWorkGroupCursor | null;
}

export type CreateJobWorkGroupResult =
  | Readonly<{
      readonly status: "APPLIED" | "DEDUPLICATED";
      readonly workGroupId: string;
      readonly createdAt: Date;
    }>
  | Readonly<{ readonly status: "NOT_FOUND" | "STALE_STATE" }>;

export type AssignJobWorkGroupResult =
  | Readonly<{
      readonly status: "APPLIED" | "DEDUPLICATED";
      readonly assignmentId: string;
      readonly assignedAt: Date;
    }>
  | Readonly<{ readonly status: "NOT_FOUND" | "STALE_STATE" }>;

export type DepartJobWorkGroupResult =
  | Readonly<{
      readonly status: "APPLIED" | "DEDUPLICATED";
      readonly endedAt: Date;
    }>
  | Readonly<{ readonly status: "NOT_FOUND" | "STALE_STATE" }>;

export class JobWorkGroupIdempotencyError extends Error {}

export function createJobWorkGroupCommandRepository(sql: RootSql) {
  return Object.freeze({
    async listForPrimaryParty(input: {
      readonly actorUserId: string;
      readonly jobId: string;
      readonly cursor?: JobWorkGroupCursor;
      readonly limit: number;
    }): Promise<JobWorkGroupListPage | null> {
      validateIds(input.actorUserId, input.jobId);
      if (
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 50 ||
        (input.cursor !== undefined &&
          (!uuid.test(input.cursor.id) ||
            !(input.cursor.createdAt instanceof Date) ||
            !Number.isFinite(input.cursor.createdAt.getTime())))
      )
        throw new TypeError("Invalid work-group list query.");
      return transaction(sql, async (tx) => {
        const [authorized] = await tx<Array<{ id: string }>>`
          SELECT job.id FROM users viewer
          JOIN jobs job ON job.id = ${input.jobId}
          JOIN customer_profiles customer ON customer.id = job.customer_profile_id
          JOIN craftsman_profiles provider ON provider.id = job.primary_craftsman_profile_id
          JOIN job_acceptance_events accepted ON accepted.job_id = job.id
          JOIN job_agreement_snapshots snapshot ON snapshot.job_id = job.id
          WHERE viewer.id = ${input.actorUserId}
            AND viewer.account_state = 'ACTIVE'
            AND (customer.owner_user_id = viewer.id OR provider.owner_user_id = viewer.id)
          FOR SHARE OF viewer, job
        `;
        if (authorized === undefined) return null;
        const beforeAt = input.cursor?.createdAt ?? null;
        const beforeId = input.cursor?.id ?? null;
        const rows = await tx<
          Array<{
            id: string;
            name: string;
            crewName: string | null;
            createdAt: Date;
          }>
        >`
          SELECT group_row.id, group_row.name, crew.name AS "crewName",
            group_row.created_at AS "createdAt"
          FROM job_work_groups group_row
          LEFT JOIN crews crew ON crew.id = group_row.crew_id
          WHERE group_row.job_id = ${input.jobId}
            AND (${beforeAt}::timestamptz IS NULL OR
              (group_row.created_at, group_row.id) <
              (${beforeAt}::timestamptz, ${beforeId}::uuid))
          ORDER BY group_row.created_at DESC, group_row.id DESC
          LIMIT ${input.limit + 1}
        `;
        const groups = rows.slice(0, input.limit).map((row) => {
          if (
            !uuid.test(row.id) ||
            typeof row.name !== "string" ||
            row.name.trim().length < 2 ||
            (row.crewName !== null && typeof row.crewName !== "string") ||
            !(row.createdAt instanceof Date) ||
            !Number.isFinite(row.createdAt.getTime())
          )
            throw new Error("Invalid work-group list provenance.");
          return Object.freeze(row);
        });
        const last = rows.length > input.limit ? groups.at(-1) : undefined;
        return Object.freeze({
          groups: Object.freeze(groups),
          nextCursor:
            last === undefined
              ? null
              : Object.freeze({
                  createdAt: last.createdAt,
                  id: last.id,
                }),
        });
      });
    },

    async create(
      input: CreateJobWorkGroupInput,
    ): Promise<CreateJobWorkGroupResult> {
      const name = validateName(input);
      return transaction(sql, async (tx) => {
        await commandLock(tx, input.commandId);
        const authorized = await providerOwnsJob(
          tx,
          input.jobId,
          input.actorUserId,
        );
        if (!authorized) return { status: "NOT_FOUND" };
        await tx`SELECT id FROM jobs WHERE id = ${input.jobId} FOR UPDATE`;
        const [existing] = await tx<
          Array<{
            jobId: string;
            name: string;
            actorUserId: string;
            createdAt: Date;
          }>
        >`
          SELECT job_id AS "jobId", name,
            created_by_user_id AS "actorUserId", created_at AS "createdAt"
          FROM job_work_groups WHERE id = ${input.commandId}
        `;
        if (existing !== undefined) {
          if (existing.actorUserId !== input.actorUserId)
            return { status: "NOT_FOUND" };
          if (existing.jobId !== input.jobId || existing.name !== name)
            throw new JobWorkGroupIdempotencyError(
              "Work-group command ID reused.",
            );
          return Object.freeze({
            status: "DEDUPLICATED" as const,
            workGroupId: input.commandId,
            createdAt: existing.createdAt,
          });
        }
        if (!(await jobActive(tx, input.jobId)))
          return { status: "STALE_STATE" };
        const [created] = await tx<Array<{ createdAt: Date }>>`
          INSERT INTO job_work_groups (
            id, job_id, name, created_by_user_id
          ) VALUES (
            ${input.commandId}, ${input.jobId}, ${name}, ${input.actorUserId}
          ) RETURNING created_at AS "createdAt"
        `;
        if (created === undefined)
          throw new Error("Work-group effect missing.");
        return Object.freeze({
          status: "APPLIED" as const,
          workGroupId: input.commandId,
          createdAt: created.createdAt,
        });
      });
    },

    async assign(
      input: AssignJobWorkGroupInput,
    ): Promise<AssignJobWorkGroupResult> {
      validateIds(
        input.actorUserId,
        input.commandId,
        input.workGroupId,
        input.participantId,
      );
      return transaction(sql, async (tx) => {
        await commandLock(tx, input.commandId);
        const [group] = await tx<Array<{ jobId: string }>>`
          SELECT job_id AS "jobId" FROM job_work_groups
          WHERE id = ${input.workGroupId}
        `;
        if (group === undefined) return { status: "NOT_FOUND" };
        if (!(await providerOwnsJob(tx, group.jobId, input.actorUserId)))
          return { status: "NOT_FOUND" };
        await tx`SELECT id FROM jobs WHERE id = ${group.jobId} FOR UPDATE`;
        const [existing] = await tx<
          Array<{
            jobId: string;
            workGroupId: string;
            participantId: string;
            actorUserId: string;
            assignedAt: Date;
          }>
        >`
          SELECT job_id AS "jobId", work_group_id AS "workGroupId",
            participant_id AS "participantId",
            assigned_by_user_id AS "actorUserId", assigned_at AS "assignedAt"
          FROM job_work_group_assignments WHERE id = ${input.commandId}
        `;
        if (existing !== undefined) {
          if (existing.actorUserId !== input.actorUserId)
            return { status: "NOT_FOUND" };
          if (
            existing.jobId !== group.jobId ||
            existing.workGroupId !== input.workGroupId ||
            existing.participantId !== input.participantId
          )
            throw new JobWorkGroupIdempotencyError(
              "Work-group assignment command ID reused.",
            );
          return Object.freeze({
            status: "DEDUPLICATED" as const,
            assignmentId: input.commandId,
            assignedAt: existing.assignedAt,
          });
        }
        const [participant] = await tx<Array<{ state: string }>>`
          SELECT state FROM current_job_participants
          WHERE id = ${input.participantId} AND job_id = ${group.jobId}
        `;
        if (participant === undefined) return { status: "NOT_FOUND" };
        if (
          !(await jobActive(tx, group.jobId)) ||
          participant.state !== "ACCEPTED"
        )
          return { status: "STALE_STATE" };
        const [active] = await tx<Array<{ id: string }>>`
          SELECT id FROM current_job_work_group_assignments
          WHERE work_group_id = ${input.workGroupId}
            AND participant_id = ${input.participantId} AND active
          LIMIT 1
        `;
        if (active !== undefined) return { status: "STALE_STATE" };
        const [sequence] = await tx<Array<{ next: number }>>`
          SELECT coalesce(max(assignment_sequence), 0) + 1 AS next
          FROM job_work_group_assignments
          WHERE work_group_id = ${input.workGroupId}
            AND participant_id = ${input.participantId}
        `;
        const [created] = await tx<Array<{ assignedAt: Date }>>`
          INSERT INTO job_work_group_assignments (
            id, job_id, work_group_id, participant_id,
            assignment_sequence, assigned_by_user_id
          ) VALUES (
            ${input.commandId}, ${group.jobId}, ${input.workGroupId},
            ${input.participantId}, ${sequence?.next ?? 1}, ${input.actorUserId}
          ) RETURNING assigned_at AS "assignedAt"
        `;
        if (created === undefined)
          throw new Error("Work-group assignment effect missing.");
        return Object.freeze({
          status: "APPLIED" as const,
          assignmentId: input.commandId,
          assignedAt: created.assignedAt,
        });
      });
    },

    async depart(
      input: DepartJobWorkGroupInput,
    ): Promise<DepartJobWorkGroupResult> {
      const reason = validateDeparture(input);
      return transaction(sql, async (tx) => {
        await commandLock(tx, input.commandId);
        const [assignment] = await tx<
          Array<{
            jobId: string;
            ownerUserId: string;
            providerUserId: string;
          }>
        >`
          SELECT assignment.job_id AS "jobId",
            target.owner_user_id AS "ownerUserId",
            provider.owner_user_id AS "providerUserId"
          FROM job_work_group_assignments assignment
          JOIN job_participants participant ON participant.id = assignment.participant_id
          JOIN craftsman_profiles target ON target.id = participant.craftsman_profile_id
          JOIN jobs job ON job.id = assignment.job_id
          JOIN craftsman_profiles provider ON provider.id = job.primary_craftsman_profile_id
          WHERE assignment.id = ${input.assignmentId}
        `;
        if (assignment === undefined) return { status: "NOT_FOUND" };
        if (
          (input.action === "LEAVE" &&
            assignment.ownerUserId !== input.actorUserId) ||
          (input.action === "REMOVE" &&
            assignment.providerUserId !== input.actorUserId)
        )
          return { status: "NOT_FOUND" };
        const [actor] = await tx<Array<{ id: string }>>`
          SELECT actor.id FROM users actor
          JOIN auth_credentials credential ON credential.user_id = actor.id
          WHERE actor.id = ${input.actorUserId}
            AND actor.account_state = 'ACTIVE'
            AND credential.email_verified_at IS NOT NULL
            AND credential.phone_verified_at IS NOT NULL
        `;
        if (actor === undefined) return { status: "NOT_FOUND" };
        await tx`SELECT id FROM jobs WHERE id = ${assignment.jobId} FOR UPDATE`;
        await tx`SELECT id FROM job_work_group_assignments WHERE id = ${input.assignmentId} FOR UPDATE`;
        const [existing] = await tx<
          Array<{
            assignmentId: string;
            action: DepartureAction;
            actorUserId: string;
            reason: string | null;
            recordedAt: Date;
          }>
        >`
          SELECT assignment_id AS "assignmentId", event_kind::text AS action,
            actor_user_id AS "actorUserId", reason,
            recorded_at AS "recordedAt"
          FROM job_work_group_departure_events WHERE event_id = ${input.commandId}
        `;
        if (existing !== undefined) {
          if (existing.actorUserId !== input.actorUserId)
            return { status: "NOT_FOUND" };
          if (
            existing.assignmentId !== input.assignmentId ||
            existing.action !== input.action ||
            existing.reason !== reason
          )
            throw new JobWorkGroupIdempotencyError(
              "Work-group departure command ID reused.",
            );
          return Object.freeze({
            status: "DEDUPLICATED" as const,
            endedAt: existing.recordedAt,
          });
        }
        const [current] = await tx<Array<{ active: boolean }>>`
          SELECT active FROM current_job_work_group_assignments
          WHERE id = ${input.assignmentId}
        `;
        if (current?.active !== true) return { status: "STALE_STATE" };
        const fingerprint = createHash("sha256")
          .update(
            JSON.stringify({
              assignmentId: input.assignmentId,
              action: input.action,
              actorUserId: input.actorUserId,
              reason,
            }),
          )
          .digest("hex");
        const [created] = await tx<Array<{ recordedAt: Date }>>`
          INSERT INTO job_work_group_departure_events (
            event_id, assignment_id, event_kind, actor_user_id,
            reason, payload_fingerprint
          ) VALUES (
            ${input.commandId}, ${input.assignmentId}, ${input.action},
            ${input.actorUserId}, ${reason}, ${fingerprint}
          ) RETURNING recorded_at AS "recordedAt"
        `;
        if (created === undefined)
          throw new Error("Work-group departure effect missing.");
        return Object.freeze({
          status: "APPLIED" as const,
          endedAt: created.recordedAt,
        });
      });
    },
  });
}

function validateIds(...values: readonly string[]): void {
  if (values.some((value) => !uuid.test(value)))
    throw new TypeError("Invalid work-group command ID.");
}

function validateName(input: CreateJobWorkGroupInput): string {
  validateIds(input.actorUserId, input.commandId, input.jobId);
  if (typeof input.name !== "string")
    throw new TypeError("Invalid work-group name.");
  const name = input.name.trim();
  if (name.length < 2 || name.length > 120 || /[\p{Cc}]/u.test(name))
    throw new TypeError("Invalid work-group name.");
  return name;
}

function validateDeparture(input: DepartJobWorkGroupInput): string | null {
  validateIds(input.actorUserId, input.commandId, input.assignmentId);
  if (input.action !== "LEAVE" && input.action !== "REMOVE")
    throw new TypeError("Invalid work-group departure action.");
  if (input.reason !== undefined && typeof input.reason !== "string")
    throw new TypeError("Invalid work-group departure reason.");
  const reason = input.reason?.trim() ?? null;
  if (
    (input.action === "LEAVE" && reason !== null) ||
    (input.action === "REMOVE" && reason === null) ||
    (reason !== null &&
      (reason.length < 8 || reason.length > 500 || /[\p{Cc}]/u.test(reason)))
  )
    throw new TypeError("Invalid work-group departure reason.");
  return reason;
}

async function providerOwnsJob(
  tx: TransactionSql,
  jobId: string,
  actorUserId: string,
): Promise<boolean> {
  const [owned] = await tx<Array<{ id: string }>>`
    SELECT job.id FROM jobs job
    JOIN craftsman_profiles provider ON provider.id = job.primary_craftsman_profile_id
    JOIN users actor ON actor.id = provider.owner_user_id
    JOIN auth_credentials credential ON credential.user_id = actor.id
    JOIN job_acceptance_events accepted ON accepted.job_id = job.id
    JOIN job_agreement_snapshots snapshot ON snapshot.job_id = job.id
    WHERE job.id = ${jobId} AND actor.id = ${actorUserId}
      AND actor.account_state = 'ACTIVE'
      AND credential.email_verified_at IS NOT NULL
      AND credential.phone_verified_at IS NOT NULL
  `;
  return owned !== undefined;
}

async function jobActive(tx: TransactionSql, jobId: string): Promise<boolean> {
  const [current] = await tx<Array<{ state: string }>>`
    SELECT state::text FROM current_job_states WHERE job_id = ${jobId}
  `;
  return current?.state === "CONFIRMED" || current?.state === "IN_PROGRESS";
}

async function commandLock(
  tx: TransactionSql,
  commandId: string,
): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${commandId}::text, 51010))`;
}

function transaction<T>(
  sql: RootSql,
  callback: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return ("savepoint" in sql
    ? sql.savepoint(callback)
    : sql.begin(callback)) as unknown as Promise<T>;
}
