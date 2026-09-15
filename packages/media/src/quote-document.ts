import type { AuthorizationActor } from "@portal/authorization";

import {
  isServerMediaProvenance,
  type ProcessingMediaAsset,
  type ServerMediaProvenance,
} from "./model.js";
import type { ControlledMediaUploadService } from "./upload.js";

export type PrepareQuoteDocumentUploadResult = Readonly<
  | {
      readonly provenance: ServerMediaProvenance;
      readonly purpose: "QUOTE_DOCUMENT";
      readonly status: "AUTHORIZED";
    }
  | { readonly status: "UPLOAD_UNAVAILABLE" }
>;

export interface QuoteDocumentUploadAuthorization {
  prepareUpload(input: {
    readonly actorUserId: string;
    readonly quoteId: string;
    readonly quoteRevision: number;
  }): Promise<PrepareQuoteDocumentUploadResult>;
}

export interface QuoteDocumentProcessingDispatcher {
  enqueue(input: {
    readonly assetId: string;
    readonly kind: "DOCUMENT";
  }): Promise<void>;
}

export interface QuoteDocumentUploadService {
  upload(input: {
    readonly actor: AuthorizationActor;
    readonly body: Uint8Array;
    readonly declaredContentType: string;
    readonly originalFilename?: string;
    readonly quoteId: string;
    readonly quoteRevision: number;
  }): Promise<
    Readonly<
      | { readonly assetId: string; readonly status: "PROCESSING" }
      | { readonly status: "UPLOAD_UNAVAILABLE" }
    >
  >;
}

type QuoteDocumentUploadInput = Parameters<
  QuoteDocumentUploadService["upload"]
>[0];

export function createQuoteDocumentUploadService(input: {
  readonly authorization: QuoteDocumentUploadAuthorization;
  readonly processing: QuoteDocumentProcessingDispatcher;
  readonly uploads: ControlledMediaUploadService;
}): QuoteDocumentUploadService {
  return Object.freeze({
    async upload(upload: QuoteDocumentUploadInput) {
      if (
        upload.actor.kind !== "AUTHENTICATED" ||
        upload.actor.accountState !== "ACTIVE" ||
        !uuid(upload.quoteId) ||
        !Number.isSafeInteger(upload.quoteRevision) ||
        upload.quoteRevision < 1
      )
        return { status: "UPLOAD_UNAVAILABLE" } as const;
      const prepared = await input.authorization.prepareUpload({
        actorUserId: upload.actor.userId,
        quoteId: upload.quoteId,
        quoteRevision: upload.quoteRevision,
      });
      if (
        prepared.status !== "AUTHORIZED" ||
        prepared.purpose !== "QUOTE_DOCUMENT" ||
        !isServerMediaProvenance(prepared.provenance) ||
        prepared.provenance.entityType !== "QUOTE_REVISION" ||
        prepared.provenance.entityId !== upload.quoteId.toLowerCase() ||
        prepared.provenance.entityRevision !== upload.quoteRevision
      )
        return { status: "UPLOAD_UNAVAILABLE" } as const;
      const asset: ProcessingMediaAsset = await input.uploads.upload({
        actor: upload.actor,
        body: upload.body,
        declaredContentType: upload.declaredContentType,
        ...(upload.originalFilename === undefined
          ? {}
          : { originalFilename: upload.originalFilename }),
        provenance: prepared.provenance,
        purpose: "QUOTE_DOCUMENT",
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
