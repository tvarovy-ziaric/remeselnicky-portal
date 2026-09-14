import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type {
  CraftsmanProfileId,
  PortfolioProjectId,
  UserId,
} from "@portal/domain";
import type { StorageObjectKey } from "@portal/storage";

import {
  createPortfolioPublicationService,
  type PortfolioPublicationCommandInput,
  type PortfolioPublicationRepository,
  type PreparedPortfolioPublicationPhoto,
} from "../src/index.js";

const actorUserId = "10000000-0000-4000-8000-000000000001" as UserId;
const craftsmanProfileId =
  "10000000-0000-4000-8000-000000000002" as CraftsmanProfileId;
const portfolioProjectId =
  "10000000-0000-4000-8000-000000000003" as PortfolioProjectId;
const commandId = "10000000-0000-4000-8000-000000000004";
const attachmentId = "10000000-0000-4000-8000-000000000005";
const mediaAssetId = "10000000-0000-4000-8000-000000000006";
const sourceObjectId = "10000000-0000-4000-8000-000000000007";
const publicObjectId = "10000000-0000-4000-8000-000000000008";
const body = new Uint8Array([1, 2, 3, 4]);

describe("portfolio publication service", () => {
  it("copies the exact private thumbnail and finalizes an explicit public derivative", async () => {
    const photo = preparedPhoto(body);
    const finalizePublish = vi.fn(() =>
      Promise.resolve({
        snapshot: snapshot("PUBLIC", 1),
        status: "APPLIED" as const,
      }),
    );
    const repository = repositoryStub({
      finalizePublish,
      preparePublish: () =>
        Promise.resolve({ photos: [photo], status: "READY" as const }),
    });
    const storePublicDerivative = vi.fn(() =>
      Promise.resolve({
        area: "public-derivative" as const,
        key: publicKey(),
        url: new URL("https://cdn.example.test/public/image.webp"),
      }),
    );
    const service = createPortfolioPublicationService({
      cleanupObserver: { recordCleanupFailure: vi.fn() },
      repository,
      storage: {
        readPrivateForProcessing: () => Promise.resolve(body),
        revokePublicDerivative: vi.fn(),
        storePublicDerivative,
      },
      uuid: () => publicObjectId,
    });

    await expect(service.publish(command())).resolves.toMatchObject({
      snapshot: { publicationRevision: 1, state: "PUBLIC" },
      status: "APPLIED",
    });
    expect(storePublicDerivative).toHaveBeenCalledWith({
      body,
      contentType: "image/webp",
    });
    expect(finalizePublish).toHaveBeenCalledWith(
      expect.objectContaining({
        derivatives: [
          expect.objectContaining({
            attachmentId,
            mediaAssetId,
            publicObjectId,
            sourceObjectId,
          }),
        ],
      }),
    );
  });

  it("fails closed before publication when private bytes no longer match", async () => {
    const repository = repositoryStub({
      preparePublish: () =>
        Promise.resolve({
          photos: [preparedPhoto(new Uint8Array([9]))],
          status: "READY" as const,
        }),
    });
    const storePublicDerivative = vi.fn();
    const service = createPortfolioPublicationService({
      cleanupObserver: { recordCleanupFailure: vi.fn() },
      repository,
      storage: {
        readPrivateForProcessing: () => Promise.resolve(body),
        revokePublicDerivative: vi.fn(),
        storePublicDerivative,
      },
    });

    await expect(service.publish(command())).rejects.toThrow(
      /source derivative changed/u,
    );
    expect(storePublicDerivative).not.toHaveBeenCalled();
  });

  it("revokes copied bytes when the authoritative finalize loses a race", async () => {
    const revokePublicDerivative = vi.fn(() => Promise.resolve());
    const service = createPortfolioPublicationService({
      cleanupObserver: { recordCleanupFailure: vi.fn() },
      repository: repositoryStub({
        finalizePublish: () =>
          Promise.resolve({ status: "STALE_PHOTO_SET_REVISION" as const }),
        preparePublish: () =>
          Promise.resolve({
            photos: [preparedPhoto(body)],
            status: "READY" as const,
          }),
      }),
      storage: {
        readPrivateForProcessing: () => Promise.resolve(body),
        revokePublicDerivative,
        storePublicDerivative: () =>
          Promise.resolve({
            area: "public-derivative",
            key: publicKey(),
            url: new URL("https://cdn.example.test/public/image.webp"),
          }),
      },
      uuid: () => publicObjectId,
    });

    await expect(service.publish(command())).resolves.toEqual({
      status: "STALE_PHOTO_SET_REVISION",
    });
    expect(revokePublicDerivative).toHaveBeenCalledTimes(1);
  });

  it("tracks an unsafe published URL for cleanup without persisting it", async () => {
    const recordCleanupFailure = vi.fn(() => Promise.resolve());
    const service = createPortfolioPublicationService({
      cleanupObserver: { recordCleanupFailure },
      repository: repositoryStub({
        preparePublish: () =>
          Promise.resolve({
            photos: [preparedPhoto(body)],
            status: "READY" as const,
          }),
      }),
      storage: {
        readPrivateForProcessing: () => Promise.resolve(body),
        revokePublicDerivative: () => Promise.reject(new Error("offline")),
        storePublicDerivative: () =>
          Promise.resolve({
            area: "public-derivative",
            key: publicKey(),
            url: new URL("https://cdn.example.test/image.webp?token=secret"),
          }),
      },
      uuid: () => publicObjectId,
    });

    await expect(service.publish(command())).rejects.toThrow(
      /URL is not safe/u,
    );
    expect(recordCleanupFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        objectId: publicObjectId,
        reason: "FAILED_PUBLICATION",
      }),
    );
  });

  it("makes hide authoritative even when CDN cleanup must be retried", async () => {
    const recordCleanupFailure = vi.fn(() => Promise.resolve());
    const service = createPortfolioPublicationService({
      cleanupObserver: { recordCleanupFailure },
      repository: repositoryStub({
        hide: () =>
          Promise.resolve({
            pendingRevocations: [
              {
                objectId: publicObjectId,
                publicationRevision: 2,
                storageObject: {
                  area: "public-derivative",
                  key: publicKey(),
                },
              },
            ],
            snapshot: snapshot("HIDDEN", 2),
            status: "APPLIED" as const,
          }),
      }),
      storage: {
        readPrivateForProcessing: vi.fn(),
        revokePublicDerivative: () => Promise.reject(new Error("offline")),
        storePublicDerivative: vi.fn(),
      },
    });

    await expect(service.hide(command(1))).resolves.toMatchObject({
      cleanupPending: 1,
      snapshot: { state: "HIDDEN" },
      status: "APPLIED",
    });
    expect(recordCleanupFailure).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "HIDDEN_PUBLICATION" }),
    );
  });
});

function command(
  expectedPublicationRevision = 0,
): PortfolioPublicationCommandInput {
  return {
    actorUserId,
    commandId,
    craftsmanProfileId,
    expectedPhotoSetRevision: 1,
    expectedProjectRevision: 1,
    expectedPublicationRevision,
    portfolioProjectId,
  };
}

function preparedPhoto(bytes: Uint8Array): PreparedPortfolioPublicationPhoto {
  return Object.freeze({
    attachmentId,
    byteSize: bytes.byteLength,
    canonicalHeight: 384,
    canonicalWidth: 384,
    contentSha256: createHash("sha256").update(bytes).digest("hex"),
    displayOrder: 1,
    mediaAssetId,
    phase: "OTHER",
    sourceObject: {
      area: "private" as const,
      key: "private/2026/09/10000000-0000-4000-8000-000000000009" as StorageObjectKey,
    },
    sourceObjectId,
  });
}

function publicKey(): StorageObjectKey {
  return "public-derivative/2026/09/10000000-0000-4000-8000-000000000010" as StorageObjectKey;
}

function snapshot(state: "HIDDEN" | "PUBLIC", publicationRevision: number) {
  return {
    photoSetRevision: 1,
    projectRevision: 1,
    publicationRevision,
    state,
  } as const;
}

function repositoryStub(
  overrides: Partial<PortfolioPublicationRepository>,
): PortfolioPublicationRepository {
  return {
    finalizePublish: () =>
      Promise.resolve({ status: "PROJECT_UNAVAILABLE" as const }),
    hide: () => Promise.resolve({ status: "PROJECT_UNAVAILABLE" as const }),
    markPublicDerivativeRevoked: () => Promise.resolve("STALE" as const),
    preparePublish: () =>
      Promise.resolve({ status: "PROJECT_UNAVAILABLE" as const }),
    ...overrides,
  };
}
