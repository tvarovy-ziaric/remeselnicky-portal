import { createHash, randomUUID } from "node:crypto";

import type { UserId } from "@portal/domain";
import {
  RETENTION_CATEGORY_VALUES,
  type RetentionCategory,
} from "@portal/privacy";
import type {
  EnqueueJob,
  EnqueueResult,
  Queue,
  QueueDelivery,
  QueueMetrics,
  RetryJobOptions,
  TerminalJobOptions,
  TerminalJobRecord,
} from "@portal/queue";
import type { Sql, TransactionSql } from "postgres";

export const PRIVACY_DISPOSITION_JOB_NAME =
  "privacy.data-disposition.execute.v1";
export const PRIVACY_DISPOSITION_MAX_ATTEMPTS = 10;

export interface PrivacyDispositionJob {
  readonly caseId: string;
  readonly category: RetentionCategory;
  readonly disposition: "ANONYMIZE" | "DELETE";
  readonly policyVersionId: string;
  readonly sourceDispositionEventId: string;
  readonly subjectUserId: UserId;
  readonly tombstoneId: string;
}

export interface PendingPrivacyRecoveryTombstone extends PrivacyDispositionJob {
  readonly createdAt: Date;
}

export interface PrivacyRecoveryTombstoneStore {
  acknowledge(input: {
    readonly ledgerCode: string;
    readonly receipt: string;
    readonly tombstoneId: string;
  }): Promise<"ACKNOWLEDGED" | "DEDUPLICATED" | "NOT_FOUND">;
  listPending(
    limit?: number,
  ): Promise<readonly PendingPrivacyRecoveryTombstone[]>;
}

interface JobRow extends PrivacyDispositionJob {
  readonly attempt: number;
  readonly availableAt: Date;
  readonly enqueuedAt: Date;
  readonly jobId: string;
  readonly maxAttempts: number;
}

interface ExistingJobRow extends PrivacyDispositionJob {
  readonly jobId: string;
  readonly maxAttempts: number;
}

interface MutationRow extends PrivacyDispositionJob {
  readonly jobId: string;
}

interface SnapshotRow {
  readonly depth: number;
  readonly failedAttempts: number;
  readonly inFlight: number;
  readonly oldestInFlightAgeMs: number | null;
  readonly oldestPendingAgeMs: number | null;
  readonly retriesScheduled: number;
  readonly succeeded: number;
  readonly terminalFailures: number;
}

interface TerminalRow {
  readonly attempts: number;
  readonly caseId: string;
  readonly errorCode: string;
  readonly failedAt: Date;
  readonly jobId: string;
  readonly reason: "NON_RETRYABLE" | "RETRIES_EXHAUSTED";
  readonly runId: string;
  readonly sourceDispositionEventId: string;
}

interface ReceiptRow {
  readonly ledgerCode: string;
  readonly receiptDigest: string;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const errorCodePattern = /^[A-Z][A-Z0-9_.-]{0,63}$/u;
const runIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const ledgerCodePattern = /^[a-z][a-z0-9.-]{1,63}$/u;

export function createPrivacyRecoveryTombstoneStore(
  sql: Sql,
): PrivacyRecoveryTombstoneStore {
  return Object.freeze({
    async acknowledge(input) {
      assertUuid(input.tombstoneId, "tombstoneId");
      if (!ledgerCodePattern.test(input.ledgerCode))
        throw new TypeError("Invalid recovery ledger code.");
      if (
        input.receipt.trim() !== input.receipt ||
        input.receipt.length < 16 ||
        input.receipt.length > 2_048
      )
        throw new TypeError("Invalid recovery ledger receipt.");
      const receiptDigest = digest(input.receipt);
      return transaction(sql, async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(
          hashtextextended(${input.tombstoneId}::text, 427_026_111)
        )`;
        const [existing] = await tx<ReceiptRow[]>`
          SELECT ledger_code AS "ledgerCode",
            receipt_digest AS "receiptDigest"
          FROM privacy_recovery_tombstone_receipts
          WHERE tombstone_id = ${input.tombstoneId}`;
        if (existing !== undefined) {
          if (
            existing.ledgerCode !== input.ledgerCode ||
            existing.receiptDigest !== receiptDigest
          )
            throw new Error("Recovery tombstone receipt conflict.");
          return "DEDUPLICATED" as const;
        }
        const rows = await tx<Array<{ readonly tombstoneId: string }>>`
          INSERT INTO privacy_recovery_tombstone_receipts (
            tombstone_id, ledger_code, receipt_digest
          )
          SELECT tombstone_id, ${input.ledgerCode}, ${receiptDigest}
          FROM privacy_recovery_tombstones
          WHERE tombstone_id = ${input.tombstoneId}
          RETURNING tombstone_id AS "tombstoneId"`;
        return rows.length === 1
          ? ("ACKNOWLEDGED" as const)
          : ("NOT_FOUND" as const);
      });
    },

    async listPending(limit = 100) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
        throw new RangeError(
          "Privacy tombstone limit must be between 1 and 500.",
        );
      const rows = await sql<PendingPrivacyRecoveryTombstone[]>`
        SELECT tombstone.tombstone_id AS "tombstoneId",
          tombstone.source_disposition_event_id AS "sourceDispositionEventId",
          tombstone.case_id AS "caseId",
          tombstone.subject_user_id AS "subjectUserId",
          tombstone.category::text, tombstone.disposition::text,
          tombstone.policy_version_id AS "policyVersionId",
          tombstone.created_at AS "createdAt"
        FROM privacy_recovery_tombstones tombstone
        LEFT JOIN privacy_recovery_tombstone_receipts receipt
          ON receipt.tombstone_id = tombstone.tombstone_id
        WHERE receipt.tombstone_id IS NULL
        ORDER BY tombstone.created_at, tombstone.tombstone_id
        LIMIT ${limit}`;
      return Object.freeze(rows.map((row) => Object.freeze({ ...row })));
    },
  });
}

export function createPrivacyDispositionQueue(
  sql: Sql,
  options: Readonly<{ readonly leaseDurationMs?: number }> = {},
): Queue<PrivacyDispositionJob> {
  const leaseDurationMs = options.leaseDurationMs ?? 60_000;
  assertPositiveInteger(leaseDurationMs, "leaseDurationMs");

  return Object.freeze({
    async acknowledge(delivery) {
      assertDelivery(delivery);
      await transaction(sql, async (tx) => {
        const rows = await tx<MutationRow[]>`
          UPDATE privacy_data_disposition_jobs
          SET state = 'SUCCEEDED', lease_token = NULL,
            lease_expires_at = NULL, last_error_code = NULL
          WHERE job_id = ${delivery.jobId}
            AND state = 'PROCESSING'
            AND attempt_count = ${delivery.attempt}
            AND lease_expires_at > clock_timestamp()
          RETURNING job_id AS "jobId",
            source_disposition_event_id AS "sourceDispositionEventId",
            tombstone_id AS "tombstoneId", case_id AS "caseId",
            subject_user_id AS "subjectUserId", category::text,
            disposition::text, policy_version_id AS "policyVersionId"`;
        const row = requireSingleMutation(rows, "acknowledge");
        await appendWorkerEvent(tx, row, "COMPLETED");
      });
    },

    async enqueue(
      job: EnqueueJob<PrivacyDispositionJob>,
    ): Promise<EnqueueResult> {
      assertJob(job);
      const [existing] = await sql<ExistingJobRow[]>`
        SELECT job_id AS "jobId",
          source_disposition_event_id AS "sourceDispositionEventId",
          tombstone_id AS "tombstoneId", case_id AS "caseId",
          subject_user_id AS "subjectUserId", category::text,
          disposition::text, policy_version_id AS "policyVersionId",
          max_attempts AS "maxAttempts"
        FROM privacy_data_disposition_jobs
        WHERE job_id = ${job.jobId}`;
      if (existing !== undefined) {
        assertExistingMatches(existing, job);
        return { jobId: job.jobId, status: "duplicate" };
      }
      const rows = await sql<MutationRow[]>`
        INSERT INTO privacy_data_disposition_jobs (
          job_id, source_disposition_event_id, tombstone_id, case_id,
          subject_user_id, category, disposition, policy_version_id
        ) VALUES (
          ${job.jobId}, ${job.payload.sourceDispositionEventId},
          ${job.payload.tombstoneId}, ${job.payload.caseId},
          ${job.payload.subjectUserId}, ${job.payload.category},
          ${job.payload.disposition}, ${job.payload.policyVersionId}
        ) RETURNING job_id AS "jobId",
          source_disposition_event_id AS "sourceDispositionEventId",
          tombstone_id AS "tombstoneId", case_id AS "caseId",
          subject_user_id AS "subjectUserId", category::text,
          disposition::text, policy_version_id AS "policyVersionId"`;
      requireSingleMutation(rows, "enqueue");
      return { jobId: job.jobId, status: "enqueued" };
    },

    async moveToTerminal(delivery, terminal: TerminalJobOptions) {
      assertDelivery(delivery);
      assertErrorCode(terminal.errorCode);
      assertFiniteTimestamp(terminal.failedAt, "failedAt");
      if (!runIdPattern.test(terminal.runId))
        throw new TypeError("runId must be a bounded machine identifier");
      const reason = terminalReason(terminal.reason);
      await transaction(sql, async (tx) => {
        const rows = await tx<MutationRow[]>`
          UPDATE privacy_data_disposition_jobs
          SET state = 'TERMINAL', lease_token = NULL,
            lease_expires_at = NULL, last_error_code = ${terminal.errorCode},
            failed_attempt_count = failed_attempt_count + 1,
            terminal_reason = ${reason}, terminal_run_id = ${terminal.runId}
          WHERE job_id = ${delivery.jobId}
            AND state = 'PROCESSING'
            AND attempt_count = ${delivery.attempt}
            AND lease_expires_at > clock_timestamp()
          RETURNING job_id AS "jobId",
            source_disposition_event_id AS "sourceDispositionEventId",
            tombstone_id AS "tombstoneId", case_id AS "caseId",
            subject_user_id AS "subjectUserId", category::text,
            disposition::text, policy_version_id AS "policyVersionId"`;
        const row = requireSingleMutation(rows, "terminal transition");
        await appendWorkerEvent(tx, row, "FAILED");
      });
    },

    async retry(delivery, retry: RetryJobOptions) {
      assertDelivery(delivery);
      assertErrorCode(retry.errorCode);
      assertFiniteTimestamp(retry.availableAt, "availableAt");
      await transaction(sql, async (tx) => {
        const rows = await tx<MutationRow[]>`
          UPDATE privacy_data_disposition_jobs
          SET state = 'PENDING', lease_token = NULL, lease_expires_at = NULL,
            last_error_code = ${retry.errorCode},
            failed_attempt_count = failed_attempt_count + 1,
            retry_count = retry_count + 1,
            available_at = to_timestamp(${retry.availableAt} / 1000.0)
          WHERE job_id = ${delivery.jobId}
            AND state = 'PROCESSING'
            AND attempt_count = ${delivery.attempt}
            AND lease_expires_at > clock_timestamp()
          RETURNING job_id AS "jobId",
            source_disposition_event_id AS "sourceDispositionEventId",
            tombstone_id AS "tombstoneId", case_id AS "caseId",
            subject_user_id AS "subjectUserId", category::text,
            disposition::text, policy_version_id AS "policyVersionId"`;
        const row = requireSingleMutation(rows, "retry");
        await appendWorkerEvent(tx, row, "FAILED");
      });
    },

    async snapshot(now: number): Promise<QueueMetrics> {
      assertFiniteTimestamp(now, "now");
      const [row] = await sql<SnapshotRow[]>`
        SELECT
          count(*) FILTER (
            WHERE job.state = 'PENDING' AND receipt.tombstone_id IS NOT NULL
          )::integer AS depth,
          count(*) FILTER (WHERE job.state = 'PROCESSING')::integer
            AS "inFlight",
          count(*) FILTER (WHERE job.state = 'SUCCEEDED')::integer
            AS succeeded,
          count(*) FILTER (WHERE job.state = 'TERMINAL')::integer
            AS "terminalFailures",
          coalesce(sum(job.failed_attempt_count), 0)::integer
            AS "failedAttempts",
          coalesce(sum(job.retry_count), 0)::integer AS "retriesScheduled",
          extract(epoch FROM (
            clock_timestamp() - min(job.available_at) FILTER (
              WHERE job.state = 'PENDING' AND receipt.tombstone_id IS NOT NULL
            )
          )) * 1000 AS "oldestPendingAgeMs",
          extract(epoch FROM (
            clock_timestamp() - min(job.updated_at) FILTER (
              WHERE job.state = 'PROCESSING'
            )
          )) * 1000 AS "oldestInFlightAgeMs"
        FROM privacy_data_disposition_jobs job
        LEFT JOIN privacy_recovery_tombstone_receipts receipt
          ON receipt.tombstone_id = job.tombstone_id`;
      if (row === undefined) throw new Error("Privacy queue snapshot missing.");
      return Object.freeze({
        depth: row.depth,
        failedAttempts: row.failedAttempts,
        inFlight: row.inFlight,
        ...(row.oldestInFlightAgeMs === null
          ? {}
          : { oldestInFlightAgeMs: Math.max(0, row.oldestInFlightAgeMs) }),
        ...(row.oldestPendingAgeMs === null
          ? {}
          : { oldestPendingAgeMs: Math.max(0, row.oldestPendingAgeMs) }),
        retriesScheduled: row.retriesScheduled,
        succeeded: row.succeeded,
        terminalFailures: row.terminalFailures,
      });
    },

    async take(now: number) {
      assertFiniteTimestamp(now, "now");
      return transaction(sql, async (tx) => {
        const expiredRows = await tx<MutationRow[]>`
          WITH expired AS (
            SELECT job_id
            FROM privacy_data_disposition_jobs
            WHERE state = 'PROCESSING'
              AND lease_expires_at <= clock_timestamp()
              AND attempt_count >= max_attempts
            ORDER BY lease_expires_at, job_id
            FOR UPDATE SKIP LOCKED
            LIMIT 1
          )
          UPDATE privacy_data_disposition_jobs job
          SET state = 'TERMINAL', lease_token = NULL,
            lease_expires_at = NULL, last_error_code = 'LEASE_EXPIRED',
            failed_attempt_count = job.failed_attempt_count + 1,
            terminal_reason = 'RETRIES_EXHAUSTED',
            terminal_run_id = 'lease-expired:' || job.job_id::text
          FROM expired
          WHERE job.job_id = expired.job_id
          RETURNING job.job_id AS "jobId",
            job.source_disposition_event_id AS "sourceDispositionEventId",
            job.tombstone_id AS "tombstoneId", job.case_id AS "caseId",
            job.subject_user_id AS "subjectUserId", job.category::text,
            job.disposition::text, job.policy_version_id AS "policyVersionId"`;
        if (expiredRows[0] !== undefined) {
          const expired = requireSingleMutation(
            expiredRows,
            "expired lease terminal transition",
          );
          await appendWorkerEvent(tx, expired, "FAILED");
        }

        const leaseToken = randomUUID();
        const [row] = await tx<JobRow[]>`
          WITH candidate AS (
            SELECT job.job_id
            FROM privacy_data_disposition_jobs job
            JOIN privacy_recovery_tombstone_receipts receipt
              ON receipt.tombstone_id = job.tombstone_id
            WHERE (job.state = 'PENDING'
                AND job.available_at <= clock_timestamp()
                AND job.attempt_count < job.max_attempts)
              OR (job.state = 'PROCESSING'
                AND job.lease_expires_at <= clock_timestamp()
                AND job.attempt_count < job.max_attempts)
            ORDER BY CASE WHEN job.state = 'PROCESSING'
                THEN job.lease_expires_at ELSE job.available_at END,
              job.enqueued_at, job.job_id
            FOR UPDATE OF job SKIP LOCKED
            LIMIT 1
          )
          UPDATE privacy_data_disposition_jobs job
          SET state = 'PROCESSING',
            attempt_count = job.attempt_count + 1,
            lease_token = ${leaseToken},
            lease_expires_at = clock_timestamp()
              + (${leaseDurationMs} * interval '1 millisecond'),
            last_error_code = NULL
          FROM candidate
          WHERE job.job_id = candidate.job_id
          RETURNING job.job_id AS "jobId",
            job.source_disposition_event_id AS "sourceDispositionEventId",
            job.tombstone_id AS "tombstoneId", job.case_id AS "caseId",
            job.subject_user_id AS "subjectUserId", job.category::text,
            job.disposition::text, job.policy_version_id AS "policyVersionId",
            job.attempt_count AS attempt, job.max_attempts AS "maxAttempts",
            job.available_at AS "availableAt", job.enqueued_at AS "enqueuedAt"`;
        if (row === undefined) return undefined;
        await appendWorkerEvent(tx, row, "PROCESSING");
        return toDelivery(row);
      });
    },

    async terminalFailures(): Promise<readonly TerminalJobRecord[]> {
      const rows = await sql<TerminalRow[]>`
        SELECT job_id AS "jobId", case_id AS "caseId",
          source_disposition_event_id AS "sourceDispositionEventId",
          attempt_count AS attempts, last_error_code AS "errorCode",
          terminal_reason AS reason, terminal_run_id AS "runId",
          terminal_at AS "failedAt"
        FROM privacy_data_disposition_jobs
        WHERE state = 'TERMINAL'
        ORDER BY terminal_at, job_id`;
      return Object.freeze(rows.map(toTerminalRecord));
    },
  });
}

async function appendWorkerEvent(
  tx: TransactionSql,
  job: MutationRow,
  state: "COMPLETED" | "FAILED" | "PROCESSING",
): Promise<void> {
  const [current] = await tx<Array<{ readonly revision: number }>>`
    SELECT revision
    FROM privacy_data_disposition_events
    WHERE case_id = ${job.caseId} AND category = ${job.category}
    ORDER BY revision DESC LIMIT 1
    FOR UPDATE`;
  if (current === undefined)
    throw new Error("Privacy disposition category head missing.");
  const actionCode =
    state === "PROCESSING"
      ? "PRIVACY_DISPOSITION_PROCESSING"
      : state === "COMPLETED"
        ? "PRIVACY_DISPOSITION_COMPLETED"
        : "PRIVACY_DISPOSITION_FAILED";
  const rows = await tx<Array<{ readonly eventId: string }>>`
    INSERT INTO privacy_data_disposition_events (
      event_id, case_id, category, revision, disposition, state,
      policy_version_id, actor_user_id, actor_system_reference,
      action_code, disposition_job_id
    ) VALUES (
      ${randomUUID()}, ${job.caseId}, ${job.category},
      ${current.revision + 1}, ${job.disposition}, ${state},
      ${job.policyVersionId}, NULL,
      ${`privacy.worker:${job.jobId}`}, ${actionCode}, ${job.jobId}
    ) RETURNING event_id AS "eventId"`;
  if (rows.length !== 1)
    throw new Error("Privacy disposition worker event missing.");
}

function toDelivery(row: JobRow): QueueDelivery<PrivacyDispositionJob> {
  assertExistingRow(row);
  if (
    !Number.isSafeInteger(row.attempt) ||
    row.attempt < 1 ||
    row.maxAttempts !== PRIVACY_DISPOSITION_MAX_ATTEMPTS ||
    !validDate(row.availableAt) ||
    !validDate(row.enqueuedAt)
  )
    throw new Error("Privacy disposition delivery row is invalid.");
  const payload = payloadFromRow(row);
  return Object.freeze({
    attempt: row.attempt,
    availableAt: row.availableAt.valueOf(),
    correlationId: row.caseId,
    enqueuedAt: row.enqueuedAt.valueOf(),
    eventId: row.sourceDispositionEventId,
    jobId: row.jobId,
    maxAttempts: row.maxAttempts,
    name: PRIVACY_DISPOSITION_JOB_NAME,
    payload,
  });
}

function payloadFromRow(row: PrivacyDispositionJob): PrivacyDispositionJob {
  return Object.freeze({
    caseId: row.caseId,
    category: row.category,
    disposition: row.disposition,
    policyVersionId: row.policyVersionId,
    sourceDispositionEventId: row.sourceDispositionEventId,
    subjectUserId: row.subjectUserId,
    tombstoneId: row.tombstoneId,
  });
}

function toTerminalRecord(row: TerminalRow): TerminalJobRecord {
  if (
    !uuidPattern.test(row.jobId) ||
    !uuidPattern.test(row.caseId) ||
    !uuidPattern.test(row.sourceDispositionEventId) ||
    !Number.isSafeInteger(row.attempts) ||
    row.attempts < 1 ||
    !errorCodePattern.test(row.errorCode) ||
    !runIdPattern.test(row.runId) ||
    !validDate(row.failedAt) ||
    (row.reason !== "NON_RETRYABLE" && row.reason !== "RETRIES_EXHAUSTED")
  )
    throw new Error("Privacy terminal job row is invalid.");
  return Object.freeze({
    attempts: row.attempts,
    correlationId: row.caseId,
    errorCode: row.errorCode,
    eventId: row.sourceDispositionEventId,
    failedAt: row.failedAt.valueOf(),
    jobId: row.jobId,
    name: PRIVACY_DISPOSITION_JOB_NAME,
    reason:
      row.reason === "NON_RETRYABLE"
        ? ("non_retryable" as const)
        : ("retries_exhausted" as const),
    runId: row.runId,
  });
}

function assertJob(job: EnqueueJob<PrivacyDispositionJob>): void {
  assertExistingRow({ ...job.payload, jobId: job.jobId });
  if (
    job.correlationId !== job.payload.caseId ||
    job.eventId !== job.payload.sourceDispositionEventId ||
    job.jobId !== job.payload.sourceDispositionEventId ||
    job.payload.tombstoneId !== job.jobId ||
    job.name !== PRIVACY_DISPOSITION_JOB_NAME ||
    job.maxAttempts !== PRIVACY_DISPOSITION_MAX_ATTEMPTS
  )
    throw new TypeError("Privacy disposition job identity is invalid.");
}

function assertDelivery(delivery: QueueDelivery<PrivacyDispositionJob>): void {
  assertJob(delivery);
  if (!Number.isSafeInteger(delivery.attempt) || delivery.attempt < 1)
    throw new TypeError("Privacy disposition delivery attempt is invalid.");
}

function assertExistingMatches(
  row: ExistingJobRow,
  job: EnqueueJob<PrivacyDispositionJob>,
): void {
  assertExistingRow(row);
  if (
    row.jobId !== job.jobId ||
    row.maxAttempts !== job.maxAttempts ||
    row.caseId !== job.payload.caseId ||
    row.category !== job.payload.category ||
    row.disposition !== job.payload.disposition ||
    row.policyVersionId !== job.payload.policyVersionId ||
    row.sourceDispositionEventId !== job.payload.sourceDispositionEventId ||
    row.subjectUserId !== job.payload.subjectUserId ||
    row.tombstoneId !== job.payload.tombstoneId
  )
    throw new Error("Privacy disposition job identity collision.");
}

function assertExistingRow(
  row: PrivacyDispositionJob & { readonly jobId: string },
): void {
  for (const [label, value] of [
    ["jobId", row.jobId],
    ["caseId", row.caseId],
    ["sourceDispositionEventId", row.sourceDispositionEventId],
    ["subjectUserId", row.subjectUserId],
    ["tombstoneId", row.tombstoneId],
    ["policyVersionId", row.policyVersionId],
  ] as const)
    assertUuid(value, label);
  if (
    row.jobId !== row.sourceDispositionEventId ||
    row.jobId !== row.tombstoneId ||
    !RETENTION_CATEGORY_VALUES.includes(row.category) ||
    (row.disposition !== "ANONYMIZE" && row.disposition !== "DELETE")
  )
    throw new Error("Privacy disposition job row is invalid.");
}

function requireSingleMutation(
  rows: readonly MutationRow[],
  operation: string,
): MutationRow {
  const row = rows[0];
  if (rows.length !== 1 || row === undefined)
    throw new Error(`Privacy disposition ${operation} lost its active lease.`);
  assertExistingRow(row);
  return row;
}

function terminalReason(
  reason: TerminalJobOptions["reason"],
): TerminalRow["reason"] {
  if (reason === "non_retryable") return "NON_RETRYABLE";
  if (reason === "retries_exhausted") return "RETRIES_EXHAUSTED";
  throw new TypeError("Privacy terminal reason is invalid.");
}

function assertUuid(value: string, label: string): void {
  if (!uuidPattern.test(value)) throw new TypeError(`Invalid ${label}.`);
}
function assertErrorCode(value: string): void {
  if (!errorCodePattern.test(value))
    throw new TypeError("errorCode must be a bounded machine identifier");
}
function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 300_000)
    throw new RangeError(`${label} must be a bounded positive integer`);
}
function assertFiniteTimestamp(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
}
function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.valueOf());
}
function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function transaction<T>(
  sql: Sql,
  work: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(work) as unknown as Promise<T>;
}
