import type { CraftsmanProfessionId } from "./craftsman-profession.js";
import type { CraftsmanProfileId } from "./craftsman-profile.js";
import type { EntityId } from "./index.js";
import type { UserId } from "./user.js";

export const CREDENTIAL_CLAIM_STATES = Object.freeze([
  "PENDING",
  "APPROVED",
  "REJECTED",
  "REVOKED",
] as const);
export type CredentialClaimState = (typeof CREDENTIAL_CLAIM_STATES)[number];

export const CREDENTIAL_EVIDENCE_REQUIREMENTS = Object.freeze([
  "REQUIRED",
  "OPTIONAL",
] as const);
export type CredentialEvidenceRequirement =
  (typeof CREDENTIAL_EVIDENCE_REQUIREMENTS)[number];

export const CREDENTIAL_REVIEW_REASON_CATEGORIES = Object.freeze([
  "INSUFFICIENT_EVIDENCE",
  "FALSE_QUALIFICATION",
  "FALSE_IDENTITY",
  "MISLEADING_CLAIM",
  "EXPIRED_OR_INVALID",
  "OTHER",
] as const);
export type CredentialReviewReasonCategory =
  (typeof CREDENTIAL_REVIEW_REASON_CATEGORIES)[number];

declare const credentialClaimIdBrand: unique symbol;
export type CredentialClaimId = EntityId & {
  readonly [credentialClaimIdBrand]: "CredentialClaimId";
};

export interface CredentialEvidenceReference {
  readonly attachedAt: Date;
  readonly mediaAssetId: string;
  readonly mediaKind: "DOCUMENT" | "IMAGE";
}

/** Private owner/admin projection. Evidence bytes and storage keys are excluded. */
export interface CredentialClaim {
  readonly id: CredentialClaimId;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly craftsmanProfessionId: CraftsmanProfessionId;
  readonly credentialTypeCode: string;
  readonly evidenceRequirement: CredentialEvidenceRequirement;
  readonly expiresOn: string | null;
  readonly state: CredentialClaimState;
  readonly revision: number;
  readonly evidence: readonly CredentialEvidenceReference[];
  readonly reviewReasonCategory: CredentialReviewReasonCategory | null;
  readonly reviewReason: string | null;
  readonly reviewedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateCredentialClaimInput {
  readonly actorUserId: UserId;
  readonly claimId: CredentialClaimId;
  readonly commandId: string;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly craftsmanProfessionId: CraftsmanProfessionId;
  readonly credentialTypeCode: string;
  readonly expiresOn?: string | null;
}

export interface AttachCredentialEvidenceInput {
  readonly actorUserId: UserId;
  readonly claimId: CredentialClaimId;
  readonly commandId: string;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly expectedRevision: number;
  readonly mediaAssetId: string;
}

export type CredentialReviewCommand = Readonly<
  | {
      claimId: CredentialClaimId;
      commandId: string;
      decision: "APPROVE";
      expectedRevision: number;
    }
  | {
      claimId: CredentialClaimId;
      commandId: string;
      decision: "REJECT" | "REVOKE";
      expectedRevision: number;
      reasonCategory: CredentialReviewReasonCategory;
      reason: string;
    }
>;

export type CreateCredentialClaimResult = Readonly<
  | { status: "APPLIED" | "DEDUPLICATED"; claim: CredentialClaim }
  | {
      status:
        | "PROFILE_UNAVAILABLE"
        | "PROFESSION_UNAVAILABLE"
        | "TYPE_UNAVAILABLE"
        | "CLAIM_ALREADY_EXISTS";
    }
>;

export type AttachCredentialEvidenceResult = Readonly<
  | { status: "APPLIED" | "DEDUPLICATED"; claim: CredentialClaim }
  | {
      status:
        | "PROFILE_UNAVAILABLE"
        | "CLAIM_UNAVAILABLE"
        | "CLAIM_NOT_PENDING"
        | "EVIDENCE_UNAVAILABLE"
        | "EVIDENCE_ALREADY_ATTACHED"
        | "STALE_REVISION";
    }
>;

export interface CredentialClaimPersistence {
  attachEvidence(
    input: AttachCredentialEvidenceInput,
  ): Promise<AttachCredentialEvidenceResult>;
  create(
    input: CreateCredentialClaimInput,
  ): Promise<CreateCredentialClaimResult>;
  listOwned(input: {
    readonly actorUserId: UserId;
    readonly craftsmanProfileId: CraftsmanProfileId;
  }): Promise<readonly CredentialClaim[]>;
}

export class CredentialClaimValidationError extends TypeError {
  readonly code = "INVALID_CREDENTIAL_CLAIM_COMMAND";
}

export function assertCreateCredentialClaimInput(
  input: CreateCredentialClaimInput,
): void {
  assertUuid(input.actorUserId, "actorUserId");
  assertUuid(input.claimId, "claimId");
  assertUuid(input.commandId, "commandId");
  assertUuid(input.craftsmanProfileId, "craftsmanProfileId");
  assertUuid(input.craftsmanProfessionId, "craftsmanProfessionId");
  if (
    normalizeCredentialTypeCode(input.credentialTypeCode) !==
    input.credentialTypeCode
  ) {
    throw invalid("credentialTypeCode");
  }
  if (normalizeExpiry(input.expiresOn) !== (input.expiresOn ?? null)) {
    throw invalid("expiresOn");
  }
}

export function normalizeCreateCredentialClaimInput(
  input: CreateCredentialClaimInput,
): CreateCredentialClaimInput {
  assertUuid(input.actorUserId, "actorUserId");
  assertUuid(input.claimId, "claimId");
  assertUuid(input.commandId, "commandId");
  assertUuid(input.craftsmanProfileId, "craftsmanProfileId");
  assertUuid(input.craftsmanProfessionId, "craftsmanProfessionId");
  return Object.freeze({
    ...input,
    credentialTypeCode: normalizeCredentialTypeCode(input.credentialTypeCode),
    expiresOn: normalizeExpiry(input.expiresOn),
  });
}

export function assertAttachCredentialEvidenceInput(
  input: AttachCredentialEvidenceInput,
): void {
  assertUuid(input.actorUserId, "actorUserId");
  assertUuid(input.claimId, "claimId");
  assertUuid(input.commandId, "commandId");
  assertUuid(input.craftsmanProfileId, "craftsmanProfileId");
  assertUuid(input.mediaAssetId, "mediaAssetId");
  assertPositiveRevision(input.expectedRevision);
}

export function normalizeCredentialReviewCommand(
  input: CredentialReviewCommand,
): CredentialReviewCommand {
  assertUuid(input.claimId, "claimId");
  assertUuid(input.commandId, "commandId");
  assertPositiveRevision(input.expectedRevision);
  if (input.decision === "APPROVE") {
    return Object.freeze({
      claimId: input.claimId,
      commandId: input.commandId,
      decision: input.decision,
      expectedRevision: input.expectedRevision,
    });
  }
  if (input.decision !== "REJECT" && input.decision !== "REVOKE") {
    throw invalid("decision");
  }
  if (!CREDENTIAL_REVIEW_REASON_CATEGORIES.includes(input.reasonCategory)) {
    throw invalid("reasonCategory");
  }
  const reason = normalizeReviewReason(input.reason);
  return Object.freeze({ ...input, reason });
}

export function assertCredentialClaimListInput(input: {
  readonly actorUserId: UserId;
  readonly craftsmanProfileId: CraftsmanProfileId;
}): void {
  assertUuid(input.actorUserId, "actorUserId");
  assertUuid(input.craftsmanProfileId, "craftsmanProfileId");
}

export function isApprovedCredentialCurrentlyValid(
  claim: Pick<CredentialClaim, "expiresOn" | "state">,
  onDate: string,
): boolean {
  const normalizedDate = normalizeExpiry(onDate);
  if (normalizedDate === null) throw invalid("onDate");
  return (
    claim.state === "APPROVED" &&
    (claim.expiresOn === null || claim.expiresOn >= normalizedDate)
  );
}

function normalizeCredentialTypeCode(value: string): string {
  if (typeof value !== "string") throw invalid("credentialTypeCode");
  const normalized = value.trim().toLowerCase();
  if (
    !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(normalized) ||
    normalized.length > 64
  ) {
    throw invalid("credentialTypeCode");
  }
  return normalized;
}

function normalizeExpiry(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw invalid("expiresOn");
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year ?? 0, (month ?? 0) - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) {
    throw invalid("expiresOn");
  }
  return value;
}

function normalizeReviewReason(value: string): string {
  if (typeof value !== "string") throw invalid("reason");
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (
    normalized.length < 8 ||
    normalized.length > 500 ||
    hasControlCharacter(normalized) ||
    /(?:[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|https?:\/\/|www\.|bearer\s+\S+|(?:\+?\d[\d ().-]{6,}\d)|(?:password|heslo|api[ _-]?key|access[ _-]?token|secret))/iu.test(
      normalized,
    )
  ) {
    throw invalid("reason");
  }
  return normalized;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0);
    return point !== undefined && (point <= 31 || point === 127);
  });
}

function assertPositiveRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1)
    throw invalid("expectedRevision");
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

function invalid(field: string): CredentialClaimValidationError {
  return new CredentialClaimValidationError(
    `Invalid credential claim command field: ${field}.`,
  );
}
