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
});
