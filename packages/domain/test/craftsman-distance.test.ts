import { describe, expect, it } from "vitest";

import {
  assertCraftsmanDistanceQueryInput,
  createCraftsmanDistanceFact,
  serializePublicCraftsmanApproximateDistance,
  type MunicipalityCode,
} from "../src/index.js";

const profileId = "74000000-0000-4000-8000-000000000001";

describe("craftsman distance facts", () => {
  it("keeps stable metre precision internal and exposes rounded kilometres", () => {
    const fact = createCraftsmanDistanceFact({
      approximateDistanceKm: 18,
      craftsmanProfileId: profileId,
      rankingDistanceMeters: 17_501,
    });

    expect(fact).toMatchObject({ rankingDistanceMeters: 17_501 });
    expect(serializePublicCraftsmanApproximateDistance(fact)).toEqual({
      approximateDistanceKm: 18,
      craftsmanProfileId: profileId,
    });
    expect(
      Object.keys(serializePublicCraftsmanApproximateDistance(fact)),
    ).not.toEqual(
      expect.arrayContaining([
        "rankingDistanceMeters",
        "latitude",
        "longitude",
        "address",
      ]),
    );
  });

  it("represents missing location with a paired null distance", () => {
    expect(
      createCraftsmanDistanceFact({
        approximateDistanceKm: null,
        craftsmanProfileId: profileId,
        rankingDistanceMeters: null,
      }),
    ).toMatchObject({
      approximateDistanceKm: null,
      rankingDistanceMeters: null,
    });
  });

  it.each([
    { approximateDistanceKm: null, rankingDistanceMeters: 1 },
    { approximateDistanceKm: 1, rankingDistanceMeters: null },
    { approximateDistanceKm: 2, rankingDistanceMeters: 1_499 },
    { approximateDistanceKm: 0, rankingDistanceMeters: -1 },
    { approximateDistanceKm: 20_041, rankingDistanceMeters: 20_040_001 },
    { approximateDistanceKm: 1.1, rankingDistanceMeters: 1_100 },
  ])("rejects an invalid distance pair %#", (distance) => {
    expect(() =>
      createCraftsmanDistanceFact({
        craftsmanProfileId: profileId,
        ...distance,
      }),
    ).toThrow(/distance/u);
  });

  it.each([
    { limit: 0, municipalityCode: null },
    { limit: 101, municipalityCode: null },
    { limit: 1.5, municipalityCode: null },
    { limit: 10, municipalityCode: " sk:ba " as MunicipalityCode },
    { limit: 10, municipalityCode: "SK/BA" as MunicipalityCode },
  ])("rejects malformed server query input %#", (input) => {
    expect(() => assertCraftsmanDistanceQueryInput(input)).toThrow(
      /distance query/u,
    );
  });

  it("accepts omitted location as unavailable distance relevance", () => {
    expect(() =>
      assertCraftsmanDistanceQueryInput({
        limit: 20,
        municipalityCode: null,
      }),
    ).not.toThrow();
  });
});
