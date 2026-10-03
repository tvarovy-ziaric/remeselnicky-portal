export interface JobRequestMunicipalitySuggestion {
  readonly code: string;
  readonly districtName: string | null;
  readonly kind: "CITY_AREA" | "MUNICIPALITY";
  readonly name: string;
  readonly postalCodes: readonly string[];
  readonly regionName: string;
}

export type JobRequestMunicipalitySuggestionResult =
  | {
      readonly status: "OK";
      readonly suggestions: readonly JobRequestMunicipalitySuggestion[];
    }
  | {
      readonly status: "ZERO";
      readonly suggestions: readonly JobRequestMunicipalitySuggestion[];
    }
  | {
      readonly status: "ERROR";
      readonly suggestions: readonly JobRequestMunicipalitySuggestion[];
    };

export function isMunicipalityQueryEligible(query: string): boolean {
  const normalized = query.trim();
  if (normalized.length > 80) return false;
  const compactPostalCode = normalized.replaceAll(" ", "");
  if (/^\d+$/u.test(compactPostalCode)) {
    return compactPostalCode.length >= 3 && compactPostalCode.length <= 5;
  }
  return normalized.length >= 2;
}

export async function loadJobRequestMunicipalitySuggestions(
  query: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<JobRequestMunicipalitySuggestionResult> {
  const normalized = query.trim();
  if (!isMunicipalityQueryEligible(normalized)) return zeroResult();
  try {
    const url = new URL(
      "/v1/public/municipalities/suggestions",
      "http://portal.local",
    );
    url.searchParams.set("q", normalized);
    const response = await fetcher(`${url.pathname}${url.search}`, {
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" },
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) return errorResult();
    const body: unknown = await response.json();
    if (
      !record(body) ||
      !Array.isArray(body["suggestions"]) ||
      body["suggestions"].length > 10
    )
      return errorResult();
    const suggestions = body["suggestions"].map(parseSuggestion);
    if (suggestions.some((suggestion) => suggestion === null)) {
      return errorResult();
    }
    if (suggestions.length === 0) return zeroResult();
    return Object.freeze({
      status: "OK",
      suggestions: Object.freeze(
        suggestions as JobRequestMunicipalitySuggestion[],
      ),
    });
  } catch {
    return errorResult();
  }
}

export function formatPostalCode(postalCode: string): string {
  return /^\d{5}$/u.test(postalCode)
    ? `${postalCode.slice(0, 3)} ${postalCode.slice(3)}`
    : postalCode;
}

function parseSuggestion(
  value: unknown,
): JobRequestMunicipalitySuggestion | null {
  const kind = valueKind(value);
  if (
    !record(value) ||
    !code(value["code"]) ||
    kind === null ||
    !label(value["name"]) ||
    !nullableLabel(value["districtName"]) ||
    !label(value["regionName"]) ||
    !Array.isArray(value["postalCodes"]) ||
    value["postalCodes"].length > 100 ||
    !value["postalCodes"].every(postalCode) ||
    (kind === "CITY_AREA" &&
      (value["districtName"] !== null || value["postalCodes"].length !== 0)) ||
    (kind === "MUNICIPALITY" &&
      (value["districtName"] === null || value["postalCodes"].length === 0))
  )
    return null;
  return Object.freeze({
    code: value["code"],
    districtName: value["districtName"],
    kind,
    name: value["name"],
    postalCodes: Object.freeze([...value["postalCodes"]]),
    regionName: value["regionName"],
  });
}

function errorResult(): JobRequestMunicipalitySuggestionResult {
  return Object.freeze({ status: "ERROR", suggestions: Object.freeze([]) });
}
function zeroResult(): JobRequestMunicipalitySuggestionResult {
  return Object.freeze({ status: "ZERO", suggestions: Object.freeze([]) });
}
function code(value: unknown): value is string {
  return (
    typeof value === "string" && /^[A-Z0-9][A-Z0-9._:-]{0,63}$/u.test(value)
  );
}
function label(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length >= 1 &&
    value.length <= 120 &&
    !/[\r\n\p{Cc}]/u.test(value)
  );
}
function nullableLabel(value: unknown): value is string | null {
  return value === null || label(value);
}
function postalCode(value: unknown): value is string {
  return typeof value === "string" && /^\d{5}$/u.test(value);
}
function valueKind(
  value: unknown,
): JobRequestMunicipalitySuggestion["kind"] | null {
  if (!record(value)) return null;
  return value["kind"] === "CITY_AREA" || value["kind"] === "MUNICIPALITY"
    ? value["kind"]
    : null;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
