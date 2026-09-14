import { createHash } from "node:crypto";

import {
  assertListOwnedFeaturedProjectsInput,
  assertPinFeaturedProjectInput,
  assertReorderFeaturedProjectsInput,
  assertUnpinFeaturedProjectInput,
  MAX_FEATURED_PROJECTS,
  type CraftsmanProfileId,
  type FeaturedProjectCommandResult,
  type FeaturedProjectItem,
  type FeaturedProjectPersistence,
  type FeaturedProjectSet,
  type ListOwnedFeaturedProjectsInput,
  type PinFeaturedProjectInput,
  type PortfolioProjectId,
  type ReorderFeaturedProjectsInput,
  type UnpinFeaturedProjectInput,
  type UserId,
} from "@portal/domain";
import type { Sql, TransactionSql } from "postgres";

type FeaturedCommandKind = "PIN" | "UNPIN" | "REORDER";

interface OwnedProfileRow {
  readonly accountState: string;
  readonly ownerUserId: UserId;
}

interface FeaturedSetRow {
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly projectIds: readonly PortfolioProjectId[];
  readonly revision: number;
  readonly updatedAt: Date;
}

interface FeaturedCommandRow {
  readonly actorUserId: UserId;
  readonly commandKind: FeaturedCommandKind;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly payloadFingerprint: string;
  readonly resultingRevision: number;
}

interface FeaturedItemRow {
  readonly available: boolean;
  readonly position: number;
  readonly portfolioProjectId: PortfolioProjectId;
  readonly title: string | null;
}

export class FeaturedProjectIdempotencyError extends Error {
  readonly code = "FEATURED_PROJECT_IDEMPOTENCY_CONFLICT";
}

export function createFeaturedProjectRepository(
  sql: Sql,
): FeaturedProjectPersistence {
  return Object.freeze({
    pin(input: PinFeaturedProjectInput) {
      assertPinFeaturedProjectInput(input);
      const fingerprint = fingerprintCommand("PIN", input);
      return sql.begin(async (transaction) => {
        const authorized = await authorizeOrReplay(
          transaction,
          input,
          "PIN",
          fingerprint,
        );
        if ("result" in authorized) return authorized.result;
        const current = authorized.current;
        if (current.revision !== input.expectedRevision) {
          return { status: "STALE_REVISION" } as const;
        }
        if (current.projectIds.includes(input.portfolioProjectId)) {
          return { status: "PROJECT_ALREADY_FEATURED" } as const;
        }
        if (current.projectIds.length >= MAX_FEATURED_PROJECTS) {
          return { status: "FEATURED_LIMIT_REACHED" } as const;
        }
        if (
          !(await projectsAvailable(transaction, input, [
            input.portfolioProjectId,
          ]))
        ) {
          return { status: "PROJECT_UNAVAILABLE" } as const;
        }
        const resulting = Object.freeze([
          ...current.projectIds,
          input.portfolioProjectId,
        ]);
        return applyCommand(
          transaction,
          "PIN",
          input,
          resulting,
          input.portfolioProjectId,
          fingerprint,
        );
      });
    },

    unpin(input: UnpinFeaturedProjectInput) {
      assertUnpinFeaturedProjectInput(input);
      const fingerprint = fingerprintCommand("UNPIN", input);
      return sql.begin(async (transaction) => {
        const authorized = await authorizeOrReplay(
          transaction,
          input,
          "UNPIN",
          fingerprint,
        );
        if ("result" in authorized) return authorized.result;
        const current = authorized.current;
        if (current.revision !== input.expectedRevision) {
          return { status: "STALE_REVISION" } as const;
        }
        if (!current.projectIds.includes(input.portfolioProjectId)) {
          return { status: "PROJECT_NOT_FEATURED" } as const;
        }
        const resulting = Object.freeze(
          current.projectIds.filter((id) => id !== input.portfolioProjectId),
        );
        if (!(await projectsAvailable(transaction, input, resulting))) {
          return { status: "PROJECT_UNAVAILABLE" } as const;
        }
        return applyCommand(
          transaction,
          "UNPIN",
          input,
          resulting,
          input.portfolioProjectId,
          fingerprint,
        );
      });
    },

    reorder(input: ReorderFeaturedProjectsInput) {
      assertReorderFeaturedProjectsInput(input);
      const fingerprint = fingerprintCommand("REORDER", input);
      return sql.begin(async (transaction) => {
        const authorized = await authorizeOrReplay(
          transaction,
          input,
          "REORDER",
          fingerprint,
        );
        if ("result" in authorized) return authorized.result;
        const current = authorized.current;
        if (current.revision !== input.expectedRevision) {
          return { status: "STALE_REVISION" } as const;
        }
        if (
          !sameMembers(current.projectIds, input.orderedPortfolioProjectIds)
        ) {
          return { status: "INVALID_ORDER" } as const;
        }
        if (arraysEqual(current.projectIds, input.orderedPortfolioProjectIds)) {
          return { status: "UNCHANGED" } as const;
        }
        if (
          !(await projectsAvailable(
            transaction,
            input,
            input.orderedPortfolioProjectIds,
          ))
        ) {
          return { status: "PROJECT_UNAVAILABLE" } as const;
        }
        return applyCommand(
          transaction,
          "REORDER",
          input,
          Object.freeze([...input.orderedPortfolioProjectIds]),
          null,
          fingerprint,
        );
      });
    },

    async listOwned(input: ListOwnedFeaturedProjectsInput) {
      assertListOwnedFeaturedProjectsInput(input);
      return sql.begin(async (transaction) => {
        if (!(await lockOwnedActiveProfile(transaction, input))) return null;
        const current = await getCurrentSet(
          transaction,
          input.craftsmanProfileId,
          false,
        );
        return current === undefined
          ? null
          : presentSet(transaction, current, input.actorUserId);
      });
    },
  });
}

async function authorizeOrReplay(
  transaction: TransactionSql,
  input: {
    readonly actorUserId: UserId;
    readonly commandId: string;
    readonly craftsmanProfileId: CraftsmanProfileId;
  },
  kind: FeaturedCommandKind,
  fingerprint: string,
): Promise<
  | { readonly current: FeaturedSetRow }
  | { readonly result: FeaturedProjectCommandResult }
> {
  if (!(await lockOwnedActiveProfile(transaction, input))) {
    return { result: { status: "PROFILE_UNAVAILABLE" } };
  }
  const replay = await findCommand(transaction, input.commandId);
  if (replay !== undefined) {
    assertExactReplay(replay, kind, input, fingerprint);
    const historical = await getHistoricalSet(
      transaction,
      input.craftsmanProfileId,
      input.commandId,
      replay.resultingRevision,
    );
    return {
      result: {
        featured: await presentSet(transaction, historical, input.actorUserId),
        status: "DEDUPLICATED",
      },
    };
  }
  const current = await getCurrentSet(
    transaction,
    input.craftsmanProfileId,
    true,
  );
  return current === undefined
    ? { result: { status: "PROFILE_UNAVAILABLE" } }
    : { current };
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
    WHERE profile.id = ${input.craftsmanProfileId}
    FOR UPDATE OF profile, owner
  `;
  return (
    row?.ownerUserId === input.actorUserId && row.accountState === "ACTIVE"
  );
}

async function getCurrentSet(
  sql: TransactionSql,
  profileId: CraftsmanProfileId,
  forUpdate: boolean,
): Promise<FeaturedSetRow | undefined> {
  const rows = forUpdate
    ? await sql<FeaturedSetRow[]>`
      SELECT craftsman_profile_id AS "craftsmanProfileId", project_ids AS "projectIds",
        revision, updated_at AS "updatedAt" FROM featured_project_sets
      WHERE craftsman_profile_id = ${profileId} FOR UPDATE`
    : await sql<FeaturedSetRow[]>`
      SELECT craftsman_profile_id AS "craftsmanProfileId", project_ids AS "projectIds",
        revision, updated_at AS "updatedAt" FROM featured_project_sets
      WHERE craftsman_profile_id = ${profileId}`;
  return rows[0];
}

async function projectsAvailable(
  transaction: TransactionSql,
  input: {
    readonly actorUserId: UserId;
    readonly craftsmanProfileId: CraftsmanProfileId;
  },
  projectIds: readonly PortfolioProjectId[],
): Promise<boolean> {
  if (projectIds.length === 0) return true;
  const rows = await transaction<{ readonly id: PortfolioProjectId }[]>`
    SELECT id FROM portfolio_projects
    WHERE id = ANY(${projectIds}::uuid[])
      AND craftsman_profile_id = ${input.craftsmanProfileId}
      AND author_user_id = ${input.actorUserId}
      AND record_state = 'DRAFT'
    ORDER BY id FOR UPDATE
  `;
  return rows.length === projectIds.length;
}

async function findCommand(
  transaction: TransactionSql,
  commandId: string,
): Promise<FeaturedCommandRow | undefined> {
  const [row] = await transaction<FeaturedCommandRow[]>`
    SELECT command_kind AS "commandKind", craftsman_profile_id AS "craftsmanProfileId",
      actor_user_id AS "actorUserId", resulting_revision AS "resultingRevision",
      payload_fingerprint AS "payloadFingerprint"
    FROM featured_project_commands WHERE command_id = ${commandId}
  `;
  return row;
}

function assertExactReplay(
  row: FeaturedCommandRow,
  kind: FeaturedCommandKind,
  input: {
    readonly actorUserId: UserId;
    readonly craftsmanProfileId: CraftsmanProfileId;
  },
  fingerprint: string,
): void {
  if (
    row.commandKind !== kind ||
    row.actorUserId !== input.actorUserId ||
    row.craftsmanProfileId !== input.craftsmanProfileId ||
    row.payloadFingerprint !== fingerprint
  ) {
    throw new FeaturedProjectIdempotencyError(
      "Featured project command id was reused with different intent.",
    );
  }
}

async function applyCommand(
  transaction: TransactionSql,
  kind: FeaturedCommandKind,
  input: {
    readonly actorUserId: UserId;
    readonly commandId: string;
    readonly craftsmanProfileId: CraftsmanProfileId;
    readonly expectedRevision: number;
  },
  resultingProjectIds: readonly PortfolioProjectId[],
  targetProjectId: PortfolioProjectId | null,
  fingerprint: string,
): Promise<FeaturedProjectCommandResult> {
  const resultingRevision = input.expectedRevision + 1;
  await transaction`
    INSERT INTO featured_project_commands (
      command_id, command_kind, craftsman_profile_id, actor_user_id,
      expected_revision, resulting_revision, target_project_id,
      resulting_project_ids, payload_fingerprint
    ) VALUES (${input.commandId}, ${kind}, ${input.craftsmanProfileId},
      ${input.actorUserId}, ${input.expectedRevision}, ${resultingRevision},
      ${targetProjectId}, ${resultingProjectIds}, ${fingerprint})
  `;
  await transaction`
    UPDATE featured_project_sets SET project_ids = ${resultingProjectIds},
      revision = ${resultingRevision}, latest_command_id = ${input.commandId}
    WHERE craftsman_profile_id = ${input.craftsmanProfileId}
  `;
  await transaction`
    INSERT INTO featured_project_revisions (
      event_id, command_id, craftsman_profile_id, revision, project_ids,
      actor_user_id
    ) VALUES (${input.commandId}, ${input.commandId}, ${input.craftsmanProfileId},
      ${resultingRevision}, ${resultingProjectIds}, ${input.actorUserId})
  `;
  const applied = await getHistoricalSet(
    transaction,
    input.craftsmanProfileId,
    input.commandId,
    resultingRevision,
  );
  return {
    featured: await presentSet(transaction, applied, input.actorUserId),
    status: "APPLIED",
  };
}

async function getHistoricalSet(
  transaction: TransactionSql,
  profileId: CraftsmanProfileId,
  commandId: string,
  revision: number,
): Promise<FeaturedSetRow> {
  const [row] = await transaction<FeaturedSetRow[]>`
    SELECT craftsman_profile_id AS "craftsmanProfileId", project_ids AS "projectIds",
      revision, occurred_at AS "updatedAt" FROM featured_project_revisions
    WHERE craftsman_profile_id = ${profileId} AND command_id = ${commandId}
      AND revision = ${revision}
  `;
  if (row === undefined)
    throw new Error("Committed featured project revision missing.");
  return row;
}

async function presentSet(
  sql: TransactionSql,
  set: FeaturedSetRow,
  actorUserId: UserId,
): Promise<FeaturedProjectSet> {
  if (set.projectIds.length === 0) {
    return Object.freeze({
      craftsmanProfileId: set.craftsmanProfileId,
      items: Object.freeze([]),
      revision: set.revision,
      updatedAt: set.updatedAt,
    });
  }
  const rows = await sql<FeaturedItemRow[]>`
    SELECT ordered.project_id AS "portfolioProjectId",
      ordered.position::integer AS position,
      project.id IS NOT NULL AS available,
      CASE WHEN project.id IS NOT NULL THEN project.title ELSE NULL END AS title
    FROM unnest(${set.projectIds}::uuid[]) WITH ORDINALITY
      AS ordered(project_id, position)
    LEFT JOIN portfolio_projects project ON project.id = ordered.project_id
      AND project.craftsman_profile_id = ${set.craftsmanProfileId}
      AND project.author_user_id = ${actorUserId}
      AND project.record_state = 'DRAFT'
    ORDER BY ordered.position
  `;
  return Object.freeze({
    craftsmanProfileId: set.craftsmanProfileId,
    items: Object.freeze(rows.map(presentItem)),
    revision: set.revision,
    updatedAt: set.updatedAt,
  });
}

function presentItem(row: FeaturedItemRow): FeaturedProjectItem {
  return Object.freeze({
    availability: row.available ? "AVAILABLE" : "UNAVAILABLE",
    position: row.position,
    portfolioProjectId: row.portfolioProjectId,
    title: row.available ? row.title : null,
  });
}

function sameMembers(
  current: readonly PortfolioProjectId[],
  ordered: readonly PortfolioProjectId[],
): boolean {
  return (
    current.length === ordered.length &&
    ordered.every((id) => current.includes(id))
  );
}

function arraysEqual(
  left: readonly PortfolioProjectId[],
  right: readonly PortfolioProjectId[],
): boolean {
  return (
    left.length === right.length &&
    left.every((id, index) => id === right[index])
  );
}

function fingerprintCommand(kind: FeaturedCommandKind, input: object): string {
  return createHash("sha256")
    .update(JSON.stringify([kind, input]), "utf8")
    .digest("hex");
}
