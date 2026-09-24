import type { AuthorizationActor } from "@portal/authorization";

import type { ProcessingMediaAsset, ServerMediaProvenance } from "./model.js";
import type { ControlledMediaUploadService } from "./upload.js";

export type DisputeEvidenceMediaKind = "IMAGE" | "PDF";

export type PrepareDisputeEvidenceUploadResult = Readonly<
  | {
      readonly provenance: ServerMediaProvenance;
      readonly purpose: "DISPUTE_EVIDENCE";
      readonly status: "AUTHORIZED";
    }
  | { readonly status: "UPLOAD_UNAVAILABLE" }
>;

export interface DisputeEvidenceUploadAuthorization {
  prepareEvidenceUpload(input: {
    readonly actorUserId: string;
    readonly jobId: string;
    readonly disputeId: string;
  }): Promise<PrepareDisputeEvidenceUploadResult>;
}

export interface DisputeEvidenceProcessingDispatcher {
  enqueue(input: {
    readonly assetId: string;
    readonly kind: "DOCUMENT" | "IMAGE";
  }): Promise<void>;
}

export type DisputeEvidenceUploadResult = Readonly<
  | {
      readonly assetId: string;
      readonly kind: DisputeEvidenceMediaKind;
      readonly status: "PROCESSING";
    }
  | { readonly status: "UPLOAD_UNAVAILABLE" }
>;

export interface DisputeEvidenceUploadService {
  upload(input: {
    readonly actor: AuthorizationActor;
    readonly body: Uint8Array;
    readonly jobId: string;
    readonly disputeId: string;
    readonly declaredContentType: string;
    readonly mediaKind: DisputeEvidenceMediaKind;
    readonly originalFilename?: string;
  }): Promise<DisputeEvidenceUploadResult>;
}

type DisputeEvidenceUploadInput = Parameters<
  DisputeEvidenceUploadService["upload"]
>[0];

export function createDisputeEvidenceUploadService(input: {
  readonly authorization: DisputeEvidenceUploadAuthorization;
  readonly processing: DisputeEvidenceProcessingDispatcher;
  readonly uploads: ControlledMediaUploadService;
}): DisputeEvidenceUploadService {
  return Object.freeze({
    async upload(uploadInput: DisputeEvidenceUploadInput) {
      if (
        uploadInput.actor.kind !== "AUTHENTICATED" ||
        uploadInput.actor.accountState !== "ACTIVE" ||
        !uuid.test(uploadInput.jobId) ||
        !uuid.test(uploadInput.disputeId) ||
        (uploadInput.mediaKind !== "IMAGE" && uploadInput.mediaKind !== "PDF")
      )
        return { status: "UPLOAD_UNAVAILABLE" } as const;
      const prepared = await input.authorization.prepareEvidenceUpload({
        actorUserId: uploadInput.actor.userId,
        jobId: uploadInput.jobId,
        disputeId: uploadInput.disputeId,
      });
      if (
        prepared.status !== "AUTHORIZED" ||
        prepared.purpose !== "DISPUTE_EVIDENCE"
      )
        return { status: "UPLOAD_UNAVAILABLE" } as const;
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
        kind: uploadInput.mediaKind === "IMAGE" ? "IMAGE" : "DOCUMENT",
      });
      return Object.freeze({
        assetId: asset.id,
        kind: uploadInput.mediaKind,
        status: "PROCESSING" as const,
      });
    },
  });
}

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
