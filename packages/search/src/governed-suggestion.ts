import type { TaxonomyAutocompleteSuggestion } from "./model.js";

const governedSuggestions = new WeakSet<TaxonomyAutocompleteSuggestion>();

export function markGovernedSuggestion(
  value: TaxonomyAutocompleteSuggestion,
): TaxonomyAutocompleteSuggestion {
  governedSuggestions.add(value);
  return value;
}

export function isGovernedSuggestion(
  value: TaxonomyAutocompleteSuggestion,
): boolean {
  return governedSuggestions.has(value);
}
