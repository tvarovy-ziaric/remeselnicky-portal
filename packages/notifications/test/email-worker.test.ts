import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createNotificationEmailWorker,
  createUnavailableEmailAdapter,
  RetryableEmailDeliveryError,
  type EmailDelivery,
  type EmailDeliveryStore,
  type TransactionalEmailRequest,
} from "../src/index.js";

function delivery(attempt = 1): EmailDelivery {
  return {
    attempt,
    context: {
      entityId: randomUUID(),
      entityRevision: 2,
      entityType: "CHANGE_ORDER",
      path: `/changes/${randomUUID()}/revisions/2`,
    },
    deliveryId: randomUUID(),
    idempotencyKey: `${randomUUID()}:${randomUUID()}:change_order.proposed:EMAIL`,
    leaseToken: randomUUID(),
    notificationId: randomUUID(),
    notificationType: "change_order.proposed",
    priority: "IMPORTANT",
    recipientUserId: randomUUID(),
  };
}

function storeWith(item: EmailDelivery): EmailDeliveryStore & {
  markEmailDelivered: ReturnType<typeof vi.fn>;
  markEmailSent: ReturnType<typeof vi.fn>;
  retryEmail: ReturnType<typeof vi.fn>;
  terminalizeEmail: ReturnType<typeof vi.fn>;
} {
  return {
    claimNextEmail: vi.fn(() => Promise.resolve(item)),
    markEmailDelivered: vi.fn(() => Promise.resolve(true)),
    markEmailSent: vi.fn(() => Promise.resolve(true)),
    retryEmail: vi.fn(() => Promise.resolve(true)),
    terminalizeEmail: vi.fn(() => Promise.resolve(true)),
  };
}

describe("notification email worker", () => {
  it("reuses the persisted idempotency key and records SENT", async () => {
    const item = delivery();
    const store = storeWith(item);
    const deliver = vi.fn((request: TransactionalEmailRequest) => {
      void request;
      return Promise.resolve({
        providerMessageReference: "provider-message-1",
        status: "SENT" as const,
      });
    });
    const worker = createNotificationEmailWorker({
      adapter: { deliver },
      backoffMs: () => 1_000,
      leaseDurationMs: 30_000,
      maxAttempts: 5,
      now: () => new Date("2026-09-14T12:00:00.000Z"),
      store,
    });

    await expect(worker.processNext()).resolves.toEqual({
      deliveryId: item.deliveryId,
      status: "SENT",
    });
    expect(deliver.mock.calls[0]?.[0]).toMatchObject({
      idempotencyKey: item.idempotencyKey,
      recipientUserId: item.recipientUserId,
    });
    expect(deliver.mock.calls[0]?.[0]).not.toHaveProperty("payload");
    expect(store.markEmailSent.mock.calls).toHaveLength(1);
  });

  it("schedules retry and terminalizes retry exhaustion", async () => {
    const retryItem = delivery(2);
    const retryStore = storeWith(retryItem);
    const retryWorker = createNotificationEmailWorker({
      adapter: {
        deliver: () =>
          Promise.reject(new RetryableEmailDeliveryError("TIMEOUT")),
      },
      backoffMs: () => 5_000,
      leaseDurationMs: 30_000,
      maxAttempts: 3,
      now: () => new Date("2026-09-14T12:00:00.000Z"),
      store: retryStore,
    });
    await expect(retryWorker.processNext()).resolves.toMatchObject({
      status: "RETRY_SCHEDULED",
    });
    expect(retryStore.retryEmail.mock.calls[0]?.[1]).toEqual({
      availableAt: new Date("2026-09-14T12:00:05.000Z"),
      errorCode: "TIMEOUT",
    });

    const terminalItem = delivery(3);
    const terminalStore = storeWith(terminalItem);
    const terminalWorker = createNotificationEmailWorker({
      adapter: {
        deliver: () =>
          Promise.reject(new RetryableEmailDeliveryError("TIMEOUT")),
      },
      backoffMs: () => 5_000,
      leaseDurationMs: 30_000,
      maxAttempts: 3,
      store: terminalStore,
    });
    await expect(terminalWorker.processNext()).resolves.toMatchObject({
      status: "TERMINAL_FAILURE",
    });
  });

  it("makes an unconfigured provider a visible terminal failure", async () => {
    const item = delivery();
    const store = storeWith(item);
    const telemetry = { record: vi.fn() };
    const worker = createNotificationEmailWorker({
      adapter: createUnavailableEmailAdapter(),
      backoffMs: () => 1_000,
      leaseDurationMs: 30_000,
      maxAttempts: 5,
      store,
      telemetry,
    });

    await expect(worker.processNext()).resolves.toMatchObject({
      status: "TERMINAL_FAILURE",
    });
    expect(store.terminalizeEmail.mock.calls[0]?.[1]).toMatchObject({
      errorCode: "EMAIL_PROVIDER_UNAVAILABLE",
    });
    expect(telemetry.record.mock.calls[0]?.[0]).not.toHaveProperty(
      "recipientUserId",
    );
  });
});
