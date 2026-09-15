import {
  MEDIA_PROCESSING_MAX_ATTEMPTS,
  createMediaProcessingDispatcher,
  type MediaProcessingJob,
} from "@portal/media";
import { InMemoryQueue, RetryableJobError } from "@portal/queue";
import { describe, expect, it, vi } from "vitest";

import { createMediaProcessingWorker } from "./media-processing.js";

const imageId = "93000000-0000-4000-8000-000000000001";
const documentId = "93000000-0000-4000-8000-000000000002";

describe("media processing worker", () => {
  it("routes opaque image and document jobs to the exact handler", async () => {
    const queue = new InMemoryQueue<MediaProcessingJob>(() => 1_000);
    const image = vi.fn(() => Promise.resolve());
    const document = vi.fn(() => Promise.resolve());
    const worker = createMediaProcessingWorker({
      createRunId: () => "media-run-1",
      document,
      image,
      now: () => 1_000,
      queue,
    });
    const dispatcher = createMediaProcessingDispatcher(queue);
    await dispatcher.enqueue({ assetId: imageId, kind: "IMAGE" });
    await dispatcher.enqueue({ assetId: documentId, kind: "DOCUMENT" });

    await expect(worker.processNext()).resolves.toMatchObject({
      jobId: imageId,
      status: "succeeded",
    });
    await expect(worker.processNext()).resolves.toMatchObject({
      jobId: documentId,
      status: "succeeded",
    });
    expect(image).toHaveBeenCalledWith(
      { assetId: imageId },
      expect.objectContaining({ jobId: imageId, runId: "media-run-1" }),
    );
    expect(document).toHaveBeenCalledWith(
      { assetId: documentId },
      expect.objectContaining({ jobId: documentId, runId: "media-run-1" }),
    );
  });

  it("retries transient handler failures without exposing the payload", async () => {
    let now = 1_000;
    const queue = new InMemoryQueue<MediaProcessingJob>(() => now);
    const telemetry: unknown[] = [];
    const worker = createMediaProcessingWorker({
      createRunId: () => "media-run-retry",
      document: vi.fn(() => Promise.resolve()),
      image: vi.fn(() =>
        Promise.reject(new RetryableJobError("STORAGE_UNAVAILABLE")),
      ),
      now: () => now,
      queue,
      telemetry: { record: (event) => telemetry.push(event) },
    });
    await queue.enqueue({
      correlationId: imageId,
      eventId: imageId,
      jobId: imageId,
      maxAttempts: MEDIA_PROCESSING_MAX_ATTEMPTS,
      name: "media.image.canonicalize",
      payload: { assetId: imageId, kind: "IMAGE" },
    });

    await expect(worker.processNext()).resolves.toMatchObject({
      availableAt: 2_000,
      status: "retry_scheduled",
    });
    expect(
      telemetry.flatMap((event) =>
        typeof event === "object" && event !== null ? Object.keys(event) : [],
      ),
    ).not.toEqual(
      expect.arrayContaining([
        "body",
        "content",
        "filename",
        "ownerUserId",
        "storageKey",
      ]),
    );
    now = 2_000;
    await expect(worker.processNext()).resolves.toMatchObject({ attempt: 2 });
  });

  it("moves malformed persisted payloads to a terminal record", async () => {
    const queue = new InMemoryQueue<MediaProcessingJob>(() => 1_000);
    const worker = createMediaProcessingWorker({
      createRunId: () => "media-run-invalid",
      document: vi.fn(() => Promise.resolve()),
      image: vi.fn(() => Promise.resolve()),
      now: () => 1_000,
      queue,
    });
    await queue.enqueue({
      correlationId: imageId,
      eventId: imageId,
      jobId: imageId,
      maxAttempts: MEDIA_PROCESSING_MAX_ATTEMPTS,
      name: "media.image.canonicalize",
      payload: {
        assetId: imageId,
        kind: "IMAGE",
        privateBody: "must-not-pass",
      } as unknown as MediaProcessingJob,
    });

    await expect(worker.processNext()).resolves.toMatchObject({
      reason: "non_retryable",
      status: "terminal_failure",
    });
    await expect(queue.terminalFailures()).resolves.toEqual([
      expect.objectContaining({
        errorCode: "INVALID_MEDIA_PROCESSING_JOB",
        jobId: imageId,
      }),
    ]);
  });
});
