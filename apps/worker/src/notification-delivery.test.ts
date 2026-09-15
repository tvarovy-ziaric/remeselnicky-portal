import { describe, expect, it, vi } from "vitest";
import type { OutboxWorker } from "@portal/outbox";

import { createInvitationNotificationProcessor } from "./notification-delivery.js";

describe("invitation notification processor", () => {
  it("schedules reminders before expiry and drains the durable outbox", async () => {
    const enqueueDueReminders = vi.fn(() => Promise.resolve([]));
    const enqueueDueUnreadChatEmails = vi.fn(() => Promise.resolve(0));
    const expirePending = vi.fn(() => Promise.resolve([]));
    const expireDueSubmitted = vi.fn(() => Promise.resolve([]));
    const results: Awaited<ReturnType<OutboxWorker["processNext"]>>[] = [
      { eventId: crypto.randomUUID(), status: "PUBLISHED" },
      { status: "IDLE" },
    ];
    const processNext = vi.fn<OutboxWorker["processNext"]>(() =>
      Promise.resolve(results.shift() ?? { status: "IDLE" }),
    );
    const processAnalytics = vi
      .fn()
      .mockResolvedValueOnce({
        eventId: crypto.randomUUID(),
        status: "DELIVERED",
      })
      .mockResolvedValueOnce({ status: "IDLE" });
    let currentTime = 1_000;
    const processor = createInvitationNotificationProcessor({
      analytics: { processNext: processAnalytics },
      demandSideNotifications: { enqueueDueUnreadChatEmails },
      invitations: { expirePending },
      maintenanceIntervalMs: 60_000,
      now: () => currentTime,
      outbox: { processNext },
      quotes: { expireDueSubmitted },
      reminders: { enqueueDueReminders },
    });

    await expect(processor.processNext()).resolves.toEqual({
      status: "succeeded",
    });
    currentTime += 1_000;
    await expect(processor.processNext()).resolves.toEqual({ status: "idle" });
    expect(enqueueDueReminders).toHaveBeenCalledTimes(1);
    expect(enqueueDueUnreadChatEmails).toHaveBeenCalledTimes(1);
    expect(expirePending).toHaveBeenCalledTimes(1);
    expect(expireDueSubmitted).toHaveBeenCalledTimes(1);
    expect(processNext).toHaveBeenCalledTimes(2);
    expect(processAnalytics).toHaveBeenCalledTimes(2);
  });

  it("reruns maintenance after the bounded interval and fails closed on errors", async () => {
    const enqueueDueReminders = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("DATABASE_UNAVAILABLE"));
    const expirePending = vi.fn(() => Promise.resolve([]));
    const enqueueDueUnreadChatEmails = vi.fn(() => Promise.resolve(0));
    const expireDueSubmitted = vi.fn(() => Promise.resolve([]));
    const processNext = vi.fn<OutboxWorker["processNext"]>(() =>
      Promise.resolve({ status: "IDLE" }),
    );
    let currentTime = 1;
    const processor = createInvitationNotificationProcessor({
      demandSideNotifications: { enqueueDueUnreadChatEmails },
      invitations: { expirePending },
      maintenanceIntervalMs: 10,
      now: () => currentTime,
      outbox: { processNext },
      quotes: { expireDueSubmitted },
      reminders: { enqueueDueReminders },
    });
    await processor.processNext();
    currentTime = 11;
    await expect(processor.processNext()).rejects.toThrow(
      "DATABASE_UNAVAILABLE",
    );
    expect(processNext).toHaveBeenCalledTimes(1);
  });

  it("never lets analytics failure interrupt notification delivery", async () => {
    const onAnalyticsError = vi.fn();
    const processOutbox = vi.fn().mockResolvedValue({
      eventId: crypto.randomUUID(),
      status: "PUBLISHED",
    });
    const processor = createInvitationNotificationProcessor({
      analytics: { processNext: vi.fn().mockRejectedValue(new Error("db")) },
      demandSideNotifications: {
        enqueueDueUnreadChatEmails: vi.fn().mockResolvedValue(0),
      },
      invitations: { expirePending: vi.fn().mockResolvedValue([]) },
      now: () => 1,
      onAnalyticsError,
      outbox: { processNext: processOutbox },
      quotes: { expireDueSubmitted: vi.fn().mockResolvedValue([]) },
      reminders: { enqueueDueReminders: vi.fn().mockResolvedValue([]) },
    });
    await expect(processor.processNext()).resolves.toEqual({
      status: "succeeded",
    });
    await expect(processor.processNext()).resolves.toEqual({
      status: "succeeded",
    });
    expect(processOutbox).toHaveBeenCalledTimes(2);
    expect(onAnalyticsError).toHaveBeenCalledTimes(2);
  });
});
