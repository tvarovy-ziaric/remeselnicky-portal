import { createAuthenticatedAuthorizationActor } from "@portal/authorization";
import type { UserId } from "@portal/domain";
import { describe, expect, it, vi } from "vitest";

import {
  createQuoteDocumentUploadService,
  createServerMediaProvenance,
  type ControlledMediaUploadService,
  type QuoteDocumentUploadAuthorization,
} from "../src/index.js";

const actor = createAuthenticatedAuthorizationActor({
  accountState: "ACTIVE",
  id: "98500000-0000-4000-8000-000000000001" as UserId,
});
const quoteId = "98500000-0000-4000-8000-000000000002";

describe("Quote document upload composition", () => {
  it("uploads only through trusted exact Quote revision provenance", async () => {
    const provenance = createServerMediaProvenance({
      entityId: quoteId,
      entityRevision: 2,
      entityType: "QUOTE_REVISION",
    });
    const authorization: QuoteDocumentUploadAuthorization = {
      prepareUpload: vi.fn().mockResolvedValue({
        provenance,
        purpose: "QUOTE_DOCUMENT",
        status: "AUTHORIZED",
      }),
    };
    const upload = vi
      .fn<ControlledMediaUploadService["upload"]>()
      .mockResolvedValue({
        id: "98500000-0000-4000-8000-000000000003",
      } as never);
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const service = createQuoteDocumentUploadService({
      authorization,
      processing: { enqueue },
      uploads: { upload },
    });
    await expect(
      service.upload({
        actor,
        body: new Uint8Array([1]),
        declaredContentType: "application/pdf",
        quoteId,
        quoteRevision: 2,
      }),
    ).resolves.toEqual({
      assetId: "98500000-0000-4000-8000-000000000003",
      status: "PROCESSING",
    });
    expect(upload).toHaveBeenCalledWith(
      expect.objectContaining({ provenance, purpose: "QUOTE_DOCUMENT" }),
    );
    expect(enqueue).toHaveBeenCalledWith({
      assetId: "98500000-0000-4000-8000-000000000003",
      kind: "DOCUMENT",
    });
  });

  it("fails closed before storage when authorization denies", async () => {
    const upload = vi.fn<ControlledMediaUploadService["upload"]>();
    const service = createQuoteDocumentUploadService({
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
        quoteId,
        quoteRevision: 1,
      }),
    ).resolves.toEqual({ status: "UPLOAD_UNAVAILABLE" });
    expect(upload).not.toHaveBeenCalled();
  });

  it("fails closed when an authorization port returns another Quote revision", async () => {
    const upload = vi.fn<ControlledMediaUploadService["upload"]>();
    const service = createQuoteDocumentUploadService({
      authorization: {
        prepareUpload: vi.fn().mockResolvedValue({
          provenance: createServerMediaProvenance({
            entityId: "98500000-0000-4000-8000-000000000004",
            entityRevision: 3,
            entityType: "QUOTE_REVISION",
          }),
          purpose: "QUOTE_DOCUMENT",
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
        quoteId,
        quoteRevision: 2,
      }),
    ).resolves.toEqual({ status: "UPLOAD_UNAVAILABLE" });
    expect(upload).not.toHaveBeenCalled();
  });
});
