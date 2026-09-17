import { createAuthenticatedAuthorizationActor } from "@portal/authorization";
import type { UserId } from "@portal/domain";
import { describe, expect, it, vi } from "vitest";

import {
  createChangeOrderDocumentUploadService,
  createServerMediaProvenance,
  type ControlledMediaUploadService,
} from "../src/index.js";

const actor = createAuthenticatedAuthorizationActor({
  accountState: "ACTIVE",
  id: "98600000-0000-4000-8000-000000000001" as UserId,
});
const jobId = "98600000-0000-4000-8000-000000000002";
const revisionId = "98600000-0000-4000-8000-000000000003";

describe("Change-order document upload composition", () => {
  it("uploads only through trusted exact revision provenance", async () => {
    const provenance = createServerMediaProvenance({
      entityId: revisionId,
      entityRevision: 2,
      entityType: "CHANGE_ORDER_REVISION",
    });
    const upload = vi
      .fn<ControlledMediaUploadService["upload"]>()
      .mockResolvedValue({
        id: "98600000-0000-4000-8000-000000000004",
      } as never);
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const prepareUpload = vi.fn().mockResolvedValue({
      provenance,
      purpose: "CHANGE_ORDER_DOCUMENT",
      status: "AUTHORIZED",
    });
    const service = createChangeOrderDocumentUploadService({
      authorization: { prepareUpload },
      processing: { enqueue },
      uploads: { upload },
    });
    await expect(
      service.upload({
        actor,
        body: new Uint8Array([1]),
        declaredContentType: "application/pdf",
        jobId,
        revisionId,
      }),
    ).resolves.toEqual({
      assetId: "98600000-0000-4000-8000-000000000004",
      status: "PROCESSING",
    });
    expect(prepareUpload).toHaveBeenCalledWith({
      actorUserId: actor.userId,
      jobId,
      revisionId,
    });
    expect(upload).toHaveBeenCalledWith(
      expect.objectContaining({ provenance, purpose: "CHANGE_ORDER_DOCUMENT" }),
    );
    expect(enqueue).toHaveBeenCalledWith({
      assetId: "98600000-0000-4000-8000-000000000004",
      kind: "DOCUMENT",
    });
  });

  it("fails closed before storage when authorization denies", async () => {
    const upload = vi.fn<ControlledMediaUploadService["upload"]>();
    const service = createChangeOrderDocumentUploadService({
      authorization: {
        prepareUpload: vi
          .fn()
          .mockResolvedValue({ status: "UPLOAD_UNAVAILABLE" }),
      },
      processing: { enqueue: vi.fn() },
      uploads: { upload },
    });
    await expect(
      service.upload({
        actor,
        body: new Uint8Array([1]),
        declaredContentType: "application/pdf",
        jobId,
        revisionId,
      }),
    ).resolves.toEqual({ status: "UPLOAD_UNAVAILABLE" });
    expect(upload).not.toHaveBeenCalled();
  });

  it("rejects trusted provenance for another revision or purpose", async () => {
    const upload = vi.fn<ControlledMediaUploadService["upload"]>();
    const service = createChangeOrderDocumentUploadService({
      authorization: {
        prepareUpload: vi.fn().mockResolvedValue({
          provenance: createServerMediaProvenance({
            entityId: "98600000-0000-4000-8000-000000000005",
            entityRevision: 2,
            entityType: "CHANGE_ORDER_REVISION",
          }),
          purpose: "CHANGE_ORDER_DOCUMENT",
          status: "AUTHORIZED",
        }),
      },
      processing: { enqueue: vi.fn() },
      uploads: { upload },
    });
    await expect(
      service.upload({
        actor,
        body: new Uint8Array([1]),
        declaredContentType: "application/pdf",
        jobId,
        revisionId,
      }),
    ).resolves.toEqual({ status: "UPLOAD_UNAVAILABLE" });
    expect(upload).not.toHaveBeenCalled();
  });
});
