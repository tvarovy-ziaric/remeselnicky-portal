import { createHash } from "node:crypto";

import type {
  AssignCraftsmanProfessionInput,
  ChangeDeclaredProficiencyInput,
  CraftsmanProfession,
  CraftsmanProfessionId,
  CraftsmanProfessionPersistence,
  CraftsmanProfessionState,
  DeactivateCraftsmanProfessionInput,
  ProfessionProficiencyLevel,
  UserId,
} from "@portal/domain";
import {
  assertAssignCraftsmanProfessionInput,
  assertChangeDeclaredProficiencyInput,
  assertCraftsmanProfessionListInput,
  assertDeactivateCraftsmanProfessionInput,
} from "@portal/domain";
import type { CraftsmanProfileId } from "@portal/domain";
import type { Sql, TransactionSql } from "postgres";

type CommandKind = "ASSIGN" | "CHANGE_DECLARED_LEVEL" | "DEACTIVATE";

interface OwnedProfileRow {
  readonly accountState: string;
  readonly ownerUserId: UserId;
}

interface CommandRow {
  readonly actorUserId: UserId;
  readonly commandId: string;
  readonly commandKind: CommandKind;
  readonly craftsmanProfessionId: CraftsmanProfessionId;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly payloadFingerprint: string;
}

interface AssignmentStateRow {
  readonly declaredLevel: ProfessionProficiencyLevel;
  readonly declaredLevelRevision: number;
  readonly state: CraftsmanProfessionState;
}

interface CurrentProfessionRow {
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly createdAt: Date;
  readonly deactivatedAt: Date | null;
  readonly declaredLevel: ProfessionProficiencyLevel;
  readonly declaredLevelChangedAt: Date;
  readonly declaredLevelRevision: number;
  readonly evidenceSupportedAt: Date | null;
  readonly evidenceSupportedLevel: ProfessionProficiencyLevel | null;
  readonly id: CraftsmanProfessionId;
  readonly professionCode: string;
  readonly state: CraftsmanProfessionState;
  readonly taxonomyReleaseId: string;
}

interface TaxonomyCurrentRow {
  readonly currentReleaseId: string;
}

interface TaxonomyProfessionStateRow {
  readonly state: "ACTIVE" | "DEPRECATED";
}

export class CraftsmanProfessionIdempotencyError extends Error {
  readonly code = "CRAFTSMAN_PROFESSION_IDEMPOTENCY_CONFLICT";
}

export function createCraftsmanProfessionRepository(
  sql: Sql,
): CraftsmanProfessionPersistence {
  return Object.freeze({
    assign(input: AssignCraftsmanProfessionInput) {
      assertAssignCraftsmanProfessionInput(input);
      return sql.begin(async (transaction) => {
        if (!(await lockOwnedActiveProfile(transaction, input))) {
          return { status: "PROFILE_UNAVAILABLE" } as const;
        }

        const fingerprint = fingerprintCommand("ASSIGN", input);
        const replay = await findCommand(transaction, input.commandId);
        if (replay !== undefined) {
          assertExactReplay(replay, "ASSIGN", input, fingerprint);
          return deduplicated(transaction, input.craftsmanProfessionId);
        }

        const [currentTaxonomy] = await transaction<TaxonomyCurrentRow[]>`
          SELECT release_id AS "currentReleaseId"
          FROM profession_taxonomy_activation_events
          ORDER BY activation_sequence DESC
          LIMIT 1
        `;
        if (currentTaxonomy?.currentReleaseId !== input.taxonomyReleaseId) {
          return { status: "TAXONOMY_RELEASE_NOT_CURRENT" } as const;
        }

        const [taxonomyProfession] = await transaction<
          TaxonomyProfessionStateRow[]
        >`
            SELECT profession.state
            FROM taxonomy_professions profession
            JOIN profession_taxonomy_releases release
              ON release.release_id = profession.release_id
            WHERE profession.release_id = ${input.taxonomyReleaseId}
              AND profession.profession_code = ${input.professionCode}
              AND release.content_class = 'CANONICAL'
              AND release.review_state = 'HUMAN_REVIEW_APPROVED'
          `;
        if (taxonomyProfession?.state !== "ACTIVE") {
          return { status: "PROFESSION_NOT_ACTIVE" } as const;
        }

        const [alreadyActive] = await transaction<{ readonly id: string }[]>`
          SELECT id
          FROM craftsman_professions
          WHERE craftsman_profile_id = ${input.craftsmanProfileId}
            AND profession_code = ${input.professionCode}
            AND state = 'ACTIVE'
        `;
        if (alreadyActive !== undefined) {
          return { status: "ALREADY_ACTIVE" } as const;
        }

        await transaction`
          INSERT INTO craftsman_professions (
            id,
            craftsman_profile_id,
            taxonomy_release_id,
            profession_code,
            created_by_user_id
          ) VALUES (
            ${input.craftsmanProfessionId},
            ${input.craftsmanProfileId},
            ${input.taxonomyReleaseId},
            ${input.professionCode},
            ${input.actorUserId}
          )
        `;
        await insertCommand(transaction, "ASSIGN", input, fingerprint);
        await transaction`
          INSERT INTO craftsman_profession_declared_level_events (
            event_id,
            command_id,
            craftsman_profession_id,
            revision,
            declared_level,
            actor_user_id
          ) VALUES (
            ${input.commandId},
            ${input.commandId},
            ${input.craftsmanProfessionId},
            1,
            ${input.declaredLevel},
            ${input.actorUserId}
          )
        `;
        return {
          profession: await getProfessionOrThrow(
            transaction,
            input.craftsmanProfessionId,
          ),
          status: "APPLIED",
        } as const;
      });
    },

    changeDeclaredLevel(input: ChangeDeclaredProficiencyInput) {
      assertChangeDeclaredProficiencyInput(input);
      return sql.begin(async (transaction) => {
        if (!(await lockOwnedActiveProfile(transaction, input))) {
          return { status: "PROFILE_UNAVAILABLE" } as const;
        }

        const fingerprint = fingerprintCommand("CHANGE_DECLARED_LEVEL", input);
        const replay = await findCommand(transaction, input.commandId);
        if (replay !== undefined) {
          assertExactReplay(
            replay,
            "CHANGE_DECLARED_LEVEL",
            input,
            fingerprint,
          );
          return deduplicated(transaction, input.craftsmanProfessionId);
        }

        const [assignment] = await transaction<AssignmentStateRow[]>`
          SELECT
            assignment.state,
            declared.declared_level AS "declaredLevel",
            declared.revision AS "declaredLevelRevision"
          FROM craftsman_professions assignment
          JOIN LATERAL (
            SELECT event.declared_level, event.revision
            FROM craftsman_profession_declared_level_events event
            WHERE event.craftsman_profession_id = assignment.id
            ORDER BY event.revision DESC
            LIMIT 1
          ) declared ON true
          WHERE assignment.id = ${input.craftsmanProfessionId}
            AND assignment.craftsman_profile_id = ${input.craftsmanProfileId}
          FOR UPDATE OF assignment
        `;
        if (assignment?.state !== "ACTIVE") {
          return { status: "ASSIGNMENT_NOT_ACTIVE" } as const;
        }
        if (
          assignment.declaredLevelRevision !==
          input.expectedDeclaredLevelRevision
        ) {
          return { status: "STALE_REVISION" } as const;
        }
        if (assignment.declaredLevel === input.declaredLevel) {
          return { status: "LEVEL_UNCHANGED" } as const;
        }

        await insertCommand(
          transaction,
          "CHANGE_DECLARED_LEVEL",
          input,
          fingerprint,
        );
        await transaction`
          INSERT INTO craftsman_profession_declared_level_events (
            event_id,
            command_id,
            craftsman_profession_id,
            revision,
            declared_level,
            actor_user_id
          ) VALUES (
            ${input.commandId},
            ${input.commandId},
            ${input.craftsmanProfessionId},
            ${assignment.declaredLevelRevision + 1},
            ${input.declaredLevel},
            ${input.actorUserId}
          )
        `;
        return {
          profession: await getProfessionOrThrow(
            transaction,
            input.craftsmanProfessionId,
          ),
          status: "APPLIED",
        } as const;
      });
    },

    deactivate(input: DeactivateCraftsmanProfessionInput) {
      assertDeactivateCraftsmanProfessionInput(input);
      return sql.begin(async (transaction) => {
        if (!(await lockOwnedActiveProfile(transaction, input))) {
          return { status: "PROFILE_UNAVAILABLE" } as const;
        }

        const fingerprint = fingerprintCommand("DEACTIVATE", input);
        const replay = await findCommand(transaction, input.commandId);
        if (replay !== undefined) {
          assertExactReplay(replay, "DEACTIVATE", input, fingerprint);
          return deduplicated(transaction, input.craftsmanProfessionId);
        }

        const [assignment] = await transaction<
          { readonly state: CraftsmanProfessionState }[]
        >`
          SELECT state
          FROM craftsman_professions
          WHERE id = ${input.craftsmanProfessionId}
            AND craftsman_profile_id = ${input.craftsmanProfileId}
          FOR UPDATE
        `;
        if (assignment?.state !== "ACTIVE") {
          return { status: "ASSIGNMENT_NOT_ACTIVE" } as const;
        }

        await insertCommand(transaction, "DEACTIVATE", input, fingerprint);
        await transaction`
          UPDATE craftsman_professions
          SET
            state = 'INACTIVE',
            deactivated_by_user_id = ${input.actorUserId},
            deactivation_command_id = ${input.commandId}
          WHERE id = ${input.craftsmanProfessionId}
        `;
        return {
          profession: await getProfessionOrThrow(
            transaction,
            input.craftsmanProfessionId,
          ),
          status: "APPLIED",
        } as const;
      });
    },

    async listOwned(input: {
      readonly actorUserId: UserId;
      readonly craftsmanProfileId: CraftsmanProfileId;
    }) {
      assertCraftsmanProfessionListInput(input);
      const [owned] = await sql<OwnedProfileRow[]>`
        SELECT
          profile.owner_user_id AS "ownerUserId",
          owner.account_state AS "accountState"
        FROM craftsman_profiles profile
        JOIN users owner ON owner.id = profile.owner_user_id
        WHERE profile.id = ${input.craftsmanProfileId}
          AND profile.owner_user_id = ${input.actorUserId}
      `;
      if (owned?.accountState !== "ACTIVE") return Object.freeze([]);
      const rows = await selectCurrentProfessions(
        sql,
        input.craftsmanProfileId,
      );
      return freezeProfessions(rows);
    },
  });
}

async function lockOwnedActiveProfile(
  transaction: TransactionSql,
  input: {
    readonly actorUserId: UserId;
    readonly craftsmanProfileId: CraftsmanProfileId;
  },
): Promise<boolean> {
  const [profile] = await transaction<OwnedProfileRow[]>`
    SELECT
      profile.owner_user_id AS "ownerUserId",
      owner.account_state AS "accountState"
    FROM craftsman_profiles profile
    JOIN users owner ON owner.id = profile.owner_user_id
    WHERE profile.id = ${input.craftsmanProfileId}
    FOR UPDATE OF profile, owner
  `;
  return (
    profile?.ownerUserId === input.actorUserId &&
    profile.accountState === "ACTIVE"
  );
}

async function findCommand(
  transaction: TransactionSql,
  commandId: string,
): Promise<CommandRow | undefined> {
  const [command] = await transaction<CommandRow[]>`
    SELECT
      command_id AS "commandId",
      command_kind AS "commandKind",
      craftsman_profession_id AS "craftsmanProfessionId",
      craftsman_profile_id AS "craftsmanProfileId",
      actor_user_id AS "actorUserId",
      payload_fingerprint AS "payloadFingerprint"
    FROM craftsman_profession_commands
    WHERE command_id = ${commandId}
  `;
  return command;
}

function assertExactReplay(
  command: CommandRow,
  kind: CommandKind,
  input: {
    readonly actorUserId: UserId;
    readonly commandId: string;
    readonly craftsmanProfessionId: CraftsmanProfessionId;
    readonly craftsmanProfileId: CraftsmanProfileId;
  },
  fingerprint: string,
): void {
  if (
    command.commandKind !== kind ||
    command.actorUserId !== input.actorUserId ||
    command.craftsmanProfessionId !== input.craftsmanProfessionId ||
    command.craftsmanProfileId !== input.craftsmanProfileId ||
    command.payloadFingerprint !== fingerprint
  ) {
    throw new CraftsmanProfessionIdempotencyError(
      "Craftsman profession command id was reused with different intent.",
    );
  }
}

async function insertCommand(
  transaction: TransactionSql,
  kind: CommandKind,
  input: {
    readonly actorUserId: UserId;
    readonly commandId: string;
    readonly craftsmanProfessionId: CraftsmanProfessionId;
    readonly craftsmanProfileId: CraftsmanProfileId;
  },
  fingerprint: string,
): Promise<void> {
  await transaction`
    INSERT INTO craftsman_profession_commands (
      command_id,
      command_kind,
      craftsman_profession_id,
      craftsman_profile_id,
      actor_user_id,
      payload_fingerprint
    ) VALUES (
      ${input.commandId},
      ${kind},
      ${input.craftsmanProfessionId},
      ${input.craftsmanProfileId},
      ${input.actorUserId},
      ${fingerprint}
    )
  `;
}

function fingerprintCommand(kind: CommandKind, input: object): string {
  const command = input as {
    readonly actorUserId: string;
    readonly commandId: string;
    readonly craftsmanProfessionId: string;
    readonly craftsmanProfileId: string;
    readonly declaredLevel?: string;
    readonly expectedDeclaredLevelRevision?: number;
    readonly professionCode?: string;
    readonly taxonomyReleaseId?: string;
  };
  return createHash("sha256")
    .update(
      JSON.stringify([
        kind,
        command.commandId,
        command.craftsmanProfessionId,
        command.craftsmanProfileId,
        command.actorUserId,
        command.taxonomyReleaseId ?? null,
        command.professionCode ?? null,
        command.expectedDeclaredLevelRevision ?? null,
        command.declaredLevel ?? null,
      ]),
      "utf8",
    )
    .digest("hex");
}

async function deduplicated(
  transaction: TransactionSql,
  id: CraftsmanProfessionId,
): Promise<{
  readonly profession: CraftsmanProfession;
  readonly status: "DEDUPLICATED";
}> {
  return {
    profession: await getProfessionOrThrow(transaction, id),
    status: "DEDUPLICATED",
  };
}

async function getProfessionOrThrow(
  sql: TransactionSql,
  id: CraftsmanProfessionId,
): Promise<CraftsmanProfession> {
  const [row] = await sql<CurrentProfessionRow[]>`
    SELECT
      id,
      craftsman_profile_id AS "craftsmanProfileId",
      taxonomy_release_id AS "taxonomyReleaseId",
      profession_code AS "professionCode",
      state,
      declared_level AS "declaredLevel",
      declared_level_revision AS "declaredLevelRevision",
      declared_level_changed_at AS "declaredLevelChangedAt",
      evidence_supported_level AS "evidenceSupportedLevel",
      evidence_supported_at AS "evidenceSupportedAt",
      created_at AS "createdAt",
      deactivated_at AS "deactivatedAt"
    FROM current_craftsman_professions
    WHERE id = ${id}
  `;
  if (row === undefined) {
    throw new Error("Committed craftsman profession projection is missing.");
  }
  return freezeProfession(row);
}

async function selectCurrentProfessions(
  sql: Sql,
  profileId: CraftsmanProfileId,
): Promise<readonly CurrentProfessionRow[]> {
  return sql<CurrentProfessionRow[]>`
    SELECT
      id,
      craftsman_profile_id AS "craftsmanProfileId",
      taxonomy_release_id AS "taxonomyReleaseId",
      profession_code AS "professionCode",
      state,
      declared_level AS "declaredLevel",
      declared_level_revision AS "declaredLevelRevision",
      declared_level_changed_at AS "declaredLevelChangedAt",
      evidence_supported_level AS "evidenceSupportedLevel",
      evidence_supported_at AS "evidenceSupportedAt",
      created_at AS "createdAt",
      deactivated_at AS "deactivatedAt"
    FROM current_craftsman_professions
    WHERE craftsman_profile_id = ${profileId}
    ORDER BY created_at, id
  `;
}

function freezeProfession(row: CurrentProfessionRow): CraftsmanProfession {
  return Object.freeze({ ...row });
}

function freezeProfessions(
  rows: readonly CurrentProfessionRow[],
): readonly CraftsmanProfession[] {
  return Object.freeze(rows.map(freezeProfession));
}
