import { createHash, randomUUID } from "node:crypto";
import {
  assertExpireQuoteRevisionInput,
  assertQuoteAcceptanceContext,
  assertQuoteAcceptanceContextReadInput,
  assertQuoteLifecycleCommandInput,
  assertReconfirmQuoteInput,
  QuoteIdempotencyError,
  type ExpireQuoteRevisionInput,
  type QuoteAcceptanceContext,
  type QuoteAcceptanceContextReadInput,
  type QuoteLifecycleCommandInput,
  type QuoteLifecycleCommandResult,
  type QuoteLifecycleExpiredRevision,
  type QuoteLifecycleMaintenancePersistence,
  type QuoteLifecyclePersistence,
  type ReconfirmQuoteInput,
} from "@portal/domain";
import type { Sql, TransactionSql } from "postgres";

import { createQuoteRepository } from "./quote-repository.js";

type RootSql = Sql | TransactionSql;
type Kind = "WITHDRAW" | "EXPIRE";
interface CommandRow {
  readonly actorUserId: string | null;
  readonly commandKind: Kind;
  readonly expectedStateRevision: number;
  readonly payloadFingerprint: string;
  readonly quoteId: string;
  readonly quoteRevision: number;
}
interface ContextRow {
  readonly authoringEligible: boolean;
  readonly authoringMode: string;
  readonly currentRequestContentRevision: number;
  readonly currentRequestVisibleVersion: number;
  readonly deadlinePassed: boolean;
  readonly lifecycleAcceptanceEligible: boolean;
  readonly materiallyStale: boolean;
  readonly quoteId: string;
  readonly quoteRevision: number;
  readonly requestContentRevision: number;
  readonly requestVisibleVersion: number;
  readonly state: string;
  readonly stateRevision: number;
  readonly validUntil: Date | null;
}

export function createQuoteLifecycleRepository(
  sql: RootSql,
): QuoteLifecyclePersistence & QuoteLifecycleMaintenancePersistence {
  return Object.freeze({
    expireDueSubmitted() {
      return expireDueSubmitted(sql);
    },
    readOwnedContext(input: QuoteAcceptanceContextReadInput) {
      assertQuoteAcceptanceContextReadInput(input);
      return transaction(sql, (tx) => readOwnedContext(tx, input));
    },
    reconfirm(input: ReconfirmQuoteInput) {
      assertReconfirmQuoteInput(input);
      return reconfirm(sql, input);
    },
    withdraw(input: QuoteLifecycleCommandInput) {
      assertQuoteLifecycleCommandInput(input);
      return execute(sql, "WITHDRAW", input);
    },
  });
}

const QUOTE_EXPIRY_BATCH_LIMIT = 100;

async function expireDueSubmitted(
  sql: RootSql,
): Promise<readonly QuoteLifecycleExpiredRevision[]> {
  return transaction(sql, async (tx) => {
    const candidates = await tx<
      Array<{
        expectedStateRevision: number;
        quoteId: string;
        quoteRevision: number;
      }>
    >`
      SELECT submitted.state_revision AS "expectedStateRevision",
        submitted.quote_id AS "quoteId", submitted.revision AS "quoteRevision"
      FROM current_submitted_quotes submitted
      JOIN quotes quote ON quote.id = submitted.quote_id
      JOIN job_invitations invitation ON invitation.id = quote.invitation_id
      WHERE quote_revision_valid_until(submitted.quote_id, submitted.revision,
          submitted.authoring_mode) <= clock_timestamp()
      ORDER BY quote_revision_valid_until(submitted.quote_id, submitted.revision,
        submitted.authoring_mode), submitted.quote_id
      LIMIT ${QUOTE_EXPIRY_BATCH_LIMIT}
      FOR UPDATE OF invitation SKIP LOCKED`;
    const expired: QuoteLifecycleExpiredRevision[] = [];
    for (const candidate of candidates) {
      const input: ExpireQuoteRevisionInput = {
        commandId: randomUUID(),
        expectedStateRevision: candidate.expectedStateRevision,
        quoteId: candidate.quoteId as never,
        quoteRevision: candidate.quoteRevision,
      };
      assertExpireQuoteRevisionInput(input);
      const result = await execute(tx, "EXPIRE", input);
      if (result.status === "APPLIED")
        expired.push(
          Object.freeze({
            quoteId: input.quoteId,
            quoteRevision: input.quoteRevision,
          }),
        );
    }
    return Object.freeze(expired);
  });
}

async function execute(
  sql: RootSql,
  kind: Kind,
  input: QuoteLifecycleCommandInput | ExpireQuoteRevisionInput,
): Promise<QuoteLifecycleCommandResult> {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ kind, ...input, commandId: undefined }))
    .digest("hex");
  try {
    return await transaction(sql, async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${input.commandId}, 51001))`;
      if (
        kind === "WITHDRAW" &&
        !(await authorizeProvider(tx, input as QuoteLifecycleCommandInput))
      )
        return { status: "NOT_FOUND" };
      const [existing] = await tx<
        CommandRow[]
      >`SELECT command_kind::text AS "commandKind", quote_id AS "quoteId", quote_revision AS "quoteRevision", actor_user_id AS "actorUserId", expected_state_revision AS "expectedStateRevision", payload_fingerprint AS "payloadFingerprint" FROM quote_lifecycle_commands WHERE command_id = ${input.commandId}`;
      if (existing !== undefined) {
        if (
          existing.commandKind !== kind ||
          existing.quoteId !== input.quoteId ||
          existing.quoteRevision !== input.quoteRevision ||
          existing.expectedStateRevision !== input.expectedStateRevision ||
          existing.payloadFingerprint !== fingerprint ||
          existing.actorUserId !==
            ("actorUserId" in input ? input.actorUserId : null)
        )
          throw new QuoteIdempotencyError(
            "Quote lifecycle command id reused with another intent.",
          );
        const context = await readContext(
          tx,
          input.quoteId,
          input.quoteRevision,
        );
        return context === null
          ? { status: "NOT_FOUND" }
          : { context, status: "DEDUPLICATED" };
      }
      const inserted =
        await tx`INSERT INTO quote_lifecycle_commands (command_id, command_kind, actor_kind, quote_id, quote_revision, conversation_id, actor_user_id, actor_system_reference, expected_state_revision, resulting_state_revision, target_state, valid_until_snapshot, payload_fingerprint, created_at)
        SELECT ${input.commandId}, ${kind}, ${kind === "WITHDRAW" ? "PROVIDER" : "SYSTEM"}, quote.id, ${input.quoteRevision}, quote.conversation_id,
          ${"actorUserId" in input ? input.actorUserId : null}, ${kind === "EXPIRE" ? "quote-lifecycle:deadline-sweeper" : null}, ${input.expectedStateRevision}, 1,
          ${kind === "WITHDRAW" ? "WITHDRAWN" : "EXPIRED"}, NULL, ${fingerprint}, clock_timestamp()
        FROM quotes quote WHERE quote.id = ${input.quoteId} RETURNING command_id`;
      if (inserted.length !== 1) return { status: "NOT_FOUND" };
      await tx`INSERT INTO quote_revision_state_events (quote_id, quote_revision, state_revision, command_id, lifecycle_command_id, state, rejection_reason, changed_at, submitted_at)
        VALUES (${input.quoteId}, ${input.quoteRevision}, 1, NULL, ${input.commandId}, ${kind === "WITHDRAW" ? "WITHDRAWN" : "EXPIRED"}, NULL, clock_timestamp(), clock_timestamp())`;
      const context = await readContext(tx, input.quoteId, input.quoteRevision);
      if (context === null) throw new Error("Quote lifecycle effect missing.");
      return { context, status: "APPLIED" };
    });
  } catch (error) {
    if (error instanceof QuoteIdempotencyError) throw error;
    const message = error instanceof Error ? error.message : "";
    if (/not due for expiry/u.test(message)) return { status: "NOT_DUE" };
    if (/invalid or stale/u.test(message)) return { status: "STALE_REVISION" };
    if (
      /owned Quote lifecycle context|writable quote conversation/u.test(message)
    )
      return { status: "NOT_FOUND" };
    throw error;
  }
}

async function authorizeProvider(
  tx: TransactionSql,
  input: QuoteLifecycleCommandInput,
): Promise<boolean> {
  const actor =
    await tx`SELECT id FROM users WHERE id = ${input.actorUserId} AND account_state = 'ACTIVE' FOR UPDATE`;
  if (actor.length !== 1) return false;
  const [row] = await tx<
    Array<{ invitationId: string; conversationId: string }>
  >`SELECT quote.invitation_id AS "invitationId", quote.conversation_id AS "conversationId" FROM quotes quote JOIN current_conversations conversation ON conversation.id = quote.conversation_id JOIN craftsman_profiles profile ON profile.id = conversation.craftsman_profile_id WHERE quote.id = ${input.quoteId} AND profile.owner_user_id = ${input.actorUserId}`;
  if (row === undefined) return false;
  await tx`SELECT id FROM job_invitations WHERE id = ${row.invitationId} FOR UPDATE`;
  await tx`SELECT id FROM conversations WHERE id = ${row.conversationId} FOR UPDATE`;
  await tx`SELECT id FROM quotes WHERE id = ${input.quoteId} FOR UPDATE`;
  const writable =
    await tx`SELECT quote_active_participant_context(${row.conversationId}, ${input.actorUserId}, 'CRAFTSMAN', true) AS allowed`;
  return writable[0]?.allowed === true;
}

async function readOwnedContext(
  tx: TransactionSql,
  input: QuoteAcceptanceContextReadInput,
): Promise<QuoteAcceptanceContext | null> {
  const actor =
    await tx`SELECT id FROM users WHERE id = ${input.actorUserId} AND account_state = 'ACTIVE' FOR UPDATE`;
  if (actor.length !== 1) return null;
  const [owned] = await tx<
    Array<{ quoteRevision: number }>
  >`SELECT context.quote_revision AS "quoteRevision" FROM current_quote_acceptance_context context JOIN quotes quote ON quote.id = context.quote_id JOIN current_conversations conversation ON conversation.id = quote.conversation_id JOIN customer_profiles customer ON customer.id = conversation.customer_profile_id JOIN craftsman_profiles craftsman ON craftsman.id = conversation.craftsman_profile_id WHERE context.quote_id = ${input.quoteId} AND (customer.owner_user_id = ${input.actorUserId} OR craftsman.owner_user_id = ${input.actorUserId}) ORDER BY context.quote_revision DESC LIMIT 1 FOR UPDATE OF quote, customer, craftsman`;
  return owned === undefined
    ? null
    : readContext(tx, input.quoteId, owned.quoteRevision);
}

async function readContext(
  tx: TransactionSql,
  quoteId: string,
  quoteRevision: number,
): Promise<QuoteAcceptanceContext | null> {
  const [row] = await tx<
    ContextRow[]
  >`SELECT quote_id AS "quoteId", quote_revision AS "quoteRevision", state::text AS state, state_revision AS "stateRevision", authoring_mode::text AS "authoringMode", request_content_revision AS "requestContentRevision", request_visible_version AS "requestVisibleVersion", current_request_content_revision AS "currentRequestContentRevision", current_request_visible_version AS "currentRequestVisibleVersion", valid_until AS "validUntil", authoring_eligible AS "authoringEligible", materially_stale AS "materiallyStale", deadline_passed AS "deadlinePassed", lifecycle_acceptance_eligible AS "lifecycleAcceptanceEligible" FROM current_quote_acceptance_context WHERE quote_id = ${quoteId} AND quote_revision = ${quoteRevision}`;
  if (row === undefined) return null;
  const context = {
    ...row,
    quoteId: row.quoteId as never,
    authoringMode: row.authoringMode as never,
    state: row.state as never,
    validUntil: row.validUntil === null ? null : new Date(row.validUntil),
  };
  assertQuoteAcceptanceContext(context);
  return Object.freeze(context);
}

async function reconfirm(sql: RootSql, input: ReconfirmQuoteInput) {
  return transaction(sql, async (tx) => {
    const actor =
      await tx`SELECT id FROM users WHERE id = ${input.actorUserId} AND account_state = 'ACTIVE' FOR UPDATE`;
    if (actor.length !== 1) return { status: "NOT_FOUND" } as const;
    const [identity] = await tx<
      Array<{
        conversationId: string;
        invitationId: string;
        jobRequestId: string;
      }>
    >`
      SELECT quote.conversation_id AS "conversationId",
        quote.invitation_id AS "invitationId",
        conversation.job_request_id AS "jobRequestId"
      FROM quotes quote
      JOIN current_conversations conversation ON conversation.id = quote.conversation_id
      JOIN craftsman_profiles craftsman ON craftsman.id = conversation.craftsman_profile_id
      WHERE quote.id = ${input.quoteId}
        AND craftsman.owner_user_id = ${input.actorUserId}`;
    if (identity === undefined) return { status: "NOT_FOUND" } as const;

    // Canonical write order shared with invitation/conversation/Quote commands.
    await tx`SELECT id FROM job_invitations WHERE id = ${identity.invitationId} FOR UPDATE`;
    await tx`SELECT id FROM conversations WHERE id = ${identity.conversationId} FOR UPDATE`;
    await tx`SELECT id FROM job_requests WHERE id = ${identity.jobRequestId} FOR UPDATE`;
    await tx`SELECT id FROM quotes WHERE id = ${input.quoteId} FOR UPDATE`;
    const [authorization] = await tx<Array<{ allowed: boolean }>>`
      SELECT quote_active_participant_context(${identity.conversationId},
          ${input.actorUserId}, 'CRAFTSMAN', true)
        AND EXISTS (SELECT 1 FROM current_job_requests request
          WHERE request.id = ${identity.jobRequestId}
            AND request.state::text = 'ACTIVE') AS allowed`;
    if (authorization?.allowed !== true)
      return { status: "NOT_FOUND" } as const;
    const [existing] = await tx<
      Array<{
        actorUserId: string;
        authoringMode: string;
        commandKind: string;
        quoteId: string;
        requestContentRevision: number;
        requestVisibleVersion: number;
        sourceQuoteRevision: number | null;
        sourceState: string | null;
        sourceStateRevision: number | null;
      }>
    >`
      SELECT actor_user_id AS "actorUserId", authoring_mode::text AS "authoringMode",
        command_kind::text AS "commandKind", quote_id AS "quoteId",
        request_content_revision AS "requestContentRevision",
        request_visible_version AS "requestVisibleVersion",
        source_quote_revision AS "sourceQuoteRevision",
        source_state::text AS "sourceState",
        source_state_revision AS "sourceStateRevision"
      FROM quote_core_commands WHERE command_id = ${input.commandId}`;
    if (existing !== undefined) {
      if (
        existing.actorUserId !== input.actorUserId ||
        existing.authoringMode !== input.authoringMode ||
        existing.commandKind !== "CREATE_REVISION" ||
        existing.quoteId !== input.quoteId ||
        existing.sourceQuoteRevision !== input.sourceQuoteRevision ||
        existing.sourceState !== input.sourceState ||
        existing.sourceStateRevision !== input.expectedSourceStateRevision
      )
        throw new QuoteIdempotencyError(
          "Quote reconfirm command id reused with another intent.",
        );
      return createQuoteRepository(tx).createRevision({
        actorUserId: input.actorUserId,
        authoringMode: input.authoringMode,
        commandId: input.commandId,
        expectedSubmittedStateRevision: input.expectedSourceStateRevision,
        quoteId: input.quoteId,
        requestContentRevision: existing.requestContentRevision,
        requestVisibleVersion: existing.requestVisibleVersion,
      });
    }
    const [source] = await tx<
      Array<{
        contentRevision: number;
        sourceRevision: number;
        sourceState: string;
        stateRevision: number;
        visibleVersion: number;
      }>
    >`
      SELECT active.content_revision AS "contentRevision",
        head.quote_revision AS "sourceRevision", head.state::text AS "sourceState",
        head.state_revision AS "stateRevision", active.visible_version AS "visibleVersion"
      FROM current_job_request_active_content_versions active
      JOIN quote_revision_heads head ON head.quote_id = ${input.quoteId}
      WHERE active.job_request_id = ${identity.jobRequestId}
        AND head.quote_revision = ${input.sourceQuoteRevision}
        AND head.state = ${input.sourceState}
        AND head.state_revision = ${input.expectedSourceStateRevision}
        AND NOT EXISTS (SELECT 1 FROM current_quote_drafts draft WHERE draft.quote_id = ${input.quoteId})
        AND (
          (head.state = 'SUBMITTED' AND EXISTS (
            SELECT 1 FROM current_submitted_quotes submitted
            WHERE submitted.quote_id = head.quote_id
              AND submitted.revision = head.quote_revision
          ))
          OR (head.state IN ('EXPIRED','WITHDRAWN') AND head.quote_revision = (
            SELECT max(revision) FROM quote_revision_identities identity
            WHERE identity.quote_id = head.quote_id
          ))
        )
      FOR UPDATE OF head`;
    if (source === undefined) return { status: "STALE_REVISION" } as const;
    return createQuoteRepository(tx).createRevision({
      actorUserId: input.actorUserId,
      authoringMode: input.authoringMode,
      commandId: input.commandId,
      expectedSubmittedStateRevision: source.stateRevision,
      quoteId: input.quoteId,
      requestContentRevision: source.contentRevision,
      requestVisibleVersion: source.visibleVersion,
    });
  });
}

function transaction<T>(
  sql: RootSql,
  callback: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return ("savepoint" in sql
    ? sql.savepoint(callback)
    : sql.begin(callback)) as unknown as Promise<T>;
}
