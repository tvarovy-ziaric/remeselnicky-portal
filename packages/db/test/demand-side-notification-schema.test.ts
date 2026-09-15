import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("R3 demand-side notification schema", () => {
  it("captures the bounded R3 event catalog from authoritative effects", async () => {
    const migration = await readMigration();
    for (const event of [
      "job_invitation.engaged",
      "job_invitation.declined",
      "job_invitation.withdrawn_by_customer",
      "job_invitation.withdrawn_by_provider",
      "job_invitation.request_closed",
      "job_invitation.not_selected",
      "conversation.message_created",
      "job_request.materially_updated",
      "quote.submitted",
      "quote.revised",
      "quote.rejected",
      "quote.withdrawn",
      "quote.expired",
    ]) {
      expect(migration).toContain(`'${event}'`);
    }
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION capture_job_invitation_notification_event",
    );
    expect(migration).toContain(
      "AFTER INSERT ON conversation_timeline_entries",
    );
    expect(migration).toContain(
      "AFTER INSERT ON job_request_active_content_revisions",
    );
    expect(migration).toContain("AFTER INSERT ON quote_revision_state_events");
    expect(migration).not.toMatch(
      /section_payload|decline_note|rejection_reason|message_text|storage_key|exact_address|phone_number|email_address/iu,
    );
  });

  it("serializes mute/message and request-edit/invitation races in one order", async () => {
    const migration = await readMigration();
    expect(migration).toContain(
      "a_conversation_message_notification_recipient_lock",
    );
    expect(migration).toContain("a_conversation_notification_preference_lock");
    expect(migration).toContain(
      "hashtextextended(NEW.command_id::text, 45001)",
    );
    expect(migration).toContain(
      "hashtextextended(NEW.command_id::text, 45002)",
    );
    expect(migration).toContain(
      "hashtextextended(NEW.job_request_id::text, 41007)",
    );
    expect(migration).toContain("hashtextextended(request_id::text, 41007)");
    expect(migration).toContain("a_job_request_notification_transition_lock");
    expect(migration).toContain(
      "source_kind IN ('CUSTOMER_STOP', 'NOT_SELECT')",
    );
    expect(migration).toContain("invitation.state IN ('PENDING', 'ENGAGED')");
  });

  it("uses an immutable DB-derived entitlement instead of the outbox for exact material reads", async () => {
    const migration = await readMigration();
    expect(migration).toContain(
      "CREATE TABLE job_request_material_update_entitlements",
    );
    expect(migration).toContain(
      "REFERENCES job_request_active_content_revisions",
    );
    expect(migration).toContain("material update entitlement is DB-derived");
    expect(migration).toContain(
      "job_request_material_update_entitlements_append_only",
    );
  });

  it("exact-compares outbox collisions and never revives muted/read chat bursts", async () => {
    const migration = await readMigration();
    expect(migration).toContain(
      "notification outbox idempotency key collision",
    );
    expect(migration).toContain(
      "existing.payload IS DISTINCT FROM candidate_payload",
    );
    expect(migration).toContain(
      "existing.occurred_at IS DISTINCT FROM candidate_occurred_at",
    );
    expect(migration).toContain("email_considered_through_sequence");
    expect(migration).toMatch(
      /WHEN 'MUTE' THEN state\.latest_notifiable_sequence/u,
    );
    expect(migration).toContain("WHEN 'MARK_READ' THEN NEW.last_read_sequence");
    expect(migration).toContain("chat_email_delay_seconds");
    expect(migration).toContain("chat email delivery intent collision");
    expect(migration).toContain(
      "conversation_notification_email_batches_append_only",
    );
  });

  it("emits quote expiry to both exact parties without commercial fields", async () => {
    const migration = await readMigration();
    expect(migration).toContain("|| ':provider'");
    expect(migration).toContain("provider_recipient_id::text");
    expect(migration).toContain("customer_recipient_id");
    expect(migration).not.toMatch(/quote_price|amount_cents|winner/iu);
  });
});

async function readMigration(): Promise<string> {
  return readFile(
    new URL(
      "../migrations/0052_demand_side_notifications.sql",
      import.meta.url,
    ),
    "utf8",
  );
}
