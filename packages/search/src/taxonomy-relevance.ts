import type {
  ProfessionProficiencyLevel,
  SearchableCraftsmanCandidate,
  SearchableCraftsmanSkill,
  SearchableCraftsmanSpecialization,
} from "@portal/domain";

import type { TaxonomyAutocompleteSuggestion } from "./model.js";
import { isGovernedSuggestion } from "./governed-suggestion.js";

export const TAXONOMY_RELEVANCE_MAX_SKILL_TARGETS = 20;

export type TaxonomyEvidenceSupport =
  "NONE" | "SELF_DECLARED" | "EVIDENCE_SUPPORTED";

const governedQueryBrand: unique symbol = Symbol("governedTaxonomyQuery");

export interface GovernedTaxonomyRelevanceQuery {
  readonly [governedQueryBrand]: true;
  readonly professionCode: string;
  readonly skillCodes: readonly string[];
  readonly specializationCode: string | null;
}

export interface TaxonomyRelevanceFacts {
  readonly profileId: string;
  readonly taxonomyEligibility: "EXACT_PROFESSION" | "NO_EXACT_PROFESSION";
  readonly profession: Readonly<{
    readonly code: string;
    readonly declaredLevel: ProfessionProficiencyLevel | null;
    readonly declaredLevelInfluence: "WEAK_CONTEXT_ONLY";
    readonly evidenceSupportedLevel: ProfessionProficiencyLevel | null;
    readonly support: TaxonomyEvidenceSupport;
  }>;
  readonly specialization: Readonly<{
    readonly code: string;
    readonly matched: boolean;
    readonly support: TaxonomyEvidenceSupport;
  }> | null;
  readonly skill: Readonly<{
    readonly aggregation: "PRESENCE_ONLY";
    readonly matched: boolean;
    readonly representativeCode: string | null;
    readonly support: TaxonomyEvidenceSupport;
  }> | null;
}

export class TaxonomyRelevanceIntegrityError extends Error {
  override readonly name = "TaxonomyRelevanceIntegrityError";
}

/**
 * Server-side composition boundary. Suggestions must come from the governed
 * autocomplete service; client-provided codes are not accepted as this type.
 */
export function composeGovernedTaxonomyRelevanceQuery(input: {
  readonly profession: TaxonomyAutocompleteSuggestion;
  readonly skills?: readonly TaxonomyAutocompleteSuggestion[];
  readonly specialization?: TaxonomyAutocompleteSuggestion | null;
}): GovernedTaxonomyRelevanceQuery {
  const { profession } = input;
  if (
    !isGovernedSuggestion(profession) ||
    profession.kind !== "PROFESSION" ||
    !isProfessionCode(profession.code) ||
    profession.professionCodes.length !== 1 ||
    profession.professionCodes[0] !== profession.code
  ) {
    throw integrity("profession target");
  }

  const specialization = input.specialization ?? null;
  if (
    specialization !== null &&
    (!isGovernedSuggestion(specialization) ||
      specialization.kind !== "SPECIALIZATION" ||
      !isSpecializationCode(specialization.code) ||
      specialization.professionCodes.length !== 1 ||
      specialization.professionCodes[0] !== profession.code)
  ) {
    throw integrity("specialization target");
  }

  const skills = input.skills ?? [];
  if (
    skills.length > TAXONOMY_RELEVANCE_MAX_SKILL_TARGETS ||
    skills.some(
      (skill) =>
        !isGovernedSuggestion(skill) ||
        skill.kind !== "SKILL" ||
        !isSkillCode(skill.code) ||
        !skill.professionCodes.includes(profession.code),
    )
  ) {
    throw integrity("skill targets");
  }
  const skillCodes = skills.map(({ code }) => code);
  if (new Set(skillCodes).size !== skillCodes.length) {
    throw integrity("duplicate skill target");
  }

  return Object.freeze({
    [governedQueryBrand]: true as const,
    professionCode: profession.code,
    skillCodes: Object.freeze([...skillCodes].sort(codePointCompare)),
    specializationCode: specialization?.code ?? null,
  });
}

/** Projects categorical facts only. R2-009 owns cross-signal ranking. */
export function projectTaxonomyRelevanceFacts(
  query: GovernedTaxonomyRelevanceQuery,
  candidate: SearchableCraftsmanCandidate,
): TaxonomyRelevanceFacts {
  assertGovernedQuery(query);
  assertCandidateTaxonomy(candidate);

  const profession = candidate.professions.find(
    ({ code }) => code === query.professionCode,
  );
  const hasExactProfession = profession !== undefined;
  const specialization =
    query.specializationCode === null
      ? undefined
      : hasExactProfession
        ? candidate.specializations.find(
            ({ code, professionCode }) =>
              code === query.specializationCode &&
              professionCode === query.professionCode,
          )
        : undefined;
  const matchingSkills = hasExactProfession
    ? candidate.skills.filter(
        (skill) =>
          skill.canonicalCode !== null &&
          query.skillCodes.includes(skill.canonicalCode) &&
          skill.professionCodes.includes(query.professionCode),
      )
    : [];
  const representativeSkill = [...matchingSkills].sort(compareSkills)[0];

  return Object.freeze({
    profileId: candidate.profileId,
    taxonomyEligibility: hasExactProfession
      ? "EXACT_PROFESSION"
      : "NO_EXACT_PROFESSION",
    profession: Object.freeze({
      code: query.professionCode,
      declaredLevel: profession?.declaredLevel ?? null,
      declaredLevelInfluence: "WEAK_CONTEXT_ONLY" as const,
      evidenceSupportedLevel: profession?.evidenceSupportedLevel ?? null,
      support:
        profession === undefined
          ? "NONE"
          : profession.evidenceSupportedLevel === null
            ? "SELF_DECLARED"
            : "EVIDENCE_SUPPORTED",
    }),
    specialization:
      query.specializationCode === null
        ? null
        : Object.freeze({
            code: query.specializationCode,
            matched: specialization !== undefined,
            support: supportForCapability(specialization),
          }),
    skill:
      query.skillCodes.length === 0
        ? null
        : Object.freeze({
            aggregation: "PRESENCE_ONLY" as const,
            matched: representativeSkill !== undefined,
            representativeCode: representativeSkill?.canonicalCode ?? null,
            support: supportForCapability(representativeSkill),
          }),
  });
}

function assertGovernedQuery(query: GovernedTaxonomyRelevanceQuery): void {
  if (
    query === null ||
    typeof query !== "object" ||
    query[governedQueryBrand] !== true ||
    !isProfessionCode(query.professionCode) ||
    (query.specializationCode !== null &&
      !isSpecializationCode(query.specializationCode)) ||
    query.skillCodes.length > TAXONOMY_RELEVANCE_MAX_SKILL_TARGETS ||
    new Set(query.skillCodes).size !== query.skillCodes.length ||
    query.skillCodes.some((code) => !isSkillCode(code))
  ) {
    throw integrity("governed query");
  }
}

function assertCandidateTaxonomy(
  candidate: SearchableCraftsmanCandidate,
): void {
  const professionCodes = candidate.professions.map(({ code }) => code);
  if (
    !isUuid(candidate.profileId) ||
    professionCodes.some((code) => !isProfessionCode(code)) ||
    new Set(professionCodes).size !== professionCodes.length ||
    candidate.professions.some(
      ({ declaredLevel, evidenceSupportedLevel }) =>
        !isLevel(declaredLevel) ||
        (evidenceSupportedLevel !== null && !isLevel(evidenceSupportedLevel)),
    ) ||
    hasInvalidSpecialization(candidate.specializations, professionCodes) ||
    hasInvalidSkill(candidate.skills, professionCodes)
  ) {
    throw integrity("search candidate taxonomy");
  }
}

function hasInvalidSpecialization(
  values: readonly SearchableCraftsmanSpecialization[],
  professionCodes: readonly string[],
): boolean {
  const codes = values.map(({ code }) => code);
  return (
    new Set(codes).size !== codes.length ||
    values.some(
      ({ code, evidenceSupported, professionCode }) =>
        !isSpecializationCode(code) ||
        !isProfessionCode(professionCode) ||
        !professionCodes.includes(professionCode) ||
        typeof evidenceSupported !== "boolean",
    )
  );
}

function hasInvalidSkill(
  values: readonly SearchableCraftsmanSkill[],
  professionCodes: readonly string[],
): boolean {
  return values.some(
    ({ canonicalCode, evidenceSupported, professionCodes: links }) =>
      (canonicalCode !== null && !isSkillCode(canonicalCode)) ||
      typeof evidenceSupported !== "boolean" ||
      links.length < 1 ||
      new Set(links).size !== links.length ||
      links.some(
        (professionCode) =>
          !isProfessionCode(professionCode) ||
          !professionCodes.includes(professionCode),
      ),
  );
}

function compareSkills(
  left: SearchableCraftsmanSkill,
  right: SearchableCraftsmanSkill,
): number {
  return (
    Number(right.evidenceSupported) - Number(left.evidenceSupported) ||
    codePointCompare(left.canonicalCode ?? "", right.canonicalCode ?? "")
  );
}

function supportForCapability(
  value:
    SearchableCraftsmanSkill | SearchableCraftsmanSpecialization | undefined,
): TaxonomyEvidenceSupport {
  return value === undefined
    ? "NONE"
    : value.evidenceSupported
      ? "EVIDENCE_SUPPORTED"
      : "SELF_DECLARED";
}

function isProfessionCode(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(?:PROF|TEST):[A-Z0-9][A-Z0-9_]{1,62}$/u.test(value)
  );
}

function isSpecializationCode(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(?:SPEC|TEST):[A-Z0-9][A-Z0-9_]{1,62}$/u.test(value)
  );
}

function isSkillCode(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(?:SKILL|TEST):[A-Z0-9][A-Z0-9_]{1,62}$/u.test(value)
  );
}

function isLevel(value: unknown): value is ProfessionProficiencyLevel {
  return value === "BEGINNER" || value === "ADVANCED" || value === "MASTER";
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}

function codePointCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function integrity(field: string): TaxonomyRelevanceIntegrityError {
  return new TaxonomyRelevanceIntegrityError(
    `Invalid governed taxonomy relevance ${field}.`,
  );
}
