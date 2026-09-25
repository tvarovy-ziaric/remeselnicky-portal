import { createHash } from "node:crypto";

import { NonRetryableJobError, type JobRunContext } from "@portal/queue";
import type { Sql, TransactionSql } from "postgres";

import type { PrivacyDispositionJob } from "./privacy-disposition-queue.js";

export const PRIVACY_NOTIFICATION_DELIVERY_EXECUTOR_CODE =
  "postgres.notification-delivery.v1";

export interface PrivacyCategoryExecutionReceipt {
  readonly affectedRecordCount: number;
  readonly category: PrivacyDispositionJob["category"];
  readonly completedAt: Date;
  readonly disposition: PrivacyDispositionJob["disposition"];
  readonly executionAttempt: number;
  readonly executorCode: string;
  readonly jobId: string;
  readonly resultDigest: string;
  readonly subjectUserId: string;
}

export interface PrivacyNotificationDeliveryDispositionExecutor {
  execute(job: PrivacyDispositionJob, context: JobRunContext): Promise<void>;
  receipt(jobId: string): Promise<PrivacyCategoryExecutionReceipt | null>;
}

interface ActiveJobRow {
  readonly attempt: number;
  readonly caseId: string;
  readonly category: PrivacyDispositionJob["category"];
  readonly disposition: PrivacyDispositionJob["disposition"];
  readonly policyVersionId: string;
  readonly sourceDispositionEventId: string;
  readonly state: string;
  readonly subjectUserId: string;
  readonly tombstoneId: string;
}

export function createPrivacyNotificationDeliveryDispositionExecutor(
  sql: Sql,
): PrivacyNotificationDeliveryDispositionExecutor {
  return Object.freeze({
    async execute(
      job: PrivacyDispositionJob,
      context: JobRunContext,
    ): Promise<void> {
      assertExecutionIdentity(job, context);
      if (job.category !== "NOTIFICATION_DELIVERY")
        throw new NonRetryableJobError("UNSUPPORTED_PRIVACY_CATEGORY");

      await transaction(sql, async (tx) => {
        const [active] = await tx<ActiveJobRow[]>`
          SELECT attempt_count AS attempt, category::text,
            disposition::text, state::text,
            case_id AS "caseId", policy_version_id AS "policyVersionId",
            source_disposition_event_id AS "sourceDispositionEventId",
            subject_user_id AS "subjectUserId",
            tombstone_id AS "tombstoneId"
          FROM privacy_data_disposition_jobs
          WHERE job_id = ${job.sourceDispositionEventId}
          FOR UPDATE`;
        if (
          active === undefined ||
          active.state !== "PROCESSING" ||
          active.attempt !== context.attempt ||
          active.caseId !== job.caseId ||
          active.category !== job.category ||
          active.disposition !== job.disposition ||
          active.policyVersionId !== job.policyVersionId ||
          active.sourceDispositionEventId !== job.sourceDispositionEventId ||
          active.subjectUserId !== job.subjectUserId ||
          active.tombstoneId !== job.tombstoneId
        )
          throw new Error("Privacy disposition execution lost its exact job.");

        const [existing] = await tx<PrivacyCategoryExecutionReceipt[]>`
          SELECT job_id AS "jobId", category::text, disposition::text,
            subject_user_id AS "subjectUserId",
            executor_code AS "executorCode",
            execution_attempt AS "executionAttempt",
            affected_record_count AS "affectedRecordCount",
            result_digest AS "resultDigest", completed_at AS "completedAt"
          FROM privacy_category_execution_receipts
          WHERE job_id = ${context.jobId}`;
        if (existing !== undefined) {
          assertReceipt(existing, job);
          return;
        }

        const [removed] = await tx<Array<{ readonly count: number }>>`
          WITH deleted AS (
            DELETE FROM notification_deliveries delivery
            USING notifications notification
            WHERE delivery.notification_id = notification.id
              AND notification.recipient_user_id = ${job.subjectUserId}
            RETURNING delivery.id
          )
          SELECT count(*)::integer AS count FROM deleted`;
        if (removed === undefined)
          throw new Error("Notification delivery disposition count missing.");
        const resultDigest = digestResult(job, removed.count);
        const rows = await tx<Array<{ readonly jobId: string }>>`
          INSERT INTO privacy_category_execution_receipts (
            job_id, category, disposition, subject_user_id, executor_code,
            execution_attempt, affected_record_count, result_digest
          ) VALUES (
            ${context.jobId}, ${job.category}, ${job.disposition},
            ${job.subjectUserId},
            ${PRIVACY_NOTIFICATION_DELIVERY_EXECUTOR_CODE},
            ${context.attempt}, ${removed.count}, ${resultDigest}
          ) RETURNING job_id AS "jobId"`;
        if (rows.length !== 1)
          throw new Error("Privacy category execution receipt missing.");
      });
    },

    async receipt(
      jobId: string,
    ): Promise<PrivacyCategoryExecutionReceipt | null> {
      assertUuid(jobId, "jobId");
      const [row] = await sql<PrivacyCategoryExecutionReceipt[]>`
        SELECT job_id AS "jobId", category::text, disposition::text,
          subject_user_id AS "subjectUserId", executor_code AS "executorCode",
          execution_attempt AS "executionAttempt",
          affected_record_count AS "affectedRecordCount",
          result_digest AS "resultDigest", completed_at AS "completedAt"
        FROM privacy_category_execution_receipts
        WHERE job_id = ${jobId}`;
      return row === undefined ? null : Object.freeze({ ...row });
    },
  });
}

function assertExecutionIdentity(
  job: PrivacyDispositionJob,
  context: JobRunContext,
): void {
  for (const [label, value] of [
    ["caseId", job.caseId],
    ["policyVersionId", job.policyVersionId],
    ["sourceDispositionEventId", job.sourceDispositionEventId],
    ["subjectUserId", job.subjectUserId],
    ["tombstoneId", job.tombstoneId],
    ["context.jobId", context.jobId],
  ] as const)
    assertUuid(value, label);
  if (
    job.sourceDispositionEventId !== context.eventId ||
    job.sourceDispositionEventId !== context.jobId ||
    job.tombstoneId !== context.jobId ||
    job.caseId !== context.correlationId ||
    !Number.isSafeInteger(context.attempt) ||
    context.attempt < 1
  )
    throw new NonRetryableJobError("INVALID_PRIVACY_DISPOSITION_JOB");
}

function assertReceipt(
  receipt: PrivacyCategoryExecutionReceipt,
  job: PrivacyDispositionJob,
): void {
  if (
    receipt.jobId !== job.sourceDispositionEventId ||
    receipt.category !== job.category ||
    receipt.disposition !== job.disposition ||
    receipt.subjectUserId !== job.subjectUserId ||
    receipt.executorCode !== PRIVACY_NOTIFICATION_DELIVERY_EXECUTOR_CODE ||
    !Number.isSafeInteger(receipt.executionAttempt) ||
    receipt.executionAttempt < 1 ||
    !Number.isSafeInteger(receipt.affectedRecordCount) ||
    receipt.affectedRecordCount < 0 ||
    !/^[0-9a-f]{64}$/u.test(receipt.resultDigest) ||
    receipt.resultDigest !== digestResult(job, receipt.affectedRecordCount) ||
    !(receipt.completedAt instanceof Date) ||
    !Number.isFinite(receipt.completedAt.valueOf())
  )
    throw new Error("Privacy category execution receipt conflict.");
}

function digestResult(job: PrivacyDispositionJob, count: number): string {
  return createHash("sha256")
    .update(
      [
        job.sourceDispositionEventId,
        job.category,
        job.disposition,
        job.subjectUserId,
        PRIVACY_NOTIFICATION_DELIVERY_EXECUTOR_CODE,
        String(count),
      ].join(":"),
      "utf8",
    )
    .digest("hex");
}

function assertUuid(value: string, label: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  )
    throw new TypeError(`Invalid ${label}.`);
}

function transaction<T>(
  sql: Sql,
  work: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(work) as unknown as Promise<T>;
}
