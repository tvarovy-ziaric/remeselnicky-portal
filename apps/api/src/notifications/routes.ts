import type { NotificationCategory } from "@portal/notifications";
import {
  getNotificationPresentation,
  NOTIFICATION_CATEGORIES,
} from "@portal/notifications";
import type { NotificationRepository } from "@portal/db";
import type { UserId } from "@portal/domain";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
} from "fastify";

export const NOTIFICATION_PATHS = Object.freeze({
  archive: "/v1/me/notifications/:notificationId/archive",
  count: "/v1/me/notifications/unread-count",
  list: "/v1/me/notifications",
  markAllRead: "/v1/me/notifications/read-all",
  markRead: "/v1/me/notifications/:notificationId/read",
  preference: "/v1/me/notifications/preferences/:category",
  preferences: "/v1/me/notifications/preferences",
} as const);

interface RateLimit {
  readonly max: number;
  readonly timeWindowMs: number;
}
export interface NotificationRouteDependencies {
  readonly notifications: Pick<
    NotificationRepository,
    | "archive"
    | "getPreferences"
    | "list"
    | "markAllRead"
    | "markRead"
    | "setPreference"
    | "unreadCount"
  >;
  readonly guard: {
    evaluate(
      request: FastifyRequest,
    ): Promise<
      | { readonly status: "ACTIVE"; readonly user: { readonly id: UserId } }
      | { readonly status: "ACCOUNT_NOT_ACTIVE" | "AUTHENTICATION_REQUIRED" }
    >;
  };
  readonly csrfProtection: onRequestHookHandler;
  readonly rateLimit: { readonly read: RateLimit; readonly write: RateLimit };
}

interface ListQuery {
  readonly filter?: "ALL" | "UNREAD";
  readonly limit?: number;
}
interface PreferenceBody {
  readonly emailEnabled: boolean;
}

export function registerNotificationRoutes(
  app: FastifyInstance,
  dependencies: NotificationRouteDependencies,
): void {
  app.get<{ Querystring: ListQuery }>(
    NOTIFICATION_PATHS.list,
    {
      config: { rateLimit: fastifyLimit(dependencies.rateLimit.read) },
      onSend: privateHeaders,
      schema: { querystring: listQuerySchema },
    },
    async (request, reply) => {
      const recipientUserId = await activeActor(request, reply, dependencies);
      if (recipientUserId === null) return;
      try {
        const items = await dependencies.notifications.list({
          filter: request.query.filter ?? "ALL",
          limit: request.query.limit ?? 50,
          recipientUserId,
        });
        return reply.send({
          items: items.map((item) => {
            const presentation = getNotificationPresentation(
              item.type,
              item.payload,
            );
            return {
              id: item.id,
              type: item.type,
              category: presentation.category,
              title: presentation.title,
              body: presentation.body,
              priority: item.priority,
              createdAt: item.createdAt.toISOString(),
              readAt: item.readAt?.toISOString() ?? null,
              context: {
                entityType: item.context.entityType,
                entityId: item.context.entityId,
                path: item.context.path,
              },
            };
          }),
        });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get(
    NOTIFICATION_PATHS.count,
    {
      config: { rateLimit: fastifyLimit(dependencies.rateLimit.read) },
      onRequest: rejectQuery,
      onSend: privateHeaders,
    },
    async (request, reply) => {
      const recipientUserId = await activeActor(request, reply, dependencies);
      if (recipientUserId === null) return;
      try {
        return reply.send({
          unreadCount:
            await dependencies.notifications.unreadCount(recipientUserId),
        });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get(
    NOTIFICATION_PATHS.preferences,
    {
      config: { rateLimit: fastifyLimit(dependencies.rateLimit.read) },
      onRequest: rejectQuery,
      onSend: privateHeaders,
    },
    async (request, reply) => {
      const recipientUserId = await activeActor(request, reply, dependencies);
      if (recipientUserId === null) return;
      try {
        const preferences =
          await dependencies.notifications.getPreferences(recipientUserId);
        return reply.send({
          preferences: preferences.map((preference) => ({
            ...preference,
            requiredEmailMayOverride:
              preference.category !== "CHAT" &&
              preference.category !== "REVIEWS",
          })),
        });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{ Params: { notificationId: string } }>(
    NOTIFICATION_PATHS.markRead,
    mutationOptions(dependencies, notificationParams),
    async (request, reply) => {
      const recipientUserId = await activeActor(request, reply, dependencies);
      if (recipientUserId === null) return;
      try {
        const changed = await dependencies.notifications.markRead(
          request.params.notificationId,
          recipientUserId,
        );
        return changed
          ? reply.send({ status: "READ" })
          : reply.code(404).send({ code: "NOT_FOUND" });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post(
    NOTIFICATION_PATHS.markAllRead,
    mutationOptions(dependencies),
    async (request, reply) => {
      const recipientUserId = await activeActor(request, reply, dependencies);
      if (recipientUserId === null) return;
      try {
        return reply.send({
          markedRead:
            await dependencies.notifications.markAllRead(recipientUserId),
        });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{ Params: { notificationId: string } }>(
    NOTIFICATION_PATHS.archive,
    mutationOptions(dependencies, notificationParams),
    async (request, reply) => {
      const recipientUserId = await activeActor(request, reply, dependencies);
      if (recipientUserId === null) return;
      try {
        const changed = await dependencies.notifications.archive(
          request.params.notificationId,
          recipientUserId,
        );
        return changed
          ? reply.send({ status: "ARCHIVED" })
          : reply.code(404).send({ code: "NOT_FOUND" });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.put<{ Params: { category: NotificationCategory }; Body: PreferenceBody }>(
    NOTIFICATION_PATHS.preference,
    {
      ...mutationOptions(dependencies, preferenceParams),
      preValidation: exactPreferenceBody,
      schema: { params: preferenceParams, body: preferenceBodySchema },
    },
    async (request, reply) => {
      const recipientUserId = await activeActor(request, reply, dependencies);
      if (recipientUserId === null) return;
      try {
        const preference = await dependencies.notifications.setPreference({
          category: request.params.category,
          emailEnabled: request.body.emailEnabled,
          recipientUserId,
        });
        return reply.send({
          ...preference,
          requiredEmailMayOverride:
            preference.category !== "CHAT" && preference.category !== "REVIEWS",
        });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
}

function mutationOptions(
  dependencies: NotificationRouteDependencies,
  params?: object,
) {
  return {
    config: { rateLimit: fastifyLimit(dependencies.rateLimit.write) },
    onRequest: [rejectQuery, dependencies.csrfProtection],
    onSend: privateHeaders,
    preValidation: emptyMutationBody,
    ...(params === undefined ? {} : { schema: { params } }),
  };
}
function fastifyLimit(value: RateLimit) {
  return { max: value.max, timeWindow: value.timeWindowMs };
}

async function activeActor(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: NotificationRouteDependencies,
): Promise<string | null> {
  const actor = await dependencies.guard.evaluate(request);
  if (actor.status === "ACTIVE") return actor.user.id;
  void reply
    .code(actor.status === "AUTHENTICATION_REQUIRED" ? 401 : 403)
    .send({ code: actor.status });
  return null;
}
function exactPreferenceBody(
  request: FastifyRequest,
  reply: FastifyReply,
  done: () => void,
): void {
  const body = request.body;
  if (
    !record(body) ||
    Object.keys(body).length !== 1 ||
    typeof body["emailEnabled"] !== "boolean"
  ) {
    void reply.code(400).send({ code: "INVALID_REQUEST" });
    return;
  }
  done();
}
function emptyMutationBody(
  request: FastifyRequest,
  reply: FastifyReply,
  done: () => void,
): void {
  if (request.body !== undefined && request.body !== null) {
    void reply.code(400).send({ code: "INVALID_REQUEST" });
    return;
  }
  done();
}
function rejectQuery(
  request: FastifyRequest,
  reply: FastifyReply,
  done: () => void,
): void {
  if (Object.keys(request.query as object).length !== 0) {
    void reply.code(400).send({ code: "INVALID_REQUEST" });
    return;
  }
  done();
}
function privateHeaders(
  _request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
  done: (error: Error | null, payload?: unknown) => void,
): void {
  void reply.header("cache-control", "private, no-store");
  void reply.header("x-robots-tag", "noindex, nofollow");
  done(null, payload);
}
function sendError(reply: FastifyReply, error: unknown) {
  return error instanceof TypeError || error instanceof RangeError
    ? reply.code(400).send({ code: "INVALID_REQUEST" })
    : reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const uuid = {
  type: "string",
  pattern:
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
} as const;
const notificationParams = {
  type: "object",
  additionalProperties: false,
  required: ["notificationId"],
  properties: { notificationId: uuid },
} as const;
const preferenceParams = {
  type: "object",
  additionalProperties: false,
  required: ["category"],
  properties: { category: { enum: NOTIFICATION_CATEGORIES } },
} as const;
const preferenceBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["emailEnabled"],
  properties: { emailEnabled: { type: "boolean" } },
} as const;
const listQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    filter: { enum: ["ALL", "UNREAD"] },
    limit: { type: "integer", minimum: 1, maximum: 100 },
  },
} as const;
