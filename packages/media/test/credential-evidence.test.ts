import { createAuthenticatedAuthorizationActor } from "@portal/authorization";
import type { UserId } from "@portal/domain";
import { describe, expect, it, vi } from "vitest";

import {
  createCredentialEvidenceUploadService,
  createServerMediaProvenance,
  type ControlledMediaUploadService,
  type CredentialEvidenceUploadAuthorization,
} from "../src/index.js";

const userId = "94100000-0000-4000-8000-000000000001" as UserId;
const profileId = "94100000-0000-4000-8000-000000000002";
const claimId = "94100000-0000-4000-8000-000000000003";
const assetId = "94100000-0000-4000-8000-000000000004";

describe("credential evidence upload", () => {
  it.each([
    ["DOCUMENT", "CREDENTIAL_DOCUMENT", "application/pdf"],
    ["IMAGE", "CREDENTIAL_IMAGE", "image/png"],
  ] as const)(
    "uploads private %s evidence with exact credential provenance",
    async (kind, purpose, contentType) => {
      const upload = vi.fn<ControlledMediaUploadService["upload"]>((request) =>
        Promise.resolve({
          byteSize: request.body.byteLength,
          createdAt: new Date("2026-09-28T12:00:00Z"),
          declaredContentType: contentType,
          displayFilename: null,
          id: assetId,
          kind,
          ownerUserId: userId,
          provenanceEntityId: claimId,
          provenanceEntityRevision: 1,
          provenanceEntityType: "CREDENTIAL",
          purpose,
          status: "PROCESSING",
          storageObject: { area: "private", key: "hidden/key" as never },
          updatedAt: new Date("2026-09-28T12:00:00Z"),
          uploaderUserId: userId,
        }),
      );
      const enqueue = vi.fn(() => Promise.resolve());
      const service = createCredentialEvidenceUploadService({
        authorization: {
          listOwnedUploads: () => Promise.resolve([]),
          prepareUpload: () =>
            Promise.resolve({
              provenance: createServerMediaProvenance({
                entityId: claimId,
                entityRevision: 1,
                entityType: "CREDENTIAL",
              }),
              purpose,
              status: "AUTHORIZED",
            }),
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
        claimId,
        craftsmanProfileId: profileId,
        declaredContentType: contentType,
        expectedRevision: 1,
        mediaKind: kind,
      });
      expect(result).toEqual({ assetId, kind, status: "PROCESSING" });
      expect(enqueue).toHaveBeenCalledWith({ assetId, kind });
      expect(JSON.stringify(result)).not.toMatch(/hidden\/key|storage/iu);
    },
  );

  it("fails closed before storage for mismatched purpose or provenance", async () => {
    const upload = vi.fn<ControlledMediaUploadService["upload"]>();
    const authorization: CredentialEvidenceUploadAuthorization = {
      listOwnedUploads: () => Promise.resolve([]),
      prepareUpload: () =>
        Promise.resolve({
          provenance: createServerMediaProvenance({
            entityId: "94100000-0000-4000-8000-000000000099",
            entityRevision: 1,
            entityType: "CREDENTIAL",
          }),
          purpose: "CREDENTIAL_DOCUMENT",
          status: "AUTHORIZED",
        }),
    };
    const service = createCredentialEvidenceUploadService({
      authorization,
      processing: { enqueue: vi.fn() },
      uploads: { upload },
    });

    await expect(
      service.upload({
        actor: createAuthenticatedAuthorizationActor({
          accountState: "ACTIVE",
          id: userId,
        }),
        body: new Uint8Array([1]),
        claimId,
        craftsmanProfileId: profileId,
        declaredContentType: "image/png",
        expectedRevision: 1,
        mediaKind: "IMAGE",
      }),
    ).resolves.toEqual({ status: "UPLOAD_UNAVAILABLE" });
    expect(upload).not.toHaveBeenCalled();
  });

  it("does not disclose uploads to inactive actors", async () => {
    const listOwnedUploads = vi.fn(() =>
      Promise.resolve([
        { assetId, kind: "IMAGE" as const, status: "READY" as const },
      ]),
    );
    const service = createCredentialEvidenceUploadService({
      authorization: {
        listOwnedUploads,
        prepareUpload: () => Promise.resolve({ status: "UPLOAD_UNAVAILABLE" }),
      },
      processing: { enqueue: vi.fn() },
      uploads: { upload: vi.fn() },
    });

    await expect(
      service.list({
        actor: createAuthenticatedAuthorizationActor({
          accountState: "SUSPENDED",
          id: userId,
        }),
        claimId,
        craftsmanProfileId: profileId,
      }),
    ).resolves.toEqual({ status: "UPLOAD_UNAVAILABLE" });
    expect(listOwnedUploads).not.toHaveBeenCalled();
  });
});
