import { createHash } from "node:crypto";

import {
  assertAddCraftsmanAvailabilityBlockInput,
  assertArchiveCraftsmanAvailabilityBlockInput,
  assertCraftsmanAvailabilityListInput,
  assertReplaceCraftsmanAvailabilityBlockInput,
  type AddCraftsmanAvailabilityBlockInput,
  type AddCraftsmanAvailabilityBlockResult,
  type ArchiveCraftsmanAvailabilityBlockInput,
  type ArchiveCraftsmanAvailabilityBlockResult,
  type CraftsmanAvailabilityBlock,
  type CraftsmanAvailabilityBlockId,
  type CraftsmanAvailabilityPersistence,
  type CraftsmanAvailabilityState,
  type CraftsmanProfileId,
  type ReplaceCraftsmanAvailabilityBlockInput,
  type ReplaceCraftsmanAvailabilityBlockResult,
  type UserId,
} from "@portal/domain";
import type { Sql, TransactionSql } from "postgres";

interface OwnedProfileRow {
  readonly accountState: "ACTIVE" | "SUSPENDED" | "DEACTIVATED";
  readonly ownerUserId: string;
}

interface CommandRow {
  readonly actorUserId: string;
  readonly blockId: string;
  readonly commandKind: "ADD" | "REPLACE" | "ARCHIVE";
  readonly craftsmanProfileId: string;
  readonly payloadFingerprint: string;
  readonly resultingRevision: number;
}

interface AvailabilityRow {
  readonly archivedAt: Date | null;
  readonly availability: "AVAILABLE" | "BUSY" | "UNAVAILABLE";
  readonly blockId: string;
  readonly changedAt: Date;
  readonly craftsmanProfileId: string;
  readonly createdAt: Date;
  readonly endsAt: Date;
  readonly revision: number;
  readonly startsAt: Date;
  readonly state: "ACTIVE" | "ARCHIVED";
}

type AvailabilityCommandKind = CommandRow["commandKind"];

export class CraftsmanAvailabilityIdempotencyError extends Error {
  readonly code = "CRAFTSMAN_AVAILABILITY_IDEMPOTENCY_CONFLICT";
}

export function createCraftsmanAvailabilityRepository(
  sql: Sql,
): CraftsmanAvailabilityPersistence {
  return Object.freeze({
    async add(
      input: AddCraftsmanAvailabilityBlockInput,
    ): Promise<AddCraftsmanAvailabilityBlockResult> {
      assertAddCraftsmanAvailabilityBlockInput(input);
      const payloadFingerprint = fingerprint("ADD", input);
      return sql.begin(async (transaction) => {
        if (!(await isActiveOwner(transaction, input))) {
          return Object.freeze({ status: "PROFILE_UNAVAILABLE" });
        }
        const replay = await replayCommand(
          transaction,
          "ADD",
          input,
          payloadFingerprint,
        );
        if (replay !== null) return replay;

        const existing = await selectBlock(transaction, input.blockId);
        if (existing !== null) {
          return Object.freeze({ status: "ALREADY_EXISTS" });
        }

        await insertCommand(transaction, {
          ...input,
          commandKind: "ADD",
          expectedRevision: 0,
          payloadFingerprint,
          resultKind: "APPLIED",
          resultingRevision: 1,
          targetState: "ACTIVE",
        });
        await insertRevision(transaction, {
          ...input,
          commandId: input.commandId,
          revision: 1,
          state: "ACTIVE",
        });
        const block = await selectBlock(transaction, input.blockId, 1);
        if (block === null) throw missingEffect();
        return Object.freeze({ block, status: "APPLIED" });
      });
    },

    async replace(
      input: ReplaceCraftsmanAvailabilityBlockInput,
    ): Promise<ReplaceCraftsmanAvailabilityBlockResult> {
      assertReplaceCraftsmanAvailabilityBlockInput(input);
      const payloadFingerprint = fingerprint("REPLACE", input);
      return sql.begin(async (transaction) => {
        if (!(await isActiveOwner(transaction, input))) {
          return Object.freeze({ status: "PROFILE_UNAVAILABLE" });
        }
        const replay = await replayCommand(
          transaction,
          "REPLACE",
          input,
          payloadFingerprint,
        );
        if (replay !== null) return replay;

        const current = await selectBlock(
          transaction,
          input.blockId,
          undefined,
          input.craftsmanProfileId,
        );
        if (current === null || current.state !== "ACTIVE") {
          return Object.freeze({ status: "BLOCK_NOT_ACTIVE" });
        }
        if (current.revision !== input.expectedRevision) {
          return Object.freeze({ status: "STALE_REVISION" });
        }
        if (sameMarking(current, input)) {
          await insertCommand(transaction, {
            ...input,
            commandKind: "REPLACE",
            payloadFingerprint,
            resultKind: "UNCHANGED",
            resultingRevision: current.revision,
            targetState: "ACTIVE",
          });
          return Object.freeze({ block: current, status: "UNCHANGED" });
        }

        const resultingRevision = current.revision + 1;
        await insertCommand(transaction, {
          ...input,
          commandKind: "REPLACE",
          payloadFingerprint,
          resultKind: "APPLIED",
          resultingRevision,
          targetState: "ACTIVE",
        });
        await insertRevision(transaction, {
          ...input,
          revision: resultingRevision,
          state: "ACTIVE",
        });
        const block = await selectBlock(
          transaction,
          input.blockId,
          resultingRevision,
          input.craftsmanProfileId,
        );
        if (block === null) throw missingEffect();
        return Object.freeze({ block, status: "APPLIED" });
      });
    },

    async archive(
      input: ArchiveCraftsmanAvailabilityBlockInput,
    ): Promise<ArchiveCraftsmanAvailabilityBlockResult> {
      assertArchiveCraftsmanAvailabilityBlockInput(input);
      const payloadFingerprint = fingerprint("ARCHIVE", input);
      return sql.begin(async (transaction) => {
        if (!(await isActiveOwner(transaction, input))) {
          return Object.freeze({ status: "PROFILE_UNAVAILABLE" });
        }
        const replay = await replayCommand(
          transaction,
          "ARCHIVE",
          input,
          payloadFingerprint,
        );
        if (replay !== null) return replay;

        const current = await selectBlock(
          transaction,
          input.blockId,
          undefined,
          input.craftsmanProfileId,
        );
        if (current === null || current.state !== "ACTIVE") {
          return Object.freeze({ status: "BLOCK_NOT_ACTIVE" });
        }
        if (current.revision !== input.expectedRevision) {
          return Object.freeze({ status: "STALE_REVISION" });
        }

        const resultingRevision = current.revision + 1;
        await insertCommand(transaction, {
          actorUserId: input.actorUserId,
          availability: current.availability,
          blockId: input.blockId,
          commandId: input.commandId,
          commandKind: "ARCHIVE",
          craftsmanProfileId: input.craftsmanProfileId,
          endsAt: current.endsAt,
          expectedRevision: input.expectedRevision,
          payloadFingerprint,
          resultKind: "APPLIED",
          resultingRevision,
          startsAt: current.startsAt,
          targetState: "ARCHIVED",
        });
        await insertRevision(transaction, {
          actorUserId: input.actorUserId,
          availability: current.availability,
          blockId: input.blockId,
          commandId: input.commandId,
          craftsmanProfileId: input.craftsmanProfileId,
          endsAt: current.endsAt,
          revision: resultingRevision,
          startsAt: current.startsAt,
          state: "ARCHIVED",
        });
        const block = await selectBlock(
          transaction,
          input.blockId,
          resultingRevision,
          input.craftsmanProfileId,
        );
        if (block === null) throw missingEffect();
        return Object.freeze({ block, status: "APPLIED" });
      });
    },

    async listOwned(input: {
      readonly actorUserId: UserId;
      readonly craftsmanProfileId: CraftsmanProfileId;
      readonly includeArchived?: boolean;
    }): Promise<readonly CraftsmanAvailabilityBlock[]> {
      assertCraftsmanAvailabilityListInput(input);
      const rows = await sql<AvailabilityRow[]>`
        SELECT
          current.block_id AS "blockId",
          current.craftsman_profile_id AS "craftsmanProfileId",
          current.state,
          current.availability,
          current.starts_at AS "startsAt",
          current.ends_at AS "endsAt",
          current.revision,
          current.created_at AS "createdAt",
          current.changed_at AS "changedAt",
          current.archived_at AS "archivedAt"
        FROM current_craftsman_availability_blocks current
        JOIN craftsman_profiles profile
          ON profile.id = current.craftsman_profile_id
        JOIN users owner ON owner.id = profile.owner_user_id
        WHERE current.craftsman_profile_id = ${input.craftsmanProfileId}
          AND profile.owner_user_id = ${input.actorUserId}
          AND owner.account_state = 'ACTIVE'
          AND (${input.includeArchived === true} OR current.state = 'ACTIVE')
        ORDER BY current.starts_at, current.ends_at, current.block_id
      `;
      return Object.freeze(rows.map(mapBlock));
    },
  });
}

interface InsertCommandInput {
  readonly actorUserId: UserId;
  readonly availability: CraftsmanAvailabilityState;
  readonly blockId: CraftsmanAvailabilityBlockId;
  readonly commandId: string;
  readonly commandKind: AvailabilityCommandKind;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly endsAt: Date;
  readonly expectedRevision: number;
  readonly payloadFingerprint: string;
  readonly resultKind: "APPLIED" | "UNCHANGED";
  readonly resultingRevision: number;
  readonly startsAt: Date;
  readonly targetState: "ACTIVE" | "ARCHIVED";
}

interface InsertRevisionInput {
  readonly actorUserId: UserId;
  readonly availability: CraftsmanAvailabilityState;
  readonly blockId: CraftsmanAvailabilityBlockId;
  readonly commandId: string;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly endsAt: Date;
  readonly revision: number;
  readonly startsAt: Date;
  readonly state: "ACTIVE" | "ARCHIVED";
}

async function isActiveOwner(
  transaction: TransactionSql,
  input: {
    readonly actorUserId: UserId;
    readonly craftsmanProfileId: CraftsmanProfileId;
  },
): Promise<boolean> {
  const [owned] = await transaction<OwnedProfileRow[]>`
    SELECT
      profile.owner_user_id AS "ownerUserId",
      owner.account_state AS "accountState"
    FROM craftsman_profiles profile
    JOIN users owner ON owner.id = profile.owner_user_id
    WHERE profile.id = ${input.craftsmanProfileId}
      AND profile.owner_user_id = ${input.actorUserId}
    FOR UPDATE OF profile, owner
  `;
  return (
    owned?.ownerUserId === input.actorUserId && owned.accountState === "ACTIVE"
  );
}

async function replayCommand(
  transaction: TransactionSql,
  commandKind: AvailabilityCommandKind,
  input: {
    readonly actorUserId: UserId;
    readonly blockId: CraftsmanAvailabilityBlockId;
    readonly commandId: string;
    readonly craftsmanProfileId: CraftsmanProfileId;
  },
  payloadFingerprint: string,
): Promise<{
  readonly block: CraftsmanAvailabilityBlock;
  readonly status: "DEDUPLICATED";
} | null> {
  const [prior] = await transaction<CommandRow[]>`
    SELECT
      actor_user_id AS "actorUserId",
      block_id AS "blockId",
      command_kind AS "commandKind",
      craftsman_profile_id AS "craftsmanProfileId",
      payload_fingerprint AS "payloadFingerprint",
      resulting_revision AS "resultingRevision"
    FROM craftsman_availability_commands
    WHERE command_id = ${input.commandId}
  `;
  if (prior === undefined) return null;
  if (
    prior.actorUserId !== input.actorUserId ||
    prior.blockId !== input.blockId ||
    prior.commandKind !== commandKind ||
    prior.craftsmanProfileId !== input.craftsmanProfileId ||
    prior.payloadFingerprint !== payloadFingerprint
  ) {
    throw new CraftsmanAvailabilityIdempotencyError(
      "Availability command id was reused for a different intent.",
    );
  }
  const block = await selectBlock(
    transaction,
    input.blockId,
    prior.resultingRevision,
    input.craftsmanProfileId,
  );
  if (block === null) throw missingEffect();
  return Object.freeze({ block, status: "DEDUPLICATED" });
}

async function insertCommand(
  transaction: TransactionSql,
  input: InsertCommandInput,
): Promise<void> {
  await transaction`
    INSERT INTO craftsman_availability_commands (
      command_id,
      command_kind,
      block_id,
      craftsman_profile_id,
      actor_user_id,
      expected_revision,
      result_kind,
      resulting_revision,
      target_state,
      availability,
      starts_at,
      ends_at,
      payload_fingerprint
    ) VALUES (
      ${input.commandId},
      ${input.commandKind},
      ${input.blockId},
      ${input.craftsmanProfileId},
      ${input.actorUserId},
      ${input.expectedRevision},
      ${input.resultKind},
      ${input.resultingRevision},
      ${input.targetState},
      ${input.availability},
      ${input.startsAt},
      ${input.endsAt},
      ${input.payloadFingerprint}
    )
  `;
}

async function insertRevision(
  transaction: TransactionSql,
  input: InsertRevisionInput,
): Promise<void> {
  await transaction`
    INSERT INTO craftsman_availability_revisions (
      block_id,
      craftsman_profile_id,
      command_id,
      revision,
      state,
      availability,
      starts_at,
      ends_at
    ) VALUES (
      ${input.blockId},
      ${input.craftsmanProfileId},
      ${input.commandId},
      ${input.revision},
      ${input.state},
      ${input.availability},
      ${input.startsAt},
      ${input.endsAt}
    )
  `;
}

async function selectBlock(
  sql: Sql | TransactionSql,
  blockId: CraftsmanAvailabilityBlockId,
  revision?: number,
  craftsmanProfileId?: CraftsmanProfileId,
): Promise<CraftsmanAvailabilityBlock | null> {
  const rows = await sql<AvailabilityRow[]>`
    SELECT
      stored.block_id AS "blockId",
      stored.craftsman_profile_id AS "craftsmanProfileId",
      stored.state,
      stored.availability,
      stored.starts_at AS "startsAt",
      stored.ends_at AS "endsAt",
      stored.revision,
      first_revision.created_at AS "createdAt",
      stored.changed_at AS "changedAt",
      stored.archived_at AS "archivedAt"
    FROM craftsman_availability_revisions stored
    CROSS JOIN LATERAL (
      SELECT min(history.changed_at) AS created_at
      FROM craftsman_availability_revisions history
      WHERE history.block_id = stored.block_id
    ) first_revision
    WHERE stored.block_id = ${blockId}
      AND (${revision ?? null}::integer IS NULL OR stored.revision = ${revision ?? null})
      AND (${craftsmanProfileId ?? null}::uuid IS NULL
        OR stored.craftsman_profile_id = ${craftsmanProfileId ?? null})
    ORDER BY stored.revision DESC
    LIMIT 1
  `;
  return rows[0] === undefined ? null : mapBlock(rows[0]);
}

function mapBlock(row: AvailabilityRow): CraftsmanAvailabilityBlock {
  return Object.freeze({
    archivedAt: row.archivedAt,
    availability: row.availability,
    changedAt: row.changedAt,
    craftsmanProfileId: row.craftsmanProfileId as CraftsmanProfileId,
    createdAt: row.createdAt,
    endsAt: row.endsAt,
    id: row.blockId as CraftsmanAvailabilityBlockId,
    revision: row.revision,
    startsAt: row.startsAt,
    state: row.state,
  });
}

function sameMarking(
  current: CraftsmanAvailabilityBlock,
  input: ReplaceCraftsmanAvailabilityBlockInput,
): boolean {
  return (
    current.availability === input.availability &&
    current.startsAt.valueOf() === input.startsAt.valueOf() &&
    current.endsAt.valueOf() === input.endsAt.valueOf()
  );
}

function fingerprint(
  commandKind: AvailabilityCommandKind,
  input:
    | AddCraftsmanAvailabilityBlockInput
    | ReplaceCraftsmanAvailabilityBlockInput
    | ArchiveCraftsmanAvailabilityBlockInput,
): string {
  const mutable = "startsAt" in input;
  return createHash("sha256")
    .update(
      JSON.stringify([
        commandKind,
        input.commandId,
        input.blockId,
        input.craftsmanProfileId,
        input.actorUserId,
        "expectedRevision" in input ? input.expectedRevision : 0,
        mutable ? input.availability : null,
        mutable ? input.startsAt.toISOString() : null,
        mutable ? input.endsAt.toISOString() : null,
      ]),
      "utf8",
    )
    .digest("hex");
}

function missingEffect(): Error {
  return new Error("Availability command points to a missing revision effect.");
}
