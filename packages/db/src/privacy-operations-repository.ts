import { createHash } from "node:crypto";

import type { PrivilegedActor } from "@portal/admin-auth";
import { auditActorFromPrivilegedActor } from "@portal/audit";
import type { UserId } from "@portal/domain";
import type {
  PrivacyRequestState,
  PrivacyRequestType,
  RetentionCategory,
} from "@portal/privacy";
import type { Sql, TransactionSql } from "postgres";

import { createAuditRepository } from "./audit-repository.js";

type RootSql = Sql | TransactionSql;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const reasonCode = /^[A-Z][A-Z0-9_]{2,63}$/u;
const control = /[\p{Cc}]/u;
const unsafeReason =
  /(?:[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|https?:\/\/|bearer\s+\S+|(?:\+?\d[\d ().-]{6,}\d))/iu;

export interface PrivacyRequestSummary {
  readonly actionCode: string | null;
  readonly actorUserId: UserId;
  readonly caseId: string;
  readonly deadlineAt: Date | null;
  readonly occurredAt: Date;
  readonly receivedAt: Date;
  readonly requestType: PrivacyRequestType;
  readonly revision: number;
  readonly state: PrivacyRequestState;
  readonly subjectUserId: UserId;
}

export interface PrivacyDataDisposition {
  readonly actionCode: string;
  readonly actorUserId: UserId;
  readonly category: RetentionCategory;
  readonly disposition:
    "ANONYMIZE" | "DELETE" | "NO_DATA" | "RETAIN" | "REVIEW_REQUIRED";
  readonly occurredAt: Date;
  readonly policyVersionId: string | null;
  readonly revision: number;
  readonly state: "BLOCKED" | "COMPLETED" | "FAILED" | "PROCESSING" | "READY";
}

export interface ExecuteAccountClosureInput {
  readonly actor: PrivilegedActor;
  readonly caseId: string;
  readonly commandId: string;
  readonly expectedRequestRevision: number;
  readonly expectedRequestState: "IN_REVIEW";
  readonly privilegedSessionId: string;
  readonly reason: string;
  readonly reasonCode: string;
  readonly subjectUserId: UserId;
}

export interface TransitionPrivacyRequestInput {
  readonly actionCode: string;
  readonly actor: PrivilegedActor;
  readonly caseId: string;
  readonly commandId: string;
  readonly deadlineAt: Date | null;
  readonly expectedRevision: number;
  readonly expectedState: PrivacyRequestState;
  readonly privilegedSessionId: string;
  readonly reason: string;
  readonly resultingState: Exclude<PrivacyRequestState, "RECEIVED">;
}

export type TransitionPrivacyRequestResult =
  | Readonly<{
      readonly commandId: string;
      readonly occurredAt: Date;
      readonly revision: number;
      readonly state: Exclude<PrivacyRequestState, "RECEIVED">;
      readonly status: "APPLIED" | "DEDUPLICATED";
    }>
  | Readonly<{ readonly status: "NOT_FOUND" }>
  | Readonly<{ readonly status: "STALE_STATE" }>;

export type ExecuteAccountClosureResult =
  | Readonly<{
      readonly commandId: string;
      readonly dispositions: readonly PrivacyDataDisposition[];
      readonly occurredAt: Date;
      readonly requestRevision: number;
      readonly requestState: "ACTION_REQUIRED";
      readonly status: "APPLIED" | "DEDUPLICATED";
    }>
  | Readonly<{ readonly status: "ACCOUNT_NOT_ACTIVE" }>
  | Readonly<{ readonly status: "ALREADY_DEACTIVATED" }>
  | Readonly<{ readonly status: "NOT_FOUND" }>
  | Readonly<{ readonly status: "OPEN_OBLIGATIONS" }>
  | Readonly<{ readonly status: "STALE_STATE" }>;

interface ClosureCommandRow {
  readonly actorUserId: UserId;
  readonly caseId: string;
  readonly commandId: string;
  readonly occurredAt: Date;
  readonly payloadFingerprint: string;
  readonly requestRevision: number;
  readonly subjectUserId: UserId;
}

interface RequestAdminCommandRow {
  readonly actorUserId: UserId;
  readonly caseId: string;
  readonly commandId: string;
  readonly occurredAt: Date;
  readonly payloadFingerprint: string;
  readonly revision: number;
  readonly state: Exclude<PrivacyRequestState, "RECEIVED">;
}

export class PrivacyAccountClosureIdempotencyError extends Error {}

export function createPrivacyOperationsRepository(sql: RootSql) {
  async function listForSubject(input: {
    readonly limit?: number;
    readonly subjectUserId: UserId;
  }): Promise<readonly PrivacyRequestSummary[]> {
    id(input.subjectUserId);
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new TypeError("Invalid privacy-request limit.");
    const rows = await sql<PrivacyRequestSummary[]>`
      SELECT case_id AS "caseId", subject_user_id AS "subjectUserId",
        request_type::text AS "requestType", received_at AS "receivedAt",
        revision, state::text, deadline_at AS "deadlineAt",
        action_code AS "actionCode", actor_user_id AS "actorUserId",
        occurred_at AS "occurredAt"
      FROM current_privacy_request_cases
      WHERE subject_user_id = ${input.subjectUserId}
      ORDER BY received_at DESC, case_id DESC
      LIMIT ${limit}`;
    return freezeRows(rows);
  }

  async function hasOpenObligations(subjectUserId: UserId): Promise<boolean> {
    id(subjectUserId);
    const [row] = await sql<Array<{ readonly blocked: boolean }>>`
      SELECT privacy_account_has_open_obligations(
        ${subjectUserId}::uuid
      ) AS blocked`;
    return row?.blocked === true;
  }

  async function listQueue(input: {
    readonly actor: PrivilegedActor;
    readonly limit?: number;
    readonly privilegedSessionId: string;
    readonly state?: PrivacyRequestState;
  }): Promise<readonly PrivacyRequestSummary[]> {
    validateAdmin(input.actor, input.privilegedSessionId);
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new TypeError("Invalid privacy-request queue limit.");
    if (
      input.state !== undefined &&
      ![
        "RECEIVED",
        "IDENTITY_VERIFICATION_PENDING",
        "VERIFIED",
        "IN_REVIEW",
        "ACTION_REQUIRED",
        "COMPLETED",
        "REJECTED",
      ].includes(input.state)
    )
      throw new TypeError("Invalid privacy-request queue state.");
    return transaction(sql, async (tx) => {
      await requireRecentSession(tx, input.actor, input.privilegedSessionId);
      const rows = await tx<PrivacyRequestSummary[]>`
        SELECT case_id AS "caseId", subject_user_id AS "subjectUserId",
          request_type::text AS "requestType", received_at AS "receivedAt",
          revision, state::text, deadline_at AS "deadlineAt",
          action_code AS "actionCode", actor_user_id AS "actorUserId",
          occurred_at AS "occurredAt"
        FROM current_privacy_request_cases
        WHERE (${input.state ?? null}::text IS NULL
          OR state::text = ${input.state ?? null}::text)
        ORDER BY CASE state
          WHEN 'RECEIVED' THEN 1
          WHEN 'IDENTITY_VERIFICATION_PENDING' THEN 2
          WHEN 'VERIFIED' THEN 3
          WHEN 'IN_REVIEW' THEN 4
          WHEN 'ACTION_REQUIRED' THEN 5
          ELSE 6 END,
          received_at, case_id
        LIMIT ${limit}`;
      return freezeRows(rows);
    });
  }

  async function transitionRequest(
    input: TransitionPrivacyRequestInput,
  ): Promise<TransitionPrivacyRequestResult> {
    validateTransition(input);
    auditActorFromPrivilegedActor(input.actor, "admin.privacy.manage");
    const payloadFingerprint = digest(
      JSON.stringify([
        input.caseId,
        input.actor.userId,
        input.expectedRevision,
        input.expectedState,
        input.resultingState,
        input.actionCode,
        input.deadlineAt?.toISOString() ?? null,
        input.reason,
      ]),
    );
    return transaction(sql, async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(
        hashtextextended(${input.commandId}::text, 427_027)
      )`;
      const [existing] = await tx<RequestAdminCommandRow[]>`
        SELECT command_id AS "commandId", case_id AS "caseId",
          actor_user_id AS "actorUserId",
          resulting_revision AS revision, resulting_state::text AS state,
          payload_fingerprint AS "payloadFingerprint",
          occurred_at AS "occurredAt"
        FROM privacy_request_admin_commands
        WHERE command_id = ${input.commandId}`;
      if (existing !== undefined) {
        if (existing.actorUserId !== input.actor.userId)
          return { status: "NOT_FOUND" };
        if (
          existing.caseId !== input.caseId ||
          existing.payloadFingerprint !== payloadFingerprint
        )
          throw new PrivacyAccountClosureIdempotencyError(
            "Privacy request command ID was reused with another intent.",
          );
        return Object.freeze({
          commandId: existing.commandId,
          occurredAt: existing.occurredAt,
          revision: existing.revision,
          state: existing.state,
          status: "DEDUPLICATED" as const,
        });
      }
      const [current] = await tx<
        Array<{
          readonly revision: number;
          readonly state: PrivacyRequestState;
        }>
      >`
        SELECT revision, state::text
        FROM current_privacy_request_cases
        WHERE case_id = ${input.caseId}`;
      if (current === undefined) return { status: "NOT_FOUND" };
      if (
        current.revision !== input.expectedRevision ||
        current.state !== input.expectedState
      )
        return { status: "STALE_STATE" };
      const [inserted] = await tx<RequestAdminCommandRow[]>`
        INSERT INTO privacy_request_admin_commands (
          command_id, case_id, actor_user_id,
          actor_privileged_session_hash, expected_revision, expected_state,
          resulting_revision, resulting_state, action_code, deadline_at,
          reason, payload_fingerprint
        ) VALUES (
          ${input.commandId}, ${input.caseId}, ${input.actor.userId},
          ${digest(input.privilegedSessionId)}, ${input.expectedRevision},
          ${input.expectedState}, ${input.expectedRevision + 1},
          ${input.resultingState}, ${input.actionCode}, ${input.deadlineAt},
          ${input.reason}, ${payloadFingerprint}
        ) RETURNING command_id AS "commandId", case_id AS "caseId",
          actor_user_id AS "actorUserId",
          resulting_revision AS revision, resulting_state::text AS state,
          payload_fingerprint AS "payloadFingerprint",
          occurred_at AS "occurredAt"`;
      if (inserted === undefined)
        throw new Error("Privacy request transition effect missing.");
      await createAuditRepository(tx).append({
        action: "admin.privacy.request_transitioned",
        actor: auditActorFromPrivilegedActor(
          input.actor,
          "admin.privacy.manage",
        ),
        category: "PRIVILEGED_COMMAND",
        changes: {},
        correlationId: input.commandId,
        eventId: derivedUuid(`privacy-request-audit:${input.commandId}`),
        reason: input.reason,
        target: { id: input.caseId, type: "PRIVACY_REQUEST" },
      });
      return Object.freeze({
        commandId: inserted.commandId,
        occurredAt: inserted.occurredAt,
        revision: inserted.revision,
        state: inserted.state,
        status: "APPLIED" as const,
      });
    });
  }

  async function executeAccountClosure(
    input: ExecuteAccountClosureInput,
  ): Promise<ExecuteAccountClosureResult> {
    validateClosure(input);
    auditActorFromPrivilegedActor(input.actor, "admin.privacy.manage");
    const payloadFingerprint = digest(
      JSON.stringify([
        input.caseId,
        input.subjectUserId,
        input.actor.userId,
        input.expectedRequestRevision,
        input.expectedRequestState,
        input.reasonCode,
        input.reason,
      ]),
    );
    return transaction(sql, async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(
        hashtextextended(${input.commandId}::text, 427026)
      )`;
      const [existing] = await tx<ClosureCommandRow[]>`
        SELECT command_id AS "commandId", case_id AS "caseId",
          subject_user_id AS "subjectUserId",
          actor_user_id AS "actorUserId",
          resulting_request_revision AS "requestRevision",
          payload_fingerprint AS "payloadFingerprint",
          occurred_at AS "occurredAt"
        FROM privacy_account_closure_commands
        WHERE command_id = ${input.commandId}`;
      if (existing !== undefined) {
        if (existing.actorUserId !== input.actor.userId)
          return { status: "NOT_FOUND" };
        if (
          existing.caseId !== input.caseId ||
          existing.subjectUserId !== input.subjectUserId ||
          existing.payloadFingerprint !== payloadFingerprint
        )
          throw new PrivacyAccountClosureIdempotencyError(
            "Privacy closure command ID was reused with another intent.",
          );
        return closureResult(tx, existing, "DEDUPLICATED");
      }

      const [priorClosure] = await tx<Array<{ readonly commandId: string }>>`
        SELECT command_id AS "commandId"
        FROM privacy_account_closure_commands
        WHERE case_id = ${input.caseId}`;
      if (priorClosure !== undefined) return { status: "ALREADY_DEACTIVATED" };

      const [current] = await tx<
        Array<{
          readonly accountState: "ACTIVE" | "DEACTIVATED" | "SUSPENDED";
          readonly requestType: PrivacyRequestType;
          readonly revision: number;
          readonly state: PrivacyRequestState;
          readonly subjectUserId: UserId;
        }>
      >`
        SELECT request.subject_user_id AS "subjectUserId",
          request.request_type::text AS "requestType",
          request.revision, request.state::text,
          subject.account_state::text AS "accountState"
        FROM current_privacy_request_cases request
        JOIN users subject ON subject.id = request.subject_user_id
        WHERE request.case_id = ${input.caseId}`;
      if (
        current === undefined ||
        current.requestType !== "ACCOUNT_CLOSURE" ||
        current.subjectUserId !== input.subjectUserId
      )
        return { status: "NOT_FOUND" };
      if (
        current.revision !== input.expectedRequestRevision ||
        current.state !== input.expectedRequestState
      )
        return { status: "STALE_STATE" };
      if (current.accountState !== "ACTIVE")
        return { status: "ACCOUNT_NOT_ACTIVE" };
      const [obligations] = await tx<Array<{ readonly blocked: boolean }>>`
        SELECT privacy_account_has_open_obligations(
          ${input.subjectUserId}::uuid
        ) AS blocked`;
      if (obligations?.blocked === true) return { status: "OPEN_OBLIGATIONS" };

      const [inserted] = await tx<ClosureCommandRow[]>`
        INSERT INTO privacy_account_closure_commands (
          command_id, case_id, subject_user_id, actor_user_id,
          actor_privileged_session_hash, expected_request_revision,
          expected_request_state, resulting_request_revision,
          reason_code, reason, payload_fingerprint
        ) VALUES (
          ${input.commandId}, ${input.caseId}, ${input.subjectUserId},
          ${input.actor.userId}, ${digest(input.privilegedSessionId)},
          ${input.expectedRequestRevision}, ${input.expectedRequestState},
          ${input.expectedRequestRevision + 1}, ${input.reasonCode},
          ${input.reason}, ${payloadFingerprint}
        ) RETURNING command_id AS "commandId", case_id AS "caseId",
          subject_user_id AS "subjectUserId",
          actor_user_id AS "actorUserId",
          resulting_request_revision AS "requestRevision",
          payload_fingerprint AS "payloadFingerprint",
          occurred_at AS "occurredAt"`;
      if (inserted === undefined)
        throw new Error("Privacy closure effect missing.");
      await createAuditRepository(tx).append({
        action: "admin.privacy.account_deactivated",
        actor: auditActorFromPrivilegedActor(
          input.actor,
          "admin.privacy.manage",
        ),
        category: "PRIVILEGED_COMMAND",
        changes: {
          account_state: { before: "ACTIVE", after: "DEACTIVATED" },
        },
        correlationId: input.commandId,
        eventId: derivedUuid(`privacy-closure-audit:${input.commandId}`),
        reason: input.reason,
        target: { id: input.caseId, type: "PRIVACY_REQUEST" },
      });
      return closureResult(tx, inserted, "APPLIED");
    });
  }

  return Object.freeze({
    executeAccountClosure,
    hasOpenObligations,
    listQueue,
    listForSubject,
    transitionRequest,
  });
}

async function closureResult(
  tx: TransactionSql,
  command: ClosureCommandRow,
  status: "APPLIED" | "DEDUPLICATED",
): Promise<Extract<ExecuteAccountClosureResult, { status: typeof status }>> {
  const rows = await tx<PrivacyDataDisposition[]>`
    SELECT category::text, revision, disposition::text, state::text,
      policy_version_id AS "policyVersionId",
      actor_user_id AS "actorUserId", action_code AS "actionCode",
      occurred_at AS "occurredAt"
    FROM current_privacy_data_dispositions
    WHERE case_id = ${command.caseId}
    ORDER BY category`;
  return Object.freeze({
    commandId: command.commandId,
    dispositions: freezeRows(rows),
    occurredAt: command.occurredAt,
    requestRevision: command.requestRevision,
    requestState: "ACTION_REQUIRED" as const,
    status,
  });
}

function validateClosure(input: ExecuteAccountClosureInput): void {
  id(input.caseId);
  id(input.commandId);
  id(input.subjectUserId);
  id(input.actor.userId);
  if (
    typeof input.privilegedSessionId !== "string" ||
    input.privilegedSessionId.length < 16 ||
    input.privilegedSessionId.length > 512
  )
    throw new TypeError("Invalid privileged session identity.");
  if (
    !Number.isSafeInteger(input.expectedRequestRevision) ||
    input.expectedRequestRevision < 1 ||
    input.expectedRequestState !== "IN_REVIEW"
  )
    throw new TypeError("Invalid privacy-request state.");
  if (!reasonCode.test(input.reasonCode))
    throw new TypeError("Invalid privacy closure reason code.");
  if (
    input.reason.trim() !== input.reason ||
    input.reason.length < 8 ||
    input.reason.length > 500 ||
    control.test(input.reason) ||
    unsafeReason.test(input.reason)
  )
    throw new TypeError("Invalid privacy closure reason.");
}

function validateTransition(input: TransitionPrivacyRequestInput): void {
  validateAdmin(input.actor, input.privilegedSessionId);
  id(input.caseId);
  id(input.commandId);
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 1 ||
    !reasonCode.test(input.actionCode) ||
    (input.deadlineAt !== null &&
      (!(input.deadlineAt instanceof Date) ||
        !Number.isFinite(input.deadlineAt.valueOf())))
  )
    throw new TypeError("Invalid privacy-request transition.");
  safeReason(input.reason);
}

function validateAdmin(actor: PrivilegedActor, sessionId: string): void {
  id(actor.userId);
  auditActorFromPrivilegedActor(actor, "admin.privacy.manage");
  if (sessionId.length < 16 || sessionId.length > 512)
    throw new TypeError("Invalid privileged session identity.");
}

async function requireRecentSession(
  tx: TransactionSql,
  actor: PrivilegedActor,
  sessionId: string,
): Promise<void> {
  const [row] = await tx<Array<{ readonly allowed: boolean }>>`
    SELECT privacy_admin_session_is_recent(
      ${digest(sessionId)}::char(64), ${actor.userId}::uuid
    ) AS allowed`;
  if (row?.allowed !== true) throw new Error("Privileged access denied.");
}

function safeReason(value: string): void {
  if (
    value.trim() !== value ||
    value.length < 8 ||
    value.length > 500 ||
    control.test(value) ||
    unsafeReason.test(value)
  )
    throw new TypeError("Invalid privacy reason.");
}

function id(value: string): void {
  if (!uuid.test(value)) throw new TypeError("Invalid identity.");
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
