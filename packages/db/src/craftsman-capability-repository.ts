import { createHash } from "node:crypto";

import {
  assertAddCraftsmanSkillInput,
  assertAddCraftsmanSpecializationInput,
  assertCraftsmanCapabilityListInput,
  assertDeactivateCraftsmanCapabilityInput,
  assertMapCustomCraftsmanSkillInput,
  type AddCraftsmanSkillInput,
  type AddCraftsmanSpecializationInput,
  type CraftsmanCapabilityPersistence,
  type CraftsmanProfessionId,
  type CraftsmanProfileId,
  type CraftsmanSkill,
  type CraftsmanSkillId,
  type CraftsmanSpecialization,
  type CraftsmanSpecializationId,
  type DeactivateCraftsmanCapabilityInput,
  type MapCustomCraftsmanSkillInput,
  type UserId,
} from "@portal/domain";
import type { Sql, TransactionSql } from "postgres";

type SpecializationCommandKind = "ADD" | "DEACTIVATE";
type SkillCommandKind = "ADD" | "MAP_CUSTOM" | "DEACTIVATE";

interface OwnedProfileRow {
  readonly accountState: string;
  readonly ownerUserId: UserId;
}

interface SpecializationRow {
  readonly craftsmanProfessionId: CraftsmanProfessionId;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly createdAt: Date;
  readonly deactivatedAt: Date | null;
  readonly declarationSource: "CRAFTSMAN";
  readonly evidenceSupportedAt: Date | null;
  readonly id: CraftsmanSpecializationId;
  readonly specializationCode: string;
  readonly state: "ACTIVE" | "INACTIVE";
  readonly taxonomyReleaseId: string;
}

interface SkillRow {
  readonly canonicalSkillCode: string | null;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly createdAt: Date;
  readonly deactivatedAt: Date | null;
  readonly declarationSource: "CRAFTSMAN";
  readonly evidenceSupportedAt: Date | null;
  readonly id: CraftsmanSkillId;
  readonly identityKind: "CANONICAL" | "CUSTOM";
  readonly mappedCanonicalSkillCode: string | null;
  readonly mappedSkillCatalogReleaseId: string | null;
  readonly mappingRevision: number;
  readonly professionIds: readonly CraftsmanProfessionId[];
  readonly rankingSignal: "NONE";
  readonly retainedCustomText: string | null;
  readonly skillCatalogReleaseId: string | null;
  readonly state: "ACTIVE" | "INACTIVE";
}

interface SpecializationCommandRow {
  readonly actorUserId: UserId;
  readonly commandKind: SpecializationCommandKind;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly craftsmanSpecializationId: CraftsmanSpecializationId;
  readonly payloadFingerprint: string;
}

interface SkillCommandRow {
  readonly actorUserId: UserId;
  readonly commandKind: SkillCommandKind;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly craftsmanSkillId: CraftsmanSkillId;
  readonly payloadFingerprint: string;
}

export class CraftsmanCapabilityIdempotencyError extends Error {
  readonly code = "CRAFTSMAN_CAPABILITY_IDEMPOTENCY_CONFLICT";
}

export function createCraftsmanCapabilityRepository(
  sql: Sql,
): CraftsmanCapabilityPersistence {
  return Object.freeze({
    addSpecialization(input: AddCraftsmanSpecializationInput) {
      assertAddCraftsmanSpecializationInput(input);
      return sql.begin(async (transaction) => {
        if (!(await lockOwnedProfile(transaction, input))) {
          return { status: "PROFILE_UNAVAILABLE" } as const;
        }
        const fingerprint = fingerprintSpecialization("ADD", input);
        const replay = await findSpecializationCommand(
          transaction,
          input.commandId,
        );
        if (replay !== undefined) {
          assertSpecializationReplay(replay, "ADD", input, fingerprint);
          return specializationResult(
            transaction,
            input.craftsmanSpecializationId,
            "DEDUPLICATED",
          );
        }
        const [profession] = await transaction<
          {
            readonly professionCode: string;
            readonly state: string;
            readonly taxonomyReleaseId: string;
          }[]
        >`
          SELECT profession_code AS "professionCode", state,
            taxonomy_release_id AS "taxonomyReleaseId"
          FROM craftsman_professions
          WHERE id = ${input.craftsmanProfessionId}
            AND craftsman_profile_id = ${input.craftsmanProfileId}
          FOR UPDATE
        `;
        if (
          profession?.state !== "ACTIVE" ||
          profession.taxonomyReleaseId !== input.taxonomyReleaseId
        ) {
          return { status: "PROFESSION_NOT_ACTIVE" } as const;
        }
        const [specialization] = await transaction<
          { readonly state: string }[]
        >`
          SELECT specialization.state
          FROM taxonomy_specializations specialization
          JOIN profession_taxonomy_releases release
            ON release.release_id = specialization.release_id
          WHERE specialization.release_id = ${input.taxonomyReleaseId}
            AND specialization.specialization_code = ${input.specializationCode}
            AND specialization.profession_code = ${profession.professionCode}
            AND release.content_class = 'CANONICAL'
            AND release.review_state = 'HUMAN_REVIEW_APPROVED'
        `;
        if (specialization?.state !== "ACTIVE") {
          return { status: "SPECIALIZATION_NOT_ACTIVE" } as const;
        }
        const [active] = await transaction<{ readonly id: string }[]>`
          SELECT id FROM craftsman_specializations
          WHERE craftsman_profile_id = ${input.craftsmanProfileId}
            AND specialization_code = ${input.specializationCode}
            AND state = 'ACTIVE'
        `;
        if (active !== undefined) return { status: "ALREADY_ACTIVE" } as const;
        await transaction`
          INSERT INTO craftsman_specializations (
            id, craftsman_profile_id, craftsman_profession_id,
            taxonomy_release_id, specialization_code, created_by_user_id
          ) VALUES (
            ${input.craftsmanSpecializationId}, ${input.craftsmanProfileId},
            ${input.craftsmanProfessionId}, ${input.taxonomyReleaseId},
            ${input.specializationCode}, ${input.actorUserId}
          )
        `;
        await insertSpecializationCommand(
          transaction,
          "ADD",
          input,
          fingerprint,
        );
        return specializationResult(
          transaction,
          input.craftsmanSpecializationId,
          "APPLIED",
        );
      });
    },

    addSkill(input: AddCraftsmanSkillInput) {
      assertAddCraftsmanSkillInput(input);
      return sql.begin(async (transaction) => {
        if (!(await lockOwnedProfile(transaction, input))) {
          return { status: "PROFILE_UNAVAILABLE" } as const;
        }
        const fingerprint = fingerprintSkill("ADD", input);
        const replay = await findSkillCommand(transaction, input.commandId);
        if (replay !== undefined) {
          assertSkillReplay(replay, "ADD", input, fingerprint);
          return skillResult(
            transaction,
            input.craftsmanSkillId,
            "DEDUPLICATED",
          );
        }
        const professions = await lockProfessions(
          transaction,
          input.craftsmanProfileId,
          input.professionIds,
        );
        if (professions.length !== input.professionIds.length) {
          return { status: "PROFESSION_NOT_ACTIVE" } as const;
        }
        if (input.identityKind === "CANONICAL") {
          const validation = await validateCanonicalSkill(
            transaction,
            input.skillCatalogReleaseId,
            input.canonicalSkillCode,
            professions,
          );
          if (validation !== "VALID") return { status: validation } as const;
        }
        const [alreadyActive] = await transaction<{ readonly id: string }[]>`
          SELECT id FROM craftsman_skills
          WHERE craftsman_profile_id = ${input.craftsmanProfileId}
            AND state = 'ACTIVE'
            AND (
              (${input.identityKind} = 'CANONICAL'
                AND identity_kind = 'CANONICAL'
                AND skill_catalog_release_id = ${input.identityKind === "CANONICAL" ? input.skillCatalogReleaseId : null}
                AND canonical_skill_code = ${input.identityKind === "CANONICAL" ? input.canonicalSkillCode : null})
              OR (${input.identityKind} = 'CUSTOM'
                AND identity_kind = 'CUSTOM'
                AND retained_custom_text = ${input.identityKind === "CUSTOM" ? input.customText : null})
            )
        `;
        if (alreadyActive !== undefined) {
          return { status: "ALREADY_ACTIVE" } as const;
        }
        await transaction`
          INSERT INTO craftsman_skills (
            id, craftsman_profile_id, identity_kind,
            skill_catalog_release_id, canonical_skill_code,
            retained_custom_text, created_by_user_id
          ) VALUES (
            ${input.craftsmanSkillId}, ${input.craftsmanProfileId},
            ${input.identityKind},
            ${input.identityKind === "CANONICAL" ? input.skillCatalogReleaseId : null},
            ${input.identityKind === "CANONICAL" ? input.canonicalSkillCode : null},
            ${input.identityKind === "CUSTOM" ? input.customText : null},
            ${input.actorUserId}
          )
        `;
        for (const professionId of [...input.professionIds].sort()) {
          await transaction`
            INSERT INTO craftsman_skill_profession_links (
              craftsman_skill_id, craftsman_profession_id
            ) VALUES (${input.craftsmanSkillId}, ${professionId})
          `;
        }
        await insertSkillCommand(transaction, "ADD", input, fingerprint);
        return skillResult(transaction, input.craftsmanSkillId, "APPLIED");
      });
    },

    deactivateSpecialization(input: DeactivateCraftsmanCapabilityInput) {
      assertDeactivateCraftsmanCapabilityInput(input);
      return deactivateSpecialization(sql, input);
    },

    deactivateSkill(input: DeactivateCraftsmanCapabilityInput) {
      assertDeactivateCraftsmanCapabilityInput(input);
      return deactivateSkill(sql, input);
    },

    mapCustomSkill(input: MapCustomCraftsmanSkillInput) {
      assertMapCustomCraftsmanSkillInput(input);
      return sql.begin(async (transaction) => {
        if (!(await lockOwnedProfile(transaction, input))) {
          return { status: "PROFILE_UNAVAILABLE" } as const;
        }
        const fingerprint = fingerprintSkill("MAP_CUSTOM", input);
        const replay = await findSkillCommand(transaction, input.commandId);
        if (replay !== undefined) {
          assertSkillReplay(replay, "MAP_CUSTOM", input, fingerprint);
          return skillResult(
            transaction,
            input.craftsmanSkillId,
            "DEDUPLICATED",
          );
        }
        const current = await getSkill(transaction, input.craftsmanSkillId);
        if (
          current === undefined ||
          current.craftsmanProfileId !== input.craftsmanProfileId ||
          current.state !== "ACTIVE"
        ) {
          return { status: "TARGET_NOT_ACTIVE" } as const;
        }
        if (current.identityKind !== "CUSTOM") {
          return { status: "NOT_CUSTOM" } as const;
        }
        if (current.mappingRevision !== input.expectedMappingRevision) {
          return { status: "STALE_REVISION" } as const;
        }
        if (
          current.mappedSkillCatalogReleaseId === input.skillCatalogReleaseId &&
          current.mappedCanonicalSkillCode === input.canonicalSkillCode
        ) {
          return { status: "MAPPING_UNCHANGED" } as const;
        }
        const professions = await lockProfessions(
          transaction,
          input.craftsmanProfileId,
          current.professionIds,
        );
        if (professions.length !== current.professionIds.length) {
          return { status: "TARGET_NOT_ACTIVE" } as const;
        }
        const validation = await validateCanonicalSkill(
          transaction,
          input.skillCatalogReleaseId,
          input.canonicalSkillCode,
          professions,
        );
        if (validation !== "VALID") return { status: validation } as const;
        await insertSkillCommand(transaction, "MAP_CUSTOM", input, fingerprint);
        await transaction`
          INSERT INTO craftsman_custom_skill_mapping_events (
            event_id, command_id, craftsman_skill_id, revision,
            skill_catalog_release_id, canonical_skill_code, actor_user_id
          ) VALUES (
            ${input.commandId}, ${input.commandId}, ${input.craftsmanSkillId},
            ${current.mappingRevision + 1}, ${input.skillCatalogReleaseId},
            ${input.canonicalSkillCode}, ${input.actorUserId}
          )
        `;
        return skillResult(transaction, input.craftsmanSkillId, "APPLIED");
      });
    },

    async listOwned(input: {
      readonly actorUserId: UserId;
      readonly craftsmanProfileId: CraftsmanProfileId;
    }) {
      assertCraftsmanCapabilityListInput(input);
      const [owned] = await sql<OwnedProfileRow[]>`
        SELECT profile.owner_user_id AS "ownerUserId",
          owner.account_state AS "accountState"
        FROM craftsman_profiles profile JOIN users owner ON owner.id = profile.owner_user_id
        WHERE profile.id = ${input.craftsmanProfileId}
          AND profile.owner_user_id = ${input.actorUserId}
      `;
      if (owned?.accountState !== "ACTIVE") {
        return Object.freeze({
          skills: Object.freeze([]),
          specializations: Object.freeze([]),
        });
      }
      const specializations = await selectSpecializations(
        sql,
        input.craftsmanProfileId,
      );
      const skills = await selectSkills(sql, input.craftsmanProfileId);
      return Object.freeze({
        skills: Object.freeze(skills.map(freezeSkill)),
        specializations: Object.freeze(
          specializations.map(freezeSpecialization),
        ),
      });
    },
  });
}

async function deactivateSpecialization(
  sql: Sql,
  input: DeactivateCraftsmanCapabilityInput,
) {
  return sql.begin(async (transaction) => {
    if (!(await lockOwnedProfile(transaction, input)))
      return { status: "PROFILE_UNAVAILABLE" } as const;
    const id = input.targetId as CraftsmanSpecializationId;
    const fingerprint = fingerprintSpecialization("DEACTIVATE", input);
    const replay = await findSpecializationCommand(
      transaction,
      input.commandId,
    );
    if (replay !== undefined) {
      assertSpecializationReplay(
        replay,
        "DEACTIVATE",
        { ...input, craftsmanSpecializationId: id },
        fingerprint,
      );
      return specializationResult(transaction, id, "DEDUPLICATED");
    }
    const [claim] = await transaction<{ readonly state: string }[]>`
      SELECT state FROM craftsman_specializations WHERE id = ${id}
        AND craftsman_profile_id = ${input.craftsmanProfileId} FOR UPDATE
    `;
    if (claim?.state !== "ACTIVE")
      return { status: "TARGET_NOT_ACTIVE" } as const;
    await insertSpecializationCommand(
      transaction,
      "DEACTIVATE",
      { ...input, craftsmanSpecializationId: id },
      fingerprint,
    );
    await transaction`
      UPDATE craftsman_specializations SET state = 'INACTIVE',
        deactivated_by_user_id = ${input.actorUserId}, deactivation_command_id = ${input.commandId}
      WHERE id = ${id}
    `;
    return specializationResult(transaction, id, "APPLIED");
  });
}

async function deactivateSkill(
  sql: Sql,
  input: DeactivateCraftsmanCapabilityInput,
) {
  return sql.begin(async (transaction) => {
    if (!(await lockOwnedProfile(transaction, input)))
      return { status: "PROFILE_UNAVAILABLE" } as const;
    const id = input.targetId as CraftsmanSkillId;
    const fingerprint = fingerprintSkill("DEACTIVATE", input);
    const replay = await findSkillCommand(transaction, input.commandId);
    if (replay !== undefined) {
      assertSkillReplay(
        replay,
        "DEACTIVATE",
        { ...input, craftsmanSkillId: id },
        fingerprint,
      );
      return skillResult(transaction, id, "DEDUPLICATED");
    }
    const [claim] = await transaction<{ readonly state: string }[]>`
      SELECT state FROM craftsman_skills WHERE id = ${id}
        AND craftsman_profile_id = ${input.craftsmanProfileId} FOR UPDATE
    `;
    if (claim?.state !== "ACTIVE")
      return { status: "TARGET_NOT_ACTIVE" } as const;
    await insertSkillCommand(
      transaction,
      "DEACTIVATE",
      { ...input, craftsmanSkillId: id },
      fingerprint,
    );
    await transaction`
      UPDATE craftsman_skills SET state = 'INACTIVE',
        deactivated_by_user_id = ${input.actorUserId}, deactivation_command_id = ${input.commandId}
      WHERE id = ${id}
    `;
    return skillResult(transaction, id, "APPLIED");
  });
}

async function lockOwnedProfile(
  transaction: TransactionSql,
  input: {
    readonly actorUserId: UserId;
    readonly craftsmanProfileId: CraftsmanProfileId;
  },
): Promise<boolean> {
  const [profile] = await transaction<OwnedProfileRow[]>`
    SELECT profile.owner_user_id AS "ownerUserId", owner.account_state AS "accountState"
    FROM craftsman_profiles profile JOIN users owner ON owner.id = profile.owner_user_id
    WHERE profile.id = ${input.craftsmanProfileId} FOR UPDATE OF profile, owner
  `;
  return (
    profile?.ownerUserId === input.actorUserId &&
    profile.accountState === "ACTIVE"
  );
}

interface ProfessionRow {
  readonly id: CraftsmanProfessionId;
  readonly professionCode: string;
  readonly taxonomyReleaseId: string;
}
async function lockProfessions(
  transaction: TransactionSql,
  profileId: CraftsmanProfileId,
  ids: readonly CraftsmanProfessionId[],
): Promise<readonly ProfessionRow[]> {
  return transaction<ProfessionRow[]>`
    SELECT id, profession_code AS "professionCode", taxonomy_release_id AS "taxonomyReleaseId"
    FROM craftsman_professions WHERE craftsman_profile_id = ${profileId}
      AND id = ANY(${[...ids]}::uuid[]) AND state = 'ACTIVE' ORDER BY id FOR UPDATE
  `;
}

async function validateCanonicalSkill(
  transaction: TransactionSql,
  releaseId: string,
  code: string,
  professions: readonly ProfessionRow[],
): Promise<"VALID" | "SKILL_NOT_ACTIVE" | "SKILL_NOT_RELEVANT"> {
  const [skill] = await transaction<{ readonly state: string }[]>`
    SELECT state FROM current_skill_catalog WHERE release_id = ${releaseId} AND skill_code = ${code}
  `;
  if (skill?.state !== "ACTIVE") return "SKILL_NOT_ACTIVE";
  const relations = await transaction<
    {
      readonly professionCode: string;
      readonly professionTaxonomyReleaseId: string;
    }[]
  >`
    SELECT profession_code AS "professionCode",
      profession_taxonomy_release_id AS "professionTaxonomyReleaseId"
    FROM current_skill_catalog_professions WHERE release_id = ${releaseId} AND skill_code = ${code}
  `;
  const keys = new Set(
    relations.map(
      (row) => `${row.professionTaxonomyReleaseId}:${row.professionCode}`,
    ),
  );
  return professions.every((row) =>
    keys.has(`${row.taxonomyReleaseId}:${row.professionCode}`),
  )
    ? "VALID"
    : "SKILL_NOT_RELEVANT";
}

async function findSpecializationCommand(
  transaction: TransactionSql,
  commandId: string,
): Promise<SpecializationCommandRow | undefined> {
  const [row] = await transaction<SpecializationCommandRow[]>`
    SELECT command_kind AS "commandKind", craftsman_specialization_id AS "craftsmanSpecializationId",
      craftsman_profile_id AS "craftsmanProfileId", actor_user_id AS "actorUserId",
      payload_fingerprint AS "payloadFingerprint"
    FROM craftsman_specialization_commands WHERE command_id = ${commandId}
  `;
  return row;
}

async function findSkillCommand(
  transaction: TransactionSql,
  commandId: string,
): Promise<SkillCommandRow | undefined> {
  const [row] = await transaction<SkillCommandRow[]>`
    SELECT command_kind AS "commandKind", craftsman_skill_id AS "craftsmanSkillId",
      craftsman_profile_id AS "craftsmanProfileId", actor_user_id AS "actorUserId",
      payload_fingerprint AS "payloadFingerprint"
    FROM craftsman_skill_commands WHERE command_id = ${commandId}
  `;
  return row;
}

function assertSpecializationReplay(
  row: SpecializationCommandRow,
  kind: SpecializationCommandKind,
  input: {
    readonly actorUserId: UserId;
    readonly craftsmanProfileId: CraftsmanProfileId;
    readonly craftsmanSpecializationId: CraftsmanSpecializationId;
  },
  fingerprint: string,
): void {
  if (
    row.commandKind !== kind ||
    row.actorUserId !== input.actorUserId ||
    row.craftsmanProfileId !== input.craftsmanProfileId ||
    row.craftsmanSpecializationId !== input.craftsmanSpecializationId ||
    row.payloadFingerprint !== fingerprint
  )
    throw new CraftsmanCapabilityIdempotencyError(
      "Specialization command id was reused with different intent.",
    );
}
function assertSkillReplay(
  row: SkillCommandRow,
  kind: SkillCommandKind,
  input: {
    readonly actorUserId: UserId;
    readonly craftsmanProfileId: CraftsmanProfileId;
    readonly craftsmanSkillId: CraftsmanSkillId;
  },
  fingerprint: string,
): void {
  if (
    row.commandKind !== kind ||
    row.actorUserId !== input.actorUserId ||
    row.craftsmanProfileId !== input.craftsmanProfileId ||
    row.craftsmanSkillId !== input.craftsmanSkillId ||
    row.payloadFingerprint !== fingerprint
  )
    throw new CraftsmanCapabilityIdempotencyError(
      "Skill command id was reused with different intent.",
    );
}

async function insertSpecializationCommand(
  transaction: TransactionSql,
  kind: SpecializationCommandKind,
  input: {
    readonly commandId: string;
    readonly actorUserId: UserId;
    readonly craftsmanProfileId: CraftsmanProfileId;
    readonly craftsmanSpecializationId: CraftsmanSpecializationId;
  },
  fingerprint: string,
): Promise<void> {
  await transaction`INSERT INTO craftsman_specialization_commands (
    command_id, command_kind, craftsman_specialization_id, craftsman_profile_id,
    actor_user_id, payload_fingerprint
  ) VALUES (${input.commandId}, ${kind}, ${input.craftsmanSpecializationId},
    ${input.craftsmanProfileId}, ${input.actorUserId}, ${fingerprint})`;
}
async function insertSkillCommand(
  transaction: TransactionSql,
  kind: SkillCommandKind,
  input: {
    readonly commandId: string;
    readonly actorUserId: UserId;
    readonly craftsmanProfileId: CraftsmanProfileId;
    readonly craftsmanSkillId: CraftsmanSkillId;
  },
  fingerprint: string,
): Promise<void> {
  await transaction`INSERT INTO craftsman_skill_commands (
    command_id, command_kind, craftsman_skill_id, craftsman_profile_id,
    actor_user_id, payload_fingerprint
  ) VALUES (${input.commandId}, ${kind}, ${input.craftsmanSkillId},
    ${input.craftsmanProfileId}, ${input.actorUserId}, ${fingerprint})`;
}

function fingerprintSpecialization(
  kind: SpecializationCommandKind,
  input: object,
): string {
  return fingerprint(kind, input);
}
function fingerprintSkill(kind: SkillCommandKind, input: object): string {
  return fingerprint(kind, input);
}
function fingerprint(kind: string, input: object): string {
  const value = input as Record<string, unknown>;
  const normalized = {
    ...value,
    professionIds: Array.isArray(value.professionIds)
      ? Array.from(value.professionIds, (id: unknown) => String(id)).sort()
      : undefined,
  };
  return createHash("sha256")
    .update(JSON.stringify([kind, normalized]), "utf8")
    .digest("hex");
}

async function specializationResult(
  transaction: TransactionSql,
  id: CraftsmanSpecializationId,
  status: "APPLIED" | "DEDUPLICATED",
): Promise<{
  readonly specialization: CraftsmanSpecialization;
  readonly status: "APPLIED" | "DEDUPLICATED";
}> {
  const [row] = await transaction<
    SpecializationRow[]
  >`SELECT * FROM current_craftsman_specializations WHERE id = ${id}`;
  if (row === undefined)
    throw new Error("Committed specialization projection is missing.");
  return { specialization: freezeSpecialization(row), status };
}
async function skillResult(
  transaction: TransactionSql,
  id: CraftsmanSkillId,
  status: "APPLIED" | "DEDUPLICATED",
): Promise<{
  readonly skill: CraftsmanSkill;
  readonly status: "APPLIED" | "DEDUPLICATED";
}> {
  const row = await getSkill(transaction, id);
  if (row === undefined)
    throw new Error("Committed skill projection is missing.");
  return { skill: freezeSkill(row), status };
}
async function getSkill(
  sql: TransactionSql,
  id: CraftsmanSkillId,
): Promise<SkillRow | undefined> {
  const [row] = await sql<SkillRow[]>`
    SELECT id, craftsman_profile_id AS "craftsmanProfileId", identity_kind AS "identityKind",
      skill_catalog_release_id AS "skillCatalogReleaseId", canonical_skill_code AS "canonicalSkillCode",
      retained_custom_text AS "retainedCustomText", mapped_skill_catalog_release_id AS "mappedSkillCatalogReleaseId",
      mapped_canonical_skill_code AS "mappedCanonicalSkillCode", mapping_revision AS "mappingRevision",
      profession_ids AS "professionIds", state, declaration_source AS "declarationSource",
      evidence_supported_at AS "evidenceSupportedAt", ranking_signal AS "rankingSignal",
      created_at AS "createdAt", deactivated_at AS "deactivatedAt"
    FROM current_craftsman_skills WHERE id = ${id}
  `;
  return row;
}
async function selectSkills(
  sql: Sql,
  profileId: CraftsmanProfileId,
): Promise<readonly SkillRow[]> {
  return sql<SkillRow[]>`
  SELECT id, craftsman_profile_id AS "craftsmanProfileId", identity_kind AS "identityKind",
    skill_catalog_release_id AS "skillCatalogReleaseId", canonical_skill_code AS "canonicalSkillCode",
    retained_custom_text AS "retainedCustomText", mapped_skill_catalog_release_id AS "mappedSkillCatalogReleaseId",
    mapped_canonical_skill_code AS "mappedCanonicalSkillCode", mapping_revision AS "mappingRevision",
    profession_ids AS "professionIds", state, declaration_source AS "declarationSource",
    evidence_supported_at AS "evidenceSupportedAt", ranking_signal AS "rankingSignal",
    created_at AS "createdAt", deactivated_at AS "deactivatedAt"
  FROM current_craftsman_skills WHERE craftsman_profile_id = ${profileId} ORDER BY created_at, id`;
}
async function selectSpecializations(
  sql: Sql,
  profileId: CraftsmanProfileId,
): Promise<readonly SpecializationRow[]> {
  return sql<SpecializationRow[]>`
  SELECT id, craftsman_profile_id AS "craftsmanProfileId", craftsman_profession_id AS "craftsmanProfessionId",
    taxonomy_release_id AS "taxonomyReleaseId", specialization_code AS "specializationCode", state,
    declaration_source AS "declarationSource", evidence_supported_at AS "evidenceSupportedAt",
    created_at AS "createdAt", deactivated_at AS "deactivatedAt"
  FROM current_craftsman_specializations WHERE craftsman_profile_id = ${profileId} ORDER BY created_at, id`;
}
function freezeSpecialization(row: SpecializationRow): CraftsmanSpecialization {
  return Object.freeze({
    ...row,
    evidence:
      row.evidenceSupportedAt === null
        ? null
        : Object.freeze({
            status: "SUPPORTED_BY_EVIDENCE" as const,
            supportedAt: row.evidenceSupportedAt,
          }),
  });
}
function freezeSkill(row: SkillRow): CraftsmanSkill {
  return Object.freeze({
    canonicalSkillCode: row.canonicalSkillCode,
    craftsmanProfileId: row.craftsmanProfileId,
    createdAt: row.createdAt,
    deactivatedAt: row.deactivatedAt,
    declarationSource: row.declarationSource,
    evidence:
      row.evidenceSupportedAt === null
        ? null
        : Object.freeze({
            status: "SUPPORTED_BY_EVIDENCE" as const,
            supportedAt: row.evidenceSupportedAt,
          }),
    id: row.id,
    identityKind: row.identityKind,
    mappedCanonicalSkillCode: row.mappedCanonicalSkillCode,
    mappedSkillCatalogReleaseId: row.mappedSkillCatalogReleaseId,
    mappingRevision: row.mappingRevision,
    professionIds: Object.freeze([...row.professionIds]),
    rankingSignal: row.rankingSignal,
    retainedCustomText: row.retainedCustomText,
    state: row.state,
    skillCatalogReleaseId: row.skillCatalogReleaseId,
  });
}
