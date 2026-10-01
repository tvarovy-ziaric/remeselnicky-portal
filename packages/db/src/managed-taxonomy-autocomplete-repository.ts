import type {
  ParsedTaxonomyAutocompleteQuery,
  TaxonomyAutocompleteCandidate,
  TaxonomyAutocompletePersistence,
} from "@portal/search";
import type { Sql } from "postgres";

interface CandidateRow {
  readonly activated: boolean;
  readonly code: string;
  readonly contentClass: string;
  readonly entryState: string;
  readonly kind: string;
  readonly label: string;
  readonly matchedBy: string;
  readonly memberCount: number;
  readonly professionCodes: readonly string[];
  readonly routingProfessionCode: string | null;
  readonly reviewState: string;
}

/** Unified managed Profession/Service discovery plus scoped capability lookup. */
export function createManagedTaxonomyAutocompleteRepository(
  sql: Sql,
): TaxonomyAutocompletePersistence {
  return Object.freeze({
    async findCandidates(query: ParsedTaxonomyAutocompleteQuery) {
      assertQuery(query);
      const rows = await sql<CandidateRow[]>`
        WITH current_release AS (
          SELECT release.*
          FROM profession_taxonomy_activation_events activation
          JOIN profession_taxonomy_releases release
            ON release.release_id = activation.release_id
          WHERE release.content_class = 'CANONICAL'
            AND release.review_state = 'HUMAN_REVIEW_APPROVED'
          ORDER BY activation.activation_sequence DESC LIMIT 1
        ), current_skill_release AS (
          SELECT release.*
          FROM skill_catalog_activation_events activation
          JOIN skill_catalog_releases release
            ON release.release_id = activation.release_id
          JOIN current_release profession_release
            ON profession_release.release_id = release.profession_taxonomy_release_id
          WHERE release.content_class = 'CANONICAL'
            AND release.review_state = 'HUMAN_REVIEW_APPROVED'
          ORDER BY activation.activation_sequence DESC LIMIT 1
        ), items AS (
          SELECT profession.profession_code AS code, 'PROFESSION'::text AS kind,
            profession.label_sk AS label,
            ARRAY[profession.profession_code]::text[] AS profession_codes,
            profession.profession_code AS routing_profession_code,
            profession.state::text AS entry_state,
            release.content_class::text AS content_class,
            release.review_state::text AS review_state
          FROM current_release release
          JOIN taxonomy_professions profession ON profession.release_id = release.release_id
          WHERE profession.state = 'ACTIVE'
            AND profession.profession_code ~ '^PROF:[A-Z0-9][A-Z0-9_]{1,62}$'
            AND profession.profession_code <> 'PROF:ALPHA_SYNTHETIC'
          UNION ALL
          SELECT service.service_code, 'SERVICE'::text, service.label_sk,
            links.profession_codes, links.routing_profession_code, service.state::text,
            release.content_class::text, release.review_state::text
          FROM current_release release
          JOIN taxonomy_services service ON service.release_id = release.release_id
          JOIN LATERAL (
            SELECT array_agg(link.profession_code ORDER BY link.profession_code)::text[]
              AS profession_codes,
              max(link.profession_code) FILTER (WHERE link.is_primary)
                AS routing_profession_code
            FROM taxonomy_service_professions link
            JOIN taxonomy_professions profession
              ON profession.release_id = link.release_id
             AND profession.profession_code = link.profession_code
             AND profession.state = 'ACTIVE'
            WHERE link.release_id = service.release_id
              AND link.service_code = service.service_code
          ) links ON true
          WHERE service.state = 'ACTIVE' AND cardinality(links.profession_codes) > 0
          UNION ALL
          SELECT specialization.specialization_code, 'SPECIALIZATION'::text,
            specialization.label_sk, ARRAY[specialization.profession_code]::text[],
            specialization.profession_code,
            specialization.state::text, release.content_class::text,
            release.review_state::text
          FROM current_release release
          JOIN taxonomy_specializations specialization
            ON specialization.release_id = release.release_id
          JOIN taxonomy_professions profession
            ON profession.release_id = specialization.release_id
           AND profession.profession_code = specialization.profession_code
          WHERE specialization.state = 'ACTIVE' AND profession.state = 'ACTIVE'
          UNION ALL
          SELECT skill.skill_code, 'SKILL'::text, skill.label_sk,
            links.profession_codes, NULL::text, skill.state::text,
            release.content_class::text, release.review_state::text
          FROM current_skill_release release
          JOIN skill_catalog_skills skill ON skill.release_id = release.release_id
          JOIN LATERAL (
            SELECT array_agg(relation.profession_code ORDER BY relation.profession_code)::text[]
              AS profession_codes
            FROM skill_catalog_skill_professions relation
            JOIN taxonomy_professions profession
              ON profession.release_id = relation.profession_taxonomy_release_id
             AND profession.profession_code = relation.profession_code
             AND profession.state = 'ACTIVE'
            WHERE relation.release_id = skill.release_id
              AND relation.skill_code = skill.skill_code
          ) links ON true
          WHERE skill.state = 'ACTIVE' AND cardinality(links.profession_codes) > 0
        ), scoped AS (
          SELECT * FROM items
          WHERE (${query.scope} = 'DISCOVERY' AND kind IN ('PROFESSION', 'SERVICE'))
             OR (${query.scope} = 'CAPABILITY' AND kind IN ('PROFESSION', 'SPECIALIZATION', 'SKILL'))
        ), terms AS (
          SELECT scoped.*, label AS raw_term, 'CANONICAL'::text AS source_kind
          FROM scoped
          UNION ALL
          SELECT scoped.*, alias.alias, 'ALIAS'::text
          FROM scoped
          JOIN current_release release ON true
          JOIN taxonomy_aliases alias
            ON alias.release_id = release.release_id
           AND alias.target_kind::text = scoped.kind
           AND alias.target_code = scoped.code
        ), normalized AS (
          SELECT terms.*, portal_taxonomy_normalize(raw_term) AS normalized_term,
            portal_taxonomy_normalize(label) AS normalized_label
          FROM terms
        ), matches AS (
          SELECT normalized.*,
            CASE
              WHEN normalized_term = ${query.normalizedText} THEN 'EXACT_' || source_kind
              WHEN normalized_term LIKE ${`${query.normalizedText}%`} THEN 'PREFIX_' || source_kind
              WHEN NOT EXISTS (
                SELECT 1 FROM unnest(${[...query.tokens]}::text[]) token
                WHERE position(token IN normalized_term) = 0
              ) THEN 'KEYWORD_' || source_kind
              ELSE 'FUZZY_' || source_kind
            END AS matched_by,
            similarity(normalized_term, ${query.normalizedText}) AS similarity_score
          FROM normalized
          WHERE normalized_term = ${query.normalizedText}
             OR normalized_term LIKE ${`${query.normalizedText}%`}
             OR NOT EXISTS (
               SELECT 1 FROM unnest(${[...query.tokens]}::text[]) token
               WHERE position(token IN normalized_term) = 0
             )
             OR (length(${query.normalizedText}) >= 4 AND
               similarity(normalized_term, ${query.normalizedText}) >=
               CASE WHEN length(${query.normalizedText}) <= 5 THEN 0.60 ELSE 0.42 END)
        ), profession_counts AS (
          SELECT profession_code AS code,
            count(DISTINCT craftsman_profile_id)::integer AS member_count
          FROM current_searchable_craftsman_professions GROUP BY profession_code
        ), service_counts AS (
          SELECT service_code AS code,
            count(DISTINCT craftsman_profile_id)::integer AS member_count
          FROM current_searchable_craftsman_services GROUP BY service_code
        ), ranked AS (
          SELECT matches.*,
            CASE matched_by
              WHEN 'EXACT_CANONICAL' THEN 10 WHEN 'PREFIX_CANONICAL' THEN 20
              WHEN 'EXACT_ALIAS' THEN 30 WHEN 'PREFIX_ALIAS' THEN 40
              WHEN 'KEYWORD_CANONICAL' THEN 50 WHEN 'KEYWORD_ALIAS' THEN 60
              WHEN 'FUZZY_CANONICAL' THEN 70 WHEN 'FUZZY_ALIAS' THEN 80
            END + CASE kind WHEN 'PROFESSION' THEN 1 WHEN 'SERVICE' THEN 2
              WHEN 'SPECIALIZATION' THEN 3 ELSE 4 END AS precedence,
            row_number() OVER (PARTITION BY kind, code ORDER BY
              CASE matched_by
                WHEN 'EXACT_CANONICAL' THEN 10 WHEN 'PREFIX_CANONICAL' THEN 20
                WHEN 'EXACT_ALIAS' THEN 30 WHEN 'PREFIX_ALIAS' THEN 40
                WHEN 'KEYWORD_CANONICAL' THEN 50 WHEN 'KEYWORD_ALIAS' THEN 60
                WHEN 'FUZZY_CANONICAL' THEN 70 WHEN 'FUZZY_ALIAS' THEN 80
              END, similarity_score DESC, normalized_term COLLATE "C", code COLLATE "C"
            ) AS identity_rank
          FROM matches
        )
        SELECT true AS activated, ranked.code,
          ranked.content_class AS "contentClass",
          ranked.entry_state AS "entryState", ranked.kind, ranked.label,
          ranked.matched_by AS "matchedBy",
          COALESCE(CASE ranked.kind
            WHEN 'PROFESSION' THEN profession_counts.member_count
            WHEN 'SERVICE' THEN service_counts.member_count ELSE 0 END, 0)::integer
            AS "memberCount",
          ranked.profession_codes AS "professionCodes",
          ranked.routing_profession_code AS "routingProfessionCode",
          ranked.review_state AS "reviewState"
        FROM ranked
        LEFT JOIN profession_counts ON ranked.kind = 'PROFESSION'
          AND profession_counts.code = ranked.code
        LEFT JOIN service_counts ON ranked.kind = 'SERVICE'
          AND service_counts.code = ranked.code
        WHERE identity_rank = 1 AND precedence IS NOT NULL
        ORDER BY precedence, similarity_score DESC,
          normalized_label COLLATE "C", ranked.code COLLATE "C"
        LIMIT ${query.limit}
      `;
      return Object.freeze(rows.map(toCandidate));
    },
  });
}

function assertQuery(query: ParsedTaxonomyAutocompleteQuery): void {
  if (
    !Number.isSafeInteger(query.limit) ||
    query.limit < 1 ||
    query.limit > 10 ||
    (query.scope !== "DISCOVERY" && query.scope !== "CAPABILITY") ||
    !/^[a-z0-9]+(?: [a-z0-9]+)*$/u.test(query.normalizedText) ||
    query.tokens.length < 1 ||
    query.tokens.length > 8 ||
    new Set(query.tokens).size !== query.tokens.length
  ) {
    throw new TypeError("Invalid parsed taxonomy autocomplete query.");
  }
}

function toCandidate(row: CandidateRow): TaxonomyAutocompleteCandidate {
  return {
    code: row.code,
    governance: {
      activated: row.activated,
      contentClass: row.contentClass,
      entryState: row.entryState,
      reviewState: row.reviewState,
    },
    kind: row.kind as TaxonomyAutocompleteCandidate["kind"],
    label: row.label,
    matchedBy: row.matchedBy as TaxonomyAutocompleteCandidate["matchedBy"],
    memberCount: row.memberCount,
    professionCodes: Object.freeze([...row.professionCodes]),
    ...(row.routingProfessionCode === null
      ? {}
      : { routingProfessionCode: row.routingProfessionCode }),
  };
}
