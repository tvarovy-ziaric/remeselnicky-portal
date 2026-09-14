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
  readonly professionCodes: readonly string[];
  readonly reviewState: string;
}

export function createTaxonomyAutocompleteRepository(
  sql: Sql,
): TaxonomyAutocompletePersistence {
  return Object.freeze({
    async findCandidates(
      query: ParsedTaxonomyAutocompleteQuery,
    ): Promise<readonly TaxonomyAutocompleteCandidate[]> {
      assertParsedQuery(query);
      const rows = await sql<CandidateRow[]>`
        WITH latest_profession_activation AS (
          SELECT release_id
          FROM profession_taxonomy_activation_events
          ORDER BY activation_sequence DESC
          LIMIT 1
        ),
        current_profession_release AS (
          SELECT release.*
          FROM latest_profession_activation activation
          JOIN profession_taxonomy_releases release
            ON release.release_id = activation.release_id
          WHERE release.content_class = 'CANONICAL'
            AND release.review_state = 'HUMAN_REVIEW_APPROVED'
        ),
        latest_skill_activation AS (
          SELECT release_id
          FROM skill_catalog_activation_events
          ORDER BY activation_sequence DESC
          LIMIT 1
        ),
        current_skill_release AS (
          SELECT release.*
          FROM latest_skill_activation activation
          JOIN skill_catalog_releases release
            ON release.release_id = activation.release_id
          JOIN current_profession_release profession_release
            ON profession_release.release_id =
              release.profession_taxonomy_release_id
          WHERE release.content_class = 'CANONICAL'
            AND release.review_state = 'HUMAN_REVIEW_APPROVED'
        ),
        raw_terms AS (
          SELECT
            profession.profession_code AS code,
            'PROFESSION'::text AS kind,
            profession.label_sk AS label,
            ARRAY[profession.profession_code]::text[] AS profession_codes,
            term.value AS raw_term,
            'CANONICAL'::text AS source_kind,
            profession.state::text AS entry_state,
            release.content_class::text AS content_class,
            release.review_state::text AS review_state
          FROM current_profession_release release
          JOIN taxonomy_professions profession
            ON profession.release_id = release.release_id
          CROSS JOIN LATERAL (
            VALUES (profession.label_sk), (profession.slug)
          ) term(value)
          WHERE profession.state = 'ACTIVE'
            AND profession.profession_code ~ '^PROF:[A-Z0-9][A-Z0-9_]{1,62}$'

          UNION ALL

          SELECT
            specialization.specialization_code,
            'SPECIALIZATION'::text,
            specialization.label_sk,
            ARRAY[specialization.profession_code]::text[],
            term.value,
            'CANONICAL'::text,
            specialization.state::text,
            release.content_class::text,
            release.review_state::text
          FROM current_profession_release release
          JOIN taxonomy_specializations specialization
            ON specialization.release_id = release.release_id
          JOIN taxonomy_professions profession
            ON profession.release_id = specialization.release_id
           AND profession.profession_code = specialization.profession_code
          CROSS JOIN LATERAL (
            VALUES (specialization.label_sk), (specialization.slug)
          ) term(value)
          WHERE specialization.state = 'ACTIVE'
            AND profession.state = 'ACTIVE'
            AND specialization.specialization_code ~
              '^SPEC:[A-Z0-9][A-Z0-9_]{1,62}$'
            AND profession.profession_code ~
              '^PROF:[A-Z0-9][A-Z0-9_]{1,62}$'

          UNION ALL

          SELECT
            profession.profession_code,
            'PROFESSION'::text,
            profession.label_sk,
            ARRAY[profession.profession_code]::text[],
            alias.alias,
            'ALIAS'::text,
            profession.state::text,
            release.content_class::text,
            release.review_state::text
          FROM current_profession_release release
          JOIN taxonomy_aliases alias
            ON alias.release_id = release.release_id
           AND alias.target_kind = 'PROFESSION'
          JOIN taxonomy_professions profession
            ON profession.release_id = alias.release_id
           AND profession.profession_code = alias.target_code
          WHERE profession.state = 'ACTIVE'
            AND alias.alias_kind IN (
              'LEGACY_CODE', 'LEGACY_SLUG', 'SEARCH_TERM'
            )
            AND profession.profession_code ~ '^PROF:[A-Z0-9][A-Z0-9_]{1,62}$'

          UNION ALL

          SELECT
            specialization.specialization_code,
            'SPECIALIZATION'::text,
            specialization.label_sk,
            ARRAY[specialization.profession_code]::text[],
            alias.alias,
            'ALIAS'::text,
            specialization.state::text,
            release.content_class::text,
            release.review_state::text
          FROM current_profession_release release
          JOIN taxonomy_aliases alias
            ON alias.release_id = release.release_id
           AND alias.target_kind = 'SPECIALIZATION'
          JOIN taxonomy_specializations specialization
            ON specialization.release_id = alias.release_id
           AND specialization.specialization_code = alias.target_code
          JOIN taxonomy_professions profession
            ON profession.release_id = specialization.release_id
           AND profession.profession_code = specialization.profession_code
          WHERE specialization.state = 'ACTIVE'
            AND profession.state = 'ACTIVE'
            AND alias.alias_kind IN (
              'LEGACY_CODE', 'LEGACY_SLUG', 'SEARCH_TERM'
            )
            AND specialization.specialization_code ~
              '^SPEC:[A-Z0-9][A-Z0-9_]{1,62}$'
            AND profession.profession_code ~
              '^PROF:[A-Z0-9][A-Z0-9_]{1,62}$'

          UNION ALL

          SELECT
            skill.skill_code,
            'SKILL'::text,
            skill.label_sk,
            profession_links.profession_codes,
            term.value,
            'CANONICAL'::text,
            skill.state::text,
            release.content_class::text,
            release.review_state::text
          FROM current_skill_release release
          JOIN skill_catalog_skills skill
            ON skill.release_id = release.release_id
          CROSS JOIN LATERAL (
            VALUES (skill.label_sk), (skill.slug)
          ) term(value)
          CROSS JOIN LATERAL (
            SELECT array_agg(
              relation.profession_code ORDER BY relation.profession_code
            )::text[] AS profession_codes
            FROM skill_catalog_skill_professions relation
            JOIN taxonomy_professions profession
              ON profession.release_id = relation.profession_taxonomy_release_id
             AND profession.profession_code = relation.profession_code
            WHERE relation.release_id = skill.release_id
              AND relation.skill_code = skill.skill_code
              AND relation.profession_taxonomy_release_id =
                release.profession_taxonomy_release_id
              AND profession.state = 'ACTIVE'
              AND profession.profession_code ~
                '^PROF:[A-Z0-9][A-Z0-9_]{1,62}$'
          ) profession_links
          WHERE skill.state = 'ACTIVE'
            AND skill.skill_code ~ '^SKILL:[A-Z0-9][A-Z0-9_]{1,62}$'
            AND cardinality(profession_links.profession_codes) > 0
        ),
        normalized_terms AS (
          SELECT raw_terms.*,
            btrim(regexp_replace(
              translate(
                lower(raw_term),
                'áäčďéíĺľňóôŕšťúýž',
                'aacdeillnoorstuyz'
              ),
              '[^a-z0-9]+', ' ', 'g'
            )) AS normalized_term,
            btrim(regexp_replace(
              translate(
                lower(label),
                'áäčďéíĺľňóôŕšťúýž',
                'aacdeillnoorstuyz'
              ),
              '[^a-z0-9]+', ' ', 'g'
            )) AS normalized_label
          FROM raw_terms
        ),
        matches AS (
          SELECT normalized_terms.*,
            CASE
              WHEN normalized_term = ${query.normalizedText}
                THEN 'EXACT_' || source_kind
              WHEN normalized_term LIKE ${`${query.normalizedText}%`}
                THEN 'PREFIX_' || source_kind
              ELSE 'KEYWORD_' || source_kind
            END AS matched_by
          FROM normalized_terms
          WHERE normalized_term = ${query.normalizedText}
             OR normalized_term LIKE ${`${query.normalizedText}%`}
             OR NOT EXISTS (
               SELECT 1
               FROM unnest(${[...query.tokens]}::text[]) token
               WHERE position(token IN normalized_term) = 0
             )
        ),
        ranked AS (
          SELECT matches.*,
            CASE matched_by || ':' || kind
              WHEN 'EXACT_CANONICAL:PROFESSION' THEN 1
              WHEN 'EXACT_ALIAS:PROFESSION' THEN 2
              WHEN 'EXACT_CANONICAL:SPECIALIZATION' THEN 3
              WHEN 'EXACT_ALIAS:SPECIALIZATION' THEN 4
              WHEN 'EXACT_CANONICAL:SKILL' THEN 5
              WHEN 'PREFIX_CANONICAL:PROFESSION' THEN 6
              WHEN 'PREFIX_ALIAS:PROFESSION' THEN 7
              WHEN 'PREFIX_CANONICAL:SPECIALIZATION' THEN 8
              WHEN 'PREFIX_ALIAS:SPECIALIZATION' THEN 9
              WHEN 'PREFIX_CANONICAL:SKILL' THEN 10
              WHEN 'KEYWORD_CANONICAL:PROFESSION' THEN 11
              WHEN 'KEYWORD_ALIAS:PROFESSION' THEN 12
              WHEN 'KEYWORD_CANONICAL:SPECIALIZATION' THEN 13
              WHEN 'KEYWORD_ALIAS:SPECIALIZATION' THEN 14
              WHEN 'KEYWORD_CANONICAL:SKILL' THEN 15
            END AS precedence,
            row_number() OVER (
              PARTITION BY kind, code
              ORDER BY
                CASE matched_by
                  WHEN 'EXACT_CANONICAL' THEN 1
                  WHEN 'EXACT_ALIAS' THEN 2
                  WHEN 'PREFIX_CANONICAL' THEN 3
                  WHEN 'PREFIX_ALIAS' THEN 4
                  WHEN 'KEYWORD_CANONICAL' THEN 5
                  WHEN 'KEYWORD_ALIAS' THEN 6
                END,
                normalized_term COLLATE "C",
                code COLLATE "C"
            ) AS identity_rank
          FROM matches
        )
        SELECT
          true AS activated,
          code,
          content_class AS "contentClass",
          entry_state AS "entryState",
          kind,
          label,
          matched_by AS "matchedBy",
          profession_codes AS "professionCodes",
          review_state AS "reviewState"
        FROM ranked
        WHERE identity_rank = 1
          AND precedence IS NOT NULL
        ORDER BY precedence, normalized_label COLLATE "C", code COLLATE "C"
        LIMIT ${query.limit}
      `;
      return Object.freeze(rows.map(toCandidate));
    },
  });
}

function assertParsedQuery(query: ParsedTaxonomyAutocompleteQuery): void {
  if (
    !Number.isSafeInteger(query.limit) ||
    query.limit < 1 ||
    query.limit > 20 ||
    !/^[a-z0-9]+(?: [a-z0-9]+)*$/u.test(query.normalizedText) ||
    query.tokens.length < 1 ||
    query.tokens.length > 8 ||
    new Set(query.tokens).size !== query.tokens.length ||
    query.tokens.some(
      (token) =>
        !/^[a-z0-9]+$/u.test(token) ||
        !query.normalizedText.split(" ").includes(token),
    )
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
    professionCodes: Object.freeze([...row.professionCodes]),
  };
}
