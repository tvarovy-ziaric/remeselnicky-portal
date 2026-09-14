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
  readonly searchCards: PublicSearchCards;
}

export const PUBLIC_SEARCH_CARDS_PATH = "/v1/public/craftsmen/search";

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
