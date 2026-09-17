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
  it.each([
    ["job.completion.proposed", "REVIEW_COMPLETION_PROPOSAL"],
    ["job.completion.proposal_agreed", "COMPLETION_PROPOSAL_AGREED"],
    ["job.completion.proposal_disagreed", "COMPLETION_PROPOSAL_DISAGREED"],
  ] as const)(
    "maps %s without the private proposal note or reason",
    (name, action) => {
      const jobId = randomUUID();
      const proposalId = randomUUID();
      const draft = mapDemandSideNotificationEvent(
        event({
          entityId: jobId,
          entityType: "JOB",
          name,
          payload: { job_id: jobId, proposal_id: proposalId },
        }),
      )?.[0];
      expect(draft).toEqual({
        channels: ["IN_APP", "EMAIL"],
        context: {
          entityId: jobId,
          entityType: "JOB",
          path: `/zakazky/${jobId}`,
        },
        payload: { action, proposal_id: proposalId },
        priority: "IMPORTANT",
        recipientUserId,
        type: name,
      });
      expect(() => validateNotificationDraft(draft as never)).not.toThrow();
      expect(JSON.stringify(draft)).not.toMatch(
        /note|reason|body|media|address/iu,
      );
      expect(() =>
        mapDemandSideNotificationEvent(
          event({
            entityId: randomUUID(),
            entityType: "JOB",
            name,
            payload: { job_id: jobId, proposal_id: proposalId },
          }),
        ),
      ).toThrow();
    },
  );

  it.each([
    [
      "job.completion.requested",
      "REVIEW_COMPLETION",
      "IMPORTANT",
      ["IN_APP", "EMAIL"],
    ],
    [
      "job.completion.accepted",
      "COMPLETION_ACCEPTED",
      "IMPORTANT",
      ["IN_APP", "EMAIL"],
    ],
    [
      "job.completion.rejected",
      "COMPLETION_REJECTED",
      "IMPORTANT",
      ["IN_APP", "EMAIL"],
    ],
    ["job.completion.withdrawn", "COMPLETION_WITHDRAWN", "INFO", ["IN_APP"]],
  ] as const)(
    "maps %s to private Job handover without reasons or media",
    (name, action, priority, channels) => {
      const jobId = randomUUID();
      const attemptId = randomUUID();
      const draft = mapDemandSideNotificationEvent(
        event({
          entityId: jobId,
          entityType: "JOB",
          name,
          payload: { job_id: jobId, attempt_id: attemptId },
        }),
      )?.[0];
      expect(draft).toEqual({
        channels,
        context: {
          entityId: jobId,
          entityType: "JOB",
          path: `/zakazky/${jobId}`,
        },
        payload: { action, attempt_id: attemptId },
        priority,
        recipientUserId,
        type: name,
      });
      expect(() => validateNotificationDraft(draft as never)).not.toThrow();
      expect(JSON.stringify(draft)).not.toMatch(
        /reason|note|media|filename|address|payment/iu,
      );
      expect(() =>
        mapDemandSideNotificationEvent(
          event({
            entityId: randomUUID(),
            entityType: "JOB",
            name,
            payload: { job_id: jobId, attempt_id: attemptId },
          }),
        ),
      ).toThrow();
      expect(() =>
        mapDemandSideNotificationEvent(
          event({
            entityId: jobId,
            entityType: "JOB",
            name,
            payload: {
              job_id: jobId,
              attempt_id: attemptId,
              reason: "private",
            },
          }),
        ),
      ).toThrow();
    },
  );

  it.each([
    ["job.change_order.proposed", "REVIEW_CHANGE_ORDER"],
    ["job.change_order.counterproposed", "REVIEW_CHANGE_ORDER_REVISION"],
    ["job.change_order.approved", "CHANGE_ORDER_APPROVED"],
    ["job.change_order.rejected", "CHANGE_ORDER_REJECTED"],
    ["job.change_order.withdrawn", "CHANGE_ORDER_WITHDRAWN"],
  ] as const)(
    "maps %s to the exact private revision without commercial content",
    (name, action) => {
      const jobId = randomUUID();
      const changeOrderId = randomUUID();
      const revisionId = randomUUID();
      const draft = mapDemandSideNotificationEvent(
        event({
          entityId: revisionId,
          entityType: "CHANGE_ORDER_REVISION",
          name,
          payload: {
            job_id: jobId,
            change_order_id: changeOrderId,
            revision_id: revisionId,
            revision_number: 3,
          },
        }),
      )?.[0];
      expect(draft).toEqual({
        channels: ["IN_APP", "EMAIL"],
        context: {
          entityId: revisionId,
          entityRevision: 3,
          entityType: "CHANGE_ORDER_REVISION",
          path: `/zakazky/${jobId}/zmeny/${changeOrderId}/revizie/${revisionId}`,
        },
        payload: { action, revision_number: 3 },
        priority: "IMPORTANT",
        recipientUserId,
        type: name,
      });
      expect(() => validateNotificationDraft(draft as never)).not.toThrow();
      expect(JSON.stringify(draft)).not.toMatch(
        /price|amount|reason|body|email_address|phone|address|storage|filename|document|pdf/iu,
      );
    },
  );

  it("rejects malformed Change-order envelopes, spoofed revision IDs and sensitive payload additions", () => {
    const jobId = randomUUID();
    const changeOrderId = randomUUID();
    const revisionId = randomUUID();
    const base = {
      job_id: jobId,
      change_order_id: changeOrderId,
      revision_id: revisionId,
      revision_number: 2,
    };
    const standard = {
      entityId: revisionId,
      entityType: "CHANGE_ORDER_REVISION",
      name: DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobChangeOrderProposed,
    };
    expect(() =>
      mapDemandSideNotificationEvent(event({ ...standard, payload: base })),
    ).not.toThrow();
    expect(() =>
      mapDemandSideNotificationEvent(
        event({ ...standard, entityId: randomUUID(), payload: base }),
      ),
    ).toThrow();
    expect(() =>
      mapDemandSideNotificationEvent(
        event({ ...standard, entityType: "JOB", payload: base }),
      ),
    ).toThrow();
    expect(() =>
      mapDemandSideNotificationEvent(
        event({ ...standard, schemaVersion: 2, payload: base }),
      ),
    ).toThrow();
    for (const payload of [
      { ...base, revision_number: 0 },
      { ...base, revision_number: 1.5 },
      { ...base, revision_id: "not-a-uuid" },
      { ...base, job_id: "not-a-uuid" },
      { ...base, change_order_id: "not-a-uuid" },
      { ...base, recipient_user_id: "private@example.test" },
      { ...base, price_cents: 50000 },
      { ...base, body: "private" },
      {
        job_id: jobId,
        change_order_id: changeOrderId,
        revision_id: revisionId,
      },
    ]) {
      expect(() =>
        mapDemandSideNotificationEvent(event({ ...standard, payload })),
      ).toThrow();
    }
  });
  it.each([
    ["job.progress.created", "progress_update_id", "priebeh", "INFO"],
    ["job.issue.created", "issue_id", "problemy", "IMPORTANT"],
  ] as const)(
    "maps %s to exact private Job context without content",
    (name, key, segment, priority) => {
      const jobId = randomUUID();
      const itemId = randomUUID();
      const payload =
        key === "issue_id"
          ? { issue_id: itemId, issue_kind: "DELAY" }
          : { progress_update_id: itemId };
      const draft = mapDemandSideNotificationEvent(
        event({
          entityId: jobId,
          entityType: "JOB",
          name,
          payload,
        }),
      )?.[0];
      expect(draft).toEqual({
        channels: ["IN_APP"],
        context: {
          entityId: jobId,
          entityType: "JOB",
          path: `/zakazky/${jobId}/${segment}/${itemId}`,
        },
        payload: {
          action: key === "issue_id" ? "REVIEW_ISSUE" : "READ_PROGRESS",
          [key]: itemId,
        },
        priority,
        recipientUserId,
        type: name,
      });
      expect(() => validateNotificationDraft(draft as never)).not.toThrow();
      expect(() =>
        mapDemandSideNotificationEvent(
          event({
            entityId: jobId,
            entityType: "JOB",
            name,
            payload: { ...payload, body: "private" },
          }),
        ),
      ).toThrow();
    },
  );
  it.each([
    [
      "job_participant.invited",
      "INVITED",
      ["IN_APP", "EMAIL"],
      "IMPORTANT",
      "INVITEE",
    ],
    [
      "job_participant.accepted",
      "ACCEPTED",
      ["IN_APP", "EMAIL"],
      "IMPORTANT",
      "JOB",
    ],
    [
      "job_participant.declined",
      "DECLINED",
      ["IN_APP", "EMAIL"],
      "IMPORTANT",
      "JOB",
    ],
    ["job_participant.joined", "JOINED", ["IN_APP"], "INFO", "JOB"],
    ["job_participant.left", "LEFT", ["IN_APP"], "INFO", "JOB"],
    ["job_participant.departed", "DEPARTED", ["IN_APP"], "INFO", "JOB"],
    ["job_participant.removed", "REMOVED", ["IN_APP"], "INFO", "HISTORY"],
  ] as const)(
    "maps %s to an exact guarded context without private details",
    (name, action, channels, priority, destination) => {
      const participantId = randomUUID();
      const jobId = randomUUID();
      const draft = mapDemandSideNotificationEvent(
        event({
          entityId: participantId,
          entityType: "JOB_PARTICIPANT",
          name,
          payload: {
            job_id: jobId,
            participant_id: participantId,
            participation_revision: 1,
          },
        }),
      )?.[0];
      const path =
        destination === "INVITEE"
          ? `/ucasti/pozvanky/${participantId}`
          : destination === "HISTORY"
            ? `/ucasti/historia/${participantId}`
            : `/zakazky/${jobId}/ucastnici/${participantId}`;
      expect(draft).toEqual({
        channels,
        context: {
          entityId: participantId,
          entityRevision: 1,
          entityType: "JOB_PARTICIPANT",
          path,
        },
        payload: { action, participation_revision: 1 },
        priority,
        recipientUserId,
        type: name,
      });
      expect(() => validateNotificationDraft(draft as never)).not.toThrow();
    },
  );

  it("rejects participant notification spoofing, reason and hidden address fields", () => {
    const participantId = randomUUID();
    const jobId = randomUUID();
    const base = {
      entityId: participantId,
      entityType: "JOB_PARTICIPANT",
      name: DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobParticipantJoined,
      payload: {
        job_id: jobId,
        participant_id: participantId,
        participation_revision: 1,
      },
    };
    expect(() =>
      mapDemandSideNotificationEvent(
        event({ ...base, entityId: randomUUID() }),
      ),
    ).toThrow();
    for (const key of ["reason", "exact_address", "customer_contact"]) {
      expect(() =>
        mapDemandSideNotificationEvent(
          event({ ...base, payload: { ...base.payload, [key]: "private" } }),
        ),
      ).toThrow();
    }
  });

  it.each([
    [DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobStarted, "WORK_STARTED"],
    [DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobCancelled, "WORK_CANCELLED"],
  ] as const)(
    "notifies the other primary party of %s without a reason",
    (name, action) => {
      const jobId = randomUUID();
      const draft = mapDemandSideNotificationEvent(
        event({
          entityId: jobId,
          entityType: "JOB",
          name,
          payload: { job_state_revision: 1 },
        }),
      )?.[0];
      expect(draft).toEqual({
        channels: ["IN_APP", "EMAIL"],
        context: {
          entityId: jobId,
          entityRevision: 1,
          entityType: "JOB",
          path: `/zakazky/${jobId}`,
        },
        payload: { action, job_state_revision: 1 },
        priority: "IMPORTANT",
        recipientUserId,
        type: name,
      });
      expect(() => validateNotificationDraft(draft as never)).not.toThrow();
      expect(() =>
        mapDemandSideNotificationEvent(
          event({
            entityId: jobId,
            entityType: "JOB",
            name,
            payload: { job_state_revision: 1, reason: "private reason" },
          }),
        ),
      ).toThrow();
    },
  );

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
