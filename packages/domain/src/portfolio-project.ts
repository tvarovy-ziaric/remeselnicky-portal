import type {
  CraftsmanSkillId,
  CraftsmanSpecializationId,
} from "./craftsman-capability.js";
import type { CraftsmanProfessionId } from "./craftsman-profession.js";
import type { CraftsmanProfileId } from "./craftsman-profile.js";
import type { EntityId } from "./index.js";
import type { UserId } from "./user.js";

export const PORTFOLIO_PROJECT_RECORD_STATES = Object.freeze([
  "DRAFT",
  "HIDDEN",
  "ARCHIVED",
] as const);
export const PORTFOLIO_DURATION_UNITS = Object.freeze([
  "DAYS",
  "WEEKS",
  "MONTHS",
] as const);

export type PortfolioProjectRecordState =
  (typeof PORTFOLIO_PROJECT_RECORD_STATES)[number];
export type PortfolioDurationUnit = (typeof PORTFOLIO_DURATION_UNITS)[number];

declare const portfolioProjectIdBrand: unique symbol;
export type PortfolioProjectId = EntityId & {
  readonly [portfolioProjectIdBrand]: "PortfolioProjectId";
};

export interface PortfolioProjectContent {
  readonly title: string;
  readonly shortDescription: string;
  readonly contribution: string | null;
  readonly materialsAndTechnologies: string | null;
  readonly problem: string | null;
  readonly solution: string | null;
  readonly durationValue: number | null;
  readonly durationUnit: PortfolioDurationUnit | null;
  readonly indicativePriceMinCents: number | null;
  readonly indicativePriceMaxCents: number | null;
  readonly municipalityCode: string | null;
  readonly districtCode: string | null;
  readonly professionIds: readonly CraftsmanProfessionId[];
  readonly skillIds: readonly CraftsmanSkillId[];
  readonly specializationIds: readonly CraftsmanSpecializationId[];
}

/** R1-013 is always private and never upgrades its own evidence provenance. */
export interface PortfolioProject extends PortfolioProjectContent {
  readonly id: PortfolioProjectId;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly authorUserId: UserId;
  readonly provenanceKind: "SELF_DECLARED";
  readonly evidenceStatus: "UNVERIFIED";
  readonly recordState: PortfolioProjectRecordState;
  readonly revision: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreatePortfolioProjectInput extends PortfolioProjectContent {
  readonly actorUserId: UserId;
  readonly commandId: string;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly portfolioProjectId: PortfolioProjectId;
}

export interface EditPortfolioProjectInput extends PortfolioProjectContent {
  readonly actorUserId: UserId;
  readonly commandId: string;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly portfolioProjectId: PortfolioProjectId;
  readonly expectedRevision: number;
}

export interface ChangePortfolioProjectStateInput {
  readonly actorUserId: UserId;
  readonly commandId: string;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly portfolioProjectId: PortfolioProjectId;
  readonly expectedRevision: number;
}

export type CreatePortfolioProjectResult = Readonly<
  | {
      readonly status: "APPLIED" | "DEDUPLICATED";
      readonly project: PortfolioProject;
    }
  | {
      readonly status:
        | "PROFILE_UNAVAILABLE"
        | "PROJECT_ALREADY_EXISTS"
        | "TAG_UNAVAILABLE"
        | "LOCATION_UNAVAILABLE";
    }
>;

export type EditPortfolioProjectResult = Readonly<
  | {
      readonly status: "APPLIED" | "DEDUPLICATED";
      readonly project: PortfolioProject;
    }
  | {
      readonly status:
        | "PROFILE_UNAVAILABLE"
        | "PROJECT_UNAVAILABLE"
        | "PROJECT_ARCHIVED"
        | "STALE_REVISION"
        | "TAG_UNAVAILABLE"
        | "LOCATION_UNAVAILABLE"
        | "UNCHANGED";
    }
>;

export type ChangePortfolioProjectStateResult = Readonly<
  | {
      readonly status: "APPLIED" | "DEDUPLICATED";
      readonly project: PortfolioProject;
    }
  | {
      readonly status:
        | "PROFILE_UNAVAILABLE"
        | "PROJECT_UNAVAILABLE"
        | "INVALID_STATE"
        | "STALE_REVISION";
    }
>;

export interface PortfolioProjectPersistence {
  create(
    input: CreatePortfolioProjectInput,
  ): Promise<CreatePortfolioProjectResult>;
  edit(input: EditPortfolioProjectInput): Promise<EditPortfolioProjectResult>;
  hide(
    input: ChangePortfolioProjectStateInput,
  ): Promise<ChangePortfolioProjectStateResult>;
  archive(
    input: ChangePortfolioProjectStateInput,
  ): Promise<ChangePortfolioProjectStateResult>;
  restoreDraft(
    input: ChangePortfolioProjectStateInput,
  ): Promise<ChangePortfolioProjectStateResult>;
  listOwned(input: {
    readonly actorUserId: UserId;
    readonly craftsmanProfileId: CraftsmanProfileId;
    readonly includeArchived?: boolean;
  }): Promise<readonly PortfolioProject[]>;
}

export class PortfolioProjectValidationError extends TypeError {
  readonly code = "INVALID_PORTFOLIO_PROJECT_COMMAND";
}

export function assertCreatePortfolioProjectInput(
  input: CreatePortfolioProjectInput,
): void {
  assertCommon(input);
  assertContent(input);
}

export function assertEditPortfolioProjectInput(
  input: EditPortfolioProjectInput,
): void {
  assertCommon(input);
  assertRevision(input.expectedRevision);
  assertContent(input);
}

export function assertChangePortfolioProjectStateInput(
  input: ChangePortfolioProjectStateInput,
): void {
  assertCommon(input);
  assertRevision(input.expectedRevision);
}

export function assertPortfolioProjectListInput(input: {
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

export function isPortfolioProjectPublicTextSafe(value: string): boolean {
  const patterns = [
    /[\p{L}\d._%+-]+@[\p{L}\d.-]+\.[\p{L}]{2,}/iu,
    /@[\p{L}\d_]{2,}/iu,
    /(?:\+|00)?\d(?:[\s()./-]*\d){6,}/u,
    /\b(?:https?:\/\/|www\.)/iu,
    /\b[\p{L}\d][\p{L}\d-]{0,62}(?:\.[\p{L}\d-]{1,63})*\.[\p{L}]{2,24}\b/iu,
    /(?:\b(?:adresa|ulica|námestie|trieda|číslo domu|číslo bytu)\b|\b(?:ul|nám)\.)/iu,
    /\b(?:zákazník|zákazníčka|klient|klientka|objednávateľ|objednávateľka)\s*(?:menom|:|-)\s*[\p{L}]/iu,
    /\b(?:heslo|password|api[ _-]?key|access[ _-]?token|secret|tajný kľúč)\b/iu,
  ];
  return (
    !/\p{Cc}/u.test(value) && !patterns.some((pattern) => pattern.test(value))
  );
}

function assertCommon(input: {
  readonly actorUserId: UserId;
  readonly commandId: string;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly portfolioProjectId: PortfolioProjectId;
}): void {
  assertUuid(input.actorUserId, "actorUserId");
  assertUuid(input.commandId, "commandId");
  assertUuid(input.craftsmanProfileId, "craftsmanProfileId");
  assertUuid(input.portfolioProjectId, "portfolioProjectId");
}

function assertContent(input: PortfolioProjectContent): void {
  assertRequiredText(input.title, 2, 120, "title");
  assertRequiredText(input.shortDescription, 10, 600, "shortDescription");
  assertOptionalText(input.contribution, 600, "contribution");
  assertOptionalText(
    input.materialsAndTechnologies,
    1_000,
    "materialsAndTechnologies",
  );
  assertOptionalText(input.problem, 1_500, "problem");
  assertOptionalText(input.solution, 1_500, "solution");
  assertDuration(input.durationValue, input.durationUnit);
  assertPriceRange(
    input.indicativePriceMinCents,
    input.indicativePriceMaxCents,
  );
  assertLocation(input.municipalityCode, input.districtCode);
  assertIds(input.professionIds, 1, 20, "professionIds");
  assertIds(input.skillIds, 0, 100, "skillIds");
  assertIds(input.specializationIds, 0, 100, "specializationIds");
}

function assertRequiredText(
  value: string,
  minimum: number,
  maximum: number,
  field: string,
): void {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length < minimum ||
    value.length > maximum ||
    !isPortfolioProjectPublicTextSafe(value)
  ) {
    throw invalid(field);
  }
}

function assertOptionalText(
  value: string | null,
  maximum: number,
  field: string,
): void {
  if (value === null) return;
  assertRequiredText(value, 1, maximum, field);
}

function assertDuration(
  value: number | null,
  unit: PortfolioDurationUnit | null,
): void {
  if (value === null || unit === null) {
    if (value !== null || unit !== null) throw invalid("duration");
    return;
  }
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 1_200 ||
    !PORTFOLIO_DURATION_UNITS.some((candidate) => candidate === unit)
  ) {
    throw invalid("duration");
  }
}

function assertPriceRange(
  minimum: number | null,
  maximum: number | null,
): void {
  if (minimum === null || maximum === null) {
    if (minimum !== null || maximum !== null)
      throw invalid("indicativePriceRange");
    return;
  }
  if (
    !Number.isSafeInteger(minimum) ||
    !Number.isSafeInteger(maximum) ||
    minimum < 0 ||
    maximum < minimum ||
    maximum > Number.MAX_SAFE_INTEGER
  ) {
    throw invalid("indicativePriceRange");
  }
}

function assertLocation(
  municipalityCode: string | null,
  districtCode: string | null,
): void {
  if (municipalityCode !== null && districtCode === null) {
    throw invalid("districtCode");
  }
  if (municipalityCode !== null)
    assertCatalogCode(municipalityCode, "municipalityCode");
  if (districtCode !== null) assertCatalogCode(districtCode, "districtCode");
}

function assertCatalogCode(value: string, field: string): void {
  if (
    value !== value.trim() ||
    value.length < 1 ||
    value.length > 64 ||
    !/^[A-Z0-9][A-Z0-9._:-]*$/u.test(value)
  ) {
    throw invalid(field);
  }
}

function assertIds(
  values: readonly string[],
  minimum: number,
  maximum: number,
  field: string,
): void {
  if (
    !Array.isArray(values) ||
    values.length < minimum ||
    values.length > maximum
  ) {
    throw invalid(field);
  }
  const unique = new Set(values);
  if (unique.size !== values.length) throw invalid(field);
  for (const value of values as readonly unknown[]) {
    if (typeof value !== "string") throw invalid(field);
    assertUuid(value, field);
  }
}

function assertRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1)
    throw invalid("expectedRevision");
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

function invalid(field: string): PortfolioProjectValidationError {
  return new PortfolioProjectValidationError(
    `Invalid portfolio project command field: ${field}.`,
  );
}
