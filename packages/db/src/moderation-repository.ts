import { createHash } from "node:crypto";

import type { PrivilegedActor } from "@portal/admin-auth";
import { auditActorFromPrivilegedActor } from "@portal/audit";
import type { Sql, TransactionSql } from "postgres";

import { createAuditRepository } from "./audit-repository.js";

type RootSql = Sql | TransactionSql;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const code = /^[A-Z][A-Z0-9_.:-]{2,95}$/u;
const policyVersion = /^[A-Z0-9][A-Z0-9_.:-]{0,63}$/u;
const evidenceType = /^[A-Z][A-Z0-9_]{1,63}$/u;
const control = /[\p{Cc}]/u;
const unsafeReason =
  /(?:[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|https?:\/\/|bearer\s+\S+|(?:\+?\d[\d ().-]{6,}\d))/iu;

export type ModerationReportState =
  "OPEN" | "UNDER_REVIEW" | "ACTIONED" | "NO_VIOLATION" | "CLOSED";
export type ModerationEnforcementScope =
  "CONTENT" | "MESSAGING" | "PUBLISHING" | "QUOTING" | "REVIEWS" | "ACCOUNT";
export type ModerationEffectAction =
  | "APPLY_WARNING"
  | "HIDE_CONTENT"
  | "EXCLUDE_REVIEW_EVIDENCE"
  | "APPLY_FEATURE_RESTRICTION"
  | "APPLY_TEMPORARY_SUSPENSION"
  | "APPLY_INDEFINITE_SUSPENSION";
export type ModerationAppealDecision = "UPHOLD" | "REDUCE" | "REVERSE";

interface AdminBase {
  readonly actor: PrivilegedActor;
  readonly privilegedSessionId: string;
  readonly commandId: string;
  readonly reportId: string;
  readonly expectedState: ModerationReportState;
  readonly reason: string;
}
export type ModerationAdminCommand =
  | (AdminBase & { readonly action: "START_REVIEW" | "CLOSE" | "REOPEN" })
  | (AdminBase & {
      readonly action: "FIND_NO_VIOLATION";
      readonly policyCategory: string;
      readonly policyReasonCode: string;
      readonly policyVersion: string;
      readonly privateAdminNote?: string | null;
    })
  | (AdminBase & {
      readonly action: ModerationEffectAction;
      readonly policyCategory: string;
      readonly policyReasonCode: string;
      readonly policyVersion: string;
      readonly privateAdminNote?: string | null;
      readonly subjectUserId: string;
      readonly enforcementScope: ModerationEnforcementScope;
      readonly restrictionExpiresAt?: Date | null;
      readonly userFacingReason: string;
      readonly priorState: Readonly<
        Record<string, boolean | number | string | null>
      >;
    });

export type ModerationCommandResult =
  | Readonly<{
      status: "APPLIED" | "DEDUPLICATED";
      commandId: string;
      reportId: string;
      state: ModerationReportState;
      recordedAt: Date;
    }>
  | Readonly<{ status: "NOT_FOUND" | "STALE_STATE" }>;

export interface ModerationQueueItem {
  readonly reportId: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly reason: string;
  readonly state: ModerationReportState;
  readonly reportedAt: Date;
  readonly stateRecordedAt: Date;
}
export interface ModerationReportDetail extends ModerationQueueItem {
  readonly reporterUserId: string;
  readonly details: string | null;
  readonly evidenceReferenceType: string | null;
  readonly evidenceReferenceId: string | null;
  readonly actions: readonly Readonly<{
    actionId: string;
    action: ModerationEffectAction;
    subjectUserId: string;
    enforcementScope: ModerationEnforcementScope;
    restrictionExpiresAt: Date | null;
    policyCategory: string;
    policyReasonCode: string;
    policyVersion: string;
    userFacingReason: string;
    appliedAt: Date;
    active: boolean;
  }>[];
}

export interface ModerationUserAction {
  readonly actionId: string;
  readonly action: ModerationEffectAction;
  readonly targetType: string;
  readonly targetId: string;
  readonly enforcementScope: ModerationEnforcementScope;
  readonly restrictionExpiresAt: Date | null;
  readonly policyCategory: string;
  readonly userFacingReason: string;
  readonly appliedAt: Date;
  readonly active: boolean;
  readonly appealId: string | null;
  readonly appealState: "OPEN" | "UPHELD" | "REDUCED" | "REVERSED" | null;
}

export interface ModerationAppealQueueItem {
  readonly appealId: string;
  readonly actionId: string;
  readonly action: ModerationEffectAction;
  readonly targetType: string;
  readonly targetId: string;
  readonly state: "OPEN" | "UPHELD" | "REDUCED" | "REVERSED";
  readonly submittedAt: Date;
}

export interface ModerationAppealDetail extends ModerationAppealQueueItem {
  readonly appellantUserId: string;
  readonly explanation: string;
  readonly evidenceReferenceType: string | null;
  readonly evidenceReferenceId: string | null;
}

export interface SubmitModerationAppealInput {
  readonly actorUserId: string;
  readonly appealId: string;
  readonly actionId: string;
  readonly explanation: string;
  readonly evidenceReferenceType?: string | null;
  readonly evidenceReferenceId?: string | null;
}
export type SubmitModerationAppealResult =
  | Readonly<{
      status: "APPLIED" | "DEDUPLICATED";
      appealId: string;
      state: "OPEN";
      submittedAt: Date;
    }>
  | Readonly<{ status: "NOT_FOUND" | "ALREADY_APPEALED" }>;

export interface DecideModerationAppealInput {
  readonly actor: PrivilegedActor;
  readonly privilegedSessionId: string;
  readonly commandId: string;
  readonly appealId: string;
  readonly expectedState: "OPEN";
  readonly decision: ModerationAppealDecision;
  readonly reason: string;
  readonly policyReasonCode: string;
  readonly policyVersion: string;
  readonly privateAdminNote?: string | null;
  readonly reducedScope?: ModerationEnforcementScope | null;
  readonly reducedExpiresAt?: Date | null;
  readonly userFacingReason: string;
}
export type DecideModerationAppealResult =
  | Readonly<{
      status: "APPLIED" | "DEDUPLICATED";
      commandId: string;
      appealId: string;
      state: "UPHELD" | "REDUCED" | "REVERSED";
      recordedAt: Date;
    }>
  | Readonly<{ status: "NOT_FOUND" | "STALE_STATE" }>;

export class ModerationIdempotencyError extends Error {}
export class ModerationAppealIdempotencyError extends Error {}

export function createModerationRepository(sql: RootSql) {
  async function execute(
    input: ModerationAdminCommand,
  ): Promise<ModerationCommandResult> {
    validateAdminCommand(input);
    auditActorFromPrivilegedActor(input.actor, "admin.reviews.moderate");
    const details = adminDetails(input);
    const fingerprint = digest(JSON.stringify(normalizeAdmin(input, details)));
    return transaction(sql, async (tx) => {
      await commandLock(tx, input.commandId, 524_023);
      const [existing] = await tx<
        Array<{
          actorUserId: string;
          reportId: string;
          payloadFingerprint: string;
          state: ModerationReportState;
          recordedAt: Date;
        }>
      >`
        SELECT command.actor_user_id AS "actorUserId",
          command.report_id AS "reportId",
          command.payload_fingerprint AS "payloadFingerprint",
          command.resulting_state::text AS state,
          command.recorded_at AS "recordedAt"
        FROM moderation_admin_commands command
        WHERE command.command_id = ${input.commandId}`;
      if (existing !== undefined) {
        if (existing.actorUserId !== input.actor.userId)
          return { status: "NOT_FOUND" };
        if (
          existing.reportId !== input.reportId ||
          existing.payloadFingerprint !== fingerprint
        )
          throw new ModerationIdempotencyError(
            "Moderation command ID was reused for another intent.",
          );
        return Object.freeze({
          status: "DEDUPLICATED" as const,
          commandId: input.commandId,
          reportId: input.reportId,
          state: existing.state,
          recordedAt: existing.recordedAt,
        });
      }
      const [current] = await tx<Array<{ state: ModerationReportState }>>`
        SELECT state::text FROM current_moderation_report_states
        WHERE report_id = ${input.reportId}`;
      if (current === undefined) return { status: "NOT_FOUND" };
      if (current.state !== input.expectedState)
        return { status: "STALE_STATE" };

      const auditEventId = derivedUuid(`moderation-audit:${input.commandId}`);
      const priorState =
        details.priorState === null ? null : tx.json(details.priorState);
      const [stored] = await tx<
        Array<{ state: ModerationReportState; recordedAt: Date }>
      >`
        INSERT INTO moderation_admin_commands (
          command_id, report_id, action, actor_user_id,
          actor_privileged_session_hash, expected_state, reason,
          policy_category, policy_reason_code, policy_version,
          private_admin_note, subject_user_id, enforcement_scope,
          restriction_expires_at, user_facing_reason, prior_state,
          payload_fingerprint, audit_event_id
        ) VALUES (
          ${input.commandId}, ${input.reportId}, ${input.action},
          ${input.actor.userId}, ${digest(input.privilegedSessionId)},
          ${input.expectedState}, ${input.reason}, ${details.policyCategory},
          ${details.policyReasonCode}, ${details.policyVersion},
          ${details.privateAdminNote}, ${details.subjectUserId},
          ${details.enforcementScope}, ${details.restrictionExpiresAt},
          ${details.userFacingReason}, ${priorState},
          ${fingerprint}, ${auditEventId}
        ) RETURNING resulting_state::text AS state,
          recorded_at AS "recordedAt"`;
      if (stored === undefined)
        throw new Error("Moderation command effect missing.");
      await createAuditRepository(tx).append({
        action: auditAction(input.action),
        actor: auditActorFromPrivilegedActor(
          input.actor,
          "admin.reviews.moderate",
        ),
        category: "PRIVILEGED_COMMAND",
        changes: auditChanges(input.action),
        correlationId: input.commandId,
        eventId: auditEventId,
        reason: input.reason,
        target: { id: input.reportId, type: "MODERATION_REPORT" },
      });
      return Object.freeze({
        status: "APPLIED" as const,
        commandId: input.commandId,
        reportId: input.reportId,
        state: stored.state,
        recordedAt: stored.recordedAt,
      });
    });
  }

  async function listQueue(input: {
    actor: PrivilegedActor;
    privilegedSessionId: string;
    state?: ModerationReportState;
    limit?: number;
  }): Promise<readonly ModerationQueueItem[]> {
    validateAdmin(input.actor, input.privilegedSessionId);
    if (input.state !== undefined && !reportStates.has(input.state))
      throw new TypeError("Invalid moderation queue state.");
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new TypeError("Invalid moderation queue limit.");
    return transaction(sql, async (tx) => {
      await requireRecentSession(tx, input.actor, input.privilegedSessionId);
      const rows = await tx<ModerationQueueItem[]>`
        SELECT report_id AS "reportId", target_type::text AS "targetType",
          target_id AS "targetId", reason::text, state::text,
          reported_at AS "reportedAt", state_recorded_at AS "stateRecordedAt"
        FROM current_moderation_report_states
        WHERE (${input.state ?? null}::text IS NULL
          OR state::text = ${input.state ?? null}::text)
        ORDER BY CASE state
          WHEN 'OPEN' THEN 1 WHEN 'UNDER_REVIEW' THEN 2
          WHEN 'ACTIONED' THEN 3 WHEN 'NO_VIOLATION' THEN 4 ELSE 5 END,
          reported_at, report_id
        LIMIT ${limit}`;
      return freezeRows(rows);
    });
  }

  async function getReport(input: {
    actor: PrivilegedActor;
    privilegedSessionId: string;
    reportId: string;
    accessId: string;
    reason: string;
  }): Promise<ModerationReportDetail | null> {
    validateAdmin(input.actor, input.privilegedSessionId);
    ids(input.reportId, input.accessId);
    safeReason(input.reason);
    return transaction(sql, async (tx) => {
      await requireRecentSession(tx, input.actor, input.privilegedSessionId);
      const [row] = await tx<Array<Omit<ModerationReportDetail, "actions">>>`
        SELECT report_id AS "reportId", reporter_user_id AS "reporterUserId",
          target_type::text AS "targetType", target_id AS "targetId",
          reason::text, details,
          evidence_reference_type AS "evidenceReferenceType",
          evidence_reference_id AS "evidenceReferenceId",
          state::text, reported_at AS "reportedAt",
          state_recorded_at AS "stateRecordedAt"
        FROM current_moderation_report_states
        WHERE report_id = ${input.reportId}`;
      if (row === undefined) return null;
      await createAuditRepository(tx).append({
        action: "admin.moderation.report_detail_accessed",
        actor: auditActorFromPrivilegedActor(
          input.actor,
          "admin.reviews.moderate",
        ),
        category: "SENSITIVE_ACCESS",
        changes: {},
        context: { id: input.reportId, type: "MODERATION_REPORT" },
        correlationId: input.accessId,
        eventId: input.accessId,
        reason: input.reason,
        sensitiveAccessPurpose: "MODERATION_REVIEW",
        target: { id: row.targetId, type: row.targetType },
      });
      const actions = await tx<ModerationReportDetail["actions"]>`
        SELECT action_id AS "actionId", action::text, subject_user_id AS "subjectUserId",
          enforcement_scope::text AS "enforcementScope",
          restriction_expires_at AS "restrictionExpiresAt",
          policy_category AS "policyCategory",
          policy_reason_code AS "policyReasonCode",
          policy_version AS "policyVersion",
          user_facing_reason AS "userFacingReason",
          applied_at AS "appliedAt", active
        FROM current_moderation_actions
        WHERE report_id = ${input.reportId}
        ORDER BY applied_at, action_id`;
      return Object.freeze({ ...row, actions: freezeRows(actions) });
    });
  }

  async function listMyActions(
    actorUserId: string,
  ): Promise<readonly ModerationUserAction[]> {
    ids(actorUserId);
    const rows = await sql<ModerationUserAction[]>`
      SELECT action.action_id AS "actionId", action.action::text,
        action.target_type::text AS "targetType", action.target_id AS "targetId",
        action.enforcement_scope::text AS "enforcementScope",
        action.restriction_expires_at AS "restrictionExpiresAt",
        action.policy_category AS "policyCategory",
        action.user_facing_reason AS "userFacingReason",
        action.applied_at AS "appliedAt", action.active,
        appeal.appeal_id AS "appealId", appeal.state::text AS "appealState"
      FROM current_moderation_actions action
      LEFT JOIN LATERAL (
        SELECT candidate.appeal_id, candidate.state
        FROM current_moderation_appeal_states candidate
        WHERE candidate.action_id = action.action_id
          AND candidate.appellant_user_id = ${actorUserId}
        ORDER BY candidate.submitted_at DESC, candidate.appeal_id DESC LIMIT 1
      ) appeal ON true
      WHERE action.subject_user_id = ${actorUserId}
      ORDER BY action.applied_at DESC, action.action_id DESC
      LIMIT 100`;
    return freezeRows(rows);
  }

  async function listAppeals(input: {
    actor: PrivilegedActor;
    privilegedSessionId: string;
    state?: "OPEN" | "UPHELD" | "REDUCED" | "REVERSED";
    limit?: number;
  }): Promise<readonly ModerationAppealQueueItem[]> {
    validateAdmin(input.actor, input.privilegedSessionId);
    if (input.state !== undefined && !appealStates.has(input.state))
      throw new TypeError("Invalid moderation appeal queue state.");
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new TypeError("Invalid moderation appeal queue limit.");
    return transaction(sql, async (tx) => {
      await requireRecentSession(tx, input.actor, input.privilegedSessionId);
      const rows = await tx<ModerationAppealQueueItem[]>`
        SELECT appeal.appeal_id AS "appealId", appeal.action_id AS "actionId",
          action.action::text, action.target_type::text AS "targetType",
          action.target_id AS "targetId", appeal.state::text,
          appeal.submitted_at AS "submittedAt"
        FROM current_moderation_appeal_states appeal
        JOIN current_moderation_actions action
          ON action.action_id = appeal.action_id
        WHERE (${input.state ?? null}::text IS NULL
          OR appeal.state::text = ${input.state ?? null}::text)
        ORDER BY CASE appeal.state WHEN 'OPEN' THEN 1 ELSE 2 END,
          appeal.submitted_at, appeal.appeal_id
        LIMIT ${limit}`;
      return freezeRows(rows);
    });
  }

  async function getAppeal(input: {
    actor: PrivilegedActor;
    privilegedSessionId: string;
    appealId: string;
    accessId: string;
    reason: string;
  }): Promise<ModerationAppealDetail | null> {
    validateAdmin(input.actor, input.privilegedSessionId);
    ids(input.appealId, input.accessId);
    safeReason(input.reason);
    return transaction(sql, async (tx) => {
      await requireRecentSession(tx, input.actor, input.privilegedSessionId);
      const [row] = await tx<ModerationAppealDetail[]>`
        SELECT appeal.appeal_id AS "appealId", appeal.action_id AS "actionId",
          appeal.appellant_user_id AS "appellantUserId", appeal.explanation,
          appeal.evidence_reference_type AS "evidenceReferenceType",
          appeal.evidence_reference_id AS "evidenceReferenceId",
          appeal.state::text, appeal.submitted_at AS "submittedAt",
          action.action::text, action.target_type::text AS "targetType",
          action.target_id AS "targetId"
        FROM current_moderation_appeal_states appeal
        JOIN current_moderation_actions action
          ON action.action_id = appeal.action_id
        WHERE appeal.appeal_id = ${input.appealId}`;
      if (row === undefined) return null;
      await createAuditRepository(tx).append({
        action: "admin.moderation.appeal_detail_accessed",
        actor: auditActorFromPrivilegedActor(
          input.actor,
          "admin.reviews.moderate",
        ),
        category: "SENSITIVE_ACCESS",
        changes: {},
        context: { id: input.appealId, type: "MODERATION_APPEAL" },
        correlationId: input.accessId,
        eventId: input.accessId,
        reason: input.reason,
        sensitiveAccessPurpose: "MODERATION_REVIEW",
        target: { id: row.actionId, type: "MODERATION_ACTION" },
      });
      return Object.freeze(row);
    });
  }

  async function submitAppeal(
    input: SubmitModerationAppealInput,
  ): Promise<SubmitModerationAppealResult> {
    validateAppeal(input);
    const evidence = normalizeEvidence(input);
    return transaction(sql, async (tx) => {
      await commandLock(tx, input.appealId, 524_024);
      const [existing] = await tx<
        Array<{
          actionId: string;
          appellantUserId: string;
          explanation: string;
          evidenceReferenceType: string | null;
          evidenceReferenceId: string | null;
          submittedAt: Date;
        }>
      >`
        SELECT action_id AS "actionId", appellant_user_id AS "appellantUserId",
          explanation, evidence_reference_type AS "evidenceReferenceType",
          evidence_reference_id AS "evidenceReferenceId",
          submitted_at AS "submittedAt"
        FROM moderation_appeals WHERE appeal_id = ${input.appealId}`;
      if (existing !== undefined) {
        if (existing.appellantUserId !== input.actorUserId)
          return { status: "NOT_FOUND" };
        if (
          existing.actionId !== input.actionId ||
          existing.explanation !== input.explanation ||
          existing.evidenceReferenceType !== evidence.type ||
          existing.evidenceReferenceId !== evidence.id
        )
          throw new ModerationAppealIdempotencyError(
            "Moderation appeal ID was reused for another intent.",
          );
        return Object.freeze({
          status: "DEDUPLICATED" as const,
          appealId: input.appealId,
          state: "OPEN" as const,
          submittedAt: existing.submittedAt,
        });
      }
      const [eligible] = await tx<Array<{ eligible: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM moderation_actions action
          WHERE action.action_id = ${input.actionId}
            AND action.subject_user_id = ${input.actorUserId}
        ) AS eligible`;
      if (eligible?.eligible !== true) return { status: "NOT_FOUND" };
      const [duplicate] = await tx<Array<{ appealId: string }>>`
        SELECT appeal_id AS "appealId" FROM moderation_appeals
        WHERE action_id = ${input.actionId}
          AND appellant_user_id = ${input.actorUserId}`;
      if (duplicate !== undefined) return { status: "ALREADY_APPEALED" };
      const [stored] = await tx<Array<{ submittedAt: Date }>>`
        INSERT INTO moderation_appeals (
          appeal_id, action_id, appellant_user_id, explanation,
          evidence_reference_type, evidence_reference_id
        ) VALUES (
          ${input.appealId}, ${input.actionId}, ${input.actorUserId},
          ${input.explanation}, ${evidence.type}, ${evidence.id}
        ) RETURNING submitted_at AS "submittedAt"`;
      if (stored === undefined)
        throw new Error("Moderation appeal effect missing.");
      return Object.freeze({
        status: "APPLIED" as const,
        appealId: input.appealId,
        state: "OPEN" as const,
        submittedAt: stored.submittedAt,
      });
    });
  }

  async function decideAppeal(
    input: DecideModerationAppealInput,
  ): Promise<DecideModerationAppealResult> {
    validateAppealDecision(input);
    auditActorFromPrivilegedActor(input.actor, "admin.reviews.moderate");
    const normalized = normalizeAppealDecision(input);
    const fingerprint = digest(JSON.stringify(normalized));
    return transaction(sql, async (tx) => {
      await commandLock(tx, input.commandId, 524_025);
      const [existing] = await tx<
        Array<{
          actorUserId: string;
          appealId: string;
          decision: ModerationAppealDecision;
          payloadFingerprint: string;
          recordedAt: Date;
        }>
      >`
        SELECT actor_user_id AS "actorUserId", appeal_id AS "appealId",
          decision::text, payload_fingerprint AS "payloadFingerprint",
          recorded_at AS "recordedAt"
        FROM moderation_appeal_admin_commands
        WHERE command_id = ${input.commandId}`;
      if (existing !== undefined) {
        if (existing.actorUserId !== input.actor.userId)
          return { status: "NOT_FOUND" };
        if (
          existing.appealId !== input.appealId ||
          existing.payloadFingerprint !== fingerprint
        )
          throw new ModerationIdempotencyError(
            "Moderation appeal command ID was reused for another intent.",
          );
        return Object.freeze({
          status: "DEDUPLICATED" as const,
          commandId: input.commandId,
          appealId: input.appealId,
          state: appealDecisionState(existing.decision),
          recordedAt: existing.recordedAt,
        });
      }
      const [current] = await tx<Array<{ state: string }>>`
        SELECT state::text FROM current_moderation_appeal_states
        WHERE appeal_id = ${input.appealId}`;
      if (current === undefined) return { status: "NOT_FOUND" };
      if (current.state !== input.expectedState)
        return { status: "STALE_STATE" };
      const auditEventId = derivedUuid(
        `moderation-appeal-audit:${input.commandId}`,
      );
      const [stored] = await tx<Array<{ recordedAt: Date }>>`
        INSERT INTO moderation_appeal_admin_commands (
          command_id, appeal_id, decision, actor_user_id,
          actor_privileged_session_hash, expected_state, reason,
          policy_reason_code, policy_version, private_admin_note,
          reduced_scope, reduced_expires_at, user_facing_reason,
          payload_fingerprint, audit_event_id
        ) VALUES (
          ${input.commandId}, ${input.appealId}, ${input.decision},
          ${input.actor.userId}, ${digest(input.privilegedSessionId)},
          ${input.expectedState}, ${input.reason}, ${input.policyReasonCode},
          ${input.policyVersion}, ${input.privateAdminNote ?? null},
          ${input.reducedScope ?? null}, ${input.reducedExpiresAt ?? null},
          ${input.userFacingReason}, ${fingerprint}, ${auditEventId}
        ) RETURNING recorded_at AS "recordedAt"`;
      if (stored === undefined)
        throw new Error("Moderation appeal decision effect missing.");
      await createAuditRepository(tx).append({
        action: appealAuditAction(input.decision),
        actor: auditActorFromPrivilegedActor(
          input.actor,
          "admin.reviews.moderate",
        ),
        category: "PRIVILEGED_COMMAND",
        changes: {
          restriction_state: {
            before: "ACTIVE",
            after:
              input.decision === "REVERSE"
                ? "REVERSED"
                : input.decision === "REDUCE"
                  ? "REDUCED"
                  : "UPHELD",
          },
        },
        correlationId: input.commandId,
        eventId: auditEventId,
        reason: input.reason,
        target: { id: input.appealId, type: "MODERATION_APPEAL" },
      });
      return Object.freeze({
        status: "APPLIED" as const,
        commandId: input.commandId,
        appealId: input.appealId,
        state: appealDecisionState(input.decision),
        recordedAt: stored.recordedAt,
      });
    });
  }

  return Object.freeze({
    close: bindAction(execute, "CLOSE"),
    decideAppeal,
    excludeReviewEvidence: bindAction(execute, "EXCLUDE_REVIEW_EVIDENCE"),
    findNoViolation: bindAction(execute, "FIND_NO_VIOLATION"),
    getReport,
    getAppeal,
    hideContent: bindAction(execute, "HIDE_CONTENT"),
    restrictFeature: bindAction(execute, "APPLY_FEATURE_RESTRICTION"),
    reopen: bindAction(execute, "REOPEN"),
    startReview: bindAction(execute, "START_REVIEW"),
    submitAppeal,
    suspendIndefinitely: bindAction(execute, "APPLY_INDEFINITE_SUSPENSION"),
    suspendTemporarily: bindAction(execute, "APPLY_TEMPORARY_SUSPENSION"),
    warn: bindAction(execute, "APPLY_WARNING"),
    listQueue,
    listAppeals,
    listMyActions,
  });
}

const reportStates = new Set<ModerationReportState>([
  "OPEN",
  "UNDER_REVIEW",
  "ACTIONED",
  "NO_VIOLATION",
  "CLOSED",
]);
const appealStates = new Set([
  "OPEN",
  "UPHELD",
  "REDUCED",
  "REVERSED",
] as const);

function bindAction<A extends ModerationAdminCommand["action"]>(
  execute: (input: ModerationAdminCommand) => Promise<ModerationCommandResult>,
  action: A,
) {
  return (input: ModerationAdminInputFor<A>) =>
    execute({ ...input, action } as ModerationAdminCommand);
}

type ModerationAdminInputFor<
  A extends ModerationAdminCommand["action"],
  Command extends ModerationAdminCommand = ModerationAdminCommand,
> = Command extends ModerationAdminCommand
  ? A extends Command["action"]
    ? Omit<Command, "action">
    : never
  : never;

function validateAdminCommand(input: ModerationAdminCommand): void {
  validateAdmin(input.actor, input.privilegedSessionId);
  ids(input.commandId, input.reportId);
  if (!reportStates.has(input.expectedState))
    throw new TypeError("Invalid moderation report state.");
  safeReason(input.reason);
  if (isWorkflowAction(input)) return;
  if (!code.test(input.policyCategory) || !code.test(input.policyReasonCode))
    throw new TypeError("Invalid moderation policy code.");
  if (!policyVersion.test(input.policyVersion))
    throw new TypeError("Invalid moderation policy version.");
  optionalText(input.privateAdminNote, 1, 4_000);
  if (input.action === "FIND_NO_VIOLATION") return;
  ids(input.subjectUserId);
  if (!scopes.has(input.enforcementScope))
    throw new TypeError("Invalid moderation enforcement scope.");
  bounded(input.userFacingReason, 8, 1_000);
  validatePriorState(input.priorState);
  if (
    input.restrictionExpiresAt !== undefined &&
    input.restrictionExpiresAt !== null &&
    !validDate(input.restrictionExpiresAt)
  )
    throw new TypeError("Invalid moderation restriction expiry.");
  const expiry = input.restrictionExpiresAt ?? null;
  if (
    ["APPLY_WARNING", "HIDE_CONTENT", "EXCLUDE_REVIEW_EVIDENCE"].includes(
      input.action,
    ) &&
    (input.enforcementScope !== "CONTENT" || expiry !== null)
  )
    throw new TypeError("Invalid content moderation effect shape.");
  if (
    input.action === "APPLY_FEATURE_RESTRICTION" &&
    (input.enforcementScope === "CONTENT" ||
      input.enforcementScope === "ACCOUNT" ||
      expiry !== null)
  )
    throw new TypeError("Invalid feature restriction effect shape.");
  if (
    input.action === "APPLY_TEMPORARY_SUSPENSION" &&
    (input.enforcementScope === "CONTENT" ||
      expiry === null ||
      expiry.getTime() <= Date.now())
  )
    throw new TypeError("Future temporary restriction expiry is required.");
  if (
    input.action === "APPLY_INDEFINITE_SUSPENSION" &&
    (input.enforcementScope !== "ACCOUNT" || expiry !== null)
  )
    throw new TypeError("Invalid indefinite account suspension shape.");
}

const scopes = new Set<ModerationEnforcementScope>([
  "CONTENT",
  "MESSAGING",
  "PUBLISHING",
  "QUOTING",
  "REVIEWS",
  "ACCOUNT",
]);

function validateAdmin(actor: PrivilegedActor, sessionId: string): void {
  auditActorFromPrivilegedActor(actor, "admin.reviews.moderate");
  if (typeof sessionId !== "string" || sessionId.length < 16)
    throw new TypeError("Invalid privileged session.");
}

function validateAppeal(input: SubmitModerationAppealInput): void {
  ids(input.actorUserId, input.appealId, input.actionId);
  bounded(input.explanation, 1, 4_000);
  normalizeEvidence(input);
}

function validateAppealDecision(input: DecideModerationAppealInput): void {
  validateAdmin(input.actor, input.privilegedSessionId);
  ids(input.commandId, input.appealId);
  if (input.expectedState !== "OPEN" || !decisions.has(input.decision))
    throw new TypeError("Invalid moderation appeal decision.");
  safeReason(input.reason);
  if (
    !code.test(input.policyReasonCode) ||
    !policyVersion.test(input.policyVersion)
  )
    throw new TypeError("Invalid moderation appeal policy.");
  optionalText(input.privateAdminNote, 1, 4_000);
  bounded(input.userFacingReason, 8, 1_000);
  if (input.decision === "REDUCE") {
    if (input.reducedScope === undefined || input.reducedScope === null)
      throw new TypeError("Reduced enforcement scope is required.");
    if (!scopes.has(input.reducedScope))
      throw new TypeError("Invalid reduced enforcement scope.");
  } else if (
    (input.reducedScope !== undefined && input.reducedScope !== null) ||
    (input.reducedExpiresAt !== undefined && input.reducedExpiresAt !== null)
  ) {
    throw new TypeError("Only reduction may set reduced enforcement.");
  }
  if (
    input.reducedExpiresAt !== undefined &&
    input.reducedExpiresAt !== null &&
    !validDate(input.reducedExpiresAt)
  )
    throw new TypeError("Invalid reduced restriction expiry.");
}

const decisions = new Set<ModerationAppealDecision>([
  "UPHOLD",
  "REDUCE",
  "REVERSE",
]);

function adminDetails(input: ModerationAdminCommand) {
  if (isWorkflowAction(input)) {
    return {
      policyCategory: null,
      policyReasonCode: null,
      policyVersion: null,
      privateAdminNote: null,
      subjectUserId: null,
      enforcementScope: null,
      restrictionExpiresAt: null,
      userFacingReason: null,
      priorState: null,
    };
  }
  if (input.action === "FIND_NO_VIOLATION") {
    return {
      policyCategory: input.policyCategory,
      policyReasonCode: input.policyReasonCode,
      policyVersion: input.policyVersion,
      privateAdminNote: input.privateAdminNote ?? null,
      subjectUserId: null,
      enforcementScope: null,
      restrictionExpiresAt: null,
      userFacingReason: null,
      priorState: null,
    };
  }
  return {
    policyCategory: input.policyCategory,
    policyReasonCode: input.policyReasonCode,
    policyVersion: input.policyVersion,
    privateAdminNote: input.privateAdminNote ?? null,
    subjectUserId: input.subjectUserId,
    enforcementScope: input.enforcementScope,
    restrictionExpiresAt: input.restrictionExpiresAt ?? null,
    userFacingReason: input.userFacingReason,
    priorState: input.priorState,
  };
}

function isWorkflowAction(
  input: ModerationAdminCommand,
): input is Extract<
  ModerationAdminCommand,
  { action: "START_REVIEW" | "CLOSE" | "REOPEN" }
> {
  return (
    input.action === "START_REVIEW" ||
    input.action === "CLOSE" ||
    input.action === "REOPEN"
  );
}

function normalizeAdmin(
  input: ModerationAdminCommand,
  details: ReturnType<typeof adminDetails>,
) {
  return {
    action: input.action,
    reportId: input.reportId,
    expectedState: input.expectedState,
    reason: input.reason,
    ...details,
  };
}

function normalizeAppealDecision(input: DecideModerationAppealInput) {
  return {
    appealId: input.appealId,
    decision: input.decision,
    expectedState: input.expectedState,
    reason: input.reason,
    policyReasonCode: input.policyReasonCode,
    policyVersion: input.policyVersion,
    privateAdminNote: input.privateAdminNote ?? null,
    reducedScope: input.reducedScope ?? null,
    reducedExpiresAt: input.reducedExpiresAt ?? null,
    userFacingReason: input.userFacingReason,
  };
}

function normalizeEvidence(input: {
  evidenceReferenceType?: string | null;
  evidenceReferenceId?: string | null;
}): { type: string | null; id: string | null } {
  const type = input.evidenceReferenceType ?? null;
  const id = input.evidenceReferenceId ?? null;
  if ((type === null) !== (id === null))
    throw new TypeError("Incomplete evidence reference.");
  if (type !== null && (!evidenceType.test(type) || !uuid.test(id ?? "")))
    throw new TypeError("Invalid evidence reference.");
  return { type, id };
}

function validatePriorState(
  value: Readonly<Record<string, boolean | number | string | null>>,
): void {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError("Invalid moderation prior state.");
  const entries = Object.entries(value);
  if (entries.length > 12)
    throw new TypeError("Moderation prior state is too large.");
  for (const [key, item] of entries) {
    if (!/^[a-z][a-z0-9_]{0,47}$/u.test(key))
      throw new TypeError("Invalid moderation prior state key.");
    if (
      !(
        item === null ||
        typeof item === "boolean" ||
        typeof item === "number"
      ) &&
      !(typeof item === "string" && /^[A-Z0-9_.:-]{1,96}$/u.test(item))
    )
      throw new TypeError("Invalid moderation prior state value.");
  }
}

function auditAction(action: ModerationAdminCommand["action"]): string {
  return {
    START_REVIEW: "admin.moderation.review_started",
    FIND_NO_VIOLATION: "admin.moderation.no_violation_found",
    APPLY_WARNING: "admin.moderation.warning_applied",
    HIDE_CONTENT: "admin.moderation.content_hidden",
    EXCLUDE_REVIEW_EVIDENCE: "admin.moderation.review_evidence_excluded",
    APPLY_FEATURE_RESTRICTION: "admin.moderation.feature_restricted",
    APPLY_TEMPORARY_SUSPENSION: "admin.moderation.temporary_suspension_applied",
    APPLY_INDEFINITE_SUSPENSION:
      "admin.moderation.indefinite_suspension_applied",
    CLOSE: "admin.moderation.report_closed",
    REOPEN: "admin.moderation.report_reopened",
  }[action];
}

function auditChanges(action: ModerationAdminCommand["action"]) {
  if (action === "HIDE_CONTENT")
    return { public_visibility: { before: "VISIBLE", after: "HIDDEN" } };
  if (action === "EXCLUDE_REVIEW_EVIDENCE")
    return { review_visibility: { before: "INCLUDED", after: "EXCLUDED" } };
  if (
    action === "APPLY_FEATURE_RESTRICTION" ||
    action === "APPLY_TEMPORARY_SUSPENSION" ||
    action === "APPLY_INDEFINITE_SUSPENSION"
  )
    return { restriction_state: { before: "ALLOWED", after: "RESTRICTED" } };
  return {};
}

function appealAuditAction(decision: ModerationAppealDecision): string {
  return {
    UPHOLD: "admin.moderation.appeal_upheld",
    REDUCE: "admin.moderation.appeal_reduced",
    REVERSE: "admin.moderation.appeal_reversed",
  }[decision];
}

function appealDecisionState(decision: ModerationAppealDecision) {
  return {
    UPHOLD: "UPHELD" as const,
    REDUCE: "REDUCED" as const,
    REVERSE: "REVERSED" as const,
  }[decision];
}

async function requireRecentSession(
  tx: TransactionSql,
  actor: PrivilegedActor,
  sessionId: string,
): Promise<void> {
  const [row] = await tx<Array<{ allowed: boolean }>>`
    SELECT moderation_admin_session_is_recent(
      ${digest(sessionId)}::char(64), ${actor.userId}::uuid
    ) AS allowed`;
  if (row?.allowed !== true) throw new Error("Privileged access denied.");
}

function safeReason(value: string): string {
  bounded(value, 8, 500);
  if (unsafeReason.test(value)) throw new TypeError("Unsafe audit reason.");
  return value;
}
function optionalText(
  value: string | null | undefined,
  minimum: number,
  maximum: number,
): void {
  if (value !== undefined && value !== null) bounded(value, minimum, maximum);
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
function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}
async function commandLock(
  tx: TransactionSql,
  id: string,
  namespace: number,
): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${id}::text, ${namespace}))`;
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
