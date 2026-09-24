import type { PersistedDomainEvent } from "@portal/outbox";

import type { NotificationDraft, NotificationPriority } from "./model.js";

export const ALPHA_NOTIFICATION_EVENT_NAMES = Object.freeze({
  credentialApproved: "credential.approved",
  credentialRejected: "credential.rejected",
  credentialRevoked: "credential.revoked",
  jobConfirmed: "job.confirmed",
  moderationActionApplied: "moderation.action.applied",
  moderationAppealDecided: "moderation.appeal.decided",
  profileApproved: "profile.approved",
  profileRejected: "profile.rejected",
  reviewResponseCreated: "job.review.response.created",
} as const);

export function mapAlphaNotificationEvent(
  event: PersistedDomainEvent,
): readonly NotificationDraft[] | undefined {
  if (
    !Object.values(ALPHA_NOTIFICATION_EVENT_NAMES).includes(event.name as never)
  )
    return undefined;
  if (
    event.schemaVersion !== 1 ||
    event.entity === undefined ||
    !isUuid(event.entity.id)
  ) {
    throw new TypeError("Invalid alpha notification event envelope.");
  }
  const recipientUserId = requiredUuid(
    event.payload["recipient_user_id"],
    "recipient",
  );

  switch (event.name) {
    case ALPHA_NOTIFICATION_EVENT_NAMES.jobConfirmed:
      assertEvent(event, "JOB", ["job_id", "recipient_user_id"]);
      return one(
        event,
        recipientUserId,
        "JOB",
        `/zakazky/${event.entity.id}`,
        "IMPORTANT",
        {
          action: "OPEN_CONFIRMED_JOB",
        },
      );
    case ALPHA_NOTIFICATION_EVENT_NAMES.reviewResponseCreated: {
      assertEvent(event, "REVIEW_RESPONSE", [
        "job_id",
        "recipient_user_id",
        "response_id",
      ]);
      const jobId = requiredUuid(event.payload["job_id"], "Job");
      const responseId = requiredUuid(event.payload["response_id"], "response");
      if (responseId !== event.entity.id)
        throw new TypeError("Review response identity is incoherent.");
      return one(
        event,
        recipientUserId,
        "REVIEW_RESPONSE",
        `/zakazky/${jobId}`,
        "INFO",
        {
          action: "READ_REVIEW_RESPONSE",
          response_id: responseId,
        },
        ["IN_APP"],
      );
    }
    case ALPHA_NOTIFICATION_EVENT_NAMES.credentialApproved:
    case ALPHA_NOTIFICATION_EVENT_NAMES.credentialRejected:
    case ALPHA_NOTIFICATION_EVENT_NAMES.credentialRevoked: {
      assertEvent(event, "CREDENTIAL_CLAIM", [
        "claim_id",
        "decision",
        "reason_category",
        "recipient_user_id",
      ]);
      const claimId = requiredUuid(
        event.payload["claim_id"],
        "credential claim",
      );
      if (claimId !== event.entity.id)
        throw new TypeError("Credential claim identity is incoherent.");
      return one(
        event,
        recipientUserId,
        "CREDENTIAL_CLAIM",
        `/ucet/kvalifikacie/${claimId}`,
        event.name === ALPHA_NOTIFICATION_EVENT_NAMES.credentialApproved
          ? "IMPORTANT"
          : event.name === ALPHA_NOTIFICATION_EVENT_NAMES.credentialRevoked
            ? "CRITICAL"
            : "IMPORTANT",
        {
          action: "READ_CREDENTIAL_DECISION",
          decision: requiredCode(event.payload["decision"]),
          reason_category: requiredNullableCode(
            event.payload["reason_category"],
          ),
        },
      );
    }
    case ALPHA_NOTIFICATION_EVENT_NAMES.profileApproved:
    case ALPHA_NOTIFICATION_EVENT_NAMES.profileRejected:
      assertEvent(event, "CRAFTSMAN_PROFILE", [
        "decision",
        "profile_id",
        "reason_code",
        "recipient_user_id",
      ]);
      if (
        requiredUuid(event.payload["profile_id"], "profile") !== event.entity.id
      )
        throw new TypeError("Profile identity is incoherent.");
      return one(
        event,
        recipientUserId,
        "CRAFTSMAN_PROFILE",
        "/ucet/profil",
        "IMPORTANT",
        {
          action: "READ_PROFILE_DECISION",
          decision: requiredCode(event.payload["decision"]),
          reason_code: requiredNullableCode(event.payload["reason_code"]),
        },
      );
    case ALPHA_NOTIFICATION_EVENT_NAMES.moderationActionApplied: {
      assertEvent(event, "MODERATION_ACTION", [
        "action",
        "action_id",
        "general_reason_category",
        "recipient_user_id",
      ]);
      const actionId = requiredUuid(
        event.payload["action_id"],
        "moderation action",
      );
      if (actionId !== event.entity.id)
        throw new TypeError("Moderation action identity is incoherent.");
      const action = requiredCode(event.payload["action"]);
      const critical =
        action === "APPLY_FEATURE_RESTRICTION" ||
        action === "APPLY_TEMPORARY_SUSPENSION" ||
        action === "APPLY_INDEFINITE_SUSPENSION";
      return one(
        event,
        recipientUserId,
        "MODERATION_ACTION",
        "/ucet/moderacia",
        critical ? "CRITICAL" : "IMPORTANT",
        {
          action,
          action_id: actionId,
          general_reason_category: requiredCode(
            event.payload["general_reason_category"],
          ),
        },
      );
    }
    case ALPHA_NOTIFICATION_EVENT_NAMES.moderationAppealDecided: {
      assertEvent(event, "MODERATION_APPEAL", [
        "appeal_id",
        "decision",
        "recipient_user_id",
      ]);
      const appealId = requiredUuid(
        event.payload["appeal_id"],
        "moderation appeal",
      );
      if (appealId !== event.entity.id)
        throw new TypeError("Moderation appeal identity is incoherent.");
      return one(
        event,
        recipientUserId,
        "MODERATION_APPEAL",
        "/ucet/moderacia",
        "IMPORTANT",
        {
          action: "READ_APPEAL_DECISION",
          appeal_id: appealId,
          decision: requiredCode(event.payload["decision"]),
        },
      );
    }
    default:
      throw new TypeError(
        `Unsupported alpha notification event: ${event.name}`,
      );
  }
}

function one(
  event: PersistedDomainEvent & {
    readonly entity?: { readonly id: string; readonly type: string };
  },
  recipientUserId: string,
  entityType: string,
  path: string,
  priority: NotificationPriority,
  payload: NotificationDraft["payload"],
  channels: readonly ("IN_APP" | "EMAIL")[] = ["IN_APP", "EMAIL"],
): readonly NotificationDraft[] {
  return Object.freeze([
    Object.freeze({
      channels: Object.freeze([...channels]),
      context: Object.freeze({
        entityId: event.entity?.id ?? "invalid",
        entityType,
        path,
      }),
      payload: Object.freeze({ ...payload }),
      priority,
      recipientUserId,
      type: event.name,
    }),
  ]);
}

function assertEvent(
  event: PersistedDomainEvent,
  entityType: string,
  keys: readonly string[],
): void {
  if (event.entity?.type !== entityType)
    throw new TypeError(`Invalid ${entityType} notification entity.`);
  const actual = Object.keys(event.payload).sort();
  if (
    actual.length !== keys.length ||
    actual.some((key, index) => key !== keys[index])
  ) {
    throw new TypeError("Alpha notification payload keys are invalid.");
  }
}

function requiredUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !isUuid(value))
    throw new TypeError(`${label} must be a UUID.`);
  return value;
}
function requiredCode(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Z][A-Z0-9_]{1,79}$/u.test(value))
    throw new TypeError("Notification code is invalid.");
  return value;
}
function requiredNullableCode(value: unknown): string | null {
  return value === null ? null : requiredCode(value);
}
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}
