import { randomUUID } from "node:crypto";

import type { PersistedDomainEvent } from "@portal/outbox";
import { describe, expect, it } from "vitest";

import {
  getJobDisputeNotificationCopy,
  mapDemandSideNotificationEvent,
  mapJobDisputeNotificationEvent,
  validateNotificationDraft,
} from "../src/index.js";

const disputeId = randomUUID();
const jobId = randomUUID();
const recipientUserId = randomUUID();

function event(
  payload: Readonly<Record<string, string>> = {},
  entityId = disputeId,
): PersistedDomainEvent {
  return Object.freeze({
    entity: Object.freeze({ id: entityId, type: "DISPUTE_CASE" }),
    eventId: randomUUID(),
    idempotencyKey: `dispute:${disputeId}:opened:${recipientUserId}`,
    name: "job.dispute.opened",
    occurredAt: new Date("2026-09-24T10:00:00.000Z"),
    payload: Object.freeze({
      dispute_id: disputeId,
      job_id: jobId,
      recipient_user_id: recipientUserId,
      ...payload,
    }),
    schemaVersion: 1,
  });
}

describe("D22 Job dispute notification catalog", () => {
  it("creates one private important read action without dispute content", () => {
    const draft = mapDemandSideNotificationEvent(event())?.[0];
    expect(draft).toEqual({
      channels: ["IN_APP", "EMAIL"],
      context: {
        entityId: disputeId,
        entityType: "DISPUTE_CASE",
        path: `/zakazky/${jobId}`,
      },
      payload: {
        action: "READ_DISPUTE_CASE",
        dispute_id: disputeId,
        job_id: jobId,
      },
      priority: "IMPORTANT",
      recipientUserId,
      type: "job.dispute.opened",
    });
    expect(() => validateNotificationDraft(draft as never)).not.toThrow();
    expect(JSON.stringify(draft?.payload)).not.toMatch(
      /description|resolution|address|email_address|phone|evidence/iu,
    );
  });

  it("fails closed on extra private fields and incoherent identities", () => {
    expect(() =>
      mapJobDisputeNotificationEvent(event({ description: "never copy me" })),
    ).toThrow(/payload keys/iu);
    expect(() =>
      mapJobDisputeNotificationEvent(event({}, randomUUID())),
    ).toThrow(/identity/iu);
    expect(() =>
      mapJobDisputeNotificationEvent({ ...event(), schemaVersion: 2 }),
    ).toThrow(/envelope/iu);
  });

  it("keeps neutral Slovak copy separate from the private event", () => {
    const copy = getJobDisputeNotificationCopy("job.dispute.opened");
    expect(copy.title).toBe("Nový sporný prípad k zákazke");
    expect(copy.body).toMatch(/súkromný prípad/iu);
    expect(`${copy.title} ${copy.body}`).not.toMatch(
      /vina|vinný|refund|náhrada priznaná/iu,
    );
  });

  it("maps an admin action without request, outcome, note or audit text", () => {
    const draft = mapJobDisputeNotificationEvent({
      ...event({ action: "REQUEST_INFORMATION" }),
      name: "job.dispute.admin_action",
    })?.[0];
    expect(draft).toMatchObject({
      channels: ["IN_APP", "EMAIL"],
      context: { path: `/zakazky/${jobId}` },
      payload: {
        action: "READ_DISPUTE_ADMIN_ACTION",
        case_action: "REQUEST_INFORMATION",
        dispute_id: disputeId,
        job_id: jobId,
      },
      priority: "IMPORTANT",
    });
    expect(JSON.stringify(draft)).not.toMatch(
      /request_text|summary|internal_note|reason/iu,
    );
    expect(() =>
      mapJobDisputeNotificationEvent({
        ...event({ action: "LEGAL_VERDICT" }),
        name: "job.dispute.admin_action",
      }),
    ).toThrow(/action/iu);
  });

  it("maps a party action without settlement or withdrawal content", () => {
    const draft = mapJobDisputeNotificationEvent({
      ...event({ action: "CONFIRM_SETTLEMENT" }),
      name: "job.dispute.party_action",
    })?.[0];
    expect(draft).toMatchObject({
      channels: ["IN_APP"],
      context: { path: `/zakazky/${jobId}` },
      payload: {
        action: "READ_DISPUTE_PARTY_ACTION",
        case_action: "CONFIRM_SETTLEMENT",
        dispute_id: disputeId,
        job_id: jobId,
      },
      priority: "IMPORTANT",
    });
    expect(JSON.stringify(draft)).not.toMatch(
      /settlement_summary|withdrawal_reason|description|evidence/iu,
    );
    expect(() =>
      mapJobDisputeNotificationEvent({
        ...event({ action: "REWRITE_AGREEMENT" }),
        name: "job.dispute.party_action",
      }),
    ).toThrow(/party action/iu);
  });

  it("ignores events outside its bounded catalog", () => {
    expect(
      mapJobDisputeNotificationEvent({
        ...event(),
        name: "job.dispute.other",
      }),
    ).toBeUndefined();
  });
});
