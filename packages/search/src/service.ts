import {
  TAXONOMY_MATCH_KINDS,
  TAXONOMY_SUGGESTION_KINDS,
  type ParsedTaxonomyAutocompleteQuery,
  type TaxonomyAutocomplete,
  type TaxonomyAutocompleteCandidate,
  type TaxonomyAutocompletePersistence,
  type TaxonomyAutocompleteSuggestion,
  type TaxonomyAutocompleteResult,
} from "./model.js";
import {
  normalizeTaxonomySearchText,
  parseTaxonomyAutocompleteQuery,
} from "./query.js";
import { markGovernedSuggestion } from "./governed-suggestion.js";

const resultOrder: readonly string[] = Object.freeze([
  "EXACT_CANONICAL:PROFESSION",
  "EXACT_ALIAS:PROFESSION",
  "EXACT_CANONICAL:SPECIALIZATION",
  "EXACT_ALIAS:SPECIALIZATION",
  "EXACT_CANONICAL:SKILL",
  "PREFIX_CANONICAL:PROFESSION",
  "PREFIX_ALIAS:PROFESSION",
  "PREFIX_CANONICAL:SPECIALIZATION",
  "PREFIX_ALIAS:SPECIALIZATION",
  "PREFIX_CANONICAL:SKILL",
  "KEYWORD_CANONICAL:PROFESSION",
  "KEYWORD_ALIAS:PROFESSION",
  "KEYWORD_CANONICAL:SPECIALIZATION",
  "KEYWORD_ALIAS:SPECIALIZATION",
  "KEYWORD_CANONICAL:SKILL",
] as const);

export class TaxonomyAutocompleteIntegrityError extends Error {
  readonly code = "TAXONOMY_AUTOCOMPLETE_INTEGRITY_ERROR";
}

export function createTaxonomyAutocompleteService(
  persistence: TaxonomyAutocompletePersistence,
): TaxonomyAutocomplete {
  return Object.freeze({
    async autocomplete(input: {
      readonly limit?: unknown;
      readonly query: unknown;
    }): Promise<TaxonomyAutocompleteResult> {
      const parsed = parseTaxonomyAutocompleteQuery(input);
      if (parsed.status === "INVALID_QUERY") return parsed;
      const candidates = await persistence.findCandidates(parsed.query);
      const deduplicated = deduplicate(candidates, parsed.query);
      return Object.freeze({
        status: "OK" as const,
        suggestions: Object.freeze(
          deduplicated.slice(0, parsed.query.limit).map(publicSuggestion),
        ),
      });
    },
  });
}

function deduplicate(
  values: readonly TaxonomyAutocompleteCandidate[],
  query: ParsedTaxonomyAutocompleteQuery,
): readonly TaxonomyAutocompleteCandidate[] {
  const byIdentity = new Map<string, TaxonomyAutocompleteCandidate>();
  for (const value of values) {
    assertCandidate(value, query);
    const key = `${value.kind}:${value.code}`;
    const existing = byIdentity.get(key);
    if (existing === undefined || compare(value, existing) < 0) {
      byIdentity.set(key, value);
    }
  }
  return [...byIdentity.values()].sort(compare);
}

function compare(
  left: TaxonomyAutocompleteCandidate,
  right: TaxonomyAutocompleteCandidate,
): number {
  const leftOrder = resultOrder.indexOf(`${left.matchedBy}:${left.kind}`);
  const rightOrder = resultOrder.indexOf(`${right.matchedBy}:${right.kind}`);
  const leftLabel = normalizeTaxonomySearchText(left.label);
  const rightLabel = normalizeTaxonomySearchText(right.label);
  return (
    leftOrder - rightOrder ||
    codePointCompare(leftLabel, rightLabel) ||
    codePointCompare(left.code, right.code)
  );
}

function assertCandidate(
  value: TaxonomyAutocompleteCandidate,
  query: ParsedTaxonomyAutocompleteQuery,
): void {
  if (
    !TAXONOMY_SUGGESTION_KINDS.includes(value.kind) ||
    !TAXONOMY_MATCH_KINDS.includes(value.matchedBy) ||
    !resultOrder.includes(`${value.matchedBy}:${value.kind}`) ||
    !value.governance.activated ||
    value.governance.contentClass !== "CANONICAL" ||
    value.governance.reviewState !== "HUMAN_REVIEW_APPROVED" ||
    value.governance.entryState !== "ACTIVE" ||
    value.label !== value.label.trim() ||
    value.label.length < 2 ||
    value.label.length > 120 ||
    /[\r\n\p{Cc}]/u.test(value.label) ||
    !isSafePublicLabel(value.label) ||
    !validCode(value.kind, value.code) ||
    value.professionCodes.length < 1 ||
    (value.kind === "PROFESSION" &&
      (value.professionCodes.length !== 1 ||
        value.professionCodes[0] !== value.code)) ||
    new Set(value.professionCodes).size !== value.professionCodes.length ||
    value.professionCodes.some(
      (code) => !/^PROF:[A-Z0-9][A-Z0-9_]{1,62}$/u.test(code),
    ) ||
    query.normalizedText.length === 0
  ) {
    throw new TaxonomyAutocompleteIntegrityError(
      "Taxonomy autocomplete candidate violated governed output invariants.",
    );
  }
}

function isSafePublicLabel(value: string): boolean {
  const unsafePatterns = [
    /[\p{L}\d._%+-]+@[\p{L}\d.-]+\.[\p{L}]{2,}/iu,
    /(^|\s)@[\p{L}\d_]{2,}/iu,
    /(^|[^0-9])(\+|00)?[0-9]([\s()./-]*[0-9]){6,}([^0-9]|$)/u,
    /\b(?:https?:\/\/|www\.)/iu,
    /(^|[^\p{L}\d_-])[\p{L}\d][\p{L}\d-]{0,62}(?:\.[\p{L}\d-]{1,63})*\.[\p{L}]{2,24}([^\p{L}\d_-]|$)/iu,
    /(^|[^0-9])[0-9]{3}\s?[0-9]{2}([^0-9]|$)/u,
    /\b(?:adresa|ulica|námestie|trieda|číslo domu|číslo bytu)\b|\b(?:ul|nám)\./iu,
    /\b(?:heslo|password|api[ _-]?key|access[ _-]?token|secret|tajný kľúč)\b/iu,
  ];
  return unsafePatterns.every((pattern) => !pattern.test(value));
}

function codePointCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validCode(
  kind: TaxonomyAutocompleteCandidate["kind"],
  code: string,
): boolean {
  const prefix =
    kind === "PROFESSION"
      ? "PROF"
      : kind === "SPECIALIZATION"
        ? "SPEC"
        : "SKILL";
  return new RegExp(`^${prefix}:[A-Z0-9][A-Z0-9_]{1,62}$`, "u").test(code);
}

function publicSuggestion(
  value: TaxonomyAutocompleteCandidate,
): TaxonomyAutocompleteSuggestion {
  return markGovernedSuggestion(
    Object.freeze({
      code: value.code,
      kind: value.kind,
      label: value.label,
      matchedBy: value.matchedBy,
      professionCodes: Object.freeze([...value.professionCodes]),
    }),
  );
}
