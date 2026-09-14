import { describe, expect, it } from "vitest";

import {
  assertCraftsmanServiceAreaMatchQuery,
  createCraftsmanServiceAreaMatch,
  serializePublicCraftsmanServiceAreaMatch,
  type MunicipalityCode,
} from "../src/index.js";

const profileId = "94000000-0000-4000-8000-000000000001";

describe("craftsman service-area match", () => {
  it.each([
    "ADDITIONAL_SERVICE_AREA",
    "WITHIN_NORMAL_RADIUS",
    "WITHIN_MAXIMUM_RADIUS",
    "OUTSIDE_DECLARED_AREA",
  ])("accepts measured %s facts", (matchKind) => {
    expect(
      createCraftsmanServiceAreaMatch({
        approximateDistanceKm: 18,
        craftsmanProfileId: profileId,
        matchKind,
        rankingDistanceMeters: 17_501,
      }),
    ).toMatchObject({ matchKind, rankingDistanceMeters: 17_501 });
  });

  it("keeps omitted-origin relevance neutral and distance-free", () => {
    expect(
      createCraftsmanServiceAreaMatch({
        approximateDistanceKm: null,
        craftsmanProfileId: profileId,
        matchKind: "DISTANCE_UNAVAILABLE",
        rankingDistanceMeters: null,
      }),
    ).toMatchObject({
      approximateDistanceKm: null,
      matchKind: "DISTANCE_UNAVAILABLE",
      rankingDistanceMeters: null,
    });
  });

  it("publishes only approximate distance and non-contractual classification", () => {
    const serialized = serializePublicCraftsmanServiceAreaMatch(
      createCraftsmanServiceAreaMatch({
        approximateDistanceKm: 18,
        craftsmanProfileId: profileId,
        matchKind: "WITHIN_MAXIMUM_RADIUS",
        rankingDistanceMeters: 17_501,
      }),
    );
    expect(serialized).toEqual({
      approximateDistanceKm: 18,
      craftsmanProfileId: profileId,
      matchKind: "WITHIN_MAXIMUM_RADIUS",
    });
    expect(Object.keys(serialized)).not.toContain("rankingDistanceMeters");
  });

  it.each([
    {
      approximateDistanceKm: null,
      matchKind: "WITHIN_NORMAL_RADIUS",
      rankingDistanceMeters: null,
    },
    {
      approximateDistanceKm: 1,
      matchKind: "DISTANCE_UNAVAILABLE",
      rankingDistanceMeters: 1_000,
    },
    {
      approximateDistanceKm: 2,
      matchKind: "UNKNOWN",
      rankingDistanceMeters: 2_000,
    },
    {
      approximateDistanceKm: 1,
      matchKind: "WITHIN_NORMAL_RADIUS",
      rankingDistanceMeters: -1,
    },
  ])("rejects malformed persisted facts %#", (fact) => {
    expect(() =>
      createCraftsmanServiceAreaMatch({
        craftsmanProfileId: profileId,
        ...fact,
      }),
    ).toThrow(/service-area match/u);
  });

  it.each([
    { includeOutsideDeclaredArea: false, limit: 0, municipalityCode: null },
    { includeOutsideDeclaredArea: false, limit: 101, municipalityCode: null },
    { includeOutsideDeclaredArea: 1, limit: 20, municipalityCode: null },
    {
      includeOutsideDeclaredArea: false,
      limit: 20,
      municipalityCode: "SK/BA" as MunicipalityCode,
    },
  ])("rejects malformed query input %#", (input) => {
    expect(() =>
      assertCraftsmanServiceAreaMatchQuery(
        input as Parameters<typeof assertCraftsmanServiceAreaMatchQuery>[0],
      ),
    ).toThrow(/service-area match/u);
  });

  it("accepts optional origin without turning it into a negative signal", () => {
    expect(() =>
      assertCraftsmanServiceAreaMatchQuery({
        includeOutsideDeclaredArea: false,
        limit: 20,
        municipalityCode: null,
      }),
    ).not.toThrow();
  });
});
