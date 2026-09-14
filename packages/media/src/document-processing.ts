import { createHash } from "node:crypto";

import {
  NonRetryableJobError,
  RetryableJobError,
  type QueueHandler,
} from "@portal/queue";
import type { ObjectStorageService } from "@portal/storage";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import type {
  CleanDocumentScanEvidence,
  DocumentProcessingRepository,
  StoredDocumentCanonical,
} from "./model.js";
import {
  MEDIA_UPLOAD_LIMITS,
  type OrphanedPrivateObjectObserver,
} from "./upload.js";

const PDF_MAX_PAGES = 200;
const PDF_MAX_OBJECTS = 50_000;
const PDF_MAX_STREAMS = 10_000;
const PDF_MAX_OPERATORS_PER_PAGE = 50_000;
const PDF_MAX_OPERATORS_TOTAL = 500_000;
const PDF_MAX_ANNOTATIONS_TOTAL = 5_000;
const PDF_MAX_IMAGE_PIXELS = 40_000_000;
const DEFAULT_SCAN_TIMEOUT_MS = 30_000;
const MAX_SCAN_EVIDENCE_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const boundedIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;

export const DOCUMENT_VALIDATION_JOB_NAME = "media.document.validate" as const;

export const DOCUMENT_PROCESSING_LIMITS = Object.freeze({
  inputMaxBytes: MEDIA_UPLOAD_LIMITS.documentMaxBytes,
  maxAnnotationsTotal: PDF_MAX_ANNOTATIONS_TOTAL,
  maxObjects: PDF_MAX_OBJECTS,
  maxOperatorsPerPage: PDF_MAX_OPERATORS_PER_PAGE,
  maxOperatorsTotal: PDF_MAX_OPERATORS_TOTAL,
  maxPages: PDF_MAX_PAGES,
  maxStreams: PDF_MAX_STREAMS,
  scanTimeoutMs: DEFAULT_SCAN_TIMEOUT_MS,
});

export type DocumentProcessingEnvironment =
  "development" | "production" | "staging" | "test";

export type DocumentProcessingRejectionCode =
  | "ACTIVE_PDF_CONTENT"
  | "DOCUMENT_TOO_COMPLEX"
  | "ENCRYPTED_PDF"
  | "MALFORMED_PDF"
  | "MALWARE_DETECTED"
  | "MALWARE_SCAN_UNSCANNABLE"
  | "MIME_SIGNATURE_MISMATCH"
  | "UNSUPPORTED_DOCUMENT_FORMAT";

export class DocumentProcessingRejectedError extends Error {
  readonly code: DocumentProcessingRejectionCode;

  constructor(code: DocumentProcessingRejectionCode) {
    super(`Document processing rejected: ${code}`);
    this.code = code;
    this.name = "DocumentProcessingRejectedError";
  }
}

export interface DocumentValidationJob {
  readonly assetId: string;
}

export interface ValidatedPdfDocument {
  readonly body: Uint8Array;
  readonly contentSha256: string;
  readonly pageCount: number;
}

export type MalwareScanVerdict = Readonly<{
  contentSha256: string;
  engine: string;
  engineVersion: string;
  scannedAt: Date;
  signatureVersion: string;
  verdict: "CLEAN" | "INFECTED" | "UNSCANNABLE";
}>;

export interface ActiveMalwareScanner {
  readonly assurance: "ACTIVE";
  scan(input: {
    readonly body: Uint8Array;
    readonly contentSha256: string;
    readonly contentType: "application/pdf";
    readonly signal: AbortSignal;
  }): Promise<MalwareScanVerdict>;
}

export interface TestOnlyBypassMalwareScanner {
  readonly assurance: "BYPASS_TEST_ONLY";
}

export type MalwareScanner =
  ActiveMalwareScanner | TestOnlyBypassMalwareScanner;

export async function validatePdfDocument(
  body: Uint8Array,
  declaredContentType: string,
): Promise<ValidatedPdfDocument> {
  assertPdfBodyBoundary(body);
  if (declaredContentType.trim().toLowerCase() !== "application/pdf") {
    throw new DocumentProcessingRejectedError("MIME_SIGNATURE_MISMATCH");
  }

  const source = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (
    !/^%PDF-(?:1\.[0-7]|2\.0)(?:\r|\n)/u.test(source.toString("latin1", 0, 10))
  ) {
    throw new DocumentProcessingRejectedError("UNSUPPORTED_DOCUMENT_FORMAT");
  }
  assertFinalEofMarker(source);
  assertStaticPdfComplexity(source);
  assertNotEncrypted(source);
  assertNoActiveContentNames(source);

  const loadingTask = getDocument({
    data: body.slice(),
    disableFontFace: true,
    enableXfa: false,
    maxImageSize: PDF_MAX_IMAGE_PIXELS,
    stopAtErrors: true,
    useSystemFonts: false,
    useWasm: false,
  });
  // Password-protected PDFs are intentionally not accepted into alpha.
  loadingTask.onPassword = () => {
    void loadingTask.destroy();
  };

  try {
    const document = await loadingTask.promise;
    if (document.numPages < 1 || document.numPages > PDF_MAX_PAGES) {
      throw new DocumentProcessingRejectedError("DOCUMENT_TOO_COMPLEX");
    }
    const [attachments, documentJavaScript] = await Promise.all([
      document.getAttachments(),
      document.getJSActions(),
    ]);
    if (
      (attachments !== null && attachments.size > 0) ||
      (documentJavaScript !== null && documentJavaScript.size > 0)
    ) {
      throw new DocumentProcessingRejectedError("ACTIVE_PDF_CONTENT");
    }

    let totalOperators = 0;
    let totalAnnotations = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const [operators, annotations, pageJavaScript] = await Promise.all([
        page.getOperatorList(),
        page.getAnnotations({ intent: "display" }),
        page.getJSActions(),
      ]);
      if (pageJavaScript !== null && pageJavaScript.size > 0) {
        throw new DocumentProcessingRejectedError("ACTIVE_PDF_CONTENT");
      }
      if (operators.fnArray.length > PDF_MAX_OPERATORS_PER_PAGE) {
        throw new DocumentProcessingRejectedError("DOCUMENT_TOO_COMPLEX");
      }
      totalOperators += operators.fnArray.length;
      totalAnnotations += annotations.length;
      if (
        totalOperators > PDF_MAX_OPERATORS_TOTAL ||
        totalAnnotations > PDF_MAX_ANNOTATIONS_TOTAL
      ) {
        throw new DocumentProcessingRejectedError("DOCUMENT_TOO_COMPLEX");
      }
    }

    return Object.freeze({
      body,
      contentSha256: createHash("sha256").update(body).digest("hex"),
      pageCount: document.numPages,
    });
  } catch (error: unknown) {
    if (error instanceof DocumentProcessingRejectedError) throw error;
    if (isPasswordException(error)) {
      throw new DocumentProcessingRejectedError("ENCRYPTED_PDF");
    }
    throw new DocumentProcessingRejectedError("MALFORMED_PDF");
  } finally {
    await loadingTask.destroy().catch(() => undefined);
  }
}

export function createDocumentValidationQueueHandler(input: {
  readonly environment: DocumentProcessingEnvironment;
  readonly orphanedObjectObserver: OrphanedPrivateObjectObserver;
  readonly repository: DocumentProcessingRepository;
  readonly scanner: MalwareScanner;
  readonly storage: ObjectStorageService;
  readonly now?: () => Date;
  readonly scanTimeoutMs?: number;
}): QueueHandler<DocumentValidationJob> {
  assertScannerEnvironment(input.environment, input.scanner);
  const now = input.now ?? (() => new Date());
  const scanTimeoutMs = input.scanTimeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(scanTimeoutMs) ||
    scanTimeoutMs < 100 ||
    scanTimeoutMs > 120_000
  ) {
    throw new RangeError(
      "Document scan timeout must be between 100 and 120000 ms",
    );
  }

  return async (job) => {
    if (!isUuid(job.assetId)) {
      throw new NonRetryableJobError("INVALID_MEDIA_ASSET_ID");
    }

    let source: Awaited<
      ReturnType<DocumentProcessingRepository["findDocumentProcessingSource"]>
    >;
    try {
      source = await input.repository.findDocumentProcessingSource(job.assetId);
    } catch {
      throw new RetryableJobError("DOCUMENT_SOURCE_METADATA_LOAD_FAILED");
    }
    if (source === null) {
      throw new NonRetryableJobError("MEDIA_ASSET_NOT_FOUND");
    }
    if (source.id !== job.assetId || !isUuid(source.id)) {
      throw new NonRetryableJobError("INVALID_MEDIA_SOURCE_METADATA");
    }
    if (source.status !== "PROCESSING") return;
    if (source.kind !== "DOCUMENT") {
      await rejectOrRetry(
        input.repository,
        source.id,
        "UNSUPPORTED_DOCUMENT_FORMAT",
      );
      return;
    }
    if (source.originalStorageObject.area !== "private") {
      throw new NonRetryableJobError("INVALID_MEDIA_SOURCE_STORAGE_AREA");
    }

    let body: Uint8Array;
    try {
      body = await input.storage.readPrivateForProcessing({
        maximumBytes: MEDIA_UPLOAD_LIMITS.documentMaxBytes,
        object: source.originalStorageObject,
      });
    } catch {
      throw new RetryableJobError("DOCUMENT_SOURCE_STORAGE_UNAVAILABLE");
    }

    let document: ValidatedPdfDocument;
    try {
      document = await validatePdfDocument(body, source.declaredContentType);
    } catch (error: unknown) {
      if (!(error instanceof DocumentProcessingRejectedError)) {
        throw new RetryableJobError("DOCUMENT_VALIDATION_UNEXPECTED");
      }
      await rejectOrRetry(input.repository, source.id, error.code);
      return;
    }

    if (input.scanner.assurance !== "ACTIVE") {
      throw new RetryableJobError("DOCUMENT_SCANNER_NOT_CONFIGURED");
    }

    let scan: MalwareScanVerdict;
    try {
      scan = await scanWithTimeout(input.scanner, document, scanTimeoutMs);
    } catch {
      throw new RetryableJobError("DOCUMENT_MALWARE_SCAN_UNAVAILABLE");
    }
    assertScanEvidence(scan, document.contentSha256, now());
    if (scan.verdict !== "CLEAN") {
      await rejectOrRetry(
        input.repository,
        source.id,
        scan.verdict === "INFECTED"
          ? "MALWARE_DETECTED"
          : "MALWARE_SCAN_UNSCANNABLE",
      );
      return;
    }

    let stored: StoredDocumentCanonical;
    try {
      const storageObject = await input.storage.storePrivate({
        body: document.body,
        contentType: "application/pdf",
      });
      stored = Object.freeze({
        byteSize: document.body.byteLength,
        contentSha256: document.contentSha256,
        contentType: "application/pdf" as const,
        role: "CANONICAL" as const,
        storageObject,
      });
    } catch {
      throw new RetryableJobError("DOCUMENT_CANONICAL_STORAGE_FAILED");
    }

    try {
      const completion = await input.repository.completeDocumentProcessing({
        assetId: source.id,
        canonical: stored,
        pageCount: document.pageCount,
        scan: toCleanScanEvidence(scan),
      });
      if (completion.transition !== "UPDATED") {
        await observeCanonicalOrphan(input.orphanedObjectObserver, stored);
      }
    } catch {
      await observeCanonicalOrphan(input.orphanedObjectObserver, stored);
      throw new RetryableJobError("DOCUMENT_CANONICAL_PERSISTENCE_FAILED");
    }
  };
}

function assertPdfBodyBoundary(body: Uint8Array): void {
  if (
    !(body instanceof Uint8Array) ||
    body.byteLength === 0 ||
    body.byteLength > MEDIA_UPLOAD_LIMITS.documentMaxBytes
  ) {
    throw new DocumentProcessingRejectedError("MALFORMED_PDF");
  }
}

function assertFinalEofMarker(source: Buffer): void {
  const tailStart = Math.max(0, source.byteLength - 1_024);
  const tail = source.toString("latin1", tailStart);
  const marker = tail.lastIndexOf("%%EOF");
  if (marker < 0 || !/^[\t\n\f\r ]*$/u.test(tail.slice(marker + 5))) {
    throw new DocumentProcessingRejectedError("MALFORMED_PDF");
  }
}

function assertStaticPdfComplexity(source: Buffer): void {
  const text = source.toString("latin1");
  const objectCount = countMatches(
    text,
    /(?:^|[\r\n])[\t ]*\d{1,10}[\t ]+\d{1,5}[\t ]+obj\b/gu,
  );
  const streamCount = countMatches(
    text,
    /(?:^|[\r\n])[\t ]*stream(?:\r?\n|\r)/gu,
  );
  if (objectCount < 1) {
    throw new DocumentProcessingRejectedError("MALFORMED_PDF");
  }
  if (objectCount > PDF_MAX_OBJECTS || streamCount > PDF_MAX_STREAMS) {
    throw new DocumentProcessingRejectedError("DOCUMENT_TOO_COMPLEX");
  }
}

function assertNotEncrypted(source: Buffer): void {
  if (/\/Encrypt\b/iu.test(decodePdfNames(source))) {
    throw new DocumentProcessingRejectedError("ENCRYPTED_PDF");
  }
}

function assertNoActiveContentNames(source: Buffer): void {
  const decodedNames = decodePdfNames(source);
  if (
    /\/(?:EmbeddedFile|Filespec|ImportData|JavaScript|JS|Launch|Movie|RichMedia|Sound|SubmitForm|XFA)\b/iu.test(
      decodedNames,
    )
  ) {
    throw new DocumentProcessingRejectedError("ACTIVE_PDF_CONTENT");
  }
}

function decodePdfNames(source: Buffer): string {
  return source
    .toString("latin1")
    .replace(/#([0-9a-f]{2})/giu, (match, hex: string) => {
      if (match.length !== 3) return match;
      return String.fromCharCode(Number.parseInt(hex, 16));
    });
}

function countMatches(value: string, pattern: RegExp): number {
  let count = 0;
  const matches = value.matchAll(pattern);
  while (!matches.next().done) {
    count += 1;
  }
  return count;
}

async function scanWithTimeout(
  scanner: ActiveMalwareScanner,
  document: ValidatedPdfDocument,
  timeoutMs: number,
): Promise<MalwareScanVerdict> {
  const abortController = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      abortController.abort();
      reject(new Error("Malware scan timed out"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      scanner.scan({
        body: document.body,
        contentSha256: document.contentSha256,
        contentType: "application/pdf",
        signal: abortController.signal,
      }),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function assertScanEvidence(
  scan: MalwareScanVerdict,
  expectedContentSha256: string,
  now: Date,
): void {
  const scannedAt = scan.scannedAt.valueOf();
  if (
    scan.contentSha256 !== expectedContentSha256 ||
    !/^[0-9a-f]{64}$/u.test(scan.contentSha256) ||
    !boundedIdentifierPattern.test(scan.engine) ||
    !boundedIdentifierPattern.test(scan.engineVersion) ||
    !boundedIdentifierPattern.test(scan.signatureVersion) ||
    !Number.isFinite(scannedAt) ||
    scannedAt < now.valueOf() - MAX_SCAN_EVIDENCE_AGE_MS ||
    scannedAt > now.valueOf() + MAX_CLOCK_SKEW_MS
  ) {
    throw new RetryableJobError("DOCUMENT_MALWARE_SCAN_EVIDENCE_INVALID");
  }
}

function toCleanScanEvidence(
  scan: MalwareScanVerdict,
): CleanDocumentScanEvidence {
  if (scan.verdict !== "CLEAN") {
    throw new RetryableJobError("DOCUMENT_MALWARE_SCAN_EVIDENCE_INVALID");
  }
  return Object.freeze({
    assurance: "ACTIVE" as const,
    contentSha256: scan.contentSha256,
    engine: scan.engine,
    engineVersion: scan.engineVersion,
    scannedAt: scan.scannedAt,
    signatureVersion: scan.signatureVersion,
    verdict: "CLEAN" as const,
  });
}

function assertScannerEnvironment(
  environment: DocumentProcessingEnvironment,
  scanner: MalwareScanner,
): void {
  if (
    (environment === "production" || environment === "staging") &&
    scanner.assurance !== "ACTIVE"
  ) {
    throw new Error(
      "An active malware scanner is mandatory outside local/test environments",
    );
  }
}

async function rejectOrRetry(
  repository: DocumentProcessingRepository,
  assetId: string,
  rejectionCode: DocumentProcessingRejectionCode,
): Promise<void> {
  try {
    await repository.recordMediaProcessingRejected({ assetId, rejectionCode });
  } catch {
    throw new RetryableJobError("DOCUMENT_REJECTION_PERSISTENCE_FAILED");
  }
}

async function observeCanonicalOrphan(
  observer: OrphanedPrivateObjectObserver,
  canonical: StoredDocumentCanonical,
): Promise<void> {
  await Promise.allSettled([
    observer.recordOrphanedPrivateObject({
      reason: "DERIVATIVE_PERSISTENCE_FAILED",
      storageObject: canonical.storageObject,
    }),
  ]);
}

function isPasswordException(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "PasswordException"
  );
}

function isUuid(value: string): boolean {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}
