import { createHash } from "node:crypto";

import type { Sql, TransactionSql } from "postgres";

type RootSql = Sql | TransactionSql;
type JobState =
  | "CONFIRMED"
  | "IN_PROGRESS"
  | "COMPLETION_REQUESTED"
  | "COMPLETED"
  | "CANCELLED";
type DecisionKind = "ACCEPT" | "REJECT" | "WITHDRAW";
export type JobCompletionRejectionCategory =
  "UNFINISHED_SCOPE" | "DEFECT" | "MISSING_OUTPUT" | "OTHER";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface RequestJobCompletionInput {
  readonly actorUserId: string;
  readonly commandId: string;
  readonly jobId: string;
  readonly note?: string | null;
  readonly physicalWorkFinishedOn?: string | null;
  readonly finalMediaAssetIds?: readonly string[];
}

export interface DecideJobCompletionInput {
  readonly actorUserId: string;
  readonly commandId: string;
  readonly jobId: string;
  readonly attemptId: string;
}

export interface RejectJobCompletionInput extends DecideJobCompletionInput {
  readonly category: JobCompletionRejectionCategory;
  readonly reason: string;
  readonly evidenceMediaAssetIds?: readonly string[];
}

export interface WithdrawJobCompletionInput extends DecideJobCompletionInput {
  readonly reason: string;
}

export interface JobCompletionAttempt {
  readonly id: string;
  readonly attemptNumber: number;
  readonly requestedAt: Date;
  readonly requestedByUserId: string;
  readonly note: string | null;
  readonly physicalWorkFinishedOn: string | null;
  readonly finalMediaAssetIds: readonly string[];
  readonly outcome: "PENDING" | "ACCEPTED" | "REJECTED" | "WITHDRAWN";
  readonly decidedAt: Date | null;
  readonly decidedByUserId: string | null;
  readonly rejectionCategory: JobCompletionRejectionCategory | null;
  readonly rejectionReason: string | null;
  readonly objectionMediaAssetIds: readonly string[];
}

export interface JobCompletionHistory {
  readonly jobState: JobState;
  readonly attempts: readonly JobCompletionAttempt[];
}

export type JobCompletionResult =
  | Readonly<{
      status: "APPLIED" | "DEDUPLICATED";
      jobState: "IN_PROGRESS" | "COMPLETION_REQUESTED" | "COMPLETED";
      attemptId: string;
      recordedAt: Date;
    }>
  | Readonly<{ status: "NOT_FOUND" | "STALE_STATE" | "STALE_ATTEMPT" }>;

export class JobCompletionIdempotencyError extends Error {}

interface ExistingCommand {
  readonly actorUserId: string;
  readonly attemptId: string;
  readonly commandKind: "REQUEST" | DecisionKind;
  readonly jobId: string;
  readonly payloadFingerprint: string;
  readonly recordedAt: Date;
}

interface HistoryRow {
  readonly id: string;
  readonly attemptNumber: number;
  readonly requestedAt: Date;
  readonly requestedByUserId: string;
  readonly note: string | null;
  readonly physicalWorkFinishedOn: string | null;
  readonly finalMediaAssetIds: string[];
  readonly decisionKind: DecisionKind | null;
  readonly decidedAt: Date | null;
  readonly decidedByUserId: string | null;
  readonly rejectionCategory: JobCompletionRejectionCategory | null;
  readonly rejectionReason: string | null;
  readonly objectionMediaAssetIds: string[] | null;
}

export function createJobCompletionRepository(sql: RootSql) {
  async function request(
    input: RequestJobCompletionInput,
  ): Promise<JobCompletionResult> {
    validateIdentity(input);
    const note = optionalText(input.note, 1, 1000);
    const physicalWorkFinishedOn = input.physicalWorkFinishedOn ?? null;
    if (physicalWorkFinishedOn !== null && !validDate(physicalWorkFinishedOn))
      throw new TypeError("Invalid physical work-finished date.");
    const finalMediaAssetIds = mediaIds(input.finalMediaAssetIds);
    const fingerprint = hash({
      kind: "REQUEST",
      jobId: input.jobId,
      actorUserId: input.actorUserId,
      note,
      physicalWorkFinishedOn,
      finalMediaAssetIds,
    });
    return transaction(sql, async (tx) => {
      const authorized = await lockOwnedJob(
        tx,
        input.jobId,
        input.actorUserId,
        "PRIMARY_PROVIDER",
      );
      if (!authorized) return { status: "NOT_FOUND" };
      const existing = await existingCommand(tx, input.commandId);
      if (existing)
        return replay(
          existing,
          input,
          "REQUEST",
          fingerprint,
          "COMPLETION_REQUESTED",
        );
      const current = await jobState(tx, input.jobId);
      if (current !== "IN_PROGRESS") return { status: "STALE_STATE" };
      const [{ nextNumber } = { nextNumber: 1 }] = await tx<
        Array<{ nextNumber: number }>
      >`
        SELECT (coalesce(max(attempt_number), 0) + 1)::integer AS "nextNumber"
        FROM job_completion_attempts WHERE job_id = ${input.jobId}
      `;
      const [inserted] = await tx<Array<{ recordedAt: Date }>>`
        INSERT INTO job_completion_attempts (
          id, job_id, attempt_number, requested_by_user_id, note,
          physical_work_finished_on, final_media_asset_ids, payload_fingerprint
        ) VALUES (${input.commandId}, ${input.jobId}, ${nextNumber},
          ${input.actorUserId}, ${note}, ${physicalWorkFinishedOn},
          ${[...finalMediaAssetIds]}::uuid[], ${fingerprint})
        RETURNING requested_at AS "recordedAt"
      `;
      if (!inserted) throw new Error("Completion attempt effect missing.");
      return Object.freeze({
        status: "APPLIED" as const,
        jobState: "COMPLETION_REQUESTED" as const,
        attemptId: input.commandId,
        recordedAt: inserted.recordedAt,
      });
    });
  }

  async function decide(
    kind: DecisionKind,
    input:
      | DecideJobCompletionInput
      | RejectJobCompletionInput
      | WithdrawJobCompletionInput,
  ): Promise<JobCompletionResult> {
    validateIdentity(input);
    if (!uuid.test(input.attemptId))
      throw new TypeError("Invalid completion attempt ID.");
    const category =
      kind === "REJECT" ? (input as RejectJobCompletionInput).category : null;
    const reason =
      kind === "ACCEPT"
        ? null
        : requiredText(
            (input as RejectJobCompletionInput | WithdrawJobCompletionInput)
              .reason,
            8,
            1000,
          );
    const evidenceMediaAssetIds =
      kind === "REJECT"
        ? mediaIds((input as RejectJobCompletionInput).evidenceMediaAssetIds)
        : [];
    if (
      kind === "REJECT" &&
      !["UNFINISHED_SCOPE", "DEFECT", "MISSING_OUTPUT", "OTHER"].includes(
        category ?? "",
      )
    )
      throw new TypeError("Invalid completion objection category.");
    const fingerprint = hash({
      kind,
      jobId: input.jobId,
      actorUserId: input.actorUserId,
      attemptId: input.attemptId,
      category,
      reason,
      evidenceMediaAssetIds,
    });
    return transaction(sql, async (tx) => {
      const authorized = await lockOwnedJob(
        tx,
        input.jobId,
        input.actorUserId,
        kind === "WITHDRAW" ? "PRIMARY_PROVIDER" : "CUSTOMER",
      );
      if (!authorized) return { status: "NOT_FOUND" };
      const existing = await existingCommand(tx, input.commandId);
      if (existing)
        return replay(
          existing,
          input,
          kind,
          fingerprint,
          kind === "ACCEPT" ? "COMPLETED" : "IN_PROGRESS",
        );
      const current = await jobState(tx, input.jobId);
      if (current !== "COMPLETION_REQUESTED") return { status: "STALE_STATE" };
      const [pending] = await tx<Array<{ id: string }>>`
        SELECT id FROM job_completion_attempts
        WHERE job_id = ${input.jobId} ORDER BY attempt_number DESC LIMIT 1
      `;
      if (!pending || pending.id !== input.attemptId)
        return { status: "STALE_ATTEMPT" };
      const [inserted] = await tx<Array<{ recordedAt: Date }>>`
        INSERT INTO job_completion_decisions (
          id, attempt_id, kind, actor_user_id, rejection_category,
          reason, evidence_media_asset_ids, payload_fingerprint
        ) VALUES (${input.commandId}, ${input.attemptId}, ${kind},
          ${input.actorUserId}, ${category}, ${reason},
          ${[...evidenceMediaAssetIds]}::uuid[], ${fingerprint})
        RETURNING decided_at AS "recordedAt"
      `;
      if (!inserted) throw new Error("Completion decision effect missing.");
      return Object.freeze({
        status: "APPLIED" as const,
        jobState:
          kind === "ACCEPT" ? ("COMPLETED" as const) : ("IN_PROGRESS" as const),
        attemptId: input.attemptId,
        recordedAt: inserted.recordedAt,
      });
    });
  }

  async function list(input: {
    readonly actorUserId: string;
    readonly jobId: string;
  }): Promise<JobCompletionHistory | null> {
    validateIdentity(input);
    return transaction(sql, async (tx) => {
      const authorized = await lockOwnedJob(
        tx,
        input.jobId,
        input.actorUserId,
        "EITHER",
        false,
      );
      if (!authorized) return null;
      const state = await jobState(tx, input.jobId);
      if (!state) return null;
      const rows = await tx<HistoryRow[]>`
        SELECT attempt.id, attempt.attempt_number AS "attemptNumber",
          attempt.requested_at AS "requestedAt",
          attempt.requested_by_user_id AS "requestedByUserId",
          attempt.note, attempt.physical_work_finished_on::text AS "physicalWorkFinishedOn",
          attempt.final_media_asset_ids AS "finalMediaAssetIds",
          decision.kind::text AS "decisionKind",
          decision.decided_at AS "decidedAt",
          decision.actor_user_id AS "decidedByUserId",
          decision.rejection_category::text AS "rejectionCategory",
          decision.reason AS "rejectionReason",
          decision.evidence_media_asset_ids AS "objectionMediaAssetIds"
        FROM job_completion_attempts attempt
        LEFT JOIN job_completion_decisions decision ON decision.attempt_id = attempt.id
        WHERE attempt.job_id = ${input.jobId}
        ORDER BY attempt.attempt_number DESC
      `;
      return Object.freeze({
        jobState: state,
        attempts: Object.freeze(
          rows.map((row) =>
            Object.freeze({
              id: row.id,
              attemptNumber: row.attemptNumber,
              requestedAt: row.requestedAt,
              requestedByUserId: row.requestedByUserId,
              note: row.note,
              physicalWorkFinishedOn: row.physicalWorkFinishedOn,
              finalMediaAssetIds: Object.freeze(row.finalMediaAssetIds),
              outcome:
                row.decisionKind === "ACCEPT"
                  ? ("ACCEPTED" as const)
                  : row.decisionKind === "REJECT"
                    ? ("REJECTED" as const)
                    : row.decisionKind === "WITHDRAW"
                      ? ("WITHDRAWN" as const)
                      : ("PENDING" as const),
              decidedAt: row.decidedAt,
              decidedByUserId: row.decidedByUserId,
              rejectionCategory: row.rejectionCategory,
              rejectionReason: row.rejectionReason,
              objectionMediaAssetIds: Object.freeze(
                row.objectionMediaAssetIds ?? [],
              ),
            }),
          ),
        ),
      });
    });
  }

  return Object.freeze({
    request,
    accept: (input: DecideJobCompletionInput) => decide("ACCEPT", input),
    reject: (input: RejectJobCompletionInput) => decide("REJECT", input),
    withdraw: (input: WithdrawJobCompletionInput) => decide("WITHDRAW", input),
    list,
  });
}

export type JobCompletionRepository = ReturnType<
  typeof createJobCompletionRepository
>;

function validateIdentity(input: {
  readonly actorUserId: string;
  readonly jobId: string;
  readonly commandId?: string;
}): void {
  if (
    !uuid.test(input.actorUserId) ||
    !uuid.test(input.jobId) ||
    (input.commandId !== undefined && !uuid.test(input.commandId))
  )
    throw new TypeError("Invalid Job completion identity.");
}

function requiredText(value: unknown, min: number, max: number): string {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length < min ||
    value.length > max ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  )
    throw new TypeError("Invalid Job completion text.");
  return value;
}

function optionalText(value: unknown, min: number, max: number): string | null {
  return value === undefined || value === null
    ? null
    : requiredText(value, min, max);
}

function mediaIds(value: readonly string[] | undefined): readonly string[] {
  const ids = value ?? [];
  if (
    !Array.isArray(ids) ||
    ids.length > 10 ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => typeof id !== "string" || !uuid.test(id))
  )
    throw new TypeError("Invalid completion media references.");
  return (ids as readonly string[]).slice();
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function lockOwnedJob(
  tx: TransactionSql,
  jobId: string,
  actorUserId: string,
  role: "CUSTOMER" | "PRIMARY_PROVIDER" | "EITHER",
  lock = true,
): Promise<boolean> {
  const rows = await tx<Array<{ id: string }>>`
    SELECT job.id FROM jobs job
    JOIN customer_profiles customer ON customer.id = job.customer_profile_id
    JOIN craftsman_profiles provider ON provider.id = job.primary_craftsman_profile_id
    JOIN job_acceptance_events accepted ON accepted.job_id = job.id
    JOIN job_agreement_snapshots snapshot ON snapshot.job_id = job.id
    JOIN users actor ON actor.id = ${actorUserId} AND actor.account_state = 'ACTIVE'
    JOIN auth_credentials auth ON auth.user_id = actor.id
      AND auth.email_verified_at IS NOT NULL AND auth.phone_verified_at IS NOT NULL
    WHERE job.id = ${jobId}
      AND ((${role} IN ('CUSTOMER', 'EITHER') AND customer.owner_user_id = actor.id)
        OR (${role} IN ('PRIMARY_PROVIDER', 'EITHER') AND provider.owner_user_id = actor.id))
  `;
  if (!rows[0]) return false;
  if (lock) await tx`SELECT id FROM jobs WHERE id = ${jobId} FOR UPDATE`;
  else await tx`SELECT id FROM jobs WHERE id = ${jobId} FOR SHARE`;
  return true;
}

async function jobState(
  tx: TransactionSql,
  jobId: string,
): Promise<JobState | null> {
  const [row] = await tx<Array<{ state: JobState }>>`
    SELECT state::text FROM current_job_states WHERE job_id = ${jobId}
  `;
  return row?.state ?? null;
}

async function existingCommand(
  tx: TransactionSql,
  commandId: string,
): Promise<ExistingCommand | undefined> {
  const [row] = await tx<ExistingCommand[]>`
    SELECT attempt.job_id AS "jobId", attempt.id AS "attemptId",
      attempt.requested_by_user_id AS "actorUserId",
      'REQUEST'::text AS "commandKind",
      attempt.payload_fingerprint AS "payloadFingerprint",
      attempt.requested_at AS "recordedAt"
    FROM job_completion_attempts attempt WHERE attempt.id = ${commandId}
    UNION ALL
    SELECT attempt.job_id, decision.attempt_id, decision.actor_user_id,
      decision.kind::text, decision.payload_fingerprint, decision.decided_at
    FROM job_completion_decisions decision
    JOIN job_completion_attempts attempt ON attempt.id = decision.attempt_id
    WHERE decision.id = ${commandId}
  `;
  return row;
}

function replay(
  existing: ExistingCommand,
  input: {
    readonly actorUserId: string;
    readonly jobId: string;
    readonly attemptId?: string;
  },
  kind: "REQUEST" | DecisionKind,
  fingerprint: string,
  state: "IN_PROGRESS" | "COMPLETION_REQUESTED" | "COMPLETED",
): JobCompletionResult {
  if (existing.actorUserId !== input.actorUserId)
    return { status: "NOT_FOUND" };
  if (
    existing.jobId !== input.jobId ||
    existing.commandKind !== kind ||
    existing.payloadFingerprint !== fingerprint ||
    (input.attemptId !== undefined && existing.attemptId !== input.attemptId)
  )
    throw new JobCompletionIdempotencyError(
      "Completion command ID reused for another intent.",
    );
  return Object.freeze({
    status: "DEDUPLICATED",
    jobState: state,
    attemptId: existing.attemptId,
    recordedAt: existing.recordedAt,
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
