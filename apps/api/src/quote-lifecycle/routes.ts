import {
  QuoteIdempotencyError,
  type QuoteAcceptanceContext,
  type QuoteAuthoringMode,
  type QuoteId,
  type QuoteLifecyclePersistence,
  type QuoteRevisionState,
  type UserId,
} from "@portal/domain";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
} from "fastify";
import type { SessionAuthorizationScope } from "../auth/guard.js";

export const QUOTE_LIFECYCLE_PATHS = Object.freeze({
  context: "/v1/me/quotes/:quoteId/lifecycle",
  reconfirm: "/v1/me/quotes/:quoteId/reconfirm",
  withdraw: "/v1/me/quotes/:quoteId/withdraw",
});

interface Guard {
  evaluate(
    request: FastifyRequest,
    scope?: SessionAuthorizationScope,
  ): Promise<
    | { readonly status: "ACTIVE"; readonly user: { readonly id: UserId } }
    | { readonly status: "ACCOUNT_NOT_ACTIVE" | "AUTHENTICATION_REQUIRED" }
  >;
}

export interface QuoteLifecycleRouteDependencies {
  readonly csrfProtection: onRequestHookHandler;
  readonly guard: Guard;
  readonly lifecycle: Pick<
    QuoteLifecyclePersistence,
    "readOwnedContext" | "reconfirm" | "withdraw"
  >;
}

export function registerQuoteLifecycleRoutes(
  app: FastifyInstance,
  dependencies: QuoteLifecycleRouteDependencies,
): void {
  app.addHook("onSend", (request, reply, payload, done) => {
    if (request.url.startsWith("/v1/me/quotes/")) {
      void reply.header("cache-control", "private, no-store");
      void reply.header("x-robots-tag", "noindex, nofollow");
    }
    done(null, payload);
  });
  app.get<{
    Params: { quoteId: string };
    Querystring: { quoteRevision?: number };
  }>(
    QUOTE_LIFECYCLE_PATHS.context,
    {
      schema: {
        params: paramsSchema,
        querystring: {
          additionalProperties: false,
          properties: { quoteRevision: { type: "integer", minimum: 1 } },
          type: "object",
        },
      },
    },
    async (request, reply) => {
      const actorUserId = await requireActor(
        request,
        reply,
        dependencies.guard,
      );
      if (actorUserId === undefined) return;
      try {
        const context = await dependencies.lifecycle.readOwnedContext({
          actorUserId,
          quoteId: request.params.quoteId as QuoteId,
          ...(request.query.quoteRevision === undefined
            ? {}
            : { quoteRevision: request.query.quoteRevision }),
        });
        return context === null
          ? reply.code(404).send({ code: "NOT_FOUND" })
          : reply.send(serializeContext(context));
      } catch {
        return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
      }
    },
  );
  app.post<{
    Body: {
      commandId: string;
      expectedStateRevision: number;
      quoteRevision: number;
    };
    Params: { quoteId: string };
  }>(
    QUOTE_LIFECYCLE_PATHS.withdraw,
    {
      onRequest: dependencies.csrfProtection,
      schema: { body: withdrawSchema, params: paramsSchema },
    },
    async (request, reply) => {
      const actorUserId = await requireActor(
        request,
        reply,
        dependencies.guard,
        "QUOTING",
      );
      if (actorUserId === undefined) return;
      try {
        const result = await dependencies.lifecycle.withdraw({
          actorUserId,
          commandId: request.body.commandId,
          expectedStateRevision: request.body.expectedStateRevision,
          quoteId: request.params.quoteId as QuoteId,
          quoteRevision: request.body.quoteRevision,
        });
        return "context" in result
          ? reply.send({
              context: serializeContext(result.context),
              status: result.status,
            })
          : sendFailure(reply, result.status);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
  app.post<{
    Body: {
      authoringMode: QuoteAuthoringMode;
      commandId: string;
      expectedSourceStateRevision: number;
      sourceQuoteRevision: number;
      sourceState: QuoteRevisionState;
    };
    Params: { quoteId: string };
  }>(
    QUOTE_LIFECYCLE_PATHS.reconfirm,
    {
      onRequest: dependencies.csrfProtection,
      schema: { body: reconfirmSchema, params: paramsSchema },
    },
    async (request, reply) => {
      const actorUserId = await requireActor(
        request,
        reply,
        dependencies.guard,
        "QUOTING",
      );
      if (actorUserId === undefined) return;
      try {
        const result = await dependencies.lifecycle.reconfirm({
          actorUserId,
          authoringMode: request.body.authoringMode,
          commandId: request.body.commandId,
          expectedSourceStateRevision: request.body.expectedSourceStateRevision,
          quoteId: request.params.quoteId as QuoteId,
          sourceQuoteRevision: request.body.sourceQuoteRevision,
          sourceState: request.body.sourceState as
            "SUBMITTED" | "EXPIRED" | "WITHDRAWN",
        });
        if ("quote" in result)
          return reply.code(result.status === "APPLIED" ? 201 : 200).send({
            draftRevision: result.quote.currentDraft?.revision ?? null,
            quoteId: result.quote.id,
            status: result.status,
          });
        return sendFailure(reply, result.status);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
}

async function requireActor(
  request: FastifyRequest,
  reply: FastifyReply,
  guard: Guard,
  scope?: SessionAuthorizationScope,
): Promise<UserId | undefined> {
  const result = await guard.evaluate(request, scope);
  if (result.status === "ACTIVE") return result.user.id;
  await reply
    .code(result.status === "AUTHENTICATION_REQUIRED" ? 401 : 403)
    .send({ code: result.status });
  return undefined;
}
function serializeContext(context: QuoteAcceptanceContext) {
  return { ...context, validUntil: context.validUntil?.toISOString() ?? null };
}
function sendFailure(reply: FastifyReply, status: string) {
  if (status === "NOT_FOUND") return reply.code(404).send({ code: status });
  if (
    status === "STALE_REVISION" ||
    status === "INVALID_TRANSITION" ||
    status === "READ_ONLY" ||
    status === "AUTHORING_NOT_READY" ||
    status === "NOT_DUE"
  )
    return reply.code(409).send({ code: status });
  return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
}
function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof QuoteIdempotencyError)
    return reply.code(409).send({ code: "IDEMPOTENCY_CONFLICT" });
  if (error instanceof TypeError)
    return reply.code(400).send({ code: "INVALID_REQUEST" });
  return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
}

const uuid = {
  pattern:
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
  type: "string",
} as const;
const paramsSchema = {
  additionalProperties: false,
  properties: { quoteId: uuid },
  required: ["quoteId"],
  type: "object",
} as const;
const withdrawSchema = {
  additionalProperties: false,
  properties: {
    commandId: uuid,
    expectedStateRevision: { minimum: 1, type: "integer" },
    quoteRevision: { minimum: 1, type: "integer" },
  },
  required: ["commandId", "expectedStateRevision", "quoteRevision"],
  type: "object",
} as const;
const reconfirmSchema = {
  additionalProperties: false,
  properties: {
    authoringMode: {
      enum: ["PLATFORM_STRUCTURED", "EXTERNAL_PDF"],
      type: "string",
    },
    commandId: uuid,
    expectedSourceStateRevision: { minimum: 1, type: "integer" },
    sourceQuoteRevision: { minimum: 1, type: "integer" },
    sourceState: {
      enum: ["SUBMITTED", "EXPIRED", "WITHDRAWN"],
      type: "string",
    },
  },
  required: [
    "authoringMode",
    "commandId",
    "expectedSourceStateRevision",
    "sourceQuoteRevision",
    "sourceState",
  ],
  type: "object",
} as const;
