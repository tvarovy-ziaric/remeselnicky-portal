import type { PersistedDomainEvent } from "@portal/outbox";

import type { NotificationDraft } from "./model.js";

export const JOB_INVITATION_NOTIFICATION_EVENT_NAMES = Object.freeze({
  expired: "job_invitation.expired",
  reminder: "job_invitation.expiry_reminder",
  sent: "job_invitation.sent",
} as const);

export interface JobInvitationReminderStore {
  /**
   * Durably captures at most one reminder event per pending invitation once
   * the offline-configured warning window opens.
   */
  enqueueDueReminders(): Promise<readonly string[]>;
}

/**
 * Maps only the explicit invitation event catalog. Unknown events are left for
 * other outbox consumers. Invalid known events fail closed in the publisher.
 */
export function mapJobInvitationNotificationEvent(
  event: PersistedDomainEvent,
): readonly NotificationDraft[] | undefined {
  if (
    !Object.values(JOB_INVITATION_NOTIFICATION_EVENT_NAMES).includes(
      event.name as (typeof JOB_INVITATION_NOTIFICATION_EVENT_NAMES)[keyof typeof JOB_INVITATION_NOTIFICATION_EVENT_NAMES],
    )
  ) {
    return undefined;
  }
  if (
    event.schemaVersion !== 1 ||
    event.entity?.type !== "JOB_INVITATION" ||
    !isUuid(event.entity.id)
  ) {
    throw new TypeError("Invalid job invitation notification event envelope.");
  }

  const recipientUserId = requiredUuid(event.payload["recipient_user_id"]);
  const invitationRevision = requiredPositiveInteger(
    event.payload["invitation_revision"],
  );
  const path = `/invitations/${event.entity.id}`;

  if (event.name === JOB_INVITATION_NOTIFICATION_EVENT_NAMES.sent) {
    return Object.freeze([
      invitationDraft({
        action: "RESPONSE_REQUIRED",
        channels: ["IN_APP", "EMAIL"],
        event,
        invitationRevision,
        path,
        priority: "IMPORTANT",
        recipientUserId,
        type: "job_invitation.received",
      }),
    ]);
  }
  if (event.name === JOB_INVITATION_NOTIFICATION_EVENT_NAMES.reminder) {
    requiredUtcTimestamp(event.payload["expires_at"]);
    return Object.freeze([
      invitationDraft({
        action: "RESPONSE_REQUIRED",
        channels: ["IN_APP", "EMAIL"],
        event,
        invitationRevision,
        path,
        priority: "IMPORTANT",
        recipientUserId,
        type: "job_invitation.expiry_reminder",
      }),
    ]);
  }

  return Object.freeze([
    invitationDraft({
      action: "NO_ACTION_REQUIRED",
      channels: ["IN_APP"],
      event,
      invitationRevision,
      path,
      priority: "INFO",
      recipientUserId,
      type: "job_invitation.expired",
    }),
  ]);
}

function invitationDraft(input: {
  readonly action: string;
  readonly channels: readonly ("EMAIL" | "IN_APP")[];
  readonly event: PersistedDomainEvent;
  readonly invitationRevision: number;
  readonly path: string;
  readonly priority: "IMPORTANT" | "INFO";
  readonly recipientUserId: string;
  readonly type: string;
}): NotificationDraft {
  return Object.freeze({
    channels: input.channels,
    context: Object.freeze({
      entityId: input.event.entity?.id ?? "invalid",
      entityRevision: input.invitationRevision,
      entityType: "JOB_INVITATION",
      path: input.path,
    }),
    payload: Object.freeze({
      action: input.action,
      invitation_revision: input.invitationRevision,
    }),
    priority: input.priority,
    recipientUserId: input.recipientUserId,
    type: input.type,
  });
}

function requiredUuid(value: unknown): string {
  if (typeof value !== "string" || !isUuid(value)) {
    throw new TypeError("Invitation notification recipient is invalid.");
  }
  return value;
}

function requiredPositiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError("Invitation notification revision is invalid.");
  }
  return value as number;
}

function requiredUtcTimestamp(value: unknown): void {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new TypeError("Invitation reminder expiry is invalid.");
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}
