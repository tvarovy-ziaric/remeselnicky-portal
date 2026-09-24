import type { PersistedDomainEvent } from "@portal/outbox";

import type { NotificationDraft } from "./model.js";

export const JOB_DISPUTE_NOTIFICATION_EVENT_NAMES = Object.freeze({
  opened: "job.dispute.opened",
} as const);

export interface JobDisputeNotificationCopy {
  readonly body: string;
  readonly title: string;
}

const COPY = Object.freeze({
  [JOB_DISPUTE_NOTIFICATION_EVENT_NAMES.opened]: Object.freeze({
    body: "Druhá zmluvná strana otvorila súkromný prípad k zákazke. Pozrite si opis a požadované riešenie v detaile zákazky.",
    title: "Nový sporný prípad k zákazke",
  }),
} as const);

export function getJobDisputeNotificationCopy(
  type: keyof typeof COPY,
): JobDisputeNotificationCopy {
  return COPY[type];
}

/** Maps only the privacy-minimal case-open event; no case text enters outbox. */
export function mapJobDisputeNotificationEvent(
  event: PersistedDomainEvent,
): readonly NotificationDraft[] | undefined {
  if (event.name !== JOB_DISPUTE_NOTIFICATION_EVENT_NAMES.opened)
    return undefined;
  if (
    event.schemaVersion !== 1 ||
    event.entity?.type !== "DISPUTE_CASE" ||
    !isUuid(event.entity.id)
  )
    throw new TypeError("Invalid Job dispute notification envelope.");
  assertExactKeys(event.payload, ["dispute_id", "job_id", "recipient_user_id"]);
  const disputeId = requiredUuid(event.payload["dispute_id"], "dispute");
  const jobId = requiredUuid(event.payload["job_id"], "Job");
  const recipientUserId = requiredUuid(
    event.payload["recipient_user_id"],
    "recipient",
  );
  if (event.entity.id !== disputeId)
    throw new TypeError("Job dispute notification identity is incoherent.");

  return Object.freeze([
    Object.freeze({
      channels: Object.freeze(["IN_APP"] as const),
      context: Object.freeze({
        entityId: disputeId,
        entityType: "DISPUTE_CASE",
        path: `/zakazky/${jobId}`,
      }),
      payload: Object.freeze({
        action: "READ_DISPUTE_CASE",
        dispute_id: disputeId,
        job_id: jobId,
      }),
      priority: "IMPORTANT" as const,
      recipientUserId,
      type: event.name,
    }),
  ]);
}

function assertExactKeys(
  payload: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): void {
  const actual = Object.keys(payload).sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  )
    throw new TypeError("Job dispute notification payload keys are invalid.");
}

function requiredUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !isUuid(value))
    throw new TypeError(`${label} must be a UUID.`);
  return value;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}
