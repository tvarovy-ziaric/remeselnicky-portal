import type { CraftsmanDistanceFact, CraftsmanProfileId } from "@portal/domain";
import { describe, expect, it } from "vitest";

import {
  ALTERNATE_SEARCH_SORT_MODES,
  AlternateSearchSortIntegrityError,
  sortEligibleSearchCandidates,
  type BestRatedSortFact,
} from "../src/alternate-sort.js";

const ids = [
  "98000000-0000-4000-8000-000000000001",
  "98000000-0000-4000-8000-000000000002",
  "98000000-0000-4000-8000-000000000003",
  "98000000-0000-4000-8000-000000000004",
] as const;

describe("alternate search sort modes", () => {
  it("locks the alpha alternate mode vocabulary", () => {
    expect(ALTERNATE_SEARCH_SORT_MODES).toEqual(["NEAREST", "BEST_RATED"]);
  });

  it("orders nearest by internal metres, null last, and UUID ties", () => {
    const candidates = [
      candidate(ids[2]),
      candidate(ids[1]),
      candidate(ids[0]),
    ];
    const result = sortEligibleSearchCandidates({
      candidates,
      distanceFacts: [
        distance(ids[2], null),
        distance(ids[1], 1_000),
        distance(ids[0], 1_000),
      ],
      mode: "NEAREST",
    });
    expect(result.map(({ profileId }) => profileId)).toEqual([
      ids[0],
      ids[1],
      ids[2],
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.every((item) => !("rankingDistanceMeters" in item))).toBe(
      true,
    );
  });

  it("treats zero as real and keeps all-null distance in Recommended order", () => {
    const candidates = [
      candidate(ids[2]),
      candidate(ids[0]),
      candidate(ids[1]),
    ];
    const measured = sortEligibleSearchCandidates({
      candidates,
      distanceFacts: [
        distance(ids[0], null),
        distance(ids[1], 50),
        distance(ids[2], 0),
      ],
      mode: "NEAREST",
    });
    expect(measured.map(({ profileId }) => profileId)).toEqual([
      ids[2],
      ids[1],
      ids[0],
    ]);
    const unavailable = sortEligibleSearchCandidates({
      candidates,
      distanceFacts: candidates.map(({ profileId }) =>
        distance(profileId, null),
      ),
      mode: "NEAREST",
    });
    expect(unavailable).toEqual(candidates);
  });

  it("puts measured facts first while preserving the null cluster order", () => {
    const candidates = [
      candidate(ids[3]),
      candidate(ids[2]),
      candidate(ids[0]),
      candidate(ids[1]),
    ];
    const result = sortEligibleSearchCandidates({
      candidates,
      distanceFacts: [
        distance(ids[0], null),
        distance(ids[1], 500),
        distance(ids[2], 1_000),
        distance(ids[3], null),
      ],
      mode: "NEAREST",
    });
    expect(result.map(({ profileId }) => profileId)).toEqual([
      ids[1],
      ids[2],
      ids[3],
      ids[0],
    ]);
  });

  it("never admits an extra distance fact outside the eligible pool", () => {
    expect(() =>
      sortEligibleSearchCandidates({
        candidates: [candidate(ids[0])],
        distanceFacts: [distance(ids[0], 1_000), distance(ids[1], 500)],
        mode: "NEAREST",
      }),
    ).toThrow(/fact set/u);
  });

  it("ranks only sufficient ratings by score and review count", () => {
    const candidates = [
      candidate(ids[3]),
      candidate(ids[2]),
      candidate(ids[1]),
      candidate(ids[0]),
    ];
    const result = sortEligibleSearchCandidates({
      candidates,
      mode: "BEST_RATED",
      ratingFacts: [
        rating(ids[0], 4.9, 20, true),
        rating(ids[1], 4.9, 80, true),
        rating(ids[2], null, 1, false),
        rating(ids[3], null, 0, false),
      ],
    });
    expect(result.map(({ profileId }) => profileId)).toEqual([
      ids[1],
      ids[0],
      ids[3],
      ids[2],
    ]);
  });

  it("keeps current sparse R2 profiles in incoming Recommended order", () => {
    const candidates = [
      candidate(ids[2]),
      candidate(ids[0]),
      candidate(ids[1]),
    ];
    const result = sortEligibleSearchCandidates({
      candidates,
      mode: "BEST_RATED",
      ratingFacts: candidates.map(({ profileId }) =>
        rating(profileId, null, 0, false),
      ),
    });
    expect(result).toEqual(candidates);
  });

  it("requires a one-review score to be suppressed when confidence is insufficient", () => {
    expect(() =>
      sortEligibleSearchCandidates({
        candidates: [candidate(ids[0])],
        mode: "BEST_RATED",
        ratingFacts: [rating(ids[0], 5, 1, false)],
      }),
    ).toThrow(/insufficient/u);
  });

  it("does not use paid, founder, completeness, photo, price, or tag fields", () => {
    const candidates = [
      candidate(ids[1]),
      {
        ...candidate(ids[0]),
        paid: true,
        founder: true,
        completeness: 100,
        photoCount: 10_000,
        lowestPrice: 1,
        tagCount: 10_000,
      },
    ];
    const facts = candidates.map(({ profileId }) =>
      rating(profileId, null, 0, false),
    );
    expect(
      sortEligibleSearchCandidates({
        candidates,
        mode: "BEST_RATED",
        ratingFacts: facts,
      }).map(({ profileId }) => profileId),
    ).toEqual([ids[1], ids[0]]);
  });

  it.each([
    [rating(ids[0], 5, 1, false), "insufficient"],
    [rating(ids[0], null, 2, true), "sufficient"],
    [rating(ids[0], 5.1, 10, true), "sufficient"],
    [rating(ids[0], 4.5, 0, true), "sufficient"],
    [rating(ids[0], null, -1, false), "rating"],
  ])("rejects incoherent rating fact %#", (fact, expected) => {
    expect(() =>
      sortEligibleSearchCandidates({
        candidates: [candidate(ids[0])],
        mode: "BEST_RATED",
        ratingFacts: [fact],
      }),
    ).toThrow(new RegExp(expected, "u"));
  });

  it("rejects missing, duplicate, cross-profile, and malformed distance facts", () => {
    const candidates = [candidate(ids[0]), candidate(ids[1])];
    for (const distanceFacts of [
      [distance(ids[0], 100)],
      [distance(ids[0], 100), distance(ids[0], 100)],
      [distance(ids[0], 100), distance(ids[2], 100)],
      [
        distance(ids[0], 100),
        { ...distance(ids[1], 100), approximateDistanceKm: 2 },
      ],
    ]) {
      expect(() =>
        sortEligibleSearchCandidates({
          candidates,
          distanceFacts,
          mode: "NEAREST",
        }),
      ).toThrow();
    }
  });

  it("rejects duplicate candidate identities before sorting", () => {
    expect(() =>
      sortEligibleSearchCandidates({
        candidates: [candidate(ids[0]), candidate(ids[0])],
        mode: "BEST_RATED",
        ratingFacts: [rating(ids[0], null, 0, false)],
      }),
    ).toThrow(AlternateSearchSortIntegrityError);
  });

  it("rejects an unknown runtime mode", () => {
    expect(() =>
      sortEligibleSearchCandidates({
        candidates: [],
        mode: "POPULAR" as "NEAREST",
        distanceFacts: [],
      }),
    ).toThrow(/mode/u);
  });
});

function candidate(profileId: string) {
  return Object.freeze({ profileId, safeLabel: `candidate-${profileId}` });
}

function distance(
  craftsmanProfileId: string,
  rankingDistanceMeters: number | null,
): CraftsmanDistanceFact {
  return {
    approximateDistanceKm:
      rankingDistanceMeters === null
        ? null
        : Math.round(rankingDistanceMeters / 1_000),
    craftsmanProfileId: craftsmanProfileId as CraftsmanProfileId,
    rankingDistanceMeters,
  };
}

function rating(
  profileId: string,
  customerScore: number | null,
  reviewCount: number,
  reviewSampleSufficient: boolean,
): BestRatedSortFact {
  return { customerScore, profileId, reviewCount, reviewSampleSufficient };
}
