import type { AuthorizationActor } from "@portal/authorization";
import {
  CONVERSATION_MESSAGE_MAX_ATTACHMENTS,
  CONVERSATION_MESSAGE_MAX_IMAGE_ATTACHMENTS,
} from "@portal/domain";

import type { ProcessingMediaAsset, ServerMediaProvenance } from "./model.js";
import type { ControlledMediaUploadService } from "./upload.js";

export type ConversationAttachmentMediaKind = "IMAGE" | "PDF";

export type PrepareConversationAttachmentUploadResult = Readonly<
  | {
      readonly provenance: ServerMediaProvenance;
      readonly purpose: "CHAT_DOCUMENT" | "CHAT_IMAGE";
      readonly status: "AUTHORIZED";
    }
  | { readonly status: "UPLOAD_UNAVAILABLE" }
>;

export interface ConversationAttachmentUploadAuthorization {
  /**
   * Revalidates and locks the ACTIVE exact participant, writable conversation,
   * and an immutable HUMAN_MESSAGE authored by that participant.
   */
  prepareUpload(input: {
    readonly actorUserId: string;
    readonly conversationId: string;
    readonly mediaKind: ConversationAttachmentMediaKind;
    readonly messageId: string;
  }): Promise<PrepareConversationAttachmentUploadResult>;
}

export interface ConversationAttachmentProcessingDispatcher {
  enqueue(input: {
    readonly assetId: string;
    readonly kind: "DOCUMENT" | "IMAGE";
  }): Promise<void>;
}

export type ConversationAttachmentUploadResult = Readonly<
  | {
      readonly assetId: string;
      readonly kind: ConversationAttachmentMediaKind;
      readonly status: "PROCESSING";
    }
  | { readonly status: "UPLOAD_UNAVAILABLE" }
>;

export interface ConversationAttachmentUploadService {
  upload(input: {
    readonly actor: AuthorizationActor;
    readonly body: Uint8Array;
    readonly conversationId: string;
    readonly declaredContentType: string;
    readonly mediaKind: ConversationAttachmentMediaKind;
    readonly messageId: string;
    readonly originalFilename?: string;
  }): Promise<ConversationAttachmentUploadResult>;
}

type ConversationAttachmentUploadInput = Parameters<
  ConversationAttachmentUploadService["upload"]
>[0];

export const CONVERSATION_ATTACHMENT_UPLOAD_LIMITS = Object.freeze({
  maximumImagesPerMessage: CONVERSATION_MESSAGE_MAX_IMAGE_ATTACHMENTS,
  maximumTotalPerMessage: CONVERSATION_MESSAGE_MAX_ATTACHMENTS,
});

/**
 * Text messages are created first by the chat command. This composer then
 * attaches centrally processed private media to that exact immutable message.
 */
export function createConversationAttachmentUploadService(input: {
  readonly authorization: ConversationAttachmentUploadAuthorization;
  readonly processing: ConversationAttachmentProcessingDispatcher;
  readonly uploads: ControlledMediaUploadService;
}): ConversationAttachmentUploadService {
  return Object.freeze({
    async upload(uploadInput: ConversationAttachmentUploadInput) {
      if (
        uploadInput.actor.kind !== "AUTHENTICATED" ||
        uploadInput.actor.accountState !== "ACTIVE" ||
        !isUuid(uploadInput.conversationId) ||
        !isUuid(uploadInput.messageId) ||
        (uploadInput.mediaKind !== "IMAGE" && uploadInput.mediaKind !== "PDF")
      ) {
        return { status: "UPLOAD_UNAVAILABLE" } as const;
      }
      const prepared = await input.authorization.prepareUpload({
        actorUserId: uploadInput.actor.userId,
        conversationId: uploadInput.conversationId,
        mediaKind: uploadInput.mediaKind,
        messageId: uploadInput.messageId,
      });
      if (prepared.status !== "AUTHORIZED") return prepared;
      const expectedPurpose =
        uploadInput.mediaKind === "IMAGE" ? "CHAT_IMAGE" : "CHAT_DOCUMENT";
      if (prepared.purpose !== expectedPurpose) {
        return { status: "UPLOAD_UNAVAILABLE" } as const;
      }
      const asset: ProcessingMediaAsset = await input.uploads.upload({
        actor: uploadInput.actor,
        body: uploadInput.body,
        declaredContentType: uploadInput.declaredContentType,
        ...(uploadInput.originalFilename === undefined
          ? {}
          : { originalFilename: uploadInput.originalFilename }),
        provenance: prepared.provenance,
        purpose: prepared.purpose,
      });
      const processingKind =
        uploadInput.mediaKind === "IMAGE" ? "IMAGE" : "DOCUMENT";
      await input.processing.enqueue({
        assetId: asset.id,
        kind: processingKind,
      });
      return Object.freeze({
        assetId: asset.id,
        kind: uploadInput.mediaKind,
        status: "PROCESSING" as const,
      });
    },
  });
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}
