import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import {
  createDatabasePublicSearchAdmission,
  PUBLIC_SEARCH_CARDS_PATH,
  registerPublicSearchCardRoutes,
  type PublicSearchRateLimitPersistence,
} from "./routes.js";

const admitted = Object.freeze({
  admit: () => Promise.resolve("ADMITTED" as const),
});

describe("public search-card route", () => {
  it("returns only the service allowlist with no-store and no indexing", async () => {
    const app = Fastify();
    registerPublicSearchCardRoutes(app, {
      admission: admitted,
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
    registerPublicSearchCardRoutes(app, {
      admission: admitted,
      searchCards: { search },
    });
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
      admission: admitted,
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

  it("rejects an exhausted public-search budget before executing search", async () => {
    const search = vi.fn(() =>
      Promise.resolve({ status: "INVALID_QUERY" as const }),
    );
    const app = Fastify();
    registerPublicSearchCardRoutes(app, {
      admission: {
        admit: () => Promise.resolve("RATE_LIMITED"),
      },
      searchCards: { search },
    });
    const response = await app.inject({
      method: "GET",
      url: `${PUBLIC_SEARCH_CARDS_PATH}?professionCode=PROF%3ATILER`,
    });
    expect(response.statusCode).toBe(429);
    expect(response.json()).toEqual({ code: "RATE_LIMITED" });
    expect(search).not.toHaveBeenCalled();
    expect(response.headers["cache-control"]).toBe("no-store");
    await app.close();
  });

  it("fails closed when public-search admission is missing or unavailable", async () => {
    const search = vi.fn(() =>
      Promise.resolve({ status: "INVALID_QUERY" as const }),
    );
    const missing = Fastify();
    registerPublicSearchCardRoutes(missing, {
      searchCards: { search },
    } as unknown as Parameters<typeof registerPublicSearchCardRoutes>[1]);
    const missingResponse = await missing.inject({
      method: "GET",
      url: `${PUBLIC_SEARCH_CARDS_PATH}?professionCode=PROF%3ATILER`,
    });
    expect(missingResponse.statusCode).toBe(503);
    expect(missingResponse.json()).toEqual({
      code: "TEMPORARILY_UNAVAILABLE",
    });
    await missing.close();

    const unavailable = Fastify();
    registerPublicSearchCardRoutes(unavailable, {
      admission: {
        admit: () => Promise.reject(new Error("raw IP 198.51.100.4")),
      },
      searchCards: { search },
    });
    const unavailableResponse = await unavailable.inject({
      method: "GET",
      url: `${PUBLIC_SEARCH_CARDS_PATH}?professionCode=PROF%3ATILER`,
    });
    expect(unavailableResponse.statusCode).toBe(503);
    expect(unavailableResponse.body).not.toContain("198.51.100.4");
    expect(search).not.toHaveBeenCalled();
    await unavailable.close();
  });

  it("admits by a stable route-and-IP digest without persisting raw IP", async () => {
    const consumeRateLimit = vi
      .fn<PublicSearchRateLimitPersistence["consumeRateLimit"]>()
      .mockResolvedValueOnce({ current: 5 })
      .mockResolvedValueOnce({ current: 6 })
      .mockResolvedValueOnce({ current: 1 });
    const admission = createDatabasePublicSearchAdmission({
      clock: () => new Date("2026-09-15T10:00:00.000Z"),
      limit: 5,
      persistence: { consumeRateLimit },
      timeWindowMs: 60_000,
    });

    await expect(admission.admit({ ip: "198.51.100.4" })).resolves.toBe(
      "ADMITTED",
    );
    await expect(admission.admit({ ip: "198.51.100.4" })).resolves.toBe(
      "RATE_LIMITED",
    );
    await expect(admission.admit({ ip: "198.51.100.5" })).resolves.toBe(
      "ADMITTED",
    );
    const first = consumeRateLimit.mock.calls[0]?.[0];
    const second = consumeRateLimit.mock.calls[1]?.[0];
    const third = consumeRateLimit.mock.calls[2]?.[0];
    expect(first).toMatchObject({
      limit: 5,
      scope: "public-search:ip",
      timeWindowMs: 60_000,
    });
    expect(first?.keyDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(first?.keyDigest).toBe(second?.keyDigest);
    expect(first?.keyDigest).not.toBe(third?.keyDigest);
    expect(JSON.stringify(consumeRateLimit.mock.calls)).not.toContain(
      "198.51.100.4",
    );
  });

  it("rejects invalid admission configuration and provider output", async () => {
    expect(() =>
      createDatabasePublicSearchAdmission({
        limit: 0,
        persistence: {
          consumeRateLimit: () => Promise.resolve({ current: 1 }),
        },
        timeWindowMs: 1,
      }),
    ).toThrow(RangeError);
    const invalidProvider = createDatabasePublicSearchAdmission({
      limit: 5,
      persistence: {
        consumeRateLimit: () => Promise.resolve({ current: Number.NaN }),
      },
      timeWindowMs: 1,
    });
    await expect(invalidProvider.admit({ ip: "198.51.100.4" })).rejects.toThrow(
      TypeError,
    );
    await expect(invalidProvider.admit({ ip: "bad\nip" })).rejects.toThrow(
      TypeError,
    );
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
