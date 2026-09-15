import type { AuthorizationActor } from "@portal/authorization";
import type { ObjectStorageService } from "@portal/storage";

import {
  MEDIA_UPLOAD_PURPOSES,
  isServerMediaProvenance,
  type MediaAssetUploadRepository,
  type MediaKind,
  type MediaUploadPurpose,
  type ProcessingMediaAsset,
  type ServerMediaProvenance,
} from "./model.js";
import { authorizeMediaUpload } from "./policy.js";

const IMAGE_CONTENT_TYPES = Object.freeze([
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
] as const);
const DOCUMENT_CONTENT_TYPES = Object.freeze(["application/pdf"] as const);
const IMAGE_MAX_BYTES = 15 * 1024 * 1024;
const DOCUMENT_MAX_BYTES = 25 * 1024 * 1024;

const IMAGE_PURPOSES = new Set<MediaUploadPurpose>([
  "PROFILE_IMAGE",
  "PORTFOLIO_IMAGE",
  "JOB_REQUEST_IMAGE",
  "JOB_IMAGE",
  "CHAT_IMAGE",
  "CREDENTIAL_IMAGE",
]);
const DOCUMENT_PURPOSES = new Set<MediaUploadPurpose>([
  "JOB_REQUEST_DOCUMENT",
  "CHAT_DOCUMENT",
  "CREDENTIAL_DOCUMENT",
  "QUOTE_DOCUMENT",
  "CHANGE_ORDER_DOCUMENT",
  "JOB_DOCUMENT",
]);

export const MEDIA_UPLOAD_LIMITS = Object.freeze({
  documentMaxBytes: DOCUMENT_MAX_BYTES,
  imageMaxBytes: IMAGE_MAX_BYTES,
});

export type MediaUploadRejectionCode =
  | "EMPTY_FILE"
  | "FILE_TOO_LARGE"
  | "INVALID_BODY"
  | "INVALID_CONTENT_TYPE"
  | "INVALID_FILENAME"
  | "INVALID_PROVENANCE"
  | "UNAUTHORIZED"
  | "UNSUPPORTED_PURPOSE";

export class MediaUploadRejectedError extends Error {
  readonly code: MediaUploadRejectionCode;

  constructor(code: MediaUploadRejectionCode) {
    super(`Media upload rejected: ${code}`);
    this.name = "MediaUploadRejectedError";
    this.code = code;
  }
}

export interface ControlledMediaUploadService {
  upload(input: {
    readonly actor: AuthorizationActor;
    readonly body: Uint8Array;
    readonly declaredContentType: string;
    readonly originalFilename?: string;
    readonly provenance: ServerMediaProvenance;
    readonly purpose: MediaUploadPurpose;
  }): Promise<ProcessingMediaAsset>;
}

export interface OrphanedPrivateObjectObserver {
  recordOrphanedPrivateObject(
    input: Readonly<{
      reason:
        | "DERIVATIVE_PERSISTENCE_FAILED"
        | "METADATA_PERSISTENCE_FAILED"
        | "PARTIAL_DERIVATIVE_STORAGE";
      storageObject: Awaited<ReturnType<ObjectStorageService["storePrivate"]>>;
    }>,
  ): Promise<void> | void;
}

type ControlledMediaUploadInput = Parameters<
  ControlledMediaUploadService["upload"]
>[0];

export function createControlledMediaUploadService(input: {
  readonly orphanedObjectObserver: OrphanedPrivateObjectObserver;
  readonly repository: MediaAssetUploadRepository;
  readonly storage: ObjectStorageService;
}): ControlledMediaUploadService {
  return Object.freeze({
    async upload(
      uploadInput: ControlledMediaUploadInput,
    ): Promise<ProcessingMediaAsset> {
      if (!MEDIA_UPLOAD_PURPOSES.includes(uploadInput.purpose)) {
        throw new MediaUploadRejectedError("UNSUPPORTED_PURPOSE");
      }
      if (!isServerMediaProvenance(uploadInput.provenance)) {
        throw new MediaUploadRejectedError("INVALID_PROVENANCE");
      }
      if (
        !(await authorizeMediaUpload(uploadInput.actor, uploadInput.purpose))
      ) {
        throw new MediaUploadRejectedError("UNAUTHORIZED");
      }
      if (!(uploadInput.body instanceof Uint8Array)) {
        throw new MediaUploadRejectedError("INVALID_BODY");
      }
      if (
        uploadInput.originalFilename !== undefined &&
        typeof uploadInput.originalFilename !== "string"
      ) {
        throw new MediaUploadRejectedError("INVALID_FILENAME");
      }

      const classification = classifyUpload(
        uploadInput.purpose,
        uploadInput.declaredContentType,
      );
      assertByteSize(uploadInput.body.byteLength, classification.maximumBytes);
      const displayFilename = sanitizeDisplayFilename(
        uploadInput.originalFilename,
      );

      const storageObject = await input.storage.storePrivate({
        body: uploadInput.body,
        contentType: classification.contentType,
      });
      const userId =
        uploadInput.actor.kind === "AUTHENTICATED"
          ? uploadInput.actor.userId
          : failClosedActor();

      try {
        return await input.repository.createProcessingAsset({
          byteSize: uploadInput.body.byteLength,
          declaredContentType: classification.contentType,
          displayFilename,
          kind: classification.kind,
          ownerUserId: userId,
          provenanceEntityId: uploadInput.provenance.entityId,
          provenanceEntityRevision: uploadInput.provenance.entityRevision,
          provenanceEntityType: uploadInput.provenance.entityType,
          purpose: uploadInput.purpose,
          storageObject,
          uploaderUserId: userId,
        });
      } catch (error: unknown) {
        await input.orphanedObjectObserver.recordOrphanedPrivateObject({
          reason: "METADATA_PERSISTENCE_FAILED",
          storageObject,
        });
        throw error;
      }
    },
  });
}

function classifyUpload(
  purpose: MediaUploadPurpose,
  declaredContentType: string,
): Readonly<{
  contentType: string;
  kind: MediaKind;
  maximumBytes: number;
}> {
  if (typeof declaredContentType !== "string") {
    throw new MediaUploadRejectedError("INVALID_CONTENT_TYPE");
  }
  const contentType = declaredContentType.trim().toLowerCase();
  if (IMAGE_PURPOSES.has(purpose)) {
    if (!IMAGE_CONTENT_TYPES.some((allowed) => allowed === contentType)) {
      throw new MediaUploadRejectedError("INVALID_CONTENT_TYPE");
    }
    return { contentType, kind: "IMAGE", maximumBytes: IMAGE_MAX_BYTES };
  }
  if (DOCUMENT_PURPOSES.has(purpose)) {
    if (!DOCUMENT_CONTENT_TYPES.some((allowed) => allowed === contentType)) {
      throw new MediaUploadRejectedError("INVALID_CONTENT_TYPE");
    }
    return { contentType, kind: "DOCUMENT", maximumBytes: DOCUMENT_MAX_BYTES };
  }
  if (purpose === "DISPUTE_EVIDENCE") {
    if (IMAGE_CONTENT_TYPES.some((allowed) => allowed === contentType)) {
      return { contentType, kind: "IMAGE", maximumBytes: IMAGE_MAX_BYTES };
    }
    if (DOCUMENT_CONTENT_TYPES.some((allowed) => allowed === contentType)) {
      return {
        contentType,
        kind: "DOCUMENT",
        maximumBytes: DOCUMENT_MAX_BYTES,
      };
    }
  }
  throw new MediaUploadRejectedError("INVALID_CONTENT_TYPE");
}

function assertByteSize(byteSize: number, maximumBytes: number): void {
  if (byteSize === 0) {
    throw new MediaUploadRejectedError("EMPTY_FILE");
  }
  if (!Number.isSafeInteger(byteSize) || byteSize > maximumBytes) {
    throw new MediaUploadRejectedError("FILE_TOO_LARGE");
  }
}

export function sanitizeDisplayFilename(filename?: string): string | null {
  if (filename === undefined) return null;
  const normalized = filename.normalize("NFC").replaceAll("\\", "/");
  const basename = normalized.split("/").at(-1) ?? "";
  const withoutControls = [...basename]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return !(
        codePoint <= 31 ||
        (codePoint >= 127 && codePoint <= 159) ||
        (codePoint >= 0x202a && codePoint <= 0x202e) ||
        (codePoint >= 0x2066 && codePoint <= 0x2069)
      );
    })
    .join("");
  const sanitized = withoutControls.replace(/\s+/gu, " ").trim();
  if (sanitized === "" || sanitized === "." || sanitized === "..") {
    return null;
  }
  return [...sanitized].slice(0, 255).join("");
}

function failClosedActor(): never {
  throw new MediaUploadRejectedError("UNAUTHORIZED");
}
