import { randomUUID } from "node:crypto";

import type { PersistedDomainEvent } from "@portal/outbox";
import { describe, expect, it } from "vitest";

import {
  DEMAND_SIDE_EXTENSION_EVENT_NAMES,
  DEMAND_SIDE_NOTIFICATION_EVENT_NAMES,
  JOB_INVITATION_NOTIFICATION_EVENT_NAMES,
  mapDemandSideNotificationEvent,
  validateNotificationDraft,
} from "../src/index.js";

const recipientUserId = randomUUID();
const invitationId = randomUUID();
const jobRequestId = randomUUID();

function event(input: {
  readonly entityId?: string;
  readonly entityType: string;
  readonly name: string;
  readonly payload?: Readonly<Record<string, boolean | number | string | null>>;
  readonly schemaVersion?: number;
}): PersistedDomainEvent {
  return Object.freeze({
    entity: Object.freeze({
      id: input.entityId ?? randomUUID(),
      type: input.entityType,
    }),
    eventId: randomUUID(),
    idempotencyKey: `r3:${randomUUID()}`,
    name: input.name,
    occurredAt: new Date("2026-09-15T08:00:00.000Z"),
    payload: Object.freeze({
      recipient_user_id: recipientUserId,
      ...input.payload,
    }),
    schemaVersion: input.schemaVersion ?? 1,
  });
}

describe("R3 demand-side notification catalog", () => {
  it("owns a catalog disjoint from the delegated invitation events", () => {
    const delegated = new Set(
      Object.values(JOB_INVITATION_NOTIFICATION_EVENT_NAMES),
    );
    expect(
      Object.values(DEMAND_SIDE_EXTENSION_EVENT_NAMES).filter((name) =>
        delegated.has(name as never),
      ),
    ).toEqual([]);
    expect(
      new Set(Object.values(DEMAND_SIDE_NOTIFICATION_EVENT_NAMES)).size,
    ).toBe(Object.values(DEMAND_SIDE_NOTIFICATION_EVENT_NAMES).length);
  });

  it.each([
    [
      DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.invitationEngaged,
      "job_invitation.provider_engaged",
      ["IN_APP", "EMAIL"],
      "IMPORTANT",
    ],
    [
      DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.invitationDeclined,
      "job_invitation.provider_declined",
      ["IN_APP"],
      "INFO",
    ],
    [
      DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.invitationWithdrawnByCustomer,
      "job_invitation.withdrawn_by_customer",
      ["IN_APP"],
      "INFO",
    ],
    [
      DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.invitationWithdrawnByProvider,
      "job_invitation.withdrawn_by_provider",
      ["IN_APP"],
      "INFO",
    ],
    [
      DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.invitationRequestClosed,
      "job_invitation.request_closed",
      ["IN_APP"],
      "INFO",
    ],
    [
      DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.invitationNotSelected,
      "job_invitation.not_selected",
      ["IN_APP"],
      "INFO",
    ],
  ] as const)(
    "maps %s through the stable invitation contract",
    (name, type, channels, priority) => {
      const draft = mapDemandSideNotificationEvent(
        event({
          entityType: "JOB_INVITATION",
          name,
          payload: { invitation_revision: 2 },
        }),
      )?.[0];
      expect(draft).toMatchObject({ channels, priority, type });
      expect(draft?.context.path).toMatch(/^\/invitations\/[0-9a-f-]+$/u);
      expect(() => validateNotificationDraft(draft as never)).not.toThrow();
    },
  );

  it("keeps chat body and author identity out of an immediate in-app-only signal", () => {
    const conversationId = randomUUID();
    const draft = mapDemandSideNotificationEvent(
      event({
        entityId: conversationId,
        entityType: "CONVERSATION",
        name: DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.conversationMessageCreated,
        payload: { conversation_sequence: 7, invitation_id: invitationId },
      }),
    )?.[0];
    expect(draft).toEqual({
      channels: ["IN_APP"],
      context: {
        entityId: conversationId,
        entityRevision: 7,
        entityType: "CONVERSATION",
        path: `/konverzacie/pozvanka/${invitationId}`,
      },
      payload: { action: "OPEN_CONVERSATION", conversation_sequence: 7 },
      priority: "INFO",
      recipientUserId,
      type: "conversation.message_received",
    });
  });

  it("maps only material request updates to a provider action without request content", () => {
    const draft = mapDemandSideNotificationEvent(
      event({
        entityId: jobRequestId,
        entityType: "JOB_REQUEST",
        name: DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobRequestMateriallyUpdated,
        payload: {
          invitation_id: invitationId,
          request_content_revision: 4,
          request_visible_version: 3,
        },
      }),
    )?.[0];
    expect(draft).toMatchObject({
      channels: ["IN_APP", "EMAIL"],
      context: {
        entityId: jobRequestId,
        entityRevision: 4,
        path: `/invitations/${invitationId}/verzie/4`,
      },
      payload: {
        action: "REVIEW_MATERIAL_UPDATE",
        request_content_revision: 4,
        request_visible_version: 3,
      },
      priority: "IMPORTANT",
      type: "job_request.materially_updated",
    });
  });

  it.each([
    ["quote.submitted", "quote.submitted", ["IN_APP", "EMAIL"], "CUSTOMER"],
    ["quote.revised", "quote.revised", ["IN_APP", "EMAIL"], "CUSTOMER"],
    ["quote.rejected", "quote.rejected", ["IN_APP"], "PROVIDER"],
    ["quote.withdrawn", "quote.withdrawn", ["IN_APP"], "CUSTOMER"],
    ["quote.expired", "quote.expired", ["IN_APP"], "CUSTOMER"],
  ] as const)(
    "maps %s without commercial content",
    (name, type, channels, audience) => {
      const quoteId = randomUUID();
      const draft = mapDemandSideNotificationEvent(
        event({
          entityId: quoteId,
          entityType: "QUOTE",
          name,
          payload: {
            invitation_id: invitationId,
            job_request_id: jobRequestId,
            quote_revision: 2,
            recipient_audience: audience,
          },
        }),
      )?.[0];
      expect(draft).toMatchObject({ channels, type });
      const comparison = name === "quote.submitted" || name === "quote.revised";
      expect(draft?.context.path).toBe(
        comparison
          ? `/ziadosti/${jobRequestId}/ponuky`
          : `/konverzacie/pozvanka/${invitationId}`,
      );
      expect(JSON.stringify(draft?.payload)).not.toMatch(
        /price|amount|reason|body|email|phone|address|storage|document/iu,
      );
      expect(() => validateNotificationDraft(draft as never)).not.toThrow();
    },
  );

  it("delegates the existing invitation catalog and ignores unrelated events", () => {
    expect(
      mapDemandSideNotificationEvent(
        event({
          entityType: "JOB_INVITATION",
          name: DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.sent,
          payload: { invitation_revision: 1 },
        }),
      )?.[0]?.type,
    ).toBe("job_invitation.received");
    expect(
      mapDemandSideNotificationEvent(
        event({ entityType: "JOB", name: "job.confirmed" }),
      ),
    ).toBeUndefined();
  });

  it("routes provider Quote expiry to the provider conversation", () => {
    const draft = mapDemandSideNotificationEvent(
      event({
        entityType: "QUOTE",
        name: "quote.expired",
        payload: {
          recipient_audience: "PROVIDER",
          invitation_id: invitationId,
          job_request_id: jobRequestId,
          quote_revision: 1,
        },
      }),
    )?.[0];
    expect(draft?.context.path).toBe(`/konverzacie/pozvanka/${invitationId}`);
  });

  it.each([
    event({
      entityType: "CONVERSATION",
      name: "conversation.message_created",
      payload: { conversation_sequence: 0, invitation_id: invitationId },
    }),
    event({
      entityType: "QUOTE",
      name: "quote.submitted",
      payload: {
        invitation_id: invitationId,
        job_request_id: jobRequestId,
        quote_revision: 1,
        recipient_audience: "CUSTOMER",
        recipient_user_id: "customer@example.test",
      },
    }),
    event({
      entityType: "QUOTE",
      name: "quote.rejected",
      payload: {
        invitation_id: invitationId,
        job_request_id: "not-a-uuid",
        quote_revision: 1,
        recipient_audience: "PROVIDER",
      },
    }),
    event({
      entityType: "JOB_REQUEST",
      name: "job_request.materially_updated",
      payload: { invitation_id: invitationId, request_visible_version: 2 },
      schemaVersion: 2,
    }),
    event({
      entityType: "CONVERSATION",
      name: "conversation.message_created",
      payload: {
        body: "private",
        conversation_sequence: 2,
        invitation_id: invitationId,
      },
    }),
  ])("rejects corrupt known envelopes and payloads", (candidate) => {
    expect(() => mapDemandSideNotificationEvent(candidate)).toThrow();
  });
});
