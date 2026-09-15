import type { JobInvitationReminderStore } from "@portal/notifications";
import type { Sql } from "postgres";

interface ReminderRow {
  readonly invitationId: string;
}

/**
 * PostgreSQL is the scheduler authority: policy, current state, deadline and
 * idempotent event capture are evaluated together under row locks.
 */
export function createJobInvitationReminderRepository(
  sql: Sql,
): JobInvitationReminderStore {
  return Object.freeze({
    async enqueueDueReminders(): Promise<readonly string[]> {
      return sql.begin(async (transaction) => {
        const inserted = await transaction<ReminderRow[]>`
          WITH runtime AS (
            SELECT warning_lead_days, clock_timestamp() AS database_now
            FROM job_invitation_runtime_policy
            WHERE singleton
          ), candidates AS (
            SELECT invitation.id, current.revision, current.expires_at,
              profile.owner_user_id AS recipient_user_id,
              runtime.database_now
            FROM runtime
            JOIN current_job_invitations current
              ON current.state = 'PENDING'
              AND runtime.warning_lead_days > 0
              AND current.expires_at > runtime.database_now
              AND current.expires_at <= runtime.database_now
                + make_interval(days => runtime.warning_lead_days)
            JOIN job_invitations invitation ON invitation.id = current.id
            JOIN craftsman_profiles profile
              ON profile.id = invitation.craftsman_profile_id
            ORDER BY current.expires_at, invitation.id
            FOR UPDATE OF invitation SKIP LOCKED
            LIMIT 100
          )
          SELECT candidate.id::text AS "invitationId"
          FROM candidates candidate
          WHERE insert_exact_invitation_reminder_outbox_event(
            'job-invitation:' || candidate.id::text || ':expiry-reminder',
            candidate.database_now,
            candidate.id::text,
            jsonb_build_object(
              'recipient_user_id', candidate.recipient_user_id::text,
              'invitation_revision', candidate.revision,
              'expires_at', to_char(
                candidate.expires_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
              )
            ),
            'job_invitation.schedule_reminder',
            candidate.id::text,
            candidate.database_now
          )
        `;
        return Object.freeze(inserted.map((row) => row.invitationId));
      });
    },
  });
}
