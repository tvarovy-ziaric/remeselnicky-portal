export interface JobRequestTaxonomySuggestion {
  readonly code: string;
  readonly kind: "PROFESSION" | "SERVICE" | "SKILL" | "SPECIALIZATION";
  readonly label: string;
  readonly memberCount: number;
  readonly professionCodes: readonly string[];
  readonly routingProfessionCode?: string | null;
}

export type JobRequestTaxonomyLookup =
  | Readonly<{
      status: "OK";
      suggestions: readonly JobRequestTaxonomySuggestion[];
    }>
  | Readonly<{
      status: "ERROR";
      suggestions: readonly JobRequestTaxonomySuggestion[];
    }>;

export async function loadJobRequestTaxonomySuggestions(
  query: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
  scope: "CAPABILITY" | "DISCOVERY" = "DISCOVERY",
): Promise<readonly JobRequestTaxonomySuggestion[]> {
  const result = await loadJobRequestTaxonomySuggestionLookup(
    query,
    fetcher,
    signal,
    scope,
  );
  return result.suggestions;
}

export async function loadJobRequestTaxonomySuggestionLookup(
  query: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
  scope: "CAPABILITY" | "DISCOVERY" = "DISCOVERY",
): Promise<JobRequestTaxonomyLookup> {
  const normalized = query.trim();
  if (normalized.length < 2 || normalized.length > 120)
    return Object.freeze({ status: "OK", suggestions: Object.freeze([]) });
  try {
    const url = new URL(
      "/v1/public/taxonomy/suggestions",
      "http://portal.local",
    );
    url.searchParams.set("q", normalized);
    url.searchParams.set("limit", "10");
    url.searchParams.set("scope", scope);
    const response = await fetcher(`${url.pathname}${url.search}`, {
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" },
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok)
      return Object.freeze({ status: "ERROR", suggestions: [] });
    const body: unknown = await response.json();
    if (
      !record(body) ||
      !Array.isArray(body["suggestions"]) ||
      body["suggestions"].length > 10
    )
      return Object.freeze({ status: "ERROR", suggestions: [] });
    const suggestions = body["suggestions"].map(parseSuggestion);
    return suggestions.some((suggestion) => suggestion === null)
      ? Object.freeze({ status: "ERROR", suggestions: [] })
      : Object.freeze({
          status: "OK",
          suggestions: Object.freeze(
            suggestions as JobRequestTaxonomySuggestion[],
          ),
        });
  } catch {
    return Object.freeze({ status: "ERROR", suggestions: [] });
  }
}

function parseSuggestion(value: unknown): JobRequestTaxonomySuggestion | null {
  if (
    !record(value) ||
    !["PROFESSION", "SERVICE", "SKILL", "SPECIALIZATION"].includes(
      String(value["kind"]),
    ) ||
    !safeLabel(value["label"]) ||
    !Number.isSafeInteger(value["memberCount"]) ||
    Number(value["memberCount"]) < 0 ||
    !code(value["code"]) ||
    !Array.isArray(value["professionCodes"]) ||
    value["professionCodes"].length < 1 ||
    value["professionCodes"].length > 32 ||
    !value["professionCodes"].every(professionCode)
  )
    return null;
  const explicitRoutingProfessionCode = value["routingProfessionCode"];
  const routingProfessionCode =
    professionCode(explicitRoutingProfessionCode) &&
    value["professionCodes"].includes(explicitRoutingProfessionCode)
      ? explicitRoutingProfessionCode
      : value["professionCodes"].length === 1
        ? (value["professionCodes"][0] as string)
        : null;
  if (
    (value["kind"] === "PROFESSION" || value["kind"] === "SERVICE") &&
    routingProfessionCode === null
  ) {
    return null;
  }
  return Object.freeze({
    code: value["code"],
    kind: value["kind"] as JobRequestTaxonomySuggestion["kind"],
    label: value["label"],
    memberCount: value["memberCount"] as number,
    professionCodes: Object.freeze([...value["professionCodes"]]),
    routingProfessionCode,
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
    /^(?:PROF|SERV|SPEC|SKILL|TEST):[A-Z0-9][A-Z0-9_]{1,62}$/u.test(value)
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
