export interface JobRequestMunicipalitySuggestion {
  readonly code: string;
  readonly districtName: string;
  readonly name: string;
  readonly regionName: string;
}

export async function loadJobRequestMunicipalitySuggestions(
  query: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<readonly JobRequestMunicipalitySuggestion[]> {
  const normalized = query.trim();
  if (normalized.length < 2 || normalized.length > 80) return [];
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
    if (!response.ok) return [];
    const body: unknown = await response.json();
    if (
      !record(body) ||
      !Array.isArray(body["suggestions"]) ||
      body["suggestions"].length > 10
    )
      return [];
    const suggestions = body["suggestions"].map(parseSuggestion);
    return suggestions.some((suggestion) => suggestion === null)
      ? []
      : Object.freeze(suggestions as JobRequestMunicipalitySuggestion[]);
  } catch {
    return [];
  }
}

function parseSuggestion(
  value: unknown,
): JobRequestMunicipalitySuggestion | null {
  if (
    !record(value) ||
    !code(value["code"]) ||
    !label(value["name"]) ||
    !label(value["districtName"]) ||
    !label(value["regionName"])
  )
    return null;
  return Object.freeze({
    code: value["code"],
    districtName: value["districtName"],
    name: value["name"],
    regionName: value["regionName"],
  });
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
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
