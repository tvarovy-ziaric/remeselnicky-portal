import type { AuthorizationActor } from "@portal/authorization";

import type {
  MediaKind,
  ProcessingMediaAsset,
  ServerMediaProvenance,
} from "./model.js";
import type { ControlledMediaUploadService } from "./upload.js";

export type JobRequestMediaKind = "DOCUMENT" | "IMAGE";

export interface JobRequestMediaUploadStatus {
  readonly assetId: string;
  readonly kind: JobRequestMediaKind;
  readonly status: "PROCESSING" | "READY" | "REJECTED";
}

export type PrepareJobRequestMediaUploadResult = Readonly<
  | {
      readonly provenance: ServerMediaProvenance;
      readonly purpose: "JOB_REQUEST_DOCUMENT" | "JOB_REQUEST_IMAGE";
      readonly status: "AUTHORIZED";
    }
  | { readonly status: "UPLOAD_UNAVAILABLE" }
>;

export interface JobRequestMediaUploadAuthorization {
  listOwnedUploads(input: {
    readonly actorUserId: string;
    readonly jobRequestId: string;
  }): Promise<readonly JobRequestMediaUploadStatus[]>;
  prepareUpload(input: {
    readonly actorUserId: string;
    readonly expectedRevision: number;
    readonly jobRequestId: string;
    readonly mediaKind: JobRequestMediaKind;
  }): Promise<PrepareJobRequestMediaUploadResult>;
}

export interface JobRequestMediaProcessingDispatcher {
  enqueue(input: {
    readonly assetId: string;
    readonly kind: JobRequestMediaKind;
  }): Promise<void>;
}

export type JobRequestMediaUploadResult = Readonly<
  | {
      readonly assetId: string;
      readonly kind: MediaKind;
      readonly status: "PROCESSING";
    }
  | { readonly status: "UPLOAD_UNAVAILABLE" }
>;

export interface JobRequestMediaUploadService {
  list(input: {
    readonly actor: AuthorizationActor;
    readonly jobRequestId: string;
  }): Promise<
    Readonly<
      | {
          readonly uploads: readonly JobRequestMediaUploadStatus[];
          readonly status: "OK";
        }
      | { readonly status: "UPLOAD_UNAVAILABLE" }
    >
  >;
  upload(input: {
    readonly actor: AuthorizationActor;
    readonly body: Uint8Array;
    readonly declaredContentType: string;
    readonly expectedRevision: number;
    readonly jobRequestId: string;
    readonly mediaKind: JobRequestMediaKind;
    readonly originalFilename?: string;
  }): Promise<JobRequestMediaUploadResult>;
}

type JobRequestMediaListInput = Parameters<
  JobRequestMediaUploadService["list"]
>[0];
type JobRequestMediaUploadInput = Parameters<
  JobRequestMediaUploadService["upload"]
>[0];

/**
 * Composes current request ownership with the central private upload boundary.
 * Processing is intentionally asynchronous; callers receive no storage key.
 */
export function createJobRequestMediaUploadService(input: {
  readonly authorization: JobRequestMediaUploadAuthorization;
  readonly processing: JobRequestMediaProcessingDispatcher;
  readonly uploads: ControlledMediaUploadService;
}): JobRequestMediaUploadService {
  return Object.freeze({
    async list(listInput: JobRequestMediaListInput) {
      if (
        listInput.actor.kind !== "AUTHENTICATED" ||
        listInput.actor.accountState !== "ACTIVE"
      ) {
        return { status: "UPLOAD_UNAVAILABLE" } as const;
      }
      return Object.freeze({
        status: "OK" as const,
        uploads: await input.authorization.listOwnedUploads({
          actorUserId: listInput.actor.userId,
          jobRequestId: listInput.jobRequestId,
        }),
      });
    },
    async upload(
      uploadInput: JobRequestMediaUploadInput,
    ): Promise<JobRequestMediaUploadResult> {
      if (
        uploadInput.actor.kind !== "AUTHENTICATED" ||
        uploadInput.actor.accountState !== "ACTIVE"
      ) {
        return { status: "UPLOAD_UNAVAILABLE" } as const;
      }
      const prepared = await input.authorization.prepareUpload({
        actorUserId: uploadInput.actor.userId,
        expectedRevision: uploadInput.expectedRevision,
        jobRequestId: uploadInput.jobRequestId,
        mediaKind: uploadInput.mediaKind,
      });
      if (prepared.status !== "AUTHORIZED") return prepared;
      const expectedPurpose =
        uploadInput.mediaKind === "IMAGE"
          ? "JOB_REQUEST_IMAGE"
          : "JOB_REQUEST_DOCUMENT";
      if (prepared.purpose !== expectedPurpose) {
        return { status: "UPLOAD_UNAVAILABLE" } as const;
      }
      const asset: ProcessingMediaAsset = await input.uploads.upload({
        actor: uploadInput.actor,
        body: uploadInput.body,
        declaredContentType: uploadInput.declaredContentType,
        ...(uploadInput.originalFilename === undefined
          ? {}
          : { originalFilename: uploadInput.originalFilename }),
        provenance: prepared.provenance,
        purpose: prepared.purpose,
      });
      await input.processing.enqueue({
        assetId: asset.id,
        kind: uploadInput.mediaKind,
      });
      return Object.freeze({
        assetId: asset.id,
        kind: asset.kind,
        status: "PROCESSING" as const,
      });
    },
  });
}
