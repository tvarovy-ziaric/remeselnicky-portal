import {
  TAXONOMY_AUTOCOMPLETE_DEFAULT_LIMIT,
  TAXONOMY_AUTOCOMPLETE_MAX_LIMIT,
  TAXONOMY_AUTOCOMPLETE_MAX_QUERY_LENGTH,
  TAXONOMY_AUTOCOMPLETE_MAX_TOKENS,
  type TaxonomyAutocompleteParseResult,
} from "./model.js";

export function parseTaxonomyAutocompleteQuery(input: {
  readonly limit?: unknown;
  readonly query: unknown;
}): TaxonomyAutocompleteParseResult {
  if (typeof input.query !== "string") return { status: "INVALID_QUERY" };
  const rawLength = Array.from(input.query).length;
  if (
    rawLength < 1 ||
    rawLength > TAXONOMY_AUTOCOMPLETE_MAX_QUERY_LENGTH ||
    hasControlCharacter(input.query) ||
    hasSensitiveQueryText(input.query)
  ) {
    return { status: "INVALID_QUERY" };
  }
  const normalizedText = normalizeTaxonomySearchText(input.query);
  if (normalizedText.length === 0 || !/^[a-z0-9 ]+$/u.test(normalizedText)) {
    return { status: "INVALID_QUERY" };
  }
  const tokens = [...new Set(normalizedText.split(" "))];
  if (tokens.length > TAXONOMY_AUTOCOMPLETE_MAX_TOKENS) {
    return { status: "INVALID_QUERY" };
  }
  const limit = parseLimit(input.limit);
  return limit === null
    ? { status: "INVALID_QUERY" }
    : {
        query: Object.freeze({
          limit,
          normalizedText,
          tokens: Object.freeze(tokens),
        }),
        status: "VALID",
      };
}

export function normalizeTaxonomySearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replaceAll(/\p{M}/gu, "")
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replaceAll(/\s+/gu, " ");
}

function parseLimit(value: unknown): number | null {
  if (value === undefined) return TAXONOMY_AUTOCOMPLETE_DEFAULT_LIMIT;
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[1-9][0-9]*$/u.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(numeric) &&
    numeric >= 1 &&
    numeric <= TAXONOMY_AUTOCOMPLETE_MAX_LIMIT
    ? numeric
    : null;
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
}

function hasSensitiveQueryText(value: string): boolean {
  const sensitivePatterns = [
    /[\p{L}\d._%+-]+@[\p{L}\d.-]+\.[\p{L}]{2,}/iu,
    /(^|\s)@[\p{L}\d_]{2,}/iu,
    /(^|[^0-9])(\+|00)?[0-9]([\s()./-]*[0-9]){6,}([^0-9]|$)/u,
    /\b(?:https?:\/\/|www\.)/iu,
    /(^|[^\p{L}\d_-])[\p{L}\d][\p{L}\d-]{0,62}(?:\.[\p{L}\d-]{1,63})*\.[\p{L}]{2,24}([^\p{L}\d_-]|$)/iu,
    /(^|[^0-9])[0-9]{3}\s?[0-9]{2}([^0-9]|$)/u,
    /\b(?:adresa|ulica|námestie|trieda|číslo domu|číslo bytu)\b|\b(?:ul|nám)\./iu,
    /\b(?:heslo|password|api[ _-]?key|access[ _-]?token|secret|tajný kľúč)\b/iu,
  ];
  return sensitivePatterns.some((pattern) => pattern.test(value));
}
