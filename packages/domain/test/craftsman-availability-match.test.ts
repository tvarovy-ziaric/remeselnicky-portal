import { describe, expect, it } from "vitest";

import {
  assertCraftsmanAvailabilityMatchQuery,
  createCraftsmanAvailabilityMatch,
  CraftsmanAvailabilityMatchValidationError,
} from "../src/craftsman-availability-match.js";

const profileId = "97000000-0000-4000-8000-000000000001";

describe("craftsman availability match", () => {
  it("keeps omitted timing neutral and forbids filtering without timing", () => {
    expect(() =>
      assertCraftsmanAvailabilityMatchQuery({
        endsAt: null,
        filterIndicativelyAvailable: false,
        limit: 20,
        startsAt: null,
      }),
    ).not.toThrow();
    expect(() =>
      assertCraftsmanAvailabilityMatchQuery({
        endsAt: null,
        filterIndicativelyAvailable: true,
        limit: 20,
        startsAt: null,
      }),
    ).toThrow(CraftsmanAvailabilityMatchValidationError);
  });

  it("accepts a bounded UTC instant interval", () => {
    expect(() =>
      assertCraftsmanAvailabilityMatchQuery({
        endsAt: new Date("2028-06-01T12:00:00.000Z"),
        filterIndicativelyAvailable: true,
        limit: 100,
        startsAt: new Date("2028-06-01T10:00:00.000Z"),
      }),
    ).not.toThrow();
  });

  it.each([
    { startsAt: null },
    { endsAt: new Date("2028-06-01T09:00:00.000Z") },
    { startsAt: new Date("invalid") },
    { startsAt: new Date("1999-12-31T23:59:59.999Z") },
    { endsAt: new Date("2200-01-01T00:00:00.001Z") },
    { limit: 0 },
    { limit: 101 },
    { filterIndicativelyAvailable: 1 },
  ])("rejects malformed timing input %#", (change) => {
    expect(() =>
      assertCraftsmanAvailabilityMatchQuery({
        endsAt: new Date("2028-06-01T12:00:00.000Z"),
        filterIndicativelyAvailable: false,
        limit: 20,
        startsAt: new Date("2028-06-01T10:00:00.000Z"),
        ...change,
      } as Parameters<typeof assertCraftsmanAvailabilityMatchQuery>[0]),
    ).toThrow(CraftsmanAvailabilityMatchValidationError);
  });

  it.each([
    ["AVAILABLE_OVERLAP", true],
    ["TIMING_NOT_SUPPLIED", false],
    ["NO_OVERLAPPING_DECLARATION", false],
    ["BUSY_OVERLAP", false],
    ["UNAVAILABLE_OVERLAP", false],
    ["MIXED_OVERLAP", false],
  ])("accepts coherent %s facts", (matchKind, indicativelyAvailable) => {
    const fact = createCraftsmanAvailabilityMatch({
      craftsmanProfileId: profileId,
      indicativelyAvailable,
      matchKind,
    });
    expect(fact).toEqual({
      craftsmanProfileId: profileId,
      indicativelyAvailable,
      matchKind,
    });
    expect(Object.isFrozen(fact)).toBe(true);
  });

  it("fails closed when MIXED is misrepresented as indicatively available", () => {
    expect(() =>
      createCraftsmanAvailabilityMatch({
        craftsmanProfileId: profileId,
        indicativelyAvailable: true,
        matchKind: "MIXED_OVERLAP",
      }),
    ).toThrow(CraftsmanAvailabilityMatchValidationError);
  });
});
