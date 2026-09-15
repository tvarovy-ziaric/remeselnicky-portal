import { randomUUID } from "node:crypto";

import type {
  DocumentValidationJob,
  ImageCanonicalizationJob,
  MediaProcessingJob,
} from "@portal/media";
import {
  NonRetryableJobError,
  createQueueWorker,
  type Queue,
  type QueueHandler,
  type QueueTelemetrySink,
  type QueueWorker,
} from "@portal/queue";

export function createMediaProcessingWorker(input: {
  readonly createRunId?: () => string;
  readonly document: QueueHandler<DocumentValidationJob>;
  readonly image: QueueHandler<ImageCanonicalizationJob>;
  readonly now?: () => number;
  readonly queue: Queue<MediaProcessingJob>;
  readonly telemetry?: QueueTelemetrySink;
}): QueueWorker {
  return createQueueWorker({
    backoff: { baseDelayMs: 1_000, maxDelayMs: 60_000 },
    createRunId: input.createRunId ?? randomUUID,
    handler: async (job, context) => {
      if (!isExactJob(job)) {
        throw new NonRetryableJobError("INVALID_MEDIA_PROCESSING_JOB");
      }
      if (job.kind === "IMAGE") {
        await input.image({ assetId: job.assetId }, context);
        return;
      }
      await input.document({ assetId: job.assetId }, context);
    },
    ...(input.now === undefined ? {} : { now: input.now }),
    queue: input.queue,
    ...(input.telemetry === undefined ? {} : { telemetry: input.telemetry }),
  });
}

function isExactJob(job: MediaProcessingJob): boolean {
  if (
    typeof job !== "object" ||
    job === null ||
    Object.keys(job).sort().join(",") !== "assetId,kind"
  ) {
    return false;
  }
  return (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      job.assetId,
    ) &&
    (job.kind === "IMAGE" || job.kind === "DOCUMENT")
  );
}
