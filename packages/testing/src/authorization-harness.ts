import type { TestHttpResponse } from "./http.js";

const defaultDeniedStatuses: readonly number[] = Object.freeze([401, 403, 404]);

export function assertAuthorizationDenied(
  response: TestHttpResponse,
  options: {
    readonly allowedStatusCodes?: readonly number[];
    readonly forbiddenResponseMarkers?: readonly string[];
  } = {},
): void {
  const allowed = options.allowedStatusCodes ?? defaultDeniedStatuses;
  if (
    allowed.length === 0 ||
    allowed.some((statusCode) => !defaultDeniedStatuses.includes(statusCode))
  ) {
    throw new TypeError(
      "Denial statuses must be a subset of 401, 403 and 404.",
    );
  }
  if (!allowed.includes(response.statusCode)) {
    throw new Error(
      `Expected an authorization denial, received HTTP ${response.statusCode}.`,
    );
  }
  assertNoForbiddenMarkers(response, options.forbiddenResponseMarkers ?? []);
}

/** Ensures object existence is not disclosed differently between attackers. */
export function assertUniformNotFound(
  responses: readonly TestHttpResponse[],
  options: { readonly forbiddenResponseMarkers?: readonly string[] } = {},
): void {
  if (responses.length < 2) {
    throw new TypeError("Uniform denial verification requires two responses.");
  }
  const canonicalBody = stableJson(responses[0]?.body);
  for (const response of responses) {
    if (response.statusCode !== 404) {
      throw new Error(`Private-object denial must be HTTP 404.`);
    }
    if (stableJson(response.body) !== canonicalBody) {
      throw new Error("Private-object denials are not uniform.");
    }
    if (header(response, "location") !== undefined) {
      throw new Error("A denied private-object response exposed a location.");
    }
    const cacheControl = header(response, "cache-control")?.toLowerCase();
    if (cacheControl === undefined || !cacheControl.includes("no-store")) {
      throw new Error("A denied private-object response is cacheable.");
    }
    assertNoForbiddenMarkers(response, options.forbiddenResponseMarkers ?? []);
  }
}

function assertNoForbiddenMarkers(
  response: TestHttpResponse,
  markers: readonly string[],
): void {
  const serialized = stableJson({
    body: response.body,
    headers: response.headers,
  });
  for (const marker of markers) {
    if (marker.length > 0 && serialized.includes(marker)) {
      throw new Error(
        "Authorization denial leaked a forbidden private marker.",
      );
    }
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value)) ?? "undefined";
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}

function header(response: TestHttpResponse, name: string): string | undefined {
  return Object.entries(response.headers).find(
    ([candidate]) => candidate.toLowerCase() === name,
  )?.[1];
}
