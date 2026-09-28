import { createAuthenticatedAuthorizationActor } from "@portal/authorization";
import type { UserId } from "@portal/domain";
import { describe, expect, it, vi } from "vitest";

import {
  createPortfolioProjectPhotoUploadService,
  createServerMediaProvenance,
  type ControlledMediaUploadService,
  type PortfolioProjectPhotoUploadAuthorization,
} from "../src/index.js";

const userId = "93100000-0000-4000-8000-000000000001" as UserId;
const profileId = "93100000-0000-4000-8000-000000000002";
const projectId = "93100000-0000-4000-8000-000000000003";
const assetId = "93100000-0000-4000-8000-000000000004";

describe("portfolio project photo upload", () => {
  it("uses server-minted provenance and returns no storage material", async () => {
    const prepareUpload = vi.fn<
      PortfolioProjectPhotoUploadAuthorization["prepareUpload"]
    >(() =>
      Promise.resolve({
        provenance: createServerMediaProvenance({
          entityId: projectId,
          entityRevision: 2,
          entityType: "PORTFOLIO_PROJECT",
        }),
        purpose: "PORTFOLIO_IMAGE",
        status: "AUTHORIZED",
      }),
    );
    const upload = vi.fn<ControlledMediaUploadService["upload"]>((request) =>
      Promise.resolve({
        byteSize: request.body.byteLength,
        createdAt: new Date("2026-09-28T12:00:00Z"),
        declaredContentType: "image/png",
        displayFilename: null,
        id: assetId,
        kind: "IMAGE",
        ownerUserId: userId,
        provenanceEntityId: projectId,
        provenanceEntityRevision: 2,
        provenanceEntityType: "PORTFOLIO_PROJECT",
        purpose: "PORTFOLIO_IMAGE",
        status: "PROCESSING",
        storageObject: { area: "private", key: "private/hidden" as never },
        updatedAt: new Date("2026-09-28T12:00:00Z"),
        uploaderUserId: userId,
      }),
    );
    const enqueue = vi.fn(() => Promise.resolve());
    const service = createPortfolioProjectPhotoUploadService({
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
      craftsmanProfileId: profileId,
      declaredContentType: "image/png",
      expectedProjectRevision: 2,
      portfolioProjectId: projectId,
    });

    expect(result).toEqual({ assetId, kind: "IMAGE", status: "PROCESSING" });
    expect(JSON.stringify(result)).not.toMatch(/storage|private\/hidden/iu);
    expect(prepareUpload).toHaveBeenCalledWith({
      actorUserId: userId,
      craftsmanProfileId: profileId,
      expectedProjectRevision: 2,
      portfolioProjectId: projectId,
    });
    expect(enqueue).toHaveBeenCalledWith({ assetId, kind: "IMAGE" });
  });

  it("fails closed before storage for inactive or unavailable ownership", async () => {
    const upload = vi.fn<ControlledMediaUploadService["upload"]>();
    const prepareUpload = vi.fn<
      PortfolioProjectPhotoUploadAuthorization["prepareUpload"]
    >(() => Promise.resolve({ status: "UPLOAD_UNAVAILABLE" }));
    const service = createPortfolioProjectPhotoUploadService({
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
        craftsmanProfileId: profileId,
        declaredContentType: "image/png",
        expectedProjectRevision: 2,
        portfolioProjectId: projectId,
      }),
    ).resolves.toEqual({ status: "UPLOAD_UNAVAILABLE" });
    expect(prepareUpload).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it("lists only authorization-approved bounded states", async () => {
    const listOwnedUploads = vi.fn<
      PortfolioProjectPhotoUploadAuthorization["listOwnedUploads"]
    >(() => Promise.resolve([{ assetId, kind: "IMAGE", status: "READY" }]));
    const service = createPortfolioProjectPhotoUploadService({
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
        craftsmanProfileId: profileId,
        portfolioProjectId: projectId,
      }),
    ).resolves.toEqual({
      status: "OK",
      uploads: [{ assetId, kind: "IMAGE", status: "READY" }],
    });
  });
});
