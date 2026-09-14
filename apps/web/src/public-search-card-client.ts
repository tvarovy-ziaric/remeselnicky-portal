import { cache } from "react";

import type { PublicSearchCardViewModel } from "./public-search-card-view";

export interface PublicSearchCardPageViewModel {
  readonly items: readonly PublicSearchCardViewModel[];
  readonly nextCursor: string | null;
}

interface LoaderDependencies {
  readonly apiOrigin: string;
  readonly fetch: typeof fetch;
}

const PUBLIC_SEARCH_PAGE_MAX_ITEMS = 50;
const PUBLIC_SEARCH_CARD_MAX_PROFESSIONS = 20;
const PUBLIC_SEARCH_CARD_MAX_BADGES = 5;
const PUBLIC_SEARCH_CARD_MAX_REASONS = 5;

export function createPublicSearchCardLoader(dependencies: LoaderDependencies) {
  const origin = internalApiOrigin(dependencies.apiOrigin);
  return async (
    parameters: Readonly<
      Record<string, string | readonly string[] | undefined>
    >,
  ): Promise<PublicSearchCardPageViewModel | null> => {
    if (origin === null) return null;
    try {
      const endpoint = new URL("/v1/public/craftsmen/search", origin);
      for (const [key, raw] of Object.entries(parameters)) {
        for (const value of typeof raw === "string" ? [raw] : (raw ?? [])) {
          endpoint.searchParams.append(key, value);
        }
      }
      const response = await dependencies.fetch(endpoint, {
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      if (!response.ok) return null;
      return parsePage(await response.json());
    } catch {
      return null;
    }
  };
}

const load = createPublicSearchCardLoader({
  apiOrigin: process.env.PORTAL_API_ORIGIN ?? "http://127.0.0.1:3001",
  fetch,
});

export const loadPublicSearchCards = cache(load);

function parsePage(value: unknown): PublicSearchCardPageViewModel | null {
  if (
    !record(value) ||
    !Array.isArray(value["items"]) ||
    value["items"].length > PUBLIC_SEARCH_PAGE_MAX_ITEMS
  )
    return null;
  const nextCursor = value["nextCursor"];
  if (nextCursor !== null && !uuid(nextCursor)) return null;
  const items = value["items"].map(parseCard);
  if (items.some((item) => item === null)) return null;
  return Object.freeze({
    items: Object.freeze(items as PublicSearchCardViewModel[]),
    nextCursor,
  });
}

function parseCard(value: unknown): PublicSearchCardViewModel | null {
  if (!record(value) || !uuid(value["profileId"])) return null;
  const identity = value["identity"];
  const location = value["location"];
  const rating = value["rating"];
  const image = value["representativePortfolioImage"];
  if (
    !record(identity) ||
    !text(identity["primaryName"]) ||
    (identity["secondaryName"] !== null && !text(identity["secondaryName"])) ||
    !record(location) ||
    !text(location["municipalityName"]) ||
    (location["approximateDistanceKm"] !== null &&
      (!integer(location["approximateDistanceKm"]) ||
        location["approximateDistanceKm"] > 20_040)) ||
    !record(rating) ||
    !integer(rating["reviewCount"]) ||
    (rating["score"] !== null && !score(rating["score"])) ||
    !integer(value["verifiedWorkCount"]) ||
    !Array.isArray(value["professions"]) ||
    value["professions"].length < 1 ||
    value["professions"].length > PUBLIC_SEARCH_CARD_MAX_PROFESSIONS ||
    !Array.isArray(value["badges"]) ||
    value["badges"].length > PUBLIC_SEARCH_CARD_MAX_BADGES ||
    !Array.isArray(value["whyMatched"]) ||
    value["whyMatched"].length > PUBLIC_SEARCH_CARD_MAX_REASONS ||
    (image !== null && (!record(image) || !uuid(image["mediaAssetId"]))) ||
    value["indicativePrice"] !== null ||
    !["INDICATIVELY_AVAILABLE", "NO_POSITIVE_SIGNAL"].includes(
      String(value["availability"]),
    )
  ) {
    return null;
  }
  const professions = value["professions"].map(labelItem);
  const badges = value["badges"].map(labelItem);
  const reasons = value["whyMatched"].map((item) =>
    record(item) && text(item["text"])
      ? { kind: String(item["kind"]), text: item["text"] }
      : null,
  );
  if (
    professions.some((item) => item === null) ||
    badges.some((item) => item === null) ||
    reasons.some((item) => item === null)
  ) {
    return null;
  }
  return Object.freeze({
    availability: value[
      "availability"
    ] as PublicSearchCardViewModel["availability"],
    badges: badges as PublicSearchCardViewModel["badges"],
    identity: {
      primaryName: identity["primaryName"],
      secondaryName: identity["secondaryName"],
    },
    location: {
      approximateDistanceKm:
        typeof location["approximateDistanceKm"] === "number"
          ? location["approximateDistanceKm"]
          : null,
      municipalityName: location["municipalityName"],
    },
    professions: professions as PublicSearchCardViewModel["professions"],
    profileId: value["profileId"],
    rating: {
      reviewCount: rating["reviewCount"],
      score: rating["score"],
    },
    representativePortfolioImage:
      image === null ? null : { mediaAssetId: image["mediaAssetId"] as string },
    verifiedWorkCount: value["verifiedWorkCount"],
    whyMatched: reasons as PublicSearchCardViewModel["whyMatched"],
  });
}

function labelItem(value: unknown) {
  return record(value) && text(value["label"])
    ? { kind: String(value["kind"] ?? value["code"]), label: value["label"] }
    : null;
}

function text(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length > 0 &&
    value.length <= 180 &&
    !/[\r\n\p{Cc}]/u.test(value) &&
    [
      /[\p{L}\d._%+-]+@[\p{L}\d.-]+\.[\p{L}]{2,}/iu,
      /(^|[^0-9])(\+|00)?[0-9]([\s()./-]*[0-9]){6,}([^0-9]|$)/u,
      /\b(?:https?:\/\/|www\.)/iu,
      /\b(?:adresa|ulica|číslo domu|číslo bytu)\b/iu,
      /\b(?:heslo|password|api[ _-]?key|access[ _-]?token|secret)\b/iu,
    ].every((pattern) => !pattern.test(value))
  );
}
function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function score(value: unknown): value is number {
  return typeof value === "number" && value >= 0 && value <= 5;
}
function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function internalApiOrigin(value: string): URL | null {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
      ? url
      : null;
  } catch {
    return null;
  }
}
