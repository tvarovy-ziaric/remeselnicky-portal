import type { CraftsmanProfileId } from "./craftsman-profile.js";
import type { UserId } from "./user.js";

export const PROFILE_REVIEW_STATES = Object.freeze([
  "DRAFT",
  "PENDING",
  "APPROVED",
  "REJECTED",
] as const);
export const PROFILE_OWNER_VISIBILITY_STATES = Object.freeze([
  "PUBLIC",
  "HIDDEN",
] as const);
export const PROFILE_MODERATION_STATES = Object.freeze([
  "ALLOWED",
  "HIDDEN",
  "RESTRICTED",
] as const);
export const PROFILE_READINESS_REQUIREMENTS = Object.freeze([
  "VALID_IDENTITY",
  "ABOUT",
  "ACTIVE_PROFESSION_WITH_DECLARED_LEVEL",
  "BASE_MUNICIPALITY",
  "NORMAL_RADIUS",
] as const);
export const PROFILE_IDENTITY_REVIEW_SYSTEM_REFERENCE =
  "profile-service:identity-change" as const;

export type ProfileReviewState = (typeof PROFILE_REVIEW_STATES)[number];
export type ProfileOwnerVisibilityState =
  (typeof PROFILE_OWNER_VISIBILITY_STATES)[number];
export type ProfileModerationState = (typeof PROFILE_MODERATION_STATES)[number];
export type ProfileReadinessRequirement =
  (typeof PROFILE_READINESS_REQUIREMENTS)[number];

export interface ProfileReviewDecisionFact {
  readonly actorUserId: UserId;
  readonly occurredAt: Date;
}

export interface ProfileRejectionFact extends ProfileReviewDecisionFact {
  readonly reasonCode: string;
  readonly userFacingReason: string;
}

export interface ProfileModerationFact extends ProfileReviewDecisionFact {
  readonly policyVersion: string;
  readonly reasonCategory: string;
  readonly reasonCode: string;
}

export interface CraftsmanPublicationState {
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly revision: number;
  readonly reviewState: ProfileReviewState;
  readonly ownerVisibility: ProfileOwnerVisibilityState;
  readonly moderationState: ProfileModerationState;
  readonly approved: ProfileReviewDecisionFact | null;
  readonly rejection: ProfileRejectionFact | null;
  readonly moderation: ProfileModerationFact | null;
  /** Authoritative boundary only; R1-010 exposes no public profile fields. */
  readonly effectivelyPublic: boolean;
  readonly readiness: Readonly<{
    isReady: boolean;
    missing: readonly ProfileReadinessRequirement[];
  }>;
  readonly changedAt: Date | null;
}

export interface OwnerProfilePublicationCommandInput {
  readonly actorUserId: UserId;
  readonly commandId: string;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly expectedRevision: number;
}

export interface SetOwnerProfileVisibilityInput extends OwnerProfilePublicationCommandInput {
  readonly visibility: ProfileOwnerVisibilityState;
}

export interface PrivilegedProfileCommandInput {
  readonly actorSessionIdDigest: string;
  readonly actorUserId: UserId;
  readonly commandId: string;
  readonly correlationId: string;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly expectedRevision: number;
  readonly reason: string;
}

export interface RejectCraftsmanProfileInput extends PrivilegedProfileCommandInput {
  readonly reasonCode: string;
  readonly userFacingReason: string;
}

export interface SetProfileModerationInput extends PrivilegedProfileCommandInput {
  readonly moderationState: "HIDDEN" | "RESTRICTED";
  readonly policyVersion: string;
  readonly reasonCategory: string;
  readonly reasonCode: string;
}

export interface RestoreProfileModerationInput extends PrivilegedProfileCommandInput {
  readonly policyVersion: string;
  readonly reasonCategory: string;
  readonly reasonCode: string;
}

/** Trusted server-only hook invoked by an identity-change command after it commits. */
export interface RequireProfileIdentityReviewInput {
  readonly commandId: string;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly expectedRevision: number;
  readonly reasonCode: string;
  readonly ruleReference: string;
}

export type ProfilePublicationCommandResult = Readonly<
  | {
      status: "APPLIED" | "DEDUPLICATED" | "UNCHANGED";
      publication: CraftsmanPublicationState;
    }
  | {
      status:
        | "PROFILE_UNAVAILABLE"
        | "NOT_READY"
        | "STALE_REVISION"
        | "INVALID_TRANSITION"
        | "ADMIN_AUTHORIZATION_REQUIRED";
      readiness?: CraftsmanPublicationState["readiness"];
    }
>;

export interface CraftsmanPublicationPersistence {
  submitForReview(
    input: OwnerProfilePublicationCommandInput,
  ): Promise<ProfilePublicationCommandResult>;
  setOwnerVisibility(
    input: SetOwnerProfileVisibilityInput,
  ): Promise<ProfilePublicationCommandResult>;
  approve(
    input: PrivilegedProfileCommandInput,
  ): Promise<ProfilePublicationCommandResult>;
  reject(
    input: RejectCraftsmanProfileInput,
  ): Promise<ProfilePublicationCommandResult>;
  setModeration(
    input: SetProfileModerationInput,
  ): Promise<ProfilePublicationCommandResult>;
  restoreModeration(
    input: RestoreProfileModerationInput,
  ): Promise<ProfilePublicationCommandResult>;
  requireIdentityReview(
    input: RequireProfileIdentityReviewInput,
  ): Promise<ProfilePublicationCommandResult>;
  findOwned(input: {
    readonly actorUserId: UserId;
    readonly craftsmanProfileId: CraftsmanProfileId;
  }): Promise<CraftsmanPublicationState | null>;
}

export class CraftsmanPublicationValidationError extends TypeError {
  readonly code = "INVALID_CRAFTSMAN_PUBLICATION_COMMAND";
}

export function assertOwnerProfilePublicationCommandInput(
  input: OwnerProfilePublicationCommandInput,
): void {
  assertCommandBase(input);
}

export function assertSetOwnerProfileVisibilityInput(
  input: SetOwnerProfileVisibilityInput,
): void {
  assertCommandBase(input);
  if (!PROFILE_OWNER_VISIBILITY_STATES.includes(input.visibility)) {
    throw invalid("visibility");
  }
}

export function assertPrivilegedProfileCommandInput(
  input: PrivilegedProfileCommandInput,
): void {
  assertCommandBase(input);
  assertUuid(input.correlationId, "correlationId");
  if (!/^[0-9a-f]{64}$/u.test(input.actorSessionIdDigest)) {
    throw invalid("actorSessionIdDigest");
  }
  assertSafeReason(input.reason, "reason", 8, 500);
}

export function assertRejectCraftsmanProfileInput(
  input: RejectCraftsmanProfileInput,
): void {
  assertPrivilegedProfileCommandInput(input);
  assertStableCode(input.reasonCode, "reasonCode");
  assertSafeReason(input.userFacingReason, "userFacingReason", 8, 500);
}

export function assertSetProfileModerationInput(
  input: SetProfileModerationInput,
): void {
  assertPrivilegedProfileCommandInput(input);
  if (!(["HIDDEN", "RESTRICTED"] as const).includes(input.moderationState)) {
    throw invalid("moderationState");
  }
  assertModerationReason(input);
}

export function assertRestoreProfileModerationInput(
  input: RestoreProfileModerationInput,
): void {
  assertPrivilegedProfileCommandInput(input);
  assertModerationReason(input);
}

export function assertRequireProfileIdentityReviewInput(
  input: RequireProfileIdentityReviewInput,
): void {
  assertUuid(input.commandId, "commandId");
  assertUuid(input.craftsmanProfileId, "craftsmanProfileId");
  assertRevision(input.expectedRevision);
  assertStableCode(input.reasonCode, "reasonCode");
  if (!/^[A-Z][A-Z0-9_.:-]{2,95}$/u.test(input.ruleReference)) {
    throw invalid("ruleReference");
  }
}

export function assertCraftsmanPublicationReadInput(input: {
  readonly actorUserId: UserId;
  readonly craftsmanProfileId: CraftsmanProfileId;
}): void {
  assertUuid(input.actorUserId, "actorUserId");
  assertUuid(input.craftsmanProfileId, "craftsmanProfileId");
}

function assertModerationReason(input: {
  readonly policyVersion: string;
  readonly reasonCategory: string;
  readonly reasonCode: string;
}): void {
  assertStableCode(input.reasonCategory, "reasonCategory");
  assertStableCode(input.reasonCode, "reasonCode");
  if (!/^[A-Z][A-Z0-9_.:-]{2,95}$/u.test(input.policyVersion)) {
    throw invalid("policyVersion");
  }
}

function assertCommandBase(input: OwnerProfilePublicationCommandInput): void {
  assertUuid(input.actorUserId, "actorUserId");
  assertUuid(input.commandId, "commandId");
  assertUuid(input.craftsmanProfileId, "craftsmanProfileId");
  assertRevision(input.expectedRevision);
}

function assertRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalid("expectedRevision");
  }
}

function assertStableCode(value: string, field: string): void {
  if (!/^[A-Z][A-Z0-9_.:-]{2,95}$/u.test(value)) throw invalid(field);
}

function assertSafeReason(
  value: string,
  field: string,
  minimum: number,
  maximum: number,
): void {
  if (
    value !== value.trim() ||
    value.length < minimum ||
    value.length > maximum ||
    /(?:https?:\/\/|www\.)/iu.test(value) ||
    /\b[^\s@]+@[^\s@]+\.[a-z]{2,}\b/iu.test(value) ||
    /\+?\d(?:[\s().-]*\d){6,}/u.test(value)
  ) {
    throw invalid(field);
  }
}

function assertUuid(value: string, field: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    throw invalid(field);
  }
}

function invalid(field: string): CraftsmanPublicationValidationError {
  return new CraftsmanPublicationValidationError(
    `Invalid craftsman publication command field: ${field}.`,
  );
}
