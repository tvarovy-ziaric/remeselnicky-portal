import { randomUUID } from "node:crypto";

import type { PrivacyDispositionJob } from "@portal/db";
import { RETENTION_CATEGORY_VALUES } from "@portal/privacy";
import {
  NonRetryableJobError,
  createQueueWorker,
  type JobRunContext,
  type Queue,
  type QueueTelemetrySink,
  type QueueWorker,
} from "@portal/queue";

export interface PrivacyDispositionExecutor {
  /** Must be idempotent for the supplied job ID and category. */
  execute(job: PrivacyDispositionJob, context: JobRunContext): Promise<void>;
}

/**
 * The persistent queue only yields work after an independent recovery ledger
 * has acknowledged its deletion/anonymization tombstone. This worker therefore
 * never self-acknowledges a tombstone or weakens the restore boundary.
 */
export function createPrivacyDispositionWorker(input: {
  readonly createRunId?: () => string;
  readonly executor: PrivacyDispositionExecutor;
  readonly now?: () => number;
  readonly queue: Queue<PrivacyDispositionJob>;
  readonly telemetry?: QueueTelemetrySink;
}): QueueWorker {
  return createQueueWorker({
    backoff: { baseDelayMs: 1_000, maxDelayMs: 60_000 },
    createRunId: input.createRunId ?? randomUUID,
    handler: async (job, context) => {
      if (!isExactPrivacyDispositionJob(job, context))
        throw new NonRetryableJobError("INVALID_PRIVACY_DISPOSITION_JOB");
      await input.executor.execute(Object.freeze({ ...job }), context);
    },
    ...(input.now === undefined ? {} : { now: input.now }),
    queue: input.queue,
    ...(input.telemetry === undefined ? {} : { telemetry: input.telemetry }),
  });
}

function isExactPrivacyDispositionJob(
  job: PrivacyDispositionJob,
  context: JobRunContext,
): boolean {
  if (
    typeof job !== "object" ||
    job === null ||
    Object.keys(job).sort().join(",") !==
      "caseId,category,disposition,policyVersionId,sourceDispositionEventId,subjectUserId,tombstoneId"
  )
    return false;
  const ids = [
    job.caseId,
    job.policyVersionId,
    job.sourceDispositionEventId,
    job.subjectUserId,
    job.tombstoneId,
  ];
  return (
    ids.every((value) => uuidPattern.test(value)) &&
    job.sourceDispositionEventId === context.eventId &&
    job.sourceDispositionEventId === context.jobId &&
    job.tombstoneId === context.jobId &&
    job.caseId === context.correlationId &&
    (job.disposition === "DELETE" || job.disposition === "ANONYMIZE") &&
    RETENTION_CATEGORY_VALUES.includes(job.category)
  );
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
