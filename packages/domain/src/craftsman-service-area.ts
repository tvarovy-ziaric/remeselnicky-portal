import type { CraftsmanProfileId } from "./craftsman-profile.js";
import type { EntityId } from "./index.js";
import type { UserId } from "./user.js";

export const ALPHA_EXTRA_SERVICE_AREA_UI_LIMIT = 3;
export const SERVICE_AREA_EXTRA_TECHNICAL_LIMIT = 256;

declare const municipalityCodeBrand: unique symbol;
export type MunicipalityCode = string & {
  readonly [municipalityCodeBrand]: "MunicipalityCode";
};

declare const serviceAreaRevisionIdBrand: unique symbol;
export type CraftsmanServiceAreaRevisionId = EntityId & {
  readonly [serviceAreaRevisionIdBrand]: "CraftsmanServiceAreaRevisionId";
};

/**
 * Private owner projection of profile-wide travel preferences. Municipality
 * references resolve through the governed location catalog; no address or
 * owner-supplied coordinate belongs in this aggregate.
 */
export interface CraftsmanServiceArea {
  readonly id: CraftsmanServiceAreaRevisionId;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly revision: number;
  readonly baseMunicipalityCode: MunicipalityCode | null;
  readonly normalRadiusKm: number | null;
  readonly maximumRadiusKm: number | null;
  readonly extraMunicipalityCodes: readonly MunicipalityCode[];
  readonly travelFeePolicy: string | null;
  readonly travelFeeThresholdKm: number | null;
  readonly createdAt: Date;
}

export interface ReplaceCraftsmanServiceAreaInput {
  readonly actorUserId: UserId;
  readonly commandId: string;
  readonly craftsmanProfileId: CraftsmanProfileId;
  /** Zero creates the first draft revision. */
  readonly expectedRevision: number;
  readonly baseMunicipalityCode: MunicipalityCode | null;
  readonly normalRadiusKm: number | null;
  readonly maximumRadiusKm: number | null;
  readonly extraMunicipalityCodes: readonly MunicipalityCode[];
  readonly travelFeePolicy: string | null;
  readonly travelFeeThresholdKm: number | null;
}

export type ReplaceCraftsmanServiceAreaResult = Readonly<
  | {
      status: "APPLIED" | "DEDUPLICATED" | "UNCHANGED";
      serviceArea: CraftsmanServiceArea;
    }
  | {
      status:
        "PROFILE_UNAVAILABLE" | "STALE_REVISION" | "LOCATION_NOT_AVAILABLE";
    }
>;

export interface CraftsmanServiceAreaPersistence {
  replaceOwnedDraft(
    input: ReplaceCraftsmanServiceAreaInput,
  ): Promise<ReplaceCraftsmanServiceAreaResult>;
  findOwned(input: {
    readonly actorUserId: UserId;
    readonly craftsmanProfileId: CraftsmanProfileId;
  }): Promise<CraftsmanServiceArea | null>;
}

export class CraftsmanServiceAreaValidationError extends TypeError {
  readonly code = "INVALID_CRAFTSMAN_SERVICE_AREA_COMMAND";
}

export function assertReplaceCraftsmanServiceAreaInput(
  input: ReplaceCraftsmanServiceAreaInput,
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
  assertMunicipalityCode(input.baseMunicipalityCode, "baseMunicipalityCode");
  assertRadius(input.normalRadiusKm, "normalRadiusKm");
  assertRadius(input.maximumRadiusKm, "maximumRadiusKm");
  assertRadius(input.travelFeeThresholdKm, "travelFeeThresholdKm");
  if (
    input.maximumRadiusKm !== null &&
    (input.normalRadiusKm === null ||
      input.maximumRadiusKm < input.normalRadiusKm)
  ) {
    throw invalid("maximumRadiusKm");
  }
  if (
    input.extraMunicipalityCodes.length > SERVICE_AREA_EXTRA_TECHNICAL_LIMIT
  ) {
    throw invalid("extraMunicipalityCodes");
  }
  const extras = new Set<string>();
  for (const code of input.extraMunicipalityCodes) {
    assertMunicipalityCode(code, "extraMunicipalityCodes");
    if (code === input.baseMunicipalityCode || extras.has(code)) {
      throw invalid("extraMunicipalityCodes");
    }
    extras.add(code);
  }
  if (input.travelFeePolicy !== null) {
    if (
      input.travelFeePolicy !== input.travelFeePolicy.trim() ||
      input.travelFeePolicy.includes("\r") ||
      input.travelFeePolicy.length < 1 ||
      input.travelFeePolicy.length > 1000 ||
      hasUnsafeControl(input.travelFeePolicy) ||
      /(?:https?:\/\/|www\.)/iu.test(input.travelFeePolicy) ||
      /\b[^\s@]+@[^\s@]+\.[a-z]{2,}\b/iu.test(input.travelFeePolicy) ||
      /\+?\d(?:[\s().-]*\d){6,}/u.test(input.travelFeePolicy)
    ) {
      throw invalid("travelFeePolicy");
    }
  }
}

/** Canonicalizes user-authored multiline policy text before validation/storage. */
export function normalizeTravelFeePolicy(value: string | null): string | null {
  return value === null ? null : value.replace(/\r\n?/gu, "\n").trim();
}

export function assertCraftsmanServiceAreaReadInput(input: {
  readonly actorUserId: UserId;
  readonly craftsmanProfileId: CraftsmanProfileId;
}): void {
  assertUuid(input.actorUserId, "actorUserId");
  assertUuid(input.craftsmanProfileId, "craftsmanProfileId");
}

function assertMunicipalityCode(
  value: MunicipalityCode | null,
  field: string,
): void {
  if (
    value !== null &&
    (value !== value.trim() ||
      value.length < 1 ||
      value.length > 64 ||
      !/^[A-Z0-9][A-Z0-9._:-]*$/u.test(value))
  ) {
    throw invalid(field);
  }
}

function assertRadius(value: number | null, field: string): void {
  // 20,040 km is approximately the greatest useful straight-line distance on
  // Earth; the guard rejects non-finite/nonsensical values without imposing a
  // marketplace policy threshold.
  if (
    value !== null &&
    (!Number.isFinite(value) ||
      value <= 0 ||
      value > 20_040 ||
      Math.abs(value * 100 - Math.round(value * 100)) > 1e-8)
  ) {
    throw invalid(field);
  }
}

function hasUnsafeControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (
      (code >= 1 && code <= 9) || (code >= 11 && code <= 31) || code === 127
    );
  });
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

function invalid(field: string): CraftsmanServiceAreaValidationError {
  return new CraftsmanServiceAreaValidationError(
    `Invalid craftsman service-area command field: ${field}.`,
  );
}
