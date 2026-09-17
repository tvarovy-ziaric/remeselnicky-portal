import type { Sql, TransactionSql } from "postgres";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface JobParticipationDetail {
  readonly participantId: string;
  readonly jobId: string;
  readonly viewerRole: "PARTICIPANT" | "PRIMARY_PROVIDER" | "CUSTOMER";
  readonly state: "INVITED" | "ACCEPTED" | "DECLINED" | "LEFT" | "REMOVED";
  readonly jobState: "CONFIRMED" | "IN_PROGRESS" | "CANCELLED";
  readonly participantDisplayName: string;
  readonly providerDisplayName: string;
  readonly municipalityName: string;
  readonly primaryProfessionCode: string;
  readonly invitedAt: Date;
  readonly acceptedAt: Date | null;
  readonly leftAt: Date | null;
  readonly canDecide: boolean;
  readonly canLeave: boolean;
}

interface DetailRow extends Omit<
  JobParticipationDetail,
  "canDecide" | "canLeave"
> {
  readonly participantProfileId: string;
  readonly providerProfileId: string;
}

export function createJobParticipationDetailRepository(
  sql: Sql | TransactionSql,
) {
  return Object.freeze({
    async getForViewer(input: {
      readonly actorUserId: string;
      readonly participantId: string;
    }): Promise<JobParticipationDetail | null> {
      if (!uuid.test(input.actorUserId) || !uuid.test(input.participantId))
        throw new TypeError("Invalid Job participation detail query.");
      const [row] = await sql<DetailRow[]>`
        SELECT participant.id AS "participantId", job.id AS "jobId",
          CASE
            WHEN target.owner_user_id = viewer.id THEN 'PARTICIPANT'
            WHEN provider.owner_user_id = viewer.id THEN 'PRIMARY_PROVIDER'
            ELSE 'CUSTOMER'
          END AS "viewerRole",
          participant.state, state.state::text AS "jobState",
          target.id AS "participantProfileId",
          provider.id AS "providerProfileId",
          CASE WHEN target.profile_type = 'COMPANY'
            THEN target.official_company_name
            ELSE coalesce(target.nickname,
              target.real_first_name || ' ' || target.real_last_name)
          END AS "participantDisplayName",
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
          participant.accepted_at AS "acceptedAt",
          participant.left_at AS "leftAt"
        FROM current_job_participants participant
        JOIN jobs job ON job.id = participant.job_id
        JOIN current_job_states state ON state.job_id = job.id
        JOIN job_acceptance_events accepted ON accepted.job_id = job.id
        JOIN job_agreement_snapshots snapshot ON snapshot.job_id = job.id
        JOIN craftsman_profiles target
          ON target.id = participant.craftsman_profile_id
        JOIN craftsman_profiles provider
          ON provider.id = job.primary_craftsman_profile_id
        JOIN customer_profiles customer
          ON customer.id = job.customer_profile_id
        JOIN users viewer ON viewer.id = ${input.actorUserId}
          AND viewer.account_state = 'ACTIVE'
        JOIN location_municipalities municipality
          ON municipality.code = snapshot.request_snapshot
            ->'sections'->'request.location'->'payload'
            ->>'municipalityCode'
        WHERE participant.id = ${input.participantId}
          AND (
            target.owner_user_id = viewer.id
            OR provider.owner_user_id = viewer.id
            OR (customer.owner_user_id = viewer.id
              AND participant.accepted_at IS NOT NULL)
          )
      `;
      if (row === undefined) return null;
      if (!validRow(row))
        throw new Error("Invalid Job participation detail provenance.");
      const activeJob =
        row.jobState === "CONFIRMED" || row.jobState === "IN_PROGRESS";
      const participantDisplayName = safeDisplayName(
        row.participantDisplayName,
        row.participantProfileId,
      );
      const providerDisplayName = safeDisplayName(
        row.providerDisplayName,
        row.providerProfileId,
      );
      return Object.freeze({
        participantId: row.participantId,
        jobId: row.jobId,
        viewerRole: row.viewerRole,
        state: row.state,
        jobState: row.jobState,
        participantDisplayName,
        providerDisplayName,
        municipalityName: row.municipalityName,
        primaryProfessionCode: row.primaryProfessionCode,
        invitedAt: row.invitedAt,
        acceptedAt: row.acceptedAt,
        leftAt: row.leftAt,
        canDecide:
          activeJob &&
          row.viewerRole === "PARTICIPANT" &&
          row.state === "INVITED",
        canLeave:
          activeJob &&
          row.viewerRole === "PARTICIPANT" &&
          row.state === "ACCEPTED",
      });
    },
  });
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function validRow(row: DetailRow): boolean {
  return (
    uuid.test(row.participantId) &&
    uuid.test(row.jobId) &&
    uuid.test(row.participantProfileId) &&
    uuid.test(row.providerProfileId) &&
    ["PARTICIPANT", "PRIMARY_PROVIDER", "CUSTOMER"].includes(row.viewerRole) &&
    ["INVITED", "ACCEPTED", "DECLINED", "LEFT", "REMOVED"].includes(
      row.state,
    ) &&
    ["CONFIRMED", "IN_PROGRESS", "CANCELLED"].includes(row.jobState) &&
    typeof row.municipalityName === "string" &&
    row.municipalityName.trim().length > 0 &&
    typeof row.primaryProfessionCode === "string" &&
    /^(?:PROF|TEST):[A-Z0-9][A-Z0-9_]{1,62}$/u.test(
      row.primaryProfessionCode,
    ) &&
    validDate(row.invitedAt) &&
    (row.acceptedAt === null || validDate(row.acceptedAt)) &&
    (row.leftAt === null || validDate(row.leftAt)) &&
    (row.state === "INVITED" || row.state === "DECLINED") ===
      (row.acceptedAt === null) &&
    (row.state === "LEFT" || row.state === "REMOVED") ===
      (row.leftAt !== null) &&
    (row.viewerRole !== "CUSTOMER" || row.acceptedAt !== null)
  );
}

function safeDisplayName(value: string | null, profileId: string): string {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : `Remeselník ${profileId.slice(0, 8)}`;
}
