import type { PersistedDomainEvent } from "@portal/outbox";

import type { NotificationDraft } from "./model.js";

export const JOB_SUPERVISOR_EVALUATION_NOTIFICATION_EVENT_NAMES = Object.freeze(
  {
    visible: "job.review.supervisor.visible",
  } as const,
);

export interface JobSupervisorEvaluationNotificationCopy {
  readonly body: string;
  readonly title: string;
}

const COPY = Object.freeze({
  [JOB_SUPERVISOR_EVALUATION_NOTIFICATION_EVENT_NAMES.visible]: Object.freeze({
    body: "Technické hodnotenie z dokončenej zákazky si môžete pozrieť v jej detaile.",
    title: "Nové technické hodnotenie",
  }),
} as const);

export function getJobSupervisorEvaluationNotificationCopy(
  type: keyof typeof COPY,
): JobSupervisorEvaluationNotificationCopy {
  return COPY[type];
}

/** Maps the first visible revision without copying ratings, comments or PII. */
export function mapJobSupervisorEvaluationNotificationEvent(
  event: PersistedDomainEvent,
): readonly NotificationDraft[] | undefined {
  if (event.name !== JOB_SUPERVISOR_EVALUATION_NOTIFICATION_EVENT_NAMES.visible)
    return undefined;
  if (
    event.schemaVersion !== 1 ||
    event.entity?.type !== "SUPERVISOR_EVALUATION" ||
    !isUuid(event.entity.id)
  )
    throw new TypeError("Invalid supervisor evaluation notification envelope.");
  assertExactKeys(event.payload, [
    "evaluation_id",
    "job_id",
    "recipient_user_id",
  ]);
  const evaluationId = requiredUuid(
    event.payload["evaluation_id"],
    "evaluation",
  );
  const jobId = requiredUuid(event.payload["job_id"], "Job");
  const recipientUserId = requiredUuid(
    event.payload["recipient_user_id"],
    "recipient",
  );
  if (event.entity.id !== evaluationId)
    throw new TypeError("Supervisor evaluation identity is incoherent.");

  return Object.freeze([
    Object.freeze({
      channels: Object.freeze(["IN_APP"] as const),
      context: Object.freeze({
        entityId: evaluationId,
        entityType: "SUPERVISOR_EVALUATION",
        path: `/zakazky/${jobId}/hodnotenia/odborne/${evaluationId}`,
      }),
      payload: Object.freeze({
        action: "READ_SUPERVISOR_EVALUATION",
        evaluation_id: evaluationId,
        job_id: jobId,
      }),
      priority: "INFO" as const,
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
    throw new TypeError(
      "Supervisor evaluation notification payload keys are invalid.",
    );
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
