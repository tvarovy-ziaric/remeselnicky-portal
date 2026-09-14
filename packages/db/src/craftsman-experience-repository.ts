import { createHash } from "node:crypto";

import {
  assertCraftsmanExperienceReadInput,
  assertReplaceCraftsmanExperienceInput,
  type CraftsmanExperience,
  type CraftsmanExperiencePersistence,
  type CraftsmanExperienceRevisionId,
  type CraftsmanProfileId,
  type ReplaceCraftsmanExperienceInput,
  type ReplaceCraftsmanExperienceResult,
  type UserId,
} from "@portal/domain";
import type { Sql, TransactionSql } from "postgres";

interface OwnedProfileRow {
  readonly accountState: "ACTIVE" | "SUSPENDED" | "DEACTIVATED";
  readonly ownerUserId: UserId;
}

interface ExperienceCommandRow {
  readonly actorUserId: UserId;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly payloadFingerprint: string;
  readonly resultKind: "APPLIED" | "UNCHANGED";
  readonly resultingRevision: number;
}

interface ExperienceRow {
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly createdAt: Date;
  readonly id: CraftsmanExperienceRevisionId;
  readonly revision: number;
  readonly workingSinceYear: number | null;
}

export class CraftsmanExperienceIdempotencyError extends Error {
  readonly code = "CRAFTSMAN_EXPERIENCE_IDEMPOTENCY_CONFLICT";
}

export function createCraftsmanExperienceRepository(
  sql: Sql,
): CraftsmanExperiencePersistence {
  return Object.freeze({
    async replaceOwnedDraft(
      input: ReplaceCraftsmanExperienceInput,
    ): Promise<ReplaceCraftsmanExperienceResult> {
      assertReplaceCraftsmanExperienceInput(input);
      const payloadFingerprint = fingerprint(input);

      return sql.begin(async (transaction) => {
        const owner = await lockOwnedActiveProfile(transaction, input);
        if (owner === undefined) {
          return Object.freeze({ status: "PROFILE_UNAVAILABLE" });
        }

        const priorCommand = await selectCommand(transaction, input.commandId);
        if (priorCommand !== undefined) {
          assertExactReplay(priorCommand, input, payloadFingerprint);
          const experience =
            priorCommand.resultingRevision === 0
              ? null
              : await selectRevision(
                  transaction,
                  input.craftsmanProfileId,
                  priorCommand.resultingRevision,
                );
          if (priorCommand.resultingRevision > 0 && experience === null) {
            throw new Error(
              "Craftsman experience command points to a missing revision.",
            );
          }
          return Object.freeze({
            experience,
            status: "DEDUPLICATED",
          });
        }

        const current = await selectRevision(
          transaction,
          input.craftsmanProfileId,
          undefined,
          input.actorUserId,
        );
        const currentRevision = current?.revision ?? 0;
        if (input.expectedRevision !== currentRevision) {
          return Object.freeze({ status: "STALE_REVISION" });
        }

        const unchanged =
          input.workingSinceYear === (current?.workingSinceYear ?? null);
        const command = await insertCommand(
          transaction,
          input,
          payloadFingerprint,
          unchanged ? "UNCHANGED" : "APPLIED",
          unchanged ? currentRevision : currentRevision + 1,
        );
        if (command.resultKind === "UNCHANGED") {
          return Object.freeze({ experience: current, status: "UNCHANGED" });
        }

        await transaction`
          INSERT INTO craftsman_experience_revisions (
            craftsman_profile_id,
            command_id,
            revision,
            working_since_year
          ) VALUES (
            ${input.craftsmanProfileId},
            ${input.commandId},
            ${command.resultingRevision},
            ${input.workingSinceYear}
          )
        `;
        const experience = await selectRevision(
          transaction,
          input.craftsmanProfileId,
          command.resultingRevision,
        );
        if (experience === null) {
          throw new Error("Created craftsman experience revision is missing.");
        }
        return Object.freeze({ experience, status: "APPLIED" });
      });
    },

    async findOwned(input: {
      readonly actorUserId: UserId;
      readonly craftsmanProfileId: CraftsmanProfileId;
    }): Promise<CraftsmanExperience | null> {
      assertCraftsmanExperienceReadInput(input);
      return selectRevision(
        sql,
        input.craftsmanProfileId,
        undefined,
        input.actorUserId,
      );
    },
  });
}

async function lockOwnedActiveProfile(
  transaction: TransactionSql,
  input: Pick<
    ReplaceCraftsmanExperienceInput,
    "actorUserId" | "craftsmanProfileId"
  >,
): Promise<OwnedProfileRow | undefined> {
  const [owned] = await transaction<OwnedProfileRow[]>`
    SELECT
      profile.owner_user_id AS "ownerUserId",
      owner.account_state AS "accountState"
    FROM craftsman_profiles profile
    JOIN users owner ON owner.id = profile.owner_user_id
    WHERE profile.id = ${input.craftsmanProfileId}
      AND profile.owner_user_id = ${input.actorUserId}
      AND owner.account_state = 'ACTIVE'
    FOR UPDATE OF profile, owner
  `;
  return owned;
}

async function selectCommand(
  transaction: TransactionSql,
  commandId: string,
): Promise<ExperienceCommandRow | undefined> {
  const [command] = await transaction<ExperienceCommandRow[]>`
    SELECT
      actor_user_id AS "actorUserId",
      craftsman_profile_id AS "craftsmanProfileId",
      payload_fingerprint AS "payloadFingerprint",
      result_kind AS "resultKind",
      resulting_revision AS "resultingRevision"
    FROM craftsman_experience_commands
    WHERE command_id = ${commandId}
  `;
  return command;
}

function assertExactReplay(
  command: ExperienceCommandRow,
  input: ReplaceCraftsmanExperienceInput,
  payloadFingerprint: string,
): void {
  if (
    command.actorUserId !== input.actorUserId ||
    command.craftsmanProfileId !== input.craftsmanProfileId ||
    command.payloadFingerprint !== payloadFingerprint
  ) {
    throw new CraftsmanExperienceIdempotencyError(
      "Craftsman experience command id was reused with different intent.",
    );
  }
}

async function insertCommand(
  transaction: TransactionSql,
  input: ReplaceCraftsmanExperienceInput,
  payloadFingerprint: string,
  resultKind: "APPLIED" | "UNCHANGED",
  resultingRevision: number,
): Promise<Pick<ExperienceCommandRow, "resultKind" | "resultingRevision">> {
  const [command] = await transaction<
    Pick<ExperienceCommandRow, "resultKind" | "resultingRevision">[]
  >`
    INSERT INTO craftsman_experience_commands (
      command_id,
      craftsman_profile_id,
      actor_user_id,
      expected_revision,
      result_kind,
      resulting_revision,
      working_since_year,
      payload_fingerprint
    ) VALUES (
      ${input.commandId},
      ${input.craftsmanProfileId},
      ${input.actorUserId},
      ${input.expectedRevision},
      ${resultKind},
      ${resultingRevision},
      ${input.workingSinceYear},
      ${payloadFingerprint}
    )
    RETURNING
      result_kind AS "resultKind",
      resulting_revision AS "resultingRevision"
  `;
  if (command === undefined) {
    throw new Error("Craftsman experience command insert returned no record.");
  }
  return command;
}

async function selectRevision(
  sql: Sql | TransactionSql,
  craftsmanProfileId: CraftsmanProfileId,
  revision?: number,
  actorUserId?: UserId,
): Promise<CraftsmanExperience | null> {
  if (revision === undefined && actorUserId === undefined) {
    throw new Error("Current experience read requires active owner scope.");
  }
  const rows =
    revision === undefined
      ? await sql<ExperienceRow[]>`
        SELECT
          current.id,
          current.craftsman_profile_id AS "craftsmanProfileId",
          current.revision,
          current.working_since_year AS "workingSinceYear",
          current.created_at AS "createdAt"
        FROM current_craftsman_experience current
        JOIN craftsman_profiles profile
          ON profile.id = current.craftsman_profile_id
        JOIN users owner ON owner.id = profile.owner_user_id
        WHERE current.craftsman_profile_id = ${craftsmanProfileId}
          AND profile.owner_user_id = ${actorUserId ?? null}
          AND owner.account_state = 'ACTIVE'
      `
      : await sql<ExperienceRow[]>`
        SELECT
          id,
          craftsman_profile_id AS "craftsmanProfileId",
          revision,
          working_since_year AS "workingSinceYear",
          created_at AS "createdAt"
        FROM craftsman_experience_revisions
        WHERE craftsman_profile_id = ${craftsmanProfileId}
          AND revision = ${revision}
      `;
  return rows[0] === undefined ? null : mapExperience(rows[0]);
}

function mapExperience(row: ExperienceRow): CraftsmanExperience {
  return Object.freeze({
    craftsmanProfileId: row.craftsmanProfileId,
    id: row.id,
    provenance: "SELF_DECLARED",
    recordedAt: row.createdAt,
    revision: row.revision,
    workingSinceYear: row.workingSinceYear,
  });
}

function fingerprint(input: ReplaceCraftsmanExperienceInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.commandId,
        input.craftsmanProfileId,
        input.actorUserId,
        input.expectedRevision,
        input.workingSinceYear,
      ]),
      "utf8",
    )
    .digest("hex");
}
