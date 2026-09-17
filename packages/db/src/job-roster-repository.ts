import type { Sql, TransactionSql } from "postgres";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface JobRosterCursor {
  readonly invitedAt: Date;
  readonly id: string;
}

export interface JobRosterRole {
  readonly role: "MEMBER" | "LEAD" | "COORDINATOR" | "SITE_MANAGER";
  readonly assignedAt: Date;
  readonly endedAt: Date | null;
  readonly active: boolean;
}

export interface JobRosterWorkGroup {
  readonly assignmentId: string;
  readonly workGroupId: string;
  readonly name: string;
  readonly crewName: string | null;
  readonly assignedAt: Date;
  readonly endedAt: Date | null;
  readonly active: boolean;
}

export interface JobRosterParticipant {
  readonly id: string;
  readonly craftsmanProfileId: string;
  readonly displayName: string;
  readonly state: "INVITED" | "ACCEPTED" | "DECLINED" | "LEFT" | "REMOVED";
  readonly invitedAt: Date;
  readonly acceptedAt: Date | null;
  readonly leftAt: Date | null;
  readonly roles: readonly JobRosterRole[];
  readonly workGroups: readonly JobRosterWorkGroup[];
}

export interface JobRosterPage {
  readonly role: "CUSTOMER" | "PRIMARY_PROVIDER";
  readonly participants: readonly JobRosterParticipant[];
  readonly nextCursor: JobRosterCursor | null;
}

interface ParticipantRow {
  readonly id: string;
  readonly craftsmanProfileId: string;
  readonly nickname: string | null;
  readonly realFirstName: string | null;
  readonly realLastName: string | null;
  readonly state: JobRosterParticipant["state"];
  readonly invitedAt: Date;
  readonly acceptedAt: Date | null;
  readonly leftAt: Date | null;
}

interface RoleRow extends JobRosterRole {
  readonly participantId: string;
}

interface WorkGroupRow extends JobRosterWorkGroup {
  readonly participantId: string;
}

export function createJobRosterRepository(sql: Sql | TransactionSql) {
  return Object.freeze({
    async listForPrimaryParty(input: {
      readonly actorUserId: string;
      readonly jobId: string;
      readonly cursor?: JobRosterCursor;
      readonly limit: number;
    }): Promise<JobRosterPage | null> {
      if (
        !uuid.test(input.actorUserId) ||
        !uuid.test(input.jobId) ||
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 50 ||
        (input.cursor !== undefined &&
          (!uuid.test(input.cursor.id) ||
            !(input.cursor.invitedAt instanceof Date) ||
            !Number.isFinite(input.cursor.invitedAt.getTime())))
      )
        throw new TypeError("Invalid Job roster query.");
      return transaction(sql, async (tx) => {
        const [authorized] = await tx<Array<{ role: JobRosterPage["role"] }>>`
          SELECT CASE WHEN customer.owner_user_id = viewer.id
            THEN 'CUSTOMER' ELSE 'PRIMARY_PROVIDER' END AS role
          FROM users viewer
          JOIN jobs job ON job.id = ${input.jobId}
          JOIN customer_profiles customer
            ON customer.id = job.customer_profile_id
          JOIN craftsman_profiles provider
            ON provider.id = job.primary_craftsman_profile_id
          JOIN job_acceptance_events accepted ON accepted.job_id = job.id
          JOIN job_agreement_snapshots snapshot ON snapshot.job_id = job.id
          WHERE viewer.id = ${input.actorUserId}
            AND viewer.account_state = 'ACTIVE'
            AND (customer.owner_user_id = viewer.id
              OR provider.owner_user_id = viewer.id)
          FOR SHARE OF viewer, job
        `;
        if (authorized === undefined) return null;
        if (
          authorized.role !== "CUSTOMER" &&
          authorized.role !== "PRIMARY_PROVIDER"
        )
          throw new Error("Invalid Job roster role.");
        const beforeAt = input.cursor?.invitedAt ?? null;
        const beforeId = input.cursor?.id ?? null;
        const rows = await tx<ParticipantRow[]>`
          SELECT participant.id,
            participant.craftsman_profile_id AS "craftsmanProfileId",
            profile.nickname, profile.real_first_name AS "realFirstName",
            profile.real_last_name AS "realLastName",
            participant.state, participant.invited_at AS "invitedAt",
            participant.accepted_at AS "acceptedAt",
            participant.left_at AS "leftAt"
          FROM current_job_participants participant
          JOIN craftsman_profiles profile
            ON profile.id = participant.craftsman_profile_id
          WHERE participant.job_id = ${input.jobId}
            AND (${authorized.role} = 'PRIMARY_PROVIDER'
              OR participant.accepted_at IS NOT NULL)
            AND (${beforeAt}::timestamptz IS NULL
              OR (participant.invited_at, participant.id) <
                (${beforeAt}::timestamptz, ${beforeId}::uuid))
          ORDER BY participant.invited_at DESC, participant.id DESC
          LIMIT ${input.limit + 1}
        `;
        const pageRows = rows.slice(0, input.limit);
        const ids = pageRows.map((row) => row.id);
        const roles =
          ids.length === 0
            ? []
            : await tx<RoleRow[]>`
                SELECT participant_id AS "participantId", role,
                  assigned_at AS "assignedAt", ended_at AS "endedAt", active
                FROM job_participant_role_intervals
                WHERE participant_id = ANY(${ids}::uuid[])
                ORDER BY assigned_at, role, assignment_event_id
              `;
        const workGroups =
          ids.length === 0
            ? []
            : await tx<WorkGroupRow[]>`
                SELECT assignment.participant_id AS "participantId",
                  assignment.id AS "assignmentId",
                  assignment.work_group_id AS "workGroupId",
                  group_row.name, crew.name AS "crewName",
                  assignment.assigned_at AS "assignedAt",
                  assignment.ended_at AS "endedAt", assignment.active
                FROM current_job_work_group_assignments assignment
                JOIN job_work_groups group_row
                  ON group_row.id = assignment.work_group_id
                  AND group_row.job_id = assignment.job_id
                LEFT JOIN crews crew ON crew.id = group_row.crew_id
                WHERE assignment.participant_id = ANY(${ids}::uuid[])
                ORDER BY assignment.assigned_at, assignment.id
              `;
        const rolesByParticipant = groupByParticipant(roles, ids, validRole);
        const groupsByParticipant = groupByParticipant(
          workGroups,
          ids,
          validWorkGroup,
        );
        const participants = pageRows.map((row): JobRosterParticipant => {
          if (!validParticipant(row))
            throw new Error("Invalid Job roster participant.");
          if (authorized.role === "CUSTOMER" && row.acceptedAt === null)
            throw new Error("Invalid customer Job roster visibility.");
          const participantRoles = rolesByParticipant.get(row.id) ?? [];
          const participantGroups = groupsByParticipant.get(row.id) ?? [];
          if (
            row.acceptedAt === null &&
            (participantRoles.length !== 0 || participantGroups.length !== 0)
          )
            throw new Error("Unaccepted Job roster participant has history.");
          const displayName =
            row.nickname?.trim() ||
            (row.realFirstName && row.realLastName
              ? `${row.realFirstName} ${row.realLastName}`
              : `Remeselník ${row.craftsmanProfileId.slice(0, 8)}`);
          return Object.freeze({
            id: row.id,
            craftsmanProfileId: row.craftsmanProfileId,
            displayName,
            state: row.state,
            invitedAt: row.invitedAt,
            acceptedAt: row.acceptedAt,
            leftAt: row.leftAt,
            roles: Object.freeze(
              participantRoles.map(({ role, assignedAt, endedAt, active }) =>
                Object.freeze({ role, assignedAt, endedAt, active }),
              ),
            ),
            workGroups: Object.freeze(
              participantGroups.map(
                ({
                  assignmentId,
                  workGroupId,
                  name,
                  crewName,
                  assignedAt,
                  endedAt,
                  active,
                }) =>
                  Object.freeze({
                    assignmentId,
                    workGroupId,
                    name,
                    crewName,
                    assignedAt,
                    endedAt,
                    active,
                  }),
              ),
            ),
          });
        });
        const last =
          rows.length > input.limit ? participants.at(-1) : undefined;
        return Object.freeze({
          role: authorized.role,
          participants: Object.freeze(participants),
          nextCursor:
            last === undefined
              ? null
              : Object.freeze({ invitedAt: last.invitedAt, id: last.id }),
        });
      });
    },
  });
}

function groupByParticipant<T extends { readonly participantId: string }>(
  rows: readonly T[],
  ids: readonly string[],
  valid: (value: T) => boolean,
): Map<string, T[]> {
  const allowed = new Set(ids);
  const result = new Map<string, T[]>();
  for (const row of rows) {
    if (!valid(row) || !allowed.has(row.participantId))
      throw new Error("Invalid Job roster provenance.");
    const existing = result.get(row.participantId) ?? [];
    existing.push(row);
    result.set(row.participantId, existing);
  }
  return result;
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function validParticipant(value: ParticipantRow): boolean {
  return (
    uuid.test(value.id) &&
    uuid.test(value.craftsmanProfileId) &&
    (value.nickname === null || typeof value.nickname === "string") &&
    (value.realFirstName === null || typeof value.realFirstName === "string") &&
    (value.realLastName === null || typeof value.realLastName === "string") &&
    ["INVITED", "ACCEPTED", "DECLINED", "LEFT", "REMOVED"].includes(
      value.state,
    ) &&
    validDate(value.invitedAt) &&
    (value.acceptedAt === null || validDate(value.acceptedAt)) &&
    (value.leftAt === null || validDate(value.leftAt)) &&
    (value.state === "INVITED" || value.state === "DECLINED") ===
      (value.acceptedAt === null) &&
    (value.state === "LEFT" || value.state === "REMOVED") ===
      (value.leftAt !== null)
  );
}

function validRole(value: RoleRow): boolean {
  return (
    uuid.test(value.participantId) &&
    ["MEMBER", "LEAD", "COORDINATOR", "SITE_MANAGER"].includes(value.role) &&
    validDate(value.assignedAt) &&
    (value.endedAt === null || validDate(value.endedAt)) &&
    typeof value.active === "boolean" &&
    value.active === (value.endedAt === null)
  );
}

function validWorkGroup(value: WorkGroupRow): boolean {
  return (
    uuid.test(value.participantId) &&
    uuid.test(value.assignmentId) &&
    uuid.test(value.workGroupId) &&
    typeof value.name === "string" &&
    (value.crewName === null || typeof value.crewName === "string") &&
    validDate(value.assignedAt) &&
    (value.endedAt === null || validDate(value.endedAt)) &&
    typeof value.active === "boolean" &&
    value.active === (value.endedAt === null)
  );
}

function transaction<T>(
  sql: Sql | TransactionSql,
  callback: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return ("savepoint" in sql
    ? sql.savepoint(callback)
    : sql.begin(callback)) as unknown as Promise<T>;
}
