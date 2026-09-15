import type { EventPayload, PersistedDomainEvent } from "@portal/outbox";
import {
  createNotificationOutboxPublisher,
  mapJobInvitationNotificationEvent,
} from "@portal/notifications";
import type { Sql } from "postgres";
import { expect } from "vitest";

import {
  createJobInvitationReminderRepository,
  createNotificationRepository,
  createOutboxRepository,
} from "../src/index.js";

interface InvitationFixture {
  readonly craftsmanOwnerId: string;
  readonly id: string;
}

interface EventRow {
  readonly commandName: string;
  readonly correlationId: string;
  readonly entityId: string;
  readonly entityType: string;
  readonly eventId: string;
  readonly eventName: string;
  readonly idempotencyKey: string;
  readonly occurredAt: Date;
  readonly payload: EventPayload;
  readonly schemaVersion: number;
}

/** Runs after the R3-007 invitation fixture in the single clean migration test. */
export async function runJobInvitationNotificationIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const [invitation] = await sql<InvitationFixture[]>`
    SELECT invitation.id, profile.owner_user_id AS "craftsmanOwnerId"
    FROM job_invitations invitation
    JOIN current_job_invitations current ON current.id = invitation.id
    JOIN craftsman_profiles profile
      ON profile.id = invitation.craftsman_profile_id
    WHERE current.state = 'PENDING'
    ORDER BY invitation.created_at DESC, invitation.id DESC
    LIMIT 1
  `;
  if (invitation === undefined) {
    throw new Error("R3-009 requires the pending R3-007 invitation fixture.");
  }

  const [sent] = await sql<EventRow[]>`
    SELECT event_id AS "eventId", idempotency_key AS "idempotencyKey",
      event_name AS "eventName", schema_version AS "schemaVersion",
      occurred_at AS "occurredAt", entity_type AS "entityType",
      entity_id AS "entityId", payload, command_name AS "commandName",
      correlation_id AS "correlationId"
    FROM domain_outbox_events
    WHERE idempotency_key =
      ${`job-invitation:${invitation.id}:sent`}
  `;
  expect(sent?.eventName).toBe("job_invitation.sent");

  try {
    await sql`
      UPDATE job_invitation_runtime_policy
      SET warning_lead_days = expiry_days, updated_at = clock_timestamp()
      WHERE singleton
    `;
    const reminders = createJobInvitationReminderRepository(sql);
    await expect(reminders.enqueueDueReminders()).resolves.toEqual([
      invitation.id,
    ]);
    await expect(reminders.enqueueDueReminders()).resolves.toEqual([]);

    const [reminder] = await sql<EventRow[]>`
      SELECT event_id AS "eventId", idempotency_key AS "idempotencyKey",
        event_name AS "eventName", schema_version AS "schemaVersion",
        occurred_at AS "occurredAt", entity_type AS "entityType",
        entity_id AS "entityId", payload, command_name AS "commandName",
        correlation_id AS "correlationId"
      FROM domain_outbox_events
      WHERE idempotency_key =
        ${`job-invitation:${invitation.id}:expiry-reminder`}
    `;
    if (sent === undefined || reminder === undefined) {
      throw new Error("Invitation notification events were not captured.");
    }

    const outbox = createOutboxRepository(sql);
    const notifications = createNotificationRepository(sql);
    const publisher = createNotificationOutboxPublisher({
      claims: outbox.consumerClaims,
      mapper: mapJobInvitationNotificationEvent,
      notifications: notifications.writer,
      transactions: outbox.transactions,
    });
    for (const row of [sent, reminder]) {
      const delivery = {
        attempt: 1,
        commandName: row.commandName,
        correlationId: row.correlationId,
        event: toEvent(row),
        leaseToken: crypto.randomUUID(),
      };
      await publisher.publish(delivery);
      await publisher.publish(delivery);
    }

    const [counts] = await sql<
      Array<{ readonly emails: number; readonly notifications: number }>
    >`
      SELECT
        count(DISTINCT notification.id)::integer AS notifications,
        count(delivery.id) FILTER (WHERE delivery.channel = 'EMAIL')::integer
          AS emails
      FROM notifications notification
      LEFT JOIN notification_deliveries delivery
        ON delivery.notification_id = notification.id
      WHERE notification.recipient_user_id = ${invitation.craftsmanOwnerId}
        AND notification.entity_type = 'JOB_INVITATION'
        AND notification.entity_id = ${invitation.id}
    `;
    expect(counts).toEqual({ emails: 2, notifications: 2 });

    const [payloadSafety] = await sql<Array<{ readonly leaks: number }>>`
      SELECT count(*) FILTER (
        WHERE payload ?| ARRAY[
          'email', 'phone', 'exact_address', 'description', 'decline_note'
        ]
      )::integer AS leaks
      FROM notifications
      WHERE entity_type = 'JOB_INVITATION' AND entity_id = ${invitation.id}
    `;
    expect(payloadSafety?.leaks).toBe(0);
  } finally {
    await sql`
      UPDATE job_invitation_runtime_policy
      SET warning_lead_days = LEAST(2, expiry_days),
        updated_at = clock_timestamp()
      WHERE singleton
    `;
  }
}

function toEvent(row: EventRow): PersistedDomainEvent {
  return Object.freeze({
    entity: Object.freeze({ id: row.entityId, type: row.entityType }),
    eventId: row.eventId,
    idempotencyKey: row.idempotencyKey,
    name: row.eventName,
    occurredAt: row.occurredAt,
    payload: Object.freeze(row.payload),
    schemaVersion: row.schemaVersion,
  });
}
