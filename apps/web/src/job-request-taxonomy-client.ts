export interface JobRequestTaxonomySuggestion {
  readonly code: string;
  readonly kind: "PROFESSION" | "SKILL" | "SPECIALIZATION";
  readonly label: string;
  readonly professionCodes: readonly string[];
}

export async function loadJobRequestTaxonomySuggestions(
  query: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<readonly JobRequestTaxonomySuggestion[]> {
  const normalized = query.trim();
  if (normalized.length < 2 || normalized.length > 120) return [];
  try {
    const url = new URL(
      "/v1/public/taxonomy/suggestions",
      "http://portal.local",
    );
    url.searchParams.set("q", normalized);
    url.searchParams.set("limit", "8");
    const response = await fetcher(`${url.pathname}${url.search}`, {
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" },
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) return [];
    const body: unknown = await response.json();
    if (
      !record(body) ||
      !Array.isArray(body["suggestions"]) ||
      body["suggestions"].length > 8
    )
      return [];
    const suggestions = body["suggestions"].map(parseSuggestion);
    return suggestions.some((suggestion) => suggestion === null)
      ? []
      : Object.freeze(suggestions as JobRequestTaxonomySuggestion[]);
  } catch {
    return [];
  }
}

function parseSuggestion(value: unknown): JobRequestTaxonomySuggestion | null {
  if (
    !record(value) ||
    !["PROFESSION", "SKILL", "SPECIALIZATION"].includes(
      String(value["kind"]),
    ) ||
    !safeLabel(value["label"]) ||
    !code(value["code"]) ||
    !Array.isArray(value["professionCodes"]) ||
    value["professionCodes"].length < 1 ||
    value["professionCodes"].length > 32 ||
    !value["professionCodes"].every(professionCode)
  )
    return null;
  return Object.freeze({
    code: value["code"],
    kind: value["kind"] as JobRequestTaxonomySuggestion["kind"],
    label: value["label"],
    professionCodes: Object.freeze([...value["professionCodes"]]),
  });
}

function safeLabel(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length >= 2 &&
    value.length <= 120 &&
    !/[\r\n\p{Cc}]/u.test(value)
  );
}
function code(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(?:PROF|SPEC|SKILL|TEST):[A-Z0-9][A-Z0-9_]{1,62}$/u.test(value)
  );
}
function professionCode(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(?:PROF|TEST):[A-Z0-9][A-Z0-9_]{1,62}$/u.test(value)
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
