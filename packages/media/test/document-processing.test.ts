import { createHash } from "node:crypto";

import {
  InMemoryQueue,
  RetryableJobError,
  createQueueWorker,
} from "@portal/queue";
import {
  createStorageObjectKey,
  storageAreas,
  type ObjectStorageService,
  type StoredObjectReference,
} from "@portal/storage";
import { describe, expect, it, vi } from "vitest";

import {
  DOCUMENT_PROCESSING_LIMITS,
  DOCUMENT_VALIDATION_JOB_NAME,
  DocumentProcessingRejectedError,
  createDocumentValidationQueueHandler,
  validatePdfDocument,
  type ActiveMalwareScanner,
  type CompleteDocumentProcessingInput,
  type DocumentProcessingRepository,
  type DocumentValidationJob,
  type MalwareScanVerdict,
} from "../src/index.js";

const assetId = "123e4567-e89b-42d3-a456-426614174000";
const now = new Date("2026-09-14T15:00:00.000Z");
const originalObject = objectReference("223e4567-e89b-42d3-a456-426614174000");
const canonicalObject = objectReference("323e4567-e89b-42d3-a456-426614174000");

describe("PDF document validation", () => {
  it("requires a real PDF signature and parses every page", async () => {
    const body = minimalPdf();
    await expect(validatePdfDocument(body, "application/pdf")).resolves.toEqual(
      {
        body,
        contentSha256: createHash("sha256").update(body).digest("hex"),
        pageCount: 1,
      },
    );
    await expect(
      validatePdfDocument(body, "application/octet-stream"),
    ).rejects.toMatchObject({ code: "MIME_SIGNATURE_MISMATCH" });
    await expect(
      validatePdfDocument(
        new TextEncoder().encode("%PDF-1.7\nnot a real document\n%%EOF\n"),
        "application/pdf",
      ),
    ).rejects.toMatchObject({ code: "MALFORMED_PDF" });
  });

  it("rejects active content, encrypted markers and oversized bodies", async () => {
    await expect(
      validatePdfDocument(
        minimalPdf("/OpenAction /JavaScript"),
        "application/pdf",
      ),
    ).rejects.toMatchObject({ code: "ACTIVE_PDF_CONTENT" });
    await expect(
      validatePdfDocument(minimalPdf("/Encrypt 5 0 R"), "application/pdf"),
    ).rejects.toMatchObject({ code: "ENCRYPTED_PDF" });
    await expect(
      validatePdfDocument(
        new Uint8Array(DOCUMENT_PROCESSING_LIMITS.inputMaxBytes + 1),
        "application/pdf",
      ),
    ).rejects.toBeInstanceOf(DocumentProcessingRejectedError);
  });
});

describe("document validation queue handler", () => {
  it("stores an exact private canonical with hash and CLEAN scan evidence before READY", async () => {
    const context = setupQueueHandler();
    await expect(
      context.handler({ assetId }, queueContext()),
    ).resolves.toBeUndefined();
    expect(context.scan).toHaveBeenCalledOnce();
    expect(context.storePrivate).toHaveBeenCalledWith({
      body: context.body,
      contentType: "application/pdf",
    });
    expect(context.completeDocumentProcessing).toHaveBeenCalledOnce();
    const completion = context.completeDocumentProcessing.mock.calls[0]?.[0];
    if (completion === undefined)
      throw new Error("Missing document completion");
    expect(completion).toMatchObject({
      assetId,
      canonical: {
        contentSha256: createHash("sha256").update(context.body).digest("hex"),
        contentType: "application/pdf",
        role: "CANONICAL",
        storageObject: canonicalObject,
      },
      pageCount: 1,
      scan: {
        assurance: "ACTIVE",
        engine: "scanner-engine",
        engineVersion: "1.2.3",
        scannedAt: now,
        signatureVersion: "20260914.1",
        verdict: "CLEAN",
      },
    });
  });

  it("rejects an EICAR-indicated scan permanently and does not crash-loop", async () => {
    const eicarIndicator = [
      "X5O!P",
      "%@AP[4\\PZX54(P^)7CC)7}$",
      "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*",
    ].join("");
    const body = minimalPdf(`% ${eicarIndicator}`);
    const context = setupQueueHandler({
      body,
      scanImplementation: ({ body: scannedBody, contentSha256 }) => {
        const verdict = new TextDecoder()
          .decode(scannedBody)
          .includes(eicarIndicator)
          ? "INFECTED"
          : "CLEAN";
        return Promise.resolve({
          contentSha256,
          engine: "scanner-engine",
          engineVersion: "1.2.3",
          scannedAt: now,
          signatureVersion: "20260914.1",
          verdict,
        });
      },
    });
    const queue = new InMemoryQueue<DocumentValidationJob>(() => 1_000);
    await queue.enqueue({
      correlationId: "correlation-document-1",
      eventId: "event-document-1",
      jobId: "job-document-1",
      maxAttempts: 3,
      name: DOCUMENT_VALIDATION_JOB_NAME,
      payload: { assetId },
    });
    const worker = createQueueWorker({
      backoff: { baseDelayMs: 100, maxDelayMs: 1_000 },
      createRunId: () => "run-document-1",
      handler: context.handler,
      now: () => 1_000,
      queue,
    });

    await expect(worker.processNext()).resolves.toMatchObject({
      attempt: 1,
      status: "succeeded",
    });
    await expect(worker.processNext()).resolves.toEqual({ status: "idle" });
    expect(context.recordMediaProcessingRejected).toHaveBeenCalledWith({
      assetId,
      rejectionCode: "MALWARE_DETECTED",
    });
    expect(context.storePrivate).not.toHaveBeenCalled();
    expect(context.completeDocumentProcessing).not.toHaveBeenCalled();
  });

  it("persists malformed and unscannable input as terminal business rejections", async () => {
    const malformed = setupQueueHandler({
      body: new TextEncoder().encode("%PDF-1.7\nmalformed\n%%EOF\n"),
    });
    await expect(
      malformed.handler({ assetId }, queueContext()),
    ).resolves.toBeUndefined();
    expect(malformed.recordMediaProcessingRejected).toHaveBeenCalledWith({
      assetId,
      rejectionCode: "MALFORMED_PDF",
    });
    expect(malformed.scan).not.toHaveBeenCalled();

    const unscannable = setupQueueHandler({ verdict: "UNSCANNABLE" });
    await expect(
      unscannable.handler({ assetId }, queueContext()),
    ).resolves.toBeUndefined();
    expect(unscannable.recordMediaProcessingRejected).toHaveBeenCalledWith({
      assetId,
      rejectionCode: "MALWARE_SCAN_UNSCANNABLE",
    });
    expect(unscannable.completeDocumentProcessing).not.toHaveBeenCalled();
  });

  it("fails closed for bypass scanners in staging and production", () => {
    for (const environment of ["staging", "production"] as const) {
      expect(() =>
        createDocumentValidationQueueHandler({
          environment,
          orphanedObjectObserver: { recordOrphanedPrivateObject: vi.fn() },
          repository: repositoryMocks().repository,
          scanner: { assurance: "BYPASS_TEST_ONLY" },
          storage: storageMocks(minimalPdf()).storage,
        }),
      ).toThrow(/active malware scanner is mandatory/iu);
    }
  });

  it("retries scan timeout/provider failure and never marks the asset READY", async () => {
    const context = setupQueueHandler({
      scanImplementation: ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
      scanTimeoutMs: 100,
    });
    await expect(
      context.handler({ assetId }, queueContext()),
    ).rejects.toMatchObject({
      code: "DOCUMENT_MALWARE_SCAN_UNAVAILABLE",
    });
    expect(context.recordMediaProcessingRejected).not.toHaveBeenCalled();
    expect(context.storePrivate).not.toHaveBeenCalled();
    expect(context.completeDocumentProcessing).not.toHaveBeenCalled();

    const providerFailure = setupQueueHandler({
      scanImplementation: () =>
        Promise.reject(new Error("provider unavailable")),
    });
    await expect(
      providerFailure.handler({ assetId }, queueContext()),
    ).rejects.toBeInstanceOf(RetryableJobError);
  });

  it("fails closed when CLEAN evidence is stale or bound to another hash", async () => {
    const invalidEvidence = setupQueueHandler({
      scanImplementation: () =>
        Promise.resolve({
          contentSha256: "0".repeat(64),
          engine: "scanner-engine",
          engineVersion: "1.2.3",
          scannedAt: new Date("2026-09-12T15:00:00.000Z"),
          signatureVersion: "20260912.1",
          verdict: "CLEAN",
        }),
    });
    await expect(
      invalidEvidence.handler({ assetId }, queueContext()),
    ).rejects.toMatchObject({
      code: "DOCUMENT_MALWARE_SCAN_EVIDENCE_INVALID",
    });
    expect(invalidEvidence.storePrivate).not.toHaveBeenCalled();
    expect(invalidEvidence.completeDocumentProcessing).not.toHaveBeenCalled();
  });

  it("keeps a stored canonical private and observable when DB finalization fails", async () => {
    const context = setupQueueHandler();
    context.completeDocumentProcessing.mockRejectedValueOnce(
      new Error("database down"),
    );
    await expect(
      context.handler({ assetId }, queueContext()),
    ).rejects.toMatchObject({
      code: "DOCUMENT_CANONICAL_PERSISTENCE_FAILED",
    });
    expect(context.recordOrphanedPrivateObject).toHaveBeenCalledWith({
      reason: "DERIVATIVE_PERSISTENCE_FAILED",
      storageObject: canonicalObject,
    });
  });
});

function setupQueueHandler(
  options: {
    readonly body?: Uint8Array;
    readonly scanImplementation?: ActiveMalwareScanner["scan"];
    readonly scanTimeoutMs?: number;
    readonly status?: "PROCESSING" | "READY" | "REJECTED";
    readonly verdict?: MalwareScanVerdict["verdict"];
  } = {},
) {
  const body = options.body ?? minimalPdf();
  const repositories = repositoryMocks(options.status);
  const storageContext = storageMocks(body);
  const contentSha256 = createHash("sha256").update(body).digest("hex");
  const scan = vi.fn(
    options.scanImplementation ??
      (() =>
        Promise.resolve({
          contentSha256,
          engine: "scanner-engine",
          engineVersion: "1.2.3",
          scannedAt: now,
          signatureVersion: "20260914.1",
          verdict: options.verdict ?? "CLEAN",
        })),
  );
  const recordOrphanedPrivateObject = vi.fn(() => Promise.resolve());
  return {
    ...repositories,
    ...storageContext,
    body,
    handler: createDocumentValidationQueueHandler({
      environment: "test",
      now: () => now,
      orphanedObjectObserver: { recordOrphanedPrivateObject },
      repository: repositories.repository,
      scanner: { assurance: "ACTIVE", scan },
      ...(options.scanTimeoutMs === undefined
        ? {}
        : { scanTimeoutMs: options.scanTimeoutMs }),
      storage: storageContext.storage,
    }),
    recordOrphanedPrivateObject,
    scan,
  };
}

function repositoryMocks(
  status: "PROCESSING" | "READY" | "REJECTED" = "PROCESSING",
) {
  const completeDocumentProcessing = vi.fn(
    (input: CompleteDocumentProcessingInput) => {
      void input;
      return Promise.resolve({ transition: "UPDATED" as const });
    },
  );
  const findDocumentProcessingSource = vi.fn(() =>
    Promise.resolve({
      declaredContentType: "application/pdf",
      id: assetId,
      kind: "DOCUMENT" as const,
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
  const repository: DocumentProcessingRepository = {
    completeDocumentProcessing,
    findDocumentProcessingSource,
    recordMediaProcessingRejected,
    recordMediaProcessingSucceeded,
  };
  return {
    completeDocumentProcessing,
    findDocumentProcessingSource,
    recordMediaProcessingRejected,
    repository,
  };
}

function storageMocks(body: Uint8Array) {
  const readPrivateForProcessing = vi.fn(() => Promise.resolve(body));
  const storePrivate = vi.fn(() => Promise.resolve(canonicalObject));
  const storage = {
    readPrivateForProcessing,
    storePrivate,
  } as unknown as ObjectStorageService;
  return { readPrivateForProcessing, storage, storePrivate };
}

function minimalPdf(catalogExtra = ""): Uint8Array {
  const encoder = new TextEncoder();
  const objects = [
    `1 0 obj\n<< /Type /Catalog /Pages 2 0 R ${catalogExtra} >>\nendobj\n`,
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources <<>> /Contents 4 0 R >>\nendobj\n",
    "4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n",
  ];
  let pdf = "%PDF-1.7\n% synthetic test fixture\n";
  const offsets: number[] = [];
  for (const object of objects) {
    offsets.push(encoder.encode(pdf).byteLength);
    pdf += object;
  }
  const xrefOffset = encoder.encode(pdf).byteLength;
  pdf += "xref\n0 5\n0000000000 65535 f \n";
  pdf += offsets
    .map((offset) => `${offset.toString().padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return encoder.encode(pdf);
}

function objectReference(uuid: string): StoredObjectReference {
  return {
    area: storageAreas.private,
    key: createStorageObjectKey(storageAreas.private, {
      now: () => now,
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
