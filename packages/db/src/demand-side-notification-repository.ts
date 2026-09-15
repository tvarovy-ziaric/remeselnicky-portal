import type { DemandSideNotificationMaintenanceStore } from "@portal/notifications";
import type { Sql } from "postgres";

interface CountRow {
  readonly count: number;
}

/**
 * Claims privacy-minimal chat bursts under their current recipient-state row.
 * The 0052 trigger authors and validates the exact notification/delivery link.
 */
export function createDemandSideNotificationRepository(
  sql: Sql,
): DemandSideNotificationMaintenanceStore {
  return Object.freeze({
    async enqueueDueUnreadChatEmails(): Promise<number> {
      const [result] = await sql.begin(
        async (transaction) =>
          transaction<CountRow[]>`
          WITH due AS (
            SELECT state.conversation_id, state.recipient_user_id,
              state.latest_notifiable_sequence,
              notification.id AS notification_id,
              clock_timestamp() AS database_now
            FROM conversation_notification_states state
            JOIN users recipient
              ON recipient.id = state.recipient_user_id
              AND recipient.account_state = 'ACTIVE'
            CROSS JOIN demand_notification_runtime_policy runtime
            JOIN notifications notification
              ON notification.recipient_user_id = state.recipient_user_id
              AND notification.type = 'conversation.message_received'
              AND notification.entity_type = 'CONVERSATION'
              AND notification.entity_id = state.conversation_id::text
              AND notification.entity_revision =
                state.latest_notifiable_sequence
            WHERE runtime.singleton
              AND NOT state.muted
              AND state.latest_notifiable_sequence > state.last_read_sequence
              AND state.latest_notifiable_sequence >
                state.email_considered_through_sequence
              AND state.latest_notifiable_at <= clock_timestamp()
                - make_interval(secs => runtime.chat_email_delay_seconds)
              AND NOT EXISTS (
                SELECT 1
                FROM conversation_notification_email_batches prior
                WHERE prior.conversation_id = state.conversation_id
                  AND prior.recipient_user_id = state.recipient_user_id
                  AND prior.through_sequence >=
                    state.latest_notifiable_sequence
              )
            ORDER BY state.latest_notifiable_at,
              state.conversation_id, state.recipient_user_id
            FOR UPDATE OF state SKIP LOCKED
            LIMIT 100
          ), inserted AS (
            INSERT INTO conversation_notification_email_batches (
              batch_id, conversation_id, recipient_user_id,
              through_sequence, notification_id, scheduled_at
            )
            SELECT gen_random_uuid(), due.conversation_id,
              due.recipient_user_id, due.latest_notifiable_sequence,
              due.notification_id, due.database_now
            FROM due
            ON CONFLICT (
              conversation_id, recipient_user_id, through_sequence
            ) DO NOTHING
            RETURNING batch_id
          )
          SELECT count(*)::integer AS count FROM inserted
        `,
      );
      if (
        result === undefined ||
        !Number.isSafeInteger(result.count) ||
        result.count < 0 ||
        result.count > 100
      ) {
        throw new TypeError("Invalid chat notification batch result.");
      }
      return result.count;
    },
  });
}
