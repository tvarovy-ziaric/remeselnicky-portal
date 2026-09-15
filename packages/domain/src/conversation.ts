import type { CraftsmanProfileId } from "./craftsman-profile.js";
import type { CustomerProfileId } from "./customer-profile.js";
import type { EntityId } from "./index.js";
import type { JobInvitationId } from "./job-invitation.js";
import type { JobRequestId } from "./job-request.js";
import type { UserId } from "./user.js";

declare const conversationIdBrand: unique symbol;
export type ConversationId = EntityId & {
  readonly [conversationIdBrand]: "ConversationId";
};

export const CONVERSATION_ACCESS_STATES = Object.freeze([
  "READ_ONLY",
  "WRITABLE",
] as const);

export type ConversationAccessState =
  (typeof CONVERSATION_ACCESS_STATES)[number];
export type ConversationParticipantRole = "CRAFTSMAN" | "CUSTOMER";

/**
 * Private, invitation-scoped conversation identity. Messages and per-user
 * presentation state are separate append-only concerns introduced by R3-012.
 */
export interface Conversation {
  readonly access: ConversationAccessState;
  readonly counterpartDisplayName: string;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly createdAt: Date;
  readonly customerProfileId: CustomerProfileId;
  readonly id: ConversationId;
  readonly invitationId: JobInvitationId;
  readonly jobRequestId: JobRequestId;
  readonly participantRole: ConversationParticipantRole;
  readonly requestTitle: string;
}

export interface ConversationReadInput {
  readonly actorUserId: UserId;
  readonly conversationId: ConversationId;
}

export interface InvitationConversationReadInput {
  readonly actorUserId: UserId;
  readonly invitationId: JobInvitationId;
}

export interface ConversationPersistence {
  readOwned(input: ConversationReadInput): Promise<Conversation | null>;
  readOwnedByInvitation(
    input: InvitationConversationReadInput,
  ): Promise<Conversation | null>;
}

export function assertConversationReadInput(
  input: ConversationReadInput,
): void {
  assertRecord(input);
  assertUuid(input.actorUserId, "actorUserId");
  assertUuid(input.conversationId, "conversationId");
}

export function assertInvitationConversationReadInput(
  input: InvitationConversationReadInput,
): void {
  assertRecord(input);
  assertUuid(input.actorUserId, "actorUserId");
  assertUuid(input.invitationId, "invitationId");
}

function assertRecord(
  value: unknown,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Invalid conversation read input.");
  }
}

function assertUuid(value: unknown, field: string): void {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    throw new TypeError(`Invalid conversation field: ${field}.`);
  }
}
