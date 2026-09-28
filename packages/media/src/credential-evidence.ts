import type { AuthorizationActor } from "@portal/authorization";

import type { ProcessingMediaAsset, ServerMediaProvenance } from "./model.js";
import type { ControlledMediaUploadService } from "./upload.js";

export type CredentialEvidenceMediaKind = "DOCUMENT" | "IMAGE";

export interface CredentialEvidenceUploadStatus {
  readonly assetId: string;
  readonly kind: CredentialEvidenceMediaKind;
  readonly status: "PROCESSING" | "READY" | "REJECTED";
}

export type PrepareCredentialEvidenceUploadResult = Readonly<
  | {
      readonly provenance: ServerMediaProvenance;
      readonly purpose: "CREDENTIAL_DOCUMENT" | "CREDENTIAL_IMAGE";
      readonly status: "AUTHORIZED";
    }
  | { readonly status: "UPLOAD_UNAVAILABLE" }
>;

export interface CredentialEvidenceUploadAuthorization {
  listOwnedUploads(input: {
    readonly actorUserId: string;
    readonly claimId: string;
    readonly craftsmanProfileId: string;
  }): Promise<readonly CredentialEvidenceUploadStatus[]>;
  prepareUpload(input: {
    readonly actorUserId: string;
    readonly claimId: string;
    readonly craftsmanProfileId: string;
    readonly expectedRevision: number;
    readonly mediaKind: CredentialEvidenceMediaKind;
  }): Promise<PrepareCredentialEvidenceUploadResult>;
}

export interface CredentialEvidenceProcessingDispatcher {
  enqueue(input: {
    readonly assetId: string;
    readonly kind: CredentialEvidenceMediaKind;
  }): Promise<void>;
}

export type CredentialEvidenceUploadResult = Readonly<
  | {
      readonly assetId: string;
      readonly kind: CredentialEvidenceMediaKind;
      readonly status: "PROCESSING";
    }
  | { readonly status: "UPLOAD_UNAVAILABLE" }
>;

export interface CredentialEvidenceUploadService {
  list(input: {
    readonly actor: AuthorizationActor;
    readonly claimId: string;
    readonly craftsmanProfileId: string;
  }): Promise<
    Readonly<
      | {
          readonly status: "OK";
          readonly uploads: readonly CredentialEvidenceUploadStatus[];
        }
      | { readonly status: "UPLOAD_UNAVAILABLE" }
    >
  >;
  upload(input: {
    readonly actor: AuthorizationActor;
    readonly body: Uint8Array;
    readonly claimId: string;
    readonly craftsmanProfileId: string;
    readonly declaredContentType: string;
    readonly expectedRevision: number;
    readonly mediaKind: CredentialEvidenceMediaKind;
  }): Promise<CredentialEvidenceUploadResult>;
}

type ListInput = Parameters<CredentialEvidenceUploadService["list"]>[0];
type UploadInput = Parameters<CredentialEvidenceUploadService["upload"]>[0];

/**
 * Composes exact pending-claim ownership with the central private media
 * boundary. Credential provenance is minted server-side and never accepted
 * from the browser.
 */
export function createCredentialEvidenceUploadService(input: {
  readonly authorization: CredentialEvidenceUploadAuthorization;
  readonly processing: CredentialEvidenceProcessingDispatcher;
  readonly uploads: ControlledMediaUploadService;
}): CredentialEvidenceUploadService {
  return Object.freeze({
    async list(listInput: ListInput) {
      if (!activeActor(listInput.actor)) {
        return { status: "UPLOAD_UNAVAILABLE" } as const;
      }
      return Object.freeze({
        status: "OK" as const,
        uploads: await input.authorization.listOwnedUploads({
          actorUserId: listInput.actor.userId,
          claimId: listInput.claimId,
          craftsmanProfileId: listInput.craftsmanProfileId,
        }),
      });
    },
    async upload(
      uploadInput: UploadInput,
    ): Promise<CredentialEvidenceUploadResult> {
      if (!activeActor(uploadInput.actor)) {
        return { status: "UPLOAD_UNAVAILABLE" };
      }
      if (
        uploadInput.mediaKind !== "DOCUMENT" &&
        uploadInput.mediaKind !== "IMAGE"
      ) {
        return { status: "UPLOAD_UNAVAILABLE" };
      }
      const prepared = await input.authorization.prepareUpload({
        actorUserId: uploadInput.actor.userId,
        claimId: uploadInput.claimId,
        craftsmanProfileId: uploadInput.craftsmanProfileId,
        expectedRevision: uploadInput.expectedRevision,
        mediaKind: uploadInput.mediaKind,
      });
      const expectedPurpose =
        uploadInput.mediaKind === "DOCUMENT"
          ? "CREDENTIAL_DOCUMENT"
          : "CREDENTIAL_IMAGE";
      if (
        prepared.status !== "AUTHORIZED" ||
        prepared.purpose !== expectedPurpose ||
        prepared.provenance.entityType !== "CREDENTIAL" ||
        prepared.provenance.entityId !== uploadInput.claimId ||
        prepared.provenance.entityRevision !== uploadInput.expectedRevision
      ) {
        return { status: "UPLOAD_UNAVAILABLE" };
      }
      const asset: ProcessingMediaAsset = await input.uploads.upload({
        actor: uploadInput.actor,
        body: uploadInput.body,
        declaredContentType: uploadInput.declaredContentType,
        provenance: prepared.provenance,
        purpose: expectedPurpose,
      });
      if (asset.kind !== uploadInput.mediaKind) {
        return { status: "UPLOAD_UNAVAILABLE" };
      }
      await input.processing.enqueue({ assetId: asset.id, kind: asset.kind });
      return Object.freeze({
        assetId: asset.id,
        kind: asset.kind,
        status: "PROCESSING" as const,
      });
    },
  });
}

function activeActor(
  actor: AuthorizationActor,
): actor is Extract<AuthorizationActor, { kind: "AUTHENTICATED" }> {
  return actor.kind === "AUTHENTICATED" && actor.accountState === "ACTIVE";
}
