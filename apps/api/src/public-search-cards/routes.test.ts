import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { registerPublicSearchCardRoutes } from "./routes.js";

describe("public search-card route", () => {
  it("returns only the service allowlist with no-store and no indexing", async () => {
    const app = Fastify();
    registerPublicSearchCardRoutes(app, {
      searchCards: {
        search: () =>
          Promise.resolve({
            page: {
              items: [{ ...card(), privateStorageKey: "private/secret" }],
              nextCursor: null,
            },
            status: "OK",
          }),
      },
    });
    const response = await app.inject({
      method: "GET",
      url: "/v1/public/craftsmen/search?professionCode=PROF%3ATILER",
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(response.json()).toEqual({
      items: [card()],
      nextCursor: null,
    });
    expect(response.body).not.toContain("privateStorageKey");
    await app.close();
  });

  it("passes only raw query data to the server service", async () => {
    const search = vi.fn(() =>
      Promise.resolve({ status: "INVALID_QUERY" as const }),
    );
    const app = Fastify();
    registerPublicSearchCardRoutes(app, { searchCards: { search } });
    const response = await app.inject({
      method: "GET",
      url: "/v1/public/craftsmen/search?professionCode=PROF%3ATILER&skillCodes=SKILL%3AGRIP&skillCodes=SKILL%3ACUT",
    });
    expect(response.statusCode).toBe(400);
    expect(search).toHaveBeenCalledWith({
      professionCode: "PROF:TILER",
      skillCodes: ["SKILL:GRIP", "SKILL:CUT"],
    });
    await app.close();
  });

  it("uses one uniform bounded error without internal details", async () => {
    const app = Fastify();
    registerPublicSearchCardRoutes(app, {
      searchCards: {
        search: () => Promise.reject(new Error("storage_key private/hash")),
      },
    });
    const response = await app.inject({
      method: "GET",
      url: "/v1/public/craftsmen/search?professionCode=PROF%3ATILER",
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ code: "TEMPORARILY_UNAVAILABLE" });
    expect(response.body).not.toMatch(/storage|private|hash/iu);
    expect(response.headers["cache-control"]).toBe("no-store");
    await app.close();
  });
});

function card() {
  return {
    availability: "NO_POSITIVE_SIGNAL",
    badges: [],
    identity: {
      primaryName: "Majster Ján",
      profileType: "INDIVIDUAL",
      secondaryName: "Ján Remeselný",
    },
    indicativePrice: null,
    location: { approximateDistanceKm: 8, municipalityName: "Bratislava" },
    professions: [{ code: "PROF:TILER", label: "Obkladač" }],
    profileId: "99000000-0000-4000-8000-000000000001",
    rating: { reviewCount: 0, score: null },
    representativePortfolioImage: null,
    verifiedWorkCount: 0,
    whyMatched: [{ kind: "PROFESSION", text: "Vykonáva profesiu Obkladač" }],
  };
}
