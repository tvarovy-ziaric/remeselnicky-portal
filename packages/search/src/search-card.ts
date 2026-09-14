import type {
  CraftsmanDistanceFact,
  SearchableCraftsmanCandidate,
} from "@portal/domain";
import {
  assertCraftsmanAvailabilityMatchQuery,
  normalizeSearchCraftsmanCandidatesInput,
} from "@portal/domain";

import {
  sortEligibleSearchCandidates,
  type BestRatedSortFact,
} from "./alternate-sort.js";
import {
  createRecommendedRankingPipeline,
  RECOMMENDED_RANKING_MAX_CANDIDATES,
  type RecommendedQualificationContextResolver,
  type RecommendedRankingCandidate,
  type RecommendedRankingResult,
} from "./recommended-ranking.js";
import type { GovernedTaxonomyRelevanceQuery } from "./taxonomy-relevance.js";

export const PUBLIC_SEARCH_CARD_DEFAULT_LIMIT = 20;
export const PUBLIC_SEARCH_CARD_MAX_LIMIT = 50;
export const PUBLIC_SEARCH_CARD_MAX_REASONS = 5;
export const PUBLIC_SEARCH_CARD_MAX_BADGES = 5;
export const PUBLIC_SEARCH_CARD_MAX_SKILLS = 20;

export const PUBLIC_SEARCH_SORT_MODES = Object.freeze([
  "RECOMMENDED",
  "NEAREST",
  "BEST_RATED",
] as const);
export type PublicSearchSortMode = (typeof PUBLIC_SEARCH_SORT_MODES)[number];

export interface PublicSearchCardQuery {
  readonly afterProfileId: string | null;
  readonly filterIndicativelyAvailable: boolean;
  readonly includeOutsideDeclaredArea: boolean;
  readonly identityQuery: string | null;
  readonly limit: number;
  readonly municipalityCode: string | null;
  readonly professionCode: string;
  readonly skillCodes: readonly string[];
  readonly sort: PublicSearchSortMode;
  readonly specializationCode: string | null;
  readonly timing: Readonly<{
    readonly endsAt: string;
    readonly startsAt: string;
  }> | null;
}

export interface PublicSearchCard {
  readonly profileId: string;
  readonly identity: Readonly<{
    readonly profileType: "INDIVIDUAL" | "COMPANY";
    readonly primaryName: string;
    readonly secondaryName: string | null;
  }>;
  readonly professions: readonly Readonly<{
    readonly code: string;
    readonly label: string;
  }>[];
  readonly location: Readonly<{
    readonly municipalityName: string;
    readonly approximateDistanceKm: number | null;
  }>;
  readonly rating: Readonly<{
    readonly score: number | null;
    readonly reviewCount: number;
  }>;
  readonly verifiedWorkCount: number;
  readonly badges: readonly PublicSearchCardBadge[];
  readonly availability: "INDICATIVELY_AVAILABLE" | "NO_POSITIVE_SIGNAL";
  readonly representativePortfolioImage: Readonly<{
    readonly mediaAssetId: string;
  }> | null;
  /** No canonical service-to-price link exists yet, so R2-011 stays closed. */
  readonly indicativePrice: null;
  readonly whyMatched: readonly PublicSearchCardReason[];
}

export interface PublicSearchCardBadge {
  readonly kind:
    | "EVIDENCE_SUPPORTED_PROFESSION"
    | "EVIDENCE_SUPPORTED_SKILL"
    | "EVIDENCE_SUPPORTED_SPECIALIZATION"
    | "VERIFIED_CREDENTIAL"
    | "VERIFIED_PORTFOLIO";
  readonly label: string;
}

export interface PublicSearchCardReason {
  readonly kind:
    | "PROFESSION"
    | "SPECIALIZATION"
    | "SKILL"
    | "GEO"
    | "REQUIRED_QUALIFICATION"
    | "AVAILABILITY"
    | "EVIDENCE_TRUST";
  readonly text: string;
}

export interface PublicSearchCardPage {
  readonly items: readonly PublicSearchCard[];
  readonly nextCursor: string | null;
}

export type PublicSearchCardSearchResult = Readonly<
  | { readonly status: "OK"; readonly page: PublicSearchCardPage }
  | { readonly status: "INVALID_QUERY" }
>;

export interface PublicSearchDiscoveryBatch {
  readonly distanceFacts: readonly CraftsmanDistanceFact[];
  readonly publicCandidates: readonly SearchableCraftsmanCandidate[];
  readonly rankingCandidates: readonly RecommendedRankingCandidate[];
  readonly ratingFacts: readonly BestRatedSortFact[];
}

export interface PublicSearchPreparedCohort {
  readonly batch: PublicSearchDiscoveryBatch;
  readonly qualificationResolver: RecommendedQualificationContextResolver;
  readonly taxonomy: GovernedTaxonomyRelevanceQuery;
}

/** Server-only source. Its implementation must read the authoritative 0029 seam. */
export interface PublicSearchCardSource {
  /**
   * Keeps taxonomy, PUBLIC/ACTIVE candidates, geo, availability, trust and
   * qualification in one authoritative snapshot through `use`. It must not
   * apply the outward card cursor.
   */
  withAuthoritativeCohort<Result>(
    query: PublicSearchCardQuery,
    maximumCandidates: number,
    use: (cohort: PublicSearchPreparedCohort | null) => Promise<Result>,
  ): Promise<Result>;
}

export interface PublicSearchCardSearch {
  search(input: unknown): Promise<PublicSearchCardSearchResult>;
}

export class PublicSearchCardIntegrityError extends Error {
  override readonly name = "PublicSearchCardIntegrityError";
}

export function createPublicSearchCardSearch(
  source: PublicSearchCardSource,
): PublicSearchCardSearch {
  return Object.freeze({
    async search(input: unknown): Promise<PublicSearchCardSearchResult> {
      const query = parsePublicSearchCardQuery(input);
      if (query === null) return Object.freeze({ status: "INVALID_QUERY" });
      return source.withAuthoritativeCohort(
        query,
        RECOMMENDED_RANKING_MAX_CANDIDATES,
        async (prepared) => {
          if (
            prepared === null ||
            !matchesGovernedTaxonomy(query, prepared.taxonomy)
          ) {
            return Object.freeze({ status: "INVALID_QUERY" as const });
          }
          const { batch } = prepared;
          assertDiscoveryBatch(batch);
          const recommended = await createRecommendedRankingPipeline(
            prepared.qualificationResolver,
          ).rank(batch.rankingCandidates);
          const eligibleIds = new Set(
            recommended.map(({ profileId }) => profileId),
          );
          const ordered = applySort(
            query.sort,
            recommended,
            batch.distanceFacts.filter(({ craftsmanProfileId }) =>
              eligibleIds.has(craftsmanProfileId),
            ),
            batch.ratingFacts.filter(({ profileId }) =>
              eligibleIds.has(profileId),
            ),
          );
          const eligibleCandidates = batch.publicCandidates.filter(
            ({ profileId }) => eligibleIds.has(profileId),
          );
          const allItems = composePublicSearchCards({
            candidates: eligibleCandidates,
            professionCode: query.professionCode,
            ranked: ordered,
            skillCodes: query.skillCodes,
            specializationCode: query.specializationCode,
          });
          const page = paginateCards(
            allItems,
            query.afterProfileId,
            query.limit,
          );
          return Object.freeze({ page, status: "OK" as const });
        },
      );
    },
  });
}

export function composePublicSearchCards(input: {
  readonly candidates: readonly SearchableCraftsmanCandidate[];
  readonly professionCode: string;
  readonly ranked: readonly RecommendedRankingResult[];
  readonly skillCodes?: readonly string[];
  readonly specializationCode?: string | null;
}): readonly PublicSearchCard[] {
  if (!isProfessionCode(input.professionCode)) throw integrity("profession");
  const candidates = exactMap(
    input.candidates,
    ({ profileId }) => profileId,
    "candidate",
  );
  const ranked = exactMap(
    input.ranked,
    ({ profileId }) => profileId,
    "ranking",
  );
  if (!sameKeys(candidates, ranked)) throw integrity("profile alignment");
  return Object.freeze(
    input.ranked
      .map((ranking) =>
        projectCard(
          candidates.get(ranking.profileId),
          ranking,
          input.professionCode,
          input.specializationCode ?? null,
          input.skillCodes ?? [],
        ),
      )
      .filter((card): card is PublicSearchCard => card !== null),
  );
}

export function parsePublicSearchCardQuery(
  input: unknown,
): PublicSearchCardQuery | null {
  if (!isRecord(input)) return null;
  const allowed = new Set([
    "afterProfileId",
    "endsAt",
    "filterIndicativelyAvailable",
    "identityQuery",
    "includeOutsideDeclaredArea",
    "limit",
    "municipalityCode",
    "professionCode",
    "skillCodes",
    "sort",
    "specializationCode",
    "startsAt",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) return null;
  const professionCode = singleString(input["professionCode"]);
  const municipalityCode = nullableSingleString(input["municipalityCode"]);
  const afterProfileId = nullableSingleString(input["afterProfileId"]);
  const sort = singleString(input["sort"] ?? "RECOMMENDED");
  const limit = parseLimit(input["limit"]);
  const identityQuery = parseIdentityQuery(input["identityQuery"]);
  const specializationCode = nullableSingleString(input["specializationCode"]);
  const skillCodes = repeatedStrings(input["skillCodes"]);
  const includeOutsideDeclaredArea = parseBoolean(
    input["includeOutsideDeclaredArea"],
    false,
  );
  const filterIndicativelyAvailable = parseBoolean(
    input["filterIndicativelyAvailable"],
    false,
  );
  const timing = parseTiming(input["startsAt"], input["endsAt"]);
  if (
    professionCode === null ||
    !isProfessionCode(professionCode) ||
    municipalityCode === undefined ||
    (municipalityCode !== null && !isMunicipalityCode(municipalityCode)) ||
    afterProfileId === undefined ||
    (afterProfileId !== null && !isUuid(afterProfileId)) ||
    sort === null ||
    !PUBLIC_SEARCH_SORT_MODES.some((value) => value === sort) ||
    limit === null ||
    identityQuery === undefined ||
    specializationCode === undefined ||
    (specializationCode !== null &&
      !isSpecializationCode(specializationCode)) ||
    skillCodes === null ||
    includeOutsideDeclaredArea === null ||
    filterIndicativelyAvailable === null ||
    timing === undefined ||
    (filterIndicativelyAvailable && timing === null)
  ) {
    return null;
  }
  const normalizedSort = sort as PublicSearchSortMode;
  return Object.freeze({
    afterProfileId,
    filterIndicativelyAvailable,
    identityQuery,
    includeOutsideDeclaredArea,
    limit,
    municipalityCode,
    professionCode,
    skillCodes,
    sort: normalizedSort,
    specializationCode,
    timing,
  });
}

function applySort(
  mode: PublicSearchSortMode,
  candidates: readonly RecommendedRankingResult[],
  distanceFacts: readonly CraftsmanDistanceFact[],
  ratingFacts: readonly BestRatedSortFact[],
): readonly RecommendedRankingResult[] {
  if (mode === "RECOMMENDED") return candidates;
  return mode === "NEAREST"
    ? sortEligibleSearchCandidates({ candidates, distanceFacts, mode })
    : sortEligibleSearchCandidates({ candidates, mode, ratingFacts });
}

function projectCard(
  candidate: SearchableCraftsmanCandidate | undefined,
  ranking: RecommendedRankingResult,
  professionCode: string,
  specializationCode: string | null,
  skillCodes: readonly string[],
): PublicSearchCard | null {
  try {
    return projectCardChecked(
      candidate,
      ranking,
      professionCode,
      specializationCode,
      skillCodes,
    );
  } catch {
    // Persistence and composition inputs are trusted server seams, but a corrupt
    // row still fails closed as one absent card instead of leaking a partial DTO.
    return null;
  }
}

function projectCardChecked(
  candidate: SearchableCraftsmanCandidate | undefined,
  ranking: RecommendedRankingResult,
  professionCode: string,
  specializationCode: string | null,
  skillCodes: readonly string[],
): PublicSearchCard | null {
  if (
    candidate === undefined ||
    candidate.profileId !== ranking.profileId ||
    !validRanking(ranking) ||
    ranking.taxonomy.profession !== "EXACT_PROFESSION"
  ) {
    return null;
  }
  const profession = candidate.professions.find(
    ({ code }) => code === professionCode,
  );
  const specialization =
    specializationCode === null
      ? undefined
      : candidate.specializations.find(
          ({ code, professionCode: linkedProfession }) =>
            code === specializationCode && linkedProfession === professionCode,
        );
  const skill = candidate.skills
    .filter(
      ({ canonicalCode, professionCodes }) =>
        canonicalCode !== null &&
        skillCodes.includes(canonicalCode) &&
        professionCodes.includes(professionCode),
    )
    .sort(
      (left, right) =>
        Number(right.evidenceSupported) - Number(left.evidenceSupported) ||
        codePointCompare(left.canonicalCode ?? "", right.canonicalCode ?? ""),
    )[0];
  if (
    profession === undefined ||
    !safePublicText(candidate.identity.primaryName, 1, 120) ||
    (candidate.identity.secondaryName !== null &&
      !safePublicText(candidate.identity.secondaryName, 1, 120)) ||
    (candidate.identity.profileType === "COMPANY" &&
      candidate.identity.secondaryName !== null) ||
    !safePublicText(candidate.location.baseMunicipalityName, 1, 120) ||
    !safePublicText(profession.label, 2, 120) ||
    !capabilityMatches(
      ranking.taxonomy.specialization,
      specializationCode !== null,
      specialization,
    ) ||
    !capabilityMatches(ranking.taxonomy.skill, skillCodes.length > 0, skill) ||
    (specialization !== undefined &&
      !safePublicText(specialization.label, 2, 120)) ||
    (skill !== undefined && !safePublicText(skill.label, 2, 120)) ||
    !validTrust(candidate.signals.trust) ||
    (candidate.signals.portfolio.representativeMediaAssetId !== null &&
      !isUuid(candidate.signals.portfolio.representativeMediaAssetId))
  ) {
    return null;
  }
  const badges = makeBadges(
    ranking,
    specializationCode !== null,
    skillCodes.length > 0,
  );
  const whyMatched = makeReasons(
    ranking,
    profession.label,
    specialization?.label ?? null,
    skill?.label ?? null,
  );
  if (
    badges.some(({ label }) => !safePublicText(label, 2, 120)) ||
    whyMatched.some(({ text }) => !safePublicText(text, 2, 180))
  ) {
    return null;
  }
  return Object.freeze({
    availability:
      ranking.availability === "SOFT_POSITIVE"
        ? ("INDICATIVELY_AVAILABLE" as const)
        : ("NO_POSITIVE_SIGNAL" as const),
    badges,
    identity: Object.freeze({
      primaryName: candidate.identity.primaryName,
      profileType: candidate.identity.profileType,
      secondaryName: candidate.identity.secondaryName,
    }),
    indicativePrice: null,
    location: Object.freeze({
      approximateDistanceKm: ranking.geo.approximateDistanceKm,
      municipalityName: candidate.location.baseMunicipalityName,
    }),
    professions: Object.freeze([
      Object.freeze({ code: profession.code, label: profession.label }),
    ]),
    profileId: candidate.profileId,
    rating: Object.freeze({
      reviewCount: candidate.signals.trust.reviewCount,
      score: candidate.signals.trust.customerScore,
    }),
    representativePortfolioImage:
      candidate.signals.portfolio.representativeMediaAssetId === null
        ? null
        : Object.freeze({
            mediaAssetId:
              candidate.signals.portfolio.representativeMediaAssetId,
          }),
    verifiedWorkCount: candidate.signals.trust.verifiedWorkCount,
    whyMatched,
  });
}

function makeBadges(
  ranking: RecommendedRankingResult,
  specializationRequested: boolean,
  skillRequested: boolean,
): readonly PublicSearchCardBadge[] {
  const badges: PublicSearchCardBadge[] = [];
  if (ranking.evidence.professionLevelSupported) {
    badges.push({
      kind: "EVIDENCE_SUPPORTED_PROFESSION",
      label: "Odborná úroveň podporená dôkazmi",
    });
  }
  if (ranking.evidence.relevantSpecializationSupported) {
    badges.push({
      kind: "EVIDENCE_SUPPORTED_SPECIALIZATION",
      label: "Špecializácia podporená dôkazmi",
    });
  }
  if (ranking.evidence.relevantSkillSupported) {
    badges.push({
      kind: "EVIDENCE_SUPPORTED_SKILL",
      label: "Zručnosť podporená dôkazmi",
    });
  }
  if (
    ranking.qualification === "REQUIRED_APPROVED" ||
    ranking.qualification === "OPTIONAL_APPROVED"
  ) {
    badges.push({
      kind: "VERIFIED_CREDENTIAL",
      label: "Profesijné oprávnenie overené",
    });
  }
  if (
    ranking.evidence.verifiedPortfolioPresent &&
    !specializationRequested &&
    !skillRequested
  ) {
    badges.push({
      kind: "VERIFIED_PORTFOLIO",
      label: "Portfólio podporené overenou realizáciou",
    });
  }
  return Object.freeze(
    dedupeBy(badges, ({ kind }) => kind)
      .slice(0, PUBLIC_SEARCH_CARD_MAX_BADGES)
      .map((badge) => Object.freeze(badge)),
  );
}

function makeReasons(
  ranking: RecommendedRankingResult,
  professionLabel: string,
  specializationLabel: string | null,
  skillLabel: string | null,
): readonly PublicSearchCardReason[] {
  const reasons: PublicSearchCardReason[] = [
    { kind: "PROFESSION", text: `Vykonáva profesiu ${professionLabel}` },
  ];
  if (specializationLabel !== null) {
    reasons.push({
      kind: "SPECIALIZATION",
      text: `Ponúka hľadanú špecializáciu ${specializationLabel}`,
    });
  }
  if (skillLabel !== null) {
    reasons.push({
      kind: "SKILL",
      text: `Ponúka hľadanú zručnosť ${skillLabel}`,
    });
  }
  if (ranking.geo.approximateDistanceKm !== null) {
    reasons.push({
      kind: "GEO",
      text: `Približne ${ranking.geo.approximateDistanceKm} km od zadanej lokality`,
    });
  }
  if (ranking.qualification === "REQUIRED_APPROVED") {
    reasons.push({
      kind: "REQUIRED_QUALIFICATION",
      text: "Požadované profesijné oprávnenie je overené",
    });
  }
  if (ranking.availability === "SOFT_POSITIVE") {
    reasons.push({
      kind: "AVAILABILITY",
      text: "Orientačne dostupný vo vašom termíne",
    });
  }
  const evidenceText = evidenceReason(ranking);
  if (evidenceText !== null) {
    reasons.push({ kind: "EVIDENCE_TRUST", text: evidenceText });
  }
  return Object.freeze(
    dedupeBy(reasons, ({ kind }) => kind)
      .slice(0, PUBLIC_SEARCH_CARD_MAX_REASONS)
      .map((reason) => Object.freeze(reason)),
  );
}

function evidenceReason(ranking: RecommendedRankingResult): string | null {
  if (ranking.evidence.verifiedWorkPresent) return "Má overenú realizáciu";
  if (ranking.evidence.relevantSpecializationSupported) {
    return "Zhodná špecializácia je podporená dôkazmi";
  }
  if (ranking.evidence.relevantSkillSupported) {
    return "Zhodná zručnosť je podporená dôkazmi";
  }
  if (ranking.evidence.professionLevelSupported) {
    return "Odborná úroveň je podporená dôkazmi";
  }
  if (ranking.qualification === "OPTIONAL_APPROVED") {
    return "Relevantné profesijné oprávnenie je overené";
  }
  return null;
}

function validRanking(value: unknown): value is RecommendedRankingResult {
  if (!isRecord(value)) return false;
  const taxonomy = value["taxonomy"];
  const geo = value["geo"];
  const evidence = value["evidence"];
  const secondary = value["secondary"];
  if (
    !isRecord(taxonomy) ||
    !isRecord(geo) ||
    !isRecord(evidence) ||
    !isRecord(secondary)
  ) {
    return false;
  }
  if (
    !isUuid(value["profileId"]) ||
    taxonomy["profession"] !== "EXACT_PROFESSION" ||
    !["MATCHED", "NOT_MATCHED", "NOT_REQUESTED"].includes(
      String(taxonomy["specialization"]),
    ) ||
    !["MATCHED", "NOT_MATCHED", "NOT_REQUESTED"].includes(
      String(taxonomy["skill"]),
    ) ||
    ![
      "STRONG_SERVICE_AREA",
      "FARTHER_BY_AGREEMENT",
      "OUTSIDE_DECLARED_AREA",
      "DISTANCE_UNAVAILABLE",
    ].includes(String(geo["band"])) ||
    ![
      "NOT_REGULATED",
      "REQUIRED_APPROVED",
      "OPTIONAL_APPROVED",
      "OPTIONAL_NOT_APPROVED",
    ].includes(String(value["qualification"])) ||
    !["SOFT_POSITIVE", "NEUTRAL"].includes(String(value["availability"])) ||
    !["SUPPORTED", "COLD_START_NEUTRAL"].includes(
      String(evidence["category"]),
    ) ||
    secondary["influence"] !== "WEAK_CONTEXT_ONLY"
  ) {
    return false;
  }
  const booleans = [
    evidence["approvedCredentialPresent"],
    evidence["professionLevelSupported"],
    evidence["relevantSkillSupported"],
    evidence["relevantSpecializationSupported"],
    evidence["verifiedPortfolioPresent"],
    evidence["verifiedWorkPresent"],
  ];
  const distance = geo["approximateDistanceKm"];
  const distanceUnavailable = geo["band"] === "DISTANCE_UNAVAILABLE";
  return (
    booleans.every((candidate) => typeof candidate === "boolean") &&
    distanceUnavailable === (distance === null) &&
    (distance === null ||
      (typeof distance === "number" &&
        Number.isSafeInteger(distance) &&
        distance >= 0 &&
        distance <= 20_040)) &&
    (evidence["category"] === "SUPPORTED") === booleans.some(Boolean)
  );
}

function validTrust(
  value: SearchableCraftsmanCandidate["signals"]["trust"],
): boolean {
  return (
    Number.isSafeInteger(value.reviewCount) &&
    value.reviewCount >= 0 &&
    Number.isSafeInteger(value.verifiedWorkCount) &&
    value.verifiedWorkCount >= 0 &&
    (value.customerScore === null ||
      (typeof value.customerScore === "number" &&
        Number.isFinite(value.customerScore) &&
        value.customerScore >= 0 &&
        value.customerScore <= 5 &&
        value.reviewCount > 0))
  );
}

function assertDiscoveryBatch(batch: PublicSearchDiscoveryBatch): void {
  if (batch === null || typeof batch !== "object") throw integrity("batch");
  if (
    !isArray(batch.publicCandidates) ||
    batch.publicCandidates.length > RECOMMENDED_RANKING_MAX_CANDIDATES
  ) {
    throw integrity("bounded cohort");
  }
  const publicIds = identities(
    batch.publicCandidates,
    ({ profileId }) => profileId,
  );
  const rankingIds = identities(
    batch.rankingCandidates,
    ({ profileId }) => profileId,
  );
  const distanceIds = identities(
    batch.distanceFacts,
    ({ craftsmanProfileId }) => craftsmanProfileId,
  );
  const ratingIds = identities(batch.ratingFacts, ({ profileId }) => profileId);
  if (
    !sameIdentitySets(publicIds, rankingIds) ||
    !sameIdentitySets(publicIds, distanceIds) ||
    !sameIdentitySets(publicIds, ratingIds)
  ) {
    throw integrity("source alignment");
  }
}

function paginateCards(
  cards: readonly PublicSearchCard[],
  afterProfileId: string | null,
  limit: number,
): PublicSearchCardPage {
  const start =
    afterProfileId === null
      ? 0
      : cards.findIndex(({ profileId }) => profileId === afterProfileId) + 1;
  if (afterProfileId !== null && start === 0) throw integrity("cursor");
  const items = Object.freeze(cards.slice(start, start + limit));
  const nextCursor =
    start + limit < cards.length ? (items.at(-1)?.profileId ?? null) : null;
  return Object.freeze({ items, nextCursor });
}

function matchesGovernedTaxonomy(
  query: PublicSearchCardQuery,
  taxonomy: GovernedTaxonomyRelevanceQuery,
): boolean {
  return (
    taxonomy.professionCode === query.professionCode &&
    taxonomy.specializationCode === query.specializationCode &&
    taxonomy.skillCodes.length === query.skillCodes.length &&
    taxonomy.skillCodes.every((code, index) => code === query.skillCodes[index])
  );
}

function capabilityMatches(
  category: "MATCHED" | "NOT_MATCHED" | "NOT_REQUESTED",
  requested: boolean,
  value: unknown,
): boolean {
  return requested
    ? category === (value === undefined ? "NOT_MATCHED" : "MATCHED")
    : category === "NOT_REQUESTED" && value === undefined;
}

function identities<T>(
  values: readonly T[],
  id: (value: T) => string,
): Set<string> {
  if (!isArray(values)) throw integrity("fact array");
  const result = new Set<string>();
  for (const value of values) {
    const candidate = id(value);
    if (!isUuid(candidate) || result.has(candidate))
      throw integrity("fact identity");
    result.add(candidate);
  }
  return result;
}

function exactMap<T>(
  values: readonly T[],
  id: (value: T) => string,
  label: string,
): ReadonlyMap<string, T> {
  if (!isArray(values)) throw integrity(`${label} array`);
  const result = new Map<string, T>();
  for (const value of values) {
    const identity = id(value);
    if (!isUuid(identity) || result.has(identity))
      throw integrity(`${label} identity`);
    result.set(identity, value);
  }
  return result;
}

function sameKeys(
  left: ReadonlyMap<string, unknown>,
  right: ReadonlyMap<string, unknown>,
) {
  return (
    left.size === right.size && [...left.keys()].every((key) => right.has(key))
  );
}

function sameIdentitySets(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
) {
  return left.size === right.size && [...left].every((key) => right.has(key));
}

function dedupeBy<T>(values: readonly T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const identity = key(value);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function safePublicText(
  value: string,
  minimum: number,
  maximum: number,
): boolean {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length < minimum ||
    value.length > maximum ||
    /[\r\n\p{Cc}]/u.test(value)
  ) {
    return false;
  }
  return [
    /[\p{L}\d._%+-]+@[\p{L}\d.-]+\.[\p{L}]{2,}/iu,
    /(^|[^0-9])(\+|00)?[0-9]([\s()./-]*[0-9]){6,}([^0-9]|$)/u,
    /\b(?:https?:\/\/|www\.)/iu,
    /\b(?:adresa|ulica|číslo domu|číslo bytu)\b/iu,
    /\b(?:heslo|password|api[ _-]?key|access[ _-]?token|secret)\b/iu,
  ].every((pattern) => !pattern.test(value));
}

function parseLimit(value: unknown): number | null {
  if (value === undefined) return PUBLIC_SEARCH_CARD_DEFAULT_LIMIT;
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[1-9][0-9]*$/u.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(numeric) &&
    numeric >= 1 &&
    numeric <= PUBLIC_SEARCH_CARD_MAX_LIMIT
    ? numeric
    : null;
}

function singleString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nullableSingleString(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  return typeof value === "string" ? value : undefined;
}

function repeatedStrings(value: unknown): readonly string[] | null {
  if (value === undefined || value === null || value === "")
    return Object.freeze([]);
  const values = Array.isArray(value) ? value : [value];
  if (
    values.length > PUBLIC_SEARCH_CARD_MAX_SKILLS ||
    values.some((item) => typeof item !== "string" || !isSkillCode(item))
  ) {
    return null;
  }
  const normalized = [...(values as string[])].sort(codePointCompare);
  return new Set(normalized).size === normalized.length
    ? Object.freeze(normalized)
    : null;
}

function parseBoolean(value: unknown, fallback: boolean): boolean | null {
  if (value === undefined) return fallback;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return null;
}

function parseTiming(
  startsAt: unknown,
  endsAt: unknown,
): PublicSearchCardQuery["timing"] | undefined {
  if (startsAt === undefined && endsAt === undefined) return null;
  if (typeof startsAt !== "string" || typeof endsAt !== "string") {
    return undefined;
  }
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  if (
    !Number.isFinite(start.valueOf()) ||
    !Number.isFinite(end.valueOf()) ||
    start.toISOString() !== startsAt ||
    end.toISOString() !== endsAt
  ) {
    return undefined;
  }
  try {
    assertCraftsmanAvailabilityMatchQuery({
      endsAt: end,
      filterIndicativelyAvailable: false,
      limit: 1,
      startsAt: start,
    });
  } catch {
    return undefined;
  }
  return Object.freeze({ endsAt, startsAt });
}

function parseIdentityQuery(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return undefined;
  try {
    return normalizeSearchCraftsmanCandidatesInput({
      identityQuery: value,
      limit: 1,
    }).identityQuery;
  } catch {
    return undefined;
  }
}

function isProfessionCode(value: string): boolean {
  return /^(?:PROF|TEST):[A-Z0-9][A-Z0-9_]{1,62}$/u.test(value);
}

function isSpecializationCode(value: string): boolean {
  return /^(?:SPEC|TEST):[A-Z0-9][A-Z0-9_]{1,62}$/u.test(value);
}

function isSkillCode(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(?:SKILL|TEST):[A-Z0-9][A-Z0-9_]{1,62}$/u.test(value)
  );
}

function isMunicipalityCode(value: string): boolean {
  return value.length <= 64 && /^[A-Z0-9][A-Z0-9._:-]*$/u.test(value);
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isArray(value: unknown): boolean {
  return Array.isArray(value);
}

function codePointCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function integrity(field: string): PublicSearchCardIntegrityError {
  return new PublicSearchCardIntegrityError(
    `Invalid public search card ${field}.`,
  );
}
