import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  assertDomainEvent,
  defineDomainEvent,
  isDomainEvent,
} from "../src/index.js";

const quoteAccepted = defineDomainEvent({
  eventName: "quote.accepted",
  payloadKeys: ["job_id", "quote_revision", "actor_context"] as const,
  schemaVersion: 1,
});

describe("domain-event schema", () => {
  it("creates a stable privacy-minimal event envelope", () => {
    const event = quoteAccepted.create({
      entity: { id: randomUUID(), type: "QUOTE" },
      eventId: randomUUID(),
      idempotencyKey: "quote-accept:42",
      occurredAt: new Date("2026-09-14T12:00:00.000Z"),
      payload: {
        actor_context: "CUSTOMER",
        job_id: randomUUID(),
        quote_revision: 3,
      },
    });

    expect(isDomainEvent(event)).toBe(true);
    expect(() => assertDomainEvent(event)).not.toThrow();
    expect(event).toMatchObject({
      idempotencyKey: "quote-accept:42",
      name: "quote.accepted",
      schemaVersion: 1,
    });
  });

  it("rejects unknown keys, nested objects and oversized values", () => {
    const base = {
      eventId: randomUUID(),
      idempotencyKey: "quote-accept:42",
      occurredAt: new Date(),
    };

    expect(() =>
      quoteAccepted.create({
        ...base,
        payload: { email: "hidden@example.test" },
      } as Parameters<typeof quoteAccepted.create>[0]),
    ).toThrow(/not allowlisted/u);
    expect(() =>
      quoteAccepted.create({
        ...base,
        payload: { job_id: { whole: "business object" } },
      } as unknown as Parameters<typeof quoteAccepted.create>[0]),
    ).toThrow(/not content/u);
    expect(() =>
      quoteAccepted.create({
        ...base,
        payload: { job_id: "x".repeat(257) },
      }),
    ).toThrow(/machine scalars/u);
  });

  it("rejects PII, prose and token-like strings outside the payload too", () => {
    const base = {
      eventId: randomUUID(),
      occurredAt: new Date(),
    };
    expect(() =>
      quoteAccepted.create({
        ...base,
        idempotencyKey: "person@example.test",
        payload: {},
      }),
    ).toThrow(/opaque safe identifier/u);
    expect(() =>
      quoteAccepted.create({
        ...base,
        idempotencyKey: "Bearer eyJhbGciOiJIUzI1NiJ9",
        payload: {},
      }),
    ).toThrow(/opaque safe identifier/u);
    expect(() =>
      quoteAccepted.create({
        ...base,
        entity: { id: "owner@example.test", type: "QUOTE" },
        idempotencyKey: randomUUID(),
        payload: {},
      }),
    ).toThrow(/opaque safe identifier/u);
    expect(() =>
      quoteAccepted.create({
        ...base,
        idempotencyKey: randomUUID(),
        payload: { actor_context: "person@example.test" },
      }),
    ).toThrow(/machine scalars/u);
    expect(() =>
      quoteAccepted.create({
        ...base,
        idempotencyKey: randomUUID(),
        payload: { actor_context: "full sentence dumped here" },
      }),
    ).toThrow(/machine scalars/u);
  });

  it("rejects arbitrary lookalike events not created from a definition", () => {
    expect(() =>
      assertDomainEvent({
        eventId: randomUUID(),
        name: "quote.accepted",
        payload: {},
      }),
    ).toThrow(/explicit domain-event definition/u);
  });

  it("refuses common sensitive-content fields even when a caller lists them", () => {
    expect(() =>
      defineDomainEvent({
        eventName: "unsafe.event",
        payloadKeys: ["email", "exact_address", "message_text"],
        schemaVersion: 1,
      }),
    ).toThrow(/sensitive payload key is forbidden/u);
  });
});
