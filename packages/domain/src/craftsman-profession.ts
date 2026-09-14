import type { CraftsmanProfileId } from "./craftsman-profile.js";
import type { EntityId } from "./index.js";
import type { UserId } from "./user.js";

export const PROFESSION_PROFICIENCY_LEVELS = Object.freeze([
  "BEGINNER",
  "ADVANCED",
  "MASTER",
] as const);
export const CRAFTSMAN_PROFESSION_STATES = Object.freeze([
  "ACTIVE",
  "INACTIVE",
] as const);

export type ProfessionProficiencyLevel =
  (typeof PROFESSION_PROFICIENCY_LEVELS)[number];
export type CraftsmanProfessionState =
  (typeof CRAFTSMAN_PROFESSION_STATES)[number];

declare const craftsmanProfessionIdBrand: unique symbol;
export type CraftsmanProfessionId = EntityId & {
  readonly [craftsmanProfessionIdBrand]: "CraftsmanProfessionId";
};

/**
 * One profession-specific capability of a profile. Taxonomy identity is an
 * immutable reference to the governed release; labels and taxonomy state are
 * never copied into this aggregate.
 */
export interface CraftsmanProfession {
  readonly id: CraftsmanProfessionId;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly taxonomyReleaseId: string;
  readonly professionCode: string;
  readonly state: CraftsmanProfessionState;
  readonly declaredLevel: ProfessionProficiencyLevel;
  readonly declaredLevelRevision: number;
  readonly declaredLevelChangedAt: Date;
  /** Reserved for a future evidence-adjudication projection; owner commands cannot write it. */
  readonly evidenceSupportedLevel: ProfessionProficiencyLevel | null;
  readonly evidenceSupportedAt: Date | null;
  readonly createdAt: Date;
  readonly deactivatedAt: Date | null;
}

export interface AssignCraftsmanProfessionInput {
  readonly commandId: string;
  readonly craftsmanProfessionId: CraftsmanProfessionId;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly actorUserId: UserId;
  readonly taxonomyReleaseId: string;
  readonly professionCode: string;
  readonly declaredLevel: ProfessionProficiencyLevel;
}

export interface ChangeDeclaredProficiencyInput {
  readonly commandId: string;
  readonly craftsmanProfessionId: CraftsmanProfessionId;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly actorUserId: UserId;
  readonly expectedDeclaredLevelRevision: number;
  readonly declaredLevel: ProfessionProficiencyLevel;
}

export interface DeactivateCraftsmanProfessionInput {
  readonly commandId: string;
  readonly craftsmanProfessionId: CraftsmanProfessionId;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly actorUserId: UserId;
}

export type AssignCraftsmanProfessionResult = Readonly<
  | {
      status: "APPLIED" | "DEDUPLICATED";
      profession: CraftsmanProfession;
    }
  | {
      status:
        | "PROFILE_UNAVAILABLE"
        | "TAXONOMY_RELEASE_NOT_CURRENT"
        | "PROFESSION_NOT_ACTIVE"
        | "ALREADY_ACTIVE";
    }
>;

export type ChangeDeclaredProficiencyResult = Readonly<
  | {
      status: "APPLIED" | "DEDUPLICATED";
      profession: CraftsmanProfession;
    }
  | {
      status:
        | "PROFILE_UNAVAILABLE"
        | "ASSIGNMENT_NOT_ACTIVE"
        | "STALE_REVISION"
        | "LEVEL_UNCHANGED";
    }
>;

export type DeactivateCraftsmanProfessionResult = Readonly<
  | {
      status: "APPLIED" | "DEDUPLICATED";
      profession: CraftsmanProfession;
    }
  | { status: "PROFILE_UNAVAILABLE" | "ASSIGNMENT_NOT_ACTIVE" }
>;

export interface CraftsmanProfessionPersistence {
  assign(
    input: AssignCraftsmanProfessionInput,
  ): Promise<AssignCraftsmanProfessionResult>;
  changeDeclaredLevel(
    input: ChangeDeclaredProficiencyInput,
  ): Promise<ChangeDeclaredProficiencyResult>;
  deactivate(
    input: DeactivateCraftsmanProfessionInput,
  ): Promise<DeactivateCraftsmanProfessionResult>;
  listOwned(input: {
    readonly actorUserId: UserId;
    readonly craftsmanProfileId: CraftsmanProfileId;
  }): Promise<readonly CraftsmanProfession[]>;
}

export class CraftsmanProfessionValidationError extends TypeError {
  readonly code = "INVALID_CRAFTSMAN_PROFESSION_COMMAND";
}

export function assertAssignCraftsmanProfessionInput(
  input: AssignCraftsmanProfessionInput,
): void {
  assertUuid(input.commandId, "commandId");
  assertUuid(input.craftsmanProfessionId, "craftsmanProfessionId");
  assertUuid(input.craftsmanProfileId, "craftsmanProfileId");
  assertUuid(input.actorUserId, "actorUserId");
  assertUuid(input.taxonomyReleaseId, "taxonomyReleaseId");
  assertProfessionCode(input.professionCode);
  assertProficiencyLevel(input.declaredLevel);
}

export function assertChangeDeclaredProficiencyInput(
  input: ChangeDeclaredProficiencyInput,
): void {
  assertUuid(input.commandId, "commandId");
  assertUuid(input.craftsmanProfessionId, "craftsmanProfessionId");
  assertUuid(input.craftsmanProfileId, "craftsmanProfileId");
  assertUuid(input.actorUserId, "actorUserId");
  if (
    !Number.isSafeInteger(input.expectedDeclaredLevelRevision) ||
    input.expectedDeclaredLevelRevision < 1
  ) {
    throw invalid("expectedDeclaredLevelRevision");
  }
  assertProficiencyLevel(input.declaredLevel);
}

export function assertDeactivateCraftsmanProfessionInput(
  input: DeactivateCraftsmanProfessionInput,
): void {
  assertUuid(input.commandId, "commandId");
  assertUuid(input.craftsmanProfessionId, "craftsmanProfessionId");
  assertUuid(input.craftsmanProfileId, "craftsmanProfileId");
  assertUuid(input.actorUserId, "actorUserId");
}

export function assertCraftsmanProfessionListInput(input: {
  readonly actorUserId: UserId;
  readonly craftsmanProfileId: CraftsmanProfileId;
}): void {
  assertUuid(input.actorUserId, "actorUserId");
  assertUuid(input.craftsmanProfileId, "craftsmanProfileId");
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

function assertProfessionCode(value: string): void {
  if (!/^(PROF|TEST):[A-Z0-9][A-Z0-9_]{1,62}$/u.test(value)) {
    throw invalid("professionCode");
  }
}

function assertProficiencyLevel(value: unknown): void {
  if (!PROFESSION_PROFICIENCY_LEVELS.some((candidate) => candidate === value)) {
    throw invalid("declaredLevel");
  }
}

function invalid(field: string): CraftsmanProfessionValidationError {
  return new CraftsmanProfessionValidationError(
    `Invalid craftsman profession command field: ${field}.`,
  );
}
