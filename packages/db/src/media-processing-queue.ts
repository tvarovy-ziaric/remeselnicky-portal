import { randomUUID } from "node:crypto";

import {
  DOCUMENT_VALIDATION_JOB_NAME,
  IMAGE_CANONICALIZATION_JOB_NAME,
  MEDIA_PROCESSING_MAX_ATTEMPTS,
  type MediaProcessingJob,
} from "@portal/media";
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
import type { Sql } from "postgres";

interface DeliveryRow {
  readonly assetId: string;
  readonly attempt: number;
  readonly availableAt: Date;
  readonly enqueuedAt: Date;
  readonly kind: "DOCUMENT" | "IMAGE";
  readonly maxAttempts: number;
}

interface ExistingRow {
  readonly assetId: string;
  readonly kind: "DOCUMENT" | "IMAGE";
  readonly maxAttempts: number;
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
  readonly assetId: string;
  readonly attempts: number;
  readonly errorCode: string;
  readonly failedAt: Date;
  readonly kind: "DOCUMENT" | "IMAGE";
  readonly reason: "NON_RETRYABLE" | "RETRIES_EXHAUSTED";
  readonly runId: string;
}

interface MutationRow {
  readonly assetId: string;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const errorCodePattern = /^[A-Z][A-Z0-9_.-]{0,63}$/u;
const runIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;

export function createMediaProcessingQueue(
  sql: Sql,
  options: Readonly<{ readonly leaseDurationMs?: number }> = {},
): Queue<MediaProcessingJob> {
  const leaseDurationMs = options.leaseDurationMs ?? 60_000;
  assertPositiveInteger(leaseDurationMs, "leaseDurationMs");

  return Object.freeze({
    async acknowledge(delivery: QueueDelivery<MediaProcessingJob>) {
      assertDelivery(delivery);
      const rows = await sql<MutationRow[]>`
        UPDATE media_processing_jobs
        SET state = 'SUCCEEDED', lease_token = NULL, lease_expires_at = NULL,
            last_error_code = NULL
        WHERE asset_id = ${delivery.jobId}
          AND state = 'PROCESSING'
          AND attempt_count = ${delivery.attempt}
          AND lease_expires_at > clock_timestamp()
        RETURNING asset_id AS "assetId"
      `;
      requireSingleMutation(rows, "acknowledge");
    },

    async enqueue(job: EnqueueJob<MediaProcessingJob>): Promise<EnqueueResult> {
      assertJob(job);
      const [existing] = await sql<ExistingRow[]>`
        SELECT asset_id AS "assetId", kind, max_attempts AS "maxAttempts"
        FROM media_processing_jobs
        WHERE asset_id = ${job.jobId}
      `;
      if (existing !== undefined) {
        assertExistingMatches(existing, job);
        return { jobId: job.jobId, status: "duplicate" };
      }
      const rows = await sql<MutationRow[]>`
        INSERT INTO media_processing_jobs (asset_id, kind)
        VALUES (${job.jobId}, ${job.payload.kind})
        RETURNING asset_id AS "assetId"
      `;
      requireSingleMutation(rows, "enqueue");
      return { jobId: job.jobId, status: "enqueued" };
    },

    async moveToTerminal(
      delivery: QueueDelivery<MediaProcessingJob>,
      terminal: TerminalJobOptions,
    ) {
      assertDelivery(delivery);
      assertErrorCode(terminal.errorCode);
      assertFiniteTimestamp(terminal.failedAt, "failedAt");
      if (!runIdPattern.test(terminal.runId)) {
        throw new TypeError("runId must be a bounded machine identifier");
      }
      const reason = terminalReason(terminal.reason);
      const rows = await sql<MutationRow[]>`
        UPDATE media_processing_jobs
        SET state = 'TERMINAL', lease_token = NULL, lease_expires_at = NULL,
            failed_attempt_count = failed_attempt_count + 1,
            last_error_code = ${terminal.errorCode},
            terminal_reason = ${reason}, terminal_run_id = ${terminal.runId}
        WHERE asset_id = ${delivery.jobId}
          AND state = 'PROCESSING'
          AND attempt_count = ${delivery.attempt}
          AND lease_expires_at > clock_timestamp()
        RETURNING asset_id AS "assetId"
      `;
      requireSingleMutation(rows, "terminal transition");
    },

    async retry(
      delivery: QueueDelivery<MediaProcessingJob>,
      retry: RetryJobOptions,
    ) {
      assertDelivery(delivery);
      assertErrorCode(retry.errorCode);
      assertFiniteTimestamp(retry.availableAt, "availableAt");
      const rows = await sql<MutationRow[]>`
        UPDATE media_processing_jobs
        SET state = 'PENDING', available_at = GREATEST(
              clock_timestamp(), ${new Date(retry.availableAt)}
            ),
            lease_token = NULL, lease_expires_at = NULL,
            failed_attempt_count = failed_attempt_count + 1,
            retry_count = retry_count + 1,
            last_error_code = ${retry.errorCode}
        WHERE asset_id = ${delivery.jobId}
          AND state = 'PROCESSING'
          AND attempt_count = ${delivery.attempt}
          AND lease_expires_at > clock_timestamp()
        RETURNING asset_id AS "assetId"
      `;
      requireSingleMutation(rows, "retry");
    },

    async snapshot(now: number): Promise<QueueMetrics> {
      assertFiniteTimestamp(now, "now");
      const [row] = await sql<SnapshotRow[]>`
        SELECT
          count(*) FILTER (WHERE state = 'PENDING')::integer AS depth,
          count(*) FILTER (WHERE state = 'PROCESSING')::integer AS "inFlight",
          count(*) FILTER (WHERE state = 'SUCCEEDED')::integer AS succeeded,
          count(*) FILTER (WHERE state = 'TERMINAL')::integer AS "terminalFailures",
          coalesce(sum(failed_attempt_count), 0)::integer AS "failedAttempts",
          coalesce(sum(retry_count), 0)::integer AS "retriesScheduled",
          CASE WHEN min(enqueued_at) FILTER (WHERE state = 'PENDING') IS NULL
            THEN NULL ELSE greatest(0, extract(epoch FROM (
              clock_timestamp() - min(enqueued_at) FILTER (WHERE state = 'PENDING')
            )) * 1000)::double precision END AS "oldestPendingAgeMs",
          CASE WHEN min(updated_at) FILTER (WHERE state = 'PROCESSING') IS NULL
            THEN NULL ELSE greatest(0, extract(epoch FROM (
              clock_timestamp() - min(updated_at) FILTER (WHERE state = 'PROCESSING')
            )) * 1000)::double precision END AS "oldestInFlightAgeMs"
        FROM media_processing_jobs
      `;
      if (row === undefined) throw new Error("Media queue snapshot is missing");
      return Object.freeze({
        depth: row.depth,
        failedAttempts: row.failedAttempts,
        inFlight: row.inFlight,
        oldestInFlightAgeMs: row.oldestInFlightAgeMs ?? undefined,
        oldestPendingAgeMs: row.oldestPendingAgeMs ?? undefined,
        retriesScheduled: row.retriesScheduled,
        succeeded: row.succeeded,
        terminalFailures: row.terminalFailures,
      });
    },

    async take(now: number) {
      assertFiniteTimestamp(now, "now");
      const leaseToken = randomUUID();
      const [row] = await sql<DeliveryRow[]>`
        WITH candidate AS (
          SELECT asset_id
          FROM media_processing_jobs
          WHERE (state = 'PENDING' AND available_at <= clock_timestamp())
             OR (state = 'PROCESSING' AND lease_expires_at <= clock_timestamp())
          ORDER BY CASE WHEN state = 'PROCESSING'
              THEN lease_expires_at ELSE available_at END,
            enqueued_at, asset_id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE media_processing_jobs job
        SET state = 'PROCESSING', attempt_count = job.attempt_count + 1,
            lease_token = ${leaseToken},
            lease_expires_at = clock_timestamp()
              + (${leaseDurationMs} * interval '1 millisecond'),
            last_error_code = NULL
        FROM candidate
        WHERE job.asset_id = candidate.asset_id
        RETURNING job.asset_id AS "assetId", job.kind, job.attempt_count AS attempt,
          job.max_attempts AS "maxAttempts", job.available_at AS "availableAt",
          job.enqueued_at AS "enqueuedAt"
      `;
      return row === undefined ? undefined : toDelivery(row);
    },

    async terminalFailures(): Promise<readonly TerminalJobRecord[]> {
      const rows = await sql<TerminalRow[]>`
        SELECT asset_id AS "assetId", kind, attempt_count AS attempts,
          last_error_code AS "errorCode", terminal_reason AS reason,
          terminal_run_id AS "runId", terminal_at AS "failedAt"
        FROM media_processing_jobs
        WHERE state = 'TERMINAL'
        ORDER BY terminal_at, asset_id
      `;
      return Object.freeze(rows.map(toTerminalRecord));
    },
  });
}

function toDelivery(row: DeliveryRow): QueueDelivery<MediaProcessingJob> {
  assertExistingRow(row);
  if (
    !Number.isSafeInteger(row.attempt) ||
    row.attempt < 1 ||
    !Number.isSafeInteger(row.maxAttempts) ||
    row.maxAttempts !== MEDIA_PROCESSING_MAX_ATTEMPTS ||
    !validDate(row.availableAt) ||
    !validDate(row.enqueuedAt)
  ) {
    throw new Error("Media processing delivery row is invalid");
  }
  const payload = Object.freeze({ assetId: row.assetId, kind: row.kind });
  return Object.freeze({
    attempt: row.attempt,
    availableAt: row.availableAt.valueOf(),
    correlationId: row.assetId,
    enqueuedAt: row.enqueuedAt.valueOf(),
    eventId: row.assetId,
    jobId: row.assetId,
    maxAttempts: row.maxAttempts,
    name: jobName(row.kind),
    payload,
  });
}

function toTerminalRecord(row: TerminalRow): TerminalJobRecord {
  assertExistingRow(row);
  if (
    !Number.isSafeInteger(row.attempts) ||
    row.attempts < 1 ||
    !errorCodePattern.test(row.errorCode) ||
    !runIdPattern.test(row.runId) ||
    !validDate(row.failedAt) ||
    (row.reason !== "NON_RETRYABLE" && row.reason !== "RETRIES_EXHAUSTED")
  ) {
    throw new Error("Media terminal job row is invalid");
  }
  return Object.freeze({
    attempts: row.attempts,
    correlationId: row.assetId,
    errorCode: row.errorCode,
    eventId: row.assetId,
    failedAt: row.failedAt.valueOf(),
    jobId: row.assetId,
    name: jobName(row.kind),
    reason:
      row.reason === "NON_RETRYABLE"
        ? ("non_retryable" as const)
        : ("retries_exhausted" as const),
    runId: row.runId,
  });
}

function assertJob(job: EnqueueJob<MediaProcessingJob>): void {
  if (
    !uuidPattern.test(job.jobId) ||
    job.correlationId !== job.jobId ||
    job.eventId !== job.jobId ||
    job.payload.assetId !== job.jobId ||
    job.name !== jobName(job.payload.kind) ||
    job.maxAttempts !== MEDIA_PROCESSING_MAX_ATTEMPTS
  ) {
    throw new TypeError("Media processing job identity is invalid");
  }
}

function assertDelivery(delivery: QueueDelivery<MediaProcessingJob>): void {
  assertJob(delivery);
  if (!Number.isSafeInteger(delivery.attempt) || delivery.attempt < 1) {
    throw new TypeError("Media processing delivery attempt is invalid");
  }
}

function assertExistingMatches(
  row: ExistingRow,
  job: EnqueueJob<MediaProcessingJob>,
): void {
  assertExistingRow(row);
  if (
    row.assetId !== job.jobId ||
    row.kind !== job.payload.kind ||
    row.maxAttempts !== job.maxAttempts
  ) {
    throw new Error("Media processing job identity collision");
  }
}

function assertExistingRow(
  row: Readonly<Pick<ExistingRow, "assetId" | "kind">>,
): void {
  if (
    !uuidPattern.test(row.assetId) ||
    (row.kind !== "IMAGE" && row.kind !== "DOCUMENT")
  ) {
    throw new Error("Media processing job row is invalid");
  }
}

function jobName(kind: MediaProcessingJob["kind"]): string {
  return kind === "IMAGE"
    ? IMAGE_CANONICALIZATION_JOB_NAME
    : DOCUMENT_VALIDATION_JOB_NAME;
}

function terminalReason(
  reason: TerminalJobOptions["reason"],
): TerminalRow["reason"] {
  if (reason === "non_retryable") return "NON_RETRYABLE";
  if (reason === "retries_exhausted") return "RETRIES_EXHAUSTED";
  throw new TypeError("Media processing terminal reason is invalid");
}

function assertErrorCode(value: string): void {
  if (!errorCodePattern.test(value)) {
    throw new TypeError("errorCode must be a bounded machine identifier");
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 300_000) {
    throw new RangeError(`${label} must be a bounded positive integer`);
  }
}

function assertFiniteTimestamp(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.valueOf());
}

function requireSingleMutation(
  rows: readonly MutationRow[],
  operation: string,
) {
  if (rows.length !== 1 || !uuidPattern.test(rows[0]?.assetId ?? "")) {
    throw new Error(`Media processing ${operation} lost its active lease`);
  }
}
