import { randomUUID } from "node:crypto";

import type { UserId } from "@portal/domain";
import type { Sql } from "postgres";
import { expect } from "vitest";

import { createAuditRepository } from "../src/index.js";

export async function runAuditIntegrationAssertions(
  sql: Sql,
  actorUserId: UserId,
): Promise<void> {
  const repository = createAuditRepository(sql);
  const eventId = randomUUID();
  const correlationId = randomUUID();
  const draft = {
    action: "admin.conversation.accessed",
    actor: {
      capability: "admin.sensitive.read",
      kind: "AUTHENTICATED_USER",
      userId: actorUserId,
    },
    category: "SENSITIVE_ACCESS",
    changes: {},
    context: { id: `case:${randomUUID()}`, type: "DISPUTE" },
    correlationId,
    eventId,
    reason: "Investigating a reported integration dispute",
    sensitiveAccessPurpose: "DISPUTE_INVESTIGATION",
    target: { id: randomUUID(), type: "CONVERSATION" },
  } as const;

  const repeated = await Promise.all([
    repository.append(draft),
    repository.append(draft),
  ]);
  expect(repeated.map(({ status }) => status).sort()).toEqual([
    "APPENDED",
    "DEDUPLICATED",
  ]);
  expect(repeated[0]?.event.occurredAt).toEqual(repeated[1]?.event.occurredAt);

  await expect(
    repository.append({
      ...draft,
      action: "admin.conversation.access_denied",
    }),
  ).rejects.toThrow(/idempotency conflict/u);

  const forcedTimestampEventId = randomUUID();
  const beforeInsert = new Date();
  const [timestamped] = await sql<{ occurredAt: Date }[]>`
    INSERT INTO audit_events (
      event_id,
      correlation_id,
      category,
      actor_kind,
      actor_user_id,
      actor_capability,
      action_type,
      target_type,
      target_id,
      changes,
      occurred_at
    ) VALUES (
      ${forcedTimestampEventId},
      ${randomUUID()},
      'SECURITY_EVENT',
      'AUTHENTICATED_USER',
      ${actorUserId},
      'admin.access',
      'security.authorization.denied',
      'API_ROUTE',
      'route:admin-users',
      '{}'::jsonb,
      '2000-01-01T00:00:00Z'::timestamptz
    )
    RETURNING occurred_at AS "occurredAt"
  `;
  expect(timestamped?.occurredAt.valueOf()).toBeGreaterThanOrEqual(
    beforeInsert.valueOf(),
  );

  await expect(sql`
    UPDATE audit_events
    SET action_type = 'security.authorization.allowed'
    WHERE event_id = ${eventId}
  `).rejects.toThrow(/append-only/u);
  await expect(sql`
    DELETE FROM audit_events
    WHERE event_id = ${eventId}
  `).rejects.toThrow(/append-only/u);

  const rollbackUserId = randomUUID();
  await sql`INSERT INTO users (id) VALUES (${rollbackUserId})`;
  await expect(
    sql.begin(async (transaction) => {
      await transaction`
        UPDATE users
        SET account_state = 'SUSPENDED',
            account_state_changed_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ${rollbackUserId}
      `;
      await transaction`
        INSERT INTO audit_events (
          event_id,
          correlation_id,
          category,
          actor_kind,
          actor_user_id,
          actor_capability,
          action_type,
          target_type,
          target_id,
          reason,
          changes
        ) VALUES (
          ${randomUUID()},
          ${randomUUID()},
          'PRIVILEGED_COMMAND',
          'AUTHENTICATED_USER',
          ${actorUserId},
          'admin.users.manage',
          'admin.user.suspended',
          'USER',
          ${rollbackUserId},
          'Integration support suspension reason',
          ${transaction.json({
            email: { after: "private@example.test", before: null },
          })}
        )
      `;
    }),
  ).rejects.toThrow(/audit_events_changes_safe/u);
  const [rolledBackUser] = await sql<{ accountState: string }[]>`
    SELECT account_state AS "accountState"
    FROM users
    WHERE id = ${rollbackUserId}
  `;
  expect(rolledBackUser?.accountState).toBe("ACTIVE");

  await expect(sql`
    INSERT INTO audit_events (
      event_id,
      correlation_id,
      category,
      actor_kind,
      actor_user_id,
      actor_capability,
      action_type,
      target_type,
      target_id,
      reason,
      changes
    ) VALUES (
      ${randomUUID()},
      ${randomUUID()},
      'SENSITIVE_ACCESS',
      'AUTHENTICATED_USER',
      ${actorUserId},
      'admin.sensitive.read',
      'admin.conversation.accessed',
      'CONVERSATION',
      ${randomUUID()},
      'Integration sensitive access reason',
      '{}'::jsonb
    )
  `).rejects.toThrow(/audit_events_sensitive_context_valid/u);
}
