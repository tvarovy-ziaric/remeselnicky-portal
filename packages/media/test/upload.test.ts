import {
  anonymousAuthorizationActor,
  createAuthenticatedAuthorizationActor,
} from "@portal/authorization";
import type { User, UserId } from "@portal/domain";
import {
  createStorageObjectKey,
  storageAreas,
  type ObjectStorageService,
} from "@portal/storage";
import { describe, expect, it, vi } from "vitest";

import {
  MEDIA_UPLOAD_LIMITS,
  MediaUploadRejectedError,
  createControlledMediaUploadService,
  createServerMediaProvenance,
  sanitizeDisplayFilename,
  type CreateProcessingMediaAssetInput,
  type MediaAssetUploadRepository,
  type ProcessingMediaAsset,
} from "../src/index.js";

const userId = "123e4567-e89b-42d3-a456-426614174000" as UserId;
const sourceId = "223e4567-e89b-42d3-a456-426614174000";
const storageKey = createStorageObjectKey(storageAreas.private, {
  now: () => new Date("2026-09-14T12:00:00.000Z"),
  uuid: () => "323e4567-e89b-42d3-a456-426614174000",
});

function actor(accountState: User["accountState"] = "ACTIVE") {
  return createAuthenticatedAuthorizationActor({ id: userId, accountState });
}

function setup() {
  const storePrivate = vi.fn(
    (input: Parameters<ObjectStorageService["storePrivate"]>[0]) => {
      void input;
      return Promise.resolve({ area: storageAreas.private, key: storageKey });
    },
  );
  const recordOrphanedPrivateObject = vi.fn(() => Promise.resolve());
  const createProcessingAsset = vi.fn(
    (input: CreateProcessingMediaAssetInput): Promise<ProcessingMediaAsset> =>
      Promise.resolve({
        ...input,
        createdAt: new Date("2026-09-14T12:00:01.000Z"),
        id: "423e4567-e89b-42d3-a456-426614174000",
        status: "PROCESSING",
        updatedAt: new Date("2026-09-14T12:00:01.000Z"),
      }),
  );
  const storage = { storePrivate } as unknown as ObjectStorageService;
  const repository: MediaAssetUploadRepository = { createProcessingAsset };
  return {
    createProcessingAsset,
    recordOrphanedPrivateObject,
    service: createControlledMediaUploadService({
      orphanedObjectObserver: { recordOrphanedPrivateObject },
      repository,
      storage,
    }),
    storePrivate,
  };
}

describe("controlled media upload", () => {
  it("authorizes, stores privately and persists central processing metadata", async () => {
    const { createProcessingAsset, service, storePrivate } = setup();
    const body = new Uint8Array([1, 2, 3]);
    const provenance = createServerMediaProvenance({
      entityId: sourceId,
      entityRevision: 2,
      entityType: "PORTFOLIO_PROJECT",
    });

    await expect(
      service.upload({
        actor: actor(),
        body,
        declaredContentType: " IMAGE/JPEG ",
        originalFilename: "../../private/\u202ephoto.jpg",
        provenance,
        purpose: "PORTFOLIO_IMAGE",
      }),
    ).resolves.toMatchObject({
      kind: "IMAGE",
      ownerUserId: userId,
      provenanceEntityId: sourceId,
      provenanceEntityRevision: 2,
      provenanceEntityType: "PORTFOLIO_PROJECT",
      status: "PROCESSING",
      uploaderUserId: userId,
    });
    expect(storePrivate).toHaveBeenCalledWith({
      body,
      contentType: "image/jpeg",
    });
    expect(storePrivate.mock.calls[0]?.[0]).not.toHaveProperty(
      "originalFilename",
    );
    expect(createProcessingAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        byteSize: 3,
        declaredContentType: "image/jpeg",
        displayFilename: "photo.jpg",
        ownerUserId: userId,
        storageObject: { area: storageAreas.private, key: storageKey },
        uploaderUserId: userId,
      }),
    );
  });

  it.each([
    ["anonymous", anonymousAuthorizationActor],
    ["suspended", actor("SUSPENDED")],
    ["deactivated", actor("DEACTIVATED")],
    [
      "untrusted actor",
      { accountState: "ACTIVE", kind: "AUTHENTICATED", userId } as ReturnType<
        typeof actor
      >,
    ],
  ])("denies a %s actor before writing bytes", async (_label, deniedActor) => {
    const { createProcessingAsset, service, storePrivate } = setup();

    await expect(
      service.upload({
        actor: deniedActor,
        body: new Uint8Array([1]),
        declaredContentType: "image/png",
        provenance: createServerMediaProvenance(),
        purpose: "PROFILE_IMAGE",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(storePrivate).not.toHaveBeenCalled();
    expect(createProcessingAsset).not.toHaveBeenCalled();
  });

  it("rejects provenance assembled from a client payload", async () => {
    const { service, storePrivate } = setup();
    await expect(
      service.upload({
        actor: actor(),
        body: new Uint8Array([1]),
        declaredContentType: "image/png",
        provenance: {
          entityId: sourceId,
          entityRevision: null,
          entityType: "PORTFOLIO_PROJECT",
        } as Parameters<typeof service.upload>[0]["provenance"],
        purpose: "PORTFOLIO_IMAGE",
      }),
    ).rejects.toMatchObject({ code: "INVALID_PROVENANCE" });
    expect(storePrivate).not.toHaveBeenCalled();
  });

  it("enforces type and byte limits centrally before storage", async () => {
    const { service, storePrivate } = setup();
    const base = {
      actor: actor(),
      provenance: createServerMediaProvenance(),
      purpose: "CHAT_DOCUMENT" as const,
    };

    await expect(
      service.upload({
        ...base,
        body: new Uint8Array([1]),
        declaredContentType: "text/html",
      }),
    ).rejects.toMatchObject({ code: "INVALID_CONTENT_TYPE" });
    await expect(
      service.upload({
        ...base,
        body: new Uint8Array(),
        declaredContentType: "application/pdf",
      }),
    ).rejects.toMatchObject({ code: "EMPTY_FILE" });
    await expect(
      service.upload({
        ...base,
        body: new Uint8Array(MEDIA_UPLOAD_LIMITS.documentMaxBytes + 1),
        declaredContentType: "application/pdf",
      }),
    ).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    await expect(
      service.upload({
        ...base,
        body: { byteLength: 1 } as Uint8Array,
        declaredContentType: "application/pdf",
      }),
    ).rejects.toMatchObject({ code: "INVALID_BODY" });
    await expect(
      service.upload({
        ...base,
        body: new Uint8Array([1]),
        declaredContentType: 42 as unknown as string,
      }),
    ).rejects.toMatchObject({ code: "INVALID_CONTENT_TYPE" });
    await expect(
      service.upload({
        ...base,
        body: new Uint8Array([1]),
        declaredContentType: "application/pdf",
        originalFilename: 42 as unknown as string,
      }),
    ).rejects.toMatchObject({ code: "INVALID_FILENAME" });
    await expect(
      service.upload({
        ...base,
        body: new Uint8Array([1]),
        declaredContentType: "application/pdf",
        purpose: "EXECUTABLE" as typeof base.purpose,
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_PURPOSE" });
    expect(storePrivate).not.toHaveBeenCalled();
  });

  it("uses declared MIME and purpose, never a spoofed filename extension", async () => {
    const { createProcessingAsset, service } = setup();
    await service.upload({
      actor: actor(),
      body: new Uint8Array([1]),
      declaredContentType: "image/png",
      originalFilename: "invoice.pdf",
      provenance: createServerMediaProvenance(),
      purpose: "CHAT_IMAGE",
    });
    expect(createProcessingAsset).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "IMAGE" }),
    );
  });

  it("accepts only PDF bytes for a job-request document purpose", async () => {
    const { createProcessingAsset, service } = setup();
    const provenance = createServerMediaProvenance({
      entityId: sourceId,
      entityRevision: 2,
      entityType: "JOB_REQUEST",
    });

    await service.upload({
      actor: actor(),
      body: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      declaredContentType: "application/pdf",
      originalFilename: "podklady.pdf",
      provenance,
      purpose: "JOB_REQUEST_DOCUMENT",
    });

    expect(createProcessingAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "DOCUMENT",
        provenanceEntityId: sourceId,
        provenanceEntityRevision: 2,
        provenanceEntityType: "JOB_REQUEST",
        purpose: "JOB_REQUEST_DOCUMENT",
      }),
    );
    await expect(
      service.upload({
        actor: actor(),
        body: new Uint8Array([1]),
        declaredContentType: "image/jpeg",
        provenance,
        purpose: "JOB_REQUEST_DOCUMENT",
      }),
    ).rejects.toMatchObject({ code: "INVALID_CONTENT_TYPE" });
  });

  it("accepts credential photos only through the private image purpose", async () => {
    const { createProcessingAsset, service } = setup();
    const provenance = createServerMediaProvenance({
      entityId: sourceId,
      entityRevision: 1,
      entityType: "CREDENTIAL",
    });
    await service.upload({
      actor: actor(),
      body: new Uint8Array([1]),
      declaredContentType: "image/jpeg",
      provenance,
      purpose: "CREDENTIAL_IMAGE",
    });
    expect(createProcessingAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "IMAGE",
        purpose: "CREDENTIAL_IMAGE",
      }),
    );
    await expect(
      service.upload({
        actor: actor(),
        body: new Uint8Array([1]),
        declaredContentType: "application/pdf",
        provenance,
        purpose: "CREDENTIAL_IMAGE",
      }),
    ).rejects.toMatchObject({ code: "INVALID_CONTENT_TYPE" });
  });

  it("reports an inaccessible private orphan when metadata persistence fails", async () => {
    const { createProcessingAsset, recordOrphanedPrivateObject, service } =
      setup();
    createProcessingAsset.mockRejectedValueOnce(new Error("database down"));

    await expect(
      service.upload({
        actor: actor(),
        body: new Uint8Array([1]),
        declaredContentType: "image/png",
        provenance: createServerMediaProvenance(),
        purpose: "PROFILE_IMAGE",
      }),
    ).rejects.toThrow("database down");
    expect(recordOrphanedPrivateObject).toHaveBeenCalledWith({
      reason: "METADATA_PERSISTENCE_FAILED",
      storageObject: { area: storageAreas.private, key: storageKey },
    });
  });
});

describe("media provenance and filename boundaries", () => {
  it("rejects invalid IDs and revisions at the trusted server boundary", () => {
    expect(() =>
      createServerMediaProvenance({
        entityId: "../../another-object",
        entityType: "JOB_REQUEST",
      }),
    ).toThrow(/valid server-resolved UUID/u);
    expect(() =>
      createServerMediaProvenance({
        entityId: sourceId,
        entityRevision: 0,
        entityType: "QUOTE_REVISION",
      }),
    ).toThrow(/positive integer/u);
  });

  it("keeps only safe basename display metadata", () => {
    expect(sanitizeDisplayFilename("..\\..\\secret\\photo.jpg")).toBe(
      "photo.jpg",
    );
    expect(sanitizeDisplayFilename("../..")).toBeNull();
    expect(sanitizeDisplayFilename("\u0000\u202e safe   name.pdf ")).toBe(
      "safe name.pdf",
    );
    expect(sanitizeDisplayFilename("a".repeat(300))).toHaveLength(255);
  });

  it("exposes stable rejection codes without echoing sensitive inputs", () => {
    const error = new MediaUploadRejectedError("INVALID_CONTENT_TYPE");
    expect(error.message).toBe("Media upload rejected: INVALID_CONTENT_TYPE");
  });
});
