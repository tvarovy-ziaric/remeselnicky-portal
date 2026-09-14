import { createHash } from "node:crypto";

import {
  assertAuthorPortfolioCollaborationStateInput,
  assertCollaboratorPortfolioCollaborationStateInput,
  assertEditPendingPortfolioCollaborationInput,
  assertInvitePortfolioCollaboratorInput,
  assertPortfolioCollaborationAuthorListInput,
  assertPortfolioCollaborationCollaboratorListInput,
  type AuthorPortfolioCollaborationStateInput,
  type CollaboratorPortfolioCollaborationStateInput,
  type CraftsmanProfileId,
  type EditPendingPortfolioCollaborationInput,
  type InvitePortfolioCollaboratorInput,
  type PortfolioCollaboration,
  type PortfolioCollaborationCommandResult,
  type PortfolioCollaborationId,
  type PortfolioCollaborationPersistence,
  type PortfolioCollaborationState,
  type PortfolioCollaborationVisibility,
  type PortfolioProjectId,
  type UserId,
} from "@portal/domain";
import type { Sql, TransactionSql } from "postgres";

type CommandKind =
  | "INVITE"
  | "EDIT_PENDING"
  | "AUTHOR_WITHDRAW"
  | "COLLABORATOR_ACCEPT"
  | "COLLABORATOR_DECLINE"
  | "COLLABORATOR_WITHDRAW"
  | "HIDE"
  | "SHOW";
type ActorKind = "AUTHOR" | "COLLABORATOR";

interface CollaborationRow {
  readonly acceptedAt: Date | null;
  readonly authorProfileId: CraftsmanProfileId;
  readonly collaboratorProfileId: CraftsmanProfileId;
  readonly contribution: string;
  readonly id: PortfolioCollaborationId;
  readonly invitedAt: Date;
  readonly portfolioProjectId: PortfolioProjectId;
  readonly revision: number;
  readonly role: string;
  readonly state: PortfolioCollaborationState;
  readonly terminalAt: Date | null;
  readonly updatedAt: Date;
  readonly visibility: PortfolioCollaborationVisibility;
}

interface CommandRow {
  readonly actorKind: ActorKind;
  readonly actorUserId: UserId;
  readonly collaborationId: PortfolioCollaborationId;
  readonly commandKind: CommandKind;
  readonly payloadFingerprint: string;
  readonly portfolioProjectId: PortfolioProjectId;
  readonly resultingRevision: number;
}

interface CollaborationIdentityRow {
  readonly authorProfileId: CraftsmanProfileId;
  readonly collaboratorProfileId: CraftsmanProfileId;
  readonly portfolioProjectId: PortfolioProjectId;
}

interface CommandSpec {
  readonly actorKind: ActorKind;
  readonly actorUserId: UserId;
  readonly collaboratorProfileId?: CraftsmanProfileId;
  readonly collaborationId: PortfolioCollaborationId;
  readonly commandId: string;
  readonly commandKind: CommandKind;
  readonly contribution?: string;
  readonly expectedRevision: number;
  readonly fingerprint: string;
  readonly portfolioProjectId: PortfolioProjectId;
  readonly role?: string;
}

export class PortfolioCollaborationIdempotencyError extends Error {
  readonly code = "PORTFOLIO_COLLABORATION_IDEMPOTENCY_CONFLICT";
}

export function createPortfolioCollaborationRepository(
  sql: Sql,
): PortfolioCollaborationPersistence {
  return Object.freeze({
    async invite(input: InvitePortfolioCollaboratorInput) {
      assertInvitePortfolioCollaboratorInput(input);
      const spec = authorSpec("INVITE", input, 0, {
        contribution: input.contribution,
        role: input.role,
      });
      return sql.begin(async (transaction) => {
        if (!(await lockInviteContext(transaction, input)))
          return unavailable();
        const replay = await replayCommand(transaction, spec);
        if (replay !== null) return replay;
        if (await activePairExists(transaction, input)) {
          return Object.freeze({ status: "DUPLICATE_ACTIVE_INVITATION" });
        }
        await transaction`
          INSERT INTO portfolio_collaborations (
            id, portfolio_project_id, author_profile_id,
            collaborator_profile_id, state, visibility, role, contribution,
            revision, latest_command_id
          ) VALUES (
            ${input.collaborationId}, ${input.portfolioProjectId},
            ${input.authorProfileId}, ${input.collaboratorProfileId},
            'PENDING', 'VISIBLE', ${input.role}, ${input.contribution},
            1, ${input.commandId}
          )
        `;
        await insertCommand(transaction, spec);
        await insertRevision(transaction, spec, 1);
        return applied(transaction, spec, 1);
      });
    },

    async editPending(input: EditPendingPortfolioCollaborationInput) {
      assertEditPendingPortfolioCollaborationInput(input);
      return execute(
        sql,
        authorSpec("EDIT_PENDING", input, input.expectedRevision, {
          contribution: input.contribution,
          role: input.role,
        }),
      );
    },

    async withdrawPending(input: AuthorPortfolioCollaborationStateInput) {
      assertAuthorPortfolioCollaborationStateInput(input);
      return execute(
        sql,
        authorSpec("AUTHOR_WITHDRAW", input, input.expectedRevision),
      );
    },

    async hide(input: AuthorPortfolioCollaborationStateInput) {
      assertAuthorPortfolioCollaborationStateInput(input);
      return execute(sql, authorSpec("HIDE", input, input.expectedRevision));
    },

    async show(input: AuthorPortfolioCollaborationStateInput) {
      assertAuthorPortfolioCollaborationStateInput(input);
      return execute(sql, authorSpec("SHOW", input, input.expectedRevision));
    },

    async accept(input: CollaboratorPortfolioCollaborationStateInput) {
      assertCollaboratorPortfolioCollaborationStateInput(input);
      return execute(sql, collaboratorSpec("COLLABORATOR_ACCEPT", input));
    },

    async decline(input: CollaboratorPortfolioCollaborationStateInput) {
      assertCollaboratorPortfolioCollaborationStateInput(input);
      return execute(sql, collaboratorSpec("COLLABORATOR_DECLINE", input));
    },

    async withdrawAccepted(
      input: CollaboratorPortfolioCollaborationStateInput,
    ) {
      assertCollaboratorPortfolioCollaborationStateInput(input);
      return execute(sql, collaboratorSpec("COLLABORATOR_WITHDRAW", input));
    },

    async listOwnedAsAuthor(input: {
      readonly actorUserId: UserId;
      readonly authorProfileId: CraftsmanProfileId;
      readonly portfolioProjectId: PortfolioProjectId;
    }) {
      assertPortfolioCollaborationAuthorListInput(input);
      return listOwned(sql, {
        actorUserId: input.actorUserId,
        ownerKind: "AUTHOR",
        profileId: input.authorProfileId,
        projectId: input.portfolioProjectId,
      });
    },

    async listOwnedAsCollaborator(input: {
      readonly actorUserId: UserId;
      readonly collaboratorProfileId: CraftsmanProfileId;
    }) {
      assertPortfolioCollaborationCollaboratorListInput(input);
      return listOwned(sql, {
        actorUserId: input.actorUserId,
        ownerKind: "COLLABORATOR",
        profileId: input.collaboratorProfileId,
      });
    },
  });
}

function authorSpec(
  kind: "INVITE" | "EDIT_PENDING" | "AUTHOR_WITHDRAW" | "HIDE" | "SHOW",
  input: {
    readonly actorUserId: UserId;
    readonly collaborationId: PortfolioCollaborationId;
    readonly commandId: string;
    readonly portfolioProjectId: PortfolioProjectId;
  },
  expectedRevision: number,
  content:
    | { readonly contribution: string; readonly role: string }
    | undefined = undefined,
): CommandSpec {
  return {
    actorKind: "AUTHOR",
    actorUserId: input.actorUserId,
    collaborationId: input.collaborationId,
    commandId: input.commandId,
    commandKind: kind,
    ...content,
    expectedRevision,
    fingerprint: fingerprint(kind, input),
    portfolioProjectId: input.portfolioProjectId,
  };
}

function collaboratorSpec(
  kind:
    "COLLABORATOR_ACCEPT" | "COLLABORATOR_DECLINE" | "COLLABORATOR_WITHDRAW",
  input: CollaboratorPortfolioCollaborationStateInput,
): CommandSpec {
  return {
    actorKind: "COLLABORATOR",
    actorUserId: input.actorUserId,
    collaboratorProfileId: input.collaboratorProfileId,
    collaborationId: input.collaborationId,
    commandId: input.commandId,
    commandKind: kind,
    expectedRevision: input.expectedRevision,
    fingerprint: fingerprint(kind, input),
    portfolioProjectId: input.portfolioProjectId,
  };
}

async function execute(
  sql: Sql,
  spec: CommandSpec,
): Promise<PortfolioCollaborationCommandResult> {
  return sql.begin(async (transaction) => {
    const current = await lockOwnedCurrent(transaction, spec);
    if (current === null) return unavailable();
    const replay = await replayCommand(transaction, spec);
    if (replay !== null) return replay;
    if (current.revision !== spec.expectedRevision) {
      return Object.freeze({ status: "STALE_REVISION" });
    }
    const noChange = isNoChange(current, spec);
    if (noChange) return Object.freeze({ status: "UNCHANGED" });
    if (!isValidTransition(current, spec)) {
      return Object.freeze({ status: "INVALID_TRANSITION" });
    }

    await insertCommand(transaction, spec);
    const nextRevision = current.revision + 1;
    await updateHead(transaction, current, spec, nextRevision);
    await insertRevision(transaction, spec, nextRevision);
    return applied(transaction, spec, nextRevision);
  });
}

function isNoChange(current: CollaborationRow, spec: CommandSpec): boolean {
  return (
    (spec.commandKind === "EDIT_PENDING" &&
      current.role === spec.role &&
      current.contribution === spec.contribution) ||
    (spec.commandKind === "HIDE" && current.visibility === "HIDDEN") ||
    (spec.commandKind === "SHOW" && current.visibility === "VISIBLE")
  );
}

function isValidTransition(
  current: CollaborationRow,
  spec: CommandSpec,
): boolean {
  switch (spec.commandKind) {
    case "EDIT_PENDING":
    case "AUTHOR_WITHDRAW":
    case "COLLABORATOR_ACCEPT":
    case "COLLABORATOR_DECLINE":
      return current.state === "PENDING";
    case "COLLABORATOR_WITHDRAW":
      return current.state === "ACCEPTED";
    case "HIDE":
      return current.state === "ACCEPTED" && current.visibility === "VISIBLE";
    case "SHOW":
      return current.state === "ACCEPTED" && current.visibility === "HIDDEN";
    default:
      return false;
  }
}

async function updateHead(
  transaction: TransactionSql,
  current: CollaborationRow,
  spec: CommandSpec,
  revision: number,
): Promise<void> {
  const state = nextState(current.state, spec.commandKind);
  const visibility = nextVisibility(current.visibility, spec.commandKind);
  await transaction`
    UPDATE portfolio_collaborations
    SET state = ${state}, visibility = ${visibility},
      role = ${spec.role ?? current.role},
      contribution = ${spec.contribution ?? current.contribution},
      accepted_at = CASE
        WHEN ${spec.commandKind} = 'COLLABORATOR_ACCEPT' THEN CURRENT_TIMESTAMP
        ELSE accepted_at
      END,
      terminal_at = CASE
        WHEN ${spec.commandKind} IN (
          'AUTHOR_WITHDRAW', 'COLLABORATOR_DECLINE', 'COLLABORATOR_WITHDRAW'
        ) THEN CURRENT_TIMESTAMP
        ELSE terminal_at
      END,
      revision = ${revision}, latest_command_id = ${spec.commandId}
    WHERE id = ${spec.collaborationId}
      AND revision = ${spec.expectedRevision}
  `;
}

function nextState(
  current: PortfolioCollaborationState,
  kind: CommandKind,
): PortfolioCollaborationState {
  switch (kind) {
    case "AUTHOR_WITHDRAW":
      return "AUTHOR_WITHDRAWN";
    case "COLLABORATOR_ACCEPT":
      return "ACCEPTED";
    case "COLLABORATOR_DECLINE":
      return "DECLINED";
    case "COLLABORATOR_WITHDRAW":
      return "COLLABORATOR_WITHDRAWN";
    default:
      return current;
  }
}

function nextVisibility(
  current: PortfolioCollaborationVisibility,
  kind: CommandKind,
): PortfolioCollaborationVisibility {
  if (kind === "HIDE") return "HIDDEN";
  if (kind === "SHOW") return "VISIBLE";
  return current;
}

async function insertCommand(
  transaction: TransactionSql,
  spec: CommandSpec,
): Promise<void> {
  await transaction`
    INSERT INTO portfolio_collaboration_commands (
      command_id, command_kind, collaboration_id, portfolio_project_id,
      actor_kind, actor_user_id, expected_revision, resulting_revision,
      requested_role, requested_contribution, payload_fingerprint
    ) VALUES (
      ${spec.commandId}, ${spec.commandKind}, ${spec.collaborationId},
      ${spec.portfolioProjectId}, ${spec.actorKind}, ${spec.actorUserId},
      ${spec.expectedRevision}, ${spec.expectedRevision + 1},
      ${spec.role ?? null}, ${spec.contribution ?? null}, ${spec.fingerprint}
    )
  `;
}

async function insertRevision(
  transaction: TransactionSql,
  spec: CommandSpec,
  revision: number,
): Promise<void> {
  await transaction`
    INSERT INTO portfolio_collaboration_revisions (
      command_id, collaboration_id, revision, state, visibility,
      role, contribution, accepted_at, terminal_at, actor_user_id
    )
    SELECT ${spec.commandId}, current.id, ${revision}, current.state,
      current.visibility, current.role, current.contribution,
      current.accepted_at, current.terminal_at, ${spec.actorUserId}
    FROM portfolio_collaborations current
    WHERE current.id = ${spec.collaborationId}
  `;
}

async function applied(
  transaction: TransactionSql,
  spec: CommandSpec,
  revision: number,
): Promise<PortfolioCollaborationCommandResult> {
  const row = await selectRevision(transaction, spec.collaborationId, revision);
  if (row === null) throw new Error("Portfolio collaboration effect missing.");
  return Object.freeze({
    collaboration: toCollaboration(row),
    status: "APPLIED",
  });
}

async function replayCommand(
  transaction: TransactionSql,
  spec: CommandSpec,
): Promise<PortfolioCollaborationCommandResult | null> {
  const [existing] = await transaction<CommandRow[]>`
    SELECT actor_kind AS "actorKind", actor_user_id AS "actorUserId",
      collaboration_id AS "collaborationId", command_kind AS "commandKind",
      payload_fingerprint AS "payloadFingerprint",
      portfolio_project_id AS "portfolioProjectId",
      resulting_revision AS "resultingRevision"
    FROM portfolio_collaboration_commands
    WHERE command_id = ${spec.commandId}
  `;
  if (existing === undefined) return null;
  if (
    existing.actorKind !== spec.actorKind ||
    existing.actorUserId !== spec.actorUserId ||
    existing.collaborationId !== spec.collaborationId ||
    existing.commandKind !== spec.commandKind ||
    existing.payloadFingerprint !== spec.fingerprint ||
    existing.portfolioProjectId !== spec.portfolioProjectId
  ) {
    throw new PortfolioCollaborationIdempotencyError(
      "Portfolio collaboration command id was reused with different authority or payload.",
    );
  }
  const row = await selectRevision(
    transaction,
    spec.collaborationId,
    existing.resultingRevision,
  );
  if (row === null) throw new Error("Persisted collaboration effect missing.");
  return Object.freeze({
    collaboration: toCollaboration(row),
    status: "DEDUPLICATED",
  });
}

async function lockInviteContext(
  transaction: TransactionSql,
  input: InvitePortfolioCollaboratorInput,
): Promise<boolean> {
  const profiles = await transaction<
    {
      readonly accountState: string;
      readonly ownerUserId: UserId;
      readonly profileId: CraftsmanProfileId;
    }[]
  >`
    SELECT profile.id AS "profileId", profile.owner_user_id AS "ownerUserId",
      owner.account_state AS "accountState"
    FROM craftsman_profiles profile
    JOIN users owner ON owner.id = profile.owner_user_id
    WHERE profile.id IN (${input.authorProfileId}, ${input.collaboratorProfileId})
    ORDER BY profile.id
    FOR UPDATE OF profile, owner
  `;
  const author = profiles.find(
    ({ profileId }) => profileId === input.authorProfileId,
  );
  const collaborator = profiles.find(
    ({ profileId }) => profileId === input.collaboratorProfileId,
  );
  if (
    input.authorProfileId === input.collaboratorProfileId ||
    author === undefined ||
    author.ownerUserId !== input.actorUserId ||
    author.accountState !== "ACTIVE" ||
    collaborator === undefined ||
    collaborator.accountState !== "ACTIVE"
  ) {
    return false;
  }
  const projects = await transaction`
    SELECT id FROM portfolio_projects
    WHERE id = ${input.portfolioProjectId}
      AND craftsman_profile_id = ${input.authorProfileId}
      AND author_user_id = ${input.actorUserId}
      AND record_state <> 'ARCHIVED'
    FOR UPDATE
  `;
  return projects.length === 1;
}

async function lockOwnedCurrent(
  transaction: TransactionSql,
  spec: CommandSpec,
): Promise<CollaborationRow | null> {
  const [identity] = await transaction<CollaborationIdentityRow[]>`
    SELECT author_profile_id AS "authorProfileId",
      collaborator_profile_id AS "collaboratorProfileId",
      portfolio_project_id AS "portfolioProjectId"
    FROM portfolio_collaborations
    WHERE id = ${spec.collaborationId}
      AND portfolio_project_id = ${spec.portfolioProjectId}
  `;
  if (identity === undefined) return null;

  const actorProfileId =
    spec.actorKind === "AUTHOR"
      ? identity.authorProfileId
      : identity.collaboratorProfileId;
  if (
    spec.actorKind === "COLLABORATOR" &&
    actorProfileId !== spec.collaboratorProfileId
  ) {
    return null;
  }
  const actorProfiles = await transaction`
    SELECT profile.id
    FROM craftsman_profiles profile
    JOIN users owner ON owner.id = profile.owner_user_id
    WHERE profile.id = ${actorProfileId}
      AND profile.owner_user_id = ${spec.actorUserId}
      AND owner.account_state = 'ACTIVE'
    FOR UPDATE OF profile, owner
  `;
  if (actorProfiles.length !== 1) return null;

  if (spec.actorKind === "AUTHOR") {
    const projects = await transaction`
      SELECT id FROM portfolio_projects
      WHERE id = ${identity.portfolioProjectId}
        AND craftsman_profile_id = ${identity.authorProfileId}
        AND author_user_id = ${spec.actorUserId}
        AND record_state <> 'ARCHIVED'
      FOR UPDATE
    `;
    if (projects.length !== 1) return null;
  } else {
    // Keep the same project -> collaboration-head lock order as the author
    // path. The command FK reads the project too, so deferring this lock until
    // INSERT can deadlock a concurrent author command.
    const projects = await transaction`
      SELECT id FROM portfolio_projects
      WHERE id = ${identity.portfolioProjectId}
      FOR UPDATE
    `;
    if (projects.length !== 1) return null;
  }

  const rows = await transaction<CollaborationRow[]>`
    SELECT collaboration.id,
      collaboration.portfolio_project_id AS "portfolioProjectId",
      collaboration.author_profile_id AS "authorProfileId",
      collaboration.collaborator_profile_id AS "collaboratorProfileId",
      collaboration.state, collaboration.visibility, collaboration.role,
      collaboration.contribution, collaboration.revision,
      collaboration.invited_at AS "invitedAt",
      collaboration.accepted_at AS "acceptedAt",
      collaboration.terminal_at AS "terminalAt",
      collaboration.updated_at AS "updatedAt"
    FROM portfolio_collaborations collaboration
    WHERE collaboration.id = ${spec.collaborationId}
      AND collaboration.portfolio_project_id = ${spec.portfolioProjectId}
      AND collaboration.author_profile_id = ${identity.authorProfileId}
      AND collaboration.collaborator_profile_id = ${identity.collaboratorProfileId}
    FOR UPDATE OF collaboration
  `;
  return rows[0] ?? null;
}

async function activePairExists(
  transaction: TransactionSql,
  input: InvitePortfolioCollaboratorInput,
): Promise<boolean> {
  const rows = await transaction`
    SELECT id FROM portfolio_collaborations
    WHERE portfolio_project_id = ${input.portfolioProjectId}
      AND collaborator_profile_id = ${input.collaboratorProfileId}
      AND state IN ('PENDING', 'ACCEPTED')
    LIMIT 1
  `;
  return rows.length > 0;
}

async function selectRevision(
  transaction: TransactionSql,
  collaborationId: PortfolioCollaborationId,
  revision: number,
): Promise<CollaborationRow | null> {
  const [row] = await transaction<CollaborationRow[]>`
    SELECT stored.collaboration_id AS id,
      current.portfolio_project_id AS "portfolioProjectId",
      current.author_profile_id AS "authorProfileId",
      current.collaborator_profile_id AS "collaboratorProfileId",
      stored.state, stored.visibility, stored.role, stored.contribution,
      stored.revision, current.invited_at AS "invitedAt",
      stored.accepted_at AS "acceptedAt", stored.terminal_at AS "terminalAt",
      stored.occurred_at AS "updatedAt"
    FROM portfolio_collaboration_revisions stored
    JOIN portfolio_collaborations current ON current.id = stored.collaboration_id
    WHERE stored.collaboration_id = ${collaborationId}
      AND stored.revision = ${revision}
  `;
  return row ?? null;
}

async function listOwned(
  sql: Sql,
  input: {
    readonly actorUserId: UserId;
    readonly ownerKind: ActorKind;
    readonly profileId: CraftsmanProfileId;
    readonly projectId?: PortfolioProjectId;
  },
): Promise<readonly PortfolioCollaboration[]> {
  const rows = await sql<CollaborationRow[]>`
    SELECT collaboration.id,
      collaboration.portfolio_project_id AS "portfolioProjectId",
      collaboration.author_profile_id AS "authorProfileId",
      collaboration.collaborator_profile_id AS "collaboratorProfileId",
      collaboration.state, collaboration.visibility, collaboration.role,
      collaboration.contribution, collaboration.revision,
      collaboration.invited_at AS "invitedAt",
      collaboration.accepted_at AS "acceptedAt",
      collaboration.terminal_at AS "terminalAt",
      collaboration.updated_at AS "updatedAt"
    FROM portfolio_collaborations collaboration
    JOIN craftsman_profiles profile ON profile.id = ${input.profileId}
    JOIN users owner ON owner.id = profile.owner_user_id
    WHERE profile.owner_user_id = ${input.actorUserId}
      AND owner.account_state = 'ACTIVE'
      AND (${input.ownerKind} <> 'AUTHOR'
        OR collaboration.author_profile_id = profile.id)
      AND (${input.ownerKind} <> 'COLLABORATOR'
        OR collaboration.collaborator_profile_id = profile.id)
      AND (${input.projectId ?? null}::uuid IS NULL
        OR collaboration.portfolio_project_id = ${input.projectId ?? null})
    ORDER BY collaboration.updated_at DESC, collaboration.id
  `;
  return Object.freeze(rows.map((row) => toCollaboration(row)));
}

function toCollaboration(row: CollaborationRow): PortfolioCollaboration {
  return Object.freeze({ ...row });
}

function unavailable(): PortfolioCollaborationCommandResult {
  return Object.freeze({ status: "COLLABORATION_UNAVAILABLE" });
}

function fingerprint(kind: CommandKind, input: unknown): string {
  return createHash("sha256")
    .update(canonicalJson({ input, kind }))
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
