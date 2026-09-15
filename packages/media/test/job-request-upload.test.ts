import { createAuthenticatedAuthorizationActor } from "@portal/authorization";
import type { UserId } from "@portal/domain";
import { describe, expect, it, vi } from "vitest";

import {
  createJobRequestMediaUploadService,
  createServerMediaProvenance,
  type ControlledMediaUploadService,
  type JobRequestMediaUploadAuthorization,
} from "../src/index.js";

const userId = "93000000-0000-4000-8000-000000000001" as UserId;
const jobRequestId = "93000000-0000-4000-8000-000000000002";

describe("job request media upload", () => {
  it("mints no client provenance and returns no storage material", async () => {
    const prepareUpload = vi.fn<
      JobRequestMediaUploadAuthorization["prepareUpload"]
    >(() =>
      Promise.resolve({
        provenance: createServerMediaProvenance({
          entityId: jobRequestId,
          entityRevision: 4,
          entityType: "JOB_REQUEST",
        }),
        purpose: "JOB_REQUEST_IMAGE",
        status: "AUTHORIZED",
      }),
    );
    const upload = vi.fn<ControlledMediaUploadService["upload"]>((input) =>
      Promise.resolve({
        byteSize: input.body.byteLength,
        createdAt: new Date("2026-09-15T07:00:00Z"),
        declaredContentType: "image/jpeg",
        displayFilename: null,
        id: "93000000-0000-4000-8000-000000000003",
        kind: "IMAGE",
        ownerUserId: userId,
        provenanceEntityId: jobRequestId,
        provenanceEntityRevision: 4,
        provenanceEntityType: "JOB_REQUEST",
        purpose: "JOB_REQUEST_IMAGE",
        status: "PROCESSING",
        storageObject: {
          area: "private",
          key: "private/2026/09/93000000-0000-4000-8000-000000000004" as never,
        },
        updatedAt: new Date("2026-09-15T07:00:00Z"),
        uploaderUserId: userId,
      }),
    );
    const enqueue = vi.fn(() => Promise.resolve());
    const service = createJobRequestMediaUploadService({
      authorization: {
        listOwnedUploads: () => Promise.resolve([]),
        prepareUpload,
      },
      processing: { enqueue },
      uploads: { upload },
    });
    const result = await service.upload({
      actor: createAuthenticatedAuthorizationActor({
        accountState: "ACTIVE",
        id: userId,
      }),
      body: new Uint8Array([1, 2, 3]),
      declaredContentType: "image/jpeg",
      expectedRevision: 4,
      jobRequestId,
      mediaKind: "IMAGE",
    });
    expect(result).toEqual({
      assetId: "93000000-0000-4000-8000-000000000003",
      kind: "IMAGE",
      status: "PROCESSING",
    });
    expect(JSON.stringify(result)).not.toMatch(/storage|private\//iu);
    expect(prepareUpload).toHaveBeenCalledWith({
      actorUserId: userId,
      expectedRevision: 4,
      jobRequestId,
      mediaKind: "IMAGE",
    });
    expect(enqueue).toHaveBeenCalledWith({
      assetId: "93000000-0000-4000-8000-000000000003",
      kind: "IMAGE",
    });
  });

  it("fails closed before storage for stale or inactive authorization", async () => {
    const upload = vi.fn<ControlledMediaUploadService["upload"]>();
    const prepareUpload = vi.fn<
      JobRequestMediaUploadAuthorization["prepareUpload"]
    >(() => Promise.resolve({ status: "UPLOAD_UNAVAILABLE" }));
    const service = createJobRequestMediaUploadService({
      authorization: {
        listOwnedUploads: () => Promise.resolve([]),
        prepareUpload,
      },
      processing: { enqueue: vi.fn(() => Promise.resolve()) },
      uploads: { upload },
    });
    await expect(
      service.upload({
        actor: createAuthenticatedAuthorizationActor({
          accountState: "SUSPENDED",
          id: userId,
        }),
        body: new Uint8Array([1]),
        declaredContentType: "application/pdf",
        expectedRevision: 2,
        jobRequestId,
        mediaKind: "DOCUMENT",
      }),
    ).resolves.toEqual({ status: "UPLOAD_UNAVAILABLE" });
    expect(prepareUpload).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it("lists only repository-authorized processing states", async () => {
    const listOwnedUploads = vi.fn<
      JobRequestMediaUploadAuthorization["listOwnedUploads"]
    >(() =>
      Promise.resolve([
        {
          assetId: "93000000-0000-4000-8000-000000000005",
          kind: "DOCUMENT",
          status: "READY",
        },
      ]),
    );
    const service = createJobRequestMediaUploadService({
      authorization: {
        listOwnedUploads,
        prepareUpload: () => Promise.resolve({ status: "UPLOAD_UNAVAILABLE" }),
      },
      processing: { enqueue: vi.fn(() => Promise.resolve()) },
      uploads: { upload: vi.fn() },
    });
    await expect(
      service.list({
        actor: createAuthenticatedAuthorizationActor({
          accountState: "ACTIVE",
          id: userId,
        }),
        jobRequestId,
      }),
    ).resolves.toEqual({
      status: "OK",
      uploads: [
        {
          assetId: "93000000-0000-4000-8000-000000000005",
          kind: "DOCUMENT",
          status: "READY",
        },
      ],
    });
  });
});
