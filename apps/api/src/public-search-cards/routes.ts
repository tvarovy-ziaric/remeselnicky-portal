import { createHash } from "node:crypto";

import type { FastifyInstance } from "fastify";

interface SafeSearchPage {
  readonly items: readonly SafeSearchCard[];
  readonly nextCursor: string | null;
}

interface SafeSearchCard {
  readonly availability: string;
  readonly badges: readonly Readonly<{ kind: string; label: string }>[];
  readonly identity: Readonly<{
    primaryName: string;
    profileType: string;
    secondaryName: string | null;
  }>;
  readonly indicativePrice: null;
  readonly location: Readonly<{
    approximateDistanceKm: number | null;
    municipalityName: string;
  }>;
  readonly professions: readonly Readonly<{ code: string; label: string }>[];
  readonly profileId: string;
  readonly rating: Readonly<{ reviewCount: number; score: number | null }>;
  readonly representativePortfolioImage: Readonly<{
    mediaAssetId: string;
  }> | null;
  readonly verifiedWorkCount: number;
  readonly whyMatched: readonly Readonly<{ kind: string; text: string }>[];
}

interface PublicSearchCards {
  search(
    input: unknown,
  ): Promise<
    | Readonly<{ status: "INVALID_QUERY" }>
    | Readonly<{ page: SafeSearchPage; status: "OK" }>
  >;
}

export interface PublicSearchCardRouteDependencies {
  readonly admission: PublicSearchAdmission;
  readonly searchCards: PublicSearchCards;
}

export interface PublicSearchAdmission {
  admit(input: { readonly ip: string }): Promise<"ADMITTED" | "RATE_LIMITED">;
}

export interface PublicSearchRateLimitPersistence {
  consumeRateLimit(input: {
    readonly keyDigest: string;
    readonly limit: number;
    readonly now: Date;
    readonly scope: string;
    readonly timeWindowMs: number;
  }): Promise<{ readonly current: number }>;
}

export const PUBLIC_SEARCH_CARDS_PATH = "/v1/public/craftsmen/search";
/** Reuses the established auth rate window with a read-heavy public multiplier. */
export const PUBLIC_SEARCH_RATE_LIMIT_MULTIPLIER = 5;

const responseHeaders = Object.freeze({
  "cache-control": "no-store",
  "x-robots-tag": "noindex, nofollow",
});

export function registerPublicSearchCardRoutes(
  app: FastifyInstance,
  dependencies: PublicSearchCardRouteDependencies,
): void {
  app.get(PUBLIC_SEARCH_CARDS_PATH, async (request, reply) => {
    reply.headers(responseHeaders);
    try {
      if (dependencies.admission === undefined) {
        return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
      }
      const admission = await dependencies.admission.admit({ ip: request.ip });
      if (admission === "RATE_LIMITED") {
        return reply.code(429).send({ code: "RATE_LIMITED" });
      }
      const result = await dependencies.searchCards.search(request.query);
      if (result.status === "INVALID_QUERY") {
        return reply.code(400).send({ code: "INVALID_QUERY" });
      }
      return reply.code(200).send(serializePage(result.page));
    } catch {
      return reply.code(503).send({ code: "TEMPORARILY_UNAVAILABLE" });
    }
  });
}

export function createDatabasePublicSearchAdmission(input: {
  readonly clock?: () => Date;
  readonly limit: number;
  readonly persistence: PublicSearchRateLimitPersistence;
  readonly timeWindowMs: number;
}): PublicSearchAdmission {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
    throw new RangeError("public search rate limit must be positive");
  }
  if (!Number.isSafeInteger(input.timeWindowMs) || input.timeWindowMs < 1) {
    throw new RangeError("public search rate window must be positive");
  }
  const clock = input.clock ?? (() => new Date());
  return Object.freeze({
    async admit(request: { readonly ip: string }) {
      if (
        typeof request.ip !== "string" ||
        request.ip.length < 1 ||
        request.ip.length > 256 ||
        /[\p{Cc}]/u.test(request.ip)
      ) {
        throw new TypeError("public search admission IP is invalid");
      }
      const now = clock();
      if (!(now instanceof Date) || !Number.isFinite(now.valueOf())) {
        throw new TypeError("public search admission clock is invalid");
      }
      const keyDigest = createHash("sha256")
        .update(`${PUBLIC_SEARCH_CARDS_PATH}\u0000${request.ip}`, "utf8")
        .digest("hex");
      const result = await input.persistence.consumeRateLimit({
        keyDigest,
        limit: input.limit,
        now,
        scope: "public-search:ip",
        timeWindowMs: input.timeWindowMs,
      });
      if (!Number.isSafeInteger(result.current) || result.current < 1) {
        throw new TypeError("public search admission result is invalid");
      }
      return result.current > input.limit ? "RATE_LIMITED" : "ADMITTED";
    },
  });
}

function serializePage(page: SafeSearchPage): SafeSearchPage {
  return {
    items: page.items.map((card) => ({
      availability: card.availability,
      badges: card.badges.map(({ kind, label }) => ({ kind, label })),
      identity: {
        primaryName: card.identity.primaryName,
        profileType: card.identity.profileType,
        secondaryName: card.identity.secondaryName,
      },
      indicativePrice: null,
      location: {
        approximateDistanceKm: card.location.approximateDistanceKm,
        municipalityName: card.location.municipalityName,
      },
      professions: card.professions.map(({ code, label }) => ({ code, label })),
      profileId: card.profileId,
      rating: {
        reviewCount: card.rating.reviewCount,
        score: card.rating.score,
      },
      representativePortfolioImage:
        card.representativePortfolioImage === null
          ? null
          : { mediaAssetId: card.representativePortfolioImage.mediaAssetId },
      verifiedWorkCount: card.verifiedWorkCount,
      whyMatched: card.whyMatched.map(({ kind, text }) => ({ kind, text })),
    })),
    nextCursor: page.nextCursor,
  };
}
