import type { StoredObjectReference } from "@portal/storage";

export const MEDIA_ASSET_STATUSES = Object.freeze([
  "PROCESSING",
  "READY",
  "REJECTED",
] as const);

export type MediaAssetStatus = (typeof MEDIA_ASSET_STATUSES)[number];

export const MEDIA_KINDS = Object.freeze(["IMAGE", "DOCUMENT"] as const);
export type MediaKind = (typeof MEDIA_KINDS)[number];

export const MEDIA_UPLOAD_PURPOSES = Object.freeze([
  "PROFILE_IMAGE",
  "PORTFOLIO_IMAGE",
  "JOB_REQUEST_IMAGE",
  "JOB_REQUEST_DOCUMENT",
  "JOB_IMAGE",
  "JOB_DOCUMENT",
  "CHAT_IMAGE",
  "CHAT_DOCUMENT",
  "CREDENTIAL_DOCUMENT",
  "CREDENTIAL_IMAGE",
  "QUOTE_DOCUMENT",
  "CHANGE_ORDER_DOCUMENT",
  "DISPUTE_EVIDENCE",
] as const);

export type MediaUploadPurpose = (typeof MEDIA_UPLOAD_PURPOSES)[number];

export const MEDIA_PROVENANCE_ENTITY_TYPES = Object.freeze([
  "USER_PROFILE",
  "PORTFOLIO_PROJECT",
  "JOB_REQUEST",
  "JOB",
  "JOB_PARTICIPANT",
  "CONVERSATION_MESSAGE",
  "CREDENTIAL",
  "QUOTE_REVISION",
  "CHANGE_ORDER_REVISION",
  "DISPUTE_CASE",
] as const);

export type MediaProvenanceEntityType =
  (typeof MEDIA_PROVENANCE_ENTITY_TYPES)[number];

const trustedMediaProvenance = Symbol("portal.media.trusted-provenance");
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface ServerMediaProvenance {
  readonly entityId: string | null;
  readonly entityRevision: number | null;
  readonly entityType: MediaProvenanceEntityType | null;
  readonly [trustedMediaProvenance]: true;
}

/**
 * Creates provenance only from a relation already resolved by server code.
 * Raw request bodies must never be cast to this type.
 */
export function createServerMediaProvenance(
  source?: Readonly<{
    entityId: string;
    entityRevision?: number;
    entityType: MediaProvenanceEntityType;
  }>,
): ServerMediaProvenance {
  if (source === undefined) {
    return Object.freeze({
      entityId: null,
      entityRevision: null,
      entityType: null,
      [trustedMediaProvenance]: true as const,
    });
  }
  if (!MEDIA_PROVENANCE_ENTITY_TYPES.includes(source.entityType)) {
    throw new Error("Unsupported media provenance entity type");
  }
  if (!uuidPattern.test(source.entityId)) {
    throw new Error("Media provenance requires a valid server-resolved UUID");
  }
  const entityRevision = source.entityRevision ?? null;
  if (
    entityRevision !== null &&
    (!Number.isSafeInteger(entityRevision) || entityRevision < 1)
  ) {
    throw new Error("Media provenance revision must be a positive integer");
  }

  return Object.freeze({
    entityId: source.entityId.toLowerCase(),
    entityRevision,
    entityType: source.entityType,
    [trustedMediaProvenance]: true as const,
  });
}

export function isServerMediaProvenance(
  value: unknown,
): value is ServerMediaProvenance {
  return (
    typeof value === "object" &&
    value !== null &&
    trustedMediaProvenance in value &&
    value[trustedMediaProvenance] === true
  );
}

export interface CreateProcessingMediaAssetInput {
  readonly byteSize: number;
  readonly declaredContentType: string;
  readonly displayFilename: string | null;
  readonly kind: MediaKind;
  readonly ownerUserId: string;
  readonly provenanceEntityId: string | null;
  readonly provenanceEntityRevision: number | null;
  readonly provenanceEntityType: MediaProvenanceEntityType | null;
  readonly purpose: MediaUploadPurpose;
  readonly storageObject: StoredObjectReference;
  readonly uploaderUserId: string;
}

export interface ProcessingMediaAsset {
  readonly byteSize: number;
  readonly createdAt: Date;
  readonly declaredContentType: string;
  readonly displayFilename: string | null;
  readonly id: string;
  readonly kind: MediaKind;
  readonly ownerUserId: string;
  readonly provenanceEntityId: string | null;
  readonly provenanceEntityRevision: number | null;
  readonly provenanceEntityType: MediaProvenanceEntityType | null;
  readonly purpose: MediaUploadPurpose;
  readonly status: "PROCESSING";
  readonly storageObject: StoredObjectReference;
  readonly updatedAt: Date;
  readonly uploaderUserId: string;
}

export interface MediaAssetUploadRepository {
  createProcessingAsset(
    input: CreateProcessingMediaAssetInput,
  ): Promise<ProcessingMediaAsset>;
}

export type MediaProcessingTransitionResult =
  | Readonly<{
      assetId: string;
      rejectionCode: null;
      status: "READY";
      statusChangedAt: Date;
      transition: "UPDATED";
    }>
  | Readonly<{
      assetId: string;
      rejectionCode: string;
      status: "REJECTED";
      statusChangedAt: Date;
      transition: "UPDATED";
    }>
  | Readonly<{ transition: "NOT_PROCESSING" }>;

export interface MediaAssetProcessingRepository {
  recordMediaProcessingSucceeded(
    assetId: string,
  ): Promise<MediaProcessingTransitionResult>;
  recordMediaProcessingRejected(input: {
    readonly assetId: string;
    readonly rejectionCode: string;
  }): Promise<MediaProcessingTransitionResult>;
}

export interface ImageProcessingAssetSource {
  readonly declaredContentType: string;
  readonly id: string;
  readonly kind: MediaKind;
  readonly originalStorageObject: StoredObjectReference;
  readonly status: MediaAssetStatus;
}

export interface DocumentProcessingAssetSource {
  readonly declaredContentType: string;
  readonly id: string;
  readonly kind: MediaKind;
  readonly originalStorageObject: StoredObjectReference;
  readonly status: MediaAssetStatus;
}

export interface StoredDocumentCanonical {
  readonly byteSize: number;
  readonly contentSha256: string;
  readonly contentType: "application/pdf";
  readonly role: "CANONICAL";
  readonly storageObject: StoredObjectReference;
}

export interface CleanDocumentScanEvidence {
  readonly assurance: "ACTIVE";
  readonly contentSha256: string;
  readonly engine: string;
  readonly engineVersion: string;
  readonly scannedAt: Date;
  readonly signatureVersion: string;
  readonly verdict: "CLEAN";
}

export interface CompleteDocumentProcessingInput {
  readonly assetId: string;
  readonly canonical: StoredDocumentCanonical;
  readonly pageCount: number;
  readonly scan: CleanDocumentScanEvidence;
}

export type DocumentProcessingCompletionResult =
  | Readonly<{ transition: "UPDATED" }>
  | Readonly<{ transition: "ALREADY_READY" }>
  | Readonly<{ transition: "NOT_PROCESSING" }>;

export interface DocumentProcessingRepository extends MediaAssetProcessingRepository {
  completeDocumentProcessing(
    input: CompleteDocumentProcessingInput,
  ): Promise<DocumentProcessingCompletionResult>;
  findDocumentProcessingSource(
    assetId: string,
  ): Promise<DocumentProcessingAssetSource | null>;
}

export interface StoredImageDerivative {
  readonly byteSize: number;
  readonly contentSha256: string;
  readonly contentType: "image/webp";
  readonly role: "CANONICAL" | "THUMBNAIL";
  readonly storageObject: StoredObjectReference;
}

export interface CompleteImageProcessingInput {
  readonly assetId: string;
  readonly canonicalHeight: number;
  readonly canonicalWidth: number;
  readonly capturedAt: Date | null;
  readonly derivatives: readonly [StoredImageDerivative, StoredImageDerivative];
}

export type ImageProcessingCompletionResult =
  | Readonly<{ transition: "UPDATED" }>
  | Readonly<{ transition: "ALREADY_READY" }>
  | Readonly<{ transition: "NOT_PROCESSING" }>;

export interface ImageProcessingRepository extends MediaAssetProcessingRepository {
  completeImageProcessing(
    input: CompleteImageProcessingInput,
  ): Promise<ImageProcessingCompletionResult>;
  findImageProcessingSource(
    assetId: string,
  ): Promise<ImageProcessingAssetSource | null>;
}

export interface MediaAssetRepository
  extends MediaAssetUploadRepository, MediaAssetProcessingRepository {}
