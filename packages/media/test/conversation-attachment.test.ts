import { createAuthenticatedAuthorizationActor } from "@portal/authorization";
import type { UserId } from "@portal/domain";
import { describe, expect, it, vi } from "vitest";

import {
  CONVERSATION_ATTACHMENT_UPLOAD_LIMITS,
  createConversationAttachmentUploadService,
  createServerMediaProvenance,
  type ControlledMediaUploadService,
  type ConversationAttachmentUploadAuthorization,
} from "../src/index.js";

const actorUserId = "9f100000-0000-4000-8000-000000000001" as UserId;
const conversationId = "9f100000-0000-4000-8000-000000000002";
const messageId = "9f100000-0000-4000-8000-000000000003";
const assetId = "9f100000-0000-4000-8000-000000000004";

describe("conversation attachment upload composition", () => {
  it("uses only server-minted message provenance and returns no storage material", async () => {
    const prepareUpload = vi.fn<
      ConversationAttachmentUploadAuthorization["prepareUpload"]
    >(() =>
      Promise.resolve({
        provenance: createServerMediaProvenance({
          entityId: messageId,
          entityRevision: 7,
          entityType: "CONVERSATION_MESSAGE",
        }),
        purpose: "CHAT_IMAGE",
        status: "AUTHORIZED",
      }),
    );
    const upload = vi.fn<ControlledMediaUploadService["upload"]>((input) =>
      Promise.resolve({
        byteSize: input.body.byteLength,
        createdAt: new Date("2026-09-15T10:00:00Z"),
        declaredContentType: "image/jpeg",
        displayFilename: null,
        id: assetId,
        kind: "IMAGE",
        ownerUserId: actorUserId,
        provenanceEntityId: messageId,
        provenanceEntityRevision: 7,
        provenanceEntityType: "CONVERSATION_MESSAGE",
        purpose: "CHAT_IMAGE",
        status: "PROCESSING",
        storageObject: {
          area: "private",
          key: "private/2026/09/9f100000-0000-4000-8000-000000000005" as never,
        },
        updatedAt: new Date("2026-09-15T10:00:00Z"),
        uploaderUserId: actorUserId,
      }),
    );
    const enqueue = vi.fn(() => Promise.resolve());
    const service = createConversationAttachmentUploadService({
      authorization: { prepareUpload },
      processing: { enqueue },
      uploads: { upload },
    });

    const result = await service.upload({
      actor: createAuthenticatedAuthorizationActor({
        accountState: "ACTIVE",
        id: actorUserId,
      }),
      body: new Uint8Array([1, 2, 3]),
      conversationId,
      declaredContentType: "image/jpeg",
      mediaKind: "IMAGE",
      messageId,
    });

    expect(result).toEqual({ assetId, kind: "IMAGE", status: "PROCESSING" });
    expect(JSON.stringify(result)).not.toMatch(/storage|private\//iu);
    expect(prepareUpload).toHaveBeenCalledWith({
      actorUserId,
      conversationId,
      mediaKind: "IMAGE",
      messageId,
    });
    expect(enqueue).toHaveBeenCalledWith({ assetId, kind: "IMAGE" });
  });

  it("fails closed before storage for invalid, suspended, or denied actors", async () => {
    const prepareUpload = vi.fn<
      ConversationAttachmentUploadAuthorization["prepareUpload"]
    >(() => Promise.resolve({ status: "UPLOAD_UNAVAILABLE" }));
    const upload = vi.fn<ControlledMediaUploadService["upload"]>();
    const service = createConversationAttachmentUploadService({
      authorization: { prepareUpload },
      processing: { enqueue: vi.fn() },
      uploads: { upload },
    });

    await expect(
      service.upload({
        actor: createAuthenticatedAuthorizationActor({
          accountState: "SUSPENDED",
          id: actorUserId,
        }),
        body: new Uint8Array([1]),
        conversationId,
        declaredContentType: "application/pdf",
        mediaKind: "PDF",
        messageId,
      }),
    ).resolves.toEqual({ status: "UPLOAD_UNAVAILABLE" });
    await expect(
      service.upload({
        actor: createAuthenticatedAuthorizationActor({
          accountState: "ACTIVE",
          id: actorUserId,
        }),
        body: new Uint8Array([1]),
        conversationId,
        declaredContentType: "application/pdf",
        mediaKind: "PDF",
        messageId,
      }),
    ).resolves.toEqual({ status: "UPLOAD_UNAVAILABLE" });
    expect(upload).not.toHaveBeenCalled();
  });

  it("exports explicit technical abuse limits", () => {
    expect(CONVERSATION_ATTACHMENT_UPLOAD_LIMITS).toEqual({
      maximumImagesPerMessage: 5,
      maximumTotalPerMessage: 10,
    });
  });
});
