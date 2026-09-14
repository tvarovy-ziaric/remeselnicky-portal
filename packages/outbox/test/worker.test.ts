import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createOutboxWorker,
  defineDomainEvent,
  PermanentOutboxError,
  RetryableOutboxError,
  type OutboxDelivery,
  type OutboxDeliveryStore,
} from "../src/index.js";

const testEvent = defineDomainEvent({
  eventName: "test.completed",
  payloadKeys: ["entity_id"] as const,
  schemaVersion: 1,
});

function delivery(attempt = 1): OutboxDelivery {
  const eventId = randomUUID();
  return {
    attempt,
    commandName: "test.complete",
    correlationId: randomUUID(),
    event: testEvent.create({
      eventId,
      idempotencyKey: eventId,
      occurredAt: new Date("2026-09-14T12:00:00.000Z"),
      payload: { entity_id: randomUUID() },
    }),
    leaseToken: randomUUID(),
  };
}

function storeWith(item: OutboxDelivery): OutboxDeliveryStore & {
  markPublished: ReturnType<typeof vi.fn>;
  moveToTerminal: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
} {
  return {
    claimNext: vi.fn(() => Promise.resolve(item)),
    markPublished: vi.fn(() => Promise.resolve(true)),
    moveToTerminal: vi.fn(() => Promise.resolve(true)),
    retry: vi.fn(() => Promise.resolve(true)),
  };
}

describe("outbox worker", () => {
  it("publishes then conditionally acknowledges a leased event", async () => {
    const item = delivery();
    const store = storeWith(item);
    const publisher = { publish: vi.fn(() => Promise.resolve()) };
    const worker = createOutboxWorker({
      backoffMs: () => 1_000,
      leaseDurationMs: 30_000,
      maxAttempts: 5,
      now: () => new Date("2026-09-14T12:00:00.000Z"),
      publisher,
      store,
    });

    await expect(worker.processNext()).resolves.toEqual({
      eventId: item.event.eventId,
      status: "PUBLISHED",
    });
    expect(publisher.publish.mock.calls).toEqual([[item]]);
    expect(store.markPublished.mock.calls).toEqual([
      [item, new Date("2026-09-14T12:00:00.000Z")],
    ]);
  });

  it("schedules bounded retry and terminalizes exhausted delivery", async () => {
    const retryItem = delivery(2);
    const retryStore = storeWith(retryItem);
    const retryWorker = createOutboxWorker({
      backoffMs: () => 5_000,
      leaseDurationMs: 30_000,
      maxAttempts: 3,
      now: () => new Date("2026-09-14T12:00:00.000Z"),
      publisher: {
        publish: () => Promise.reject(new RetryableOutboxError("TIMEOUT")),
      },
      store: retryStore,
    });
    await expect(retryWorker.processNext()).resolves.toMatchObject({
      status: "RETRY_SCHEDULED",
    });
    expect(retryStore.retry.mock.calls).toEqual([
      [
        retryItem,
        {
          availableAt: new Date("2026-09-14T12:00:05.000Z"),
          errorCode: "TIMEOUT",
        },
      ],
    ]);

    const terminalItem = delivery(3);
    const terminalStore = storeWith(terminalItem);
    const terminalWorker = createOutboxWorker({
      backoffMs: () => 5_000,
      leaseDurationMs: 30_000,
      maxAttempts: 3,
      publisher: {
        publish: () => Promise.reject(new Error("sensitive detail")),
      },
      store: terminalStore,
    });
    await expect(terminalWorker.processNext()).resolves.toMatchObject({
      status: "TERMINAL_FAILURE",
    });
    expect(terminalStore.moveToTerminal.mock.calls).toEqual([
      [terminalItem, "UNEXPECTED", expect.any(Date)],
    ]);
  });

  it("terminalizes explicitly permanent failures without retry", async () => {
    const item = delivery();
    const store = storeWith(item);
    const worker = createOutboxWorker({
      backoffMs: () => 1,
      leaseDurationMs: 30_000,
      maxAttempts: 5,
      publisher: {
        publish: () => Promise.reject(new PermanentOutboxError("BAD_SCHEMA")),
      },
      store,
    });
    await expect(worker.processNext()).resolves.toMatchObject({
      status: "TERMINAL_FAILURE",
    });
    expect(store.retry.mock.calls).toHaveLength(0);
  });

  it("does not let telemetry failure change the published outcome", async () => {
    const item = delivery();
    const worker = createOutboxWorker({
      backoffMs: () => 1,
      leaseDurationMs: 30_000,
      maxAttempts: 5,
      publisher: { publish: () => Promise.resolve() },
      store: storeWith(item),
      telemetry: {
        record() {
          throw new Error("telemetry unavailable");
        },
      },
    });
    await expect(worker.processNext()).resolves.toMatchObject({
      status: "PUBLISHED",
    });
  });
});
