import { randomUUID } from "node:crypto";

import { defineDomainEvent } from "@portal/outbox";
import { describe, expect, it, vi } from "vitest";

import {
  createNotificationOutboxPublisher,
  type CreateNotificationInput,
} from "../src/index.js";

interface TestTransaction {
  readonly claims: Set<string>;
  readonly notifications: CreateNotificationInput[];
}

const definition = defineDomainEvent({
  eventName: "change_order.proposed",
  payloadKeys: ["recipient_user_id", "revision"] as const,
  schemaVersion: 1,
});

function delivery() {
  const eventId = randomUUID();
  const recipientUserId = randomUUID();
  const entityId = randomUUID();
  return {
    attempt: 1,
    commandName: "change_order.propose",
    correlationId: randomUUID(),
    event: definition.create({
      entity: { id: entityId, type: "CHANGE_ORDER" },
      eventId,
      idempotencyKey: `change-order:${eventId}`,
      occurredAt: new Date("2026-09-14T12:00:00.000Z"),
      payload: { recipient_user_id: recipientUserId, revision: 2 },
    }),
    leaseToken: randomUUID(),
  };
}

describe("notification outbox publisher", () => {
  it("creates one notification atomically across duplicate worker delivery", async () => {
    const committed: TestTransaction = { claims: new Set(), notifications: [] };
    const create = vi.fn(
      (transaction: TestTransaction, input: CreateNotificationInput) => {
        transaction.notifications.push(input);
        return Promise.resolve({
          ...input,
          archivedAt: null,
          createdAt: new Date(),
          id: randomUUID(),
          readAt: null,
        });
      },
    );
    const item = delivery();
    const publisher = createNotificationOutboxPublisher<TestTransaction>({
      claims: {
        claim(transaction, identity) {
          const key = `${identity.consumerName}:${identity.eventId}`;
          if (transaction.claims.has(key)) return Promise.resolve(false);
          transaction.claims.add(key);
          return Promise.resolve(true);
        },
      },
      mapper(event) {
        return [
          {
            channels: ["IN_APP", "EMAIL"],
            context: {
              entityId: event.entity?.id ?? "missing",
              entityRevision: 2,
              entityType: "CHANGE_ORDER",
              path: `/changes/${event.entity?.id ?? "missing"}/revisions/2`,
            },
            payload: { action: "REVIEW_REQUIRED", revision: 2 },
            priority: "IMPORTANT",
            recipientUserId: String(event.payload.recipient_user_id),
            type: "change_order.review_requested",
          },
        ];
      },
      notifications: { create },
      transactions: {
        async run(work) {
          const transaction: TestTransaction = {
            claims: new Set(committed.claims),
            notifications: [...committed.notifications],
          };
          const result = await work(transaction);
          committed.claims.clear();
          for (const claim of transaction.claims) committed.claims.add(claim);
          committed.notifications.splice(
            0,
            committed.notifications.length,
            ...transaction.notifications,
          );
          return result;
        },
      },
    });

    await publisher.publish(item);
    await publisher.publish(item);
    expect(create).toHaveBeenCalledTimes(1);
    expect(committed.notifications).toHaveLength(1);
    expect(committed.notifications[0]).toMatchObject({
      domainEventId: item.event.eventId,
      eventIdempotencyKey: item.event.idempotencyKey,
    });
  });

  it("does not claim unrelated events and terminalizes unsafe mapped payloads", async () => {
    const item = delivery();
    const claim = vi.fn(() => Promise.resolve(true));
    const ignored = createNotificationOutboxPublisher<TestTransaction>({
      claims: { claim },
      mapper: () => undefined,
      notifications: { create: vi.fn() },
      transactions: {
        run: (work) => work({ claims: new Set(), notifications: [] }),
      },
    });
    await ignored.publish(item);
    expect(claim).not.toHaveBeenCalled();

    const invalid = createNotificationOutboxPublisher<TestTransaction>({
      claims: { claim },
      mapper: () => [
        {
          channels: ["IN_APP"],
          context: {
            entityId: randomUUID(),
            entityType: "JOB",
            path: "/jobs/id",
          },
          payload: { exact_address: "hidden" },
          priority: "CRITICAL",
          recipientUserId: randomUUID(),
          type: "job.invalid",
        },
      ],
      notifications: { create: vi.fn() },
      transactions: {
        run: (work) => work({ claims: new Set(), notifications: [] }),
      },
    });
    await expect(invalid.publish(item)).rejects.toMatchObject({
      code: "NOTIFICATION_PAYLOAD_INVALID",
    });
  });
});
