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

export const CONVERSATION_PATHS = Object.freeze({
  byId: "/v1/me/conversations/:conversationId",
  byInvitation: "/v1/me/invitations/:invitationId/conversation",
  messages: "/v1/me/conversations/:conversationId/messages",
  report: "/v1/me/conversations/:conversationId/reports",
  state: "/v1/me/conversations/:conversationId/state",
  timeline: "/v1/me/conversations/:conversationId/timeline",
} as const);

interface Guard {
  evaluate(
    request: FastifyRequest,
  ): Promise<
    | { readonly status: "ACTIVE"; readonly user: { readonly id: UserId } }
    | { readonly status: "ACCOUNT_NOT_ACTIVE" }
    | { readonly status: "AUTHENTICATION_REQUIRED" }
  >;
}

export interface ConversationRouteDependencies {
  readonly chat?: {
    readonly csrfProtection: onRequestHookHandler;
    readonly persistence: Pick<ConversationChatPersistence, "readTimeline">;
    readonly rateLimit: { readonly max: number; readonly timeWindowMs: number };
    readonly service: ConversationChatService;
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
  const limited = {
    config: {
      rateLimit: {
        max: chat.rateLimit.max,
        timeWindow: chat.rateLimit.timeWindowMs,
      },
    },
  } as const;

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
      ...limited,
      onRequest: chat.csrfProtection,
      schema: { body: messageBodySchema, params: conversationParamsSchema },
    },
    async (request, reply) => {
      const actorUserId = await requireActor(request, reply, guard);
      if (actorUserId === undefined) return;
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
      ...limited,
      onRequest: chat.csrfProtection,
      schema: { body: stateBodySchema, params: conversationParamsSchema },
    },
    async (request, reply) => {
      const actorUserId = await requireActor(request, reply, guard);
      if (actorUserId === undefined) return;
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
      ...limited,
      onRequest: chat.csrfProtection,
      schema: { body: reportBodySchema, params: conversationParamsSchema },
    },
    async (request, reply) => {
      const actorUserId = await requireActor(request, reply, guard);
      if (actorUserId === undefined) return;
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
    author: entry.author,
    authorRole: entry.authorRole,
    body: entry.body,
    createdAt: entry.createdAt.toISOString(),
    id: entry.id,
    kind: entry.kind,
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
): Promise<UserId | undefined> {
  const result = await guard.evaluate(request);
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
