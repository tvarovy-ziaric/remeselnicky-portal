import type { CraftsmanProfileId } from "./craftsman-profile.js";
import type { MunicipalityCode } from "./craftsman-service-area.js";
import {
  CRAFTSMAN_DISTANCE_QUERY_MAX_RESULTS,
  MAX_RANKING_DISTANCE_METERS,
} from "./craftsman-distance.js";

export const CRAFTSMAN_SERVICE_AREA_MATCH_KINDS = Object.freeze([
  "ADDITIONAL_SERVICE_AREA",
  "WITHIN_NORMAL_RADIUS",
  "WITHIN_MAXIMUM_RADIUS",
  "OUTSIDE_DECLARED_AREA",
  "DISTANCE_UNAVAILABLE",
] as const);

export type CraftsmanServiceAreaMatchKind =
  (typeof CRAFTSMAN_SERVICE_AREA_MATCH_KINDS)[number];

export interface CraftsmanServiceAreaMatchQuery {
  readonly municipalityCode: MunicipalityCode | null;
  readonly includeOutsideDeclaredArea: boolean;
  readonly limit: number;
}

/** Internal geo fact. Metre precision must not cross the public boundary. */
export interface CraftsmanServiceAreaMatch {
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly matchKind: CraftsmanServiceAreaMatchKind;
  readonly rankingDistanceMeters: number | null;
  readonly approximateDistanceKm: number | null;
}

export interface PublicCraftsmanServiceAreaMatch {
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly matchKind: CraftsmanServiceAreaMatchKind;
  readonly approximateDistanceKm: number | null;
}

export type CraftsmanServiceAreaMatchResult = Readonly<
  | {
      readonly status: "OK";
      readonly matches: readonly CraftsmanServiceAreaMatch[];
    }
  | { readonly status: "LOCATION_UNAVAILABLE" }
>;

export interface CraftsmanServiceAreaMatchPersistence {
  findMatches(
    input: CraftsmanServiceAreaMatchQuery,
  ): Promise<CraftsmanServiceAreaMatchResult>;
}

export interface CraftsmanServiceAreaMatchValues {
  readonly craftsmanProfileId: string;
  readonly matchKind: string;
  readonly rankingDistanceMeters: number | null;
  readonly approximateDistanceKm: number | null;
}

export class CraftsmanServiceAreaMatchValidationError extends TypeError {
  readonly code = "INVALID_CRAFTSMAN_SERVICE_AREA_MATCH";
}

export function assertCraftsmanServiceAreaMatchQuery(
  input: CraftsmanServiceAreaMatchQuery,
): void {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw invalid("input");
  }
  if (typeof input.includeOutsideDeclaredArea !== "boolean") {
    throw invalid("includeOutsideDeclaredArea");
  }
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > CRAFTSMAN_DISTANCE_QUERY_MAX_RESULTS
  ) {
    throw invalid("limit");
  }
  if (
    input.municipalityCode !== null &&
    (typeof input.municipalityCode !== "string" ||
      input.municipalityCode !== input.municipalityCode.trim() ||
      input.municipalityCode.length < 1 ||
      input.municipalityCode.length > 64 ||
      !/^[A-Z0-9][A-Z0-9._:-]*$/u.test(input.municipalityCode))
  ) {
    throw invalid("municipalityCode");
  }
}

export function createCraftsmanServiceAreaMatch(
  values: CraftsmanServiceAreaMatchValues,
): CraftsmanServiceAreaMatch {
  if (!isUuid(values.craftsmanProfileId)) {
    throw invalid("craftsmanProfileId");
  }
  if (!isMatchKind(values.matchKind)) throw invalid("matchKind");
  const distanceUnavailable = values.matchKind === "DISTANCE_UNAVAILABLE";
  if (
    distanceUnavailable !==
    (values.rankingDistanceMeters === null &&
      values.approximateDistanceKm === null)
  ) {
    throw invalid("distanceAvailability");
  }
  if (!distanceUnavailable) {
    const metres = values.rankingDistanceMeters;
    const kilometres = values.approximateDistanceKm;
    if (
      metres === null ||
      kilometres === null ||
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
    matchKind: values.matchKind,
    rankingDistanceMeters: values.rankingDistanceMeters,
    approximateDistanceKm: values.approximateDistanceKm,
  });
}

/** Public serializer omits internal precision and carries no promise wording. */
export function serializePublicCraftsmanServiceAreaMatch(
  match: CraftsmanServiceAreaMatch,
): PublicCraftsmanServiceAreaMatch {
  return Object.freeze({
    craftsmanProfileId: match.craftsmanProfileId,
    matchKind: match.matchKind,
    approximateDistanceKm: match.approximateDistanceKm,
  });
}

function isMatchKind(value: string): value is CraftsmanServiceAreaMatchKind {
  return CRAFTSMAN_SERVICE_AREA_MATCH_KINDS.some(
    (candidate) => candidate === value,
  );
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}

function invalid(field: string): CraftsmanServiceAreaMatchValidationError {
  return new CraftsmanServiceAreaMatchValidationError(
    `Invalid craftsman service-area match field: ${field}.`,
  );
}
