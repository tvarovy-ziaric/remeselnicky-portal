import type { CraftsmanProfileId } from "./craftsman-profile.js";
import {
  AVAILABILITY_EARLIEST_INSTANT_MS,
  AVAILABILITY_LATEST_INSTANT_MS,
  AVAILABILITY_MAX_BLOCK_DURATION_MS,
} from "./craftsman-availability.js";

export const CRAFTSMAN_AVAILABILITY_MATCH_KINDS = Object.freeze([
  "TIMING_NOT_SUPPLIED",
  "NO_OVERLAPPING_DECLARATION",
  "AVAILABLE_OVERLAP",
  "BUSY_OVERLAP",
  "UNAVAILABLE_OVERLAP",
  "MIXED_OVERLAP",
] as const);

export const CRAFTSMAN_AVAILABILITY_MATCH_MAX_RESULTS = 100;

export type CraftsmanAvailabilityMatchKind =
  (typeof CRAFTSMAN_AVAILABILITY_MATCH_KINDS)[number];

export interface CraftsmanAvailabilityMatchQuery {
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
  /** Explicit opt-in. It accepts only an unambiguous AVAILABLE overlap. */
  readonly filterIndicativelyAvailable: boolean;
  readonly limit: number;
}

/**
 * Public-safe categorical fact. It never exposes a private calendar interval,
 * capacity, booking state, or availability guarantee.
 */
export interface CraftsmanAvailabilityMatch {
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly matchKind: CraftsmanAvailabilityMatchKind;
  readonly indicativelyAvailable: boolean;
}

export interface CraftsmanAvailabilityMatchValues {
  readonly craftsmanProfileId: string;
  readonly matchKind: string;
  readonly indicativelyAvailable: boolean;
}

export interface CraftsmanAvailabilityMatchPersistence {
  findMatches(
    input: CraftsmanAvailabilityMatchQuery,
  ): Promise<readonly CraftsmanAvailabilityMatch[]>;
}

export class CraftsmanAvailabilityMatchValidationError extends TypeError {
  readonly code = "INVALID_CRAFTSMAN_AVAILABILITY_MATCH";
}

export function assertCraftsmanAvailabilityMatchQuery(
  input: CraftsmanAvailabilityMatchQuery,
): void {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw invalid("input");
  }
  if (typeof input.filterIndicativelyAvailable !== "boolean") {
    throw invalid("filterIndicativelyAvailable");
  }
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > CRAFTSMAN_AVAILABILITY_MATCH_MAX_RESULTS
  ) {
    throw invalid("limit");
  }
  const noTiming = input.startsAt === null && input.endsAt === null;
  if (noTiming) {
    if (input.filterIndicativelyAvailable) throw invalid("timingRequired");
    return;
  }
  if (!(input.startsAt instanceof Date) || !(input.endsAt instanceof Date)) {
    throw invalid("interval");
  }
  const start = input.startsAt.valueOf();
  const end = input.endsAt.valueOf();
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

export function createCraftsmanAvailabilityMatch(
  values: CraftsmanAvailabilityMatchValues,
): CraftsmanAvailabilityMatch {
  if (!isUuid(values.craftsmanProfileId)) {
    throw invalid("craftsmanProfileId");
  }
  if (!isMatchKind(values.matchKind)) throw invalid("matchKind");
  if (typeof values.indicativelyAvailable !== "boolean") {
    throw invalid("indicativelyAvailable");
  }
  if (
    values.indicativelyAvailable !==
    (values.matchKind === "AVAILABLE_OVERLAP")
  ) {
    throw invalid("availabilityCoherence");
  }
  return Object.freeze({
    craftsmanProfileId: values.craftsmanProfileId as CraftsmanProfileId,
    indicativelyAvailable: values.indicativelyAvailable,
    matchKind: values.matchKind,
  });
}

function isMatchKind(value: string): value is CraftsmanAvailabilityMatchKind {
  return CRAFTSMAN_AVAILABILITY_MATCH_KINDS.some(
    (candidate) => candidate === value,
  );
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}

function invalid(field: string): CraftsmanAvailabilityMatchValidationError {
  return new CraftsmanAvailabilityMatchValidationError(
    `Invalid craftsman availability match field: ${field}.`,
  );
}
