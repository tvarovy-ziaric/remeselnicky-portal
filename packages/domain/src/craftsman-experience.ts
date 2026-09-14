import type { CraftsmanProfileId } from "./craftsman-profile.js";
import type { EntityId } from "./index.js";
import type { UserId } from "./user.js";

declare const craftsmanExperienceRevisionIdBrand: unique symbol;
export type CraftsmanExperienceRevisionId = EntityId & {
  readonly [craftsmanExperienceRevisionIdBrand]: "CraftsmanExperienceRevisionId";
};

/** Private owner projection of optional, explicitly self-declared context. */
export interface CraftsmanExperience {
  readonly id: CraftsmanExperienceRevisionId;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly workingSinceYear: number | null;
  readonly provenance: "SELF_DECLARED";
  readonly revision: number;
  readonly recordedAt: Date;
}

export interface ReplaceCraftsmanExperienceInput {
  readonly actorUserId: UserId;
  readonly commandId: string;
  readonly craftsmanProfileId: CraftsmanProfileId;
  /** Zero addresses the profile state before its first applied revision. */
  readonly expectedRevision: number;
  /** Null explicitly clears previously supplied context. */
  readonly workingSinceYear: number | null;
}

export type ReplaceCraftsmanExperienceResult = Readonly<
  | {
      status: "APPLIED" | "DEDUPLICATED" | "UNCHANGED";
      experience: CraftsmanExperience | null;
    }
  | { status: "PROFILE_UNAVAILABLE" | "STALE_REVISION" }
>;

export interface CraftsmanExperiencePersistence {
  replaceOwnedDraft(
    input: ReplaceCraftsmanExperienceInput,
  ): Promise<ReplaceCraftsmanExperienceResult>;
  findOwned(input: {
    readonly actorUserId: UserId;
    readonly craftsmanProfileId: CraftsmanProfileId;
  }): Promise<CraftsmanExperience | null>;
}

export class CraftsmanExperienceValidationError extends TypeError {
  readonly code = "INVALID_CRAFTSMAN_EXPERIENCE_COMMAND";
}

export function assertReplaceCraftsmanExperienceInput(
  input: ReplaceCraftsmanExperienceInput,
): void {
  assertUuid(input.actorUserId, "actorUserId");
  assertUuid(input.commandId, "commandId");
  assertUuid(input.craftsmanProfileId, "craftsmanProfileId");
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0
  ) {
    throw invalid("expectedRevision");
  }
  if (input.workingSinceYear !== null) {
    const serverCurrentYear = new Date().getUTCFullYear();
    if (
      !Number.isSafeInteger(input.workingSinceYear) ||
      input.workingSinceYear < 1800 ||
      input.workingSinceYear > serverCurrentYear
    ) {
      throw invalid("workingSinceYear");
    }
  }
}

export function assertCraftsmanExperienceReadInput(input: {
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

function invalid(field: string): CraftsmanExperienceValidationError {
  return new CraftsmanExperienceValidationError(
    `Invalid craftsman experience command field: ${field}.`,
  );
}
