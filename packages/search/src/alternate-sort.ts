import {
  createCraftsmanDistanceFact,
  type CraftsmanDistanceFact,
} from "@portal/domain";

export const ALTERNATE_SEARCH_SORT_MODES = Object.freeze([
  "NEAREST",
  "BEST_RATED",
] as const);

export type AlternateSearchSortMode =
  (typeof ALTERNATE_SEARCH_SORT_MODES)[number];

export interface EligibleAlternateSortCandidate {
  readonly profileId: string;
}

export interface BestRatedSortFact {
  readonly profileId: string;
  readonly customerScore: number | null;
  readonly reviewCount: number;
  /** Server-authored confidence decision; the sorter never derives a threshold. */
  readonly reviewSampleSufficient: boolean;
}

export type AlternateSearchSortInput<
  Candidate extends EligibleAlternateSortCandidate,
> = Readonly<
  | {
      readonly mode: "NEAREST";
      readonly candidates: readonly Candidate[];
      readonly distanceFacts: readonly CraftsmanDistanceFact[];
    }
  | {
      readonly mode: "BEST_RATED";
      readonly candidates: readonly Candidate[];
      readonly ratingFacts: readonly BestRatedSortFact[];
    }
>;

export class AlternateSearchSortIntegrityError extends Error {
  override readonly name = "AlternateSearchSortIntegrityError";
}

/**
 * Reorders, but never expands, an already-eligible candidate pool. Required
 * qualification, service-area and publication gates must run before this
 * boundary. No candidate or ranking fact is copied into a new public shape.
 */
export function sortEligibleSearchCandidates<
  Candidate extends EligibleAlternateSortCandidate,
>(input: AlternateSearchSortInput<Candidate>): readonly Candidate[] {
  if (
    input === null ||
    typeof input !== "object" ||
    !ALTERNATE_SEARCH_SORT_MODES.some((mode) => mode === input.mode)
  ) {
    throw integrity("mode");
  }
  assertCandidates(input.candidates);
  return input.mode === "NEAREST"
    ? sortNearest(input.candidates, input.distanceFacts)
    : sortBestRated(input.candidates, input.ratingFacts);
}

function sortNearest<Candidate extends EligibleAlternateSortCandidate>(
  candidates: readonly Candidate[],
  facts: readonly CraftsmanDistanceFact[],
): readonly Candidate[] {
  assertArray(facts, "distance fact set");
  const validatedFacts = facts.map(validateDistanceFact);
  const byProfile = exactFactMap(
    candidates,
    validatedFacts,
    ({ craftsmanProfileId }) => craftsmanProfileId,
  );
  const originalPosition = new Map(
    candidates.map(({ profileId }, index) => [profileId, index] as const),
  );
  return Object.freeze(
    [...candidates].sort((left, right) => {
      const leftDistance = byProfile.get(left.profileId)?.rankingDistanceMeters;
      const rightDistance = byProfile.get(
        right.profileId,
      )?.rankingDistanceMeters;
      const leftPosition = originalPosition.get(left.profileId);
      const rightPosition = originalPosition.get(right.profileId);
      if (
        leftDistance === undefined ||
        rightDistance === undefined ||
        leftPosition === undefined ||
        rightPosition === undefined
      ) {
        throw integrity("distance fact lookup");
      }
      if (leftDistance === null || rightDistance === null) {
        if (leftDistance === null && rightDistance === null) {
          return leftPosition - rightPosition;
        }
        return leftDistance === null ? 1 : -1;
      }
      return (
        leftDistance - rightDistance ||
        codePointCompare(left.profileId, right.profileId)
      );
    }),
  );
}

function sortBestRated<Candidate extends EligibleAlternateSortCandidate>(
  candidates: readonly Candidate[],
  facts: readonly BestRatedSortFact[],
): readonly Candidate[] {
  assertArray(facts, "rating fact set");
  for (const fact of facts) assertRatingFact(fact);
  const byProfile = exactFactMap(
    candidates,
    facts,
    ({ profileId }) => profileId,
  );
  const originalPosition = new Map(
    candidates.map(({ profileId }, index) => [profileId, index] as const),
  );
  return Object.freeze(
    [...candidates].sort((left, right) => {
      const leftFact = byProfile.get(left.profileId);
      const rightFact = byProfile.get(right.profileId);
      const leftPosition = originalPosition.get(left.profileId);
      const rightPosition = originalPosition.get(right.profileId);
      if (
        leftFact === undefined ||
        rightFact === undefined ||
        leftPosition === undefined ||
        rightPosition === undefined
      ) {
        throw integrity("rating fact lookup");
      }
      if (
        leftFact.reviewSampleSufficient !== rightFact.reviewSampleSufficient
      ) {
        return leftFact.reviewSampleSufficient ? -1 : 1;
      }
      if (leftFact.reviewSampleSufficient) {
        if (
          leftFact.customerScore === null ||
          rightFact.customerScore === null
        ) {
          throw integrity("sufficient rating lookup");
        }
        const scoreOrder = compareNumberDescending(
          leftFact.customerScore,
          rightFact.customerScore,
        );
        if (scoreOrder !== 0) return scoreOrder;
        const countOrder = compareNumberDescending(
          leftFact.reviewCount,
          rightFact.reviewCount,
        );
        if (countOrder !== 0) return countOrder;
      }
      return (
        leftPosition - rightPosition ||
        codePointCompare(left.profileId, right.profileId)
      );
    }),
  );
}

function assertCandidates(
  candidates: readonly EligibleAlternateSortCandidate[],
): void {
  assertArray(candidates, "candidate set");
  const ids = candidates.map((candidate) =>
    candidate !== null && typeof candidate === "object"
      ? candidate.profileId
      : null,
  );
  if (
    ids.some((profileId) => !isUuid(profileId)) ||
    new Set(ids).size !== ids.length
  ) {
    throw integrity("candidate identity");
  }
}

function assertArray(
  value: unknown,
  field: string,
): asserts value is readonly unknown[] {
  if (!Array.isArray(value)) throw integrity(field);
}

function assertRatingFact(fact: BestRatedSortFact): void {
  if (
    fact === null ||
    typeof fact !== "object" ||
    !isUuid(fact.profileId) ||
    typeof fact.reviewSampleSufficient !== "boolean" ||
    !Number.isSafeInteger(fact.reviewCount) ||
    fact.reviewCount < 0
  ) {
    throw integrity("rating fact");
  }
  if (fact.reviewSampleSufficient) {
    if (
      fact.reviewCount < 1 ||
      typeof fact.customerScore !== "number" ||
      !Number.isFinite(fact.customerScore) ||
      fact.customerScore < 0 ||
      fact.customerScore > 5
    ) {
      throw integrity("sufficient rating fact");
    }
  } else if (fact.customerScore !== null) {
    throw integrity("insufficient rating fact");
  }
}

function validateDistanceFact(fact: unknown): CraftsmanDistanceFact {
  if (fact === null || typeof fact !== "object") {
    throw integrity("distance fact");
  }
  try {
    const values = fact as Readonly<Record<string, unknown>>;
    return createCraftsmanDistanceFact({
      approximateDistanceKm: values["approximateDistanceKm"] as number | null,
      craftsmanProfileId: values["craftsmanProfileId"] as string,
      rankingDistanceMeters: values["rankingDistanceMeters"] as number | null,
    });
  } catch {
    throw integrity("distance fact");
  }
}

function exactFactMap<Candidate extends EligibleAlternateSortCandidate, Fact>(
  candidates: readonly Candidate[],
  facts: readonly Fact[],
  profileId: (fact: Fact) => string,
): ReadonlyMap<string, Fact> {
  const mapped = new Map<string, Fact>();
  for (const fact of facts) {
    const id = profileId(fact);
    if (mapped.has(id)) throw integrity("duplicate fact");
    mapped.set(id, fact);
  }
  if (
    mapped.size !== candidates.length ||
    candidates.some(({ profileId: id }) => !mapped.has(id))
  ) {
    throw integrity("fact set");
  }
  return mapped;
}

function compareNumberDescending(left: number, right: number): number {
  return left === right ? 0 : left > right ? -1 : 1;
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}

function codePointCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function integrity(field: string): AlternateSearchSortIntegrityError {
  return new AlternateSearchSortIntegrityError(
    `Invalid alternate search sort ${field}.`,
  );
}
