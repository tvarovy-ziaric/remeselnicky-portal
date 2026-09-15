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
            recipientUserId: input.recipientUserId,
            type: input.type,
          },
        ])
        .mockResolvedValueOnce([{ emailKey: null, pushKey: null }]),
      { json: (value: unknown) => value },
    );
    const repository = createNotificationRepository(vi.fn() as unknown as Sql);
    await expect(
      repository.writer.create(transaction as never, input),
    ).rejects.toThrow("channel intent collision");
    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it("rejects replay with a colliding delivery idempotency key", async () => {
    const input = notificationInput();
    const transaction = Object.assign(
      vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            archivedAt: null,
            createdAt: new Date(),
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
            recipientUserId: input.recipientUserId,
            type: input.type,
          },
        ])
        .mockResolvedValueOnce([
          { emailKey: "another-delivery-intent", pushKey: null },
        ]),
      { json: (value: unknown) => value },
    );
    const repository = createNotificationRepository(vi.fn() as unknown as Sql);
    await expect(
      repository.writer.create(transaction as never, input),
    ).rejects.toThrow("channel intent collision");
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
