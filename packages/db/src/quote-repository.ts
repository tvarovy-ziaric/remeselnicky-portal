import { createHash } from "node:crypto";

import {
  QUOTE_AUTHORING_MODES,
  QUOTE_REVISION_STATES,
  QuoteIdempotencyError,
  assertCreateQuoteDraftInput,
  assertCreateQuoteRevisionInput,
  assertInvitationQuoteReadInput,
  assertQuoteReadInput,
  assertRejectQuoteRevisionInput,
  assertSubmitQuoteRevisionInput,
  normalizeRejectQuoteRevisionInput,
  type ConversationId,
  type CreateQuoteDraftInput,
  type CreateQuoteRevisionInput,
  type InvitationQuoteReadInput,
  type JobInvitationId,
  type JobRequestId,
  type Quote,
  type QuoteAuthoringMode,
  type QuoteCommandResult,
  type QuoteId,
  type QuotePersistence,
  type QuoteReadInput,
  type QuoteRevision,
  type QuoteRevisionState,
  type RejectQuoteRevisionInput,
  type SubmitQuoteRevisionInput,
} from "@portal/domain";
import type { Sql, TransactionSql } from "postgres";

type CommandKind = "CREATE_DRAFT" | "CREATE_REVISION" | "SUBMIT" | "REJECT";
type RootOrTransactionSql = Sql | TransactionSql;

interface CommandRow {
  readonly actorUserId: string;
  readonly payloadFingerprint: string;
  readonly quoteId: string;
}

interface InsertedCommandRow {
  readonly conversationId: string;
  readonly createdAt: Date;
  readonly quoteId: string;
  readonly quoteRevision: number;
}

interface QuoteContextRow {
  readonly conversationId: string;
  readonly createdAt: Date;
  readonly id: string;
  readonly invitationId: string;
  readonly jobRequestId: string;
  readonly participantRole: string;
}

interface QuoteRevisionRow {
  readonly authoringMode: string;
  readonly changedAt: Date;
  readonly createdAt: Date;
  readonly rejectionReason: string | null;
  readonly requestContentRevision: number;
  readonly requestVisibleVersion: number;
  readonly revision: number;
  readonly state: string;
  readonly stateRevision: number;
  readonly submittedAt: Date | null;
}

export function createQuoteRepository(
  sql: RootOrTransactionSql,
): QuotePersistence {
  return Object.freeze({
    createDraft(input: CreateQuoteDraftInput) {
      assertCreateQuoteDraftInput(input);
      return execute(sql, "CREATE_DRAFT", input);
    },
    createRevision(input: CreateQuoteRevisionInput) {
      assertCreateQuoteRevisionInput(input);
      return execute(sql, "CREATE_REVISION", input);
    },
    readOwned(input: QuoteReadInput) {
      assertQuoteReadInput(input);
      return withTransaction(sql, (transaction) =>
        readOwned(transaction, input.actorUserId, input.quoteId, null),
      );
    },
    readOwnedByInvitation(input: InvitationQuoteReadInput) {
      assertInvitationQuoteReadInput(input);
      return withTransaction(sql, (transaction) =>
        readOwned(transaction, input.actorUserId, null, input.invitationId),
      );
    },
    reject(input: RejectQuoteRevisionInput) {
      assertRejectQuoteRevisionInput(input);
      return execute(sql, "REJECT", normalizeRejectQuoteRevisionInput(input));
    },
    submit(input: SubmitQuoteRevisionInput) {
      assertSubmitQuoteRevisionInput(input);
      return execute(sql, "SUBMIT", input);
    },
  });
}

async function execute(
  sql: RootOrTransactionSql,
  kind: CommandKind,
  input:
    | CreateQuoteDraftInput
    | CreateQuoteRevisionInput
    | RejectQuoteRevisionInput
    | SubmitQuoteRevisionInput,
): Promise<QuoteCommandResult> {
  const fingerprint = commandFingerprint(kind, input);
  try {
    return await withTransaction(sql, async (transaction) => {
      await transaction`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${input.commandId}, 48001)
        )
      `;
      const [existing] = await transaction<CommandRow[]>`
        SELECT quote_id AS "quoteId", actor_user_id AS "actorUserId",
          payload_fingerprint AS "payloadFingerprint"
        FROM quote_core_commands WHERE command_id = ${input.commandId}
      `;
      if (existing !== undefined) {
        if (
          existing.actorUserId !== input.actorUserId ||
          existing.payloadFingerprint !== fingerprint
        ) {
          throw new QuoteIdempotencyError(
            "Quote command id was reused with another intent.",
          );
        }
        const replay = await readOwned(
          transaction,
          input.actorUserId,
          existing.quoteId as QuoteId,
          null,
        );
        return replay === null
          ? Object.freeze({ status: "NOT_FOUND" as const })
          : Object.freeze({ quote: replay, status: "DEDUPLICATED" as const });
      }

      const active = await transaction`
        SELECT id FROM users
        WHERE id = ${input.actorUserId} AND account_state = 'ACTIVE'
      `;
      if (active.length !== 1) {
        return Object.freeze({ status: "NOT_FOUND" as const });
      }

      if (!(await lockQuoteRequest(transaction, input))) {
        return Object.freeze({ status: "NOT_FOUND" as const });
      }

      const command = await insertCommand(
        transaction,
        kind,
        input,
        fingerprint,
      );
      if (kind === "CREATE_DRAFT") {
        await transaction`
          INSERT INTO quotes (
            id, invitation_id, conversation_id, create_command_id, created_at
          )
          SELECT ${command.quoteId}, conversation.invitation_id,
            ${command.conversationId}, ${input.commandId}, ${command.createdAt}
          FROM conversations conversation
          WHERE conversation.id = ${command.conversationId}
        `;
      }
      if (kind === "CREATE_DRAFT" || kind === "CREATE_REVISION") {
        const create = input as
          CreateQuoteDraftInput | CreateQuoteRevisionInput;
        await transaction`
          INSERT INTO quote_revision_identities (
            quote_id, revision, create_command_id, authoring_mode,
            request_content_revision, request_visible_version, created_at
          ) VALUES (
            ${command.quoteId}, ${command.quoteRevision}, ${input.commandId},
            ${create.authoringMode}, ${create.requestContentRevision},
            ${create.requestVisibleVersion}, ${command.createdAt}
          )
        `;
        await insertStateEvent(transaction, {
          commandId: input.commandId,
          quoteId: command.quoteId,
          quoteRevision: command.quoteRevision,
          state: "DRAFT",
        });
      } else if (kind === "SUBMIT") {
        const submit = input as SubmitQuoteRevisionInput;
        if (submit.expectedSubmittedStateRevision !== null) {
          const [prior] = await transaction<
            Array<{ readonly revision: number }>
          >`
            SELECT revision FROM current_submitted_quotes
            WHERE quote_id = ${command.quoteId}
          `;
          if (prior === undefined)
            throw new Error("Missing prior Quote revision.");
          await insertStateEvent(transaction, {
            commandId: input.commandId,
            quoteId: command.quoteId,
            quoteRevision: prior.revision,
            state: "SUPERSEDED",
          });
        }
        await insertStateEvent(transaction, {
          commandId: input.commandId,
          quoteId: command.quoteId,
          quoteRevision: command.quoteRevision,
          state: "SUBMITTED",
        });
      } else {
        await insertStateEvent(transaction, {
          commandId: input.commandId,
          quoteId: command.quoteId,
          quoteRevision: command.quoteRevision,
          state: "REJECTED",
        });
      }

      const quote = await readOwned(
        transaction,
        input.actorUserId,
        command.quoteId as QuoteId,
        null,
      );
      if (quote === null)
        throw new Error("Quote command effect is inaccessible.");
      return Object.freeze({ quote, status: "APPLIED" as const });
    });
  } catch (error) {
    if (error instanceof QuoteIdempotencyError) throw error;
    return mapCommandError(error);
  }
}

async function lockQuoteRequest(
  transaction: TransactionSql,
  input:
    | CreateQuoteDraftInput
    | CreateQuoteRevisionInput
    | RejectQuoteRevisionInput
    | SubmitQuoteRevisionInput,
): Promise<boolean> {
  const [row] =
    "conversationId" in input
      ? await transaction<Array<{ jobRequestId: string }>>`
        SELECT invitation.job_request_id AS "jobRequestId"
        FROM conversations conversation
        JOIN job_invitations invitation ON invitation.id = conversation.invitation_id
        WHERE conversation.id = ${input.conversationId}
      `
      : await transaction<Array<{ jobRequestId: string }>>`
        SELECT invitation.job_request_id AS "jobRequestId"
        FROM quotes quote
        JOIN job_invitations invitation ON invitation.id = quote.invitation_id
        WHERE quote.id = ${input.quoteId}
      `;
  if (row === undefined) return false;
  await transaction`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${row.jobRequestId}::text, 41007)
    )
  `;
  return true;
}

async function insertCommand(
  transaction: TransactionSql,
  kind: CommandKind,
  input:
    | CreateQuoteDraftInput
    | CreateQuoteRevisionInput
    | RejectQuoteRevisionInput
    | SubmitQuoteRevisionInput,
  fingerprint: string,
): Promise<InsertedCommandRow> {
  const create =
    kind === "CREATE_DRAFT" || kind === "CREATE_REVISION"
      ? (input as CreateQuoteDraftInput | CreateQuoteRevisionInput)
      : null;
  const quoteId =
    "quoteId" in input
      ? input.quoteId
      : ("00000000-0000-4000-8000-000000000000" as QuoteId);
  const conversationId =
    "conversationId" in input
      ? input.conversationId
      : await conversationIdForQuote(transaction, quoteId);
  const expectedDraft =
    kind === "SUBMIT"
      ? (input as SubmitQuoteRevisionInput).expectedDraftStateRevision
      : null;
  const expectedSubmitted =
    kind === "CREATE_REVISION"
      ? (input as CreateQuoteRevisionInput).expectedSubmittedStateRevision
      : kind === "SUBMIT"
        ? (input as SubmitQuoteRevisionInput).expectedSubmittedStateRevision
        : kind === "REJECT"
          ? (input as RejectQuoteRevisionInput).expectedStateRevision
          : null;
  const revision = "revision" in input ? input.revision : 1;
  const rejectionReason =
    kind === "REJECT"
      ? ((input as RejectQuoteRevisionInput).rejectionReason ?? null)
      : null;
  const [row] = await transaction<InsertedCommandRow[]>`
    INSERT INTO quote_core_commands (
      command_id, quote_id, conversation_id, actor_user_id, command_kind,
      quote_revision, authoring_mode, request_content_revision,
      request_visible_version, expected_draft_state_revision,
      expected_submitted_state_revision, target_state, rejection_reason,
      payload_fingerprint, created_at
    ) VALUES (
      ${input.commandId}, ${quoteId}, ${conversationId}, ${input.actorUserId},
      ${kind}, ${revision}, ${create?.authoringMode ?? null},
      ${create?.requestContentRevision ?? null},
      ${create?.requestVisibleVersion ?? null}, ${expectedDraft},
      ${expectedSubmitted},
      ${kind === "REJECT" ? "REJECTED" : kind === "SUBMIT" ? "SUBMITTED" : "DRAFT"},
      ${rejectionReason}, ${fingerprint}, clock_timestamp()
    )
    RETURNING quote_id AS "quoteId", conversation_id AS "conversationId",
      quote_revision AS "quoteRevision", created_at AS "createdAt"
  `;
  if (row === undefined) throw new Error("Quote command was not stored.");
  return row;
}

async function insertStateEvent(
  transaction: TransactionSql,
  input: {
    readonly commandId: string;
    readonly quoteId: string;
    readonly quoteRevision: number;
    readonly state: QuoteRevisionState;
  },
): Promise<void> {
  await transaction`
    INSERT INTO quote_revision_state_events (
      quote_id, quote_revision, state_revision, command_id, state,
      rejection_reason, changed_at, submitted_at
    ) VALUES (
      ${input.quoteId}, ${input.quoteRevision}, 1, ${input.commandId},
      ${input.state}, NULL, clock_timestamp(),
      ${input.state === "DRAFT" ? null : new Date(0)}
    )
  `;
}

async function conversationIdForQuote(
  sql: TransactionSql,
  quoteId: QuoteId,
): Promise<ConversationId> {
  const [row] = await sql<Array<{ readonly conversationId: ConversationId }>>`
    SELECT conversation_id AS "conversationId" FROM quotes WHERE id = ${quoteId}
  `;
  return (
    row?.conversationId ??
    ("00000000-0000-4000-8000-000000000000" as ConversationId)
  );
}

async function readOwned(
  sql: TransactionSql,
  actorUserId: string,
  quoteId: QuoteId | null,
  invitationId: JobInvitationId | null,
): Promise<Quote | null> {
  const actors = await sql`
    SELECT id FROM users
    WHERE id = ${actorUserId} AND account_state = 'ACTIVE'
    FOR UPDATE
  `;
  if (actors.length !== 1) return null;
  const [context] = await sql<QuoteContextRow[]>`
    SELECT quote.id, quote.invitation_id AS "invitationId",
      quote.conversation_id AS "conversationId",
      conversation.job_request_id AS "jobRequestId",
      quote.created_at AS "createdAt",
      CASE WHEN customer.owner_user_id = actor.id
        THEN 'CUSTOMER' ELSE 'CRAFTSMAN' END AS "participantRole"
    FROM quotes quote
    JOIN current_conversations conversation
      ON conversation.id = quote.conversation_id
    JOIN customer_profiles customer
      ON customer.id = conversation.customer_profile_id
    JOIN craftsman_profiles craftsman
      ON craftsman.id = conversation.craftsman_profile_id
    JOIN users actor ON actor.id = ${actorUserId}
      AND actor.account_state = 'ACTIVE'
    WHERE (${quoteId}::uuid IS NULL OR quote.id = ${quoteId})
      AND (${invitationId}::uuid IS NULL
        OR quote.invitation_id = ${invitationId})
      AND (customer.owner_user_id = actor.id
        OR craftsman.owner_user_id = actor.id)
    FOR UPDATE OF quote, customer, craftsman
  `;
  if (context === undefined) return null;
  const rows = await sql<QuoteRevisionRow[]>`
    SELECT revision, authoring_mode::text AS "authoringMode",
      request_content_revision AS "requestContentRevision",
      request_visible_version AS "requestVisibleVersion",
      created_at AS "createdAt", state_revision AS "stateRevision",
      state::text AS state, rejection_reason AS "rejectionReason",
      changed_at AS "changedAt", submitted_at AS "submittedAt"
    FROM current_quote_revision_states
    WHERE quote_id = ${context.id}
      AND (${context.participantRole} = 'CRAFTSMAN' OR state <> 'DRAFT')
    ORDER BY revision
  `;
  return toQuote(context, rows);
}

function toQuote(context: QuoteContextRow, rows: QuoteRevisionRow[]): Quote {
  if (
    !isUuid(context.id) ||
    !isUuid(context.invitationId) ||
    !isUuid(context.conversationId) ||
    !isUuid(context.jobRequestId) ||
    !validDate(context.createdAt) ||
    (context.participantRole !== "CUSTOMER" &&
      context.participantRole !== "CRAFTSMAN")
  ) {
    throw new Error("Corrupt Quote context projection.");
  }
  const revisions = Object.freeze(rows.map(toRevision));
  const draft =
    revisions.find((revision) => revision.state === "DRAFT") ?? null;
  const submitted =
    revisions.find((revision) => revision.state === "SUBMITTED") ?? null;
  if (
    revisions.filter((revision) => revision.state === "DRAFT").length > 1 ||
    revisions.filter((revision) => revision.state === "SUBMITTED").length > 1 ||
    (context.participantRole === "CUSTOMER" && draft !== null)
  ) {
    throw new Error("Corrupt Quote current-revision projection.");
  }
  return Object.freeze({
    conversationId: context.conversationId as ConversationId,
    createdAt: new Date(context.createdAt),
    currentDraft: draft,
    currentSubmitted: submitted,
    id: context.id as QuoteId,
    invitationId: context.invitationId as JobInvitationId,
    jobRequestId: context.jobRequestId as JobRequestId,
    participantRole: context.participantRole,
    revisions,
  });
}

function toRevision(row: QuoteRevisionRow): QuoteRevision {
  if (
    !QUOTE_AUTHORING_MODES.some((mode) => mode === row.authoringMode) ||
    !QUOTE_REVISION_STATES.some((state) => state === row.state) ||
    !positive(row.revision) ||
    !positive(row.stateRevision) ||
    !positive(row.requestContentRevision) ||
    !positive(row.requestVisibleVersion) ||
    !validDate(row.createdAt) ||
    !validDate(row.changedAt) ||
    (row.submittedAt !== null && !validDate(row.submittedAt)) ||
    (row.rejectionReason !== null &&
      (typeof row.rejectionReason !== "string" ||
        row.rejectionReason.length < 1))
  ) {
    throw new Error("Corrupt Quote revision projection.");
  }
  return Object.freeze({
    authoringMode: row.authoringMode as QuoteAuthoringMode,
    changedAt: new Date(row.changedAt),
    createdAt: new Date(row.createdAt),
    rejectionReason: row.rejectionReason,
    requestContentRevision: row.requestContentRevision,
    requestVisibleVersion: row.requestVisibleVersion,
    revision: row.revision,
    state: row.state as QuoteRevisionState,
    stateRevision: row.stateRevision,
    submittedAt: row.submittedAt === null ? null : new Date(row.submittedAt),
  });
}

function mapCommandError(error: unknown): QuoteCommandResult {
  const message = error instanceof Error ? error.message : "";
  if (/authoring is not ready/u.test(message)) {
    return Object.freeze({ status: "AUTHORING_NOT_READY" });
  }
  if (/invalid or stale/u.test(message)) {
    return Object.freeze({ status: "STALE_REVISION" });
  }
  if (/writable quote conversation required/u.test(message)) {
    return Object.freeze({ status: "READ_ONLY" });
  }
  if (/owned quote (context|lineage) required/u.test(message)) {
    return Object.freeze({ status: "NOT_FOUND" });
  }
  if (/already exists|provenance required/u.test(message)) {
    return Object.freeze({ status: "INVALID_TRANSITION" });
  }
  throw error;
}

function withTransaction<T>(
  sql: RootOrTransactionSql,
  callback: (transaction: TransactionSql) => Promise<T>,
): Promise<T> {
  return ("savepoint" in sql
    ? sql.savepoint(callback)
    : sql.begin((transaction) =>
        callback(transaction),
      )) as unknown as Promise<T>;
}

function commandFingerprint(
  kind: CommandKind,
  input:
    | CreateQuoteDraftInput
    | CreateQuoteRevisionInput
    | RejectQuoteRevisionInput
    | SubmitQuoteRevisionInput,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ kind, ...input, commandId: undefined }))
    .digest("hex");
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}

function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.valueOf());
}
