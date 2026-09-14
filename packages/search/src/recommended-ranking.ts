import {
  CRAFTSMAN_DISTANCE_QUERY_MAX_RESULTS,
  CRAFTSMAN_SERVICE_AREA_MATCH_KINDS,
  MAX_RANKING_DISTANCE_METERS,
  serializeCraftsmanTrustEvidence,
  type CraftsmanServiceAreaMatch,
  type CraftsmanTrustEvidenceSummary,
  type ProfessionProficiencyLevel,
} from "@portal/domain";

import {
  AVAILABILITY_SEARCH_MATCH_KINDS,
  type AvailabilitySearchRelevance,
} from "./availability-relevance.js";
import type { CredentialQualificationResult } from "./credential-qualification.js";
import type {
  TaxonomyEvidenceSupport,
  TaxonomyRelevanceFacts,
} from "./taxonomy-relevance.js";

export const RECOMMENDED_RANKING_MAX_CANDIDATES =
  CRAFTSMAN_DISTANCE_QUERY_MAX_RESULTS;

export interface RecommendedRankingCandidate {
  readonly availability: AvailabilitySearchRelevance;
  readonly profileId: string;
  readonly serviceArea: CraftsmanServiceAreaMatch;
  readonly taxonomy: TaxonomyRelevanceFacts;
  readonly trust: CraftsmanTrustEvidenceSummary;
}

export interface RecommendedQualificationContextCandidate {
  readonly professionCode: unknown;
  readonly regulation: unknown;
}

/**
 * Server-owned port bound to the selected governed profession/service query.
 * A request payload must never implement or supply this dependency.
 */
export interface RecommendedQualificationContextResolver {
  resolveForGovernedQuery(): Promise<RecommendedQualificationContextCandidate | null>;
  evaluateForGovernedQuery(input: {
    readonly profileId: string;
  }): Promise<CredentialQualificationResult | null>;
}

export interface RecommendedRankingResult {
  readonly profileId: string;
  readonly taxonomy: Readonly<{
    readonly profession: "EXACT_PROFESSION";
    readonly skill: "MATCHED" | "NOT_MATCHED" | "NOT_REQUESTED";
    readonly specialization: "MATCHED" | "NOT_MATCHED" | "NOT_REQUESTED";
  }>;
  readonly geo: Readonly<{
    readonly approximateDistanceKm: number | null;
    readonly band:
      | "STRONG_SERVICE_AREA"
      | "FARTHER_BY_AGREEMENT"
      | "OUTSIDE_DECLARED_AREA"
      | "DISTANCE_UNAVAILABLE";
  }>;
  readonly qualification:
    | "NOT_REGULATED"
    | "REQUIRED_APPROVED"
    | "OPTIONAL_APPROVED"
    | "OPTIONAL_NOT_APPROVED";
  readonly availability: "SOFT_POSITIVE" | "NEUTRAL";
  readonly evidence: Readonly<{
    readonly approvedCredentialPresent: boolean;
    readonly category: "SUPPORTED" | "COLD_START_NEUTRAL";
    readonly professionLevelSupported: boolean;
    readonly relevantSkillSupported: boolean;
    readonly relevantSpecializationSupported: boolean;
    readonly verifiedWorkPresent: boolean;
  }>;
  readonly secondary: Readonly<{
    readonly declaredLevel: ProfessionProficiencyLevel | null;
    readonly influence: "WEAK_CONTEXT_ONLY";
  }>;
}

export interface RecommendedRankingPipeline {
  rank(
    candidates: readonly RecommendedRankingCandidate[],
  ): Promise<readonly RecommendedRankingResult[]>;
}

export class RecommendedRankingIntegrityError extends Error {
  override readonly name = "RecommendedRankingIntegrityError";
}

interface TrustedQualificationContext {
  readonly professionCode: string;
  readonly regulation: "NOT_REGULATED" | "REQUIRED" | "OPTIONAL";
}

interface PreparedCandidate {
  readonly availability: "SOFT_POSITIVE" | "NEUTRAL";
  readonly declaredLevel: ProfessionProficiencyLevel | null;
  readonly profileId: string;
  readonly rankingDistanceMeters: number | null;
  readonly resultBase: Omit<
    RecommendedRankingResult,
    "availability" | "evidence" | "qualification" | "secondary"
  >;
  readonly taxonomy: TaxonomyRelevanceFacts;
  readonly trust: CraftsmanTrustEvidenceSummary;
}

interface EligibleCandidate extends PreparedCandidate {
  readonly result: RecommendedRankingResult;
}

const trustedQualificationContexts = new WeakSet<object>();

export function createRecommendedRankingPipeline(
  resolver: RecommendedQualificationContextResolver,
): RecommendedRankingPipeline {
  if (
    !isRecord(resolver) ||
    typeof resolver.resolveForGovernedQuery !== "function" ||
    typeof resolver.evaluateForGovernedQuery !== "function"
  ) {
    throw integrity("qualification resolver");
  }
  return Object.freeze({
    async rank(candidates: readonly RecommendedRankingCandidate[]) {
      if (
        !Array.isArray(candidates) ||
        candidates.length > RECOMMENDED_RANKING_MAX_CANDIDATES
      ) {
        throw integrity("candidate batch");
      }
      if (candidates.length === 0) return Object.freeze([]);

      const prepared = candidates.map(prepareCandidate);
      assertBatchCoherence(prepared);
      const professionCode = prepared[0]?.taxonomy.profession.code;
      if (professionCode === undefined) throw integrity("profession context");

      const qualificationContext = mintQualificationContext(
        await resolver.resolveForGovernedQuery(),
        professionCode,
      );
      if (qualificationContext === null) return Object.freeze([]);

      const exactCandidates = prepared.filter(
        ({ taxonomy }) => taxonomy.taxonomyEligibility === "EXACT_PROFESSION",
      );
      const eligible = (
        await Promise.all(
          exactCandidates.map(async (candidate) =>
            applyQualification(
              candidate,
              qualificationContext,
              qualificationContext.regulation === "NOT_REGULATED"
                ? null
                : await resolver.evaluateForGovernedQuery({
                    profileId: candidate.profileId,
                  }),
            ),
          ),
        )
      )
        .filter(
          (candidate): candidate is EligibleCandidate => candidate !== null,
        )
        .sort(comparePrepared);

      return Object.freeze(eligible.map(({ result }) => result));
    },
  });
}

function prepareCandidate(value: unknown): PreparedCandidate {
  if (!isRecord(value) || !isUuid(value.profileId)) {
    throw integrity("candidate identity");
  }
  const taxonomy = parseTaxonomy(value.taxonomy, value.profileId);
  const serviceArea = parseServiceArea(value.serviceArea, value.profileId);
  const availability = parseAvailability(value.availability, value.profileId);
  const trust = serializeCraftsmanTrustEvidence(value.trust);
  if (trust === null || trust.profileId !== value.profileId) {
    throw integrity("candidate trust identity");
  }
  const professionTrust = trust.professions.find(
    ({ professionCode }) => professionCode === taxonomy.profession.code,
  );
  if (taxonomy.taxonomyEligibility === "EXACT_PROFESSION") {
    if (professionTrust === undefined) {
      throw integrity("profession trust context");
    }
    if (
      professionTrust.evidenceSupportedLevel !==
        taxonomy.profession.evidenceSupportedLevel ||
      (taxonomy.specialization?.support === "EVIDENCE_SUPPORTED" &&
        !professionTrust.hasEvidenceSupportedSpecialization) ||
      (taxonomy.skill?.support === "EVIDENCE_SUPPORTED" &&
        !professionTrust.hasEvidenceSupportedSkill)
    ) {
      throw integrity("taxonomy trust coherence");
    }
  } else if (professionTrust !== undefined) {
    throw integrity("non-matching profession trust context");
  }

  return {
    availability,
    declaredLevel: taxonomy.profession.declaredLevel,
    profileId: value.profileId,
    rankingDistanceMeters: serviceArea.rankingDistanceMeters,
    resultBase: Object.freeze({
      profileId: value.profileId,
      taxonomy: Object.freeze({
        profession: "EXACT_PROFESSION" as const,
        skill: matchCategory(taxonomy.skill),
        specialization: matchCategory(taxonomy.specialization),
      }),
      geo: Object.freeze({
        approximateDistanceKm: serviceArea.approximateDistanceKm,
        band: geoBand(serviceArea.matchKind),
      }),
    }),
    taxonomy,
    trust,
  };
}

function applyQualification(
  candidate: PreparedCandidate,
  context: TrustedQualificationContext,
  qualificationResult: unknown,
): EligibleCandidate | null {
  if (!trustedQualificationContexts.has(context)) {
    throw integrity("qualification provenance");
  }
  let qualification: RecommendedRankingResult["qualification"];
  let optionalApproved = false;

  if (context.regulation === "NOT_REGULATED") {
    if (qualificationResult !== null) {
      throw integrity("non-regulated qualification");
    }
    qualification = "NOT_REGULATED";
  } else {
    const result = parseQualificationResult(
      qualificationResult,
      context.regulation,
    );
    if (result === null || result.status === "UNAVAILABLE") return null;
    if (context.regulation === "REQUIRED") {
      if (!result.eligible || !result.currentApproved) return null;
      qualification = "REQUIRED_APPROVED";
    } else {
      optionalApproved = result.currentApproved;
      qualification = result.currentApproved
        ? "OPTIONAL_APPROVED"
        : "OPTIONAL_NOT_APPROVED";
    }
  }

  const professionTrust = candidate.trust.professions.find(
    ({ professionCode }) => professionCode === context.professionCode,
  );
  if (professionTrust === undefined) throw integrity("profession trust row");
  const professionLevelSupported =
    candidate.taxonomy.profession.support === "EVIDENCE_SUPPORTED";
  const relevantSpecializationSupported =
    candidate.taxonomy.specialization?.matched === true &&
    candidate.taxonomy.specialization.support === "EVIDENCE_SUPPORTED";
  const relevantSkillSupported =
    candidate.taxonomy.skill?.matched === true &&
    candidate.taxonomy.skill.support === "EVIDENCE_SUPPORTED";
  const verifiedWorkPresent =
    professionTrust.volume.verifiedJobCount > 0 ||
    professionTrust.volume.verifiedPortfolioProjectCount > 0;
  const approvedCredentialPresent =
    qualification === "REQUIRED_APPROVED" ||
    optionalApproved ||
    professionTrust.volume.approvedCredentialTypeCount > 0;
  const supported =
    professionLevelSupported ||
    relevantSpecializationSupported ||
    relevantSkillSupported ||
    verifiedWorkPresent ||
    approvedCredentialPresent;

  const result = Object.freeze({
    ...candidate.resultBase,
    availability: candidate.availability,
    qualification,
    evidence: Object.freeze({
      approvedCredentialPresent,
      category: supported
        ? ("SUPPORTED" as const)
        : ("COLD_START_NEUTRAL" as const),
      professionLevelSupported,
      relevantSkillSupported,
      relevantSpecializationSupported,
      verifiedWorkPresent,
    }),
    secondary: Object.freeze({
      declaredLevel: candidate.declaredLevel,
      influence: "WEAK_CONTEXT_ONLY" as const,
    }),
  });
  return { ...candidate, result };
}

function comparePrepared(
  left: EligibleCandidate,
  right: EligibleCandidate,
): number {
  return (
    compareMatch(
      left.result.taxonomy.specialization,
      right.result.taxonomy.specialization,
    ) ||
    compareMatch(left.result.taxonomy.skill, right.result.taxonomy.skill) ||
    compareGeoBand(left.result.geo.band, right.result.geo.band) ||
    compareNullableDistance(
      left.rankingDistanceMeters,
      right.rankingDistanceMeters,
    ) ||
    comparePositive(
      left.result.availability === "SOFT_POSITIVE",
      right.result.availability === "SOFT_POSITIVE",
    ) ||
    comparePositive(
      left.result.evidence.category === "SUPPORTED",
      right.result.evidence.category === "SUPPORTED",
    ) ||
    compareDeclaredLevel(left.declaredLevel, right.declaredLevel) ||
    codePointCompare(left.profileId, right.profileId)
  );
}

function assertBatchCoherence(candidates: readonly PreparedCandidate[]): void {
  const profileIds = candidates.map(({ profileId }) => profileId);
  const professionCodes = candidates.map(
    ({ taxonomy }) => taxonomy.profession.code,
  );
  const distanceUnavailable = candidates.map(
    ({ resultBase }) => resultBase.geo.band === "DISTANCE_UNAVAILABLE",
  );
  if (
    new Set(profileIds).size !== profileIds.length ||
    new Set(professionCodes).size !== 1 ||
    (distanceUnavailable.some(Boolean) && !distanceUnavailable.every(Boolean))
  ) {
    throw integrity("candidate batch coherence");
  }
}

function mintQualificationContext(
  value: RecommendedQualificationContextCandidate | null,
  professionCode: string,
): TrustedQualificationContext | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    value.professionCode !== professionCode ||
    (value.regulation !== "NOT_REGULATED" &&
      value.regulation !== "REQUIRED" &&
      value.regulation !== "OPTIONAL")
  ) {
    throw integrity("qualification context");
  }
  const context = Object.freeze({
    professionCode,
    regulation: value.regulation,
  });
  trustedQualificationContexts.add(context);
  return context;
}

function parseTaxonomy(
  value: unknown,
  profileId: string,
): TaxonomyRelevanceFacts {
  if (!isRecord(value) || value.profileId !== profileId) {
    throw integrity("taxonomy identity");
  }
  const profession = value.profession;
  if (
    !isRecord(profession) ||
    !isProfessionCode(profession.code) ||
    !isLevelOrNull(profession.declaredLevel) ||
    !isLevelOrNull(profession.evidenceSupportedLevel) ||
    profession.declaredLevelInfluence !== "WEAK_CONTEXT_ONLY" ||
    !isSupport(profession.support) ||
    (value.taxonomyEligibility !== "EXACT_PROFESSION" &&
      value.taxonomyEligibility !== "NO_EXACT_PROFESSION")
  ) {
    throw integrity("taxonomy profession");
  }
  const exact = value.taxonomyEligibility === "EXACT_PROFESSION";
  if (
    (exact && profession.support === "NONE") ||
    (!exact && profession.support !== "NONE") ||
    (profession.evidenceSupportedLevel === null) !==
      (profession.support !== "EVIDENCE_SUPPORTED")
  ) {
    throw integrity("taxonomy profession support");
  }
  const specialization = parseCapability(value.specialization, "SPEC");
  const skill = parseSkill(value.skill);
  if (!exact && (specialization?.matched === true || skill?.matched === true)) {
    throw integrity("taxonomy eligibility");
  }
  return value as unknown as TaxonomyRelevanceFacts;
}

function parseCapability(
  value: unknown,
  namespace: "SPEC",
): TaxonomyRelevanceFacts["specialization"] {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !isTaxonomyCode(value.code, namespace) ||
    typeof value.matched !== "boolean" ||
    !isSupport(value.support) ||
    value.matched !== (value.support !== "NONE")
  ) {
    throw integrity("taxonomy specialization");
  }
  return value as unknown as TaxonomyRelevanceFacts["specialization"];
}

function parseSkill(value: unknown): TaxonomyRelevanceFacts["skill"] {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    value.aggregation !== "PRESENCE_ONLY" ||
    typeof value.matched !== "boolean" ||
    !isSupport(value.support) ||
    (value.representativeCode !== null &&
      !isTaxonomyCode(value.representativeCode, "SKILL")) ||
    value.matched !== (value.support !== "NONE") ||
    value.matched !== (value.representativeCode !== null)
  ) {
    throw integrity("taxonomy skill");
  }
  return value as unknown as TaxonomyRelevanceFacts["skill"];
}

function parseServiceArea(
  value: unknown,
  profileId: string,
): CraftsmanServiceAreaMatch {
  if (
    !isRecord(value) ||
    value.craftsmanProfileId !== profileId ||
    !CRAFTSMAN_SERVICE_AREA_MATCH_KINDS.some((kind) => kind === value.matchKind)
  ) {
    throw integrity("service-area identity");
  }
  const unavailable = value.matchKind === "DISTANCE_UNAVAILABLE";
  if (
    unavailable !==
    (value.rankingDistanceMeters === null &&
      value.approximateDistanceKm === null)
  ) {
    throw integrity("service-area availability");
  }
  if (
    !unavailable &&
    (!isBoundedInteger(
      value.rankingDistanceMeters,
      MAX_RANKING_DISTANCE_METERS,
    ) ||
      !isBoundedInteger(
        value.approximateDistanceKm,
        Math.round(MAX_RANKING_DISTANCE_METERS / 1000),
      ) ||
      value.approximateDistanceKm !==
        Math.round(value.rankingDistanceMeters / 1000))
  ) {
    throw integrity("service-area distance");
  }
  return value as unknown as CraftsmanServiceAreaMatch;
}

function parseAvailability(
  value: unknown,
  profileId: string,
): "SOFT_POSITIVE" | "NEUTRAL" {
  if (
    !isRecord(value) ||
    value.profileId !== profileId ||
    !AVAILABILITY_SEARCH_MATCH_KINDS.some((kind) => kind === value.matchKind) ||
    (value.relevance !== "SOFT_POSITIVE" && value.relevance !== "NEUTRAL") ||
    (value.relevance === "SOFT_POSITIVE") !==
      (value.matchKind === "AVAILABLE_OVERLAP")
  ) {
    throw integrity("availability");
  }
  return value.relevance;
}

function parseQualificationResult(
  value: unknown,
  requirement: "REQUIRED" | "OPTIONAL",
): CredentialQualificationResult | null {
  if (!isRecord(value)) throw integrity("qualification result");
  if (value.status === "UNAVAILABLE" && value.eligible === false) {
    return value as unknown as CredentialQualificationResult;
  }
  if (
    value.status !== "OK" ||
    value.requirement !== requirement ||
    typeof value.currentApproved !== "boolean" ||
    typeof value.eligible !== "boolean"
  ) {
    throw integrity("qualification result");
  }
  const coherent =
    (requirement === "REQUIRED" &&
      value.currentApproved === true &&
      value.eligible === true &&
      value.reasonCode === "REQUIRED_CREDENTIAL_APPROVED") ||
    (requirement === "REQUIRED" &&
      value.currentApproved === false &&
      value.eligible === false &&
      value.reasonCode === "REQUIRED_CREDENTIAL_MISSING") ||
    (requirement === "OPTIONAL" &&
      value.currentApproved === true &&
      value.eligible === true &&
      value.reasonCode === "OPTIONAL_CREDENTIAL_APPROVED") ||
    (requirement === "OPTIONAL" &&
      value.currentApproved === false &&
      value.eligible === true &&
      value.reasonCode === "OPTIONAL_CREDENTIAL_NOT_APPROVED");
  if (!coherent) throw integrity("qualification coherence");
  return value as unknown as CredentialQualificationResult;
}

function matchCategory(
  value:
    TaxonomyRelevanceFacts["skill"] | TaxonomyRelevanceFacts["specialization"],
): "MATCHED" | "NOT_MATCHED" | "NOT_REQUESTED" {
  return value === null
    ? "NOT_REQUESTED"
    : value.matched
      ? "MATCHED"
      : "NOT_MATCHED";
}

function geoBand(
  value: CraftsmanServiceAreaMatch["matchKind"],
): RecommendedRankingResult["geo"]["band"] {
  switch (value) {
    case "ADDITIONAL_SERVICE_AREA":
    case "WITHIN_NORMAL_RADIUS":
      return "STRONG_SERVICE_AREA";
    case "WITHIN_MAXIMUM_RADIUS":
      return "FARTHER_BY_AGREEMENT";
    case "OUTSIDE_DECLARED_AREA":
      return "OUTSIDE_DECLARED_AREA";
    case "DISTANCE_UNAVAILABLE":
      return "DISTANCE_UNAVAILABLE";
  }
}

function compareMatch(
  left: "MATCHED" | "NOT_MATCHED" | "NOT_REQUESTED",
  right: "MATCHED" | "NOT_MATCHED" | "NOT_REQUESTED",
): number {
  return Number(right === "MATCHED") - Number(left === "MATCHED");
}

function compareGeoBand(
  left: RecommendedRankingResult["geo"]["band"],
  right: RecommendedRankingResult["geo"]["band"],
): number {
  return geoPriority(right) - geoPriority(left);
}

function geoPriority(value: RecommendedRankingResult["geo"]["band"]): number {
  switch (value) {
    case "STRONG_SERVICE_AREA":
      return 3;
    case "FARTHER_BY_AGREEMENT":
      return 2;
    case "OUTSIDE_DECLARED_AREA":
      return 1;
    case "DISTANCE_UNAVAILABLE":
      return 0;
  }
}

function compareNullableDistance(
  left: number | null,
  right: number | null,
): number {
  if (left === null || right === null) return 0;
  return left - right;
}

function comparePositive(left: boolean, right: boolean): number {
  return Number(right) - Number(left);
}

function compareDeclaredLevel(
  left: ProfessionProficiencyLevel | null,
  right: ProfessionProficiencyLevel | null,
): number {
  return declaredLevelPriority(right) - declaredLevelPriority(left);
}

function declaredLevelPriority(
  value: ProfessionProficiencyLevel | null,
): number {
  switch (value) {
    case "MASTER":
      return 3;
    case "ADVANCED":
      return 2;
    case "BEGINNER":
      return 1;
    case null:
      return 0;
  }
}

function isSupport(value: unknown): value is TaxonomyEvidenceSupport {
  return (
    value === "NONE" ||
    value === "SELF_DECLARED" ||
    value === "EVIDENCE_SUPPORTED"
  );
}

function isLevelOrNull(
  value: unknown,
): value is ProfessionProficiencyLevel | null {
  return (
    value === null ||
    value === "BEGINNER" ||
    value === "ADVANCED" ||
    value === "MASTER"
  );
}

function isProfessionCode(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(?:PROF|TEST):[A-Z0-9][A-Z0-9_]{1,62}$/u.test(value)
  );
}

function isTaxonomyCode(
  value: unknown,
  namespace: "SPEC" | "SKILL",
): value is string {
  return (
    typeof value === "string" &&
    new RegExp(`^(?:${namespace}|TEST):[A-Z0-9][A-Z0-9_]{1,62}$`, "u").test(
      value,
    )
  );
}

function isBoundedInteger(value: unknown, maximum: number): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= maximum
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function integrity(field: string): RecommendedRankingIntegrityError {
  return new RecommendedRankingIntegrityError(
    `Invalid recommended-ranking ${field}.`,
  );
}
