import type { CraftsmanProfileId } from "./craftsman-profile.js";
import type { EntityId } from "./index.js";
import type { UserId } from "./user.js";

export const CRAFTSMAN_AVAILABILITY_STATES = Object.freeze([
  "AVAILABLE",
  "BUSY",
  "UNAVAILABLE",
] as const);
export const CRAFTSMAN_AVAILABILITY_BLOCK_STATES = Object.freeze([
  "ACTIVE",
  "ARCHIVED",
] as const);

/** Broad technical bounds, not marketplace scheduling policy. */
export const AVAILABILITY_EARLIEST_INSTANT_MS = Date.parse(
  "2000-01-01T00:00:00.000Z",
);
export const AVAILABILITY_LATEST_INSTANT_MS = Date.parse(
  "2200-01-01T00:00:00.000Z",
);
export const AVAILABILITY_MAX_BLOCK_DURATION_MS =
  10 * 366 * 24 * 60 * 60 * 1000;

export type CraftsmanAvailabilityState =
  (typeof CRAFTSMAN_AVAILABILITY_STATES)[number];
export type CraftsmanAvailabilityBlockState =
  (typeof CRAFTSMAN_AVAILABILITY_BLOCK_STATES)[number];

declare const craftsmanAvailabilityBlockIdBrand: unique symbol;
export type CraftsmanAvailabilityBlockId = EntityId & {
  readonly [craftsmanAvailabilityBlockIdBrand]: "CraftsmanAvailabilityBlockId";
};

/**
 * An explicit private calendar marking. Overlapping blocks remain independent
 * statements and do not create a booking, capacity promise, or precedence.
 */
export interface CraftsmanAvailabilityBlock {
  readonly id: CraftsmanAvailabilityBlockId;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly state: CraftsmanAvailabilityBlockState;
  readonly availability: CraftsmanAvailabilityState;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly revision: number;
  readonly createdAt: Date;
  readonly changedAt: Date;
  readonly archivedAt: Date | null;
}

export interface AddCraftsmanAvailabilityBlockInput {
  readonly actorUserId: UserId;
  readonly blockId: CraftsmanAvailabilityBlockId;
  readonly commandId: string;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly availability: CraftsmanAvailabilityState;
  readonly startsAt: Date;
  readonly endsAt: Date;
}

export interface ReplaceCraftsmanAvailabilityBlockInput extends AddCraftsmanAvailabilityBlockInput {
  readonly expectedRevision: number;
}

export interface ArchiveCraftsmanAvailabilityBlockInput {
  readonly actorUserId: UserId;
  readonly blockId: CraftsmanAvailabilityBlockId;
  readonly commandId: string;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly expectedRevision: number;
}

export type AddCraftsmanAvailabilityBlockResult = Readonly<
  | {
      status: "APPLIED" | "DEDUPLICATED";
      block: CraftsmanAvailabilityBlock;
    }
  | { status: "PROFILE_UNAVAILABLE" | "ALREADY_EXISTS" }
>;

export type ReplaceCraftsmanAvailabilityBlockResult = Readonly<
  | {
      status: "APPLIED" | "DEDUPLICATED" | "UNCHANGED";
      block: CraftsmanAvailabilityBlock;
    }
  | {
      status: "PROFILE_UNAVAILABLE" | "BLOCK_NOT_ACTIVE" | "STALE_REVISION";
    }
>;

export type ArchiveCraftsmanAvailabilityBlockResult = Readonly<
  | {
      status: "APPLIED" | "DEDUPLICATED";
      block: CraftsmanAvailabilityBlock;
    }
  | {
      status: "PROFILE_UNAVAILABLE" | "BLOCK_NOT_ACTIVE" | "STALE_REVISION";
    }
>;

export interface CraftsmanAvailabilityPersistence {
  add(
    input: AddCraftsmanAvailabilityBlockInput,
  ): Promise<AddCraftsmanAvailabilityBlockResult>;
  replace(
    input: ReplaceCraftsmanAvailabilityBlockInput,
  ): Promise<ReplaceCraftsmanAvailabilityBlockResult>;
  archive(
    input: ArchiveCraftsmanAvailabilityBlockInput,
  ): Promise<ArchiveCraftsmanAvailabilityBlockResult>;
  listOwned(input: {
    readonly actorUserId: UserId;
    readonly craftsmanProfileId: CraftsmanProfileId;
    readonly includeArchived?: boolean;
  }): Promise<readonly CraftsmanAvailabilityBlock[]>;
}

export class CraftsmanAvailabilityValidationError extends TypeError {
  readonly code = "INVALID_CRAFTSMAN_AVAILABILITY_COMMAND";
}

export function assertAddCraftsmanAvailabilityBlockInput(
  input: AddCraftsmanAvailabilityBlockInput,
): void {
  assertIdentity(input);
  assertAvailability(input.availability);
  assertInterval(input.startsAt, input.endsAt);
}

export function assertReplaceCraftsmanAvailabilityBlockInput(
  input: ReplaceCraftsmanAvailabilityBlockInput,
): void {
  assertIdentity(input);
  assertAvailability(input.availability);
  assertRevision(input.expectedRevision);
  assertInterval(input.startsAt, input.endsAt);
}

export function assertArchiveCraftsmanAvailabilityBlockInput(
  input: ArchiveCraftsmanAvailabilityBlockInput,
): void {
  assertIdentity(input);
  assertRevision(input.expectedRevision);
}

export function assertCraftsmanAvailabilityListInput(input: {
  readonly actorUserId: UserId;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly includeArchived?: boolean;
}): void {
  assertUuid(input.actorUserId, "actorUserId");
  assertUuid(input.craftsmanProfileId, "craftsmanProfileId");
  if (
    input.includeArchived !== undefined &&
    typeof input.includeArchived !== "boolean"
  ) {
    throw invalid("includeArchived");
  }
}

function assertIdentity(
  input: Pick<
    AddCraftsmanAvailabilityBlockInput,
    "actorUserId" | "blockId" | "commandId" | "craftsmanProfileId"
  >,
): void {
  assertUuid(input.actorUserId, "actorUserId");
  assertUuid(input.blockId, "blockId");
  assertUuid(input.commandId, "commandId");
  assertUuid(input.craftsmanProfileId, "craftsmanProfileId");
}

function assertAvailability(value: CraftsmanAvailabilityState): void {
  if (!CRAFTSMAN_AVAILABILITY_STATES.some((candidate) => candidate === value)) {
    throw invalid("availability");
  }
}

function assertInterval(startsAt: Date, endsAt: Date): void {
  if (!(startsAt instanceof Date) || !(endsAt instanceof Date)) {
    throw invalid("interval");
  }
  const start = startsAt.valueOf();
  const end = endsAt.valueOf();
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < AVAILABILITY_EARLIEST_INSTANT_MS ||
    end > AVAILABILITY_LATEST_INSTANT_MS ||
    start >= end ||
    end - start > AVAILABILITY_MAX_BLOCK_DURATION_MS
  ) {
    throw invalid("interval");
  }
}

function assertRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw invalid("expectedRevision");
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

function invalid(field: string): CraftsmanAvailabilityValidationError {
  return new CraftsmanAvailabilityValidationError(
    `Invalid craftsman availability command field: ${field}.`,
  );
}
