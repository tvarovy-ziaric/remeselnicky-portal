import { createHash } from "node:crypto";

import {
  NonRetryableJobError,
  RetryableJobError,
  type QueueHandler,
} from "@portal/queue";
import { type ObjectStorageService } from "@portal/storage";
import readExif from "exif-reader";
import sharp, { type Metadata, type OutputInfo, type Sharp } from "sharp";

import type {
  ImageProcessingRepository,
  StoredImageDerivative,
} from "./model.js";
import {
  MEDIA_UPLOAD_LIMITS,
  type OrphanedPrivateObjectObserver,
} from "./upload.js";

const MAX_INPUT_PIXELS = 40_000_000;
const MAX_INPUT_DIMENSION = 12_000;
const CANONICAL_MAX_DIMENSION = 2_560;
const THUMBNAIL_MAX_DIMENSION = 384;
const WEBP_QUALITY = 82;

export const IMAGE_CANONICALIZATION_JOB_NAME =
  "media.image.canonicalize" as const;

export const IMAGE_PROCESSING_LIMITS = Object.freeze({
  canonicalMaxDimension: CANONICAL_MAX_DIMENSION,
  inputMaxBytes: MEDIA_UPLOAD_LIMITS.imageMaxBytes,
  inputMaxDimension: MAX_INPUT_DIMENSION,
  inputMaxPixels: MAX_INPUT_PIXELS,
  thumbnailMaxDimension: THUMBNAIL_MAX_DIMENSION,
  webpQuality: WEBP_QUALITY,
});

export const IMAGE_RUNTIME_CAPABILITIES = Object.freeze({
  /** Official prebuilds commonly expose AVIF-only libheif support. */
  heicDecode:
    sharp.format.heif.input.fileSuffix?.some((suffix) =>
      [".heic", ".heif"].includes(suffix.toLowerCase()),
    ) ?? false,
});

export type ImageProcessingRejectionCode =
  | "DECOMPRESSION_BOMB"
  | "MALFORMED_IMAGE"
  | "MIME_SIGNATURE_MISMATCH"
  | "UNSUPPORTED_IMAGE_FORMAT";

export class ImageProcessingRejectedError extends Error {
  readonly code: ImageProcessingRejectionCode;

  constructor(code: ImageProcessingRejectionCode) {
    super(`Image processing rejected: ${code}`);
    this.code = code;
    this.name = "ImageProcessingRejectedError";
  }
}

export interface ImageCanonicalizationJob {
  readonly assetId: string;
}

interface CanonicalImageDerivative {
  readonly body: Uint8Array;
  readonly height: number;
  readonly width: number;
}

export interface CanonicalizedImage {
  readonly canonical: CanonicalImageDerivative;
  readonly capturedAt: Date | null;
  readonly thumbnail: CanonicalImageDerivative;
}

export function detectImageSignature(
  body: Uint8Array,
): "image/heif" | "image/jpeg" | "image/png" | null {
  if (
    body.length >= 3 &&
    body[0] === 0xff &&
    body[1] === 0xd8 &&
    body[2] === 0xff
  ) {
    return "image/jpeg";
  }
  const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (
    body.length >= pngSignature.length &&
    pngSignature.every((value, index) => body[index] === value)
  ) {
    return "image/png";
  }
  if (hasHeifFileTypeBox(body)) return "image/heif";
  return null;
}

export async function canonicalizeImage(input: {
  readonly body: Uint8Array;
  readonly declaredContentType: string;
  readonly now?: () => Date;
}): Promise<CanonicalizedImage> {
  assertBodyBoundary(input.body);
  const signature = detectImageSignature(input.body);
  assertSignatureMatchesDeclaration(signature, input.declaredContentType);
  if (
    signature === "image/heif" &&
    hasHevcBrand(input.body) &&
    !IMAGE_RUNTIME_CAPABILITIES.heicDecode
  ) {
    throw new ImageProcessingRejectedError("UNSUPPORTED_IMAGE_FORMAT");
  }

  let metadata: Metadata;
  try {
    metadata = await sharp(input.body, sharpInputOptions()).metadata();
  } catch {
    throw new ImageProcessingRejectedError("MALFORMED_IMAGE");
  }
  assertDecodedMetadata(metadata, signature);
  const capturedAt = extractReliableCapturedAt(
    metadata.exif,
    (input.now ?? (() => new Date()))(),
  );

  try {
    const decoded = sharp(input.body, sharpInputOptions()).autoOrient();
    const [canonical, thumbnail] = await Promise.all([
      encodeDerivative(decoded.clone(), CANONICAL_MAX_DIMENSION),
      encodeDerivative(decoded.clone(), THUMBNAIL_MAX_DIMENSION),
    ]);
    return Object.freeze({ canonical, capturedAt, thumbnail });
  } catch (error: unknown) {
    if (error instanceof ImageProcessingRejectedError) throw error;
    throw new ImageProcessingRejectedError("MALFORMED_IMAGE");
  }
}

export function createImageCanonicalizationQueueHandler(input: {
  readonly orphanedObjectObserver: OrphanedPrivateObjectObserver;
  readonly repository: ImageProcessingRepository;
  readonly storage: ObjectStorageService;
  readonly now?: () => Date;
}): QueueHandler<ImageCanonicalizationJob> {
  return async (job) => {
    if (!isUuid(job.assetId)) {
      throw new NonRetryableJobError("INVALID_MEDIA_ASSET_ID");
    }

    let source: Awaited<
      ReturnType<ImageProcessingRepository["findImageProcessingSource"]>
    >;
    try {
      source = await input.repository.findImageProcessingSource(job.assetId);
    } catch {
      throw new RetryableJobError("IMAGE_SOURCE_METADATA_LOAD_FAILED");
    }
    if (source === null) {
      throw new NonRetryableJobError("MEDIA_ASSET_NOT_FOUND");
    }
    if (source.id !== job.assetId || !isUuid(source.id)) {
      throw new NonRetryableJobError("INVALID_MEDIA_SOURCE_METADATA");
    }
    if (source.status !== "PROCESSING") return;
    if (source.kind !== "IMAGE") {
      await rejectOrRetry(
        input.repository,
        source.id,
        "UNSUPPORTED_IMAGE_FORMAT",
      );
      return;
    }
    if (source.originalStorageObject.area !== "private") {
      throw new NonRetryableJobError("INVALID_MEDIA_SOURCE_STORAGE_AREA");
    }

    let body: Uint8Array;
    try {
      body = await input.storage.readPrivateForProcessing({
        maximumBytes: MEDIA_UPLOAD_LIMITS.imageMaxBytes,
        object: source.originalStorageObject,
      });
    } catch {
      throw new RetryableJobError("IMAGE_SOURCE_STORAGE_UNAVAILABLE");
    }

    let image: CanonicalizedImage;
    try {
      image = await canonicalizeImage({
        body,
        declaredContentType: source.declaredContentType,
        ...(input.now === undefined ? {} : { now: input.now }),
      });
    } catch (error: unknown) {
      if (!(error instanceof ImageProcessingRejectedError)) {
        throw new RetryableJobError("IMAGE_PROCESSING_UNEXPECTED");
      }
      await rejectOrRetry(input.repository, source.id, error.code);
      return;
    }

    const stored: StoredImageDerivative[] = [];
    try {
      stored.push(
        await storeDerivative(input.storage, "CANONICAL", image.canonical),
      );
      stored.push(
        await storeDerivative(input.storage, "THUMBNAIL", image.thumbnail),
      );
    } catch {
      await observeOrphans(
        input.orphanedObjectObserver,
        stored,
        "PARTIAL_DERIVATIVE_STORAGE",
      );
      throw new RetryableJobError("IMAGE_DERIVATIVE_STORAGE_FAILED");
    }

    try {
      const completion = await input.repository.completeImageProcessing({
        assetId: source.id,
        canonicalHeight: image.canonical.height,
        canonicalWidth: image.canonical.width,
        capturedAt: image.capturedAt,
        derivatives: requireDerivativeTuple(stored),
      });
      if (completion.transition !== "UPDATED") {
        await observeOrphans(
          input.orphanedObjectObserver,
          stored,
          "DERIVATIVE_PERSISTENCE_FAILED",
        );
      }
    } catch {
      await observeOrphans(
        input.orphanedObjectObserver,
        stored,
        "DERIVATIVE_PERSISTENCE_FAILED",
      );
      throw new RetryableJobError("IMAGE_DERIVATIVE_PERSISTENCE_FAILED");
    }
  };
}

function sharpInputOptions() {
  return {
    animated: false,
    failOn: "warning" as const,
    limitInputPixels: MAX_INPUT_PIXELS,
    sequentialRead: true,
    unlimited: false,
  };
}

function assertBodyBoundary(body: Uint8Array): void {
  if (
    !(body instanceof Uint8Array) ||
    body.byteLength === 0 ||
    body.byteLength > MEDIA_UPLOAD_LIMITS.imageMaxBytes
  ) {
    throw new ImageProcessingRejectedError("MALFORMED_IMAGE");
  }
}

function assertSignatureMatchesDeclaration(
  signature: ReturnType<typeof detectImageSignature>,
  declaredContentType: string,
): asserts signature is Exclude<ReturnType<typeof detectImageSignature>, null> {
  if (signature === null) {
    throw new ImageProcessingRejectedError("UNSUPPORTED_IMAGE_FORMAT");
  }
  const declared = declaredContentType.trim().toLowerCase();
  const matches =
    signature === declared ||
    (signature === "image/heif" &&
      (declared === "image/heif" || declared === "image/heic"));
  if (!matches) {
    throw new ImageProcessingRejectedError("MIME_SIGNATURE_MISMATCH");
  }
}

function assertDecodedMetadata(
  metadata: Metadata,
  signature: Exclude<ReturnType<typeof detectImageSignature>, null>,
): void {
  const expectedFormat =
    signature === "image/jpeg"
      ? "jpeg"
      : signature === "image/png"
        ? "png"
        : "heif";
  if (metadata.format !== expectedFormat) {
    throw new ImageProcessingRejectedError("MIME_SIGNATURE_MISMATCH");
  }
  const width = metadata.width;
  const height = metadata.height;
  if (
    width === undefined ||
    height === undefined ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1
  ) {
    throw new ImageProcessingRejectedError("MALFORMED_IMAGE");
  }
  if (
    width > MAX_INPUT_DIMENSION ||
    height > MAX_INPUT_DIMENSION ||
    width * height > MAX_INPUT_PIXELS ||
    (metadata.pages ?? 1) !== 1
  ) {
    throw new ImageProcessingRejectedError("DECOMPRESSION_BOMB");
  }
}

async function encodeDerivative(
  pipeline: Sharp,
  maximumDimension: number,
): Promise<CanonicalImageDerivative> {
  const output = await pipeline
    .resize({
      fit: "inside",
      height: maximumDimension,
      kernel: sharp.kernel.lanczos3,
      width: maximumDimension,
      withoutEnlargement: true,
    })
    .webp({ effort: 4, quality: WEBP_QUALITY, smartSubsample: true })
    .toBuffer({ resolveWithObject: true });
  return derivativeFromOutput(output);
}

function derivativeFromOutput(output: {
  readonly data: Buffer;
  readonly info: OutputInfo;
}): CanonicalImageDerivative {
  if (output.info.width < 1 || output.info.height < 1) {
    throw new ImageProcessingRejectedError("MALFORMED_IMAGE");
  }
  return Object.freeze({
    body: new Uint8Array(output.data),
    height: output.info.height,
    width: output.info.width,
  });
}

function extractReliableCapturedAt(
  rawExif: Buffer | undefined,
  now: Date,
): Date | null {
  if (rawExif === undefined || !Number.isFinite(now.valueOf())) return null;
  try {
    const exif = readExif(rawExif);
    const localDate = exif.Photo?.DateTimeOriginal;
    const offset = exif.Photo?.OffsetTimeOriginal;
    if (!(localDate instanceof Date) || typeof offset !== "string") return null;
    const match = /^([+-])(0\d|1[0-4]):([0-5]\d)$/u.exec(offset);
    if (match === null) return null;
    const direction = match[1] === "+" ? 1 : -1;
    const hours = Number(match[2]);
    const minutes = Number(match[3]);
    if (hours === 14 && minutes !== 0) return null;
    const capturedAt = new Date(
      localDate.valueOf() - direction * (hours * 60 + minutes) * 60_000,
    );
    const earliest = Date.UTC(2000, 0, 1);
    const latest = now.valueOf() + 24 * 60 * 60 * 1_000;
    return capturedAt.valueOf() >= earliest && capturedAt.valueOf() <= latest
      ? capturedAt
      : null;
  } catch {
    return null;
  }
}

function hasHeifFileTypeBox(body: Uint8Array): boolean {
  if (
    body.length < 16 ||
    body[4] !== 0x66 ||
    body[5] !== 0x74 ||
    body[6] !== 0x79 ||
    body[7] !== 0x70
  ) {
    return false;
  }
  const size =
    ((body[0] ?? 0) << 24) |
    ((body[1] ?? 0) << 16) |
    ((body[2] ?? 0) << 8) |
    (body[3] ?? 0);
  if (size < 16 || size > body.length || size > 256) return false;
  const allowedBrands = new Set([
    "heic",
    "heix",
    "heim",
    "heis",
    "hevc",
    "hevx",
    "mif1",
    "msf1",
  ]);
  for (const brand of heifBrands(body, size)) {
    if (allowedBrands.has(brand)) return true;
  }
  return false;
}

function hasHevcBrand(body: Uint8Array): boolean {
  const size = heifBoxSize(body);
  if (size === null) return false;
  const hevcBrands = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx"]);
  return heifBrands(body, size).some((brand) => hevcBrands.has(brand));
}

function heifBoxSize(body: Uint8Array): number | null {
  if (
    body.length < 16 ||
    body[4] !== 0x66 ||
    body[5] !== 0x74 ||
    body[6] !== 0x79 ||
    body[7] !== 0x70
  ) {
    return null;
  }
  const size =
    ((body[0] ?? 0) << 24) |
    ((body[1] ?? 0) << 16) |
    ((body[2] ?? 0) << 8) |
    (body[3] ?? 0);
  return size >= 16 && size <= body.length && size <= 256 ? size : null;
}

function heifBrands(body: Uint8Array, size: number): string[] {
  const brands: string[] = [];
  for (let offset = 8; offset + 4 <= size; offset += 4) {
    brands.push(String.fromCharCode(...body.slice(offset, offset + 4)));
  }
  return brands;
}

async function storeDerivative(
  storage: ObjectStorageService,
  role: StoredImageDerivative["role"],
  derivative: CanonicalImageDerivative,
): Promise<StoredImageDerivative> {
  const storageObject = await storage.storePrivate({
    body: derivative.body,
    contentType: "image/webp",
  });
  return Object.freeze({
    byteSize: derivative.body.byteLength,
    contentSha256: createHash("sha256").update(derivative.body).digest("hex"),
    contentType: "image/webp" as const,
    role,
    storageObject,
  });
}

async function rejectOrRetry(
  repository: ImageProcessingRepository,
  assetId: string,
  rejectionCode: ImageProcessingRejectionCode,
): Promise<void> {
  try {
    await repository.recordMediaProcessingRejected({ assetId, rejectionCode });
  } catch {
    throw new RetryableJobError("IMAGE_REJECTION_PERSISTENCE_FAILED");
  }
}

async function observeOrphans(
  observer: OrphanedPrivateObjectObserver,
  derivatives: readonly StoredImageDerivative[],
  reason: "DERIVATIVE_PERSISTENCE_FAILED" | "PARTIAL_DERIVATIVE_STORAGE",
): Promise<void> {
  await Promise.allSettled(
    derivatives.map(async (derivative) => {
      await observer.recordOrphanedPrivateObject({
        reason,
        storageObject: derivative.storageObject,
      });
    }),
  );
}

function requireDerivativeTuple(
  derivatives: readonly StoredImageDerivative[],
): readonly [StoredImageDerivative, StoredImageDerivative] {
  const canonical = derivatives.find((item) => item.role === "CANONICAL");
  const thumbnail = derivatives.find((item) => item.role === "THUMBNAIL");
  if (canonical === undefined || thumbnail === undefined) {
    throw new RetryableJobError("IMAGE_DERIVATIVE_SET_INCOMPLETE");
  }
  return [canonical, thumbnail];
}

function isUuid(value: string): boolean {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}
