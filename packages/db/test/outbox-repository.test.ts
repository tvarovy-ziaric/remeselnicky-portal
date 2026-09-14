import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { defineDomainEvent } from "@portal/outbox";
import type { Sql } from "postgres";

import {
  createOutboxRepository,
  type OutboxDatabaseTransaction,
} from "../src/index.js";

const testEvent = defineDomainEvent({
  eventName: "test.completed",
  payloadKeys: ["outcome"] as const,
  schemaVersion: 1,
});

describe("outbox repository envelope validation", () => {
  it.each(["person@example.test", "Bearer eyJhbGciOiJIUzI1NiJ9"])(
    "rejects unsafe correlation ID before executing SQL: %s",
    async (correlationId) => {
      const transactionCall = vi.fn();
      const transaction = Object.assign(transactionCall, {
        json: vi.fn((value: unknown) => value),
      }) as unknown as OutboxDatabaseTransaction;
      const repository = createOutboxRepository(vi.fn() as unknown as Sql);
      const eventId = randomUUID();
      const event = testEvent.create({
        eventId,
        idempotencyKey: eventId,
        occurredAt: new Date(),
        payload: { outcome: "CREATED" },
      });

      await expect(
        repository.writer.collect(transaction, [event], {
          commandName: "test.complete",
          correlationId,
        }),
      ).rejects.toThrow(/opaque safe identifier/u);
      expect(transactionCall.mock.calls).toHaveLength(0);
    },
  );
});
