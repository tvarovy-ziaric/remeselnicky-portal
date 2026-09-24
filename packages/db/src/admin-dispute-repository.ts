import { createHash } from "node:crypto";

import type { PrivilegedActor } from "@portal/admin-auth";
import { auditActorFromPrivilegedActor } from "@portal/audit";
import type { Sql, TransactionSql } from "postgres";

import { createAuditRepository } from "./audit-repository.js";

type RootSql = Sql | TransactionSql;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const unsafeReason =
  /(?:[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|https?:\/\/|bearer\s+\S+|(?:\+?\d[\d ().-]{6,}\d))/iu;
const control = /[\p{Cc}]/u;

export const ADMIN_DISPUTE_ACTIONS = Object.freeze([
  "START_REVIEW",
  "REQUEST_INFORMATION",
  "ADD_INTERNAL_NOTE",
  "RECORD_OUTCOME",
  "CLOSE",
  "REOPEN",
] as const);
export type AdminDisputeAction = (typeof ADMIN_DISPUTE_ACTIONS)[number];
export type AdminDisputeState =
  "OPEN" | "WAITING_FOR_PARTY" | "UNDER_REVIEW" | "RESOLVED" | "CLOSED";
export type DisputeRequestRecipient = "CUSTOMER" | "PRIMARY_PROVIDER" | "BOTH";
export const DISPUTE_OUTCOME_CATEGORIES = Object.freeze([
  "RESOLVED_BY_PARTIES",
  "OPERATIONAL_ADMIN_RESOLUTION",
  "NO_ACTION",
  "REFERRED_OUTSIDE_PLATFORM",
  "ACCOUNT_POLICY_ACTION",
  "OTHER",
] as const);
export type DisputeOutcomeCategory =
  (typeof DISPUTE_OUTCOME_CATEGORIES)[number];
export type DisputeOutcomeBasis =
  "MUTUAL_PARTY_AGREEMENT" | "ADMINISTRATIVE_CLOSURE";

interface CommandBase {
  readonly actor: PrivilegedActor;
  readonly privilegedSessionId: string;
  readonly commandId: string;
  readonly disputeId: string;
  readonly expectedState: AdminDisputeState;
  readonly reason: string;
}

export type AdminDisputeCommand =
  | (CommandBase & { readonly action: "START_REVIEW" | "CLOSE" | "REOPEN" })
  | (CommandBase & {
      readonly action: "REQUEST_INFORMATION";
      readonly recipient: DisputeRequestRecipient;
      readonly requestText: string;
      readonly replyDeadline: Date | null;
    })
  | (CommandBase & {
      readonly action: "ADD_INTERNAL_NOTE";
      readonly note: string;
    })
  | (CommandBase & {
      readonly action: "RECORD_OUTCOME";
      readonly category: DisputeOutcomeCategory;
      readonly basis: DisputeOutcomeBasis;
      readonly summary: string;
    });

export type AdminDisputeCommandResult =
  | Readonly<{
      status: "APPLIED" | "DEDUPLICATED";
      commandId: string;
      disputeId: string;
      state: AdminDisputeState;
      recordedAt: Date;
    }>
  | Readonly<{ status: "NOT_FOUND" | "STALE_STATE" }>;

export interface AdminDisputeQueueItem {
  readonly disputeId: string;
  readonly jobId: string;
  readonly category: string;
  readonly state: AdminDisputeState;
  readonly openedByRole: "CUSTOMER" | "PRIMARY_PROVIDER";
  readonly createdAt: Date;
  readonly stateChangedAt: Date;
  readonly informationRequestCount: number;
}

export interface AdminDisputeCaseDetail extends AdminDisputeQueueItem {
  readonly description: string;
  readonly desiredResolution: string;
  readonly jobState: string;
  readonly conversationId: string;
  readonly statements: readonly Readonly<{
    id: string;
    authorRole: string;
    kind: string;
    body: string;
    createdAt: Date;
  }>[];
  readonly evidence: readonly Readonly<{
    id: string;
    submittedByRole: string;
    mediaAssetId: string;
    description: string;
    createdAt: Date;
  }>[];
  readonly informationRequests: readonly Readonly<{
    id: string;
    recipient: DisputeRequestRecipient;
    requestText: string;
    replyDeadline: Date | null;
    requestedAt: Date;
  }>[];
  readonly internalNotes: readonly Readonly<{
    id: string;
    body: string;
    createdAt: Date;
  }>[];
  readonly outcomes: readonly Readonly<{
    id: string;
    category: DisputeOutcomeCategory;
    basis: DisputeOutcomeBasis;
    summary: string;
    recordedAt: Date;
  }>[];
  readonly conversation: readonly Readonly<{
    id: string;
    sequence: number;
    kind: string;
    authorUserId: string | null;
    body: string | null;
    createdAt: Date;
  }>[];
  readonly attachments: readonly Readonly<{
    mediaAssetId: string;
    sourceMessageId: string;
    mediaKind: string;
    uploadedAt: Date;
  }>[];
}

export class AdminDisputeIdempotencyError extends Error {}

export function createAdminDisputeRepository(sql: RootSql) {
  async function execute(
    input: AdminDisputeCommand,
  ): Promise<AdminDisputeCommandResult> {
    validateCommand(input);
    auditActorFromPrivilegedActor(input.actor, "admin.disputes.manage");
    const normalized = normalize(input);
    const payloadFingerprint = digest(JSON.stringify(normalized));
    return transaction(sql, async (tx) => {
      await lockCommand(tx, input.commandId);
      const [existing] = await tx<
        Array<{
          actorUserId: string;
          disputeId: string;
          payloadFingerprint: string;
          resultingState: AdminDisputeState | null;
          expectedState: AdminDisputeState;
          recordedAt: Date;
        }>
      >`
        SELECT actor_user_id AS "actorUserId", dispute_id AS "disputeId",
          payload_fingerprint AS "payloadFingerprint",
          resulting_state::text AS "resultingState",
          expected_state::text AS "expectedState", recorded_at AS "recordedAt"
        FROM dispute_case_admin_commands WHERE command_id = ${input.commandId}`;
      if (existing) {
        if (existing.actorUserId !== input.actor.userId)
          return { status: "NOT_FOUND" };
        if (
          existing.disputeId !== input.disputeId ||
          existing.payloadFingerprint !== payloadFingerprint
        )
          throw new AdminDisputeIdempotencyError(
            "Administrative dispute command ID reused with different intent.",
          );
        return Object.freeze({
          status: "DEDUPLICATED" as const,
          commandId: input.commandId,
          disputeId: input.disputeId,
          state: existing.resultingState ?? existing.expectedState,
          recordedAt: existing.recordedAt,
        });
      }

      const [current] = await tx<Array<{ state: AdminDisputeState }>>`
        SELECT state::text FROM current_dispute_cases
        WHERE id = ${input.disputeId}`;
      if (!current) return { status: "NOT_FOUND" };
      if (current.state !== input.expectedState)
        return { status: "STALE_STATE" };

      const details = commandDetails(input);
      const auditEventId = derivedUuid(
        `admin-dispute-audit:${input.commandId}`,
      );
      const [inserted] = await tx<
        Array<{ state: AdminDisputeState | null; recordedAt: Date }>
      >`
        INSERT INTO dispute_case_admin_commands (
          command_id, dispute_id, action, actor_user_id,
          actor_privileged_session_hash, expected_state, reason,
          request_recipient, request_text, reply_deadline, internal_note,
          outcome_category, outcome_basis, outcome_summary,
          payload_fingerprint, audit_event_id
        ) VALUES (
          ${input.commandId}, ${input.disputeId}, ${input.action},
          ${input.actor.userId}, ${digest(input.privilegedSessionId)},
          ${input.expectedState}, ${input.reason}, ${details.recipient},
          ${details.requestText}, ${details.replyDeadline}, ${details.note},
          ${details.category}, ${details.basis}, ${details.summary},
          ${payloadFingerprint}, ${auditEventId}
        ) RETURNING resulting_state::text AS state,
          recorded_at AS "recordedAt"`;
      if (!inserted) throw new Error("Dispute administrative effect missing.");
      const resultingState = inserted.state ?? input.expectedState;
      await createAuditRepository(tx).append({
        action: auditAction(input.action),
        actor: auditActorFromPrivilegedActor(
          input.actor,
          "admin.disputes.manage",
        ),
        category: "PRIVILEGED_COMMAND",
        changes:
          resultingState === input.expectedState
            ? {}
            : {
                dispute_state: {
                  before: input.expectedState,
                  after: resultingState,
                },
              },
        correlationId: input.commandId,
        eventId: auditEventId,
        reason: input.reason,
        target: { id: input.disputeId, type: "DISPUTE_CASE" },
      });
      return Object.freeze({
        status: "APPLIED" as const,
        commandId: input.commandId,
        disputeId: input.disputeId,
        state: resultingState,
        recordedAt: inserted.recordedAt,
      });
    });
  }

  async function listQueue(input: {
    actor: PrivilegedActor;
    privilegedSessionId: string;
    state?: AdminDisputeState;
    limit?: number;
  }): Promise<readonly AdminDisputeQueueItem[]> {
    validateAdmin(input.actor, input.privilegedSessionId);
    if (
      input.state !== undefined &&
      ![
        "OPEN",
        "WAITING_FOR_PARTY",
        "UNDER_REVIEW",
        "RESOLVED",
        "CLOSED",
      ].includes(input.state)
    )
      throw new TypeError("Invalid dispute queue state.");
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new TypeError("Invalid dispute queue limit.");
    return transaction(sql, async (tx) => {
      await requireRecentSession(tx, input.actor, input.privilegedSessionId);
      const rows = await tx<
        Array<
          Omit<AdminDisputeQueueItem, "state" | "openedByRole"> & {
            state: string;
            openedByRole: string;
          }
        >
      >`
        SELECT dispute.id AS "disputeId", dispute.job_id AS "jobId",
          dispute.category::text, dispute.state::text,
          dispute.opened_by_role::text AS "openedByRole",
          dispute.created_at AS "createdAt",
          dispute.state_changed_at AS "stateChangedAt",
          (SELECT count(*)::integer FROM dispute_case_information_requests request
            WHERE request.dispute_id = dispute.id) AS "informationRequestCount"
        FROM current_dispute_cases dispute
        WHERE (${input.state ?? null}::text IS NULL
          OR dispute.state::text = ${input.state ?? null}::text)
        ORDER BY CASE dispute.state
          WHEN 'OPEN' THEN 1 WHEN 'WAITING_FOR_PARTY' THEN 2
          WHEN 'UNDER_REVIEW' THEN 3 WHEN 'RESOLVED' THEN 4 ELSE 5 END,
          dispute.state_changed_at, dispute.id
        LIMIT ${limit}`;
      return Object.freeze(
        rows.map((row) =>
          Object.freeze({
            ...row,
            state: row.state as AdminDisputeState,
            openedByRole: row.openedByRole as "CUSTOMER" | "PRIMARY_PROVIDER",
          }),
        ),
      );
    });
  }

  async function getCase(input: {
    actor: PrivilegedActor;
    privilegedSessionId: string;
    disputeId: string;
    accessId: string;
    reason: string;
  }): Promise<AdminDisputeCaseDetail | null> {
    validateAdmin(input.actor, input.privilegedSessionId);
    ids(input.disputeId, input.accessId);
    safeReason(input.reason);
    return transaction(sql, async (tx) => {
      await requireRecentSession(tx, input.actor, input.privilegedSessionId);
      const [row] = await tx<
        Array<
          Omit<
            AdminDisputeQueueItem,
            "state" | "openedByRole" | "informationRequestCount"
          > & {
            state: string;
            openedByRole: string;
            description: string;
            desiredResolution: string;
            jobState: string;
            conversationId: string;
          }
        >
      >`
        SELECT dispute.id AS "disputeId", dispute.job_id AS "jobId",
          dispute.category::text, dispute.state::text,
          dispute.opened_by_role::text AS "openedByRole",
          dispute.description, dispute.desired_resolution AS "desiredResolution",
          dispute.created_at AS "createdAt",
          dispute.state_changed_at AS "stateChangedAt",
          job_state.state::text AS "jobState",
          job.winning_conversation_id AS "conversationId"
        FROM current_dispute_cases dispute
        JOIN jobs job ON job.id = dispute.job_id
        JOIN current_job_states job_state ON job_state.job_id = job.id
        WHERE dispute.id = ${input.disputeId}`;
      if (!row) return null;

      await createAuditRepository(tx).append({
        action: "admin.dispute.private_evidence_accessed",
        actor: auditActorFromPrivilegedActor(
          input.actor,
          "admin.disputes.manage",
        ),
        category: "SENSITIVE_ACCESS",
        changes: {},
        context: { id: input.disputeId, type: "DISPUTE_CASE" },
        correlationId: input.accessId,
        eventId: input.accessId,
        reason: input.reason,
        sensitiveAccessPurpose: "DISPUTE_INVESTIGATION",
        target: { id: row.conversationId, type: "CONVERSATION" },
      });

      const [
        statements,
        evidence,
        requests,
        notes,
        outcomes,
        conversation,
        attachments,
      ] = await Promise.all([
        tx<
          Array<{
            id: string;
            authorRole: string;
            kind: string;
            body: string;
            createdAt: Date;
          }>
        >`
            SELECT id, author_role::text AS "authorRole", kind::text, body,
              created_at AS "createdAt" FROM dispute_case_statements
            WHERE dispute_id = ${input.disputeId} ORDER BY created_at, id`,
        tx<
          Array<{
            id: string;
            submittedByRole: string;
            mediaAssetId: string;
            description: string;
            createdAt: Date;
          }>
        >`
            SELECT id, submitted_by_role::text AS "submittedByRole",
              media_asset_id AS "mediaAssetId", description, created_at AS "createdAt"
            FROM dispute_case_evidence WHERE dispute_id = ${input.disputeId}
            ORDER BY created_at, id`,
        tx<
          Array<{
            id: string;
            recipient: DisputeRequestRecipient;
            requestText: string;
            replyDeadline: Date | null;
            requestedAt: Date;
          }>
        >`
            SELECT id, recipient::text, request_text AS "requestText",
              reply_deadline AS "replyDeadline", requested_at AS "requestedAt"
            FROM dispute_case_information_requests
            WHERE dispute_id = ${input.disputeId} ORDER BY requested_at, id`,
        tx<Array<{ id: string; body: string; createdAt: Date }>>`
            SELECT id, body, created_at AS "createdAt" FROM dispute_case_internal_notes
            WHERE dispute_id = ${input.disputeId} ORDER BY created_at, id`,
        tx<
          Array<{
            id: string;
            category: DisputeOutcomeCategory;
            basis: DisputeOutcomeBasis;
            summary: string;
            recordedAt: Date;
          }>
        >`
            SELECT id, category::text, basis::text, summary, recorded_at AS "recordedAt"
            FROM dispute_case_outcomes WHERE dispute_id = ${input.disputeId}
            ORDER BY recorded_at, id`,
        tx<
          Array<{
            id: string;
            sequence: number;
            kind: string;
            authorUserId: string | null;
            body: string | null;
            createdAt: Date;
          }>
        >`
            SELECT id, sequence::integer, entry_kind::text AS kind,
              author_user_id AS "authorUserId", body, created_at AS "createdAt"
            FROM conversation_timeline_entries
            WHERE conversation_id = ${row.conversationId}
            ORDER BY sequence, id`,
        tx<
          Array<{
            mediaAssetId: string;
            sourceMessageId: string;
            mediaKind: string;
            uploadedAt: Date;
          }>
        >`
            SELECT media_asset_id AS "mediaAssetId",
              source_message_id AS "sourceMessageId", media_kind::text AS "mediaKind",
              uploaded_at AS "uploadedAt" FROM job_conversation_media
            WHERE job_id = ${row.jobId} ORDER BY chronological_at, media_asset_id`,
      ]);
      return Object.freeze({
        ...row,
        state: row.state as AdminDisputeState,
        openedByRole: row.openedByRole as "CUSTOMER" | "PRIMARY_PROVIDER",
        informationRequestCount: requests.length,
        statements: freezeRows(statements),
        evidence: freezeRows(evidence),
        informationRequests: freezeRows(requests),
        internalNotes: freezeRows(notes),
        outcomes: freezeRows(outcomes),
        conversation: freezeRows(conversation),
        attachments: freezeRows(attachments),
      });
    });
  }

  return Object.freeze({
    startReview: (input: CommandBase) =>
      execute({ ...input, action: "START_REVIEW" }),
    requestInformation: (
      input: CommandBase & {
        recipient: DisputeRequestRecipient;
        requestText: string;
        replyDeadline: Date | null;
      },
    ) => execute({ ...input, action: "REQUEST_INFORMATION" }),
    addInternalNote: (input: CommandBase & { note: string }) =>
      execute({ ...input, action: "ADD_INTERNAL_NOTE" }),
    recordOutcome: (
      input: CommandBase & {
        category: DisputeOutcomeCategory;
        basis: DisputeOutcomeBasis;
        summary: string;
      },
    ) => execute({ ...input, action: "RECORD_OUTCOME" }),
    close: (input: CommandBase) => execute({ ...input, action: "CLOSE" }),
    reopen: (input: CommandBase) => execute({ ...input, action: "REOPEN" }),
    listQueue,
    getCase,
  });
}

function validateCommand(input: AdminDisputeCommand): void {
  validateAdmin(input.actor, input.privilegedSessionId);
  ids(input.commandId, input.disputeId, input.actor.userId);
  safeReason(input.reason);
  if (
    ![
      "OPEN",
      "WAITING_FOR_PARTY",
      "UNDER_REVIEW",
      "RESOLVED",
      "CLOSED",
    ].includes(input.expectedState)
  )
    throw new TypeError("Invalid expected dispute state.");
  if (input.action === "REQUEST_INFORMATION") {
    if (
      !(["CUSTOMER", "PRIMARY_PROVIDER", "BOTH"] as const).includes(
        input.recipient,
      )
    )
      throw new TypeError("Invalid dispute request recipient.");
    bounded(input.requestText, 1, 2000);
    if (
      input.replyDeadline !== null &&
      (!(input.replyDeadline instanceof Date) ||
        !Number.isFinite(input.replyDeadline.getTime()))
    )
      throw new TypeError("Invalid dispute reply deadline.");
  } else if (input.action === "ADD_INTERNAL_NOTE") {
    bounded(input.note, 1, 4000);
  } else if (input.action === "RECORD_OUTCOME") {
    if (!DISPUTE_OUTCOME_CATEGORIES.includes(input.category))
      throw new TypeError("Invalid dispute outcome category.");
    if (
      !(["MUTUAL_PARTY_AGREEMENT", "ADMINISTRATIVE_CLOSURE"] as const).includes(
        input.basis,
      )
    )
      throw new TypeError("Invalid dispute outcome basis.");
    bounded(input.summary, 1, 4000);
  }
}

function validateAdmin(actor: PrivilegedActor, sessionId: string): void {
  auditActorFromPrivilegedActor(actor, "admin.disputes.manage");
  if (typeof sessionId !== "string" || sessionId.length < 16)
    throw new TypeError("Invalid privileged session.");
}

async function requireRecentSession(
  tx: TransactionSql,
  actor: PrivilegedActor,
  sessionId: string,
): Promise<void> {
  const [row] = await tx<Array<{ allowed: boolean }>>`
    SELECT admin_dispute_session_is_recent(
      ${digest(sessionId)}::char(64), ${actor.userId}::uuid
    ) AS allowed`;
  if (row?.allowed !== true) throw new Error("Privileged access denied.");
}

function commandDetails(input: AdminDisputeCommand): {
  recipient: string | null;
  requestText: string | null;
  replyDeadline: Date | null;
  note: string | null;
  category: string | null;
  basis: string | null;
  summary: string | null;
} {
  return {
    recipient: input.action === "REQUEST_INFORMATION" ? input.recipient : null,
    requestText:
      input.action === "REQUEST_INFORMATION" ? input.requestText : null,
    replyDeadline:
      input.action === "REQUEST_INFORMATION" ? input.replyDeadline : null,
    note: input.action === "ADD_INTERNAL_NOTE" ? input.note : null,
    category: input.action === "RECORD_OUTCOME" ? input.category : null,
    basis: input.action === "RECORD_OUTCOME" ? input.basis : null,
    summary: input.action === "RECORD_OUTCOME" ? input.summary : null,
  };
}

function normalize(input: AdminDisputeCommand): unknown {
  return {
    action: input.action,
    disputeId: input.disputeId,
    expectedState: input.expectedState,
    reason: input.reason,
    ...commandDetails(input),
  };
}

function auditAction(action: AdminDisputeAction): string {
  return {
    START_REVIEW: "admin.dispute.review_started",
    REQUEST_INFORMATION: "admin.dispute.information_requested",
    ADD_INTERNAL_NOTE: "admin.dispute.internal_note_added",
    RECORD_OUTCOME: "admin.dispute.outcome_recorded",
    CLOSE: "admin.dispute.closed",
    REOPEN: "admin.dispute.reopened",
  }[action];
}

function safeReason(value: string): string {
  bounded(value, 8, 500);
  if (unsafeReason.test(value)) throw new TypeError("Unsafe audit reason.");
  return value;
}
function bounded(value: string, minimum: number, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < minimum ||
    value.length > maximum ||
    control.test(value)
  )
    throw new TypeError("Invalid bounded text.");
  return value;
}
function ids(...values: string[]): void {
  if (values.some((value) => typeof value !== "string" || !uuid.test(value)))
    throw new TypeError("Invalid identity.");
}
async function lockCommand(tx: TransactionSql, id: string): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${id}::text, 5223))`;
}
function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function derivedUuid(seed: string): string {
  const hex = digest(seed);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function freezeRows<T extends object>(
  rows: readonly T[],
): readonly Readonly<T>[] {
  return Object.freeze(rows.map((row) => Object.freeze({ ...row })));
}
function transaction<T>(
  sql: RootSql,
  work: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return ("savepoint" in sql
    ? sql.savepoint(work)
    : sql.begin(work)) as unknown as Promise<T>;
}
