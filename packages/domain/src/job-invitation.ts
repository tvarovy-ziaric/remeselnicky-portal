import type { CraftsmanProfileId } from "./craftsman-profile.js";
import type { CustomerProfileId } from "./customer-profile.js";
import type { EntityId } from "./index.js";
import type { JobRequestId } from "./job-request.js";
import type { UserId } from "./user.js";

declare const jobInvitationIdBrand: unique symbol;
export type JobInvitationId = EntityId & {
  readonly [jobInvitationIdBrand]: "JobInvitationId";
};

export const JOB_INVITATION_STATES = Object.freeze([
  "PENDING",
  "ENGAGED",
  "DECLINED",
  "EXPIRED",
  "WITHDRAWN",
  "NOT_SELECTED",
] as const);
export const JOB_INVITATION_DECLINE_REASONS = Object.freeze([
  "NO_CAPACITY",
  "NOT_MY_WORK",
  "OTHER",
  "TIMING",
  "TOO_FAR",
] as const);
export const JOB_INVITATION_DEFAULT_ACTIVE_LIMIT = 5;
export const JOB_INVITATION_DEFAULT_EXPIRY_DAYS = 7;

export type JobInvitationState = (typeof JOB_INVITATION_STATES)[number];
export type JobInvitationDeclineReason =
  (typeof JOB_INVITATION_DECLINE_REASONS)[number];

export interface JobInvitation {
  readonly changedAt: Date;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly customerProfileId: CustomerProfileId;
  readonly declineNote: string | null;
  readonly declineReason: JobInvitationDeclineReason | null;
  readonly engagedAt: Date | null;
  readonly expiresAt: Date;
  readonly id: JobInvitationId;
  readonly jobRequestId: JobRequestId;
  readonly requestContentRevision: number;
  readonly requestVisibleVersion: number;
  readonly revision: number;
  readonly sentAt: Date;
  readonly state: JobInvitationState;
}

export interface JobInvitationListItem {
  readonly changedAt: Date;
  readonly counterpartDisplayName: string;
  readonly expiresAt: Date;
  readonly id: JobInvitationId;
  readonly jobRequestId: JobRequestId;
  readonly perspective: "CRAFTSMAN" | "CUSTOMER";
  readonly requestTitle: string;
  readonly revision: number;
  readonly state: JobInvitationState;
}

/** Explicit pre-confirmation projection; exact address, map pin and contacts are absent. */
export interface JobInvitationRequestBrief {
  readonly approximateDistanceKm: number | null;
  readonly budget: JobInvitationRequestBudget;
  readonly description: string;
  readonly details: JobInvitationRequestDetails;
  readonly documentMediaAssetIds: readonly string[];
  readonly municipalityCode: string;
  readonly photoMediaAssetIds: readonly string[];
  readonly primaryProfessionCode: string;
  readonly relatedProfessionCodes: readonly string[];
  readonly skillCodes: readonly string[];
  readonly specializationCode: string | null;
  readonly timing: JobInvitationRequestTiming;
  readonly title: string;
}

export interface JobInvitationRequestBudget {
  readonly currency: "EUR";
  readonly maximumAmountCents: number | null;
  readonly minimumAmountCents: number | null;
  readonly mode: "RANGE" | "UNKNOWN" | "UP_TO" | null;
}

export interface JobInvitationRequestTiming {
  readonly completionDeadline: string | null;
  readonly endsOn: string | null;
  readonly mode: "AS_SOON_AS_POSSIBLE" | "FLEXIBLE" | "SPECIFIC_PERIOD" | null;
  readonly startsOn: string | null;
}

export interface JobInvitationRequestDetails {
  readonly approximateQuantity: string | null;
  readonly customRequirements: string | null;
  readonly materialResponsibility:
    | "ADVICE_NEEDED"
    | "COMBINATION"
    | "CRAFTSMAN_PROVIDES"
    | "CUSTOMER_PROVIDES"
    | null;
  readonly siteInspection: "LIKELY" | "MAYBE" | "UNKNOWN" | null;
}

export interface JobInvitationDetail extends JobInvitationListItem {
  readonly competitionDisclosure: "CUSTOMER_MAY_CONTACT_OTHERS";
  readonly customerTrust: Readonly<{
    readonly permittedReviewComments: readonly string[];
    readonly rating: number | null;
    readonly reviewCount: number;
  }>;
  readonly request: JobInvitationRequestBrief;
  readonly displayedRequestContentRevision: number;
  readonly displayedRequestVisibleVersion: number;
  readonly requestContentRevision: number;
  readonly requestVisibleVersion: number;
}

export interface SendJobInvitationInput {
  readonly actorUserId: UserId;
  readonly commandId: string;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly jobRequestId: JobRequestId;
}

export interface RespondToJobInvitationInput {
  readonly action: "DECLINE" | "ENGAGE" | "WITHDRAW";
  readonly actorUserId: UserId;
  readonly commandId: string;
  readonly declineNote?: string | null;
  readonly declineReason?: JobInvitationDeclineReason | null;
  readonly expectedRevision: number;
  readonly invitationId: JobInvitationId;
}

export interface CloseJobInvitationInput {
  readonly action: "STOP_CONSIDERING" | "WITHDRAW";
  readonly actorUserId: UserId;
  readonly commandId: string;
  readonly expectedRevision: number;
  readonly invitationId: JobInvitationId;
}

export type JobInvitationCommandResult = Readonly<
  | {
      readonly invitation: JobInvitation;
      readonly status: "APPLIED" | "DEDUPLICATED";
    }
  | {
      readonly activeLimit?: number;
      readonly currentRevision?: number;
      readonly status:
        | "ACCOUNT_NOT_ELIGIBLE"
        | "ACTIVE_LIMIT_REACHED"
        | "ALREADY_INVITED"
        | "INVALID_TRANSITION"
        | "NOT_FOUND"
        | "STALE_REVISION"
        | "TARGET_NOT_ELIGIBLE";
    }
>;

export interface JobInvitationPersistence {
  closeOwned(
    input: CloseJobInvitationInput,
  ): Promise<JobInvitationCommandResult>;
  expirePending(): Promise<readonly JobInvitationId[]>;
  listOwned(input: {
    readonly actorUserId: UserId;
    readonly jobRequestId?: JobRequestId;
    readonly limit: number;
  }): Promise<readonly JobInvitationListItem[]>;
  readOwned(input: {
    readonly actorUserId: UserId;
    readonly invitationId: JobInvitationId;
    readonly requestContentRevision?: number;
  }): Promise<JobInvitationDetail | null>;
  respondOwned(
    input: RespondToJobInvitationInput,
  ): Promise<JobInvitationCommandResult>;
  sendOwned(input: SendJobInvitationInput): Promise<JobInvitationCommandResult>;
}

export class JobInvitationIdempotencyError extends Error {
  readonly code = "JOB_INVITATION_IDEMPOTENCY_CONFLICT";
}

export function transitionJobInvitation(
  current: JobInvitationState | null,
  command:
    | "CUSTOMER_STOP"
    | "CUSTOMER_WITHDRAW"
    | "DECLINE"
    | "ENGAGE"
    | "EXPIRE"
    | "NOT_SELECT"
    | "SEND"
    | "CRAFTSMAN_WITHDRAW",
): JobInvitationState | null {
  if (current === null && command === "SEND") return "PENDING";
  if (current === "PENDING" && command === "ENGAGE") return "ENGAGED";
  if (current === "PENDING" && command === "DECLINE") return "DECLINED";
  if (current === "PENDING" && command === "EXPIRE") return "EXPIRED";
  if (current === "PENDING" && command === "CUSTOMER_WITHDRAW") {
    return "WITHDRAWN";
  }
  if (current === "ENGAGED" && command === "CUSTOMER_STOP") {
    return "NOT_SELECTED";
  }
  if (current === "ENGAGED" && command === "CRAFTSMAN_WITHDRAW") {
    return "WITHDRAWN";
  }
  if (
    (current === "PENDING" || current === "ENGAGED") &&
    command === "NOT_SELECT"
  ) {
    return "NOT_SELECTED";
  }
  return null;
}

export function assertSendJobInvitationInput(
  input: SendJobInvitationInput,
): void {
  assertRecord(input);
  assertUuid(input.actorUserId, "actorUserId");
  assertUuid(input.commandId, "commandId");
  assertUuid(input.craftsmanProfileId, "craftsmanProfileId");
  assertUuid(input.jobRequestId, "jobRequestId");
}

export function assertRespondToJobInvitationInput(
  input: RespondToJobInvitationInput,
): void {
  assertCommand(input);
  if (
    input.action !== "DECLINE" &&
    input.action !== "ENGAGE" &&
    input.action !== "WITHDRAW"
  ) {
    throw invalid("action");
  }
  const reason = input.declineReason ?? null;
  const note = input.declineNote ?? null;
  if (input.action !== "DECLINE" && (reason !== null || note !== null)) {
    throw invalid("decline");
  }
  if (
    reason !== null &&
    !JOB_INVITATION_DECLINE_REASONS.some((candidate) => candidate === reason)
  ) {
    throw invalid("declineReason");
  }
  if (note !== null) {
    if (
      typeof note !== "string" ||
      note !== note.trim() ||
      note.length < 1 ||
      note.length > 500 ||
      containsControlCharacter(note) ||
      /[^\s@]+@[^\s@]+\.[a-z]{2,}/iu.test(note) ||
      /(^|[^0-9])(\+|00)?[0-9]([\s()./-]*[0-9]){6,}([^0-9]|$)/u.test(note) ||
      /(https?:\/\/|www\.)/iu.test(note)
    ) {
      throw invalid("declineNote");
    }
  }
}

export function assertCloseJobInvitationInput(
  input: CloseJobInvitationInput,
): void {
  assertCommand(input);
  if (input.action !== "STOP_CONSIDERING" && input.action !== "WITHDRAW") {
    throw invalid("action");
  }
}

function assertCommand(input: {
  readonly actorUserId: unknown;
  readonly commandId: unknown;
  readonly expectedRevision: unknown;
  readonly invitationId: unknown;
}): void {
  assertRecord(input);
  assertUuid(input.actorUserId, "actorUserId");
  assertUuid(input.commandId, "commandId");
  assertUuid(input.invitationId, "invitationId");
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    (input.expectedRevision as number) < 1
  ) {
    throw invalid("expectedRevision");
  }
}

function assertRecord(
  value: unknown,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("command");
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
  return new TypeError(`Invalid job invitation field: ${field}.`);
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint < 32 || codePoint === 127);
  });
}
