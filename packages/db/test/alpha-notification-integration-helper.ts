import type { Sql } from "postgres";
import { expect } from "vitest";

/** Verifies R4-024 capture after the R1-R4 integration fixtures have run. */
export async function runAlphaNotificationIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const rows = await sql<{ readonly eventName: string }[]>`
    SELECT DISTINCT event_name AS "eventName" FROM domain_outbox_events
    WHERE event_name IN (
      'job.confirmed', 'job.review.response.created',
      'credential.approved', 'credential.rejected', 'credential.revoked',
      'profile.approved', 'profile.rejected',
      'moderation.action.applied', 'moderation.appeal.decided'
    )
  `;
  const names = rows.map((row) => row.eventName).sort();
  expect(names).toEqual([
    "credential.approved",
    "credential.rejected",
    "credential.revoked",
    "job.confirmed",
    "job.review.response.created",
    "moderation.action.applied",
    "moderation.appeal.decided",
    "profile.approved",
    "profile.rejected",
  ]);

  const [fanout] = await sql<
    { readonly events: number; readonly jobs: number }[]
  >`
    SELECT
      (SELECT count(*)::integer FROM domain_outbox_events
        WHERE event_name = 'job.confirmed') AS events,
      (SELECT count(*)::integer FROM jobs) AS jobs
  `;
  expect(fanout?.events).toBe((fanout?.jobs ?? 0) * 2);

  const [unsafe] = await sql<{ readonly count: number }[]>`
    SELECT count(*)::integer AS count FROM domain_outbox_events
    WHERE event_name IN (
      'job.confirmed', 'job.review.response.created',
      'credential.approved', 'credential.rejected', 'credential.revoked',
      'profile.approved', 'profile.rejected',
      'moderation.action.applied', 'moderation.appeal.decided'
    ) AND EXISTS (
      SELECT 1 FROM jsonb_object_keys(payload) key
      WHERE lower(key) IN (
        'address', 'body', 'content', 'email', 'phone', 'private_admin_note',
        'review_text', 'token'
      )
    )
  `;
  expect(unsafe?.count).toBe(0);

  await expect(sql`
    INSERT INTO notification_channel_preferences (
      user_id, category, channel, enabled
    ) SELECT id, 'CHAT', 'IN_APP', false FROM users LIMIT 1
  `).rejects.toThrow(/notification_preference_mutable_channels_only/u);
}
