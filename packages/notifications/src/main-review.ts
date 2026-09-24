import type { PersistedDomainEvent } from "@portal/outbox";

import type { NotificationDraft } from "./model.js";

export const JOB_MAIN_REVIEW_NOTIFICATION_EVENT_NAMES = Object.freeze({
  invited: "job.review.main.invited",
  unlocked: "job.review.main.unlocked",
} as const);

export interface JobMainReviewNotificationCopy {
  readonly body: string;
  readonly title: string;
}

export interface JobMainReviewNotificationMaintenanceStore {
  /** Enqueues at most two exact unlock events per due one-sided Job. */
  enqueueDueDeadlineUnlocks(limit?: number): Promise<number>;
}

const COPY = Object.freeze({
  [JOB_MAIN_REVIEW_NOTIFICATION_EVENT_NAMES.invited]: Object.freeze({
    body: "Podeľte sa o svoju skúsenosť. Hodnotenie je dobrovoľné a nežiada konkrétnu známku.",
    title: "Ohodnoťte dokončenú zákazku",
  }),
  [JOB_MAIN_REVIEW_NOTIFICATION_EVENT_NAMES.unlocked]: Object.freeze({
    body: "Hodnotenia k dokončenej zákazke si teraz môžete pozrieť.",
    title: "Hodnotenia sú sprístupnené",
  }),
} as const);

/** Neutral Slovak presentation copy, kept separate from the private event. */
export function getJobMainReviewNotificationCopy(
  type: keyof typeof COPY,
): JobMainReviewNotificationCopy {
  return COPY[type];
}

export function mapJobMainReviewNotificationEvent(
  event: PersistedDomainEvent,
): readonly NotificationDraft[] | undefined {
  if (!isKnownEvent(event.name)) return undefined;
  if (
    event.schemaVersion !== 1 ||
    event.entity?.type !== "JOB" ||
    !isUuid(event.entity.id)
  ) {
    throw new TypeError("Invalid main review notification event envelope.");
  }
  const jobId = requiredUuid(event.payload["job_id"], "Job");
  const recipientUserId = requiredUuid(
    event.payload["recipient_user_id"],
    "recipient",
  );
  if (event.entity.id !== jobId) {
    throw new TypeError("Main review notification Job is incoherent.");
  }
  const direction = requiredDirection(event.payload["direction"]);
  const context = Object.freeze({
    entityId: jobId,
    entityType: "JOB",
    path: `/zakazky/${jobId}`,
  });

  if (event.name === JOB_MAIN_REVIEW_NOTIFICATION_EVENT_NAMES.invited) {
    assertExactKeys(event, [
      "direction",
      "job_id",
      "recipient_user_id",
      "submission_deadline_epoch",
    ]);
    const deadlineEpoch = requiredPositiveInteger(
      event.payload["submission_deadline_epoch"],
      "review deadline",
    );
    return one({
      channels: ["IN_APP", "EMAIL"],
      context,
      payload: Object.freeze({
        action: "WRITE_MAIN_REVIEW",
        deadline_epoch: deadlineEpoch,
        direction,
      }),
      priority: "IMPORTANT",
      recipientUserId,
      type: event.name,
    });
  }

  assertExactKeys(event, [
    "direction",
    "job_id",
    "recipient_user_id",
    "unlock_cause",
  ]);
  const unlockCause = event.payload["unlock_cause"];
  if (unlockCause !== "RECIPROCAL" && unlockCause !== "DEADLINE") {
    throw new TypeError("Main review unlock cause is invalid.");
  }
  return one({
    channels: ["IN_APP"],
    context,
    payload: Object.freeze({
      action: "READ_MAIN_REVIEWS",
      direction,
      unlock_cause: unlockCause,
    }),
    priority: "INFO",
    recipientUserId,
    type: event.name,
  });
}

function one(draft: NotificationDraft): readonly NotificationDraft[] {
  return Object.freeze([Object.freeze(draft)]);
}

function assertExactKeys(
  event: PersistedDomainEvent,
  expected: readonly string[],
): void {
  const actual = Object.keys(event.payload).sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError("Main review notification payload keys are invalid.");
  }
}

function requiredDirection(
  value: unknown,
): "CUSTOMER_TO_PROVIDER" | "PROVIDER_TO_CUSTOMER" {
  if (value !== "CUSTOMER_TO_PROVIDER" && value !== "PROVIDER_TO_CUSTOMER") {
    throw new TypeError("Main review direction is invalid.");
  }
  return value;
}

function requiredPositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
  return value as number;
}

function requiredUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !isUuid(value)) {
    throw new TypeError(`${label} must be a UUID.`);
  }
  return value;
}

function isKnownEvent(name: string): name is keyof typeof COPY {
  return Object.hasOwn(COPY, name);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}
