import { describe, expect, it } from "vitest";

import {
  parsePublicSearchCardQuery,
  PUBLIC_SEARCH_CARD_MAX_LIMIT,
  PUBLIC_SEARCH_CARD_MAX_SKILLS,
} from "../src/index.js";

describe("R2 search privacy and resource bounds", () => {
  it.each([
    "candidates",
    "coordinates",
    "exactAddress",
    "ownerUserId",
    "rankingDistanceMeters",
    "availabilityBlocks",
    "credentialDocumentIds",
    "paidBoost",
    "founderBoost",
    "completenessBoost",
  ])("rejects the client-authored fact field %s", (field) => {
    expect(
      parsePublicSearchCardQuery({
        [field]: "client-authored",
        professionCode: "PROF:TILER",
      }),
    ).toBeNull();
  });

  it("enforces explicit page and skill-cardinality bounds", () => {
    const maximumSkills = Array.from(
      { length: PUBLIC_SEARCH_CARD_MAX_SKILLS },
      (_, index) => `SKILL:SAFE_${String(index).padStart(2, "0")}`,
    );
    expect(
      parsePublicSearchCardQuery({
        limit: PUBLIC_SEARCH_CARD_MAX_LIMIT,
        professionCode: "PROF:TILER",
        skillCodes: maximumSkills,
      }),
    ).toMatchObject({
      limit: PUBLIC_SEARCH_CARD_MAX_LIMIT,
      skillCodes: maximumSkills,
    });
    expect(
      parsePublicSearchCardQuery({
        limit: PUBLIC_SEARCH_CARD_MAX_LIMIT + 1,
        professionCode: "PROF:TILER",
      }),
    ).toBeNull();
    expect(
      parsePublicSearchCardQuery({
        professionCode: "PROF:TILER",
        skillCodes: [...maximumSkills, "SKILL:ONE_TOO_MANY"],
      }),
    ).toBeNull();
    expect(
      parsePublicSearchCardQuery({
        professionCode: "PROF:TILER",
        skillCodes: ["SKILL:DUPLICATE", "SKILL:DUPLICATE"],
      }),
    ).toBeNull();
  });

  it("accepts only bounded canonical UTC timing and requires timing for its opt-in filter", () => {
    expect(
      parsePublicSearchCardQuery({
        filterIndicativelyAvailable: true,
        professionCode: "PROF:TILER",
      }),
    ).toBeNull();
    expect(
      parsePublicSearchCardQuery({
        endsAt: "2026-09-16T10:00:00.000Z",
        professionCode: "PROF:TILER",
        startsAt: "2026-09-16T11:00:00.000Z",
      }),
    ).toBeNull();
    expect(
      parsePublicSearchCardQuery({
        endsAt: "2026-09-16T12:00:00+00:00",
        professionCode: "PROF:TILER",
        startsAt: "2026-09-16T10:00:00+00:00",
      }),
    ).toBeNull();
    expect(
      parsePublicSearchCardQuery({
        endsAt: "2026-09-16T12:00:00.000Z",
        filterIndicativelyAvailable: true,
        professionCode: "PROF:TILER",
        startsAt: "2026-09-16T10:00:00.000Z",
      }),
    ).toMatchObject({ filterIndicativelyAvailable: true });
  });
});
