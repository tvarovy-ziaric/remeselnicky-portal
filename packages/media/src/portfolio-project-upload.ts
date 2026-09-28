import type { AuthorizationActor } from "@portal/authorization";

import type { ProcessingMediaAsset, ServerMediaProvenance } from "./model.js";
import type { ControlledMediaUploadService } from "./upload.js";

export interface PortfolioProjectPhotoUploadStatus {
  readonly assetId: string;
  readonly kind: "IMAGE";
  readonly status: "PROCESSING" | "READY" | "REJECTED";
}

export type PreparePortfolioProjectPhotoUploadResult = Readonly<
  | {
      readonly provenance: ServerMediaProvenance;
      readonly purpose: "PORTFOLIO_IMAGE";
      readonly status: "AUTHORIZED";
    }
  | { readonly status: "UPLOAD_UNAVAILABLE" }
>;

export interface PortfolioProjectPhotoUploadAuthorization {
  listOwnedUploads(input: {
    readonly actorUserId: string;
    readonly craftsmanProfileId: string;
    readonly portfolioProjectId: string;
  }): Promise<readonly PortfolioProjectPhotoUploadStatus[]>;
  prepareUpload(input: {
    readonly actorUserId: string;
    readonly craftsmanProfileId: string;
    readonly expectedProjectRevision: number;
    readonly portfolioProjectId: string;
  }): Promise<PreparePortfolioProjectPhotoUploadResult>;
}

export interface PortfolioProjectPhotoProcessingDispatcher {
  enqueue(input: {
    readonly assetId: string;
    readonly kind: "IMAGE";
  }): Promise<void>;
}

export type PortfolioProjectPhotoUploadResult = Readonly<
  | {
      readonly assetId: string;
      readonly kind: "IMAGE";
      readonly status: "PROCESSING";
    }
  | { readonly status: "UPLOAD_UNAVAILABLE" }
>;

export interface PortfolioProjectPhotoUploadService {
  list(input: {
    readonly actor: AuthorizationActor;
    readonly craftsmanProfileId: string;
    readonly portfolioProjectId: string;
  }): Promise<
    Readonly<
      | {
          readonly status: "OK";
          readonly uploads: readonly PortfolioProjectPhotoUploadStatus[];
        }
      | { readonly status: "UPLOAD_UNAVAILABLE" }
    >
  >;
  upload(input: {
    readonly actor: AuthorizationActor;
    readonly body: Uint8Array;
    readonly craftsmanProfileId: string;
    readonly declaredContentType: string;
    readonly expectedProjectRevision: number;
    readonly originalFilename?: string;
    readonly portfolioProjectId: string;
  }): Promise<PortfolioProjectPhotoUploadResult>;
}

type ListInput = Parameters<PortfolioProjectPhotoUploadService["list"]>[0];
type UploadInput = Parameters<PortfolioProjectPhotoUploadService["upload"]>[0];

/**
 * Composes current project ownership with the central private image boundary.
 * Trusted provenance is minted by the authorization adapter, never the client.
 */
export function createPortfolioProjectPhotoUploadService(input: {
  readonly authorization: PortfolioProjectPhotoUploadAuthorization;
  readonly processing: PortfolioProjectPhotoProcessingDispatcher;
  readonly uploads: ControlledMediaUploadService;
}): PortfolioProjectPhotoUploadService {
  return Object.freeze({
    async list(listInput: ListInput) {
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
          craftsmanProfileId: listInput.craftsmanProfileId,
          portfolioProjectId: listInput.portfolioProjectId,
        }),
      });
    },
    async upload(
      uploadInput: UploadInput,
    ): Promise<PortfolioProjectPhotoUploadResult> {
      if (
        uploadInput.actor.kind !== "AUTHENTICATED" ||
        uploadInput.actor.accountState !== "ACTIVE"
      ) {
        return { status: "UPLOAD_UNAVAILABLE" };
      }
      const prepared = await input.authorization.prepareUpload({
        actorUserId: uploadInput.actor.userId,
        craftsmanProfileId: uploadInput.craftsmanProfileId,
        expectedProjectRevision: uploadInput.expectedProjectRevision,
        portfolioProjectId: uploadInput.portfolioProjectId,
      });
      if (
        prepared.status !== "AUTHORIZED" ||
        prepared.purpose !== "PORTFOLIO_IMAGE"
      ) {
        return { status: "UPLOAD_UNAVAILABLE" };
      }
      const asset: ProcessingMediaAsset = await input.uploads.upload({
        actor: uploadInput.actor,
        body: uploadInput.body,
        declaredContentType: uploadInput.declaredContentType,
        ...(uploadInput.originalFilename === undefined
          ? {}
          : { originalFilename: uploadInput.originalFilename }),
        provenance: prepared.provenance,
        purpose: "PORTFOLIO_IMAGE",
      });
      if (asset.kind !== "IMAGE") {
        return { status: "UPLOAD_UNAVAILABLE" };
      }
      await input.processing.enqueue({ assetId: asset.id, kind: "IMAGE" });
      return Object.freeze({
        assetId: asset.id,
        kind: "IMAGE" as const,
        status: "PROCESSING" as const,
      });
    },
  });
}
