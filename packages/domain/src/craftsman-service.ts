import type { CraftsmanProfessionId } from "./craftsman-profession.js";
import type { CraftsmanProfileId } from "./craftsman-profile.js";
import type { EntityId } from "./index.js";
import type { UserId } from "./user.js";

declare const craftsmanServiceIdBrand: unique symbol;
export type CraftsmanServiceId = EntityId & {
  readonly [craftsmanServiceIdBrand]: "CraftsmanServiceId";
};

export interface CraftsmanService {
  readonly id: CraftsmanServiceId;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly taxonomyReleaseId: string;
  readonly serviceCode: string;
  /** Read-time label resolved from the pinned taxonomy release; never owner-authored. */
  readonly taxonomyLabel?: string;
  readonly state: "ACTIVE" | "INACTIVE";
  readonly craftsmanProfessionIds: readonly CraftsmanProfessionId[];
  readonly createdAt: Date;
  readonly deactivatedAt: Date | null;
}

export interface AddCraftsmanServiceInput {
  readonly actorUserId: UserId;
  readonly commandId: string;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly craftsmanProfessionIds: readonly CraftsmanProfessionId[];
  readonly craftsmanServiceId: CraftsmanServiceId;
  readonly serviceCode: string;
  readonly taxonomyReleaseId: string;
}

export interface DeactivateCraftsmanServiceInput {
  readonly actorUserId: UserId;
  readonly commandId: string;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly craftsmanServiceId: CraftsmanServiceId;
}

export type CraftsmanServiceCommandResult = Readonly<
  | {
      readonly service: CraftsmanService;
      readonly status: "APPLIED" | "DEDUPLICATED";
    }
  | {
      readonly status:
        | "ALREADY_ACTIVE"
        | "PROFILE_UNAVAILABLE"
        | "SERVICE_NOT_ACTIVE"
        | "ASSIGNMENT_NOT_ACTIVE"
        | "TAXONOMY_RELEASE_NOT_CURRENT";
    }
>;

export interface CraftsmanServicePersistence {
  add(input: AddCraftsmanServiceInput): Promise<CraftsmanServiceCommandResult>;
  deactivate(
    input: DeactivateCraftsmanServiceInput,
  ): Promise<CraftsmanServiceCommandResult>;
  listOwned(input: {
    readonly actorUserId: UserId;
    readonly craftsmanProfileId: CraftsmanProfileId;
  }): Promise<readonly CraftsmanService[]>;
}

export class CraftsmanServiceValidationError extends TypeError {
  readonly code = "INVALID_CRAFTSMAN_SERVICE_COMMAND";
}

export function assertAddCraftsmanServiceInput(
  input: AddCraftsmanServiceInput,
): void {
  assertUuid(input.actorUserId, "actorUserId");
  assertUuid(input.commandId, "commandId");
  assertUuid(input.craftsmanProfileId, "craftsmanProfileId");
  assertUuid(input.craftsmanServiceId, "craftsmanServiceId");
  assertUuid(input.taxonomyReleaseId, "taxonomyReleaseId");
  if (!/^SERV:[A-Z0-9][A-Z0-9_]{1,62}$/u.test(input.serviceCode)) {
    throw invalid("serviceCode");
  }
  if (
    input.craftsmanProfessionIds.length < 1 ||
    input.craftsmanProfessionIds.length > 8 ||
    new Set(input.craftsmanProfessionIds).size !==
      input.craftsmanProfessionIds.length
  ) {
    throw invalid("craftsmanProfessionIds");
  }
  for (const id of input.craftsmanProfessionIds) {
    assertUuid(id, "craftsmanProfessionIds");
  }
}

export function assertDeactivateCraftsmanServiceInput(
  input: DeactivateCraftsmanServiceInput,
): void {
  assertUuid(input.actorUserId, "actorUserId");
  assertUuid(input.commandId, "commandId");
  assertUuid(input.craftsmanProfileId, "craftsmanProfileId");
  assertUuid(input.craftsmanServiceId, "craftsmanServiceId");
}

export function assertCraftsmanServiceListInput(input: {
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

function invalid(field: string): CraftsmanServiceValidationError {
  return new CraftsmanServiceValidationError(
    `Invalid craftsman service command field: ${field}.`,
  );
}
