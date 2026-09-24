import type { PersistedDomainEvent } from "@portal/outbox";

import type { NotificationDraft } from "./model.js";

export const JOB_DISPUTE_NOTIFICATION_EVENT_NAMES = Object.freeze({
  adminAction: "job.dispute.admin_action",
  opened: "job.dispute.opened",
  partyAction: "job.dispute.party_action",
} as const);

export interface JobDisputeNotificationCopy {
  readonly body: string;
  readonly title: string;
}

const COPY = Object.freeze({
  [JOB_DISPUTE_NOTIFICATION_EVENT_NAMES.adminAction]: Object.freeze({
    body: "V súkromnom prípade pribudla administratívna požiadavka alebo zmena stavu. Podrobnosti nájdete v detaile zákazky.",
    title: "Aktualizácia sporného prípadu",
  }),
  [JOB_DISPUTE_NOTIFICATION_EVENT_NAMES.opened]: Object.freeze({
    body: "Druhá zmluvná strana otvorila súkromný prípad k zákazke. Pozrite si opis a požadované riešenie v detaile zákazky.",
    title: "Nový sporný prípad k zákazke",
  }),
  [JOB_DISPUTE_NOTIFICATION_EVENT_NAMES.partyAction]: Object.freeze({
    body: "Druhá zmluvná strana zaznamenala krok v súkromnom prípade. Podrobnosti nájdete v detaile zákazky.",
    title: "Krok strany v spornom prípade",
  }),
} as const);

export function getJobDisputeNotificationCopy(
  type: keyof typeof COPY,
): JobDisputeNotificationCopy {
  return COPY[type];
}

/** Maps only privacy-minimal case events; no case text enters outbox. */
export function mapJobDisputeNotificationEvent(
  event: PersistedDomainEvent,
): readonly NotificationDraft[] | undefined {
  if (
    event.name !== JOB_DISPUTE_NOTIFICATION_EVENT_NAMES.opened &&
    event.name !== JOB_DISPUTE_NOTIFICATION_EVENT_NAMES.adminAction &&
    event.name !== JOB_DISPUTE_NOTIFICATION_EVENT_NAMES.partyAction
  )
    return undefined;
  if (
    event.schemaVersion !== 1 ||
    event.entity?.type !== "DISPUTE_CASE" ||
    !isUuid(event.entity.id)
  )
    throw new TypeError("Invalid Job dispute notification envelope.");
  const isAdminAction =
    event.name === JOB_DISPUTE_NOTIFICATION_EVENT_NAMES.adminAction;
  const isPartyAction =
    event.name === JOB_DISPUTE_NOTIFICATION_EVENT_NAMES.partyAction;
  assertExactKeys(
    event.payload,
    isAdminAction || isPartyAction
      ? ["action", "dispute_id", "job_id", "recipient_user_id"]
      : ["dispute_id", "job_id", "recipient_user_id"],
  );
  const disputeId = requiredUuid(event.payload["dispute_id"], "dispute");
  const jobId = requiredUuid(event.payload["job_id"], "Job");
  const recipientUserId = requiredUuid(
    event.payload["recipient_user_id"],
    "recipient",
  );
  if (event.entity.id !== disputeId)
    throw new TypeError("Job dispute notification identity is incoherent.");
  const action = isAdminAction
    ? requiredAdminAction(event.payload["action"])
    : isPartyAction
      ? requiredPartyAction(event.payload["action"])
      : "OPEN";

  return Object.freeze([
    Object.freeze({
      channels: Object.freeze(["IN_APP"] as const),
      context: Object.freeze({
        entityId: disputeId,
        entityType: "DISPUTE_CASE",
        path: `/zakazky/${jobId}`,
      }),
      payload: Object.freeze({
        action: isAdminAction
          ? "READ_DISPUTE_ADMIN_ACTION"
          : isPartyAction
            ? "READ_DISPUTE_PARTY_ACTION"
            : "READ_DISPUTE_CASE",
        ...(isAdminAction || isPartyAction ? { case_action: action } : {}),
        dispute_id: disputeId,
        job_id: jobId,
      }),
      priority: "IMPORTANT" as const,
      recipientUserId,
      type: event.name,
    }),
  ]);
}

function requiredAdminAction(value: unknown): string {
  if (
    typeof value !== "string" ||
    ![
      "START_REVIEW",
      "REQUEST_INFORMATION",
      "RECORD_OUTCOME",
      "CLOSE",
      "REOPEN",
      "SET_INVESTIGATION_HOLD",
      "CLEAR_INVESTIGATION_HOLD",
    ].includes(value)
  )
    throw new TypeError("Job dispute admin action is invalid.");
  return value;
}

function requiredPartyAction(value: unknown): string {
  if (
    typeof value !== "string" ||
    !["WITHDRAW", "CONFIRM_SETTLEMENT"].includes(value)
  )
    throw new TypeError("Job dispute party action is invalid.");
  return value;
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
