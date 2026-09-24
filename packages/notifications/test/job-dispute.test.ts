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
      channels: ["IN_APP"],
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
    expect(JSON.stringify(draft)).not.toMatch(
      /description|resolution|address|email|phone|evidence/iu,
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

  it("ignores events outside its bounded catalog", () => {
    expect(
      mapJobDisputeNotificationEvent({
        ...event(),
        name: "job.dispute.other",
      }),
    ).toBeUndefined();
  });
});
