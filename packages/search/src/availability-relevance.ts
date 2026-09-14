import {
  CRAFTSMAN_AVAILABILITY_MATCH_KINDS,
  type CraftsmanAvailabilityMatchKind,
} from "@portal/domain";

export const AVAILABILITY_SEARCH_MATCH_KINDS =
  CRAFTSMAN_AVAILABILITY_MATCH_KINDS;

export type AvailabilitySearchMatchKind = CraftsmanAvailabilityMatchKind;

export interface AvailabilitySearchFact {
  readonly craftsmanProfileId: string;
  readonly indicativelyAvailable: boolean;
  readonly matchKind: AvailabilitySearchMatchKind;
}

export interface AvailabilitySearchCandidate {
  readonly profileId: string;
}

export interface AvailabilitySearchRelevance {
  readonly matchKind: AvailabilitySearchMatchKind;
  /** A categorical hook only. R2-009 owns cross-signal ranking weights. */
  readonly relevance: "NEUTRAL" | "SOFT_POSITIVE";
}

export interface AvailabilityComposedCandidate<
  Candidate extends AvailabilitySearchCandidate,
> {
  readonly candidate: Candidate;
  readonly availability: AvailabilitySearchRelevance;
}

export class AvailabilitySearchIntegrityError extends Error {
  override readonly name = "AvailabilitySearchIntegrityError";
}

/**
 * Composes categorical server facts without exposing the underlying periods.
 * Ordinary search preserves every input candidate and its order. The opt-in
 * filter accepts only an unambiguous AVAILABLE overlap; MIXED has no inferred
 * precedence and remains neutral.
 */
export function composeAvailabilityRelevance<
  Candidate extends AvailabilitySearchCandidate,
>(
  candidates: readonly Candidate[],
  facts: readonly AvailabilitySearchFact[],
  filterIndicativelyAvailable: boolean,
): readonly AvailabilityComposedCandidate<Candidate>[] {
  if (typeof filterIndicativelyAvailable !== "boolean") {
    throw integrity("filter");
  }
  const factsByProfile = new Map<string, AvailabilitySearchFact>();
  for (const fact of facts) {
    assertFact(fact);
    if (factsByProfile.has(fact.craftsmanProfileId)) {
      throw integrity("duplicate fact");
    }
    factsByProfile.set(fact.craftsmanProfileId, fact);
  }

  const seenCandidates = new Set<string>();
  const composed: AvailabilityComposedCandidate<Candidate>[] = [];
  for (const candidate of candidates) {
    if (
      !isUuid(candidate.profileId) ||
      seenCandidates.has(candidate.profileId)
    ) {
      throw integrity("candidate identity");
    }
    seenCandidates.add(candidate.profileId);
    const fact = factsByProfile.get(candidate.profileId);
    if (fact === undefined) throw integrity("missing fact");
    if (filterIndicativelyAvailable && !fact.indicativelyAvailable) continue;
    composed.push(
      Object.freeze({
        availability: Object.freeze({
          matchKind: fact.matchKind,
          relevance: fact.indicativelyAvailable
            ? ("SOFT_POSITIVE" as const)
            : ("NEUTRAL" as const),
        }),
        candidate,
      }),
    );
  }
  return Object.freeze(composed);
}

function assertFact(fact: AvailabilitySearchFact): void {
  if (
    fact === null ||
    typeof fact !== "object" ||
    !isUuid(fact.craftsmanProfileId) ||
    !AVAILABILITY_SEARCH_MATCH_KINDS.some(
      (candidate) => candidate === fact.matchKind,
    ) ||
    typeof fact.indicativelyAvailable !== "boolean" ||
    fact.indicativelyAvailable !== (fact.matchKind === "AVAILABLE_OVERLAP")
  ) {
    throw integrity("fact");
  }
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}

function integrity(field: string): AvailabilitySearchIntegrityError {
  return new AvailabilitySearchIntegrityError(
    `Invalid availability search ${field}.`,
  );
}
