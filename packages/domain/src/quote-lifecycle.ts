import type {
  QuoteAuthoringMode,
  QuoteCommandResult,
  QuoteId,
  QuoteRevisionState,
} from "./quote.js";
import type { UserId } from "./user.js";

export const QUOTE_LIFECYCLE_COMMANDS = Object.freeze([
  "WITHDRAW",
  "EXPIRE",
] as const);
export type QuoteLifecycleCommandKind =
  (typeof QUOTE_LIFECYCLE_COMMANDS)[number];

export interface QuoteLifecycleCommandInput {
  readonly actorUserId: UserId;
  readonly commandId: string;
  readonly expectedStateRevision: number;
  readonly quoteId: QuoteId;
  readonly quoteRevision: number;
}

export interface ExpireQuoteRevisionInput {
  readonly commandId: string;
  readonly expectedStateRevision: number;
  readonly quoteId: QuoteId;
  readonly quoteRevision: number;
}

export interface ReconfirmQuoteInput {
  readonly actorUserId: UserId;
  readonly authoringMode: QuoteAuthoringMode;
  readonly commandId: string;
  readonly expectedSourceStateRevision: number;
  readonly quoteId: QuoteId;
  readonly sourceQuoteRevision: number;
  readonly sourceState: "EXPIRED" | "SUBMITTED" | "WITHDRAWN";
}

export interface QuoteAcceptanceContextReadInput {
  readonly actorUserId: UserId;
  readonly quoteId: QuoteId;
  readonly quoteRevision?: number;
}

export interface QuoteAcceptanceContext {
  /** Lifecycle-only fact. R4 must additionally enforce every D16 acceptance gate. */
  readonly lifecycleAcceptanceEligible: boolean;
  readonly authoringEligible: boolean;
  readonly authoringMode: QuoteAuthoringMode;
  readonly currentRequestContentRevision: number;
  readonly currentRequestVisibleVersion: number;
  readonly deadlinePassed: boolean;
  readonly materiallyStale: boolean;
  readonly quoteId: QuoteId;
  readonly quoteRevision: number;
  readonly requestContentRevision: number;
  readonly requestVisibleVersion: number;
  readonly state: QuoteRevisionState;
  readonly stateRevision: number;
  readonly validUntil: Date | null;
}

export type QuoteLifecycleCommandResult = Readonly<
  | {
      readonly context: QuoteAcceptanceContext;
      readonly status: "APPLIED" | "DEDUPLICATED";
    }
  | { readonly status: "NOT_DUE" | "NOT_FOUND" | "STALE_REVISION" }
>;

export interface QuoteLifecycleExpiredRevision {
  readonly quoteId: QuoteId;
  readonly quoteRevision: number;
}

export interface QuoteLifecyclePersistence {
  readOwnedContext(
    input: QuoteAcceptanceContextReadInput,
  ): Promise<QuoteAcceptanceContext | null>;
  reconfirm(input: ReconfirmQuoteInput): Promise<QuoteCommandResult>;
  withdraw(
    input: QuoteLifecycleCommandInput,
  ): Promise<QuoteLifecycleCommandResult>;
}

/** Trusted worker-only maintenance seam; never expose it through an HTTP route. */
export interface QuoteLifecycleMaintenancePersistence {
  expireDueSubmitted(): Promise<readonly QuoteLifecycleExpiredRevision[]>;
}

export function assertExpireQuoteRevisionInput(
  input: ExpireQuoteRevisionInput,
): void {
  record(input);
  uuid(input.commandId, "commandId");
  uuid(input.quoteId, "quoteId");
  positive(input.quoteRevision, "quoteRevision");
  positive(input.expectedStateRevision, "expectedStateRevision");
}

export function assertQuoteLifecycleCommandInput(
  input: QuoteLifecycleCommandInput,
): void {
  record(input);
  uuid(input.actorUserId, "actorUserId");
  uuid(input.commandId, "commandId");
  uuid(input.quoteId, "quoteId");
  positive(input.quoteRevision, "quoteRevision");
  positive(input.expectedStateRevision, "expectedStateRevision");
}
export function assertQuoteAcceptanceContextReadInput(
  input: QuoteAcceptanceContextReadInput,
): void {
  record(input);
  uuid(input.actorUserId, "actorUserId");
  uuid(input.quoteId, "quoteId");
  if (input.quoteRevision !== undefined)
    positive(input.quoteRevision, "quoteRevision");
}
export function assertReconfirmQuoteInput(input: ReconfirmQuoteInput): void {
  record(input);
  uuid(input.actorUserId, "actorUserId");
  uuid(input.commandId, "commandId");
  uuid(input.quoteId, "quoteId");
  positive(input.expectedSourceStateRevision, "expectedSourceStateRevision");
  positive(input.sourceQuoteRevision, "sourceQuoteRevision");
  if (
    !(["SUBMITTED", "EXPIRED", "WITHDRAWN"] as const).includes(
      input.sourceState,
    )
  )
    invalid("sourceState");
  if (
    input.authoringMode !== "PLATFORM_STRUCTURED" &&
    input.authoringMode !== "EXTERNAL_PDF"
  )
    invalid("authoringMode");
}

export function assertQuoteAcceptanceContext(
  value: QuoteAcceptanceContext,
): void {
  record(value);
  uuid(value.quoteId, "quoteId");
  positive(value.quoteRevision, "quoteRevision");
  positive(value.stateRevision, "stateRevision");
  positive(value.requestContentRevision, "requestContentRevision");
  positive(value.requestVisibleVersion, "requestVisibleVersion");
  positive(
    value.currentRequestContentRevision,
    "currentRequestContentRevision",
  );
  positive(value.currentRequestVisibleVersion, "currentRequestVisibleVersion");
  if (
    value.authoringMode !== "PLATFORM_STRUCTURED" &&
    value.authoringMode !== "EXTERNAL_PDF"
  )
    invalid("authoringMode");
  if (
    !(
      [
        "DRAFT",
        "SUBMITTED",
        "SUPERSEDED",
        "REJECTED",
        "WITHDRAWN",
        "EXPIRED",
        "ACCEPTED",
        "NOT_SELECTED",
      ] as const
    ).includes(value.state)
  )
    invalid("state");
  for (const key of [
    "authoringEligible",
    "lifecycleAcceptanceEligible",
    "deadlinePassed",
    "materiallyStale",
  ] as const)
    if (typeof value[key] !== "boolean") invalid(key);
  if (
    value.validUntil !== null &&
    (!(value.validUntil instanceof Date) ||
      !Number.isFinite(value.validUntil.valueOf()))
  )
    invalid("validUntil");
  if (
    value.materiallyStale !==
    (value.requestVisibleVersion !== value.currentRequestVisibleVersion)
  )
    invalid("materiallyStale");
  if (
    value.lifecycleAcceptanceEligible &&
    (value.state !== "SUBMITTED" ||
      value.deadlinePassed ||
      value.materiallyStale ||
      !value.authoringEligible)
  )
    invalid("lifecycleAcceptanceEligible");
}

function record(value: unknown): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    invalid("input");
}
function uuid(value: unknown, field: string): void {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  )
    invalid(field);
}
function positive(value: unknown, field: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid(field);
}
function invalid(field: string): never {
  throw new TypeError(`Invalid Quote lifecycle field: ${field}.`);
}
