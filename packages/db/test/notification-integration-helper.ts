import { randomUUID } from "node:crypto";

import { defineDomainEvent } from "@portal/outbox";
import type { Sql } from "postgres";
import { expect } from "vitest";

import {
  createNotificationRepository,
  createOutboxRepository,
} from "../src/index.js";

const notificationEvent = defineDomainEvent({
  eventName: "integration.notification_requested",
  payloadKeys: ["recipient_user_id"] as const,
  schemaVersion: 1,
});

/** Runs inside the single clean-migration integration test to avoid migration races. */
export async function runNotificationIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const [recipient] = await sql<{ id: string }[]>`
    INSERT INTO users DEFAULT VALUES RETURNING id
  `;
  const [other] = await sql<{ id: string }[]>`
    INSERT INTO users DEFAULT VALUES RETURNING id
  `;
  if (recipient === undefined || other === undefined) {
    throw new Error("Expected notification integration users.");
  }

  const eventId = randomUUID();
  const entityId = randomUUID();
  const event = notificationEvent.create({
    entity: { id: entityId, type: "CHANGE_ORDER" },
    eventId,
    idempotencyKey: `notification:${eventId}`,
    occurredAt: new Date(),
    payload: { recipient_user_id: recipient.id },
  });
  const outbox = createOutboxRepository(sql);
  const repository = createNotificationRepository(sql);
  const input = {
    channels: ["IN_APP", "EMAIL"] as const,
    context: {
      entityId,
      entityRevision: 2,
      entityType: "CHANGE_ORDER",
      path: `/changes/${entityId}/revisions/2`,
    },
    domainEventId: eventId,
    eventIdempotencyKey: event.idempotencyKey,
    payload: { action: "REVIEW_REQUIRED", revision: 2 },
    priority: "IMPORTANT" as const,
    recipientUserId: recipient.id,
    type: "change_order.review_requested",
  };

  await outbox.transactions.run(async (transaction) => {
    await outbox.writer.collect(transaction, [event], {
      commandName: "integration.notification",
      correlationId: randomUUID(),
    });
    await repository.writer.create(transaction, input);
  });
  await outbox.transactions.run((transaction) =>
    repository.writer.create(transaction, input),
  );

  const [counts] = await sql<{ deliveries: number; notifications: number }[]>`
    SELECT
      (SELECT count(*)::integer FROM notifications WHERE domain_event_id = ${eventId})
        AS notifications,
      (SELECT count(*)::integer FROM notification_deliveries AS delivery
        INNER JOIN notifications AS notification
          ON notification.id = delivery.notification_id
        WHERE notification.domain_event_id = ${eventId}) AS deliveries
  `;
  expect(counts).toEqual({ deliveries: 1, notifications: 1 });

  const all = await repository.list({
    filter: "ALL",
    limit: 20,
    recipientUserId: recipient.id,
  });
  expect(all).toHaveLength(1);
  const notification = all[0];
  if (notification === undefined) throw new Error("Expected notification.");
  await expect(
    repository.list({ filter: "ALL", limit: 20, recipientUserId: other.id }),
  ).resolves.toEqual([]);
  await expect(repository.markRead(notification.id, other.id)).resolves.toBe(
    false,
  );
  await expect(
    repository.markRead(notification.id, recipient.id),
  ).resolves.toBe(true);
  await expect(
    repository.list({
      filter: "UNREAD",
      limit: 20,
      recipientUserId: recipient.id,
    }),
  ).resolves.toEqual([]);

  const [outboxAfterRead] = await sql<{ count: number }[]>`
    SELECT count(*)::integer AS count
    FROM domain_outbox_events
    WHERE event_id = ${eventId} AND status = 'PENDING'
  `;
  expect(outboxAfterRead?.count).toBe(1);

  const competingClaims = await Promise.all([
    repository.claimNextEmail({ leaseDurationMs: 60_000, now: new Date() }),
    repository.claimNextEmail({ leaseDurationMs: 60_000, now: new Date() }),
  ]);
  const first = competingClaims.find((candidate) => candidate !== undefined);
  expect(first).toMatchObject({ attempt: 1, notificationId: notification.id });
  expect(
    competingClaims.filter((candidate) => candidate === undefined),
  ).toHaveLength(1);
  if (first === undefined) throw new Error("Expected one claimed email.");

  await expect(
    repository.retryEmail(first, {
      availableAt: new Date(0),
      errorCode: "PROVIDER_TIMEOUT",
    }),
  ).resolves.toBe(true);
  const second = await repository.claimNextEmail({
    leaseDurationMs: 60_000,
    now: new Date(),
  });
  expect(second).toMatchObject({
    attempt: 2,
    idempotencyKey: first.idempotencyKey,
  });
  if (second === undefined) throw new Error("Expected retry delivery.");
  await expect(
    repository.markEmailSent(second, "provider-message-1", new Date()),
  ).resolves.toBe(true);
  await expect(repository.snapshot()).resolves.toMatchObject({
    emailBacklog: 0,
    emailTerminalFailed: 0,
  });

  await expect(sql`
    UPDATE notifications
    SET entity_id = ${randomUUID()}
    WHERE id = ${notification.id}
  `).rejects.toThrow(/notification provenance and content are immutable/u);

  await expect(sql`
    UPDATE notifications
    SET payload = ${sql.json({ exact_address: "Private:12" })}
    WHERE id = ${notification.id}
  `).rejects.toThrow(/notifications_payload_is_safe/u);
}
