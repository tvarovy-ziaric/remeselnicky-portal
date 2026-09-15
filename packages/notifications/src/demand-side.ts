import type { PersistedDomainEvent } from "@portal/outbox";

import {
  JOB_INVITATION_NOTIFICATION_EVENT_NAMES,
  mapJobInvitationNotificationEvent,
} from "./job-invitation.js";
import type { NotificationDraft } from "./model.js";

export const DEMAND_SIDE_EXTENSION_EVENT_NAMES = Object.freeze({
  conversationMessageCreated: "conversation.message_created",
  invitationDeclined: "job_invitation.declined",
  invitationEngaged: "job_invitation.engaged",
  invitationNotSelected: "job_invitation.not_selected",
  invitationRequestClosed: "job_invitation.request_closed",
  invitationWithdrawnByCustomer: "job_invitation.withdrawn_by_customer",
  invitationWithdrawnByProvider: "job_invitation.withdrawn_by_provider",
  jobRequestMateriallyUpdated: "job_request.materially_updated",
  quoteExpired: "quote.expired",
  quoteRejected: "quote.rejected",
  quoteRevised: "quote.revised",
  quoteSubmitted: "quote.submitted",
  quoteWithdrawn: "quote.withdrawn",
} as const);

export const DEMAND_SIDE_NOTIFICATION_EVENT_NAMES = Object.freeze({
  ...JOB_INVITATION_NOTIFICATION_EVENT_NAMES,
  ...DEMAND_SIDE_EXTENSION_EVENT_NAMES,
} as const);

type Channels = readonly ("EMAIL" | "IN_APP")[];
type Priority = "IMPORTANT" | "INFO";

export interface DemandSideNotificationMaintenanceStore {
  /**
   * Adds at most one generic EMAIL delivery per due unmuted conversation
   * burst. Current DB mute/read-through facts remain authoritative.
   */
  enqueueDueUnreadChatEmails(): Promise<number>;
}

/**
 * Complete R3 notification mapper. Known malformed events fail closed while
 * unrelated events remain available to other outbox consumers.
 */
export function mapDemandSideNotificationEvent(
  event: PersistedDomainEvent,
): readonly NotificationDraft[] | undefined {
  const invitation = mapJobInvitationNotificationEvent(event);
  const extensionOwned = isKnownDemandSideEvent(event.name);
  if (invitation !== undefined && extensionOwned) {
    throw new TypeError("Notification event catalog ownership collision.");
  }
  if (invitation !== undefined) return invitation;

  if (!extensionOwned) return undefined;
  if (event.schemaVersion !== 1 || event.entity === undefined) {
    throw new TypeError("Invalid demand-side notification event envelope.");
  }
  assertDemandSidePayloadKeys(event);

  const recipientUserId = requiredUuid(
    event.payload["recipient_user_id"],
    "recipient",
  );

  switch (event.name) {
    case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.invitationEngaged:
      return one(
        event,
        recipientUserId,
        invitationContext(event, "PROVIDER_ENGAGED"),
        "job_invitation.provider_engaged",
        "IMPORTANT",
        ["IN_APP", "EMAIL"],
      );
    case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.invitationDeclined:
      return one(
        event,
        recipientUserId,
        invitationContext(event, "NO_ACTION_REQUIRED"),
        "job_invitation.provider_declined",
        "INFO",
        ["IN_APP"],
      );
    case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.invitationWithdrawnByCustomer:
      return one(
        event,
        recipientUserId,
        invitationContext(event, "CANDIDACY_CLOSED"),
        "job_invitation.withdrawn_by_customer",
        "INFO",
        ["IN_APP"],
      );
    case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.invitationWithdrawnByProvider:
      return one(
        event,
        recipientUserId,
        invitationContext(event, "CANDIDACY_CLOSED"),
        "job_invitation.withdrawn_by_provider",
        "INFO",
        ["IN_APP"],
      );
    case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.invitationRequestClosed:
      return one(
        event,
        recipientUserId,
        invitationContext(event, "REQUEST_CLOSED"),
        "job_invitation.request_closed",
        "INFO",
        ["IN_APP"],
      );
    case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.invitationNotSelected:
      return one(
        event,
        recipientUserId,
        invitationContext(event, "NO_ACTION_REQUIRED"),
        "job_invitation.not_selected",
        "INFO",
        ["IN_APP"],
      );
    case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.conversationMessageCreated:
      return mapConversationMessage(event, recipientUserId);
    case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobRequestMateriallyUpdated:
      return mapMaterialUpdate(event, recipientUserId);
    case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.quoteSubmitted:
      return mapQuote(
        event,
        recipientUserId,
        "quote.submitted",
        "REVIEW_QUOTE",
        "IMPORTANT",
        ["IN_APP", "EMAIL"],
        "CUSTOMER",
        "COMPARISON",
      );
    case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.quoteRevised:
      return mapQuote(
        event,
        recipientUserId,
        "quote.revised",
        "REVIEW_QUOTE_REVISION",
        "IMPORTANT",
        ["IN_APP", "EMAIL"],
        "CUSTOMER",
        "COMPARISON",
      );
    case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.quoteRejected:
      return mapQuote(
        event,
        recipientUserId,
        "quote.rejected",
        "REVIEW_REJECTION",
        "INFO",
        ["IN_APP"],
        "PROVIDER",
        "CONVERSATION",
      );
    case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.quoteWithdrawn:
      return mapQuote(
        event,
        recipientUserId,
        "quote.withdrawn",
        "NO_ACTION_REQUIRED",
        "INFO",
        ["IN_APP"],
        "CUSTOMER",
        "CONVERSATION",
      );
    case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.quoteExpired:
      return mapQuote(
        event,
        recipientUserId,
        "quote.expired",
        "NO_ACTION_REQUIRED",
        "INFO",
        ["IN_APP"],
        undefined,
        "CONVERSATION",
      );
    default:
      throw new TypeError(`Unsupported demand-side event: ${event.name}`);
  }
}

function invitationContext(
  event: PersistedDomainEvent,
  action: string,
): DraftParts {
  assertEntity(event, "JOB_INVITATION");
  const invitationRevision = requiredPositiveInteger(
    event.payload["invitation_revision"],
    "invitation revision",
  );
  return {
    context: {
      entityId: event.entity.id,
      entityRevision: invitationRevision,
      entityType: "JOB_INVITATION",
      path: `/invitations/${event.entity.id}`,
    },
    payload: { action, invitation_revision: invitationRevision },
  };
}

function mapConversationMessage(
  event: PersistedDomainEvent,
  recipientUserId: string,
): readonly NotificationDraft[] {
  assertEntity(event, "CONVERSATION");
  const sequence = requiredPositiveInteger(
    event.payload["conversation_sequence"],
    "conversation sequence",
  );
  const invitationId = requiredUuid(
    event.payload["invitation_id"],
    "invitation",
  );
  return one(
    event,
    recipientUserId,
    {
      context: {
        entityId: event.entity.id,
        entityRevision: sequence,
        entityType: "CONVERSATION",
        path: `/konverzacie/pozvanka/${invitationId}`,
      },
      payload: { action: "OPEN_CONVERSATION", conversation_sequence: sequence },
    },
    "conversation.message_received",
    "INFO",
    ["IN_APP"],
  );
}

function mapMaterialUpdate(
  event: PersistedDomainEvent,
  recipientUserId: string,
): readonly NotificationDraft[] {
  assertEntity(event, "JOB_REQUEST");
  const visibleVersion = requiredPositiveInteger(
    event.payload["request_visible_version"],
    "request visible version",
  );
  const contentRevision = requiredPositiveInteger(
    event.payload["request_content_revision"],
    "request content revision",
  );
  const invitationId = requiredUuid(
    event.payload["invitation_id"],
    "invitation",
  );
  return one(
    event,
    recipientUserId,
    {
      context: {
        entityId: event.entity.id,
        entityRevision: contentRevision,
        entityType: "JOB_REQUEST",
        path: `/invitations/${invitationId}/verzie/${contentRevision}`,
      },
      payload: {
        action: "REVIEW_MATERIAL_UPDATE",
        request_content_revision: contentRevision,
        request_visible_version: visibleVersion,
      },
    },
    "job_request.materially_updated",
    "IMPORTANT",
    ["IN_APP", "EMAIL"],
  );
}

function mapQuote(
  event: PersistedDomainEvent,
  recipientUserId: string,
  type: string,
  action: string,
  priority: Priority,
  channels: Channels,
  expectedAudience: "CUSTOMER" | "PROVIDER" | undefined,
  destination: "COMPARISON" | "CONVERSATION",
): readonly NotificationDraft[] {
  assertEntity(event, "QUOTE");
  const audience = requiredQuoteAudience(event.payload["recipient_audience"]);
  if (expectedAudience !== undefined && audience !== expectedAudience) {
    throw new TypeError("Quote notification audience is incoherent.");
  }
  const quoteRevision = requiredPositiveInteger(
    event.payload["quote_revision"],
    "Quote revision",
  );
  const invitationId = requiredUuid(
    event.payload["invitation_id"],
    "invitation",
  );
  const jobRequestId = requiredUuid(
    event.payload["job_request_id"],
    "JobRequest",
  );
  const path =
    destination === "COMPARISON"
      ? `/ziadosti/${jobRequestId}/ponuky`
      : `/konverzacie/pozvanka/${invitationId}`;
  return one(
    event,
    recipientUserId,
    {
      context: {
        entityId: event.entity.id,
        entityRevision: quoteRevision,
        entityType: "QUOTE",
        path,
      },
      payload: { action, quote_revision: quoteRevision },
    },
    type,
    priority,
    channels,
  );
}

function requiredQuoteAudience(value: unknown): "CUSTOMER" | "PROVIDER" {
  if (value !== "CUSTOMER" && value !== "PROVIDER") {
    throw new TypeError("Quote notification audience is invalid.");
  }
  return value;
}

function assertDemandSidePayloadKeys(event: PersistedDomainEvent): void {
  const invitationKeys = ["invitation_revision", "recipient_user_id"];
  const expected = (() => {
    switch (event.name) {
      case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.invitationDeclined:
      case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.invitationEngaged:
      case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.invitationNotSelected:
      case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.invitationRequestClosed:
      case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.invitationWithdrawnByCustomer:
      case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.invitationWithdrawnByProvider:
        return invitationKeys;
      case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.conversationMessageCreated:
        return ["conversation_sequence", "invitation_id", "recipient_user_id"];
      case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobRequestMateriallyUpdated:
        return [
          "invitation_id",
          "recipient_user_id",
          "request_content_revision",
          "request_visible_version",
        ];
      case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.quoteExpired:
      case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.quoteRejected:
      case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.quoteRevised:
      case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.quoteSubmitted:
      case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.quoteWithdrawn:
        return [
          "invitation_id",
          "job_request_id",
          "quote_revision",
          "recipient_audience",
          "recipient_user_id",
        ];
      default:
        throw new TypeError("Unsupported demand-side event payload.");
    }
  })();
  const actual = Object.keys(event.payload).sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError("Demand-side notification payload keys are invalid.");
  }
}

interface DraftParts {
  readonly context: NotificationDraft["context"];
  readonly payload: NotificationDraft["payload"];
}

function one(
  _event: PersistedDomainEvent,
  recipientUserId: string,
  parts: DraftParts,
  type: string,
  priority: Priority,
  channels: Channels,
): readonly NotificationDraft[] {
  return Object.freeze([
    Object.freeze({
      channels: Object.freeze([...channels]),
      context: Object.freeze({ ...parts.context }),
      payload: Object.freeze({ ...parts.payload }),
      priority,
      recipientUserId,
      type,
    }),
  ]);
}

function assertEntity(
  event: PersistedDomainEvent,
  expected: string,
): asserts event is PersistedDomainEvent & {
  readonly entity: { readonly id: string; readonly type: string };
} {
  if (event.entity?.type !== expected || !isUuid(event.entity.id)) {
    throw new TypeError(`Invalid ${expected} notification entity.`);
  }
}

function requiredUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !isUuid(value)) {
    throw new TypeError(`${label} must be a UUID.`);
  }
  return value;
}

function requiredPositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
  return value as number;
}

function isKnownDemandSideEvent(name: string): boolean {
  return [
    DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.conversationMessageCreated,
    DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.invitationDeclined,
    DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.invitationEngaged,
    DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.invitationNotSelected,
    DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.invitationRequestClosed,
    DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.invitationWithdrawnByCustomer,
    DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.invitationWithdrawnByProvider,
    DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobRequestMateriallyUpdated,
    DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.quoteExpired,
    DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.quoteRejected,
    DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.quoteRevised,
    DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.quoteSubmitted,
    DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.quoteWithdrawn,
  ].includes(name as never);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}
