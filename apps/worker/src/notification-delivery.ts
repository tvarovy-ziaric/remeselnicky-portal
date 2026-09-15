import type {
  JobInvitationPersistence,
  QuoteLifecycleMaintenancePersistence,
} from "@portal/domain";
import type {
  DemandSideNotificationMaintenanceStore,
  JobInvitationReminderStore,
} from "@portal/notifications";
import type { OutboxWorker } from "@portal/outbox";

import type { WorkerLoopProcessor } from "./service.js";

export const INVITATION_MAINTENANCE_INTERVAL_MS = 60_000;

/**
 * Runs database scheduling before delivery, then drains one durable outbox
 * event. It deliberately leaves EMAIL delivery rows queued until a production
 * provider adapter is configured.
 */
export function createInvitationNotificationProcessor(input: {
  readonly demandSideNotifications: DemandSideNotificationMaintenanceStore;
  readonly invitations: Pick<JobInvitationPersistence, "expirePending">;
  readonly maintenanceIntervalMs?: number;
  readonly now?: () => number;
  readonly outbox: OutboxWorker;
  readonly quotes: QuoteLifecycleMaintenancePersistence;
  readonly reminders: JobInvitationReminderStore;
}): WorkerLoopProcessor {
  const interval =
    input.maintenanceIntervalMs ?? INVITATION_MAINTENANCE_INTERVAL_MS;
  if (!Number.isSafeInteger(interval) || interval < 1) {
    throw new RangeError("maintenanceIntervalMs must be a positive integer");
  }
  const now = input.now ?? Date.now;
  let nextMaintenanceAt = 0;

  return Object.freeze({
    async processNext(): Promise<{ readonly status: string }> {
      const currentTime = now();
      if (!Number.isFinite(currentTime)) {
        throw new TypeError("worker clock must return a finite timestamp");
      }
      if (currentTime >= nextMaintenanceAt) {
        await input.reminders.enqueueDueReminders();
        await input.demandSideNotifications.enqueueDueUnreadChatEmails();
        await input.invitations.expirePending();
        await input.quotes.expireDueSubmitted();
        nextMaintenanceAt = currentTime + interval;
      }

      const result = await input.outbox.processNext();
      return Object.freeze({
        status: result.status === "IDLE" ? "idle" : "succeeded",
      });
    },
  });
}
