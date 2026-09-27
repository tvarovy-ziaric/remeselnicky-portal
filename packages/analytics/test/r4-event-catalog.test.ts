import { describe, expect, it } from "vitest";

import {
  analyticsEventCatalog,
  analyticsEventNames,
  createAnalytics,
  createMemoryAnalyticsTransport,
} from "../src/index.js";

const actor = Object.freeze({
  is_internal: false,
  is_test: false,
  kind: "ACTOR" as const,
  profile_context: "CRAFTSMAN" as const,
  user_id: "123e4567-e89b-42d3-a456-426614174000",
});

describe("D28 R4 analytics event catalog", () => {
  it("documents every stable name with one frozen schema and no content properties", () => {
    expect(new Set(analyticsEventNames).size).toBe(analyticsEventNames.length);
    expect(Object.keys(analyticsEventCatalog)).toEqual([
      ...analyticsEventNames,
    ]);

    const forbiddenProperty =
      /(?:address|body|content|coordinate|document|email|evidence|filename|free_text|message_text|otp|password|phone|query_text|review_text|signed_url|statement|token)/iu;
    for (const [eventName, definition] of Object.entries(
      analyticsEventCatalog,
    )) {
      expect(definition.description, eventName).not.toHaveLength(0);
      expect(definition.trigger, eventName).not.toHaveLength(0);
      expect(definition.schema_version, eventName).toBeGreaterThan(0);
      expect(Object.isFrozen(definition), eventName).toBe(true);
      expect(Object.isFrozen(definition.properties), eventName).toBe(true);
      for (const property of Object.keys(definition.properties)) {
        expect(property, `${eventName}.${property}`).not.toMatch(
          forbiddenProperty,
        );
      }
    }
  });

  it("captures a successful R4 domain event and rejects ungoverned categories", async () => {
    const transport = createMemoryAnalyticsTransport("staging");
    const analytics = createAnalytics({
      appVersion: "r4-test",
      environment: "staging",
      platform: "WEB",
      transport,
    });

    await expect(
      analytics.capture({
        event_name: "job_completion_rejected",
        properties: {
          completion_attempt_id: "223e4567-e89b-42d3-a456-426614174000",
          job_id: "323e4567-e89b-42d3-a456-426614174000",
          rejection_category: "WORK_NOT_COMPLETE",
        },
        subject: actor,
      }),
    ).resolves.toMatchObject({ status: "DELIVERED" });

    await expect(
      analytics.capture({
        event_name: "job_completion_rejected",
        properties: {
          completion_attempt_id: "223e4567-e89b-42d3-a456-426614174000",
          job_id: "323e4567-e89b-42d3-a456-426614174000",
          rejection_category: "contains private prose",
        },
        subject: actor,
      }),
    ).resolves.toMatchObject({ reason: "INVALID_EVENT", status: "DROPPED" });
    expect(transport.events()).toHaveLength(1);
  });

  it("keeps authoritative business outcomes server-derived", () => {
    const serverEvents = [
      "job_started",
      "change_order_approved",
      "job_completion_accepted",
      "job_completed",
      "review_submitted",
      "dispute_closed",
      "moderation_action_applied",
      "notification_delivery_succeeded",
    ] as const;
    for (const eventName of serverEvents) {
      expect(analyticsEventCatalog[eventName].source).toBe("SERVER_DOMAIN");
    }
  });
});
