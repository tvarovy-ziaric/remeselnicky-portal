import { randomUUID } from "node:crypto";

import type { PersistedDomainEvent } from "@portal/outbox";
import { describe, expect, it } from "vitest";

import {
  ALPHA_NOTIFICATION_TYPES,
  getNotificationPolicy,
  getNotificationPresentation,
  mapDemandSideNotificationEvent,
  validateNotificationDraft,
} from "../src/index.js";

const recipient = randomUUID();
function event(
  name: string,
  entityType: string,
  entityId: string,
  payload: Record<string, string | null>,
): PersistedDomainEvent {
  return {
    entity: { id: entityId, type: entityType },
    eventId: randomUUID(),
    idempotencyKey: `alpha:${randomUUID()}`,
    name,
    occurredAt: new Date("2026-09-25T08:00:00.000Z"),
    payload: { recipient_user_id: recipient, ...payload },
    schemaVersion: 1,
  };
}

describe("D25 alpha notification catalog", () => {
  it("defines presentation and preference policy for every alpha type", () => {
    expect(ALPHA_NOTIFICATION_TYPES.length).toBeGreaterThan(40);
    for (const type of ALPHA_NOTIFICATION_TYPES) {
      const presentation = getNotificationPresentation(type, {});
      expect(typeof presentation.body).toBe("string");
      expect(typeof presentation.category).toBe("string");
      expect(typeof presentation.title).toBe("string");
      expect(typeof getNotificationPolicy(type).emailRequired).toBe("boolean");
    }
    expect(() => getNotificationPolicy("unknown.notification")).toThrow(
      "Unknown",
    );
  });

  it("maps confirmed Jobs and moderation without contact, notes or hidden heuristics", () => {
    const jobId = randomUUID();
    const confirmed = mapDemandSideNotificationEvent(
      event("job.confirmed", "JOB", jobId, { job_id: jobId }),
    )?.[0];
    expect(confirmed).toMatchObject({
      channels: ["IN_APP", "EMAIL"],
      priority: "IMPORTANT",
      context: { path: `/zakazky/${jobId}` },
    });
    const actionId = randomUUID();
    const moderation = mapDemandSideNotificationEvent(
      event("moderation.action.applied", "MODERATION_ACTION", actionId, {
        action: "APPLY_TEMPORARY_SUSPENSION",
        action_id: actionId,
        general_reason_category: "SAFETY",
      }),
    )?.[0];
    expect(moderation).toMatchObject({
      priority: "CRITICAL",
      payload: { action: "APPLY_TEMPORARY_SUSPENSION", action_id: actionId },
    });
    expect(() => validateNotificationDraft(moderation as never)).not.toThrow();
    expect(JSON.stringify(moderation?.payload)).not.toMatch(
      /private_note|email|phone|heuristic|address/iu,
    );
    const restrictionId = randomUUID();
    expect(
      mapDemandSideNotificationEvent(
        event("moderation.action.applied", "MODERATION_ACTION", restrictionId, {
          action: "APPLY_FEATURE_RESTRICTION",
          action_id: restrictionId,
          general_reason_category: "SAFETY",
        }),
      )?.[0],
    ).toMatchObject({ priority: "CRITICAL" });
  });

  it("maps review response and credential outcomes to exact authenticated contexts", () => {
    const responseId = randomUUID();
    const jobId = randomUUID();
    expect(
      mapDemandSideNotificationEvent(
        event("job.review.response.created", "REVIEW_RESPONSE", responseId, {
          job_id: jobId,
          response_id: responseId,
        }),
      )?.[0],
    ).toMatchObject({
      channels: ["IN_APP"],
      context: { path: `/zakazky/${jobId}` },
      priority: "INFO",
    });
    const claimId = randomUUID();
    expect(
      mapDemandSideNotificationEvent(
        event("credential.revoked", "CREDENTIAL_CLAIM", claimId, {
          claim_id: claimId,
          decision: "REVOKE",
          reason_category: "FALSE_QUALIFICATION",
        }),
      )?.[0],
    ).toMatchObject({
      context: { path: `/ucet/kvalifikacie/${claimId}` },
      priority: "CRITICAL",
    });
  });

  it("rejects extra payload keys before they become a hidden-data side channel", () => {
    const actionId = randomUUID();
    expect(() =>
      mapDemandSideNotificationEvent(
        event("moderation.action.applied", "MODERATION_ACTION", actionId, {
          action: "APPLY_WARNING",
          action_id: actionId,
          general_reason_category: "SAFETY",
          private_note: "secret",
        }),
      ),
    ).toThrow("payload keys");
  });
});
