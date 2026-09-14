import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  NOTIFICATION_CHANNEL_VALUES,
  NOTIFICATION_DELIVERY_STATE_VALUES,
  NOTIFICATION_PRIORITY_VALUES,
  notificationDeliveries,
  notifications,
} from "../src/index.js";

describe("notification schema", () => {
  it("exposes stable priorities, channels and delivery states", () => {
    expect(NOTIFICATION_PRIORITY_VALUES).toEqual([
      "INFO",
      "IMPORTANT",
      "CRITICAL",
    ]);
    expect(NOTIFICATION_CHANNEL_VALUES).toEqual(["IN_APP", "EMAIL", "PUSH"]);
    expect(NOTIFICATION_DELIVERY_STATE_VALUES).toEqual([
      "QUEUED",
      "PROCESSING",
      "SENT",
      "DELIVERED",
      "TERMINAL_FAILED",
    ]);
    expect(notifications.domainEventId.name).toBe("domain_event_id");
    expect(notificationDeliveries.idempotencyKey.name).toBe("idempotency_key");
  });

  it("locks in privacy, dedupe, recipient and retry invariants", async () => {
    const migration = await readFile(
      new URL("../migrations/0010_notifications.sql", import.meta.url),
      "utf8",
    );
    const repository = await readFile(
      new URL("../src/notification-repository.ts", import.meta.url),
      "utf8",
    );
    expect(migration).toContain("notification_payload_is_safe(payload)");
    expect(migration).toContain("'exact_address'");
    expect(migration).toContain("'review_text'");
    expect(migration).toContain("'token'");
    expect(migration).toContain(
      "UNIQUE (domain_event_id, recipient_user_id, type)",
    );
    expect(migration).toContain("UNIQUE (notification_id, channel)");
    expect(repository).toContain("FOR UPDATE SKIP LOCKED");
    expect(migration).toContain("notifications_recipient_unread_idx");
    expect(migration).toContain("notifications_protect_business_fields");
    expect(migration).toContain("notification_deliveries_enforce_transition");
    expect(migration).toContain(
      "notification_email_delivery_expired_lease_idx",
    );
    expect(migration).not.toMatch(/email_address|message_body|subject_text/iu);
  });
});
