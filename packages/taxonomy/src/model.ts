export const TAXONOMY_CONTENT_CLASSES = Object.freeze([
  "PLACEHOLDER",
  "CANONICAL",
] as const);
export const TAXONOMY_REVIEW_STATES = Object.freeze([
  "HUMAN_REVIEW_PENDING",
  "HUMAN_REVIEW_APPROVED",
] as const);
export const TAXONOMY_ENTRY_STATES = Object.freeze([
  "ACTIVE",
  "DEPRECATED",
] as const);
export const CAPABILITY_LEVELS = Object.freeze(["ADVANCED", "MASTER"] as const);
export const TAXONOMY_ALIAS_KINDS = Object.freeze([
  "LEGACY_CODE",
  "LEGACY_SLUG",
  "SEARCH_TERM",
] as const);

export type TaxonomyContentClass = (typeof TAXONOMY_CONTENT_CLASSES)[number];
export type TaxonomyReviewState = (typeof TAXONOMY_REVIEW_STATES)[number];
export type TaxonomyEntryState = (typeof TAXONOMY_ENTRY_STATES)[number];
export type CapabilityLevel = (typeof CAPABILITY_LEVELS)[number];
export type TaxonomyAliasKind = (typeof TAXONOMY_ALIAS_KINDS)[number];

export interface ProfessionSeed {
  readonly code: string;
  readonly labelSk: string;
  readonly replacedByCode: string | null;
  readonly slug: string;
  readonly state: TaxonomyEntryState;
}

export interface SpecializationSeed extends ProfessionSeed {
  readonly professionCode: string;
}

export interface CapabilityCriterionSeed {
  readonly code: string;
  readonly descriptionSk: string;
  readonly labelSk: string;
  readonly level: CapabilityLevel;
  readonly professionCode: string;
  readonly state: TaxonomyEntryState;
}

export interface TaxonomyAliasSeed {
  readonly alias: string;
  readonly kind: TaxonomyAliasKind;
  readonly targetCode: string;
  readonly targetKind: "PROFESSION" | "SPECIALIZATION";
}

export interface ProfessionTaxonomyReleaseSeed {
  readonly aliases: readonly TaxonomyAliasSeed[];
  readonly capabilityCriteria: readonly CapabilityCriterionSeed[];
  readonly contentClass: TaxonomyContentClass;
  readonly professions: readonly ProfessionSeed[];
  readonly releaseId: string;
  readonly reviewReference: string | null;
  readonly reviewState: TaxonomyReviewState;
  readonly specializations: readonly SpecializationSeed[];
  readonly supersedesReleaseId: string | null;
  readonly version: number;
}

export interface PreparedProfessionTaxonomyRelease extends ProfessionTaxonomyReleaseSeed {
  readonly checksumSha256: string;
}

export interface CurrentProfessionTaxonomyEntry {
  readonly code: string;
  readonly labelSk: string;
  readonly releaseVersion: number;
  readonly replacedByCode: string | null;
  readonly slug: string;
  readonly state: TaxonomyEntryState;
}

export interface TaxonomyActivationInput {
  readonly activationId: string;
  readonly actorReference: string;
  readonly previousReleaseId: string | null;
  readonly releaseId: string;
  readonly reviewReference: string;
}

export interface ProfessionTaxonomyPersistence {
  activateRelease(input: TaxonomyActivationInput): Promise<boolean>;
  installRelease(
    release: PreparedProfessionTaxonomyRelease,
  ): Promise<"CREATED" | "UNCHANGED">;
  listCurrentProfessions(): Promise<readonly CurrentProfessionTaxonomyEntry[]>;
}
