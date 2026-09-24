import { randomUUID } from "node:crypto";

import type { NotificationRepository } from "@portal/db";
import type { UserId } from "@portal/domain";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type HookHandlerDoneFunction,
} from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NOTIFICATION_PATHS, registerNotificationRoutes } from "./routes.js";

const userId = randomUUID() as UserId;
const notificationId = randomUUID();
const createdAt = new Date("2026-09-25T08:00:00.000Z");
const apps: FastifyInstance[] = [];

function build(
  status:
    "ACTIVE" | "AUTHENTICATION_REQUIRED" | "ACCOUNT_NOT_ACTIVE" = "ACTIVE",
) {
  const persistence = {
    archive: vi.fn<NotificationRepository["archive"]>(() =>
      Promise.resolve(true),
    ),
    getPreferences: vi.fn<NotificationRepository["getPreferences"]>(() =>
      Promise.resolve([
        { category: "CHAT", emailEnabled: false },
        { category: "MARKETPLACE", emailEnabled: true },
      ]),
    ),
    list: vi.fn<NotificationRepository["list"]>(() =>
      Promise.resolve([
        {
          archivedAt: null,
          context: {
            entityId: randomUUID(),
            entityType: "JOB",
            path: `/zakazky/${randomUUID()}`,
          },
          createdAt,
          domainEventId: randomUUID(),
          eventIdempotencyKey: `job:${randomUUID()}`,
          id: notificationId,
          payload: { action: "OPEN_CONFIRMED_JOB" },
          priority: "IMPORTANT",
          readAt: null,
          recipientUserId: userId,
          type: "job.confirmed",
        },
      ]),
    ),
    markAllRead: vi.fn<NotificationRepository["markAllRead"]>(() =>
      Promise.resolve(3),
    ),
    markRead: vi.fn<NotificationRepository["markRead"]>(() =>
      Promise.resolve(true),
    ),
    setPreference: vi.fn<NotificationRepository["setPreference"]>((input) =>
      Promise.resolve({
        category: input.category,
        emailEnabled: input.emailEnabled,
      }),
    ),
    unreadCount: vi.fn<NotificationRepository["unreadCount"]>(() =>
      Promise.resolve(4),
    ),
  };
  const csrfProtection = vi.fn(
    (
      request: FastifyRequest,
      reply: FastifyReply,
      done: HookHandlerDoneFunction,
    ) => {
      if (request.headers["x-csrf-token"] !== "valid") {
        void reply.code(403).send({ code: "CSRF_INVALID" });
        return;
      }
      done();
    },
  );
  const app = Fastify();
  registerNotificationRoutes(app, {
    notifications: persistence,
    csrfProtection,
    guard: {
      evaluate: () =>
        Promise.resolve(
          status === "ACTIVE"
            ? { status: "ACTIVE" as const, user: { id: userId } }
            : { status },
        ),
    },
    rateLimit: {
      read: { max: 30, timeWindowMs: 60_000 },
      write: { max: 10, timeWindowMs: 60_000 },
    },
  });
  apps.push(app);
  return { app, csrfProtection, persistence };
}

afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe("notification center routes", () => {
  it("lists privacy-safe generated copy and forwards only the session recipient", async () => {
    const { app, persistence } = build();
    const response = await app.inject({
      method: "GET",
      url: `${NOTIFICATION_PATHS.list}?filter=UNREAD&limit=20`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.json()).toMatchObject({
      items: [
        {
          id: notificationId,
          type: "job.confirmed",
          category: "MARKETPLACE",
          title: "Zákazka je potvrdená",
          readAt: null,
        },
      ],
    });
    expect(JSON.stringify(response.json())).not.toMatch(
      /domainEvent|idempotency|recipientUser|payload/iu,
    );
    expect(persistence.list).toHaveBeenCalledWith({
      filter: "UNREAD",
      limit: 20,
      recipientUserId: userId,
    });
  });

  it("returns global unread count and category preferences", async () => {
    const { app } = build();
    expect(
      (
        await app.inject({ method: "GET", url: NOTIFICATION_PATHS.count })
      ).json(),
    ).toEqual({ unreadCount: 4 });
    expect(
      (
        await app.inject({ method: "GET", url: NOTIFICATION_PATHS.preferences })
      ).json(),
    ).toEqual({
      preferences: [
        {
          category: "CHAT",
          emailEnabled: false,
          requiredEmailMayOverride: false,
        },
        {
          category: "MARKETPLACE",
          emailEnabled: true,
          requiredEmailMayOverride: true,
        },
      ],
    });
  });

  it("requires CSRF for read/archive/preference mutations and never accepts a recipient ID", async () => {
    const { app, persistence } = build();
    const readPath = NOTIFICATION_PATHS.markRead.replace(
      ":notificationId",
      notificationId,
    );
    expect(
      (await app.inject({ method: "POST", url: readPath })).statusCode,
    ).toBe(403);
    expect(persistence.markRead).not.toHaveBeenCalled();
    expect(
      (
        await app.inject({
          method: "POST",
          url: readPath,
          headers: { "x-csrf-token": "valid" },
        })
      ).json(),
    ).toEqual({ status: "READ" });
    expect(persistence.markRead).toHaveBeenCalledWith(notificationId, userId);

    const preferencePath = NOTIFICATION_PATHS.preference.replace(
      ":category",
      "CHAT",
    );
    const response = await app.inject({
      method: "PUT",
      url: preferencePath,
      headers: { "x-csrf-token": "valid" },
      payload: { emailEnabled: false },
    });
    expect(response.statusCode).toBe(200);
    expect(persistence.setPreference).toHaveBeenCalledWith({
      category: "CHAT",
      emailEnabled: false,
      recipientUserId: userId,
    });
    expect(
      (
        await app.inject({
          method: "PUT",
          url: preferencePath,
          headers: { "x-csrf-token": "valid" },
          payload: { emailEnabled: false, recipientUserId: randomUUID() },
        })
      ).statusCode,
    ).toBe(400);
  });

  it("fails closed for unauthenticated/inactive actors and malformed selectors", async () => {
    expect(
      (
        await build("AUTHENTICATION_REQUIRED").app.inject({
          method: "GET",
          url: NOTIFICATION_PATHS.list,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await build("ACCOUNT_NOT_ACTIVE").app.inject({
          method: "GET",
          url: NOTIFICATION_PATHS.count,
        })
      ).statusCode,
    ).toBe(403);
    const { app } = build();
    expect(
      (
        await app.inject({
          method: "GET",
          url: `${NOTIFICATION_PATHS.list}?filter=OTHER`,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `${NOTIFICATION_PATHS.count}?extra=1`,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: NOTIFICATION_PATHS.markRead.replace(
            ":notificationId",
            "not-uuid",
          ),
          headers: { "x-csrf-token": "valid" },
        })
      ).statusCode,
    ).toBe(400);
  });
});
