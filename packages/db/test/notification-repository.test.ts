import { randomUUID } from "node:crypto";

import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";

import { createNotificationRepository } from "../src/index.js";

describe("notification repository authorization envelope", () => {
  it("fails closed for invalid recipient and notification IDs without SQL", async () => {
    const execute = vi.fn();
    const repository = createNotificationRepository(execute as unknown as Sql);

    await expect(repository.markRead(randomUUID(), "not-a-user")).resolves.toBe(
      false,
    );
    await expect(
      repository.archive("not-a-notification", randomUUID()),
    ).resolves.toBe(false);
    await expect(
      repository.list({
        filter: "UNREAD",
        limit: 20,
        recipientUserId: "unsafe",
      }),
    ).rejects.toThrow("recipientUserId must be a UUID");
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects content-bearing provider references before SQL", async () => {
    const execute = vi.fn();
    const repository = createNotificationRepository(execute as unknown as Sql);
    const delivery = {
      attempt: 1,
      context: { entityId: randomUUID(), entityType: "JOB", path: "/jobs/id" },
      deliveryId: randomUUID(),
      idempotencyKey: randomUUID(),
      leaseToken: randomUUID(),
      notificationId: randomUUID(),
      notificationType: "job.confirmed",
      priority: "IMPORTANT" as const,
      recipientUserId: randomUUID(),
    };
    await expect(
      repository.markEmailSent(
        delivery,
        "provider reference with address@example.test",
        new Date(),
      ),
    ).rejects.toThrow("opaque safe identifier");
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects a notification identity conflict before adding channels", async () => {
    const transaction = Object.assign(
      vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]),
      { json: (value: unknown) => value },
    );
    const repository = createNotificationRepository(vi.fn() as unknown as Sql);
    await expect(
      repository.writer.create(transaction as never, notificationInput()),
    ).rejects.toThrow("intent collision");
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it("rejects replay with a different intended channel set", async () => {
    const input = notificationInput();
    const transaction = Object.assign(
      vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            archivedAt: null,
            createdAt: new Date(),
            deliveryChannels: ["IN_APP"],
            deepLinkPath: input.context.path,
            domainEventId: input.domainEventId,
            entityId: input.context.entityId,
            entityRevision: null,
            entityType: input.context.entityType,
            eventIdempotencyKey: input.eventIdempotencyKey,
            id: randomUUID(),
            payload: input.payload,
            priority: input.priority,
            readAt: null,
            requestedChannels: ["IN_APP"],
            recipientUserId: input.recipientUserId,
            type: input.type,
          },
        ]),
      { json: (value: unknown) => value },
    );
    const repository = createNotificationRepository(vi.fn() as unknown as Sql);
    await expect(
      repository.writer.create(transaction as never, input),
    ).rejects.toThrow("channel intent collision");
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it("accepts replay under a changed preference only from the immutable first channel decision", async () => {
    const input = notificationInput();
    const transaction = Object.assign(
      vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            archivedAt: null,
            createdAt: new Date(),
            deliveryChannels: ["IN_APP", "EMAIL"],
            deepLinkPath: input.context.path,
            domainEventId: input.domainEventId,
            entityId: input.context.entityId,
            entityRevision: null,
            entityType: input.context.entityType,
            eventIdempotencyKey: input.eventIdempotencyKey,
            id: randomUUID(),
            payload: input.payload,
            priority: input.priority,
            readAt: null,
            requestedChannels: ["IN_APP", "EMAIL"],
            recipientUserId: input.recipientUserId,
            type: input.type,
          },
        ])
        .mockResolvedValueOnce([]),
      { json: (value: unknown) => value },
    );
    const repository = createNotificationRepository(vi.fn() as unknown as Sql);
    await expect(
      repository.writer.create(transaction as never, input),
    ).resolves.toMatchObject({ type: "quote.submitted" });
  });

  it("suppresses only optional email while retaining the canonical in-app record", async () => {
    const input = {
      ...notificationInput(),
      type: "job.review.main.invited",
    };
    const row = {
      archivedAt: null,
      createdAt: new Date(),
      deliveryChannels: ["IN_APP"],
      deepLinkPath: input.context.path,
      domainEventId: input.domainEventId,
      entityId: input.context.entityId,
      entityRevision: null,
      entityType: input.context.entityType,
      eventIdempotencyKey: input.eventIdempotencyKey,
      id: randomUUID(),
      payload: input.payload,
      priority: input.priority,
      readAt: null,
      requestedChannels: ["IN_APP", "EMAIL"],
      recipientUserId: input.recipientUserId,
      type: input.type,
    };
    const transaction = Object.assign(
      vi
        .fn()
        .mockResolvedValueOnce([{ enabled: false }])
        .mockResolvedValueOnce([row]),
      { json: (value: unknown) => value },
    );
    const repository = createNotificationRepository(vi.fn() as unknown as Sql);
    await expect(
      repository.writer.create(transaction as never, input),
    ).resolves.toMatchObject({ type: input.type });
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it("keeps requested email for a CRITICAL event even when its category is otherwise optional", async () => {
    const input = {
      ...notificationInput(),
      context: {
        entityId: randomUUID(),
        entityType: "MODERATION_ACTION",
        path: "/ucet/moderacia",
      },
      payload: { action: "APPLY_FEATURE_RESTRICTION" },
      priority: "CRITICAL" as const,
      type: "moderation.action.applied",
    };
    const row = {
      archivedAt: null,
      createdAt: new Date(),
      deliveryChannels: ["IN_APP", "EMAIL"],
      deepLinkPath: input.context.path,
      domainEventId: input.domainEventId,
      entityId: input.context.entityId,
      entityRevision: null,
      entityType: input.context.entityType,
      eventIdempotencyKey: input.eventIdempotencyKey,
      id: randomUUID(),
      payload: input.payload,
      priority: input.priority,
      readAt: null,
      requestedChannels: ["IN_APP", "EMAIL"],
      recipientUserId: input.recipientUserId,
      type: input.type,
    };
    const transaction = Object.assign(
      vi.fn().mockResolvedValueOnce([row]).mockResolvedValueOnce([]),
      { json: (value: unknown) => value },
    );
    const repository = createNotificationRepository(vi.fn() as unknown as Sql);
    await expect(
      repository.writer.create(transaction as never, input),
    ).resolves.toMatchObject({ priority: "CRITICAL" });
    expect(transaction).toHaveBeenCalledTimes(2);
  });
});

function notificationInput() {
  return {
    channels: ["IN_APP", "EMAIL"] as const,
    context: {
      entityId: randomUUID(),
      entityType: "QUOTE",
      path: `/ziadosti/${randomUUID()}/ponuky`,
    },
    domainEventId: randomUUID(),
    eventIdempotencyKey: `quote:${randomUUID()}`,
    payload: { action: "REVIEW_QUOTE" },
    priority: "IMPORTANT" as const,
    recipientUserId: randomUUID(),
    type: "quote.submitted",
  };
}
