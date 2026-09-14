import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createAnalytics,
  createMemoryAnalyticsTransport,
  createNoopAnalyticsTransport,
  validateAnalyticsEnvelope,
  type AnalyticsTransport,
} from "../src/index.js";

const actor = Object.freeze({
  is_internal: false,
  is_test: false,
  kind: "ACTOR" as const,
  profile_context: "CUSTOMER" as const,
  user_id: "123e4567-e89b-42d3-a456-426614174000",
});
const jobRequestId = "223e4567-e89b-42d3-a456-426614174000";
const quoteId = "323e4567-e89b-42d3-a456-426614174000";
const jobId = "423e4567-e89b-42d3-a456-426614174000";
const fixedEventId = "523e4567-e89b-42d3-a456-426614174000";
const fixedTime = new Date("2026-09-14T12:34:56.000Z");

describe("analytics event envelope", () => {
  it("stamps a stable server event ID/time and a versioned common envelope", async () => {
    const transport = createMemoryAnalyticsTransport("staging");
    const analytics = createAnalytics({
      appVersion: "sha-abc123",
      clock: () => fixedTime,
      environment: "staging",
      eventId: () => fixedEventId,
      platform: "WEB",
      transport,
    });

    await expect(
      analytics.capture({
        event_name: "quote_accepted",
        properties: {
          job_id: jobId,
          job_request_id: jobRequestId,
          quote_id: quoteId,
        },
        subject: actor,
      }),
    ).resolves.toEqual({ event_id: fixedEventId, status: "DELIVERED" });

    expect(transport.events()).toEqual([
      {
        actor_context: {
          is_internal: false,
          is_test: false,
          profile_context: "CUSTOMER",
          user_id: actor.user_id,
        },
        app_version: "sha-abc123",
        environment: "staging",
        event_id: fixedEventId,
        event_name: "quote_accepted",
        event_source: "SERVER_DOMAIN",
        occurred_at: fixedTime.toISOString(),
        platform: "WEB",
        properties: {
          job_id: jobId,
          job_request_id: jobRequestId,
          quote_id: quoteId,
        },
        schema_version: 1,
      },
    ]);
  });

  it("supports an opaque anonymous context without accepting contact data", async () => {
    const transport = createMemoryAnalyticsTransport("development");
    const analytics = createAnalytics({
      appVersion: "dev",
      environment: "development",
      platform: "WEB",
      transport,
    });
    const result = await analytics.capture({
      event_name: "public_profile_viewed",
      properties: {
        craftsman_profile_id: "623e4567-e89b-42d3-a456-426614174000",
      },
      subject: {
        anonymous_id: `anon_${"a".repeat(32)}`,
        is_internal: false,
        is_test: false,
        kind: "ANONYMOUS",
        session_id: `session_${"b".repeat(32)}`,
      },
    });

    expect(result.status).toBe("DELIVERED");
    expect(transport.events()[0]).not.toHaveProperty("actor_context");
  });

  it("requires trusted exclusion flags for anonymous traffic", async () => {
    const transport = createMemoryAnalyticsTransport("development");
    const analytics = createAnalytics({
      appVersion: "dev",
      environment: "development",
      platform: "WEB",
      transport,
    });

    await expect(
      analytics.capture({
        event_name: "search_started",
        properties: {
          search_id: "723e4567-e89b-42d3-a456-426614174000",
        },
        subject: {
          anonymous_id: `anon_${"a".repeat(32)}`,
          kind: "ANONYMOUS",
        },
      } as never),
    ).resolves.toEqual({ reason: "INVALID_EVENT", status: "DROPPED" });
    expect(transport.events()).toHaveLength(0);
  });

  it.each([
    ["email", "person@example.test"],
    ["phone", "+421900123456"],
    ["token", "not-allowed"],
    ["exact_address", "Hlavna 12 Bratislava"],
    ["chat_text", "private conversation"],
    ["description", "free form request body"],
    ["review_text", "identifying review text"],
    ["filename", "identity-document.pdf"],
    ["document_contents", "private PDF contents"],
    ["coordinates", "48.1486,17.1077"],
  ])("rejects forbidden %s payloads before transport", async (key, value) => {
    const transport = createMemoryAnalyticsTransport("staging");
    const analytics = createAnalytics({
      appVersion: "test",
      environment: "staging",
      platform: "WEB",
      transport,
    });

    await expect(
      analytics.capture({
        event_name: "job_request_submitted",
        properties: { job_request_id: jobRequestId, [key]: value },
        subject: actor,
      } as never),
    ).resolves.toEqual({ reason: "INVALID_EVENT", status: "DROPPED" });
    expect(transport.events()).toHaveLength(0);
  });

  it("rejects nested business-object dumps and free text in allowlisted fields", async () => {
    const transport = createMemoryAnalyticsTransport("staging");
    const analytics = createAnalytics({
      appVersion: "test",
      environment: "staging",
      platform: "WEB",
      transport,
    });
    const unsafeValues = [
      { id: jobRequestId, customer: { email: "person@example.test" } },
      "message body with private details",
      "421900123456",
    ];

    for (const unsafe of unsafeValues) {
      const result = await analytics.capture({
        event_name: "job_request_submitted",
        properties: { job_request_id: unsafe },
        subject: actor,
      } as never);
      expect(result).toEqual({ reason: "INVALID_EVENT", status: "DROPPED" });
    }
    expect(transport.events()).toHaveLength(0);
  });

  it("rejects email, phone and token values in identity contexts", async () => {
    const transport = createMemoryAnalyticsTransport("staging");
    const analytics = createAnalytics({
      appVersion: "test",
      environment: "staging",
      platform: "WEB",
      transport,
    });
    for (const user_id of [
      "person@example.test",
      "+421900123456",
      "token_value_never_allowed",
    ]) {
      const result = await analytics.capture({
        event_name: "registration_completed",
        properties: {},
        subject: { ...actor, user_id },
      });
      expect(result.status).toBe("DROPPED");
    }
    expect(transport.events()).toHaveLength(0);
  });

  it("rejects malformed IDs, unknown names and incompatible schema versions", () => {
    const valid = {
      actor_context: {
        is_internal: false,
        is_test: false,
        profile_context: "CUSTOMER",
        user_id: actor.user_id,
      },
      app_version: "sha-abc123",
      environment: "production",
      event_id: fixedEventId,
      event_name: "job_completed",
      event_source: "SERVER_DOMAIN",
      occurred_at: fixedTime.toISOString(),
      platform: "WEB",
      properties: { job_id: jobId },
      schema_version: 1,
    };

    expect(() => validateAnalyticsEnvelope(valid)).not.toThrow();
    expect(() =>
      validateAnalyticsEnvelope({ ...valid, event_id: "not-a-uuid" }),
    ).toThrow(/event_id must be a UUID/u);
    expect(() =>
      validateAnalyticsEnvelope({ ...valid, event_name: "button_clicked" }),
    ).toThrow(/explicit catalog/u);
    expect(() =>
      validateAnalyticsEnvelope({ ...valid, schema_version: 2 }),
    ).toThrow(/schema_version/u);
  });

  it("requires exactly one actor or anonymous context", () => {
    const base = {
      app_version: "test",
      environment: "staging",
      event_id: randomUUID(),
      event_name: "job_completed",
      event_source: "SERVER_DOMAIN",
      occurred_at: fixedTime.toISOString(),
      platform: "WEB",
      properties: { job_id: jobId },
      schema_version: 1,
    };
    expect(() => validateAnalyticsEnvelope(base)).toThrow(/exactly one/u);
    expect(() =>
      validateAnalyticsEnvelope({
        ...base,
        actor_context: actor,
        anonymous_context: { anonymous_id: `anon_${"a".repeat(32)}` },
      }),
    ).toThrow(/exactly one/u);
  });
});

describe("analytics delivery isolation", () => {
  it("never rejects the business flow when a provider is unavailable", async () => {
    const diagnostic = vi.fn(() => {
      throw new Error("diagnostic sink is down too");
    });
    const transport: AnalyticsTransport = {
      deliver() {
        return Promise.reject(new Error("provider unavailable"));
      },
      environment: "production",
      kind: "PROVIDER",
    };
    const analytics = createAnalytics({
      appVersion: "sha-prod",
      environment: "production",
      onDiagnostic: diagnostic,
      platform: "WEB",
      transport,
    });

    await expect(
      analytics.capture({
        event_id: fixedEventId,
        event_name: "job_completed",
        properties: { job_id: jobId },
        subject: actor,
      }),
    ).resolves.toEqual({
      event_id: fixedEventId,
      reason: "TRANSPORT_UNAVAILABLE",
      status: "DROPPED",
    });
    expect(diagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ code: "TRANSPORT_UNAVAILABLE" }),
    );
  });

  it("fails safe when production is wired to a staging destination", async () => {
    const deliver = vi.fn(() => Promise.resolve());
    const analytics = createAnalytics({
      appVersion: "sha-prod",
      environment: "production",
      eventId: () => fixedEventId,
      platform: "WEB",
      transport: { deliver, environment: "staging", kind: "PROVIDER" },
    });

    expect(analytics.readiness()).toEqual({
      reason: "CROSS_ENVIRONMENT_TRANSPORT",
      status: "MISCONFIGURED",
    });
    await expect(
      analytics.capture({
        event_name: "job_completed",
        properties: { job_id: jobId },
        subject: actor,
      }),
    ).resolves.toEqual({
      event_id: fixedEventId,
      reason: "TRANSPORT_MISCONFIGURED",
      status: "DROPPED",
    });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("cannot activate an in-memory test transport in production", () => {
    const staging = createMemoryAnalyticsTransport("staging");
    const analytics = createAnalytics({
      appVersion: "sha-prod",
      environment: "production",
      platform: "WEB",
      transport: { ...staging, environment: "production" },
    });
    expect(analytics.readiness()).toEqual({
      reason: "TEST_TRANSPORT_IN_PRODUCTION",
      status: "MISCONFIGURED",
    });
  });

  it("makes disabled collection explicit through a no-op transport", async () => {
    const analytics = createAnalytics({
      appVersion: "dev",
      environment: "development",
      eventId: () => fixedEventId,
      platform: "WEB",
      transport: createNoopAnalyticsTransport("development"),
    });
    expect(analytics.readiness()).toEqual({ status: "DISABLED" });
    await expect(
      analytics.capture({
        event_name: "registration_completed",
        properties: {},
        subject: actor,
      }),
    ).resolves.toEqual({
      event_id: fixedEventId,
      reason: "TRANSPORT_DISABLED",
      status: "DROPPED",
    });
  });
});
