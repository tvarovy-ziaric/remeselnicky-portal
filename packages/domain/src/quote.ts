import type { ConversationId } from "./conversation.js";
import type { EntityId } from "./index.js";
import type { JobInvitationId } from "./job-invitation.js";
import type { JobRequestId } from "./job-request.js";
import type { UserId } from "./user.js";

declare const quoteIdBrand: unique symbol;
export type QuoteId = EntityId & { readonly [quoteIdBrand]: "QuoteId" };

export const QUOTE_AUTHORING_MODES = Object.freeze([
  "PLATFORM_STRUCTURED",
  "EXTERNAL_PDF",
] as const);
export const QUOTE_REVISION_STATES = Object.freeze([
  "DRAFT",
  "SUBMITTED",
  "SUPERSEDED",
  "REJECTED",
  "WITHDRAWN",
  "EXPIRED",
  "ACCEPTED",
  "NOT_SELECTED",
] as const);
export const QUOTE_CORE_COMMANDS = Object.freeze([
  "CREATE_DRAFT",
  "CREATE_REVISION",
  "SUBMIT",
  "REJECT",
] as const);

export type QuoteAuthoringMode = (typeof QUOTE_AUTHORING_MODES)[number];
export type QuoteRevisionState = (typeof QUOTE_REVISION_STATES)[number];
export type QuoteCoreCommand = (typeof QUOTE_CORE_COMMANDS)[number];
export type QuoteParticipantRole = "CRAFTSMAN" | "CUSTOMER";

export interface QuoteRevision {
  readonly authoringMode: QuoteAuthoringMode;
  readonly changedAt: Date;
  readonly createdAt: Date;
  readonly rejectionReason: string | null;
  readonly requestContentRevision: number;
  readonly requestVisibleVersion: number;
  readonly revision: number;
  readonly state: QuoteRevisionState;
  readonly stateRevision: number;
  readonly submittedAt: Date | null;
}

export interface Quote {
  readonly conversationId: ConversationId;
  readonly createdAt: Date;
  readonly currentDraft: QuoteRevision | null;
  readonly currentSubmitted: QuoteRevision | null;
  readonly id: QuoteId;
  readonly invitationId: JobInvitationId;
  readonly jobRequestId: JobRequestId;
  readonly participantRole: QuoteParticipantRole;
  readonly revisions: readonly QuoteRevision[];
}

interface QuoteActorCommandInput {
  readonly actorUserId: UserId;
  readonly commandId: string;
}

export interface CreateQuoteDraftInput extends QuoteActorCommandInput {
  readonly authoringMode: QuoteAuthoringMode;
  readonly conversationId: ConversationId;
  readonly requestContentRevision: number;
  readonly requestVisibleVersion: number;
}

export interface CreateQuoteRevisionInput extends QuoteActorCommandInput {
  readonly authoringMode: QuoteAuthoringMode;
  readonly expectedSubmittedStateRevision: number;
  readonly quoteId: QuoteId;
  readonly requestContentRevision: number;
  readonly requestVisibleVersion: number;
}

export interface SubmitQuoteRevisionInput extends QuoteActorCommandInput {
  readonly expectedDraftStateRevision: number;
  readonly expectedSubmittedStateRevision: number | null;
  readonly quoteId: QuoteId;
  readonly revision: number;
}

export interface RejectQuoteRevisionInput extends QuoteActorCommandInput {
  readonly expectedStateRevision: number;
  readonly quoteId: QuoteId;
  readonly rejectionReason?: string | null;
  readonly revision: number;
}

export interface QuoteReadInput {
  readonly actorUserId: UserId;
  readonly quoteId: QuoteId;
}

export interface InvitationQuoteReadInput {
  readonly actorUserId: UserId;
  readonly invitationId: JobInvitationId;
}

export type QuoteCommandFailureStatus =
  | "AUTHORING_NOT_READY"
  | "INVALID_TRANSITION"
  | "NOT_FOUND"
  | "READ_ONLY"
  | "STALE_REVISION";

export type QuoteCommandResult = Readonly<
  | { readonly quote: Quote; readonly status: "APPLIED" | "DEDUPLICATED" }
  | {
      readonly currentDraftStateRevision?: number;
      readonly currentSubmittedStateRevision?: number | null;
      readonly status: QuoteCommandFailureStatus;
    }
>;

export interface QuotePersistence {
  createDraft(input: CreateQuoteDraftInput): Promise<QuoteCommandResult>;
  createRevision(input: CreateQuoteRevisionInput): Promise<QuoteCommandResult>;
  readOwned(input: QuoteReadInput): Promise<Quote | null>;
  readOwnedByInvitation(input: InvitationQuoteReadInput): Promise<Quote | null>;
  reject(input: RejectQuoteRevisionInput): Promise<QuoteCommandResult>;
  submit(input: SubmitQuoteRevisionInput): Promise<QuoteCommandResult>;
}

export type QuoteService = QuotePersistence;

export class QuoteIdempotencyError extends Error {
  readonly code = "QUOTE_IDEMPOTENCY_CONFLICT";
}

export function createQuoteService(input: {
  readonly persistence: QuotePersistence;
}): QuoteService {
  return Object.freeze({
    createDraft(command: CreateQuoteDraftInput) {
      assertCreateQuoteDraftInput(command);
      return input.persistence.createDraft(command);
    },
    createRevision(command: CreateQuoteRevisionInput) {
      assertCreateQuoteRevisionInput(command);
      return input.persistence.createRevision(command);
    },
    readOwned(command: QuoteReadInput) {
      assertQuoteReadInput(command);
      return input.persistence.readOwned(command);
    },
    readOwnedByInvitation(command: InvitationQuoteReadInput) {
      assertInvitationQuoteReadInput(command);
      return input.persistence.readOwnedByInvitation(command);
    },
    reject(command: RejectQuoteRevisionInput) {
      assertRejectQuoteRevisionInput(command);
      return input.persistence.reject(
        normalizeRejectQuoteRevisionInput(command),
      );
    },
    submit(command: SubmitQuoteRevisionInput) {
      assertSubmitQuoteRevisionInput(command);
      return input.persistence.submit(command);
    },
  });
}

/** R3-019 and R4 own the deferred terminal commands, not this core service. */
export function transitionQuoteRevision(
  current: QuoteRevisionState,
  command:
    | "ACCEPT"
    | "EXPIRE"
    | "NOT_SELECT"
    | "REJECT"
    | "SUBMIT"
    | "SUPERSEDE"
    | "WITHDRAW",
): QuoteRevisionState | null {
  if (current === "DRAFT" && command === "SUBMIT") return "SUBMITTED";
  if (current !== "SUBMITTED") return null;
  if (command === "SUPERSEDE") return "SUPERSEDED";
  if (command === "REJECT") return "REJECTED";
  if (command === "WITHDRAW") return "WITHDRAWN";
  if (command === "EXPIRE") return "EXPIRED";
  if (command === "ACCEPT") return "ACCEPTED";
  if (command === "NOT_SELECT") return "NOT_SELECTED";
  return null;
}

export function assertCreateQuoteDraftInput(
  input: CreateQuoteDraftInput,
): void {
  assertActorCommand(input);
  assertUuid(input.conversationId, "conversationId");
  assertAuthoringMode(input.authoringMode);
  assertRequestProvenance(input);
}

export function assertCreateQuoteRevisionInput(
  input: CreateQuoteRevisionInput,
): void {
  assertActorCommand(input);
  assertUuid(input.quoteId, "quoteId");
  assertAuthoringMode(input.authoringMode);
  assertPositiveInteger(
    input.expectedSubmittedStateRevision,
    "expectedSubmittedStateRevision",
  );
  assertRequestProvenance(input);
}

export function assertSubmitQuoteRevisionInput(
  input: SubmitQuoteRevisionInput,
): void {
  assertActorCommand(input);
  assertUuid(input.quoteId, "quoteId");
  assertPositiveInteger(input.revision, "revision");
  assertPositiveInteger(
    input.expectedDraftStateRevision,
    "expectedDraftStateRevision",
  );
  if (input.expectedSubmittedStateRevision !== null) {
    assertPositiveInteger(
      input.expectedSubmittedStateRevision,
      "expectedSubmittedStateRevision",
    );
  }
}

export function assertRejectQuoteRevisionInput(
  input: RejectQuoteRevisionInput,
): void {
  assertActorCommand(input);
  assertUuid(input.quoteId, "quoteId");
  assertPositiveInteger(input.revision, "revision");
  assertPositiveInteger(input.expectedStateRevision, "expectedStateRevision");
  normalizeRejectionReason(input.rejectionReason);
}

export function normalizeRejectQuoteRevisionInput(
  input: RejectQuoteRevisionInput,
): RejectQuoteRevisionInput {
  return Object.freeze({
    ...input,
    rejectionReason: normalizeRejectionReason(input.rejectionReason),
  });
}

export function assertQuoteReadInput(input: QuoteReadInput): void {
  assertRecord(input);
  assertUuid(input.actorUserId, "actorUserId");
  assertUuid(input.quoteId, "quoteId");
}

export function assertInvitationQuoteReadInput(
  input: InvitationQuoteReadInput,
): void {
  assertRecord(input);
  assertUuid(input.actorUserId, "actorUserId");
  assertUuid(input.invitationId, "invitationId");
}

function assertActorCommand(
  input: QuoteActorCommandInput,
): asserts input is QuoteActorCommandInput {
  assertRecord(input);
  assertUuid(input.actorUserId, "actorUserId");
  assertUuid(input.commandId, "commandId");
}

function assertRequestProvenance(input: {
  readonly requestContentRevision: unknown;
  readonly requestVisibleVersion: unknown;
}): void {
  assertPositiveInteger(input.requestContentRevision, "requestContentRevision");
  assertPositiveInteger(input.requestVisibleVersion, "requestVisibleVersion");
}

function assertAuthoringMode(value: unknown): void {
  if (!QUOTE_AUTHORING_MODES.some((candidate) => candidate === value)) {
    throw invalid("authoringMode");
  }
}

function normalizeRejectionReason(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw invalid("rejectionReason");
  const normalized = value.replace(/\r\n?/gu, "\n").trim();
  if (
    normalized.length < 1 ||
    [...normalized].length > 500 ||
    [...normalized].some((character) => {
      const point = character.codePointAt(0);
      return point !== undefined && point < 32 && point !== 9 && point !== 10;
    })
  ) {
    throw invalid("rejectionReason");
  }
  return normalized;
}

function assertPositiveInteger(value: unknown, field: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw invalid(field);
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
  return new TypeError(`Invalid quote field: ${field}.`);
}
