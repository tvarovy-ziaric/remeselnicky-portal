import { createHash } from "node:crypto";

import {
  assertAddCraftsmanServiceInput,
  assertCraftsmanServiceListInput,
  assertDeactivateCraftsmanServiceInput,
  type AddCraftsmanServiceInput,
  type CraftsmanProfileId,
  type CraftsmanProfessionId,
  type CraftsmanService,
  type CraftsmanServiceId,
  type CraftsmanServicePersistence,
  type DeactivateCraftsmanServiceInput,
  type UserId,
} from "@portal/domain";
import type { Sql, TransactionSql } from "postgres";

interface ServiceRow {
  readonly craftsmanProfessionIds: readonly CraftsmanProfessionId[];
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly createdAt: Date;
  readonly deactivatedAt: Date | null;
  readonly id: CraftsmanServiceId;
  readonly serviceCode: string;
  readonly state: "ACTIVE" | "INACTIVE";
  readonly taxonomyReleaseId: string;
  readonly taxonomyLabel: string;
}

interface CommandRow {
  readonly actorUserId: UserId;
  readonly commandKind: "ADD" | "DEACTIVATE";
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly craftsmanServiceId: CraftsmanServiceId;
  readonly payloadFingerprint: string;
}

export class CraftsmanServiceIdempotencyError extends Error {
  readonly code = "CRAFTSMAN_SERVICE_IDEMPOTENCY_CONFLICT";
}

export function createCraftsmanServiceRepository(
  sql: Sql,
): CraftsmanServicePersistence {
  return Object.freeze({
    add(input: AddCraftsmanServiceInput) {
      assertAddCraftsmanServiceInput(input);
      return sql.begin(async (transaction) => {
        if (!(await lockOwner(transaction, input))) {
          return { status: "PROFILE_UNAVAILABLE" } as const;
        }
        const fingerprint = commandFingerprint("ADD", input);
        const replay = await findCommand(transaction, input.commandId);
        if (replay !== undefined) {
          assertReplay(replay, "ADD", input, fingerprint);
          return deduplicated(transaction, input.craftsmanServiceId);
        }
        const [current] = await transaction<{ readonly releaseId: string }[]>`
          SELECT release_id AS "releaseId"
          FROM profession_taxonomy_activation_events
          ORDER BY activation_sequence DESC LIMIT 1
        `;
        if (current?.releaseId !== input.taxonomyReleaseId) {
          return { status: "TAXONOMY_RELEASE_NOT_CURRENT" } as const;
        }
        const [service] = await transaction<{ readonly active: boolean }[]>`
          SELECT service.state = 'ACTIVE' AS active
          FROM taxonomy_services service
          WHERE service.release_id = ${input.taxonomyReleaseId}
            AND service.service_code = ${input.serviceCode}
        `;
        if (service?.active !== true) {
          return { status: "SERVICE_NOT_ACTIVE" } as const;
        }
        const linked = await transaction<
          { readonly id: CraftsmanProfessionId }[]
        >`
          SELECT assignment.id
          FROM craftsman_professions assignment
          JOIN taxonomy_service_professions relation
            ON relation.release_id = ${input.taxonomyReleaseId}
           AND relation.service_code = ${input.serviceCode}
           AND relation.profession_code = assignment.profession_code
          WHERE assignment.craftsman_profile_id = ${input.craftsmanProfileId}
            AND assignment.id = ANY(${input.craftsmanProfessionIds})
            AND assignment.state = 'ACTIVE'
          ORDER BY assignment.id
          FOR UPDATE OF assignment
        `;
        if (linked.length !== input.craftsmanProfessionIds.length) {
          return { status: "ASSIGNMENT_NOT_ACTIVE" } as const;
        }
        const [existing] = await transaction<{ readonly id: string }[]>`
          SELECT id FROM craftsman_services
          WHERE craftsman_profile_id = ${input.craftsmanProfileId}
            AND service_code = ${input.serviceCode} AND state = 'ACTIVE'
        `;
        if (existing !== undefined)
          return { status: "ALREADY_ACTIVE" } as const;
        await transaction`
          INSERT INTO craftsman_services (
            id, craftsman_profile_id, taxonomy_release_id, service_code,
            created_by_user_id
          ) VALUES (
            ${input.craftsmanServiceId}, ${input.craftsmanProfileId},
            ${input.taxonomyReleaseId}, ${input.serviceCode}, ${input.actorUserId}
          )
        `;
        for (const professionId of [...input.craftsmanProfessionIds].sort()) {
          await transaction`
            INSERT INTO craftsman_service_profession_links (
              craftsman_service_id, craftsman_profession_id
            ) VALUES (${input.craftsmanServiceId}, ${professionId})
          `;
        }
        await insertCommand(transaction, "ADD", input, fingerprint);
        return {
          service: await getService(transaction, input.craftsmanServiceId),
          status: "APPLIED",
        } as const;
      });
    },

    deactivate(input: DeactivateCraftsmanServiceInput) {
      assertDeactivateCraftsmanServiceInput(input);
      return sql.begin(async (transaction) => {
        if (!(await lockOwner(transaction, input))) {
          return { status: "PROFILE_UNAVAILABLE" } as const;
        }
        const fingerprint = commandFingerprint("DEACTIVATE", input);
        const replay = await findCommand(transaction, input.commandId);
        if (replay !== undefined) {
          assertReplay(replay, "DEACTIVATE", input, fingerprint);
          return deduplicated(transaction, input.craftsmanServiceId);
        }
        const [current] = await transaction<{ readonly state: string }[]>`
          SELECT state FROM craftsman_services
          WHERE id = ${input.craftsmanServiceId}
            AND craftsman_profile_id = ${input.craftsmanProfileId}
          FOR UPDATE
        `;
        if (current?.state !== "ACTIVE") {
          return { status: "ASSIGNMENT_NOT_ACTIVE" } as const;
        }
        await insertCommand(transaction, "DEACTIVATE", input, fingerprint);
        await transaction`
          UPDATE craftsman_services SET state = 'INACTIVE',
            deactivated_by_user_id = ${input.actorUserId},
            deactivation_command_id = ${input.commandId}
          WHERE id = ${input.craftsmanServiceId}
        `;
        return {
          service: await getService(transaction, input.craftsmanServiceId),
          status: "APPLIED",
        } as const;
      });
    },

    async listOwned(input: {
      readonly actorUserId: UserId;
      readonly craftsmanProfileId: CraftsmanProfileId;
    }) {
      assertCraftsmanServiceListInput(input);
      const rows = await sql<ServiceRow[]>`
        SELECT current.id, current.craftsman_profile_id AS "craftsmanProfileId",
          current.taxonomy_release_id AS "taxonomyReleaseId",
          current.service_code AS "serviceCode", taxonomy.label_sk AS "taxonomyLabel",
          current.state,
          current.craftsman_profession_ids AS "craftsmanProfessionIds",
          current.created_at AS "createdAt", current.deactivated_at AS "deactivatedAt"
        FROM current_craftsman_services current
        JOIN taxonomy_services taxonomy
          ON taxonomy.release_id = current.taxonomy_release_id
         AND taxonomy.service_code = current.service_code
        JOIN craftsman_profiles profile ON profile.id = current.craftsman_profile_id
        JOIN users owner ON owner.id = profile.owner_user_id
        WHERE current.craftsman_profile_id = ${input.craftsmanProfileId}
          AND profile.owner_user_id = ${input.actorUserId}
          AND owner.account_state = 'ACTIVE'
        ORDER BY current.created_at, current.id
      `;
      return Object.freeze(rows.map(freezeService));
    },
  });
}

async function lockOwner(
  transaction: TransactionSql,
  input: { actorUserId: UserId; craftsmanProfileId: CraftsmanProfileId },
): Promise<boolean> {
  const [row] = await transaction<
    { accountState: string; ownerUserId: UserId }[]
  >`
    SELECT profile.owner_user_id AS "ownerUserId", owner.account_state AS "accountState"
    FROM craftsman_profiles profile JOIN users owner ON owner.id = profile.owner_user_id
    WHERE profile.id = ${input.craftsmanProfileId} FOR UPDATE OF profile, owner
  `;
  return (
    row?.ownerUserId === input.actorUserId && row.accountState === "ACTIVE"
  );
}

async function findCommand(
  transaction: TransactionSql,
  commandId: string,
): Promise<CommandRow | undefined> {
  const [row] = await transaction<CommandRow[]>`
    SELECT command_kind AS "commandKind", craftsman_service_id AS "craftsmanServiceId",
      craftsman_profile_id AS "craftsmanProfileId", actor_user_id AS "actorUserId",
      payload_fingerprint AS "payloadFingerprint"
    FROM craftsman_service_commands WHERE command_id = ${commandId}
  `;
  return row;
}

function assertReplay(
  row: CommandRow,
  kind: "ADD" | "DEACTIVATE",
  input: AddCraftsmanServiceInput | DeactivateCraftsmanServiceInput,
  fingerprint: string,
): void {
  if (
    row.commandKind !== kind ||
    row.craftsmanServiceId !== input.craftsmanServiceId ||
    row.craftsmanProfileId !== input.craftsmanProfileId ||
    row.actorUserId !== input.actorUserId ||
    row.payloadFingerprint !== fingerprint
  ) {
    throw new CraftsmanServiceIdempotencyError(
      "Craftsman service command id was reused with different intent.",
    );
  }
}

async function insertCommand(
  transaction: TransactionSql,
  kind: "ADD" | "DEACTIVATE",
  input: AddCraftsmanServiceInput | DeactivateCraftsmanServiceInput,
  fingerprint: string,
): Promise<void> {
  await transaction`
    INSERT INTO craftsman_service_commands (
      command_id, command_kind, craftsman_service_id, craftsman_profile_id,
      actor_user_id, payload_fingerprint
    ) VALUES (${input.commandId}, ${kind}, ${input.craftsmanServiceId},
      ${input.craftsmanProfileId}, ${input.actorUserId}, ${fingerprint})
  `;
}

function commandFingerprint(
  kind: "ADD" | "DEACTIVATE",
  input: AddCraftsmanServiceInput | DeactivateCraftsmanServiceInput,
): string {
  const add = input as Partial<AddCraftsmanServiceInput>;
  return createHash("sha256")
    .update(
      JSON.stringify([
        kind,
        input.commandId,
        input.craftsmanServiceId,
        input.craftsmanProfileId,
        input.actorUserId,
        add.taxonomyReleaseId ?? null,
        add.serviceCode ?? null,
        [...(add.craftsmanProfessionIds ?? [])].sort(),
      ]),
      "utf8",
    )
    .digest("hex");
}

async function deduplicated(
  transaction: TransactionSql,
  id: CraftsmanServiceId,
) {
  return {
    service: await getService(transaction, id),
    status: "DEDUPLICATED" as const,
  };
}

async function getService(
  sql: TransactionSql,
  id: CraftsmanServiceId,
): Promise<CraftsmanService> {
  const [row] = await sql<ServiceRow[]>`
    SELECT current.id, current.craftsman_profile_id AS "craftsmanProfileId",
      current.taxonomy_release_id AS "taxonomyReleaseId",
      current.service_code AS "serviceCode", taxonomy.label_sk AS "taxonomyLabel",
      current.state, current.craftsman_profession_ids AS "craftsmanProfessionIds",
      current.created_at AS "createdAt", current.deactivated_at AS "deactivatedAt"
    FROM current_craftsman_services current
    JOIN taxonomy_services taxonomy
      ON taxonomy.release_id = current.taxonomy_release_id
     AND taxonomy.service_code = current.service_code
    WHERE current.id = ${id}
  `;
  if (row === undefined)
    throw new Error("Committed craftsman service projection is missing.");
  return freezeService(row);
}

function freezeService(row: ServiceRow): CraftsmanService {
  return Object.freeze({
    ...row,
    craftsmanProfessionIds: Object.freeze([...row.craftsmanProfessionIds]),
  });
}
