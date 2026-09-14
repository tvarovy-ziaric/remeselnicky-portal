import { createHash } from "node:crypto";

import type {
  CraftsmanProfileId,
  CustomerProfileId,
  UserId,
} from "@portal/domain";
import type { Sql, TransactionSql } from "postgres";

export interface CustomerShortlistRepositoryCommandInput {
  readonly actorUserId: UserId;
  readonly commandId: string;
  readonly craftsmanProfileId: CraftsmanProfileId;
}

export interface CustomerShortlistRepositoryAddInput extends CustomerShortlistRepositoryCommandInput {
  readonly customerProfileId: CustomerProfileId;
}

export type CustomerShortlistRepositoryCommandResult = Readonly<
  | {
      readonly activeShortlistSize?: number;
      readonly revision: number;
      readonly state: "ACTIVE" | "REMOVED";
      readonly status: "APPLIED" | "UNCHANGED" | "DEDUPLICATED";
    }
  | { readonly status: "ACCOUNT_NOT_ACTIVE" | "TARGET_NOT_AVAILABLE" }
>;

export type CustomerShortlistRepositoryListResult = Readonly<
  | {
      readonly entries: readonly Readonly<{
        craftsmanProfileId: CraftsmanProfileId;
        revision: number;
        savedAt: Date;
        state: "ACTIVE";
        targetAvailable: boolean;
      }>[];
      readonly status: "OK";
    }
  | { readonly status: "ACCOUNT_NOT_ACTIVE" }
>;

interface CommandRow {
  readonly actorUserId: string;
  readonly craftsmanProfileId: string;
  readonly customerProfileId: string;
  readonly payloadFingerprint: string;
  readonly resultingRevision: number;
  readonly targetState: "ACTIVE" | "REMOVED";
}

interface EntryRow {
  readonly revision: number;
  readonly state: "ACTIVE" | "REMOVED";
}

export class CustomerShortlistIdempotencyError extends Error {
  readonly code = "CUSTOMER_SHORTLIST_IDEMPOTENCY_CONFLICT";
}

export function createCustomerShortlistRepository(sql: Sql) {
  return Object.freeze({
    async addOwned(
      input: CustomerShortlistRepositoryAddInput,
    ): Promise<CustomerShortlistRepositoryCommandResult> {
      assertInput(input);
      return sql.begin(async (transaction) => {
        if (
          !(await lockTargetAndActors(
            transaction,
            input.actorUserId,
            input.craftsmanProfileId,
          ))
        ) {
          return Object.freeze({ status: "TARGET_NOT_AVAILABLE" as const });
        }
        if (
          !(await lockActiveCustomer(
            transaction,
            input.actorUserId,
            input.customerProfileId,
          ))
        ) {
          return Object.freeze({ status: "ACCOUNT_NOT_ACTIVE" as const });
        }
        const replay = await replayCommand(transaction, input, "ADD");
        if (replay !== null) return replay;

        const searchable = await transaction`
          SELECT craftsman_profile_id
          FROM current_searchable_craftsman_profiles
          WHERE craftsman_profile_id = ${input.craftsmanProfileId}
        `;
        if (searchable.length !== 1) {
          return Object.freeze({ status: "TARGET_NOT_AVAILABLE" as const });
        }
        return applyCommand(transaction, input, "ADD", "ACTIVE");
      });
    },

    async listOwned(
      actorUserId: UserId,
    ): Promise<CustomerShortlistRepositoryListResult> {
      assertUuid(actorUserId, "Shortlist actor user id");
      return sql.begin(async (transaction) => {
        const customerProfileId = await lockActiveActorCustomer(
          transaction,
          actorUserId,
        );
        if (customerProfileId === "ACCOUNT_NOT_ACTIVE") {
          return Object.freeze({ status: "ACCOUNT_NOT_ACTIVE" as const });
        }
        if (customerProfileId === null) {
          return Object.freeze({ entries: [], status: "OK" as const });
        }
        const rows = await transaction<
          {
            readonly craftsmanProfileId: string;
            readonly revision: number;
            readonly savedAt: Date;
            readonly targetAvailable: boolean;
          }[]
        >`
          SELECT entry.craftsman_profile_id AS "craftsmanProfileId",
            entry.revision, entry.active_since AS "savedAt",
            searchable.craftsman_profile_id IS NOT NULL AS "targetAvailable"
          FROM customer_shortlist_entries entry
          LEFT JOIN current_searchable_craftsman_profiles searchable
            ON searchable.craftsman_profile_id = entry.craftsman_profile_id
          WHERE entry.customer_profile_id = ${customerProfileId}
            AND entry.state = 'ACTIVE'
          ORDER BY entry.changed_at DESC, entry.craftsman_profile_id
        `;
        return Object.freeze({
          entries: Object.freeze(
            rows.map((row) =>
              Object.freeze({
                craftsmanProfileId:
                  row.craftsmanProfileId as CraftsmanProfileId,
                revision: row.revision,
                savedAt: row.savedAt,
                state: "ACTIVE" as const,
                targetAvailable: row.targetAvailable,
              }),
            ),
          ),
          status: "OK" as const,
        });
      });
    },

    async removeOwned(
      input: CustomerShortlistRepositoryAddInput,
    ): Promise<CustomerShortlistRepositoryCommandResult> {
      assertInput(input);
      return sql.begin(async (transaction) => {
        if (
          !(await lockTargetAndActors(
            transaction,
            input.actorUserId,
            input.craftsmanProfileId,
          ))
        ) {
          return Object.freeze({ status: "TARGET_NOT_AVAILABLE" as const });
        }
        if (
          !(await lockActiveCustomer(
            transaction,
            input.actorUserId,
            input.customerProfileId,
          ))
        ) {
          return Object.freeze({ status: "ACCOUNT_NOT_ACTIVE" as const });
        }
        const replay = await replayCommand(transaction, input, "REMOVE");
        return replay ?? applyCommand(transaction, input, "REMOVE", "REMOVED");
      });
    },
  });
}

async function applyCommand(
  transaction: TransactionSql,
  input: CustomerShortlistRepositoryAddInput,
  commandKind: "ADD" | "REMOVE",
  targetState: "ACTIVE" | "REMOVED",
): Promise<CustomerShortlistRepositoryCommandResult> {
  const [current] = await transaction<EntryRow[]>`
    SELECT revision, state FROM customer_shortlist_entries
    WHERE customer_profile_id = ${input.customerProfileId}
      AND craftsman_profile_id = ${input.craftsmanProfileId}
    FOR UPDATE
  `;
  const currentRevision = current?.revision ?? 0;
  const unchanged =
    current?.state === targetState ||
    (current === undefined && commandKind === "REMOVE");
  const resultingRevision = unchanged ? currentRevision : currentRevision + 1;
  const resultKind = unchanged ? "UNCHANGED" : "APPLIED";
  await transaction`
    INSERT INTO customer_shortlist_commands (
      command_id, customer_profile_id, craftsman_profile_id, actor_user_id,
      command_kind, expected_revision, result_kind, resulting_revision,
      target_state, payload_fingerprint
    ) VALUES (
      ${input.commandId}, ${input.customerProfileId}, ${input.craftsmanProfileId},
      ${input.actorUserId}, ${commandKind}, ${currentRevision},
      ${resultKind}, ${resultingRevision}, ${targetState}, ${fingerprint(input, commandKind)}
    )
  `;
  if (!unchanged) {
    const [effect] = await transaction<{ readonly changedAt: Date }[]>`
      INSERT INTO customer_shortlist_effects (
        command_id, customer_profile_id, craftsman_profile_id, revision, state, changed_at
      ) VALUES (
        ${input.commandId}, ${input.customerProfileId}, ${input.craftsmanProfileId},
        ${resultingRevision}, ${targetState}, clock_timestamp()
      ) RETURNING changed_at AS "changedAt"
    `;
    if (effect === undefined)
      throw new Error("Shortlist effect insert returned no row.");
    await transaction`
      INSERT INTO customer_shortlist_entries (
        customer_profile_id, craftsman_profile_id, state, revision,
        latest_command_id, active_since, changed_at
      ) VALUES (
        ${input.customerProfileId}, ${input.craftsmanProfileId}, ${targetState},
        ${resultingRevision}, ${input.commandId},
        ${targetState === "ACTIVE" ? effect.changedAt : null}, ${effect.changedAt}
      ) ON CONFLICT (customer_profile_id, craftsman_profile_id) DO UPDATE SET
        state = EXCLUDED.state, revision = EXCLUDED.revision,
        latest_command_id = EXCLUDED.latest_command_id,
        active_since = EXCLUDED.active_since, changed_at = EXCLUDED.changed_at
    `;
    const [size] = await transaction<{ readonly count: number }[]>`
      SELECT count(*)::integer AS count
      FROM customer_shortlist_entries
      WHERE customer_profile_id = ${input.customerProfileId}
        AND state = 'ACTIVE'
    `;
    if (size === undefined)
      throw new Error("Shortlist size query returned no row.");
    return Object.freeze({
      activeShortlistSize: size.count,
      revision: resultingRevision,
      state: targetState,
      status: resultKind,
    });
  }
  return Object.freeze({
    revision: resultingRevision,
    state: targetState,
    status: resultKind,
  });
}

async function replayCommand(
  sql: TransactionSql,
  input: CustomerShortlistRepositoryAddInput,
  kind: "ADD" | "REMOVE",
): Promise<CustomerShortlistRepositoryCommandResult | null> {
  const [row] = await sql<CommandRow[]>`
    SELECT actor_user_id AS "actorUserId", customer_profile_id AS "customerProfileId",
      craftsman_profile_id AS "craftsmanProfileId", payload_fingerprint AS "payloadFingerprint",
      resulting_revision AS "resultingRevision", target_state AS "targetState"
    FROM customer_shortlist_commands WHERE command_id = ${input.commandId}
  `;
  if (row === undefined) return null;
  if (
    row.actorUserId !== input.actorUserId ||
    row.customerProfileId !== input.customerProfileId ||
    row.craftsmanProfileId !== input.craftsmanProfileId ||
    row.payloadFingerprint !== fingerprint(input, kind)
  ) {
    throw new CustomerShortlistIdempotencyError(
      "Shortlist command id was reused for a different intent.",
    );
  }
  return Object.freeze({
    revision: row.resultingRevision,
    state: row.targetState,
    status: "DEDUPLICATED" as const,
  });
}

async function lockActiveCustomer(
  sql: TransactionSql,
  actorUserId: UserId,
  customerProfileId: CustomerProfileId,
) {
  const rows = await sql`
    SELECT customer.id FROM users actor
    JOIN customer_profiles customer ON customer.owner_user_id = actor.id
    WHERE actor.id = ${actorUserId} AND actor.account_state = 'ACTIVE'
      AND customer.id = ${customerProfileId}
    FOR UPDATE OF customer
  `;
  return rows.length === 1;
}

async function lockTargetAndActors(
  sql: TransactionSql,
  actorUserId: UserId,
  craftsmanProfileId: CraftsmanProfileId,
): Promise<boolean> {
  const [target] = await sql<{ readonly ownerUserId: string }[]>`
    SELECT owner_user_id AS "ownerUserId"
    FROM craftsman_profiles
    WHERE id = ${craftsmanProfileId}
  `;
  if (target === undefined) return false;
  const lockedProfiles = await sql`
    SELECT id FROM craftsman_profiles WHERE id = ${craftsmanProfileId} FOR UPDATE
  `;
  if (lockedProfiles.length !== 1) return false;
  const lockedUsers = await sql`
    SELECT id FROM users
    WHERE id IN (${actorUserId}, ${target.ownerUserId})
    ORDER BY id
    FOR UPDATE
  `;
  return lockedUsers.length === new Set([actorUserId, target.ownerUserId]).size;
}

async function lockActiveActorCustomer(
  sql: TransactionSql,
  actorUserId: UserId,
): Promise<CustomerProfileId | "ACCOUNT_NOT_ACTIVE" | null> {
  const [actor] = await sql<{ readonly accountState: string }[]>`
    SELECT account_state AS "accountState" FROM users WHERE id = ${actorUserId} FOR UPDATE
  `;
  if (actor?.accountState !== "ACTIVE") return "ACCOUNT_NOT_ACTIVE";
  const [customer] = await sql<{ readonly id: string }[]>`
    SELECT id FROM customer_profiles WHERE owner_user_id = ${actorUserId} FOR UPDATE
  `;
  return customer === undefined ? null : (customer.id as CustomerProfileId);
}

function fingerprint(
  input: CustomerShortlistRepositoryCommandInput,
  kind: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        actorUserId: input.actorUserId,
        commandKind: kind,
        craftsmanProfileId: input.craftsmanProfileId,
      }),
    )
    .digest("hex");
}

function assertInput(input: CustomerShortlistRepositoryCommandInput): void {
  assertUuid(input.actorUserId, "Shortlist actor user id");
  assertUuid(input.commandId, "Shortlist command id");
  assertUuid(input.craftsmanProfileId, "Shortlist craftsman profile id");
}

function assertUuid(value: unknown, label: string): void {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    throw new TypeError(`${label} must be a UUID.`);
  }
}
