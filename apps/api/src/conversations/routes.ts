import type {
  Conversation,
  ConversationId,
  ConversationPersistence,
  JobInvitationId,
  UserId,
} from "@portal/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export const CONVERSATION_PATHS = Object.freeze({
  byId: "/v1/me/conversations/:conversationId",
  byInvitation: "/v1/me/invitations/:invitationId/conversation",
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
