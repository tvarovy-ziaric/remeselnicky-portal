import {
  createCraftsmanAvailabilityMatch,
  createCraftsmanServiceAreaMatch,
  type CraftsmanDistanceFact,
  type CraftsmanTrustEvidenceSummary,
  type MunicipalityCode,
  type SearchableCraftsmanCandidate,
} from "@portal/domain";
import {
  composeAvailabilityRelevance,
  composeGovernedTaxonomyRelevanceQuery,
  createTaxonomyAutocompleteService,
  projectTaxonomyRelevanceFacts,
  type CredentialQualificationResult,
  type BestRatedSortFact,
  type GovernedTaxonomyRelevanceQuery,
  type RecommendedQualificationContextResolver,
  type RecommendedRankingCandidate,
  type TaxonomyAutocompleteCandidate,
  type TaxonomyAutocompleteSuggestion,
} from "@portal/search";
import type { Sql, TransactionSql } from "postgres";

import { readCraftsmanCandidatesByIdsSnapshot } from "./craftsman-search-read-model-repository.js";
import { readCraftsmanTrustEvidenceSnapshot } from "./craftsman-trust-evidence-repository.js";

interface GovernedTargetRow {
  readonly code: string;
  readonly kind: "PROFESSION" | "SKILL" | "SPECIALIZATION";
  readonly label: string;
  readonly professionCodes: string[];
}

interface QualificationPolicyRow {
  readonly credentialTypeCode: string;
  readonly requirement: "OPTIONAL" | "REQUIRED";
}

interface QualificationEvaluationRow {
  readonly currentApproved: boolean;
  readonly credentialTypeCode: string;
  readonly eligibility: "NOT_QUALIFIED" | "QUALIFIED";
  readonly requirement: "OPTIONAL" | "REQUIRED";
}

interface CandidateIdRow {
  readonly profileId: string;
}

interface ServiceAreaRow {
  readonly approximateDistanceKm: number | null;
  readonly craftsmanProfileId: string;
  readonly matchKind: string;
  readonly rankingDistanceMeters: number | null;
}

interface AvailabilityRow {
  readonly craftsmanProfileId: string;
  readonly indicativelyAvailable: boolean;
  readonly matchKind: string;
}

export interface DatabasePublicSearchCardQuery {
  readonly afterProfileId: string | null;
  readonly filterIndicativelyAvailable: boolean;
  readonly identityQuery: string | null;
  readonly includeOutsideDeclaredArea: boolean;
  readonly limit: number;
  readonly municipalityCode: string | null;
  readonly professionCode: string;
  readonly skillCodes: readonly string[];
  readonly sort: "BEST_RATED" | "NEAREST" | "RECOMMENDED";
  readonly specializationCode: string | null;
  readonly timing: Readonly<{ endsAt: string; startsAt: string }> | null;
}

export interface DatabasePublicSearchPreparedCohort {
  readonly batch: Readonly<{
    distanceFacts: readonly CraftsmanDistanceFact[];
    publicCandidates: readonly SearchableCraftsmanCandidate[];
    rankingCandidates: readonly RecommendedRankingCandidate[];
    ratingFacts: readonly BestRatedSortFact[];
  }>;
  readonly qualificationResolver: RecommendedQualificationContextResolver;
  readonly taxonomy: GovernedTaxonomyRelevanceQuery;
}

export interface DatabasePublicSearchCardSource {
  withAuthoritativeCohort<Result>(
    query: DatabasePublicSearchCardQuery,
    maximumCandidates: number,
    use: (cohort: DatabasePublicSearchPreparedCohort | null) => Promise<Result>,
  ): Promise<Result>;
}

export function createPublicSearchCardSource(
  sql: Sql,
): DatabasePublicSearchCardSource {
  return Object.freeze({
    async withAuthoritativeCohort<Result>(
      query: DatabasePublicSearchCardQuery,
      maximumCandidates: number,
      use: (
        cohort: DatabasePublicSearchPreparedCohort | null,
      ) => Promise<Result>,
    ): Promise<Result> {
      if (
        !Number.isSafeInteger(maximumCandidates) ||
        maximumCandidates < 1 ||
        maximumCandidates > 100
      ) {
        throw new Error("Public search cohort bound is invalid.");
      }
      const wrapped = await sql.begin(
        "isolation level repeatable read read only",
        async (transaction) => {
          const taxonomy = await resolveGovernedTaxonomy(transaction, query);
          if (taxonomy === null) return { value: await use(null) };
          const candidates = await loadCandidateCohort(
            transaction,
            query,
            maximumCandidates,
          );
          const prepared = await prepareCohort(
            transaction,
            query,
            taxonomy,
            candidates,
          );
          return { value: await use(prepared) };
        },
      );
      return wrapped.value;
    },
  });
}

async function loadCandidateCohort(
  sql: TransactionSql,
  query: DatabasePublicSearchCardQuery,
  maximumCandidates: number,
): Promise<readonly SearchableCraftsmanCandidate[]> {
  const ids = await sql<CandidateIdRow[]>`
    SELECT profile.craftsman_profile_id AS "profileId"
    FROM current_searchable_craftsman_profiles profile
    JOIN current_searchable_craftsman_professions profession
      ON profession.craftsman_profile_id = profile.craftsman_profile_id
     AND profession.profession_code = ${query.professionCode}
    WHERE (
      ${query.identityQuery}::text IS NULL
      OR profile.identity_search_document @@ plainto_tsquery(
        'simple'::regconfig,
        craftsman_search_normalize_text(${query.identityQuery}::text)
      )
    )
    ORDER BY profile.craftsman_profile_id
    LIMIT ${maximumCandidates + 1}
  `;
  if (ids.length > maximumCandidates) {
    throw new Error("Public search cohort exceeds the Web Alpha safety cap.");
  }
  const page = await readCraftsmanCandidatesByIdsSnapshot(
    sql,
    ids.map(({ profileId }) => profileId),
  );
  if (page.items.length !== ids.length) {
    throw new Error("Public search cohort changed within its snapshot.");
  }
  return page.items;
}

async function prepareCohort(
  sql: TransactionSql,
  query: DatabasePublicSearchCardQuery,
  taxonomy: GovernedTaxonomyRelevanceQuery,
  candidates: readonly SearchableCraftsmanCandidate[],
) {
  if (
    query.municipalityCode !== null &&
    !(await locationIsAvailable(sql, query.municipalityCode))
  ) {
    return null;
  }
  const candidateIds = candidates.map(({ profileId }) => profileId);
  const serviceAreaRows = await sql<ServiceAreaRow[]>`
    SELECT match.craftsman_profile_id AS "craftsmanProfileId",
      match.match_kind AS "matchKind",
      match.ranking_distance_meters AS "rankingDistanceMeters",
      match.approximate_distance_km AS "approximateDistanceKm"
    FROM craftsman_service_area_match_facts(
      ${query.municipalityCode as MunicipalityCode | null},
      ${query.includeOutsideDeclaredArea}
    ) match
    WHERE match.craftsman_profile_id = ANY(${candidateIds}::uuid[])
    ORDER BY match.craftsman_profile_id
  `;
  const serviceArea = Object.freeze(
    serviceAreaRows.map(createCraftsmanServiceAreaMatch),
  );
  const startsAt =
    query.timing === null ? null : new Date(query.timing.startsAt);
  const endsAt = query.timing === null ? null : new Date(query.timing.endsAt);
  const availabilityRows = await sql<AvailabilityRow[]>`
    SELECT availability.craftsman_profile_id AS "craftsmanProfileId",
      availability.match_kind AS "matchKind",
      availability.indicatively_available AS "indicativelyAvailable"
    FROM craftsman_availability_match_facts(
      ${startsAt}, ${endsAt}, ${query.filterIndicativelyAvailable}
    ) availability
    WHERE availability.craftsman_profile_id = ANY(${candidateIds}::uuid[])
    ORDER BY availability.craftsman_profile_id
  `;
  const availability = Object.freeze(
    availabilityRows.map(createCraftsmanAvailabilityMatch),
  );
  const serviceIds = new Set(
    serviceArea.map(({ craftsmanProfileId }) => craftsmanProfileId),
  );
  const availableIds = new Set(
    availability.map(({ craftsmanProfileId }) => craftsmanProfileId),
  );
  const filtered = candidates.filter(
    ({ profileId }) => serviceIds.has(profileId) && availableIds.has(profileId),
  );
  const profileIds = filtered.map(({ profileId }) => profileId);
  const trust =
    profileIds.length === 0
      ? Object.freeze([] as CraftsmanTrustEvidenceSummary[])
      : await readCraftsmanTrustEvidenceSnapshot(sql, profileIds);
  const trustById = exactMap(trust, ({ profileId }) => profileId, "trust");
  const serviceById = exactMap(
    serviceArea.filter(({ craftsmanProfileId }) =>
      profileIds.includes(craftsmanProfileId),
    ),
    ({ craftsmanProfileId }) => craftsmanProfileId,
    "service area",
  );
  const availabilityById = exactMap(
    composeAvailabilityRelevance(filtered, availability, false).map(
      ({ availability: fact }) => fact,
    ),
    ({ profileId }) => profileId,
    "availability",
  );
  if (
    trustById.size !== filtered.length ||
    serviceById.size !== filtered.length ||
    availabilityById.size !== filtered.length
  ) {
    throw new Error("Public search source facts are not exactly aligned.");
  }
  const rankingCandidates = filtered.map((candidate) => ({
    availability: required(availabilityById, candidate.profileId),
    profileId: candidate.profileId,
    serviceArea: required(serviceById, candidate.profileId),
    taxonomy: projectTaxonomyRelevanceFacts(taxonomy, candidate),
    trust: required(trustById, candidate.profileId),
  }));
  const qualificationResolver = await qualificationResolverFor(
    sql,
    query.professionCode,
    profileIds,
  );
  const distanceFacts: CraftsmanDistanceFact[] = serviceArea
    .filter(({ craftsmanProfileId }) => profileIds.includes(craftsmanProfileId))
    .map((fact) =>
      Object.freeze({
        approximateDistanceKm: fact.approximateDistanceKm,
        craftsmanProfileId: fact.craftsmanProfileId,
        rankingDistanceMeters: fact.rankingDistanceMeters,
      }),
    );
  const batch = Object.freeze({
    distanceFacts: Object.freeze(distanceFacts),
    publicCandidates: Object.freeze(filtered),
    rankingCandidates: Object.freeze(rankingCandidates),
    ratingFacts: Object.freeze(
      filtered.map(({ profileId, signals }) =>
        Object.freeze({
          customerScore: signals.trust.customerScore,
          profileId,
          reviewCount: signals.trust.reviewCount,
          reviewSampleSufficient: signals.trust.reviewSampleSufficient,
        }),
      ),
    ),
  });
  return Object.freeze({ batch, qualificationResolver, taxonomy });
}

async function resolveGovernedTaxonomy(
  sql: TransactionSql,
  query: DatabasePublicSearchCardQuery,
): Promise<GovernedTaxonomyRelevanceQuery | null> {
  const targetCodes = [
    query.professionCode,
    ...(query.specializationCode === null ? [] : [query.specializationCode]),
    ...query.skillCodes,
  ];
  const rows = await sql<GovernedTargetRow[]>`
    WITH profession_release AS (
      SELECT activation.release_id
      FROM profession_taxonomy_activation_events activation
      ORDER BY activation.activation_sequence DESC
      LIMIT 1
    ), skill_release AS (
      SELECT activation.release_id
      FROM skill_catalog_activation_events activation
      ORDER BY activation.activation_sequence DESC
      LIMIT 1
    ), targets AS (
      SELECT profession.profession_code AS code, 'PROFESSION'::text AS kind,
        profession.label_sk AS label,
        ARRAY[profession.profession_code]::text[] AS profession_codes
      FROM profession_release release
      JOIN profession_taxonomy_releases metadata ON metadata.release_id = release.release_id
      JOIN taxonomy_professions profession ON profession.release_id = release.release_id
      WHERE metadata.content_class = 'CANONICAL'
        AND metadata.review_state = 'HUMAN_REVIEW_APPROVED'
        AND profession.state = 'ACTIVE'
      UNION ALL
      SELECT specialization.specialization_code, 'SPECIALIZATION'::text,
        specialization.label_sk, ARRAY[specialization.profession_code]::text[]
      FROM profession_release release
      JOIN profession_taxonomy_releases metadata ON metadata.release_id = release.release_id
      JOIN taxonomy_specializations specialization ON specialization.release_id = release.release_id
      JOIN taxonomy_professions profession
        ON profession.release_id = specialization.release_id
       AND profession.profession_code = specialization.profession_code
      WHERE metadata.content_class = 'CANONICAL'
        AND metadata.review_state = 'HUMAN_REVIEW_APPROVED'
        AND specialization.state = 'ACTIVE' AND profession.state = 'ACTIVE'
      UNION ALL
      SELECT skill.skill_code, 'SKILL'::text, skill.label_sk,
        array_agg(link.profession_code ORDER BY link.profession_code)::text[]
      FROM skill_release release
      JOIN skill_catalog_releases metadata ON metadata.release_id = release.release_id
      JOIN profession_release profession_release
        ON profession_release.release_id = metadata.profession_taxonomy_release_id
      JOIN skill_catalog_skills skill ON skill.release_id = release.release_id
      JOIN skill_catalog_skill_professions link
        ON link.release_id = skill.release_id AND link.skill_code = skill.skill_code
       AND link.profession_taxonomy_release_id = metadata.profession_taxonomy_release_id
      JOIN taxonomy_professions profession
        ON profession.release_id = link.profession_taxonomy_release_id
       AND profession.profession_code = link.profession_code
       AND profession.state = 'ACTIVE'
      WHERE metadata.content_class = 'CANONICAL'
        AND metadata.review_state = 'HUMAN_REVIEW_APPROVED'
        AND skill.state = 'ACTIVE'
      GROUP BY skill.skill_code, skill.label_sk
    )
    SELECT code, kind, label, profession_codes AS "professionCodes"
    FROM targets WHERE code = ANY(${targetCodes}::text[])
    ORDER BY code
  `;
  if (rows.length !== targetCodes.length) return null;
  const byCode = exactMap(rows, ({ code }) => code, "governed target");
  const profession = await governedSuggestion(
    required(byCode, query.professionCode),
  );
  const specialization =
    query.specializationCode === null
      ? null
      : await governedSuggestion(required(byCode, query.specializationCode));
  const skills = await Promise.all(
    query.skillCodes.map(async (code) =>
      governedSuggestion(required(byCode, code)),
    ),
  );
  if (
    profession.kind !== "PROFESSION" ||
    (specialization !== null &&
      (specialization.kind !== "SPECIALIZATION" ||
        !specialization.professionCodes.includes(query.professionCode))) ||
    skills.some(
      (skill) =>
        skill.kind !== "SKILL" ||
        !skill.professionCodes.includes(query.professionCode),
    )
  ) {
    return null;
  }
  return composeGovernedTaxonomyRelevanceQuery({
    profession,
    skills,
    specialization,
  });
}

async function locationIsAvailable(
  sql: TransactionSql,
  municipalityCode: string,
): Promise<boolean> {
  const rows = await sql<{ readonly available: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM location_municipalities municipality
      JOIN location_districts district ON district.code = municipality.district_code
      JOIN location_regions region ON region.code = district.region_code
      WHERE municipality.code = ${municipalityCode}
        AND municipality.is_active AND district.is_active AND region.is_active
    ) AS available
  `;
  return rows.length === 1 && rows[0]?.available === true;
}

async function governedSuggestion(
  row: GovernedTargetRow,
): Promise<TaxonomyAutocompleteSuggestion> {
  const candidate: TaxonomyAutocompleteCandidate = {
    ...row,
    governance: {
      activated: true,
      contentClass: "CANONICAL",
      entryState: "ACTIVE",
      reviewState: "HUMAN_REVIEW_APPROVED",
    },
    matchedBy: "EXACT_CANONICAL",
  };
  const result = await createTaxonomyAutocompleteService({
    findCandidates: () => Promise.resolve([candidate]),
  }).autocomplete({ limit: 1, query: row.label });
  const suggestion = result.status === "OK" ? result.suggestions[0] : undefined;
  if (suggestion === undefined || suggestion.code !== row.code) {
    throw new Error("Governed taxonomy target failed validation.");
  }
  return suggestion;
}

async function qualificationResolverFor(
  sql: TransactionSql,
  professionCode: string,
  profileIds: readonly string[],
): Promise<RecommendedQualificationContextResolver> {
  const policies = await sql<QualificationPolicyRow[]>`
    SELECT credential_type_code AS "credentialTypeCode", requirement
    FROM current_credential_qualification_policies
    WHERE profession_code = ${professionCode}
    ORDER BY requirement, credential_type_code
  `;
  if (
    new Set(policies.map(({ credentialTypeCode }) => credentialTypeCode))
      .size !== policies.length
  ) {
    throw new Error("Credential qualification policy is ambiguous.");
  }
  const requiredPolicies = policies.filter(
    ({ requirement }) => requirement === "REQUIRED",
  );
  const effectivePolicies =
    requiredPolicies.length > 0 ? requiredPolicies : policies;
  const regulation =
    requiredPolicies.length > 0
      ? ("REQUIRED" as const)
      : policies.length > 0
        ? ("OPTIONAL" as const)
        : ("NOT_REGULATED" as const);
  const types = effectivePolicies.map(
    ({ credentialTypeCode }) => credentialTypeCode,
  );
  const evaluations =
    regulation === "NOT_REGULATED" || profileIds.length === 0
      ? []
      : await sql<
          (QualificationEvaluationRow & { readonly profileId: string })[]
        >`
          SELECT selected.profile_id AS "profileId",
            policy.credential_type_code AS "credentialTypeCode",
            evaluated.eligibility, evaluated.requirement,
            evaluated.current_approved AS "currentApproved"
          FROM unnest(${profileIds}::uuid[]) selected(profile_id)
          JOIN current_credential_qualification_policies policy
            ON policy.profession_code = ${professionCode}
           AND policy.credential_type_code = ANY(${types}::text[])
          CROSS JOIN LATERAL evaluate_craftsman_credential_qualification(
            selected.profile_id, ${professionCode}, policy.credential_type_code
          ) evaluated
          ORDER BY selected.profile_id, policy.credential_type_code
        `;
  if (evaluations.length !== profileIds.length * types.length) {
    throw new Error("Credential qualification facts are incomplete.");
  }
  const evaluationByProfile = new Map<string, QualificationEvaluationRow[]>();
  for (const row of evaluations) {
    const values = evaluationByProfile.get(row.profileId) ?? [];
    if (
      values.some(
        ({ credentialTypeCode }) =>
          credentialTypeCode === row.credentialTypeCode,
      )
    ) {
      throw new Error("Credential qualification facts are duplicated.");
    }
    values.push(row);
    evaluationByProfile.set(row.profileId, values);
  }
  return Object.freeze({
    evaluateForGovernedQuery({ profileId }: { readonly profileId: string }) {
      if (regulation === "NOT_REGULATED") return Promise.resolve(null);
      const rows = evaluationByProfile.get(profileId) ?? [];
      if (rows.length !== types.length) {
        return Promise.resolve(unavailableQualification());
      }
      const approved =
        regulation === "REQUIRED"
          ? rows.every(
              (row) =>
                row.requirement === "REQUIRED" &&
                row.currentApproved &&
                row.eligibility === "QUALIFIED",
            )
          : rows.some(
              (row) =>
                row.requirement === "OPTIONAL" &&
                row.currentApproved &&
                row.eligibility === "QUALIFIED",
            );
      return Promise.resolve(qualificationResult(regulation, approved));
    },
    resolveForGovernedQuery: () =>
      Promise.resolve({ professionCode, regulation }),
  });
}

function qualificationResult(
  regulation: "OPTIONAL" | "REQUIRED",
  approved: boolean,
): CredentialQualificationResult {
  return Object.freeze({
    currentApproved: approved,
    eligible: regulation === "OPTIONAL" || approved,
    reasonCode:
      regulation === "REQUIRED"
        ? approved
          ? "REQUIRED_CREDENTIAL_APPROVED"
          : "REQUIRED_CREDENTIAL_MISSING"
        : approved
          ? "OPTIONAL_CREDENTIAL_APPROVED"
          : "OPTIONAL_CREDENTIAL_NOT_APPROVED",
    requirement: regulation,
    status: "OK" as const,
  });
}

function unavailableQualification(): CredentialQualificationResult {
  return Object.freeze({ eligible: false as const, status: "UNAVAILABLE" });
}

function exactMap<Value>(
  values: readonly Value[],
  identity: (value: Value) => string,
  label: string,
): ReadonlyMap<string, Value> {
  const result = new Map<string, Value>();
  for (const value of values) {
    const key = identity(value);
    if (result.has(key)) throw new Error(`Duplicate public search ${label}.`);
    result.set(key, value);
  }
  return result;
}

function required<Value>(
  values: ReadonlyMap<string, Value>,
  key: string,
): Value {
  const value = values.get(key);
  if (value === undefined)
    throw new Error("Public search source fact is missing.");
  return value;
}
