import type { AuthorizationActor } from "@portal/authorization";

import {
  isServerMediaProvenance,
  type ProcessingMediaAsset,
  type ServerMediaProvenance,
} from "./model.js";
import type { ControlledMediaUploadService } from "./upload.js";

export type PrepareChangeOrderDocumentUploadResult = Readonly<
  | {
      readonly provenance: ServerMediaProvenance;
      readonly purpose: "CHANGE_ORDER_DOCUMENT";
      readonly status: "AUTHORIZED";
    }
  | { readonly status: "UPLOAD_UNAVAILABLE" }
>;

export interface ChangeOrderDocumentUploadAuthorization {
  prepareUpload(input: {
    readonly actorUserId: string;
    readonly jobId: string;
    readonly revisionId: string;
  }): Promise<PrepareChangeOrderDocumentUploadResult>;
}

export interface ChangeOrderDocumentUploadService {
  upload(input: {
    readonly actor: AuthorizationActor;
    readonly body: Uint8Array;
    readonly declaredContentType: string;
    readonly jobId: string;
    readonly originalFilename?: string;
    readonly revisionId: string;
  }): Promise<
    Readonly<
      | { readonly assetId: string; readonly status: "PROCESSING" }
      | { readonly status: "UPLOAD_UNAVAILABLE" }
    >
  >;
}

export interface ChangeOrderDocumentProcessingDispatcher {
  enqueue(input: {
    readonly assetId: string;
    readonly kind: "DOCUMENT";
  }): Promise<void>;
}

export function createChangeOrderDocumentUploadService(input: {
  readonly authorization: ChangeOrderDocumentUploadAuthorization;
  readonly processing: ChangeOrderDocumentProcessingDispatcher;
  readonly uploads: ControlledMediaUploadService;
}): ChangeOrderDocumentUploadService {
  return Object.freeze({
    async upload(
      request: Parameters<ChangeOrderDocumentUploadService["upload"]>[0],
    ) {
      if (
        request.actor.kind !== "AUTHENTICATED" ||
        request.actor.accountState !== "ACTIVE" ||
        !uuid(request.jobId) ||
        !uuid(request.revisionId)
      ) {
        return { status: "UPLOAD_UNAVAILABLE" } as const;
      }
      const prepared = await input.authorization.prepareUpload({
        actorUserId: request.actor.userId,
        jobId: request.jobId,
        revisionId: request.revisionId,
      });
      if (
        prepared.status !== "AUTHORIZED" ||
        prepared.purpose !== "CHANGE_ORDER_DOCUMENT" ||
        !isServerMediaProvenance(prepared.provenance) ||
        prepared.provenance.entityType !== "CHANGE_ORDER_REVISION" ||
        prepared.provenance.entityId !== request.revisionId.toLowerCase() ||
        prepared.provenance.entityRevision === null ||
        !Number.isSafeInteger(prepared.provenance.entityRevision) ||
        prepared.provenance.entityRevision < 1
      ) {
        return { status: "UPLOAD_UNAVAILABLE" } as const;
      }
      const asset: ProcessingMediaAsset = await input.uploads.upload({
        actor: request.actor,
        body: request.body,
        declaredContentType: request.declaredContentType,
        ...(request.originalFilename === undefined
          ? {}
          : { originalFilename: request.originalFilename }),
        provenance: prepared.provenance,
        purpose: "CHANGE_ORDER_DOCUMENT",
      });
      await input.processing.enqueue({ assetId: asset.id, kind: "DOCUMENT" });
      return Object.freeze({
        assetId: asset.id,
        status: "PROCESSING" as const,
      });
    },
  });
}

function uuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}
