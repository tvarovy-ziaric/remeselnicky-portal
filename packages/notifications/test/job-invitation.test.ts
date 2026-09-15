import { randomUUID } from "node:crypto";

import type { PersistedDomainEvent } from "@portal/outbox";
import { describe, expect, it } from "vitest";

import {
  JOB_INVITATION_NOTIFICATION_EVENT_NAMES,
  mapJobInvitationNotificationEvent,
  validateNotificationDraft,
} from "../src/index.js";

function event(
  name: string,
  payload: Readonly<Record<string, boolean | number | string | null>> = {},
): PersistedDomainEvent {
  return Object.freeze({
    entity: Object.freeze({ id: randomUUID(), type: "JOB_INVITATION" }),
    eventId: randomUUID(),
    idempotencyKey: `job-invitation:${randomUUID()}`,
    name,
    occurredAt: new Date("2026-09-15T08:00:00.000Z"),
    payload: Object.freeze({
      invitation_revision: 1,
      recipient_user_id: randomUUID(),
      ...payload,
    }),
    schemaVersion: 1,
  });
}

describe("job invitation notification catalog", () => {
  it("maps a new invitation to canonical in-app and email delivery", () => {
    const drafts = mapJobInvitationNotificationEvent(
      event(JOB_INVITATION_NOTIFICATION_EVENT_NAMES.sent),
    );
    expect(drafts).toHaveLength(1);
    expect(drafts?.[0]).toMatchObject({
      channels: ["IN_APP", "EMAIL"],
      payload: { action: "RESPONSE_REQUIRED", invitation_revision: 1 },
      priority: "IMPORTANT",
      type: "job_invitation.received",
    });
    expect(() => validateNotificationDraft(drafts?.[0] as never)).not.toThrow();
  });

  it("maps a configured reminder without copying its deadline into payload", () => {
    const drafts = mapJobInvitationNotificationEvent(
      event(JOB_INVITATION_NOTIFICATION_EVENT_NAMES.reminder, {
        expires_at: "2026-09-17T08:00:00.000Z",
      }),
    );
    expect(drafts?.[0]).toMatchObject({
      channels: ["IN_APP", "EMAIL"],
      type: "job_invitation.expiry_reminder",
    });
    expect(drafts?.[0]?.payload).not.toHaveProperty("expires_at");
  });

  it("maps expiry to a non-urgent customer in-app notice", () => {
    expect(
      mapJobInvitationNotificationEvent(
        event(JOB_INVITATION_NOTIFICATION_EVENT_NAMES.expired),
      )?.[0],
    ).toMatchObject({
      channels: ["IN_APP"],
      payload: { action: "NO_ACTION_REQUIRED" },
      priority: "INFO",
      type: "job_invitation.expired",
    });
  });

  it("ignores unrelated events and rejects corrupt known events", () => {
    expect(mapJobInvitationNotificationEvent(event("quote.submitted"))).toBe(
      undefined,
    );
    expect(() =>
      mapJobInvitationNotificationEvent(
        event(JOB_INVITATION_NOTIFICATION_EVENT_NAMES.sent, {
          recipient_user_id: "customer@example.test",
        }),
      ),
    ).toThrow("recipient");
    expect(() =>
      mapJobInvitationNotificationEvent(
        event(JOB_INVITATION_NOTIFICATION_EVENT_NAMES.reminder, {
          expires_at: "tomorrow",
        }),
      ),
    ).toThrow("expiry");
    expect(() =>
      mapJobInvitationNotificationEvent(
        event(JOB_INVITATION_NOTIFICATION_EVENT_NAMES.reminder, {
          expires_at: "2026-02-31T08:00:00.000Z",
        }),
      ),
    ).toThrow("expiry");
    expect(() =>
      mapJobInvitationNotificationEvent(
        event(JOB_INVITATION_NOTIFICATION_EVENT_NAMES.sent, {
          body: "private",
        }),
      ),
    ).toThrow("payload keys");
  });
});
