import type { EntityId } from "./index.js";
import type { UserId } from "./user.js";

export const CRAFTSMAN_PROFILE_TYPES = Object.freeze([
  "INDIVIDUAL",
  "COMPANY",
] as const);

export type CraftsmanProfileType = (typeof CRAFTSMAN_PROFILE_TYPES)[number];

declare const craftsmanProfileIdBrand: unique symbol;

export type CraftsmanProfileId = EntityId & {
  readonly [craftsmanProfileIdBrand]: "CraftsmanProfileId";
};

export interface VerificationFact {
  readonly reference: string;
  readonly verifiedAt: Date;
}

interface CraftsmanProfileBase {
  readonly id: CraftsmanProfileId;
  readonly ownerUserId: UserId;
  readonly about: string | null;
  /**
   * Verification is server-authored provenance. Draft commands can only clear
   * stale evidence by changing the identity it supported; they cannot grant it.
   */
  readonly identityVerification: VerificationFact | null;
  readonly revision: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface IndividualCraftsmanProfile extends CraftsmanProfileBase {
  readonly profileType: "INDIVIDUAL";
  readonly realFirstName: string | null;
  readonly realLastName: string | null;
  readonly nickname: string | null;
}

export interface CompanyCraftsmanProfile extends CraftsmanProfileBase {
  readonly profileType: "COMPANY";
  readonly officialCompanyName: string | null;
  readonly companyRegistrationNumber: string | null;
  readonly companyRegistrationVerification: VerificationFact | null;
}

/**
 * R1-003 exposes only an owner-scoped private draft. Public state and public
 * projections intentionally belong to R1-010/R1-011.
 */
export type CraftsmanProfile =
  IndividualCraftsmanProfile | CompanyCraftsmanProfile;

export type CreateCraftsmanProfileDraftInput = Readonly<
  | {
      /** Authenticated session actor; persistence derives owner from this ID. */
      actorUserId: UserId;
      profileType: "INDIVIDUAL";
      realFirstName?: string | null;
      realLastName?: string | null;
      nickname?: string | null;
      about?: string | null;
    }
  | {
      /** Authenticated session actor; persistence derives owner from this ID. */
      actorUserId: UserId;
      profileType: "COMPANY";
      officialCompanyName?: string | null;
      companyRegistrationNumber?: string | null;
      about?: string | null;
    }
>;

export type ReplaceCraftsmanProfileDraftInput = Readonly<
  | {
      actorUserId: UserId;
      profileId: CraftsmanProfileId;
      expectedRevision: number;
      profileType: "INDIVIDUAL";
      realFirstName: string | null;
      realLastName: string | null;
      nickname: string | null;
      about: string | null;
    }
  | {
      actorUserId: UserId;
      profileId: CraftsmanProfileId;
      expectedRevision: number;
      profileType: "COMPANY";
      officialCompanyName: string | null;
      companyRegistrationNumber: string | null;
      about: string | null;
    }
>;

export type CreateCraftsmanProfileDraftResult = Readonly<
  | { status: "CREATED" | "UNCHANGED"; profile: CraftsmanProfile }
  | { status: "ALREADY_EXISTS" | "OWNER_NOT_ACTIVE" }
>;

export type ReplaceCraftsmanProfileDraftResult = Readonly<
  | { status: "UPDATED" | "UNCHANGED"; profile: CraftsmanProfile }
  | {
      status:
        | "NOT_FOUND"
        | "OWNER_NOT_ACTIVE"
        | "PROFILE_TYPE_MISMATCH"
        | "STALE_REVISION";
    }
>;

export interface CraftsmanProfilePersistence {
  readonly createPrivateDraft: (
    input: CreateCraftsmanProfileDraftInput,
  ) => Promise<CreateCraftsmanProfileDraftResult>;
  readonly findOwnedPrivateDraft: (
    actorUserId: UserId,
    profileId: CraftsmanProfileId,
  ) => Promise<CraftsmanProfile | null>;
  readonly replacePrivateDraft: (
    input: ReplaceCraftsmanProfileDraftInput,
  ) => Promise<ReplaceCraftsmanProfileDraftResult>;
}

export interface CraftsmanProfileService {
  createPrivateDraft(
    input: CreateCraftsmanProfileDraftInput,
  ): Promise<CreateCraftsmanProfileDraftResult>;
  getPrivateDraft(input: {
    readonly actorUserId: UserId;
    readonly profileId: CraftsmanProfileId;
  }): Promise<CraftsmanProfile | null>;
  replacePrivateDraft(
    input: ReplaceCraftsmanProfileDraftInput,
  ): Promise<ReplaceCraftsmanProfileDraftResult>;
}

export class CraftsmanProfileValidationError extends TypeError {
  readonly code = "INVALID_CRAFTSMAN_PROFILE_DRAFT";
}

export function createCraftsmanProfileService(
  persistence: CraftsmanProfilePersistence,
): CraftsmanProfileService {
  const service: CraftsmanProfileService = {
    createPrivateDraft(input) {
      return persistence.createPrivateDraft(normalizeCreateInput(input));
    },
    getPrivateDraft(input) {
      assertUuid(input.actorUserId, "actorUserId");
      assertUuid(input.profileId, "profileId");
      return persistence.findOwnedPrivateDraft(
        input.actorUserId,
        input.profileId,
      );
    },
    replacePrivateDraft(input) {
      return persistence.replacePrivateDraft(normalizeReplaceInput(input));
    },
  };
  return Object.freeze(service);
}

export function isCraftsmanProfileType(
  value: unknown,
): value is CraftsmanProfileType {
  return CRAFTSMAN_PROFILE_TYPES.some((type) => type === value);
}

function normalizeCreateInput(
  input: CreateCraftsmanProfileDraftInput,
): CreateCraftsmanProfileDraftInput {
  assertUuid(input.actorUserId, "actorUserId");
  if (!isCraftsmanProfileType(input.profileType)) {
    throw validationError("profileType must be INDIVIDUAL or COMPANY");
  }
  if (input.profileType === "INDIVIDUAL") {
    const realFirstName = normalizeOptionalText(
      input.realFirstName,
      "realFirstName",
      120,
    );
    const realLastName = normalizeOptionalText(
      input.realLastName,
      "realLastName",
      120,
    );
    assertPaired(realFirstName, realLastName, "real identity names");
    return Object.freeze({
      about: normalizeOptionalAbout(input.about),
      nickname: normalizeOptionalText(input.nickname, "nickname", 80),
      actorUserId: input.actorUserId,
      profileType: input.profileType,
      realFirstName,
      realLastName,
    });
  }
  return Object.freeze({
    about: normalizeOptionalAbout(input.about),
    companyRegistrationNumber: normalizeRegistrationNumber(
      input.companyRegistrationNumber,
    ),
    officialCompanyName: normalizeOptionalText(
      input.officialCompanyName,
      "officialCompanyName",
      200,
    ),
    actorUserId: input.actorUserId,
    profileType: input.profileType,
  });
}

function normalizeReplaceInput(
  input: ReplaceCraftsmanProfileDraftInput,
): ReplaceCraftsmanProfileDraftInput {
  assertUuid(input.actorUserId, "actorUserId");
  assertUuid(input.profileId, "profileId");
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 1
  ) {
    throw validationError("expectedRevision must be a positive safe integer");
  }
  if (!isCraftsmanProfileType(input.profileType)) {
    throw validationError("profileType must be INDIVIDUAL or COMPANY");
  }
  if (input.profileType === "INDIVIDUAL") {
    const realFirstName = normalizeOptionalText(
      input.realFirstName,
      "realFirstName",
      120,
    );
    const realLastName = normalizeOptionalText(
      input.realLastName,
      "realLastName",
      120,
    );
    assertPaired(realFirstName, realLastName, "real identity names");
    return Object.freeze({
      about: normalizeOptionalAbout(input.about),
      actorUserId: input.actorUserId,
      expectedRevision: input.expectedRevision,
      nickname: normalizeOptionalText(input.nickname, "nickname", 80),
      profileId: input.profileId,
      profileType: input.profileType,
      realFirstName,
      realLastName,
    });
  }
  return Object.freeze({
    about: normalizeOptionalAbout(input.about),
    actorUserId: input.actorUserId,
    companyRegistrationNumber: normalizeRegistrationNumber(
      input.companyRegistrationNumber,
    ),
    expectedRevision: input.expectedRevision,
    officialCompanyName: normalizeOptionalText(
      input.officialCompanyName,
      "officialCompanyName",
      200,
    ),
    profileId: input.profileId,
    profileType: input.profileType,
  });
}

function normalizeOptionalText(
  value: string | null | undefined,
  field: string,
  maxLength: number,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw validationError(`${field} must be text or null`);
  }
  if (hasControlCharacter(value)) {
    throw validationError(`${field} contains invalid or excessive text`);
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    return null;
  }
  if (normalized.length > maxLength) {
    throw validationError(`${field} contains invalid or excessive text`);
  }
  return normalized;
}

function normalizeOptionalAbout(
  value: string | null | undefined,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw validationError("about must be text or null");
  }
  const newlineNormalized = value.replace(/\r\n?/gu, "\n");
  if (hasNonLineFeedControlCharacter(newlineNormalized)) {
    throw validationError("about contains invalid or excessive text");
  }
  const normalized = newlineNormalized.trim();
  if (normalized.length === 0) {
    return null;
  }
  if (normalized.length > 2_000) {
    throw validationError("about contains invalid or excessive text");
  }
  return normalized;
}

function hasNonLineFeedControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint !== undefined &&
      ((codePoint <= 31 && codePoint !== 10) || codePoint === 127)
    );
  });
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
}

function normalizeRegistrationNumber(
  value: string | null | undefined,
): string | null {
  const normalized = normalizeOptionalText(
    value,
    "companyRegistrationNumber",
    8,
  );
  if (normalized !== null && !/^\d{8}$/u.test(normalized)) {
    throw validationError("companyRegistrationNumber must contain 8 digits");
  }
  return normalized;
}

function assertPaired(
  first: string | null,
  second: string | null,
  field: string,
): void {
  if ((first === null) !== (second === null)) {
    throw validationError(`${field} must be supplied or cleared together`);
  }
}

function assertUuid(value: string, field: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    throw validationError(`${field} must be a UUID`);
  }
}

function validationError(message: string): CraftsmanProfileValidationError {
  return new CraftsmanProfileValidationError(message);
}
