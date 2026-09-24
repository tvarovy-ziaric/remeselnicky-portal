import { createAuthenticatedAuthorizationActor } from "@portal/authorization";
import type { UserId } from "@portal/domain";
import { describe, expect, it, vi } from "vitest";

import {
  createDisputeEvidenceUploadService,
  createServerMediaProvenance,
  type ControlledMediaUploadService,
  type DisputeEvidenceUploadAuthorization,
} from "../src/index.js";

const actorUserId = "9f200000-0000-4000-8000-000000000001" as UserId;
const jobId = "9f200000-0000-4000-8000-000000000002";
const disputeId = "9f200000-0000-4000-8000-000000000003";
const assetId = "9f200000-0000-4000-8000-000000000004";

describe("dispute evidence upload composition", () => {
  it("uses server-minted exact-case provenance and enqueues central processing", async () => {
    const prepareEvidenceUpload = vi.fn<
      DisputeEvidenceUploadAuthorization["prepareEvidenceUpload"]
    >(() =>
      Promise.resolve({
        status: "AUTHORIZED",
        purpose: "DISPUTE_EVIDENCE",
        provenance: createServerMediaProvenance({
          entityType: "DISPUTE_CASE",
          entityId: disputeId,
        }),
      }),
    );
    const upload = vi.fn<ControlledMediaUploadService["upload"]>((input) =>
      Promise.resolve({
        id: assetId,
        ownerUserId: actorUserId,
        uploaderUserId: actorUserId,
        kind: "DOCUMENT",
        purpose: "DISPUTE_EVIDENCE",
        status: "PROCESSING",
        declaredContentType: "application/pdf",
        displayFilename: null,
        byteSize: input.body.byteLength,
        provenanceEntityType: "DISPUTE_CASE",
        provenanceEntityId: disputeId,
        provenanceEntityRevision: null,
        storageObject: {
          area: "private",
          key: "private/2026/09/9f200000-0000-4000-8000-000000000005" as never,
        },
        createdAt: new Date("2026-09-24T17:00:00Z"),
        updatedAt: new Date("2026-09-24T17:00:00Z"),
      }),
    );
    const enqueue = vi.fn(() => Promise.resolve());
    const service = createDisputeEvidenceUploadService({
      authorization: { prepareEvidenceUpload },
      processing: { enqueue },
      uploads: { upload },
    });
    const result = await service.upload({
      actor: createAuthenticatedAuthorizationActor({
        accountState: "ACTIVE",
        id: actorUserId,
      }),
      body: new Uint8Array([1, 2, 3]),
      jobId,
      disputeId,
      declaredContentType: "application/pdf",
      mediaKind: "PDF",
    });
    expect(result).toEqual({ assetId, kind: "PDF", status: "PROCESSING" });
    expect(JSON.stringify(result)).not.toMatch(/storage|private\//iu);
    expect(prepareEvidenceUpload).toHaveBeenCalledWith({
      actorUserId,
      jobId,
      disputeId,
    });
    expect(enqueue).toHaveBeenCalledWith({ assetId, kind: "DOCUMENT" });
  });

  it("fails closed before storage for invalid, suspended or denied actors", async () => {
    const prepareEvidenceUpload = vi.fn<
      DisputeEvidenceUploadAuthorization["prepareEvidenceUpload"]
    >(() => Promise.resolve({ status: "UPLOAD_UNAVAILABLE" }));
    const upload = vi.fn<ControlledMediaUploadService["upload"]>();
    const service = createDisputeEvidenceUploadService({
      authorization: { prepareEvidenceUpload },
      processing: { enqueue: vi.fn() },
      uploads: { upload },
    });
    for (const request of [
      { accountState: "SUSPENDED" as const, targetJobId: jobId },
      { accountState: "ACTIVE" as const, targetJobId: "bad" },
      { accountState: "ACTIVE" as const, targetJobId: jobId },
    ])
      await expect(
        service.upload({
          actor: createAuthenticatedAuthorizationActor({
            accountState: request.accountState,
            id: actorUserId,
          }),
          body: new Uint8Array([1]),
          jobId: request.targetJobId,
          disputeId,
          declaredContentType: "image/jpeg",
          mediaKind: "IMAGE",
        }),
      ).resolves.toEqual({ status: "UPLOAD_UNAVAILABLE" });
    expect(upload).not.toHaveBeenCalled();
  });
});
