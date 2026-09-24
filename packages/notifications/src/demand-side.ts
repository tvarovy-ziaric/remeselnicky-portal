import type { PersistedDomainEvent } from "@portal/outbox";

import {
  JOB_INVITATION_NOTIFICATION_EVENT_NAMES,
  mapJobInvitationNotificationEvent,
} from "./job-invitation.js";
import { mapJobMainReviewNotificationEvent } from "./main-review.js";
import type { NotificationDraft } from "./model.js";
import { mapJobSupervisorEvaluationNotificationEvent } from "./supervisor-evaluation.js";

export const DEMAND_SIDE_EXTENSION_EVENT_NAMES = Object.freeze({
  conversationMessageCreated: "conversation.message_created",
  invitationDeclined: "job_invitation.declined",
  invitationEngaged: "job_invitation.engaged",
  invitationNotSelected: "job_invitation.not_selected",
  invitationRequestClosed: "job_invitation.request_closed",
  invitationWithdrawnByCustomer: "job_invitation.withdrawn_by_customer",
  invitationWithdrawnByProvider: "job_invitation.withdrawn_by_provider",
  jobRequestMateriallyUpdated: "job_request.materially_updated",
  jobStarted: "job.started",
  jobCancelled: "job.cancelled",
  jobProgressCreated: "job.progress.created",
  jobIssueCreated: "job.issue.created",
  jobChangeOrderProposed: "job.change_order.proposed",
  jobChangeOrderCounterproposed: "job.change_order.counterproposed",
  jobChangeOrderApproved: "job.change_order.approved",
  jobChangeOrderRejected: "job.change_order.rejected",
  jobChangeOrderWithdrawn: "job.change_order.withdrawn",
  jobCompletionRequested: "job.completion.requested",
  jobCompletionAccepted: "job.completion.accepted",
  jobCompletionRejected: "job.completion.rejected",
  jobCompletionWithdrawn: "job.completion.withdrawn",
  jobCompletionProposed: "job.completion.proposed",
  jobCompletionProposalAgreed: "job.completion.proposal_agreed",
  jobCompletionProposalDisagreed: "job.completion.proposal_disagreed",
  jobCompletionAdminForced: "job.completion.admin_forced",
  jobParticipantInvited: "job_participant.invited",
  jobParticipantAccepted: "job_participant.accepted",
  jobParticipantDeclined: "job_participant.declined",
  jobParticipantJoined: "job_participant.joined",
  jobParticipantLeft: "job_participant.left",
  jobParticipantDeparted: "job_participant.departed",
  jobParticipantRemoved: "job_participant.removed",
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
  const mainReview = mapJobMainReviewNotificationEvent(event);
  const supervisorEvaluation =
    mapJobSupervisorEvaluationNotificationEvent(event);
  const extensionOwned = isKnownDemandSideEvent(event.name);
  const ownerCount =
    Number(invitation !== undefined) +
    Number(mainReview !== undefined) +
    Number(supervisorEvaluation !== undefined) +
    Number(extensionOwned);
  if (ownerCount > 1) {
    throw new TypeError("Notification event catalog ownership collision.");
  }
  if (invitation !== undefined) return invitation;
  if (mainReview !== undefined) return mainReview;
  if (supervisorEvaluation !== undefined) return supervisorEvaluation;

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
    case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobStarted:
      return mapJobLifecycle(event, recipientUserId, "WORK_STARTED");
    case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobCancelled:
      return mapJobLifecycle(event, recipientUserId, "WORK_CANCELLED");
    case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobProgressCreated:
      return mapJobOperation(
        event,
        recipientUserId,
        "progress_update_id",
        "priebeh",
        "INFO",
      );
    case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobIssueCreated:
      return mapJobOperation(
        event,
        recipientUserId,
        "issue_id",
        "problemy",
        "IMPORTANT",
      );
    case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobChangeOrderProposed:
    case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobChangeOrderCounterproposed:
    case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobChangeOrderApproved:
    case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobChangeOrderRejected:
    case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobChangeOrderWithdrawn:
      return mapChangeOrder(event, recipientUserId);
    case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobCompletionRequested:
    case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobCompletionAccepted:
    case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobCompletionRejected:
    case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobCompletionWithdrawn:
      return mapCompletion(event, recipientUserId);
    case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobCompletionProposed:
    case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobCompletionProposalAgreed:
    case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobCompletionProposalDisagreed:
      return mapCompletionProposal(event, recipientUserId);
    case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobCompletionAdminForced:
      return mapAdminCompletion(event, recipientUserId);
    case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobParticipantInvited:
    case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobParticipantAccepted:
    case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobParticipantDeclined:
    case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobParticipantJoined:
    case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobParticipantLeft:
    case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobParticipantDeparted:
    case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobParticipantRemoved:
      return mapJobParticipant(event, recipientUserId);
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

function mapJobLifecycle(
  event: PersistedDomainEvent,
  recipientUserId: string,
  action: "WORK_STARTED" | "WORK_CANCELLED",
): readonly NotificationDraft[] {
  assertEntity(event, "JOB");
  const stateRevision = requiredPositiveInteger(
    event.payload["job_state_revision"],
    "Job state revision",
  );
  if (stateRevision > 2) {
    throw new TypeError("Job state revision is invalid.");
  }
  return one(
    event,
    recipientUserId,
    {
      context: {
        entityId: event.entity.id,
        entityRevision: stateRevision,
        entityType: "JOB",
        path: `/zakazky/${event.entity.id}`,
      },
      payload: { action, job_state_revision: stateRevision },
    },
    event.name,
    "IMPORTANT",
    ["IN_APP", "EMAIL"],
  );
}

function mapJobOperation(
  event: PersistedDomainEvent,
  recipientUserId: string,
  itemKey: "progress_update_id" | "issue_id",
  pathSegment: "priebeh" | "problemy",
  priority: Priority,
): readonly NotificationDraft[] {
  assertEntity(event, "JOB");
  const itemId = requiredUuid(event.payload[itemKey], itemKey);
  if (
    itemKey === "issue_id" &&
    !["PROBLEM", "DELAY", "WAITING"].includes(
      String(event.payload["issue_kind"]),
    )
  ) {
    throw new TypeError("Issue kind is invalid.");
  }
  return one(
    event,
    recipientUserId,
    {
      context: {
        entityId: event.entity.id,
        entityType: "JOB",
        path: `/zakazky/${event.entity.id}/${pathSegment}/${itemId}`,
      },
      payload: {
        action: itemKey === "issue_id" ? "REVIEW_ISSUE" : "READ_PROGRESS",
        [itemKey]: itemId,
      },
    },
    event.name,
    priority,
    ["IN_APP"],
  );
}

function mapChangeOrder(
  event: PersistedDomainEvent,
  recipientUserId: string,
): readonly NotificationDraft[] {
  assertEntity(event, "CHANGE_ORDER_REVISION");
  const jobId = requiredUuid(event.payload["job_id"], "Job");
  const changeOrderId = requiredUuid(
    event.payload["change_order_id"],
    "Change order",
  );
  const revisionId = requiredUuid(event.payload["revision_id"], "Revision");
  if (event.entity.id !== revisionId) {
    throw new TypeError("Change-order notification entity is incoherent.");
  }
  const revisionNumber = requiredPositiveInteger(
    event.payload["revision_number"],
    "Change-order revision",
  );
  const action = (() => {
    switch (event.name) {
      case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobChangeOrderProposed:
        return "REVIEW_CHANGE_ORDER";
      case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobChangeOrderCounterproposed:
        return "REVIEW_CHANGE_ORDER_REVISION";
      case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobChangeOrderApproved:
        return "CHANGE_ORDER_APPROVED";
      case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobChangeOrderRejected:
        return "CHANGE_ORDER_REJECTED";
      case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobChangeOrderWithdrawn:
        return "CHANGE_ORDER_WITHDRAWN";
      default:
        throw new TypeError("Unsupported Change-order notification event.");
    }
  })();
  return one(
    event,
    recipientUserId,
    {
      context: {
        entityId: revisionId,
        entityRevision: revisionNumber,
        entityType: "CHANGE_ORDER_REVISION",
        path: `/zakazky/${jobId}/zmeny/${changeOrderId}/revizie/${revisionId}`,
      },
      payload: { action, revision_number: revisionNumber },
    },
    event.name,
    "IMPORTANT",
    ["IN_APP", "EMAIL"],
  );
}

function mapCompletion(
  event: PersistedDomainEvent,
  recipientUserId: string,
): readonly NotificationDraft[] {
  assertEntity(event, "JOB");
  const jobId = requiredUuid(event.payload["job_id"], "Job");
  const attemptId = requiredUuid(
    event.payload["attempt_id"],
    "Completion attempt",
  );
  if (event.entity.id !== jobId)
    throw new TypeError("Completion notification Job is incoherent.");
  const action = (() => {
    switch (event.name) {
      case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobCompletionRequested:
        return "REVIEW_COMPLETION";
      case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobCompletionAccepted:
        return "COMPLETION_ACCEPTED";
      case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobCompletionRejected:
        return "COMPLETION_REJECTED";
      case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobCompletionWithdrawn:
        return "COMPLETION_WITHDRAWN";
      default:
        throw new TypeError("Unsupported completion notification event.");
    }
  })();
  const important =
    event.name !== DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobCompletionWithdrawn;
  return one(
    event,
    recipientUserId,
    {
      context: {
        entityId: jobId,
        entityType: "JOB",
        path: `/zakazky/${jobId}`,
      },
      payload: { action, attempt_id: attemptId },
    },
    event.name,
    important ? "IMPORTANT" : "INFO",
    important ? ["IN_APP", "EMAIL"] : ["IN_APP"],
  );
}

function mapCompletionProposal(
  event: PersistedDomainEvent,
  recipientUserId: string,
): readonly NotificationDraft[] {
  assertEntity(event, "JOB");
  const jobId = requiredUuid(event.payload["job_id"], "Job");
  const proposalId = requiredUuid(event.payload["proposal_id"], "Proposal");
  if (event.entity.id !== jobId)
    throw new TypeError("Completion proposal notification Job is incoherent.");
  const action = (() => {
    switch (event.name) {
      case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobCompletionProposed:
        return "REVIEW_COMPLETION_PROPOSAL";
      case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobCompletionProposalAgreed:
        return "COMPLETION_PROPOSAL_AGREED";
      case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobCompletionProposalDisagreed:
        return "COMPLETION_PROPOSAL_DISAGREED";
      default:
        throw new TypeError("Unsupported completion proposal notification.");
    }
  })();
  return one(
    event,
    recipientUserId,
    {
      context: {
        entityId: jobId,
        entityType: "JOB",
        path: `/zakazky/${jobId}`,
      },
      payload: { action, proposal_id: proposalId },
    },
    event.name,
    "IMPORTANT",
    ["IN_APP", "EMAIL"],
  );
}

function mapAdminCompletion(
  event: PersistedDomainEvent,
  recipientUserId: string,
): readonly NotificationDraft[] {
  assertEntity(event, "JOB");
  const jobId = requiredUuid(event.payload["job_id"], "Job");
  const commandId = requiredUuid(event.payload["command_id"], "Command");
  if (event.entity.id !== jobId)
    throw new TypeError("Administrative completion Job is incoherent.");
  return one(
    event,
    recipientUserId,
    {
      context: {
        entityId: jobId,
        entityType: "JOB",
        path: `/zakazky/${jobId}`,
      },
      payload: { action: "ADMIN_COMPLETION", command_id: commandId },
    },
    event.name,
    "IMPORTANT",
    ["IN_APP", "EMAIL"],
  );
}

function mapJobParticipant(
  event: PersistedDomainEvent,
  recipientUserId: string,
): readonly NotificationDraft[] {
  assertEntity(event, "JOB_PARTICIPANT");
  const participantId = requiredUuid(
    event.payload["participant_id"],
    "participant",
  );
  if (event.entity.id !== participantId) {
    throw new TypeError("Job participant notification entity is incoherent.");
  }
  const jobId = requiredUuid(event.payload["job_id"], "Job");
  const revision = requiredPositiveInteger(
    event.payload["participation_revision"],
    "participation revision",
  );
  const invited =
    event.name === DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobParticipantInvited;
  const removed =
    event.name === DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobParticipantRemoved;
  const important =
    invited ||
    event.name ===
      DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobParticipantAccepted ||
    event.name === DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobParticipantDeclined;
  const path = invited
    ? `/ucasti/pozvanky/${participantId}`
    : removed
      ? `/ucasti/historia/${participantId}`
      : `/zakazky/${jobId}/ucastnici/${participantId}`;
  return one(
    event,
    recipientUserId,
    {
      context: {
        entityId: participantId,
        entityRevision: revision,
        entityType: "JOB_PARTICIPANT",
        path,
      },
      payload: {
        action: event.name.split(".")[1]?.toUpperCase() ?? "OPEN_PARTICIPANT",
        participation_revision: revision,
      },
    },
    event.name,
    important ? "IMPORTANT" : "INFO",
    important ? ["IN_APP", "EMAIL"] : ["IN_APP"],
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
      case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobStarted:
      case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobCancelled:
        return ["job_state_revision", "recipient_user_id"];
      case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobProgressCreated:
        return ["progress_update_id", "recipient_user_id"];
      case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobIssueCreated:
        return ["issue_id", "issue_kind", "recipient_user_id"];
      case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobChangeOrderProposed:
      case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobChangeOrderCounterproposed:
      case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobChangeOrderApproved:
      case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobChangeOrderRejected:
      case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobChangeOrderWithdrawn:
        return [
          "change_order_id",
          "job_id",
          "recipient_user_id",
          "revision_id",
          "revision_number",
        ];
      case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobCompletionRequested:
      case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobCompletionAccepted:
      case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobCompletionRejected:
      case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobCompletionWithdrawn:
        return ["attempt_id", "job_id", "recipient_user_id"];
      case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobCompletionProposed:
      case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobCompletionProposalAgreed:
      case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobCompletionProposalDisagreed:
        return ["job_id", "proposal_id", "recipient_user_id"];
      case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobCompletionAdminForced:
        return ["command_id", "job_id", "recipient_user_id"];
      case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobParticipantInvited:
      case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobParticipantAccepted:
      case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobParticipantDeclined:
      case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobParticipantJoined:
      case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobParticipantLeft:
      case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobParticipantDeparted:
      case DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobParticipantRemoved:
        return [
          "job_id",
          "participant_id",
          "participation_revision",
          "recipient_user_id",
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
    DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobStarted,
    DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobCancelled,
    DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobProgressCreated,
    DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobIssueCreated,
    DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobChangeOrderProposed,
    DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobChangeOrderCounterproposed,
    DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobChangeOrderApproved,
    DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobChangeOrderRejected,
    DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobChangeOrderWithdrawn,
    DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobCompletionRequested,
    DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobCompletionAccepted,
    DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobCompletionRejected,
    DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobCompletionWithdrawn,
    DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobCompletionProposed,
    DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobCompletionProposalAgreed,
    DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobCompletionProposalDisagreed,
    DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobCompletionAdminForced,
    DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobParticipantInvited,
    DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobParticipantAccepted,
    DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobParticipantDeclined,
    DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobParticipantJoined,
    DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobParticipantLeft,
    DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobParticipantDeparted,
    DEMAND_SIDE_NOTIFICATION_EVENT_NAMES.jobParticipantRemoved,
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
