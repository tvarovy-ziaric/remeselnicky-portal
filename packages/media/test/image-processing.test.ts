import { createHash } from "node:crypto";

import {
  InMemoryQueue,
  NonRetryableJobError,
  createQueueWorker,
} from "@portal/queue";
import {
  createStorageObjectKey,
  storageAreas,
  type ObjectStorageService,
  type StoredObjectReference,
} from "@portal/storage";
import sharp from "sharp";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  IMAGE_CANONICALIZATION_JOB_NAME,
  IMAGE_PROCESSING_LIMITS,
  IMAGE_RUNTIME_CAPABILITIES,
  ImageProcessingRejectedError,
  canonicalizeImage,
  createImageCanonicalizationQueueHandler,
  detectImageSignature,
  type ImageCanonicalizationJob,
  type CompleteImageProcessingInput,
  type ImageProcessingRepository,
} from "../src/index.js";

const assetId = "123e4567-e89b-42d3-a456-426614174000";
const originalObject = objectReference("223e4567-e89b-42d3-a456-426614174000");
const canonicalObject = objectReference("323e4567-e89b-42d3-a456-426614174000");
const thumbnailObject = objectReference("423e4567-e89b-42d3-a456-426614174000");
let orientedJpeg: Uint8Array;
let png: Uint8Array;

beforeAll(async () => {
  orientedJpeg = new Uint8Array(
    await sharp({
      create: {
        background: { alpha: 1, b: 20, g: 10, r: 220 },
        channels: 3,
        height: 20,
        width: 40,
      },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .withExif({
        IFD2: {
          DateTimeOriginal: "2026:09:14 12:30:00",
          OffsetTimeOriginal: "+02:00",
        },
        IFD3: {
          GPSLatitude: "48/1 8/1 0/1",
          GPSLatitudeRef: "N",
          GPSLongitude: "17/1 6/1 0/1",
          GPSLongitudeRef: "E",
        },
      })
      .toBuffer(),
  );
  png = new Uint8Array(
    await sharp({
      create: {
        background: { alpha: 1, b: 3, g: 2, r: 1 },
        channels: 4,
        height: 10,
        width: 10,
      },
    })
      .png()
      .toBuffer(),
  );
});

describe("image canonicalization", () => {
  it("validates signatures, auto-orients pixels and strips EXIF/GPS", async () => {
    expect(detectImageSignature(orientedJpeg)).toBe("image/jpeg");
    expect(detectImageSignature(png)).toBe("image/png");

    const result = await canonicalizeImage({
      body: orientedJpeg,
      declaredContentType: "image/jpeg",
      now: () => new Date("2026-09-14T15:00:00.000Z"),
    });
    expect(result.capturedAt).toEqual(new Date("2026-09-14T10:30:00.000Z"));
    expect(result.canonical).toMatchObject({ height: 40, width: 20 });
    expect(result.thumbnail).toMatchObject({ height: 40, width: 20 });

    for (const derivative of [result.canonical, result.thumbnail]) {
      const metadata = await sharp(derivative.body).metadata();
      expect(metadata.format).toBe("webp");
      expect(metadata.orientation).toBeUndefined();
      expect(metadata.exif).toBeUndefined();
    }
  });

  it("does not retain an ambiguous EXIF local timestamp without an offset", async () => {
    const body = new Uint8Array(
      await sharp({
        create: {
          background: "white",
          channels: 3,
          height: 2,
          width: 2,
        },
      })
        .jpeg()
        .withExif({
          IFD2: { DateTimeOriginal: "2026:09:14 12:30:00" },
        })
        .toBuffer(),
    );
    await expect(
      canonicalizeImage({ body, declaredContentType: "image/jpeg" }),
    ).resolves.toMatchObject({ capturedAt: null });
  });

  it("rejects extension-style MIME spoofing and malformed images deterministically", async () => {
    await expect(
      canonicalizeImage({ body: png, declaredContentType: "image/jpeg" }),
    ).rejects.toMatchObject({ code: "MIME_SIGNATURE_MISMATCH" });
    await expect(
      canonicalizeImage({
        body: new Uint8Array([0xff, 0xd8, 0xff, 0x00]),
        declaredContentType: "image/jpeg",
      }),
    ).rejects.toMatchObject({ code: "MALFORMED_IMAGE" });
    expect(
      new ImageProcessingRejectedError("MALFORMED_IMAGE").message,
    ).not.toContain("255");
  });

  it("rejects HEVC-branded HEIC stably when the runtime has no HEIC decoder", async () => {
    const heicHeader = new Uint8Array([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
      0x00, 0x00, 0x00, 0x00, 0x6d, 0x69, 0x66, 0x31, 0x68, 0x65, 0x69, 0x63,
    ]);
    expect(detectImageSignature(heicHeader)).toBe("image/heif");
    const processing = canonicalizeImage({
      body: heicHeader,
      declaredContentType: "image/heic",
    });
    if (IMAGE_RUNTIME_CAPABILITIES.heicDecode) {
      await expect(processing).rejects.toMatchObject({
        code: "MALFORMED_IMAGE",
      });
    } else {
      await expect(processing).rejects.toMatchObject({
        code: "UNSUPPORTED_IMAGE_FORMAT",
      });
    }
  });

  it("rejects a compressed image whose dimensions exceed the bomb boundary", async () => {
    const body = new Uint8Array(
      await sharp({
        create: {
          background: "white",
          channels: 3,
          height: 1,
          width: IMAGE_PROCESSING_LIMITS.inputMaxDimension + 1,
        },
      })
        .png({ compressionLevel: 9 })
        .toBuffer(),
    );
    expect(body.byteLength).toBeLessThan(IMAGE_PROCESSING_LIMITS.inputMaxBytes);
    await expect(
      canonicalizeImage({ body, declaredContentType: "image/png" }),
    ).rejects.toMatchObject({ code: "DECOMPRESSION_BOMB" });
  });
});

describe("image canonicalization queue handler", () => {
  it("stores private derivatives before atomically requesting READY", async () => {
    const context = setupQueueHandler(orientedJpeg);
    await expect(context.handler({ assetId }, queueContext())).resolves.toBe(
      undefined,
    );
    expect(context.storePrivate).toHaveBeenCalledTimes(2);
    expect(context.completeImageProcessing).toHaveBeenCalledOnce();
    const completion = context.completeImageProcessing.mock.calls[0]?.[0];
    if (completion === undefined) throw new Error("Missing completion input");
    expect(completion.derivatives.map(({ role }) => role)).toEqual([
      "CANONICAL",
      "THUMBNAIL",
    ]);
    expect(completion.derivatives[0]?.contentSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(completion.derivatives[0]).toMatchObject({
      contentType: "image/webp",
      storageObject: canonicalObject,
    });
    expect(completion.derivatives[1]?.contentSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(completion.derivatives[1]).toMatchObject({
      contentType: "image/webp",
      storageObject: thumbnailObject,
    });
    expect(context.recordMediaProcessingRejected).not.toHaveBeenCalled();
  });

  it("persists malformed input as a terminal business rejection without throwing", async () => {
    const context = setupQueueHandler(new Uint8Array([0xff, 0xd8, 0xff, 0x00]));
    await expect(context.handler({ assetId }, queueContext())).resolves.toBe(
      undefined,
    );
    expect(context.recordMediaProcessingRejected).toHaveBeenCalledWith({
      assetId,
      rejectionCode: "MALFORMED_IMAGE",
    });
    expect(context.storePrivate).not.toHaveBeenCalled();
  });

  it("acknowledges a malformed job once instead of entering a worker crash loop", async () => {
    const context = setupQueueHandler(new Uint8Array([0xff, 0xd8, 0xff, 0x00]));
    const queue = new InMemoryQueue<ImageCanonicalizationJob>(() => 1_000);
    await queue.enqueue({
      correlationId: "correlation-image-1",
      eventId: "event-image-1",
      jobId: "job-image-1",
      maxAttempts: 3,
      name: IMAGE_CANONICALIZATION_JOB_NAME,
      payload: { assetId },
    });
    const worker = createQueueWorker({
      backoff: { baseDelayMs: 100, maxDelayMs: 1_000 },
      createRunId: () => "run-image-1",
      handler: context.handler,
      now: () => 1_000,
      queue,
    });

    await expect(worker.processNext()).resolves.toMatchObject({
      attempt: 1,
      status: "succeeded",
    });
    await expect(worker.processNext()).resolves.toEqual({ status: "idle" });
    await expect(queue.snapshot(1_000)).resolves.toMatchObject({
      depth: 0,
      retriesScheduled: 0,
      succeeded: 1,
      terminalFailures: 0,
    });
    expect(context.recordMediaProcessingRejected).toHaveBeenCalledOnce();
  });

  it("classifies invalid jobs permanently and infrastructure failures as retryable", async () => {
    const invalid = setupQueueHandler(orientedJpeg);
    await expect(
      invalid.handler({ assetId: "../../asset" }, queueContext()),
    ).rejects.toBeInstanceOf(NonRetryableJobError);

    const unavailable = setupQueueHandler(orientedJpeg);
    unavailable.readPrivateForProcessing.mockRejectedValueOnce(
      new Error("provider unavailable"),
    );
    await expect(
      unavailable.handler({ assetId }, queueContext()),
    ).rejects.toMatchObject({
      code: "IMAGE_SOURCE_STORAGE_UNAVAILABLE",
    });
  });

  it("observes stored orphans and retries when storage or DB finalization fails", async () => {
    const storageFailure = setupQueueHandler(orientedJpeg);
    storageFailure.storePrivate
      .mockReset()
      .mockResolvedValueOnce(canonicalObject)
      .mockRejectedValueOnce(new Error("down"));
    await expect(
      storageFailure.handler({ assetId }, queueContext()),
    ).rejects.toMatchObject({ code: "IMAGE_DERIVATIVE_STORAGE_FAILED" });
    expect(storageFailure.recordOrphanedPrivateObject).toHaveBeenCalledWith({
      reason: "PARTIAL_DERIVATIVE_STORAGE",
      storageObject: canonicalObject,
    });

    const persistenceFailure = setupQueueHandler(orientedJpeg);
    persistenceFailure.completeImageProcessing.mockRejectedValueOnce(
      new Error("database down"),
    );
    await expect(
      persistenceFailure.handler({ assetId }, queueContext()),
    ).rejects.toMatchObject({ code: "IMAGE_DERIVATIVE_PERSISTENCE_FAILED" });
    expect(
      persistenceFailure.recordOrphanedPrivateObject,
    ).toHaveBeenCalledTimes(2);
  });

  it("treats an already-final asset as an idempotent no-op", async () => {
    const context = setupQueueHandler(orientedJpeg, "READY");
    await context.handler({ assetId }, queueContext());
    expect(context.readPrivateForProcessing).not.toHaveBeenCalled();
    expect(context.storePrivate).not.toHaveBeenCalled();
  });
});

function setupQueueHandler(
  body: Uint8Array,
  status: "PROCESSING" | "READY" | "REJECTED" = "PROCESSING",
) {
  const completeImageProcessing = vi.fn(
    (input: CompleteImageProcessingInput) => {
      void input;
      return Promise.resolve({ transition: "UPDATED" as const });
    },
  );
  const findImageProcessingSource = vi.fn(() =>
    Promise.resolve({
      declaredContentType: "image/jpeg",
      id: assetId,
      kind: "IMAGE" as const,
      originalStorageObject: originalObject,
      status,
    }),
  );
  const recordMediaProcessingRejected = vi.fn(() =>
    Promise.resolve({ transition: "NOT_PROCESSING" as const }),
  );
  const recordMediaProcessingSucceeded = vi.fn(() =>
    Promise.resolve({ transition: "NOT_PROCESSING" as const }),
  );
  const repository: ImageProcessingRepository = {
    completeImageProcessing,
    findImageProcessingSource,
    recordMediaProcessingRejected,
    recordMediaProcessingSucceeded,
  };
  const readPrivateForProcessing = vi.fn(() => Promise.resolve(body));
  const storePrivate = vi
    .fn()
    .mockResolvedValueOnce(canonicalObject)
    .mockResolvedValueOnce(thumbnailObject);
  const storage = {
    readPrivateForProcessing,
    storePrivate,
  } as unknown as ObjectStorageService;
  const recordOrphanedPrivateObject = vi.fn(() => Promise.resolve());
  return {
    completeImageProcessing,
    handler: createImageCanonicalizationQueueHandler({
      now: () => new Date("2026-09-14T15:00:00.000Z"),
      orphanedObjectObserver: { recordOrphanedPrivateObject },
      repository,
      storage,
    }),
    readPrivateForProcessing,
    recordMediaProcessingRejected,
    recordOrphanedPrivateObject,
    storePrivate,
  };
}

function objectReference(uuid: string): StoredObjectReference {
  return {
    area: storageAreas.private,
    key: createStorageObjectKey(storageAreas.private, {
      now: () => new Date("2026-09-14T12:00:00.000Z"),
      uuid: () => uuid,
    }),
  };
}

function queueContext() {
  return {
    attempt: 1,
    correlationId: createHash("sha256").update("correlation").digest("hex"),
    eventId: createHash("sha256").update("event").digest("hex"),
    jobId: createHash("sha256").update("job").digest("hex"),
    runId: createHash("sha256").update("run").digest("hex"),
  };
}
