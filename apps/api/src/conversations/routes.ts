import type {
  Conversation,
  ConversationChatPersistence,
  ConversationChatService,
  ConversationId,
  ConversationMessageId,
  ConversationParticipantAction,
  ConversationReportReason,
  ConversationTimelineEntry,
  ConversationPersistence,
  JobInvitationId,
  UserId,
} from "@portal/domain";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
} from "fastify";
import {
  MEDIA_UPLOAD_LIMITS,
  MediaUploadRejectedError,
  PRIVATE_MEDIA_DOWNLOAD_PATH,
  type ConversationAttachmentMediaKind,
  type ConversationAttachmentUploadService,
  type PrivateMediaEndpointResponse,
} from "@portal/media";
import type { R3PdfDeliveryObservationPersistence } from "@portal/analytics";
import { createAuthenticatedAuthorizationActor } from "@portal/authorization";

import type {
  ConversationWriteAction,
  ConversationWriteAdmission,
} from "./write-admission.js";
import type { SessionAuthorizationScope } from "../auth/guard.js";

export const CONVERSATION_PATHS = Object.freeze({
  byId: "/v1/me/conversations/:conversationId",
  byInvitation: "/v1/me/invitations/:invitationId/conversation",
  messages: "/v1/me/conversations/:conversationId/messages",
  attachments:
    "/v1/me/conversations/:conversationId/messages/:messageId/attachments/:mediaKind",
  mediaDownload: PRIVATE_MEDIA_DOWNLOAD_PATH,
  report: "/v1/me/conversations/:conversationId/reports",
  state: "/v1/me/conversations/:conversationId/state",
  timeline: "/v1/me/conversations/:conversationId/timeline",
} as const);

interface Guard {
  evaluate(
    request: FastifyRequest,
    scope?: SessionAuthorizationScope,
  ): Promise<
    | { readonly status: "ACTIVE"; readonly user: { readonly id: UserId } }
    | { readonly status: "ACCOUNT_NOT_ACTIVE" }
    | { readonly status: "AUTHENTICATION_REQUIRED" }
  >;
}

export interface ConversationRouteDependencies {
  readonly chat?: {
    readonly admission?: ConversationWriteAdmission;
    readonly attachmentUploads?: ConversationAttachmentUploadService;
    readonly csrfProtection: onRequestHookHandler;
    readonly persistence: Pick<ConversationChatPersistence, "readTimeline">;
    readonly service: ConversationChatService;
    readonly privateMediaDelivery?: {
      handleDownload(input: {
        readonly actorUserId?: string;
        readonly mediaAssetId: string;
      }): Promise<PrivateMediaEndpointResponse>;
    };
    readonly pdfDeliveryObservation?: R3PdfDeliveryObservationPersistence;
  };
  readonly conversations: Pick<
    ConversationPersistence,
    "readOwned" | "readOwnedByInvitation"
  >;
  readonly guard: Guard;
}

export function registerConversationRoutes(
  app: FastifyInstance,
  dependencies: ConversationRouteDependencies,
): void {
  app.addHook("onSend", (request, reply, payload, done) => {
    if (request.url.startsWith("/v1/media/")) {
      void reply.header("cache-control", "private, no-store");
      void reply.header("x-robots-tag", "noindex, nofollow");
      done(null, payload);
      return;
    }
    if (
      request.url.startsWith("/v1/me/conversations/") ||
      (request.url.startsWith("/v1/me/invitations/") &&
        request.url.endsWith("/conversation"))
    ) {
      void reply.header("cache-control", "no-store");
      void reply.header("x-robots-tag", "noindex, nofollow");
    }
    done(null, payload);
  });

  app.get<{ Params: { readonly conversationId: string } }>(
    CONVERSATION_PATHS.byId,
    { schema: { params: conversationParamsSchema } },
    async (request, reply) => {
      const actorUserId = await requireActor(
        request,
        reply,
        dependencies.guard,
      );
      if (actorUserId === undefined) return;
      try {
        const conversation = await dependencies.conversations.readOwned({
          actorUserId,
          conversationId: request.params.conversationId as ConversationId,
        });
        return sendConversation(conversation, reply);
      } catch (error: unknown) {
        return readError(error, reply);
      }
    },
  );

  app.get<{ Params: { readonly invitationId: string } }>(
    CONVERSATION_PATHS.byInvitation,
    { schema: { params: invitationParamsSchema } },
    async (request, reply) => {
      const actorUserId = await requireActor(
        request,
        reply,
        dependencies.guard,
      );
      if (actorUserId === undefined) return;
      try {
        const conversation =
          await dependencies.conversations.readOwnedByInvitation({
            actorUserId,
            invitationId: request.params.invitationId as JobInvitationId,
          });
        return sendConversation(conversation, reply);
      } catch (error: unknown) {
        return readError(error, reply);
      }
    },
  );

  if (dependencies.chat !== undefined) {
    registerConversationChatRoutes(app, dependencies.guard, dependencies.chat);
  }
}

function registerConversationChatRoutes(
  app: FastifyInstance,
  guard: Guard,
  chat: NonNullable<ConversationRouteDependencies["chat"]>,
): void {
  registerPrivateMediaBodyParsers(app);

  app.get<{
    Params: { readonly conversationId: string };
    Querystring: { readonly beforeSequence?: number; readonly limit?: number };
  }>(
    CONVERSATION_PATHS.timeline,
    {
      schema: {
        params: conversationParamsSchema,
        querystring: timelineQuerySchema,
      },
    },
    async (request, reply) => {
      const actorUserId = await requireActor(request, reply, guard);
      if (actorUserId === undefined) return;
      try {
        const page = await chat.persistence.readTimeline({
          actorUserId,
          conversationId: request.params.conversationId as ConversationId,
          ...(request.query.beforeSequence === undefined
            ? {}
            : { beforeSequence: request.query.beforeSequence }),
          ...(request.query.limit === undefined
            ? {}
            : { limit: request.query.limit }),
        });
        return page === null
          ? reply.code(404).send({ code: "NOT_FOUND" })
          : reply.send({
              entries: page.entries.map(serializeTimelineEntry),
              hasMore: page.hasMore,
              nextBeforeSequence: page.nextBeforeSequence,
              participantState: serializeParticipantState(
                page.participantState,
              ),
              unreadCount: page.unreadCount,
            });
      } catch (error: unknown) {
        return readError(error, reply);
      }
    },
  );

  app.post<{
    Body: {
      readonly body: string;
      readonly commandId: string;
      readonly replyToMessageId?: string | null;
    };
    Params: { readonly conversationId: string };
  }>(
    CONVERSATION_PATHS.messages,
    {
      onRequest: chat.csrfProtection,
      schema: { body: messageBodySchema, params: conversationParamsSchema },
    },
    async (request, reply) => {
      const actorUserId = await requireActor(
        request,
        reply,
        guard,
        "MESSAGING",
      );
      if (actorUserId === undefined) return;
      if (
        !(await admitWrite(
          chat.admission,
          request,
          reply,
          actorUserId,
          "MESSAGE_SEND",
        ))
      )
        return;
      try {
        const result = await chat.service.sendMessage({
          actorUserId,
          body: request.body.body,
          commandId: request.body.commandId,
          conversationId: request.params.conversationId as ConversationId,
          replyToMessageId:
            (request.body.replyToMessageId as ConversationMessageId | null) ??
            null,
        });
        if (result.status === "NOT_FOUND")
          return reply.code(404).send({ code: "NOT_FOUND" });
        if (result.status === "READ_ONLY")
          return reply.code(409).send({ code: "CONVERSATION_READ_ONLY" });
        if (result.status === "BLOCKED_BY_CONTACT_POLICY")
          return reply
            .code(422)
            .send({ code: "CONTACT_SHARING_NOT_AVAILABLE" });
        if (result.status === "SENT" || result.status === "DEDUPLICATED") {
          return reply.code(result.status === "SENT" ? 201 : 200).send({
            entry: serializeTimelineEntry(result.entry),
            status: result.status,
          });
        }
        return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
      } catch (error: unknown) {
        return commandError(error, reply);
      }
    },
  );

  app.post<{
    Body: {
      readonly action: string;
      readonly commandId: string;
      readonly expectedRevision: number;
      readonly readThroughSequence?: number | null;
    };
    Params: { readonly conversationId: string };
  }>(
    CONVERSATION_PATHS.state,
    {
      onRequest: chat.csrfProtection,
      schema: { body: stateBodySchema, params: conversationParamsSchema },
    },
    async (request, reply) => {
      const actorUserId = await requireActor(request, reply, guard);
      if (actorUserId === undefined) return;
      if (
        !(await admitWrite(
          chat.admission,
          request,
          reply,
          actorUserId,
          "PARTICIPANT_STATE",
        ))
      )
        return;
      try {
        const result = await chat.service.updateParticipantState({
          action: request.body.action as ConversationParticipantAction,
          actorUserId,
          commandId: request.body.commandId,
          conversationId: request.params.conversationId as ConversationId,
          expectedRevision: request.body.expectedRevision,
          readThroughSequence: request.body.readThroughSequence ?? null,
        });
        if (result.status === "NOT_FOUND")
          return reply.code(404).send({ code: "NOT_FOUND" });
        if (result.status === "STALE")
          return reply.code(409).send({
            code: "STALE_STATE",
            currentRevision: result.currentRevision,
          });
        if (result.status === "APPLIED" || result.status === "DEDUPLICATED") {
          return reply.send({
            participantState: serializeParticipantState(
              result.participantState,
            ),
            status: result.status,
          });
        }
        return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
      } catch (error: unknown) {
        return commandError(error, reply);
      }
    },
  );

  app.post<{
    Body: {
      readonly commandId: string;
      readonly messageId?: string | null;
      readonly reason: string;
    };
    Params: { readonly conversationId: string };
  }>(
    CONVERSATION_PATHS.report,
    {
      onRequest: chat.csrfProtection,
      schema: { body: reportBodySchema, params: conversationParamsSchema },
    },
    async (request, reply) => {
      const actorUserId = await requireActor(request, reply, guard);
      if (actorUserId === undefined) return;
      if (
        !(await admitWrite(
          chat.admission,
          request,
          reply,
          actorUserId,
          "REPORT",
        ))
      )
        return;
      try {
        const result = await chat.service.report({
          actorUserId,
          commandId: request.body.commandId,
          conversationId: request.params.conversationId as ConversationId,
          messageId:
            (request.body.messageId as ConversationMessageId | null) ?? null,
          reason: request.body.reason as ConversationReportReason,
        });
        return result.status === "NOT_FOUND"
          ? reply.code(404).send({ code: "NOT_FOUND" })
          : reply
              .code(result.status === "REPORTED" ? 201 : 200)
              .send({ status: result.status });
      } catch (error: unknown) {
        return commandError(error, reply);
      }
    },
  );

  app.post<{
    Body: Buffer;
    Params: {
      readonly conversationId: string;
      readonly mediaKind: "documents" | "photos";
      readonly messageId: string;
    };
  }>(
    CONVERSATION_PATHS.attachments,
    {
      bodyLimit: MEDIA_UPLOAD_LIMITS.documentMaxBytes,
      onRequest: chat.csrfProtection,
      schema: { params: attachmentParamsSchema },
    },
    async (request, reply) => {
      const actorUserId = await requireActor(
        request,
        reply,
        guard,
        "MESSAGING",
      );
      if (actorUserId === undefined) return;
      if (
        !(await admitWrite(
          chat.admission,
          request,
          reply,
          actorUserId,
          "ATTACHMENT_UPLOAD",
        ))
      ) {
        return;
      }
      if (chat.attachmentUploads === undefined) {
        return reply.code(503).send({ code: "UPLOAD_UNAVAILABLE" });
      }
      const mediaKind: ConversationAttachmentMediaKind =
        request.params.mediaKind === "photos" ? "IMAGE" : "PDF";
      const maximumBytes =
        mediaKind === "IMAGE"
          ? MEDIA_UPLOAD_LIMITS.imageMaxBytes
          : MEDIA_UPLOAD_LIMITS.documentMaxBytes;
      if (!Buffer.isBuffer(request.body) || request.body.byteLength < 1) {
        return reply.code(400).send({ code: "INVALID_FILE" });
      }
      if (request.body.byteLength > maximumBytes) {
        return reply.code(413).send({ code: "FILE_TOO_LARGE" });
      }
      const contentType = request.headers["content-type"] ?? "";
      if (!contentTypeAllowed(mediaKind, contentType)) {
        return reply.code(400).send({ code: "INVALID_FILE" });
      }
      try {
        const result = await chat.attachmentUploads.upload({
          actor: createAuthenticatedAuthorizationActor({
            accountState: "ACTIVE",
            id: actorUserId,
          }),
          body: request.body,
          conversationId: request.params.conversationId,
          declaredContentType: contentType,
          mediaKind,
          messageId: request.params.messageId,
        });
        return result.status === "PROCESSING"
          ? reply.code(202).send(result)
          : reply.code(404).send({ code: "UPLOAD_UNAVAILABLE" });
      } catch (error: unknown) {
        if (error instanceof MediaUploadRejectedError) {
          return reply.code(error.code === "FILE_TOO_LARGE" ? 413 : 400).send({
            code:
              error.code === "FILE_TOO_LARGE"
                ? "FILE_TOO_LARGE"
                : "INVALID_FILE",
          });
        }
        return reply.code(503).send({ code: "UPLOAD_UNAVAILABLE" });
      }
    },
  );

  app.get<{ Params: { readonly mediaAssetId: string } }>(
    CONVERSATION_PATHS.mediaDownload,
    { schema: { params: mediaDownloadParamsSchema } },
    async (request, reply) => {
      const actorUserId = await requireActor(request, reply, guard);
      if (actorUserId === undefined) return;
      if (chat.privateMediaDelivery === undefined) {
        return reply.code(503).send({ code: "MEDIA_DELIVERY_UNAVAILABLE" });
      }
      const result = await chat.privateMediaDelivery.handleDownload({
        actorUserId,
        mediaAssetId: request.params.mediaAssetId,
      });
      reply.headers({
        ...result.headers,
        "x-content-type-options": "nosniff",
      });
      if (result.statusCode === 303) {
        await chat.pdfDeliveryObservation
          ?.recordSuccessfulDelivery({
            actorUserId,
            mediaAssetId: request.params.mediaAssetId,
          })
          .catch(() => undefined);
        return reply.code(303).send();
      }
      return reply.code(result.statusCode).send(result.body);
    },
  );
}

function sendConversation(
  conversation: Conversation | null,
  reply: FastifyReply,
) {
  return conversation === null
    ? reply.code(404).send({ code: "NOT_FOUND" })
    : reply.send(serializeConversation(conversation));
}

function serializeConversation(conversation: Conversation) {
  return {
    access: conversation.access,
    counterpartDisplayName: conversation.counterpartDisplayName,
    createdAt: conversation.createdAt.toISOString(),
    id: conversation.id,
    invitationId: conversation.invitationId,
    jobRequestId: conversation.jobRequestId,
    participantRole: conversation.participantRole,
    requestTitle: conversation.requestTitle,
  };
}

function serializeTimelineEntry(entry: ConversationTimelineEntry) {
  return {
    attachments: entry.attachments.map((attachment) => ({
      assetId: attachment.assetId,
      createdAt: attachment.createdAt.toISOString(),
      kind: attachment.kind,
      status: attachment.status,
    })),
    author: entry.author,
    authorRole: entry.authorRole,
    body: entry.body,
    createdAt: entry.createdAt.toISOString(),
    id: entry.id,
    kind: entry.kind,
    hiddenByModeration: entry.hiddenByModeration,
    readByCounterpart: entry.readByCounterpart,
    replyToMessageId: entry.replyToMessageId,
    sequence: entry.sequence,
    systemEvent: entry.systemEvent,
  };
}

function serializeParticipantState(state: {
  readonly archived: boolean;
  readonly lastReadAt: Date | null;
  readonly lastReadSequence: number;
  readonly muted: boolean;
  readonly revision: number;
}) {
  return {
    archived: state.archived,
    lastReadAt: state.lastReadAt?.toISOString() ?? null,
    lastReadSequence: state.lastReadSequence,
    muted: state.muted,
    revision: state.revision,
  };
}

function commandError(error: unknown, reply: FastifyReply) {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "CONVERSATION_CHAT_IDEMPOTENCY_CONFLICT"
  ) {
    return reply.code(409).send({ code: "IDEMPOTENCY_CONFLICT" });
  }
  return readError(error, reply);
}

function readError(error: unknown, reply: FastifyReply) {
  if (error instanceof TypeError) {
    return reply.code(400).send({ code: "INVALID_REQUEST" });
  }
  return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
}

async function requireActor(
  request: FastifyRequest,
  reply: FastifyReply,
  guard: Guard,
  scope?: SessionAuthorizationScope,
): Promise<UserId | undefined> {
  const result = await guard.evaluate(request, scope);
  if (result.status === "AUTHENTICATION_REQUIRED") {
    await reply.code(401).send({ code: result.status });
    return undefined;
  }
  if (result.status === "ACCOUNT_NOT_ACTIVE") {
    await reply.code(403).send({ code: result.status });
    return undefined;
  }
  return result.user.id;
}

async function admitWrite(
  admission: ConversationWriteAdmission | undefined,
  request: FastifyRequest,
  reply: FastifyReply,
  actorUserId: UserId,
  action: ConversationWriteAction,
): Promise<boolean> {
  if (admission === undefined) {
    await reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
    return false;
  }
  try {
    const result = await admission.admit({
      action,
      actorUserId,
      ip: request.ip,
    });
    if (result === "RATE_LIMITED") {
      await reply.code(429).send({ code: "RATE_LIMITED" });
      return false;
    }
    return true;
  } catch {
    await reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
    return false;
  }
}

function registerPrivateMediaBodyParsers(app: FastifyInstance): void {
  for (const contentType of [
    "application/pdf",
    "image/heic",
    "image/heif",
    "image/jpeg",
    "image/png",
  ]) {
    if (app.hasContentTypeParser(contentType)) continue;
    app.addContentTypeParser(
      contentType,
      { parseAs: "buffer" },
      (_request, body, done) => done(null, body),
    );
  }
}

function contentTypeAllowed(
  mediaKind: ConversationAttachmentMediaKind,
  contentType: string,
): boolean {
  const normalized = contentType.trim().toLowerCase();
  return mediaKind === "PDF"
    ? normalized === "application/pdf"
    : ["image/heic", "image/heif", "image/jpeg", "image/png"].includes(
        normalized,
      );
}

const uuid = {
  pattern:
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
  type: "string",
} as const;
const conversationParamsSchema = {
  additionalProperties: false,
  properties: { conversationId: uuid },
  required: ["conversationId"],
  type: "object",
} as const;
const invitationParamsSchema = {
  additionalProperties: false,
  properties: { invitationId: uuid },
  required: ["invitationId"],
  type: "object",
} as const;
const attachmentParamsSchema = {
  additionalProperties: false,
  properties: {
    conversationId: uuid,
    mediaKind: { enum: ["documents", "photos"], type: "string" },
    messageId: uuid,
  },
  required: ["conversationId", "messageId", "mediaKind"],
  type: "object",
} as const;
const mediaDownloadParamsSchema = {
  additionalProperties: false,
  properties: { mediaAssetId: uuid },
  required: ["mediaAssetId"],
  type: "object",
} as const;
const timelineQuerySchema = {
  additionalProperties: false,
  properties: {
    beforeSequence: { minimum: 1, type: "integer" },
    limit: { maximum: 50, minimum: 1, type: "integer" },
  },
  type: "object",
} as const;
const messageBodySchema = {
  additionalProperties: false,
  properties: {
    body: { maxLength: 8_000, minLength: 1, type: "string" },
    commandId: uuid,
    replyToMessageId: { anyOf: [uuid, { type: "null" }] },
  },
  required: ["body", "commandId"],
  type: "object",
} as const;
const stateBodySchema = {
  additionalProperties: false,
  properties: {
    action: {
      enum: ["MARK_READ", "ARCHIVE", "UNARCHIVE", "MUTE", "UNMUTE"],
      type: "string",
    },
    commandId: uuid,
    expectedRevision: { minimum: 0, type: "integer" },
    readThroughSequence: {
      anyOf: [{ minimum: 1, type: "integer" }, { type: "null" }],
    },
  },
  required: ["action", "commandId", "expectedRevision"],
  type: "object",
} as const;
const reportBodySchema = {
  additionalProperties: false,
  properties: {
    commandId: uuid,
    messageId: { anyOf: [uuid, { type: "null" }] },
    reason: {
      enum: [
        "ABUSE",
        "CONTACT_CIRCUMVENTION",
        "FRAUD_OR_SCAM",
        "THREAT",
        "OTHER",
      ],
      type: "string",
    },
  },
  required: ["commandId", "reason"],
  type: "object",
} as const;
