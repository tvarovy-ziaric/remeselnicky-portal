import { describe, expect, it } from "vitest";

import {
  AvailabilitySearchIntegrityError,
  composeAvailabilityRelevance,
  type AvailabilitySearchFact,
} from "../src/availability-relevance.js";

const ids = [
  "97000000-0000-4000-8000-000000000001",
  "97000000-0000-4000-8000-000000000002",
  "97000000-0000-4000-8000-000000000003",
  "97000000-0000-4000-8000-000000000004",
];

describe("availability search composition", () => {
  it("keeps absent timing and unavailable declarations neutral, not negative", () => {
    const candidates = ids.slice(0, 2).map((profileId) => ({ profileId }));
    const result = composeAvailabilityRelevance(
      candidates,
      [
        fact(ids[0]!, "TIMING_NOT_SUPPLIED"),
        fact(ids[1]!, "UNAVAILABLE_OVERLAP"),
      ],
      false,
    );
    expect(result.map(({ candidate }) => candidate.profileId)).toEqual(
      ids.slice(0, 2),
    );
    expect(result.map(({ availability }) => availability.relevance)).toEqual([
      "NEUTRAL",
      "NEUTRAL",
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result[0]?.availability)).toBe(true);
  });

  it("marks only AVAILABLE-only overlap as a soft positive", () => {
    const result = composeAvailabilityRelevance(
      ids.slice(0, 3).map((profileId) => ({ profileId })),
      [
        fact(ids[0]!, "AVAILABLE_OVERLAP"),
        fact(ids[1]!, "MIXED_OVERLAP"),
        fact(ids[2]!, "BUSY_OVERLAP"),
      ],
      false,
    );
    expect(result.map(({ availability }) => availability.relevance)).toEqual([
      "SOFT_POSITIVE",
      "NEUTRAL",
      "NEUTRAL",
    ]);
  });

  it("makes the indicative filter explicit and excludes MIXED fail closed", () => {
    const result = composeAvailabilityRelevance(
      ids.slice(0, 4).map((profileId) => ({ profileId })),
      [
        fact(ids[0]!, "AVAILABLE_OVERLAP"),
        fact(ids[1]!, "MIXED_OVERLAP"),
        fact(ids[2]!, "UNAVAILABLE_OVERLAP"),
        fact(ids[3]!, "NO_OVERLAPPING_DECLARATION"),
      ],
      true,
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.candidate.profileId).toBe(ids[0]);
  });

  it.each([
    [
      [fact(ids[0]!, "AVAILABLE_OVERLAP"), fact(ids[0]!, "AVAILABLE_OVERLAP")],
      "duplicate",
    ],
    [[fact(ids[0]!, "MIXED_OVERLAP", true)], "fact"],
    [[], "missing"],
  ])("rejects corrupt fact sets %#", (facts, expected) => {
    expect(() =>
      composeAvailabilityRelevance([{ profileId: ids[0]! }], facts, false),
    ).toThrow(new RegExp(expected, "u"));
  });

  it("rejects a non-boolean filter instead of weakening opt-in semantics", () => {
    expect(() =>
      composeAvailabilityRelevance(
        [{ profileId: ids[0]! }],
        [fact(ids[0]!, "AVAILABLE_OVERLAP")],
        1 as unknown as boolean,
      ),
    ).toThrow(AvailabilitySearchIntegrityError);
  });
});

function fact(
  craftsmanProfileId: string,
  matchKind: AvailabilitySearchFact["matchKind"],
  indicativelyAvailable = matchKind === "AVAILABLE_OVERLAP",
): AvailabilitySearchFact {
  return { craftsmanProfileId, indicativelyAvailable, matchKind };
}
