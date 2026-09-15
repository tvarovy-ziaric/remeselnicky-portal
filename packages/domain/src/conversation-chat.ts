import type {
  ConversationId,
  ConversationParticipantRole,
} from "./conversation.js";
import type { EntityId } from "./index.js";
import type { UserId } from "./user.js";

declare const conversationMessageIdBrand: unique symbol;
export type ConversationMessageId = EntityId & {
  readonly [conversationMessageIdBrand]: "ConversationMessageId";
};

export const CONVERSATION_MESSAGE_MAX_LENGTH = 4_000;
export const CONVERSATION_TIMELINE_MAX_PAGE_SIZE = 50;
export const CONVERSATION_REPORT_REASONS = Object.freeze([
  "ABUSE",
  "CONTACT_CIRCUMVENTION",
  "FRAUD_OR_SCAM",
  "THREAT",
  "OTHER",
] as const);
export const CONVERSATION_PARTICIPANT_ACTIONS = Object.freeze([
  "MARK_READ",
  "ARCHIVE",
  "UNARCHIVE",
  "MUTE",
  "UNMUTE",
] as const);

export type ConversationReportReason =
  (typeof CONVERSATION_REPORT_REASONS)[number];
export type ConversationParticipantAction =
  (typeof CONVERSATION_PARTICIPANT_ACTIONS)[number];

export interface ConversationTimelineEntry {
  readonly author: "COUNTERPART" | "SELF" | "SYSTEM";
  readonly authorRole: ConversationParticipantRole | null;
  readonly body: string | null;
  readonly conversationId: ConversationId;
  readonly createdAt: Date;
  readonly id: ConversationMessageId;
  readonly kind: "HUMAN_MESSAGE" | "SYSTEM_EVENT";
  readonly readByCounterpart: boolean | null;
  readonly replyToMessageId: ConversationMessageId | null;
  readonly sequence: number;
  readonly systemEvent: "ENGAGEMENT" | null;
}

export interface ConversationParticipantState {
  readonly archived: boolean;
  readonly lastReadAt: Date | null;
  readonly lastReadSequence: number;
  readonly muted: boolean;
  readonly revision: number;
}

export interface ConversationTimelinePage {
  readonly entries: readonly ConversationTimelineEntry[];
  readonly hasMore: boolean;
  readonly nextBeforeSequence: number | null;
  readonly participantState: ConversationParticipantState;
  readonly unreadCount: number;
}

export interface ConversationTimelineReadInput {
  readonly actorUserId: UserId;
  readonly beforeSequence?: number;
  readonly conversationId: ConversationId;
  readonly limit?: number;
}

export interface ConversationMessageSendInput {
  readonly actorUserId: UserId;
  readonly body: string;
  readonly commandId: string;
  readonly conversationId: ConversationId;
  readonly replyToMessageId?: ConversationMessageId | null;
}

export interface ConversationParticipantStateInput {
  readonly action: ConversationParticipantAction;
  readonly actorUserId: UserId;
  readonly commandId: string;
  readonly conversationId: ConversationId;
  readonly expectedRevision: number;
  readonly readThroughSequence?: number | null;
}

export interface ConversationReportInput {
  readonly actorUserId: UserId;
  readonly commandId: string;
  readonly conversationId: ConversationId;
  readonly messageId?: ConversationMessageId | null;
  readonly reason: ConversationReportReason;
}

export type ConversationMessageSendResult = Readonly<
  | {
      readonly entry: ConversationTimelineEntry;
      readonly status: "DEDUPLICATED" | "SENT";
    }
  | { readonly status: "NOT_FOUND" | "READ_ONLY" }
>;

export type ConversationParticipantStateResult = Readonly<
  | {
      readonly participantState: ConversationParticipantState;
      readonly status: "APPLIED" | "DEDUPLICATED";
    }
  | {
      readonly currentRevision?: number;
      readonly status: "NOT_FOUND" | "STALE";
    }
>;

export type ConversationReportResult = Readonly<
  | { readonly reportId: string; readonly status: "DEDUPLICATED" | "REPORTED" }
  | { readonly status: "NOT_FOUND" }
>;

export interface ConversationChatPersistence {
  readTimeline(
    input: ConversationTimelineReadInput,
  ): Promise<ConversationTimelinePage | null>;
  report(input: ConversationReportInput): Promise<ConversationReportResult>;
  sendMessage(
    input: ConversationMessageSendInput,
  ): Promise<ConversationMessageSendResult>;
  updateParticipantState(
    input: ConversationParticipantStateInput,
  ): Promise<ConversationParticipantStateResult>;
}

export interface ConversationMessageAdmission {
  evaluate(input: Readonly<{ body: string }>): Promise<"ALLOW" | "BLOCK">;
}

export interface ConversationChatService {
  report(input: ConversationReportInput): Promise<ConversationReportResult>;
  sendMessage(
    input: ConversationMessageSendInput,
  ): Promise<
    | ConversationMessageSendResult
    | Readonly<{ status: "BLOCKED_BY_CONTACT_POLICY" }>
  >;
  updateParticipantState(
    input: ConversationParticipantStateInput,
  ): Promise<ConversationParticipantStateResult>;
}

export class ConversationChatIdempotencyError extends Error {
  public readonly code = "CONVERSATION_CHAT_IDEMPOTENCY_CONFLICT";
}

export function createConversationChatService(input: {
  readonly admission: ConversationMessageAdmission;
  readonly persistence: ConversationChatPersistence;
}): ConversationChatService {
  return Object.freeze({
    report(command: ConversationReportInput) {
      assertConversationReportInput(command);
      return input.persistence.report(command);
    },
    async sendMessage(command: ConversationMessageSendInput) {
      const normalized = normalizeConversationMessageSendInput(command);
      if (
        (await input.admission.evaluate({ body: normalized.body })) !== "ALLOW"
      ) {
        return Object.freeze({ status: "BLOCKED_BY_CONTACT_POLICY" as const });
      }
      return input.persistence.sendMessage(normalized);
    },
    updateParticipantState(command: ConversationParticipantStateInput) {
      assertConversationParticipantStateInput(command);
      return input.persistence.updateParticipantState(command);
    },
  });
}

/**
 * Conservative pre-confirmation baseline. R3-014 replaces this with the full
 * confirmed-Job-aware policy, but obvious contact/address disclosure is never
 * temporarily opened while that richer policy is unfinished.
 */
export function createPreConfirmationConversationMessageAdmission(): ConversationMessageAdmission {
  return Object.freeze({
    evaluate({ body }: Readonly<{ body: string }>) {
      const blocked = [
        /[\p{L}\d._%+-]+@[\p{L}\d.-]+\.[\p{L}]{2,}/iu,
        /(?:\+|00)?\d(?:[\s()./-]*\d){6,}/u,
        /(?:psč|psc)[^\n\d]{0,12}\d{3}\s?\d{2}/iu,
        /(?:\b(?:adresa|ulica|námestie|trieda|číslo domu|číslo bytu)\b|\b(?:ul|nám)\.)/iu,
      ].some((pattern) => pattern.test(body));
      return Promise.resolve(blocked ? ("BLOCK" as const) : ("ALLOW" as const));
    },
  });
}

export function normalizeConversationMessageSendInput(
  input: ConversationMessageSendInput,
): ConversationMessageSendInput {
  assertRecord(input);
  assertUuid(input.actorUserId, "actorUserId");
  assertUuid(input.commandId, "commandId");
  assertUuid(input.conversationId, "conversationId");
  if (input.replyToMessageId !== null && input.replyToMessageId !== undefined) {
    assertUuid(input.replyToMessageId, "replyToMessageId");
  }
  if (typeof input.body !== "string") throw invalid("body");
  const body = input.body.replace(/\r\n?/gu, "\n").trim();
  if (
    body.length < 1 ||
    [...body].length > CONVERSATION_MESSAGE_MAX_LENGTH ||
    [...body].some((character) => {
      const point = character.codePointAt(0);
      return point !== undefined && point < 32 && point !== 9 && point !== 10;
    })
  ) {
    throw invalid("body");
  }
  return Object.freeze({
    actorUserId: input.actorUserId,
    body,
    commandId: input.commandId,
    conversationId: input.conversationId,
    replyToMessageId: input.replyToMessageId ?? null,
  });
}

export function assertConversationTimelineReadInput(
  input: ConversationTimelineReadInput,
): void {
  assertRecord(input);
  assertUuid(input.actorUserId, "actorUserId");
  assertUuid(input.conversationId, "conversationId");
  if (
    input.beforeSequence !== undefined &&
    (!Number.isSafeInteger(input.beforeSequence) || input.beforeSequence < 1)
  ) {
    throw invalid("beforeSequence");
  }
  if (
    input.limit !== undefined &&
    (!Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > CONVERSATION_TIMELINE_MAX_PAGE_SIZE)
  ) {
    throw invalid("limit");
  }
}

export function assertConversationParticipantStateInput(
  input: ConversationParticipantStateInput,
): void {
  assertRecord(input);
  assertUuid(input.actorUserId, "actorUserId");
  assertUuid(input.commandId, "commandId");
  assertUuid(input.conversationId, "conversationId");
  if (
    !CONVERSATION_PARTICIPANT_ACTIONS.some((action) => action === input.action)
  ) {
    throw invalid("action");
  }
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0
  ) {
    throw invalid("expectedRevision");
  }
  if (input.action === "MARK_READ") {
    if (
      !Number.isSafeInteger(input.readThroughSequence) ||
      (input.readThroughSequence ?? 0) < 1
    ) {
      throw invalid("readThroughSequence");
    }
  } else if (
    input.readThroughSequence !== null &&
    input.readThroughSequence !== undefined
  ) {
    throw invalid("readThroughSequence");
  }
}

export function assertConversationReportInput(
  input: ConversationReportInput,
): void {
  assertRecord(input);
  assertUuid(input.actorUserId, "actorUserId");
  assertUuid(input.commandId, "commandId");
  assertUuid(input.conversationId, "conversationId");
  if (input.messageId !== null && input.messageId !== undefined) {
    assertUuid(input.messageId, "messageId");
  }
  if (!CONVERSATION_REPORT_REASONS.some((reason) => reason === input.reason)) {
    throw invalid("reason");
  }
}

function assertRecord(
  value: unknown,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("input");
  }
}

function assertUuid(value: unknown, field: string): void {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    throw invalid(field);
  }
}

function invalid(field: string): TypeError {
  return new TypeError(`Invalid conversation chat field: ${field}.`);
}
