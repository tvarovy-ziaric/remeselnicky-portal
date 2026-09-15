import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  assertR3AnalyticsObservationInput,
  analyticsEventDefinition,
  createAnalytics,
  createMemoryAnalyticsTransport,
  createR3AnalyticsProcessor,
  createTrustedAnalyticsPublisher,
  validateAnalyticsEnvelope,
  type R3AnalyticsLease,
  type R3AnalyticsLeaseStore,
  type TrustedAnalyticsPublisher,
} from "../src/index.js";

const occurredAt = new Date("2026-09-15T12:00:00.000Z");
const userId = randomUUID();
const requestId = randomUUID();
const quoteId = randomUUID();
const subject = Object.freeze({
  is_internal: false,
  is_test: false,
  kind: "ACTOR" as const,
  profile_context: "CRAFTSMAN" as const,
  user_id: userId,
});

describe("R3 demand funnel analytics", () => {
  it("keeps legacy v1 and current v2 definitions separately valid", () => {
    expect(
      analyticsEventDefinition("job_request_submitted", 1)?.properties,
    ).toEqual({
      job_request_id: "UUID",
    });
    expect(
      analyticsEventDefinition("job_request_submitted", 2)?.properties,
    ).toHaveProperty("profession_code");
    expect(analyticsEventDefinition("quote_submitted", 1)?.properties).toEqual({
      job_request_id: "UUID",
      quote_id: "UUID",
    });
    expect(
      analyticsEventDefinition("quote_submitted", 2)?.properties,
    ).toHaveProperty("authoring_mode");
  });

  it("accepts v1 replay and v2 trusted capture with the DB effect timestamp", async () => {
    expect(() =>
      validateAnalyticsEnvelope(
        envelope("quote_submitted", 1, {
          job_request_id: requestId,
          quote_id: quoteId,
        }),
      ),
    ).not.toThrow();

    const transport = createMemoryAnalyticsTransport("staging");
    const publisher = createTrustedAnalyticsPublisher({
      appVersion: "r3",
      clock: () => new Date("2099-01-01T00:00:00.000Z"),
      environment: "staging",
      platform: "WEB",
      transport,
    });
    await expect(
      publisher.captureTrusted({
        event_id: randomUUID(),
        event_name: "quote_submitted",
        occurred_at: occurredAt,
        properties: {
          authoring_mode: "PLATFORM_STRUCTURED",
          job_request_id: requestId,
          price_mode: "FIXED",
          quote_id: quoteId,
          quote_revision: 1,
        },
        schema_version: 2,
        subject,
      }),
    ).resolves.toMatchObject({ status: "DELIVERED" });
    expect(transport.events()[0]?.occurred_at).toBe(occurredAt.toISOString());
    expect(transport.events()[0]?.schema_version).toBe(2);
  });

  it("rejects cross-version payloads and does not expose trusted time on AnalyticsPort", () => {
    expect(() =>
      validateAnalyticsEnvelope(
        envelope("quote_submitted", 1, {
          authoring_mode: "PLATFORM_STRUCTURED",
          job_request_id: requestId,
          quote_id: quoteId,
          quote_revision: "1",
        }),
      ),
    ).toThrow(/properties/u);
    expect(() =>
      validateAnalyticsEnvelope(
        envelope("quote_submitted", 2, {
          job_request_id: requestId,
          quote_id: quoteId,
        }),
      ),
    ).toThrow(/properties/u);
    const analytics = createAnalytics({
      appVersion: "r3",
      environment: "staging",
      platform: "WEB",
      transport: createMemoryAnalyticsTransport("staging"),
    });
    expect(analytics).not.toHaveProperty("captureTrusted");
  });

  it("marks delivered only after provider success and retries the same event UUID", async () => {
    const lease = analyticsLease();
    const store = storeHarness(lease);
    const captureTrusted = vi
      .fn<TrustedAnalyticsPublisher["captureTrusted"]>()
      .mockResolvedValueOnce({
        event_id: lease.observation.event_id,
        reason: "TRANSPORT_UNAVAILABLE",
        status: "DROPPED",
      })
      .mockResolvedValueOnce({
        event_id: lease.observation.event_id,
        status: "DELIVERED",
      });
    const processor = createR3AnalyticsProcessor({
      backoffMs: () => 1000,
      leaseDurationMs: 30_000,
      now: () => occurredAt,
      publisher: { captureTrusted, readiness: () => ({ status: "ACTIVE" }) },
      store,
    });
    await expect(processor.processNext()).resolves.toMatchObject({
      eventId: lease.observation.event_id,
      status: "RETRY_SCHEDULED",
    });
    await expect(processor.processNext()).resolves.toMatchObject({
      eventId: lease.observation.event_id,
      status: "DELIVERED",
    });
    expect(captureTrusted.mock.calls[0]?.[0].event_id).toBe(
      captureTrusted.mock.calls[1]?.[0].event_id,
    );
    // Mock-method references are assertions, not detached production calls.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(store.retry).toHaveBeenCalledOnce();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(store.markDelivered).toHaveBeenCalledOnce();
  });

  it.each([
    ["INVALID_EVENT", "TERMINAL"],
    ["TRANSPORT_DISABLED", "TERMINAL"],
    ["TRANSPORT_MISCONFIGURED", "RETRY_SCHEDULED"],
  ] as const)(
    "classifies %s without changing business work",
    async (reason, status) => {
      const lease = analyticsLease();
      const store = storeHarness(lease);
      const processor = createR3AnalyticsProcessor({
        backoffMs: () => 1,
        leaseDurationMs: 1,
        now: () => occurredAt,
        publisher: {
          captureTrusted: vi.fn().mockResolvedValue({
            event_id: lease.observation.event_id,
            reason,
            status: "DROPPED",
          }),
          readiness: () => ({ status: "ACTIVE" }),
        },
        store,
      });
      await expect(processor.processNext()).resolves.toMatchObject({ status });
    },
  );

  it("validates the server observation target shape", () => {
    expect(() =>
      assertR3AnalyticsObservationInput({
        actorUserId: userId,
        commandId: randomUUID(),
        jobRequestId: requestId,
        kind: "QUOTE_COMPARISON_OPENED",
      }),
    ).not.toThrow();
    expect(() =>
      assertR3AnalyticsObservationInput({
        actorUserId: userId,
        commandId: randomUUID(),
        jobRequestId: requestId,
        kind: "QUOTE_VIEWED",
        quoteId,
      }),
    ).toThrow(/target shape/u);
    expect(() =>
      assertR3AnalyticsObservationInput({
        actorUserId: userId,
        commandId: randomUUID(),
        invitationId: randomUUID(),
        jobRequestId: requestId,
        kind: "INVITATION_VIEWED",
      }),
    ).not.toThrow();
    expect(() =>
      assertR3AnalyticsObservationInput({
        actorUserId: userId,
        commandId: randomUUID(),
        jobRequestId: requestId,
        kind: "UNKNOWN" as "QUOTE_VIEWED",
      }),
    ).toThrow(/kind/u);
  });

  it("accepts only bounded attachment count and type buckets", () => {
    expect(() =>
      validateAnalyticsEnvelope({
        ...envelope("quote_submitted", 1, {
          job_request_id: requestId,
          quote_id: quoteId,
        }),
        event_name: "conversation_attachment_ready",
        properties: {
          attachment_count_bucket: "FIVE_TO_TEN",
          attachment_type_bucket: "MIXED",
          conversation_id: randomUUID(),
        },
      }),
    ).not.toThrow();
    expect(() =>
      validateAnalyticsEnvelope({
        ...envelope("quote_submitted", 1, {
          job_request_id: requestId,
          quote_id: quoteId,
        }),
        event_name: "conversation_attachment_ready",
        properties: {
          attachment_count_bucket: 7,
          attachment_type_bucket: "application/pdf",
          conversation_id: randomUUID(),
        },
      }),
    ).toThrow(/attachment_count_bucket/u);
  });

  it("terminally records a malformed claimed source without calling transport", async () => {
    const store = storeHarness(analyticsLease());
    store.claimNext = vi.fn().mockResolvedValue({
      attempt: 1,
      eventId: randomUUID(),
      kind: "INVALID",
      leaseToken: randomUUID(),
    });
    const captureTrusted = vi.fn();
    const processor = createR3AnalyticsProcessor({
      backoffMs: () => 1,
      leaseDurationMs: 1000,
      now: () => occurredAt,
      publisher: { captureTrusted, readiness: () => ({ status: "ACTIVE" }) },
      store,
    });
    await expect(processor.processNext()).resolves.toMatchObject({
      status: "TERMINAL",
    });
    expect(captureTrusted).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(store.markTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "INVALID" }),
      "INVALID_EVENT",
      occurredAt,
    );
  });
});

function envelope(
  name: "job_request_submitted" | "quote_submitted",
  version: number,
  properties: object,
) {
  return {
    actor_context: {
      is_internal: false,
      is_test: false,
      profile_context: "CRAFTSMAN",
      user_id: userId,
    },
    app_version: "r3",
    environment: "staging",
    event_id: randomUUID(),
    event_name: name,
    event_source: "SERVER_DOMAIN",
    occurred_at: occurredAt.toISOString(),
    platform: "WEB",
    properties,
    schema_version: version,
  };
}

function analyticsLease(): R3AnalyticsLease {
  const eventId = randomUUID();
  return {
    attempt: 1,
    eventId,
    kind: "VALID",
    leaseToken: randomUUID(),
    observation: {
      event_id: eventId,
      event_name: "job_request_started",
      occurred_at: occurredAt,
      properties: { job_request_id: requestId },
      schema_version: 1,
      subject: { ...subject, profile_context: "CUSTOMER" },
    },
  };
}

function storeHarness(lease: R3AnalyticsLease): R3AnalyticsLeaseStore & {
  markDelivered: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
} {
  const claims = [lease, lease];
  return {
    claimNext: vi.fn(() => Promise.resolve(claims.shift())),
    markDelivered: vi.fn(() => Promise.resolve(true)),
    markTerminal: vi.fn(() => Promise.resolve(true)),
    retry: vi.fn(() => Promise.resolve(true)),
  };
}
