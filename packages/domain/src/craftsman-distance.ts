import type { CraftsmanProfileId } from "./craftsman-profile.js";
import type { MunicipalityCode } from "./craftsman-service-area.js";

export const CRAFTSMAN_DISTANCE_QUERY_MAX_RESULTS = 100;
/** Broad technical geography bound, not a service-radius product threshold. */
export const MAX_RANKING_DISTANCE_METERS = 20_040_000;

export interface CraftsmanDistanceQueryInput {
  readonly municipalityCode: MunicipalityCode | null;
  readonly limit: number;
}

/**
 * Server-only geo fact. `rankingDistanceMeters` exists for stable ordering and
 * ranking calculations and must not be copied to a public response.
 */
export interface CraftsmanDistanceFact {
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly rankingDistanceMeters: number | null;
  readonly approximateDistanceKm: number | null;
}

export interface PublicCraftsmanApproximateDistance {
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly approximateDistanceKm: number | null;
}

export type CraftsmanDistanceQueryResult = Readonly<
  | { readonly status: "OK"; readonly facts: readonly CraftsmanDistanceFact[] }
  | { readonly status: "LOCATION_UNAVAILABLE" }
>;

export interface CraftsmanDistancePersistence {
  findPublicDistanceFacts(
    input: CraftsmanDistanceQueryInput,
  ): Promise<CraftsmanDistanceQueryResult>;
}

export interface CraftsmanDistanceFactValues {
  readonly craftsmanProfileId: string;
  readonly rankingDistanceMeters: number | null;
  readonly approximateDistanceKm: number | null;
}

export class CraftsmanDistanceValidationError extends TypeError {
  readonly code = "INVALID_CRAFTSMAN_DISTANCE_QUERY";
}

export function assertCraftsmanDistanceQueryInput(
  input: CraftsmanDistanceQueryInput,
): void {
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > CRAFTSMAN_DISTANCE_QUERY_MAX_RESULTS
  ) {
    throw invalid("limit");
  }
  if (
    input.municipalityCode !== null &&
    (input.municipalityCode !== input.municipalityCode.trim() ||
      input.municipalityCode.length < 1 ||
      input.municipalityCode.length > 64 ||
      !/^[A-Z0-9][A-Z0-9._:-]*$/u.test(input.municipalityCode))
  ) {
    throw invalid("municipalityCode");
  }
}

export function createCraftsmanDistanceFact(
  values: CraftsmanDistanceFactValues,
): CraftsmanDistanceFact {
  if (!isUuid(values.craftsmanProfileId)) {
    throw invalid("craftsmanProfileId");
  }
  const metres = values.rankingDistanceMeters;
  const kilometres = values.approximateDistanceKm;
  if ((metres === null) !== (kilometres === null)) {
    throw invalid("distanceAvailability");
  }
  if (metres !== null && kilometres !== null) {
    if (
      !Number.isSafeInteger(metres) ||
      metres < 0 ||
      metres > MAX_RANKING_DISTANCE_METERS ||
      !Number.isSafeInteger(kilometres) ||
      kilometres < 0 ||
      kilometres > Math.round(MAX_RANKING_DISTANCE_METERS / 1000) ||
      kilometres !== Math.round(metres / 1000)
    ) {
      throw invalid("distance");
    }
  }
  return Object.freeze({
    craftsmanProfileId: values.craftsmanProfileId as CraftsmanProfileId,
    rankingDistanceMeters: metres,
    approximateDistanceKm: kilometres,
  });
}

/** Explicit public boundary: internal metre precision is intentionally absent. */
export function serializePublicCraftsmanApproximateDistance(
  fact: CraftsmanDistanceFact,
): PublicCraftsmanApproximateDistance {
  return Object.freeze({
    craftsmanProfileId: fact.craftsmanProfileId,
    approximateDistanceKm: fact.approximateDistanceKm,
  });
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}

function invalid(field: string): CraftsmanDistanceValidationError {
  return new CraftsmanDistanceValidationError(
    `Invalid craftsman distance query field: ${field}.`,
  );
}
