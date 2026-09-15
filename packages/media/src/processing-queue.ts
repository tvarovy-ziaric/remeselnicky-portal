import type { Queue } from "@portal/queue";

import type { QuoteDocumentProcessingDispatcher } from "./quote-document.js";
import {
  IMAGE_CANONICALIZATION_JOB_NAME,
  type ImageCanonicalizationJob,
} from "./image-processing.js";
import {
  DOCUMENT_VALIDATION_JOB_NAME,
  type DocumentValidationJob,
} from "./document-processing.js";
import type { ConversationAttachmentProcessingDispatcher } from "./conversation-attachment.js";
import type { JobRequestMediaProcessingDispatcher } from "./job-request-upload.js";

export type MediaProcessingJob = Readonly<
  | ({ readonly kind: "IMAGE" } & ImageCanonicalizationJob)
  | ({ readonly kind: "DOCUMENT" } & DocumentValidationJob)
>;

export type MediaProcessingDispatcher =
  ConversationAttachmentProcessingDispatcher &
    JobRequestMediaProcessingDispatcher &
    QuoteDocumentProcessingDispatcher;

export const MEDIA_PROCESSING_MAX_ATTEMPTS = 10;

export function createMediaProcessingDispatcher(
  queue: Queue<MediaProcessingJob>,
): MediaProcessingDispatcher {
  return Object.freeze({
    async enqueue(job: MediaProcessingJob): Promise<void> {
      const name =
        job.kind === "IMAGE"
          ? IMAGE_CANONICALIZATION_JOB_NAME
          : DOCUMENT_VALIDATION_JOB_NAME;
      await queue.enqueue({
        correlationId: job.assetId,
        eventId: job.assetId,
        jobId: job.assetId,
        maxAttempts: MEDIA_PROCESSING_MAX_ATTEMPTS,
        name,
        payload: Object.freeze({ ...job }),
      });
    },
  });
}
