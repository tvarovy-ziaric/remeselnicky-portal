import { createHash } from "node:crypto";

import {
  assertArchiveIndicativePricingEntryInput,
  assertIndicativePricingListInput,
  assertNormalizedAddIndicativePricingEntryInput,
  assertNormalizedEditIndicativePricingEntryInput,
  type AddIndicativePricingEntryInput,
  type ArchiveIndicativePricingEntryInput,
  type CraftsmanProfessionId,
  type CraftsmanProfileId,
  type EditIndicativePricingEntryInput,
  type IndicativePriceMode,
  type IndicativePricingEntry,
  type IndicativePricingEntryId,
  type IndicativePricingEntryState,
  type IndicativePricingPersistence,
  type UserId,
} from "@portal/domain";
import type { Sql, TransactionSql } from "postgres";

type PricingCommandKind = "ADD" | "EDIT" | "ARCHIVE";

interface OwnedProfileRow {
  readonly accountState: "ACTIVE" | "SUSPENDED" | "DEACTIVATED";
  readonly ownerUserId: UserId;
}

interface ProfessionLinkRow {
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly state: "ACTIVE" | "INACTIVE";
}

interface PricingEntryRow {
  readonly amountCents: number | string;
  readonly archivedAt: Date | null;
  readonly craftsmanProfessionId: CraftsmanProfessionId | null;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly createdAt: Date;
  readonly currency: "EUR";
  readonly id: IndicativePricingEntryId;
  readonly note: string | null;
  readonly priceMode: IndicativePriceMode;
  readonly revision: number;
  readonly serviceName: string;
  readonly state: IndicativePricingEntryState;
  readonly updatedAt: Date;
}

interface CommandReplayRow extends PricingEntryRow {
  readonly actorUserId: UserId;
  readonly commandKind: PricingCommandKind;
  readonly commandProfileId: CraftsmanProfileId;
  readonly entryId: IndicativePricingEntryId;
  readonly payloadFingerprint: string;
}

export class IndicativePricingIdempotencyError extends Error {
  readonly code = "INDICATIVE_PRICING_IDEMPOTENCY_CONFLICT";
}

export function createIndicativePricingRepository(
  sql: Sql,
): IndicativePricingPersistence {
  return Object.freeze({
    add(input: AddIndicativePricingEntryInput) {
      assertNormalizedAddIndicativePricingEntryInput(input);
      return sql.begin(async (transaction) => {
        if (!(await lockOwnedActiveProfile(transaction, input))) {
          return { status: "PROFILE_UNAVAILABLE" } as const;
        }

        const fingerprint = fingerprintCommand("ADD", input);
        const replay = await findCommandReplay(transaction, input.commandId);
        if (replay !== undefined) {
          assertExactReplay(replay, "ADD", input, fingerprint);
          return deduplicated(replay);
        }

        if (
          !(await professionLinkIsAvailable(
            transaction,
            input.craftsmanProfileId,
            input.craftsmanProfessionId ?? null,
          ))
        ) {
          return { status: "PROFESSION_UNAVAILABLE" } as const;
        }

        const [existing] = await transaction<{ readonly id: string }[]>`
          SELECT id
          FROM indicative_pricing_entries
          WHERE id = ${input.entryId}
        `;
        if (existing !== undefined) {
          return { status: "ENTRY_ALREADY_EXISTS" } as const;
        }

        await transaction`
          INSERT INTO indicative_pricing_entries (
            id,
            craftsman_profile_id,
            craftsman_profession_id,
            service_name,
            price_mode,
            amount_cents,
            currency,
            note,
            latest_command_id,
            created_by_user_id,
            updated_by_user_id
          ) VALUES (
            ${input.entryId},
            ${input.craftsmanProfileId},
            ${input.craftsmanProfessionId ?? null},
            ${input.serviceName},
            ${input.priceMode},
            ${input.amountCents},
            'EUR',
            ${input.note ?? null},
            ${input.commandId},
            ${input.actorUserId},
            ${input.actorUserId}
          )
        `;
        await insertCommand(transaction, "ADD", input, fingerprint);
        await insertCurrentRevision(transaction, input.entryId);
        return {
          entry: await getCurrentEntryOrThrow(transaction, input.entryId),
          status: "APPLIED",
        } as const;
      });
    },

    edit(input: EditIndicativePricingEntryInput) {
      assertNormalizedEditIndicativePricingEntryInput(input);
      return sql.begin(async (transaction) => {
        if (!(await lockOwnedActiveProfile(transaction, input))) {
          return { status: "PROFILE_UNAVAILABLE" } as const;
        }

        const fingerprint = fingerprintCommand("EDIT", input);
        const replay = await findCommandReplay(transaction, input.commandId);
        if (replay !== undefined) {
          assertExactReplay(replay, "EDIT", input, fingerprint);
          return deduplicated(replay);
        }

        const current = await lockOwnedEntry(transaction, input);
        if (current === undefined) {
          return { status: "ENTRY_UNAVAILABLE" } as const;
        }
        if (current.state !== "ACTIVE") {
          return { status: "ENTRY_ARCHIVED" } as const;
        }
        if (current.revision !== input.expectedRevision) {
          return { status: "STALE_REVISION" } as const;
        }
        if (
          !(await professionLinkIsAvailable(
            transaction,
            input.craftsmanProfileId,
            input.craftsmanProfessionId,
          ))
        ) {
          return { status: "PROFESSION_UNAVAILABLE" } as const;
        }
        if (entryMatchesInput(current, input)) {
          return { status: "UNCHANGED" } as const;
        }

        await insertCommand(transaction, "EDIT", input, fingerprint);
        await transaction`
          UPDATE indicative_pricing_entries
          SET
            craftsman_profession_id = ${input.craftsmanProfessionId},
            service_name = ${input.serviceName},
            price_mode = ${input.priceMode},
            amount_cents = ${input.amountCents},
            note = ${input.note},
            latest_command_id = ${input.commandId}
          WHERE id = ${input.entryId}
            AND craftsman_profile_id = ${input.craftsmanProfileId}
            AND revision = ${input.expectedRevision}
        `;
        await insertCurrentRevision(transaction, input.entryId);
        return {
          entry: await getCurrentEntryOrThrow(transaction, input.entryId),
          status: "APPLIED",
        } as const;
      });
    },

    archive(input: ArchiveIndicativePricingEntryInput) {
      assertArchiveIndicativePricingEntryInput(input);
      return sql.begin(async (transaction) => {
        if (!(await lockOwnedActiveProfile(transaction, input))) {
          return { status: "PROFILE_UNAVAILABLE" } as const;
        }

        const fingerprint = fingerprintCommand("ARCHIVE", input);
        const replay = await findCommandReplay(transaction, input.commandId);
        if (replay !== undefined) {
          assertExactReplay(replay, "ARCHIVE", input, fingerprint);
          return deduplicated(replay);
        }

        const current = await lockOwnedEntry(transaction, input);
        if (current === undefined) {
          return { status: "ENTRY_UNAVAILABLE" } as const;
        }
        if (current.state !== "ACTIVE") {
          return { status: "ENTRY_ARCHIVED" } as const;
        }
        if (current.revision !== input.expectedRevision) {
          return { status: "STALE_REVISION" } as const;
        }

        await insertCommand(transaction, "ARCHIVE", input, fingerprint);
        await transaction`
          UPDATE indicative_pricing_entries
          SET
            state = 'ARCHIVED',
            latest_command_id = ${input.commandId}
          WHERE id = ${input.entryId}
            AND craftsman_profile_id = ${input.craftsmanProfileId}
            AND revision = ${input.expectedRevision}
        `;
        await insertCurrentRevision(transaction, input.entryId);
        return {
          entry: await getCurrentEntryOrThrow(transaction, input.entryId),
          status: "APPLIED",
        } as const;
      });
    },

    async listOwned(input: {
      readonly actorUserId: UserId;
      readonly craftsmanProfileId: CraftsmanProfileId;
      readonly includeArchived?: boolean;
    }) {
      assertIndicativePricingListInput(input);
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

      const rows = await sql<PricingEntryRow[]>`
        SELECT
          id,
          craftsman_profile_id AS "craftsmanProfileId",
          craftsman_profession_id AS "craftsmanProfessionId",
          service_name AS "serviceName",
          price_mode AS "priceMode",
          amount_cents AS "amountCents",
          currency,
          note,
          state,
          revision,
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt"
        FROM indicative_pricing_entries
        WHERE craftsman_profile_id = ${input.craftsmanProfileId}
          AND (${input.includeArchived ?? false} OR state = 'ACTIVE')
        ORDER BY created_at, id
      `;
      return freezeEntries(rows);
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

async function professionLinkIsAvailable(
  transaction: TransactionSql,
  profileId: CraftsmanProfileId,
  professionId: CraftsmanProfessionId | null,
): Promise<boolean> {
  if (professionId === null) return true;
  const [profession] = await transaction<ProfessionLinkRow[]>`
    SELECT
      craftsman_profile_id AS "craftsmanProfileId",
      state
    FROM craftsman_professions
    WHERE id = ${professionId}
    FOR KEY SHARE
  `;
  return (
    profession?.craftsmanProfileId === profileId &&
    profession.state === "ACTIVE"
  );
}

async function lockOwnedEntry(
  transaction: TransactionSql,
  input: {
    readonly craftsmanProfileId: CraftsmanProfileId;
    readonly entryId: IndicativePricingEntryId;
  },
): Promise<PricingEntryRow | undefined> {
  const [entry] = await transaction<PricingEntryRow[]>`
    SELECT
      id,
      craftsman_profile_id AS "craftsmanProfileId",
      craftsman_profession_id AS "craftsmanProfessionId",
      service_name AS "serviceName",
      price_mode AS "priceMode",
      amount_cents AS "amountCents",
      currency,
      note,
      state,
      revision,
      created_at AS "createdAt",
      updated_at AS "updatedAt",
      archived_at AS "archivedAt"
    FROM indicative_pricing_entries
    WHERE id = ${input.entryId}
      AND craftsman_profile_id = ${input.craftsmanProfileId}
    FOR UPDATE
  `;
  return entry;
}

async function findCommandReplay(
  transaction: TransactionSql,
  commandId: string,
): Promise<CommandReplayRow | undefined> {
  const [replay] = await transaction<CommandReplayRow[]>`
    SELECT
      command.command_kind AS "commandKind",
      command.entry_id AS "entryId",
      command.craftsman_profile_id AS "commandProfileId",
      command.actor_user_id AS "actorUserId",
      command.payload_fingerprint AS "payloadFingerprint",
      history.entry_id AS id,
      history.craftsman_profile_id AS "craftsmanProfileId",
      history.craftsman_profession_id AS "craftsmanProfessionId",
      history.service_name AS "serviceName",
      history.price_mode AS "priceMode",
      history.amount_cents AS "amountCents",
      history.currency,
      history.note,
      history.state,
      history.revision,
      history.created_at AS "createdAt",
      history.updated_at AS "updatedAt",
      history.archived_at AS "archivedAt"
    FROM indicative_pricing_commands command
    JOIN indicative_pricing_entry_revisions history
      ON history.command_id = command.command_id
    WHERE command.command_id = ${commandId}
  `;
  return replay;
}

function assertExactReplay(
  replay: CommandReplayRow,
  kind: PricingCommandKind,
  input: {
    readonly actorUserId: UserId;
    readonly commandId: string;
    readonly craftsmanProfileId: CraftsmanProfileId;
    readonly entryId: IndicativePricingEntryId;
  },
  fingerprint: string,
): void {
  if (
    replay.commandKind !== kind ||
    replay.actorUserId !== input.actorUserId ||
    replay.entryId !== input.entryId ||
    replay.commandProfileId !== input.craftsmanProfileId ||
    replay.payloadFingerprint !== fingerprint
  ) {
    throw new IndicativePricingIdempotencyError(
      "Indicative pricing command id was reused with different intent.",
    );
  }
}

async function insertCommand(
  transaction: TransactionSql,
  kind: PricingCommandKind,
  input: {
    readonly actorUserId: UserId;
    readonly commandId: string;
    readonly craftsmanProfileId: CraftsmanProfileId;
    readonly entryId: IndicativePricingEntryId;
  },
  fingerprint: string,
): Promise<void> {
  await transaction`
    INSERT INTO indicative_pricing_commands (
      command_id,
      command_kind,
      entry_id,
      craftsman_profile_id,
      actor_user_id,
      payload_fingerprint
    ) VALUES (
      ${input.commandId},
      ${kind},
      ${input.entryId},
      ${input.craftsmanProfileId},
      ${input.actorUserId},
      ${fingerprint}
    )
  `;
}

async function insertCurrentRevision(
  transaction: TransactionSql,
  entryId: IndicativePricingEntryId,
): Promise<void> {
  await transaction`
    INSERT INTO indicative_pricing_entry_revisions (
      entry_id,
      revision,
      command_id,
      craftsman_profile_id,
      craftsman_profession_id,
      service_name,
      price_mode,
      amount_cents,
      currency,
      note,
      state,
      actor_user_id,
      created_at,
      updated_at,
      archived_at
    )
    SELECT
      entry.id,
      entry.revision,
      entry.latest_command_id,
      entry.craftsman_profile_id,
      entry.craftsman_profession_id,
      entry.service_name,
      entry.price_mode,
      entry.amount_cents,
      entry.currency,
      entry.note,
      entry.state,
      entry.updated_by_user_id,
      entry.created_at,
      entry.updated_at,
      entry.archived_at
    FROM indicative_pricing_entries entry
    WHERE entry.id = ${entryId}
  `;
}

function fingerprintCommand(
  kind: PricingCommandKind,
  input:
    | AddIndicativePricingEntryInput
    | EditIndicativePricingEntryInput
    | ArchiveIndicativePricingEntryInput,
): string {
  const details = "serviceName" in input ? input : undefined;
  return createHash("sha256")
    .update(
      JSON.stringify([
        kind,
        input.commandId,
        input.entryId,
        input.craftsmanProfileId,
        input.actorUserId,
        "expectedRevision" in input ? input.expectedRevision : null,
        details?.craftsmanProfessionId ?? null,
        details?.serviceName ?? null,
        details?.priceMode ?? null,
        details?.amountCents ?? null,
        details?.note ?? null,
      ]),
      "utf8",
    )
    .digest("hex");
}

async function getCurrentEntryOrThrow(
  transaction: TransactionSql,
  entryId: IndicativePricingEntryId,
): Promise<IndicativePricingEntry> {
  const [entry] = await transaction<PricingEntryRow[]>`
    SELECT
      id,
      craftsman_profile_id AS "craftsmanProfileId",
      craftsman_profession_id AS "craftsmanProfessionId",
      service_name AS "serviceName",
      price_mode AS "priceMode",
      amount_cents AS "amountCents",
      currency,
      note,
      state,
      revision,
      created_at AS "createdAt",
      updated_at AS "updatedAt",
      archived_at AS "archivedAt"
    FROM indicative_pricing_entries
    WHERE id = ${entryId}
  `;
  if (entry === undefined) {
    throw new Error("Committed indicative pricing projection is missing.");
  }
  return freezeEntry(entry);
}

function entryMatchesInput(
  entry: PricingEntryRow,
  input: EditIndicativePricingEntryInput,
): boolean {
  return (
    entry.craftsmanProfessionId === input.craftsmanProfessionId &&
    entry.serviceName === input.serviceName &&
    entry.priceMode === input.priceMode &&
    parseAmountCents(entry.amountCents) === input.amountCents &&
    entry.note === input.note
  );
}

function deduplicated(replay: CommandReplayRow): {
  readonly entry: IndicativePricingEntry;
  readonly status: "DEDUPLICATED";
} {
  return { entry: freezeEntry(replay), status: "DEDUPLICATED" };
}

function freezeEntry(row: PricingEntryRow): IndicativePricingEntry {
  return Object.freeze({
    amountCents: parseAmountCents(row.amountCents),
    archivedAt: row.archivedAt,
    craftsmanProfessionId: row.craftsmanProfessionId,
    craftsmanProfileId: row.craftsmanProfileId,
    createdAt: row.createdAt,
    currency: row.currency,
    id: row.id,
    note: row.note,
    priceMode: row.priceMode,
    revision: row.revision,
    serviceName: row.serviceName,
    state: row.state,
    updatedAt: row.updatedAt,
  });
}

function freezeEntries(
  rows: readonly PricingEntryRow[],
): readonly IndicativePricingEntry[] {
  return Object.freeze(rows.map(freezeEntry));
}

function parseAmountCents(value: number | string): number {
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error("Database returned an invalid indicative EUR-cent amount.");
  }
  return amount;
}
