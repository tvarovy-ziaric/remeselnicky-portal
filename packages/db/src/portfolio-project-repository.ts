import { createHash } from "node:crypto";

import {
  assertChangePortfolioProjectStateInput,
  assertCreatePortfolioProjectInput,
  assertEditPortfolioProjectInput,
  assertPortfolioProjectListInput,
  type ChangePortfolioProjectStateInput,
  type CraftsmanProfessionId,
  type CraftsmanProfileId,
  type CraftsmanSkillId,
  type CraftsmanSpecializationId,
  type CreatePortfolioProjectInput,
  type EditPortfolioProjectInput,
  type PortfolioProject,
  type PortfolioProjectContent,
  type PortfolioProjectId,
  type PortfolioProjectPersistence,
  type PortfolioProjectRecordState,
  type UserId,
} from "@portal/domain";
import type { Sql, TransactionSql } from "postgres";

type PortfolioCommandKind =
  "CREATE" | "EDIT" | "HIDE" | "ARCHIVE" | "RESTORE_DRAFT";

interface OwnedProfileRow {
  readonly accountState: string;
  readonly ownerUserId: UserId;
}

interface PortfolioRow {
  readonly authorUserId: UserId;
  readonly contribution: string | null;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly createdAt: Date;
  readonly currency: "EUR";
  readonly districtCode: string | null;
  readonly durationUnit: "DAYS" | "WEEKS" | "MONTHS" | null;
  readonly durationValue: number | null;
  readonly evidenceStatus: "UNVERIFIED";
  readonly id: PortfolioProjectId;
  readonly indicativePriceMaxCents: number | string | null;
  readonly indicativePriceMinCents: number | string | null;
  readonly materialsAndTechnologies: string | null;
  readonly municipalityCode: string | null;
  readonly problem: string | null;
  readonly professionIds: readonly CraftsmanProfessionId[];
  readonly provenanceKind: "SELF_DECLARED";
  readonly recordState: PortfolioProjectRecordState;
  readonly revision: number;
  readonly shortDescription: string;
  readonly skillIds: readonly CraftsmanSkillId[];
  readonly solution: string | null;
  readonly specializationIds: readonly CraftsmanSpecializationId[];
  readonly title: string;
  readonly updatedAt: Date;
}

interface CommandReplayRow {
  readonly actorUserId: UserId;
  readonly commandKind: PortfolioCommandKind;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly payloadFingerprint: string;
  readonly portfolioProjectId: PortfolioProjectId;
  readonly resultingRevision: number;
}

export class PortfolioProjectIdempotencyError extends Error {
  readonly code = "PORTFOLIO_PROJECT_IDEMPOTENCY_CONFLICT";
}

export function createPortfolioProjectRepository(
  sql: Sql,
): PortfolioProjectPersistence {
  return Object.freeze({
    create(input: CreatePortfolioProjectInput) {
      assertCreatePortfolioProjectInput(input);
      const normalized = normalizeContent(input);
      return sql.begin(async (transaction) => {
        if (!(await lockOwnedActiveProfile(transaction, input))) {
          return { status: "PROFILE_UNAVAILABLE" } as const;
        }
        const fingerprint = fingerprintCommand("CREATE", {
          ...input,
          ...normalized,
        });
        const replay = await findCommand(transaction, input.commandId);
        if (replay !== undefined) {
          assertExactReplay(replay, "CREATE", input, fingerprint);
          return deduplicatedRevision(
            transaction,
            input.commandId,
            replay.resultingRevision,
          );
        }
        const [existing] = await transaction<{ readonly id: string }[]>`
          SELECT id FROM portfolio_projects WHERE id = ${input.portfolioProjectId}
        `;
        if (existing !== undefined) {
          return { status: "PROJECT_ALREADY_EXISTS" } as const;
        }
        if (
          !(await tagsAvailable(
            transaction,
            input.craftsmanProfileId,
            normalized,
            undefined,
          ))
        ) {
          return { status: "TAG_UNAVAILABLE" } as const;
        }
        if (!(await locationAvailable(transaction, normalized))) {
          return { status: "LOCATION_UNAVAILABLE" } as const;
        }
        await transaction`
          INSERT INTO portfolio_projects (
            id, craftsman_profile_id, author_user_id, provenance_kind,
            record_state, title, short_description, contribution,
            materials_and_technologies, problem, solution,
            duration_value, duration_unit, indicative_price_min_cents,
            indicative_price_max_cents, currency, municipality_code,
            district_code, profession_ids, skill_ids, specialization_ids,
            revision, latest_command_id
          ) VALUES (
            ${input.portfolioProjectId}, ${input.craftsmanProfileId},
            ${input.actorUserId}, 'SELF_DECLARED', 'DRAFT', ${normalized.title},
            ${normalized.shortDescription}, ${normalized.contribution},
            ${normalized.materialsAndTechnologies}, ${normalized.problem},
            ${normalized.solution}, ${normalized.durationValue},
            ${normalized.durationUnit}, ${normalized.indicativePriceMinCents},
            ${normalized.indicativePriceMaxCents}, 'EUR',
            ${normalized.municipalityCode}, ${normalized.districtCode},
            ${normalized.professionIds}, ${normalized.skillIds},
            ${normalized.specializationIds}, 1, ${input.commandId}
          )
        `;
        await insertCommand(transaction, "CREATE", input, 0, 1, fingerprint);
        await insertRevision(
          transaction,
          input.portfolioProjectId,
          input.commandId,
          input.actorUserId,
        );
        return applied(transaction, input.portfolioProjectId);
      });
    },

    edit(input: EditPortfolioProjectInput) {
      assertEditPortfolioProjectInput(input);
      const normalized = normalizeContent(input);
      return sql.begin(async (transaction) => {
        if (!(await lockOwnedActiveProfile(transaction, input))) {
          return { status: "PROFILE_UNAVAILABLE" } as const;
        }
        const fingerprint = fingerprintCommand("EDIT", {
          ...input,
          ...normalized,
        });
        const replay = await findCommand(transaction, input.commandId);
        if (replay !== undefined) {
          assertExactReplay(replay, "EDIT", input, fingerprint);
          return deduplicatedRevision(
            transaction,
            input.commandId,
            replay.resultingRevision,
          );
        }
        const current = await lockOwnedProject(transaction, input);
        if (current === undefined)
          return { status: "PROJECT_UNAVAILABLE" } as const;
        if (current.recordState === "ARCHIVED")
          return { status: "PROJECT_ARCHIVED" } as const;
        if (current.revision !== input.expectedRevision)
          return { status: "STALE_REVISION" } as const;
        if (
          !(await tagsAvailable(
            transaction,
            input.craftsmanProfileId,
            normalized,
            current,
          ))
        ) {
          return { status: "TAG_UNAVAILABLE" } as const;
        }
        if (!(await locationAvailable(transaction, normalized))) {
          return { status: "LOCATION_UNAVAILABLE" } as const;
        }
        if (contentMatches(current, normalized))
          return { status: "UNCHANGED" } as const;
        const nextRevision = current.revision + 1;
        await insertCommand(
          transaction,
          "EDIT",
          input,
          current.revision,
          nextRevision,
          fingerprint,
        );
        await transaction`
          UPDATE portfolio_projects SET
            title = ${normalized.title}, short_description = ${normalized.shortDescription},
            contribution = ${normalized.contribution},
            materials_and_technologies = ${normalized.materialsAndTechnologies},
            problem = ${normalized.problem}, solution = ${normalized.solution},
            duration_value = ${normalized.durationValue}, duration_unit = ${normalized.durationUnit},
            indicative_price_min_cents = ${normalized.indicativePriceMinCents},
            indicative_price_max_cents = ${normalized.indicativePriceMaxCents},
            municipality_code = ${normalized.municipalityCode}, district_code = ${normalized.districtCode},
            profession_ids = ${normalized.professionIds}, skill_ids = ${normalized.skillIds},
            specialization_ids = ${normalized.specializationIds}, revision = ${nextRevision},
            latest_command_id = ${input.commandId}
          WHERE id = ${input.portfolioProjectId}
            AND craftsman_profile_id = ${input.craftsmanProfileId}
            AND revision = ${current.revision}
        `;
        await insertRevision(
          transaction,
          input.portfolioProjectId,
          input.commandId,
          input.actorUserId,
        );
        return applied(transaction, input.portfolioProjectId);
      });
    },

    hide(input: ChangePortfolioProjectStateInput) {
      assertChangePortfolioProjectStateInput(input);
      return changeState(sql, "HIDE", "HIDDEN", input);
    },
    archive(input: ChangePortfolioProjectStateInput) {
      assertChangePortfolioProjectStateInput(input);
      return changeState(sql, "ARCHIVE", "ARCHIVED", input);
    },
    restoreDraft(input: ChangePortfolioProjectStateInput) {
      assertChangePortfolioProjectStateInput(input);
      return changeState(sql, "RESTORE_DRAFT", "DRAFT", input);
    },

    async listOwned(input: {
      readonly actorUserId: UserId;
      readonly craftsmanProfileId: CraftsmanProfileId;
      readonly includeArchived?: boolean;
    }) {
      assertPortfolioProjectListInput(input);
      const [owned] = await sql<OwnedProfileRow[]>`
        SELECT profile.owner_user_id AS "ownerUserId", owner.account_state AS "accountState"
        FROM craftsman_profiles profile JOIN users owner ON owner.id = profile.owner_user_id
        WHERE profile.id = ${input.craftsmanProfileId}
          AND profile.owner_user_id = ${input.actorUserId}
      `;
      if (owned?.accountState !== "ACTIVE") return Object.freeze([]);
      const rows = await selectProjects(
        sql,
        input.craftsmanProfileId,
        input.includeArchived ?? false,
      );
      return Object.freeze(rows.map(freezeProject));
    },
  });
}

async function changeState(
  sql: Sql,
  kind: "HIDE" | "ARCHIVE" | "RESTORE_DRAFT",
  nextState: PortfolioProjectRecordState,
  input: ChangePortfolioProjectStateInput,
) {
  return sql.begin(async (transaction) => {
    if (!(await lockOwnedActiveProfile(transaction, input)))
      return { status: "PROFILE_UNAVAILABLE" } as const;
    const fingerprint = fingerprintCommand(kind, input);
    const replay = await findCommand(transaction, input.commandId);
    if (replay !== undefined) {
      assertExactReplay(replay, kind, input, fingerprint);
      return deduplicatedRevision(
        transaction,
        input.commandId,
        replay.resultingRevision,
      );
    }
    const current = await lockOwnedProject(transaction, input);
    if (current === undefined)
      return { status: "PROJECT_UNAVAILABLE" } as const;
    if (current.revision !== input.expectedRevision)
      return { status: "STALE_REVISION" } as const;
    const valid =
      (kind === "HIDE" && current.recordState === "DRAFT") ||
      (kind === "ARCHIVE" &&
        (current.recordState === "DRAFT" ||
          current.recordState === "HIDDEN")) ||
      (kind === "RESTORE_DRAFT" &&
        (current.recordState === "HIDDEN" ||
          current.recordState === "ARCHIVED"));
    if (!valid) return { status: "INVALID_STATE" } as const;
    const nextRevision = current.revision + 1;
    await insertCommand(
      transaction,
      kind,
      input,
      current.revision,
      nextRevision,
      fingerprint,
    );
    await transaction`
      UPDATE portfolio_projects SET record_state = ${nextState},
        revision = ${nextRevision}, latest_command_id = ${input.commandId}
      WHERE id = ${input.portfolioProjectId}
        AND craftsman_profile_id = ${input.craftsmanProfileId}
        AND revision = ${current.revision}
    `;
    await insertRevision(
      transaction,
      input.portfolioProjectId,
      input.commandId,
      input.actorUserId,
    );
    return applied(transaction, input.portfolioProjectId);
  });
}

async function lockOwnedActiveProfile(
  transaction: TransactionSql,
  input: {
    readonly actorUserId: UserId;
    readonly craftsmanProfileId: CraftsmanProfileId;
  },
): Promise<boolean> {
  const [row] = await transaction<OwnedProfileRow[]>`
    SELECT profile.owner_user_id AS "ownerUserId", owner.account_state AS "accountState"
    FROM craftsman_profiles profile JOIN users owner ON owner.id = profile.owner_user_id
    WHERE profile.id = ${input.craftsmanProfileId} FOR UPDATE OF profile, owner
  `;
  return (
    row?.ownerUserId === input.actorUserId && row.accountState === "ACTIVE"
  );
}

async function lockOwnedProject(
  transaction: TransactionSql,
  input: {
    readonly craftsmanProfileId: CraftsmanProfileId;
    readonly portfolioProjectId: PortfolioProjectId;
  },
): Promise<PortfolioRow | undefined> {
  const rows = await selectProjectRows(
    transaction,
    input.portfolioProjectId,
    input.craftsmanProfileId,
    true,
  );
  return rows[0];
}

async function tagsAvailable(
  transaction: TransactionSql,
  profileId: CraftsmanProfileId,
  content: PortfolioProjectContent,
  previous: PortfolioRow | undefined,
): Promise<boolean> {
  const [counts] = await transaction<
    {
      readonly professions: number;
      readonly skills: number;
      readonly specializations: number;
    }[]
  >`
    SELECT
      (SELECT count(*)::integer FROM craftsman_professions profession
        WHERE profession.id = ANY(${content.professionIds}::uuid[])
          AND profession.craftsman_profile_id = ${profileId}
          AND (profession.state = 'ACTIVE' OR profession.id = ANY(${previous?.professionIds ?? []}::uuid[]))) AS professions,
      (SELECT count(*)::integer FROM craftsman_skills skill
        WHERE skill.id = ANY(${content.skillIds}::uuid[])
          AND skill.craftsman_profile_id = ${profileId}
          AND (skill.state = 'ACTIVE' OR skill.id = ANY(${previous?.skillIds ?? []}::uuid[]))
          AND EXISTS (SELECT 1 FROM craftsman_skill_profession_links link
            WHERE link.craftsman_skill_id = skill.id
              AND link.craftsman_profession_id = ANY(${content.professionIds}::uuid[]))) AS skills,
      (SELECT count(*)::integer FROM craftsman_specializations specialization
        WHERE specialization.id = ANY(${content.specializationIds}::uuid[])
          AND specialization.craftsman_profile_id = ${profileId}
          AND (specialization.state = 'ACTIVE' OR specialization.id = ANY(${previous?.specializationIds ?? []}::uuid[]))
          AND specialization.craftsman_profession_id = ANY(${content.professionIds}::uuid[])) AS specializations
  `;
  return (
    counts?.professions === content.professionIds.length &&
    counts.skills === content.skillIds.length &&
    counts.specializations === content.specializationIds.length
  );
}

async function locationAvailable(
  transaction: TransactionSql,
  content: PortfolioProjectContent,
): Promise<boolean> {
  if (content.districtCode === null) return content.municipalityCode === null;
  const [row] = await transaction<
    {
      readonly districtActive: boolean;
      readonly municipalityMatches: boolean;
    }[]
  >`
    SELECT district.is_active AS "districtActive",
      (${content.municipalityCode}::text IS NULL OR EXISTS (
        SELECT 1 FROM location_municipalities municipality
        WHERE municipality.code = ${content.municipalityCode}
          AND municipality.district_code = district.code AND municipality.is_active
      )) AS "municipalityMatches"
    FROM location_districts district WHERE district.code = ${content.districtCode}
  `;
  return row?.districtActive === true && row.municipalityMatches;
}

async function findCommand(
  transaction: TransactionSql,
  commandId: string,
): Promise<CommandReplayRow | undefined> {
  const [row] = await transaction<CommandReplayRow[]>`
    SELECT command_kind AS "commandKind", portfolio_project_id AS "portfolioProjectId",
      craftsman_profile_id AS "craftsmanProfileId", actor_user_id AS "actorUserId",
      payload_fingerprint AS "payloadFingerprint",
      resulting_revision AS "resultingRevision"
    FROM portfolio_project_commands WHERE command_id = ${commandId}
  `;
  return row;
}

function assertExactReplay(
  row: CommandReplayRow,
  kind: PortfolioCommandKind,
  input: {
    readonly actorUserId: UserId;
    readonly craftsmanProfileId: CraftsmanProfileId;
    readonly portfolioProjectId: PortfolioProjectId;
  },
  fingerprint: string,
): void {
  if (
    row.commandKind !== kind ||
    row.actorUserId !== input.actorUserId ||
    row.craftsmanProfileId !== input.craftsmanProfileId ||
    row.portfolioProjectId !== input.portfolioProjectId ||
    row.payloadFingerprint !== fingerprint
  ) {
    throw new PortfolioProjectIdempotencyError(
      "Portfolio command id was reused with different intent.",
    );
  }
}

async function insertCommand(
  transaction: TransactionSql,
  kind: PortfolioCommandKind,
  input: {
    readonly actorUserId: UserId;
    readonly commandId: string;
    readonly craftsmanProfileId: CraftsmanProfileId;
    readonly portfolioProjectId: PortfolioProjectId;
  },
  expectedRevision: number,
  resultingRevision: number,
  fingerprint: string,
): Promise<void> {
  await transaction`
    INSERT INTO portfolio_project_commands (
      command_id, command_kind, portfolio_project_id, craftsman_profile_id,
      actor_user_id, expected_revision, resulting_revision, payload_fingerprint
    ) VALUES (${input.commandId}, ${kind}, ${input.portfolioProjectId},
      ${input.craftsmanProfileId}, ${input.actorUserId}, ${expectedRevision},
      ${resultingRevision}, ${fingerprint})
  `;
}

async function insertRevision(
  transaction: TransactionSql,
  projectId: PortfolioProjectId,
  commandId: string,
  actorUserId: UserId,
): Promise<void> {
  await transaction`
    INSERT INTO portfolio_project_revisions (
      event_id, command_id, portfolio_project_id, revision, record_state,
      title, short_description, contribution, materials_and_technologies,
      problem, solution, duration_value, duration_unit,
      indicative_price_min_cents, indicative_price_max_cents, currency,
      municipality_code, district_code, profession_ids, skill_ids,
      specialization_ids, actor_user_id
    ) SELECT ${commandId}, ${commandId}, id, revision, record_state,
      title, short_description, contribution, materials_and_technologies,
      problem, solution, duration_value, duration_unit,
      indicative_price_min_cents, indicative_price_max_cents, currency,
      municipality_code, district_code, profession_ids, skill_ids,
      specialization_ids, ${actorUserId}
    FROM portfolio_projects WHERE id = ${projectId}
  `;
}

function normalizeContent(
  input: PortfolioProjectContent,
): PortfolioProjectContent {
  return Object.freeze({
    contribution: input.contribution,
    districtCode: input.districtCode,
    durationUnit: input.durationUnit,
    durationValue: input.durationValue,
    indicativePriceMaxCents: input.indicativePriceMaxCents,
    indicativePriceMinCents: input.indicativePriceMinCents,
    materialsAndTechnologies: input.materialsAndTechnologies,
    municipalityCode: input.municipalityCode,
    problem: input.problem,
    professionIds: Object.freeze([...input.professionIds].sort()),
    shortDescription: input.shortDescription,
    skillIds: Object.freeze([...input.skillIds].sort()),
    solution: input.solution,
    specializationIds: Object.freeze([...input.specializationIds].sort()),
    title: input.title,
  });
}

function contentMatches(
  row: PortfolioRow,
  content: PortfolioProjectContent,
): boolean {
  return (
    row.title === content.title &&
    row.shortDescription === content.shortDescription &&
    row.contribution === content.contribution &&
    row.materialsAndTechnologies === content.materialsAndTechnologies &&
    row.problem === content.problem &&
    row.solution === content.solution &&
    row.durationValue === content.durationValue &&
    row.durationUnit === content.durationUnit &&
    toNumber(row.indicativePriceMinCents) === content.indicativePriceMinCents &&
    toNumber(row.indicativePriceMaxCents) === content.indicativePriceMaxCents &&
    row.municipalityCode === content.municipalityCode &&
    row.districtCode === content.districtCode &&
    arraysEqual(row.professionIds, content.professionIds) &&
    arraysEqual(row.skillIds, content.skillIds) &&
    arraysEqual(row.specializationIds, content.specializationIds)
  );
}

function fingerprintCommand(kind: PortfolioCommandKind, input: object): string {
  return createHash("sha256")
    .update(JSON.stringify([kind, input]), "utf8")
    .digest("hex");
}

async function applied(transaction: TransactionSql, id: PortfolioProjectId) {
  return {
    project: await getProjectOrThrow(transaction, id),
    status: "APPLIED" as const,
  };
}
async function deduplicatedRevision(
  transaction: TransactionSql,
  commandId: string,
  resultingRevision: number,
) {
  return {
    project: await getRevisionOrThrow(
      transaction,
      commandId,
      resultingRevision,
    ),
    status: "DEDUPLICATED" as const,
  };
}

async function getRevisionOrThrow(
  sql: TransactionSql,
  commandId: string,
  resultingRevision: number,
): Promise<PortfolioProject> {
  const [row] = await sql<PortfolioRow[]>`
    SELECT project.id, project.craftsman_profile_id AS "craftsmanProfileId",
      project.author_user_id AS "authorUserId",
      project.provenance_kind AS "provenanceKind",
      'UNVERIFIED'::text AS "evidenceStatus",
      revision.record_state AS "recordState", revision.title,
      revision.short_description AS "shortDescription", revision.contribution,
      revision.materials_and_technologies AS "materialsAndTechnologies",
      revision.problem, revision.solution,
      revision.duration_value AS "durationValue",
      revision.duration_unit AS "durationUnit",
      revision.indicative_price_min_cents AS "indicativePriceMinCents",
      revision.indicative_price_max_cents AS "indicativePriceMaxCents",
      revision.currency, revision.municipality_code AS "municipalityCode",
      revision.district_code AS "districtCode",
      revision.profession_ids AS "professionIds",
      revision.skill_ids AS "skillIds",
      revision.specialization_ids AS "specializationIds",
      revision.revision, project.created_at AS "createdAt",
      revision.occurred_at AS "updatedAt"
    FROM portfolio_project_revisions revision
    JOIN portfolio_projects project ON project.id = revision.portfolio_project_id
    WHERE revision.command_id = ${commandId}
      AND revision.revision = ${resultingRevision}
  `;
  if (row === undefined) {
    throw new Error("Committed portfolio command snapshot is missing.");
  }
  return freezeProject(row);
}

async function getProjectOrThrow(
  sql: TransactionSql,
  id: PortfolioProjectId,
): Promise<PortfolioProject> {
  const rows = await selectProjectRows(sql, id, undefined, false);
  const row = rows[0];
  if (row === undefined)
    throw new Error("Committed portfolio projection is missing.");
  return freezeProject(row);
}

async function selectProjectRows(
  sql: Sql | TransactionSql,
  id: PortfolioProjectId,
  profileId: CraftsmanProfileId | undefined,
  forUpdate: boolean,
): Promise<readonly PortfolioRow[]> {
  return forUpdate
    ? sql<PortfolioRow[]>`
      SELECT id, craftsman_profile_id AS "craftsmanProfileId", author_user_id AS "authorUserId",
        provenance_kind AS "provenanceKind", 'UNVERIFIED'::text AS "evidenceStatus", record_state AS "recordState",
        title, short_description AS "shortDescription", contribution,
        materials_and_technologies AS "materialsAndTechnologies", problem, solution,
        duration_value AS "durationValue", duration_unit AS "durationUnit",
        indicative_price_min_cents AS "indicativePriceMinCents",
        indicative_price_max_cents AS "indicativePriceMaxCents", currency,
        municipality_code AS "municipalityCode", district_code AS "districtCode",
        profession_ids AS "professionIds", skill_ids AS "skillIds",
        specialization_ids AS "specializationIds", revision,
        created_at AS "createdAt", updated_at AS "updatedAt"
      FROM portfolio_projects WHERE id = ${id}
        AND craftsman_profile_id = ${profileId ?? null} FOR UPDATE`
    : sql<PortfolioRow[]>`
      SELECT id, craftsman_profile_id AS "craftsmanProfileId", author_user_id AS "authorUserId",
        provenance_kind AS "provenanceKind", 'UNVERIFIED'::text AS "evidenceStatus", record_state AS "recordState",
        title, short_description AS "shortDescription", contribution,
        materials_and_technologies AS "materialsAndTechnologies", problem, solution,
        duration_value AS "durationValue", duration_unit AS "durationUnit",
        indicative_price_min_cents AS "indicativePriceMinCents",
        indicative_price_max_cents AS "indicativePriceMaxCents", currency,
        municipality_code AS "municipalityCode", district_code AS "districtCode",
        profession_ids AS "professionIds", skill_ids AS "skillIds",
        specialization_ids AS "specializationIds", revision,
        created_at AS "createdAt", updated_at AS "updatedAt"
      FROM current_portfolio_projects WHERE id = ${id}`;
}

async function selectProjects(
  sql: Sql,
  profileId: CraftsmanProfileId,
  includeArchived: boolean,
): Promise<readonly PortfolioRow[]> {
  return sql<PortfolioRow[]>`
    SELECT id, craftsman_profile_id AS "craftsmanProfileId", author_user_id AS "authorUserId",
      provenance_kind AS "provenanceKind", evidence_status AS "evidenceStatus", record_state AS "recordState",
      title, short_description AS "shortDescription", contribution,
      materials_and_technologies AS "materialsAndTechnologies", problem, solution,
      duration_value AS "durationValue", duration_unit AS "durationUnit",
      indicative_price_min_cents AS "indicativePriceMinCents",
      indicative_price_max_cents AS "indicativePriceMaxCents", currency,
      municipality_code AS "municipalityCode", district_code AS "districtCode",
      profession_ids AS "professionIds", skill_ids AS "skillIds",
      specialization_ids AS "specializationIds", revision,
      created_at AS "createdAt", updated_at AS "updatedAt"
    FROM current_portfolio_projects WHERE craftsman_profile_id = ${profileId}
      AND (${includeArchived} OR record_state <> 'ARCHIVED') ORDER BY updated_at DESC, id`;
}

function freezeProject(row: PortfolioRow): PortfolioProject {
  return Object.freeze({
    ...row,
    indicativePriceMaxCents: toNumber(row.indicativePriceMaxCents),
    indicativePriceMinCents: toNumber(row.indicativePriceMinCents),
    professionIds: Object.freeze([...row.professionIds]),
    skillIds: Object.freeze([...row.skillIds]),
    specializationIds: Object.freeze([...row.specializationIds]),
  });
}
function toNumber(value: number | string | null): number | null {
  return value === null ? null : Number(value);
}
function arraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
