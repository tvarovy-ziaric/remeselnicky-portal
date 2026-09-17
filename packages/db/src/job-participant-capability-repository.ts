import type { Sql, TransactionSql } from "postgres";

type RootSql = Sql | TransactionSql;
export type JobParticipantCapabilityKind =
  "PROFESSION" | "CANONICAL_SKILL" | "CUSTOM_SKILL";

export interface ProposeJobParticipantCapabilityInput {
  readonly actorUserId: string;
  readonly commandId: string;
  readonly participantId: string;
  readonly kind: JobParticipantCapabilityKind;
  readonly professionCode?: string;
  readonly skillCode?: string;
  readonly customSkillText?: string;
}

export interface ConfirmJobParticipantCapabilityInput {
  readonly actorUserId: string;
  readonly commandId: string;
  readonly participantId: string;
  readonly claimId: string;
}

export type ProposeJobParticipantCapabilityResult =
  | Readonly<{
      readonly status: "APPLIED" | "DEDUPLICATED";
      readonly claimId: string;
      readonly claimStatus: "PROPOSED";
      readonly proposedAt: Date;
    }>
  | Readonly<{
      readonly status: "NOT_FOUND" | "STALE_STATE" | "INVALID_CAPABILITY";
    }>;

export type ConfirmJobParticipantCapabilityResult =
  | Readonly<{
      readonly status: "APPLIED" | "DEDUPLICATED";
      readonly claimId: string;
      readonly claimStatus: "CONFIRMED";
      readonly confirmedAt: Date;
    }>
  | Readonly<{ readonly status: "NOT_FOUND" | "STALE_STATE" }>;

export interface JobParticipantCapabilityCursor {
  readonly proposedAt: Date;
  readonly id: string;
}

export interface JobParticipantCapabilityItem {
  readonly claimId: string;
  readonly participantId: string;
  readonly kind: JobParticipantCapabilityKind;
  readonly professionTaxonomyReleaseId: string | null;
  readonly professionCode: string | null;
  readonly skillCatalogReleaseId: string | null;
  readonly skillCode: string | null;
  readonly customSkillText: string | null;
  readonly proposedByUserId: string;
  readonly proposedAt: Date;
  readonly confirmedByUserId: string | null;
  readonly confirmedAt: Date | null;
  readonly status: "PROPOSED" | "CONFIRMED";
  readonly canConfirm: boolean;
}

export interface JobParticipantCapabilityPage {
  readonly items: readonly JobParticipantCapabilityItem[];
  readonly nextCursor: JobParticipantCapabilityCursor | null;
  readonly canAct: boolean;
  readonly canPropose: boolean;
}

type CapabilityRow = Omit<JobParticipantCapabilityItem, "canConfirm">;
interface CapabilityViewer {
  readonly jobId: string;
  readonly providerUserId: string;
  readonly targetUserId: string;
  readonly isResponsible: boolean;
}

export class JobParticipantCapabilityIdempotencyError extends Error {}

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const professionCode = /^(?:PROF|TEST):[A-Z0-9][A-Z0-9_]{1,62}$/u;
const skillCode = /^(?:SKILL|TEST):[A-Z0-9][A-Z0-9_]{1,62}$/u;
const unsafeCustom =
  /[\p{Cc}]|@|https?:\/\/|www\.|\b(?:heslo|password|secret)\b/iu;

export function createJobParticipantCapabilityRepository(sql: RootSql) {
  return Object.freeze({
    async list(input: {
      readonly actorUserId: string;
      readonly participantId: string;
      readonly limit: number;
      readonly cursor?: JobParticipantCapabilityCursor;
    }): Promise<JobParticipantCapabilityPage | null> {
      validIds(input.actorUserId, input.participantId);
      if (
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 50 ||
        (input.cursor !== undefined &&
          (!uuid.test(input.cursor.id) ||
            !(input.cursor.proposedAt instanceof Date) ||
            !Number.isFinite(input.cursor.proposedAt.getTime())))
      )
        throw new TypeError("Invalid capability list request.");
      return transaction(sql, async (tx) => {
        const party = await findParty(
          tx,
          input.participantId,
          input.actorUserId,
        );
        if (party === null) return null;
        const beforeAt = input.cursor?.proposedAt ?? null;
        const beforeId = input.cursor?.id ?? null;
        const rows = await tx<CapabilityRow[]>`
          SELECT claim.id AS "claimId", claim.participant_id AS "participantId",
            claim.kind::text AS kind,
            claim.profession_taxonomy_release_id AS "professionTaxonomyReleaseId",
            claim.profession_code AS "professionCode",
            claim.skill_catalog_release_id AS "skillCatalogReleaseId",
            claim.skill_code AS "skillCode", claim.custom_skill_text AS "customSkillText",
            claim.proposed_by_user_id AS "proposedByUserId",
            claim.proposed_at AS "proposedAt",
            confirmation.confirmed_by_user_id AS "confirmedByUserId",
            confirmation.confirmed_at AS "confirmedAt",
            CASE WHEN confirmation.event_id IS NULL THEN 'PROPOSED'
              ELSE 'CONFIRMED' END AS status
          FROM job_participant_capability_claims claim
          LEFT JOIN job_participant_capability_confirmations confirmation
            ON confirmation.claim_id = claim.id
          WHERE claim.participant_id = ${input.participantId}
            AND (${beforeAt}::timestamptz IS NULL OR
              (claim.proposed_at, claim.id) < (${beforeAt}::timestamptz, ${beforeId}::uuid))
          ORDER BY claim.proposed_at DESC, claim.id DESC
          LIMIT ${input.limit + 1}
        `;
        const canAct = await isActive(tx, input.participantId, party.jobId);
        const canPropose =
          canAct &&
          (input.actorUserId === party.providerUserId ||
            input.actorUserId === party.targetUserId);
        const items = rows.slice(0, input.limit).map((row) =>
          Object.freeze({
            ...validateItem(row),
            canConfirm:
              canAct &&
              row.confirmedAt === null &&
              row.proposedByUserId !== input.actorUserId &&
              ((row.proposedByUserId === party.providerUserId &&
                input.actorUserId === party.targetUserId) ||
                (row.proposedByUserId === party.targetUserId &&
                  (input.actorUserId === party.providerUserId ||
                    party.isResponsible))),
          }),
        );
        const last = rows.length > input.limit ? items.at(-1) : undefined;
        return Object.freeze({
          items: Object.freeze(items),
          canAct,
          canPropose,
          nextCursor:
            last === undefined
              ? null
              : Object.freeze({
                  proposedAt: last.proposedAt,
                  id: last.claimId,
                }),
        });
      });
    },

    async propose(
      input: ProposeJobParticipantCapabilityInput,
    ): Promise<ProposeJobParticipantCapabilityResult> {
      validateProposal(input);
      return transaction(sql, async (tx) => {
        await commandLock(tx, input.commandId);
        const party = await findParty(
          tx,
          input.participantId,
          input.actorUserId,
        );
        if (party === null) return { status: "NOT_FOUND" };
        if (
          input.actorUserId !== party.providerUserId &&
          input.actorUserId !== party.targetUserId
        )
          return { status: "NOT_FOUND" };
        await tx`SELECT id FROM jobs WHERE id = ${party.jobId} FOR UPDATE`;
        await tx`SELECT id FROM job_participants WHERE id = ${input.participantId} FOR UPDATE`;
        const [existing] = await tx<
          Array<{
            participantId: string;
            kind: JobParticipantCapabilityKind;
            professionCode: string | null;
            skillCode: string | null;
            customSkillText: string | null;
            proposedByUserId: string;
            proposedAt: Date;
          }>
        >`
          SELECT participant_id AS "participantId", kind::text,
            profession_code AS "professionCode", skill_code AS "skillCode",
            custom_skill_text AS "customSkillText",
            proposed_by_user_id AS "proposedByUserId", proposed_at AS "proposedAt"
          FROM job_participant_capability_claims WHERE id = ${input.commandId}
        `;
        if (existing !== undefined) {
          if (existing.proposedByUserId !== input.actorUserId)
            return { status: "NOT_FOUND" };
          if (
            existing.participantId !== input.participantId ||
            existing.kind !== input.kind ||
            existing.professionCode !== (input.professionCode ?? null) ||
            existing.skillCode !== (input.skillCode ?? null) ||
            existing.customSkillText !== (input.customSkillText ?? null)
          )
            throw new JobParticipantCapabilityIdempotencyError(
              "Capability command ID reused.",
            );
          return Object.freeze({
            status: "DEDUPLICATED" as const,
            claimId: input.commandId,
            claimStatus: "PROPOSED" as const,
            proposedAt: existing.proposedAt,
          });
        }
        if (!(await isActive(tx, input.participantId, party.jobId)))
          return { status: "STALE_STATE" };
        let taxonomyReleaseId: string | null = null;
        let skillReleaseId: string | null = null;
        if (input.kind === "PROFESSION") {
          const [taxonomy] = await tx<Array<{ releaseId: string }>>`
            SELECT release_id AS "releaseId" FROM current_profession_taxonomy
            WHERE profession_code = ${input.professionCode!} AND state = 'ACTIVE'
          `;
          if (taxonomy === undefined) return { status: "INVALID_CAPABILITY" };
          taxonomyReleaseId = taxonomy.releaseId;
        } else if (input.kind === "CANONICAL_SKILL") {
          const [skill] = await tx<Array<{ releaseId: string }>>`
            SELECT release_id AS "releaseId" FROM current_skill_catalog
            WHERE skill_code = ${input.skillCode!} AND state = 'ACTIVE'
          `;
          if (skill === undefined) return { status: "INVALID_CAPABILITY" };
          skillReleaseId = skill.releaseId;
        } else {
          const [safe] = await tx<Array<{ safe: boolean }>>`
            SELECT craftsman_capability_public_text_safe(${input.customSkillText!}) AS safe
          `;
          if (safe?.safe !== true) return { status: "INVALID_CAPABILITY" };
        }
        const [duplicate] = await tx<Array<{ id: string }>>`
          SELECT id FROM job_participant_capability_claims
          WHERE participant_id = ${input.participantId}
            AND kind = ${input.kind}
            AND ((${input.kind} = 'PROFESSION' AND
              profession_code = ${input.professionCode ?? null}) OR
              (${input.kind} = 'CANONICAL_SKILL' AND
              skill_code = ${input.skillCode ?? null}) OR
              (${input.kind} = 'CUSTOM_SKILL' AND
              lower(custom_skill_text) = lower(${input.customSkillText ?? null}::text)))
          LIMIT 1
        `;
        if (duplicate !== undefined) return { status: "STALE_STATE" };
        const [created] = await tx<Array<{ proposedAt: Date }>>`
          INSERT INTO job_participant_capability_claims (
            id, participant_id, kind, profession_taxonomy_release_id,
            profession_code, skill_catalog_release_id, skill_code,
            custom_skill_text, proposed_by_user_id
          ) VALUES (
            ${input.commandId}, ${input.participantId}, ${input.kind},
            ${taxonomyReleaseId}, ${input.professionCode ?? null},
            ${skillReleaseId}, ${input.skillCode ?? null},
            ${input.customSkillText ?? null}, ${input.actorUserId}
          ) RETURNING proposed_at AS "proposedAt"
        `;
        if (created === undefined)
          throw new Error("Capability claim effect missing.");
        return Object.freeze({
          status: "APPLIED" as const,
          claimId: input.commandId,
          claimStatus: "PROPOSED" as const,
          proposedAt: created.proposedAt,
        });
      });
    },

    async confirm(
      input: ConfirmJobParticipantCapabilityInput,
    ): Promise<ConfirmJobParticipantCapabilityResult> {
      validIds(
        input.actorUserId,
        input.commandId,
        input.participantId,
        input.claimId,
      );
      return transaction(sql, async (tx) => {
        await commandLock(tx, input.commandId);
        const party = await findParty(
          tx,
          input.participantId,
          input.actorUserId,
        );
        if (party === null) return { status: "NOT_FOUND" };
        await tx`SELECT id FROM jobs WHERE id = ${party.jobId} FOR UPDATE`;
        await tx`SELECT id FROM job_participants WHERE id = ${input.participantId} FOR UPDATE`;
        const [claim] = await tx<
          Array<{ id: string; proposedByUserId: string }>
        >`
          SELECT id, proposed_by_user_id AS "proposedByUserId"
          FROM job_participant_capability_claims
          WHERE id = ${input.claimId} AND participant_id = ${input.participantId}
          FOR UPDATE
        `;
        if (claim === undefined) return { status: "NOT_FOUND" };
        if (
          claim.proposedByUserId === input.actorUserId ||
          !(
            (claim.proposedByUserId === party.providerUserId &&
              input.actorUserId === party.targetUserId) ||
            (claim.proposedByUserId === party.targetUserId &&
              (input.actorUserId === party.providerUserId ||
                party.isResponsible))
          )
        )
          return { status: "NOT_FOUND" };
        const [existing] = await tx<
          Array<{
            claimId: string;
            confirmedByUserId: string;
            confirmedAt: Date;
          }>
        >`
          SELECT claim_id AS "claimId", confirmed_by_user_id AS "confirmedByUserId",
            confirmed_at AS "confirmedAt"
          FROM job_participant_capability_confirmations
          WHERE event_id = ${input.commandId}
        `;
        if (existing !== undefined) {
          if (existing.confirmedByUserId !== input.actorUserId)
            return { status: "NOT_FOUND" };
          if (existing.claimId !== input.claimId)
            throw new JobParticipantCapabilityIdempotencyError(
              "Capability confirmation ID reused.",
            );
          return Object.freeze({
            status: "DEDUPLICATED" as const,
            claimId: input.claimId,
            claimStatus: "CONFIRMED" as const,
            confirmedAt: existing.confirmedAt,
          });
        }
        if (!(await isActive(tx, input.participantId, party.jobId)))
          return { status: "STALE_STATE" };
        const [prior] = await tx<Array<{ eventId: string }>>`
          SELECT event_id AS "eventId" FROM job_participant_capability_confirmations
          WHERE claim_id = ${input.claimId}
        `;
        if (prior !== undefined) return { status: "STALE_STATE" };
        const [created] = await tx<Array<{ confirmedAt: Date }>>`
          INSERT INTO job_participant_capability_confirmations (
            event_id, claim_id, confirmed_by_user_id
          ) VALUES (${input.commandId}, ${input.claimId}, ${input.actorUserId})
          RETURNING confirmed_at AS "confirmedAt"
        `;
        if (created === undefined)
          throw new Error("Capability confirmation effect missing.");
        return Object.freeze({
          status: "APPLIED" as const,
          claimId: input.claimId,
          claimStatus: "CONFIRMED" as const,
          confirmedAt: created.confirmedAt,
        });
      });
    },
  });
}

function validateProposal(input: ProposeJobParticipantCapabilityInput): void {
  validIds(input.actorUserId, input.commandId, input.participantId);
  if (
    (input.kind === "PROFESSION" &&
      professionCode.test(input.professionCode ?? "") &&
      input.skillCode === undefined &&
      input.customSkillText === undefined) ||
    (input.kind === "CANONICAL_SKILL" &&
      skillCode.test(input.skillCode ?? "") &&
      input.professionCode === undefined &&
      input.customSkillText === undefined) ||
    (input.kind === "CUSTOM_SKILL" &&
      input.professionCode === undefined &&
      input.skillCode === undefined &&
      typeof input.customSkillText === "string" &&
      input.customSkillText === input.customSkillText.trim() &&
      input.customSkillText.length >= 2 &&
      input.customSkillText.length <= 160 &&
      !unsafeCustom.test(input.customSkillText))
  )
    return;
  throw new TypeError("Invalid Job participant capability.");
}

function validIds(...ids: readonly string[]): void {
  if (ids.some((id) => !uuid.test(id)))
    throw new TypeError("Invalid capability identifier.");
}

function validateItem(row: CapabilityRow): CapabilityRow {
  if (
    !uuid.test(row.claimId) ||
    !uuid.test(row.participantId) ||
    !uuid.test(row.proposedByUserId) ||
    !(row.proposedAt instanceof Date) ||
    !Number.isFinite(row.proposedAt.getTime()) ||
    !["PROFESSION", "CANONICAL_SKILL", "CUSTOM_SKILL"].includes(row.kind) ||
    !["PROPOSED", "CONFIRMED"].includes(row.status) ||
    (row.confirmedAt !== null &&
      (!(row.confirmedAt instanceof Date) ||
        !Number.isFinite(row.confirmedAt.getTime()))) ||
    (row.confirmedByUserId !== null && !uuid.test(row.confirmedByUserId))
  )
    throw new Error("Invalid Job capability provenance.");
  return Object.freeze(row);
}

async function findParty(
  tx: TransactionSql,
  participantId: string,
  actorUserId: string,
): Promise<CapabilityViewer | null> {
  const [party] = await tx<CapabilityViewer[]>`
    SELECT participant.job_id AS "jobId",
      provider.owner_user_id AS "providerUserId",
      target.owner_user_id AS "targetUserId",
      EXISTS (
        SELECT 1 FROM job_participant_role_intervals role_interval
        JOIN current_job_participants responsible
          ON responsible.id = role_interval.participant_id
        JOIN craftsman_profiles responsible_profile
          ON responsible_profile.id = responsible.craftsman_profile_id
        WHERE responsible.job_id = job.id
          AND responsible_profile.owner_user_id = actor.id
          AND role_interval.active
          AND role_interval.role IN ('LEAD', 'SITE_MANAGER')
      ) AS "isResponsible"
    FROM job_participants participant
    JOIN jobs job ON job.id = participant.job_id
    JOIN job_acceptance_events accepted ON accepted.job_id = job.id
    JOIN job_agreement_snapshots snapshot ON snapshot.job_id = job.id
    JOIN craftsman_profiles target ON target.id = participant.craftsman_profile_id
    JOIN craftsman_profiles provider ON provider.id = job.primary_craftsman_profile_id
    JOIN users actor ON actor.id = ${actorUserId}
    JOIN auth_credentials credential ON credential.user_id = actor.id
    WHERE participant.id = ${participantId}
      AND actor.account_state = 'ACTIVE'
      AND credential.email_verified_at IS NOT NULL
      AND credential.phone_verified_at IS NOT NULL
      AND (actor.id IN (target.owner_user_id, provider.owner_user_id)
        OR EXISTS (
          SELECT 1 FROM job_participant_role_intervals role_interval
          JOIN current_job_participants responsible
            ON responsible.id = role_interval.participant_id
          JOIN craftsman_profiles responsible_profile
            ON responsible_profile.id = responsible.craftsman_profile_id
          WHERE responsible.job_id = job.id
            AND responsible_profile.owner_user_id = actor.id
            AND role_interval.active
            AND role_interval.role IN ('LEAD', 'SITE_MANAGER')
        ))
  `;
  return party ?? null;
}

async function isActive(
  tx: TransactionSql,
  participantId: string,
  jobId: string,
): Promise<boolean> {
  const [active] = await tx<Array<{ id: string }>>`
    SELECT participant.id FROM current_job_participants participant
    JOIN current_job_states state ON state.job_id = participant.job_id
    JOIN jobs job ON job.id = participant.job_id
    JOIN craftsman_profiles target ON target.id = participant.craftsman_profile_id
    JOIN craftsman_profiles provider ON provider.id = job.primary_craftsman_profile_id
    WHERE participant.id = ${participantId} AND participant.job_id = ${jobId}
      AND participant.state = 'ACCEPTED'
      AND state.state IN ('CONFIRMED', 'IN_PROGRESS')
      AND target.owner_user_id <> provider.owner_user_id
  `;
  return active !== undefined;
}

async function commandLock(
  tx: TransactionSql,
  commandId: string,
): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${commandId}::text, 51011))`;
}

function transaction<T>(
  sql: RootSql,
  callback: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return ("savepoint" in sql
    ? sql.savepoint(callback)
    : sql.begin(callback)) as unknown as Promise<T>;
}
