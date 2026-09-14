import type { CraftsmanProfessionId } from "./craftsman-profession.js";
import type { CraftsmanProfileId } from "./craftsman-profile.js";
import type { EntityId } from "./index.js";
import type { UserId } from "./user.js";

export const CRAFTSMAN_CAPABILITY_STATES = Object.freeze([
  "ACTIVE",
  "INACTIVE",
] as const);
export const SKILL_IDENTITY_KINDS = Object.freeze([
  "CANONICAL",
  "CUSTOM",
] as const);

export type CraftsmanCapabilityState =
  (typeof CRAFTSMAN_CAPABILITY_STATES)[number];
export type SkillIdentityKind = (typeof SKILL_IDENTITY_KINDS)[number];

declare const craftsmanSpecializationIdBrand: unique symbol;
export type CraftsmanSpecializationId = EntityId & {
  readonly [craftsmanSpecializationIdBrand]: "CraftsmanSpecializationId";
};
declare const craftsmanSkillIdBrand: unique symbol;
export type CraftsmanSkillId = EntityId & {
  readonly [craftsmanSkillIdBrand]: "CraftsmanSkillId";
};

/** Presentation data deliberately keeps owner declaration and evidence apart. */
export interface CapabilityEvidencePresentation {
  readonly status: "SUPPORTED_BY_EVIDENCE";
  readonly supportedAt: Date;
}

export interface CraftsmanSpecialization {
  readonly id: CraftsmanSpecializationId;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly craftsmanProfessionId: CraftsmanProfessionId;
  readonly taxonomyReleaseId: string;
  readonly specializationCode: string;
  readonly state: CraftsmanCapabilityState;
  readonly declarationSource: "CRAFTSMAN";
  readonly evidence: CapabilityEvidencePresentation | null;
  readonly createdAt: Date;
  readonly deactivatedAt: Date | null;
}

export interface CraftsmanSkill {
  readonly id: CraftsmanSkillId;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly identityKind: SkillIdentityKind;
  readonly skillCatalogReleaseId: string | null;
  readonly canonicalSkillCode: string | null;
  /** Exact accepted wording; it remains present after a later canonical mapping. */
  readonly retainedCustomText: string | null;
  readonly mappedSkillCatalogReleaseId: string | null;
  readonly mappedCanonicalSkillCode: string | null;
  readonly mappingRevision: number;
  readonly professionIds: readonly CraftsmanProfessionId[];
  readonly state: CraftsmanCapabilityState;
  readonly declarationSource: "CRAFTSMAN";
  readonly evidence: CapabilityEvidencePresentation | null;
  /** Optional profile richness is never itself a reputation or ranking signal. */
  readonly rankingSignal: "NONE";
  readonly createdAt: Date;
  readonly deactivatedAt: Date | null;
}

export interface AddCraftsmanSpecializationInput {
  readonly actorUserId: UserId;
  readonly commandId: string;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly craftsmanProfessionId: CraftsmanProfessionId;
  readonly craftsmanSpecializationId: CraftsmanSpecializationId;
  readonly taxonomyReleaseId: string;
  readonly specializationCode: string;
}

export interface AddCanonicalCraftsmanSkillInput {
  readonly actorUserId: UserId;
  readonly commandId: string;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly craftsmanSkillId: CraftsmanSkillId;
  readonly identityKind: "CANONICAL";
  readonly skillCatalogReleaseId: string;
  readonly canonicalSkillCode: string;
  readonly professionIds: readonly CraftsmanProfessionId[];
}

export interface AddCustomCraftsmanSkillInput {
  readonly actorUserId: UserId;
  readonly commandId: string;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly craftsmanSkillId: CraftsmanSkillId;
  readonly identityKind: "CUSTOM";
  readonly customText: string;
  readonly professionIds: readonly CraftsmanProfessionId[];
}

export type AddCraftsmanSkillInput =
  AddCanonicalCraftsmanSkillInput | AddCustomCraftsmanSkillInput;

export interface DeactivateCraftsmanCapabilityInput {
  readonly actorUserId: UserId;
  readonly commandId: string;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly targetId: CraftsmanSpecializationId | CraftsmanSkillId;
}

export interface MapCustomCraftsmanSkillInput {
  readonly actorUserId: UserId;
  readonly commandId: string;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly craftsmanSkillId: CraftsmanSkillId;
  readonly expectedMappingRevision: number;
  readonly skillCatalogReleaseId: string;
  readonly canonicalSkillCode: string;
}

export type AddCraftsmanSpecializationResult = Readonly<
  | {
      readonly status: "APPLIED" | "DEDUPLICATED";
      readonly specialization: CraftsmanSpecialization;
    }
  | {
      readonly status:
        | "PROFILE_UNAVAILABLE"
        | "PROFESSION_NOT_ACTIVE"
        | "SPECIALIZATION_NOT_ACTIVE"
        | "ALREADY_ACTIVE";
    }
>;

export type AddCraftsmanSkillResult = Readonly<
  | {
      readonly status: "APPLIED" | "DEDUPLICATED";
      readonly skill: CraftsmanSkill;
    }
  | {
      readonly status:
        | "PROFILE_UNAVAILABLE"
        | "PROFESSION_NOT_ACTIVE"
        | "SKILL_NOT_ACTIVE"
        | "SKILL_NOT_RELEVANT"
        | "ALREADY_ACTIVE";
    }
>;

export type DeactivateCraftsmanSpecializationResult = Readonly<
  | {
      readonly status: "APPLIED" | "DEDUPLICATED";
      readonly specialization: CraftsmanSpecialization;
    }
  | { readonly status: "PROFILE_UNAVAILABLE" | "TARGET_NOT_ACTIVE" }
>;

export type DeactivateCraftsmanSkillResult = Readonly<
  | {
      readonly status: "APPLIED" | "DEDUPLICATED";
      readonly skill: CraftsmanSkill;
    }
  | { readonly status: "PROFILE_UNAVAILABLE" | "TARGET_NOT_ACTIVE" }
>;

export type MapCustomCraftsmanSkillResult = Readonly<
  | {
      readonly status: "APPLIED" | "DEDUPLICATED";
      readonly skill: CraftsmanSkill;
    }
  | {
      readonly status:
        | "PROFILE_UNAVAILABLE"
        | "TARGET_NOT_ACTIVE"
        | "NOT_CUSTOM"
        | "STALE_REVISION"
        | "MAPPING_UNCHANGED"
        | "SKILL_NOT_ACTIVE"
        | "SKILL_NOT_RELEVANT";
    }
>;

export interface CraftsmanCapabilityPersistence {
  addSpecialization(
    input: AddCraftsmanSpecializationInput,
  ): Promise<AddCraftsmanSpecializationResult>;
  addSkill(input: AddCraftsmanSkillInput): Promise<AddCraftsmanSkillResult>;
  deactivateSpecialization(
    input: DeactivateCraftsmanCapabilityInput,
  ): Promise<DeactivateCraftsmanSpecializationResult>;
  deactivateSkill(
    input: DeactivateCraftsmanCapabilityInput,
  ): Promise<DeactivateCraftsmanSkillResult>;
  mapCustomSkill(
    input: MapCustomCraftsmanSkillInput,
  ): Promise<MapCustomCraftsmanSkillResult>;
  listOwned(input: {
    readonly actorUserId: UserId;
    readonly craftsmanProfileId: CraftsmanProfileId;
  }): Promise<{
    readonly skills: readonly CraftsmanSkill[];
    readonly specializations: readonly CraftsmanSpecialization[];
  }>;
}

export class CraftsmanCapabilityValidationError extends TypeError {
  readonly code = "INVALID_CRAFTSMAN_CAPABILITY_COMMAND";
}

export function assertAddCraftsmanSpecializationInput(
  input: AddCraftsmanSpecializationInput,
): void {
  assertUuid(input.actorUserId, "actorUserId");
  assertUuid(input.commandId, "commandId");
  assertUuid(input.craftsmanProfileId, "craftsmanProfileId");
  assertUuid(input.craftsmanProfessionId, "craftsmanProfessionId");
  assertUuid(input.craftsmanSpecializationId, "craftsmanSpecializationId");
  assertUuid(input.taxonomyReleaseId, "taxonomyReleaseId");
  assertCode(input.specializationCode, "specializationCode", "SPEC");
}

export function assertAddCraftsmanSkillInput(
  input: AddCraftsmanSkillInput,
): void {
  assertUuid(input.actorUserId, "actorUserId");
  assertUuid(input.commandId, "commandId");
  assertUuid(input.craftsmanProfileId, "craftsmanProfileId");
  assertUuid(input.craftsmanSkillId, "craftsmanSkillId");
  assertProfessionIds(input.professionIds);
  if (input.identityKind === "CANONICAL") {
    assertUuid(input.skillCatalogReleaseId, "skillCatalogReleaseId");
    assertCode(input.canonicalSkillCode, "canonicalSkillCode", "SKILL");
  } else if (input.identityKind === "CUSTOM") {
    assertCustomText(input.customText);
  } else {
    throw invalid("identityKind");
  }
}

export function assertDeactivateCraftsmanCapabilityInput(
  input: DeactivateCraftsmanCapabilityInput,
): void {
  assertUuid(input.actorUserId, "actorUserId");
  assertUuid(input.commandId, "commandId");
  assertUuid(input.craftsmanProfileId, "craftsmanProfileId");
  assertUuid(input.targetId, "targetId");
}

export function assertMapCustomCraftsmanSkillInput(
  input: MapCustomCraftsmanSkillInput,
): void {
  assertUuid(input.actorUserId, "actorUserId");
  assertUuid(input.commandId, "commandId");
  assertUuid(input.craftsmanProfileId, "craftsmanProfileId");
  assertUuid(input.craftsmanSkillId, "craftsmanSkillId");
  assertUuid(input.skillCatalogReleaseId, "skillCatalogReleaseId");
  assertCode(input.canonicalSkillCode, "canonicalSkillCode", "SKILL");
  if (
    !Number.isSafeInteger(input.expectedMappingRevision) ||
    input.expectedMappingRevision < 0
  ) {
    throw invalid("expectedMappingRevision");
  }
}

export function assertCraftsmanCapabilityListInput(input: {
  readonly actorUserId: UserId;
  readonly craftsmanProfileId: CraftsmanProfileId;
}): void {
  assertUuid(input.actorUserId, "actorUserId");
  assertUuid(input.craftsmanProfileId, "craftsmanProfileId");
}

export function isCraftsmanCapabilityPublicTextSafe(value: string): boolean {
  const patterns = [
    /[\p{L}\d._%+-]+@[\p{L}\d.-]+\.[\p{L}]{2,}/iu,
    /@[\p{L}\d_]{2,}/iu,
    /(?:\+|00)?\d(?:[\s()./-]*\d){6,}/u,
    /\b(?:https?:\/\/|www\.)/iu,
    /\b[\p{L}\d][\p{L}\d-]{0,62}(?:\.[\p{L}\d-]{1,63})*\.[\p{L}]{2,24}\b/iu,
    /\b\d{3}\s?\d{2}\b/u,
    /(?:\b(?:adresa|ulica|námestie|trieda|číslo domu|číslo bytu)\b|\b(?:ul|nám)\.)/iu,
    /\b(?:heslo|password|api[ _-]?key|access[ _-]?token|secret|tajný kľúč)\b/iu,
  ];
  return (
    !/\p{Cc}/u.test(value) && !patterns.some((pattern) => pattern.test(value))
  );
}

function assertProfessionIds(values: readonly CraftsmanProfessionId[]): void {
  if (values.length < 1 || values.length > 20) throw invalid("professionIds");
  const unique = new Set(values);
  if (unique.size !== values.length) throw invalid("professionIds");
  for (const value of values) assertUuid(value, "professionIds");
}

function assertCustomText(value: string): void {
  if (
    value !== value.trim() ||
    value.length < 2 ||
    value.length > 160 ||
    !isCraftsmanCapabilityPublicTextSafe(value)
  ) {
    throw invalid("customText");
  }
}

function assertCode(value: string, field: string, prefix: string): void {
  const pattern = new RegExp(
    `^(?:${prefix}|TEST):[A-Z0-9][A-Z0-9_]{1,62}$`,
    "u",
  );
  if (!pattern.test(value)) throw invalid(field);
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

function invalid(field: string): CraftsmanCapabilityValidationError {
  return new CraftsmanCapabilityValidationError(
    `Invalid craftsman capability command field: ${field}.`,
  );
}
