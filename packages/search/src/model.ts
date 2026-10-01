export const TAXONOMY_AUTOCOMPLETE_DEFAULT_LIMIT = 10;
export const TAXONOMY_AUTOCOMPLETE_MAX_LIMIT = 10;
export const TAXONOMY_AUTOCOMPLETE_MAX_QUERY_LENGTH = 120;
export const TAXONOMY_AUTOCOMPLETE_MAX_TOKENS = 8;

export const TAXONOMY_SUGGESTION_KINDS = Object.freeze([
  "PROFESSION",
  "SERVICE",
  "SPECIALIZATION",
  "SKILL",
] as const);
export const TAXONOMY_MATCH_KINDS = Object.freeze([
  "EXACT_CANONICAL",
  "EXACT_ALIAS",
  "PREFIX_CANONICAL",
  "PREFIX_ALIAS",
  "KEYWORD_CANONICAL",
  "KEYWORD_ALIAS",
  "FUZZY_CANONICAL",
  "FUZZY_ALIAS",
] as const);

export const TAXONOMY_AUTOCOMPLETE_SCOPES = Object.freeze([
  "DISCOVERY",
  "CAPABILITY",
] as const);
export type TaxonomyAutocompleteScope =
  (typeof TAXONOMY_AUTOCOMPLETE_SCOPES)[number];

export type TaxonomySuggestionKind = (typeof TAXONOMY_SUGGESTION_KINDS)[number];
export type TaxonomyMatchKind = (typeof TAXONOMY_MATCH_KINDS)[number];

export interface ParsedTaxonomyAutocompleteQuery {
  readonly limit: number;
  readonly normalizedText: string;
  readonly scope: TaxonomyAutocompleteScope;
  readonly tokens: readonly string[];
}

export type TaxonomyAutocompleteParseResult = Readonly<
  | { readonly status: "INVALID_QUERY" }
  | {
      readonly query: ParsedTaxonomyAutocompleteQuery;
      readonly status: "VALID";
    }
>;

export interface TaxonomyAutocompleteSuggestion {
  readonly code: string;
  readonly kind: TaxonomySuggestionKind;
  readonly label: string;
  readonly memberCount: number;
  readonly matchedBy: TaxonomyMatchKind;
  readonly professionCodes: readonly string[];
  /** Canonical server-selected profession used when this discovery item is chosen. */
  readonly routingProfessionCode?: string;
}

export interface TaxonomyAutocompleteCandidate extends TaxonomyAutocompleteSuggestion {
  readonly governance: Readonly<{
    readonly activated: boolean;
    readonly contentClass: string;
    readonly entryState: string;
    readonly reviewState: string;
  }>;
}

export interface TaxonomyAutocompletePersistence {
  findCandidates(
    query: ParsedTaxonomyAutocompleteQuery,
  ): Promise<readonly TaxonomyAutocompleteCandidate[]>;
}

export type TaxonomyAutocompleteResult = Readonly<
  | { readonly status: "INVALID_QUERY" }
  | {
      readonly status: "OK";
      readonly suggestions: readonly TaxonomyAutocompleteSuggestion[];
    }
>;

export interface TaxonomyAutocomplete {
  autocomplete(input: {
    readonly limit?: unknown;
    readonly query: unknown;
    readonly scope?: unknown;
  }): Promise<TaxonomyAutocompleteResult>;
}
