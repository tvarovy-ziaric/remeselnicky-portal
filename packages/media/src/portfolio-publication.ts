import { createHash, randomUUID } from "node:crypto";

import type {
  CraftsmanProfileId,
  PortfolioPhotoPhase,
  PortfolioProjectId,
  UserId,
} from "@portal/domain";
import type {
  ObjectStorageService,
  StoredObjectReference,
} from "@portal/storage";

export const PORTFOLIO_PUBLICATION_STATES = Object.freeze([
  "HIDDEN",
  "PUBLIC",
] as const);
export type PortfolioPublicationState =
  (typeof PORTFOLIO_PUBLICATION_STATES)[number];

export interface PortfolioPublicationCommandInput {
  readonly actorUserId: UserId;
  readonly commandId: string;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly expectedPhotoSetRevision: number;
  readonly expectedProjectRevision: number;
  readonly expectedPublicationRevision: number;
  readonly portfolioProjectId: PortfolioProjectId;
}

export interface PreparedPortfolioPublicationPhoto {
  readonly attachmentId: string;
  readonly byteSize: number;
  readonly canonicalHeight: number;
  readonly canonicalWidth: number;
  readonly contentSha256: string;
  readonly displayOrder: number;
  readonly mediaAssetId: string;
  readonly phase: PortfolioPhotoPhase;
  readonly sourceObject: StoredObjectReference;
  readonly sourceObjectId: string;
}

export interface StoredPortfolioPublicDerivative {
  readonly attachmentId: string;
  readonly byteSize: number;
  readonly canonicalHeight: number;
  readonly canonicalWidth: number;
  readonly contentSha256: string;
  readonly displayOrder: number;
  readonly mediaAssetId: string;
  readonly phase: PortfolioPhotoPhase;
  readonly publicObject: StoredObjectReference;
  readonly publicObjectId: string;
  readonly publicUrl: URL;
  readonly sourceObjectId: string;
}

export interface PortfolioPublicationSnapshot {
  readonly photoSetRevision: number;
  readonly projectRevision: number;
  readonly publicationRevision: number;
  readonly state: PortfolioPublicationState;
}

export type PreparePortfolioPublicationResult =
  | Readonly<{
      readonly photos: readonly PreparedPortfolioPublicationPhoto[];
      readonly status: "READY";
    }>
  | Readonly<{
      readonly snapshot: PortfolioPublicationSnapshot;
      readonly status: "DEDUPLICATED";
    }>
  | Readonly<{
      readonly status:
        | "PHOTO_SET_UNAVAILABLE"
        | "PROJECT_UNAVAILABLE"
        | "STALE_PHOTO_SET_REVISION"
        | "STALE_PROJECT_REVISION"
        | "STALE_PUBLICATION_REVISION";
    }>;

export type ApplyPortfolioPublicationResult =
  | Readonly<{
      readonly snapshot: PortfolioPublicationSnapshot;
      readonly status: "APPLIED" | "DEDUPLICATED";
    }>
  | Readonly<{
      readonly status:
        | "PHOTO_SET_UNAVAILABLE"
        | "PROJECT_UNAVAILABLE"
        | "STALE_PHOTO_SET_REVISION"
        | "STALE_PROJECT_REVISION"
        | "STALE_PUBLICATION_REVISION";
    }>;

export interface PendingPublicDerivativeRevocation {
  readonly objectId: string;
  readonly publicationRevision: number;
  readonly storageObject: StoredObjectReference;
}

export type HidePortfolioPublicationResult =
  | Readonly<{
      readonly pendingRevocations: readonly PendingPublicDerivativeRevocation[];
      readonly snapshot: PortfolioPublicationSnapshot;
      readonly status: "APPLIED" | "DEDUPLICATED";
    }>
  | Readonly<{
      readonly status:
        | "PROJECT_UNAVAILABLE"
        | "PUBLICATION_ALREADY_HIDDEN"
        | "STALE_PHOTO_SET_REVISION"
        | "STALE_PROJECT_REVISION"
        | "STALE_PUBLICATION_REVISION";
    }>;

export interface PortfolioPublicationRepository {
  finalizePublish(input: {
    readonly command: PortfolioPublicationCommandInput;
    readonly derivatives: readonly StoredPortfolioPublicDerivative[];
  }): Promise<ApplyPortfolioPublicationResult>;
  hide(
    command: PortfolioPublicationCommandInput,
  ): Promise<HidePortfolioPublicationResult>;
  markPublicDerivativeRevoked(input: {
    readonly objectId: string;
    readonly publicationRevision: number;
  }): Promise<"REVOKED" | "STALE">;
  preparePublish(
    command: PortfolioPublicationCommandInput,
  ): Promise<PreparePortfolioPublicationResult>;
}

export interface PublicDerivativeCleanupObserver {
  recordCleanupFailure(input: {
    readonly objectId: string;
    readonly reason: "FAILED_PUBLICATION" | "HIDDEN_PUBLICATION";
    readonly storageObject: StoredObjectReference;
  }): Promise<void>;
}

export function createPortfolioPublicationService(input: {
  readonly cleanupObserver: PublicDerivativeCleanupObserver;
  readonly repository: PortfolioPublicationRepository;
  readonly storage: Pick<
    ObjectStorageService,
    | "readPrivateForProcessing"
    | "revokePublicDerivative"
    | "storePublicDerivative"
  >;
  readonly uuid?: () => string;
}) {
  const uuid = input.uuid ?? randomUUID;
  return Object.freeze({
    async publish(
      command: PortfolioPublicationCommandInput,
    ): Promise<ApplyPortfolioPublicationResult> {
      assertPortfolioPublicationCommand(command);
      const prepared = await input.repository.preparePublish(command);
      if (prepared.status === "DEDUPLICATED") {
        return Object.freeze({
          snapshot: prepared.snapshot,
          status: "DEDUPLICATED" as const,
        });
      }
      if (prepared.status !== "READY") return prepared;

      const stored: StoredPortfolioPublicDerivative[] = [];
      try {
        for (const photo of prepared.photos) {
          const body = await input.storage.readPrivateForProcessing({
            maximumBytes: photo.byteSize,
            object: photo.sourceObject,
          });
          const digest = createHash("sha256").update(body).digest("hex");
          if (
            body.byteLength !== photo.byteSize ||
            digest !== photo.contentSha256
          ) {
            throw new Error("Portfolio source derivative changed.");
          }
          const publicObject = await input.storage.storePublicDerivative({
            body,
            contentType: "image/webp",
          });
          const publicObjectId = uuid();
          assertUuid(publicObjectId, "publicObjectId");
          stored.push(
            Object.freeze({
              ...photo,
              publicObject: {
                area: publicObject.area,
                key: publicObject.key,
              },
              publicObjectId,
              publicUrl: publicObject.url,
            }),
          );
          if (publicObject.area !== "public-derivative") {
            throw new Error("Public derivative was stored in the wrong area.");
          }
          assertSafePublicUrl(publicObject.url);
        }

        const result = await input.repository.finalizePublish({
          command,
          derivatives: stored,
        });
        if (result.status !== "APPLIED") {
          await cleanupStored(
            input.storage,
            input.cleanupObserver,
            stored,
            "FAILED_PUBLICATION",
          );
        }
        return result;
      } catch (error) {
        await cleanupStored(
          input.storage,
          input.cleanupObserver,
          stored,
          "FAILED_PUBLICATION",
        );
        throw error;
      }
    },

    async hide(command: PortfolioPublicationCommandInput) {
      assertPortfolioPublicationCommand(command);
      const result = await input.repository.hide(command);
      if (result.status !== "APPLIED" && result.status !== "DEDUPLICATED") {
        return result;
      }
      let cleanupPending = 0;
      for (const pending of result.pendingRevocations) {
        try {
          await input.storage.revokePublicDerivative(pending.storageObject);
          const marked = await input.repository.markPublicDerivativeRevoked({
            objectId: pending.objectId,
            publicationRevision: pending.publicationRevision,
          });
          if (marked === "STALE") cleanupPending += 1;
        } catch {
          cleanupPending += 1;
          await input.cleanupObserver
            .recordCleanupFailure({
              objectId: pending.objectId,
              reason: "HIDDEN_PUBLICATION",
              storageObject: pending.storageObject,
            })
            .catch(() => undefined);
        }
      }
      return Object.freeze({ ...result, cleanupPending });
    },
  });
}

export function assertPortfolioPublicationCommand(
  input: PortfolioPublicationCommandInput,
): void {
  assertUuid(input.actorUserId, "actorUserId");
  assertUuid(input.commandId, "commandId");
  assertUuid(input.craftsmanProfileId, "craftsmanProfileId");
  assertUuid(input.portfolioProjectId, "portfolioProjectId");
  for (const [field, value] of [
    ["expectedPhotoSetRevision", input.expectedPhotoSetRevision],
    ["expectedProjectRevision", input.expectedProjectRevision],
    ["expectedPublicationRevision", input.expectedPublicationRevision],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`${field} must be a non-negative safe integer.`);
    }
  }
  if (input.expectedPhotoSetRevision < 1 || input.expectedProjectRevision < 1) {
    throw new TypeError("Portfolio source revisions must be positive.");
  }
}

function assertSafePublicUrl(url: URL): void {
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.toString().length > 2048
  ) {
    throw new Error("Public derivative URL is not safe.");
  }
}

function assertUuid(value: string, field: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    throw new TypeError(`${field} must be a UUID.`);
  }
}

async function cleanupStored(
  storage: Pick<ObjectStorageService, "revokePublicDerivative">,
  observer: PublicDerivativeCleanupObserver,
  stored: readonly StoredPortfolioPublicDerivative[],
  reason: "FAILED_PUBLICATION" | "HIDDEN_PUBLICATION",
): Promise<void> {
  await Promise.allSettled(
    stored.map(async (derivative) => {
      try {
        await storage.revokePublicDerivative(derivative.publicObject);
      } catch {
        await observer.recordCleanupFailure({
          objectId: derivative.publicObjectId,
          reason,
          storageObject: derivative.publicObject,
        });
      }
    }),
  );
}
