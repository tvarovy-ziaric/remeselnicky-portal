import type { Queue } from "@portal/queue";
import { describe, expect, it, vi } from "vitest";

import {
  DOCUMENT_VALIDATION_JOB_NAME,
  IMAGE_CANONICALIZATION_JOB_NAME,
  MEDIA_PROCESSING_MAX_ATTEMPTS,
  createMediaProcessingDispatcher,
  type MediaProcessingJob,
} from "../src/index.js";

const assetId = "91000000-0000-4000-8000-000000000001";

describe("media processing dispatcher", () => {
  it.each([
    ["IMAGE", IMAGE_CANONICALIZATION_JOB_NAME],
    ["DOCUMENT", DOCUMENT_VALIDATION_JOB_NAME],
  ] as const)("authors one privacy-minimal %s job", async (kind, name) => {
    const enqueue = vi.fn<Queue<MediaProcessingJob>["enqueue"]>(() =>
      Promise.resolve({ jobId: assetId, status: "enqueued" }),
    );
    const dispatcher = createMediaProcessingDispatcher({
      enqueue,
    } as unknown as Queue<MediaProcessingJob>);

    await dispatcher.enqueue({ assetId, kind });

    expect(enqueue).toHaveBeenCalledWith({
      correlationId: assetId,
      eventId: assetId,
      jobId: assetId,
      maxAttempts: MEDIA_PROCESSING_MAX_ATTEMPTS,
      name,
      payload: { assetId, kind },
    });
    expect(JSON.stringify(enqueue.mock.calls[0])).not.toMatch(
      /filename|storage|body|content|owner|user/iu,
    );
  });
});
