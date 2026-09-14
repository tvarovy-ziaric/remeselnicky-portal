import { describe, expect, it } from "vitest";

import {
  assertListOwnedFeaturedProjectsInput,
  assertPinFeaturedProjectInput,
  assertReorderFeaturedProjectsInput,
  assertUnpinFeaturedProjectInput,
  FEATURED_PROJECT_AVAILABILITY,
  FeaturedProjectValidationError,
  MAX_FEATURED_PROJECTS,
  type PinFeaturedProjectInput,
} from "../src/featured-projects.js";

const actorUserId = "77000000-0000-4000-8000-000000000001";
const craftsmanProfileId = "77000000-0000-4000-8000-000000000002";
const portfolioProjectId = "77000000-0000-4000-8000-000000000003";
const commandId = "77000000-0000-4000-8000-000000000004";

describe("featured project domain boundary", () => {
  it("locks max three and private availability presentation", () => {
    expect(MAX_FEATURED_PROJECTS).toBe(3);
    expect(FEATURED_PROJECT_AVAILABILITY).toEqual(["AVAILABLE", "UNAVAILABLE"]);
  });

  it("accepts typed owner pin and unpin commands", () => {
    expect(() => assertPinFeaturedProjectInput(pinInput())).not.toThrow();
    expect(() => assertUnpinFeaturedProjectInput(pinInput())).not.toThrow();
  });

  it("rejects malformed IDs and revisions", () => {
    const invalid: readonly PinFeaturedProjectInput[] = [
      pinInput({ actorUserId: "bad" as never }),
      pinInput({ commandId: "bad" }),
      pinInput({ craftsmanProfileId: "bad" as never }),
      pinInput({ portfolioProjectId: "bad" as never }),
      pinInput({ expectedRevision: -1 }),
      pinInput({ expectedRevision: 1.5 }),
    ];
    for (const input of invalid) {
      expect(() => assertPinFeaturedProjectInput(input)).toThrow(
        FeaturedProjectValidationError,
      );
    }
  });

  it("accepts only a unique ordered set of at most three", () => {
    expect(() =>
      assertReorderFeaturedProjectsInput({
        ...context(),
        orderedPortfolioProjectIds: [],
      }),
    ).not.toThrow();
    expect(() =>
      assertReorderFeaturedProjectsInput({
        ...context(),
        orderedPortfolioProjectIds: [
          portfolioProjectId,
          portfolioProjectId,
        ] as never,
      }),
    ).toThrow(FeaturedProjectValidationError);
    expect(() =>
      assertReorderFeaturedProjectsInput({
        ...context(),
        orderedPortfolioProjectIds: Array.from(
          { length: MAX_FEATURED_PROJECTS + 1 },
          (_, index) =>
            `77000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
        ) as never,
      }),
    ).toThrow(FeaturedProjectValidationError);
  });

  it("validates private owner profile identifiers", () => {
    expect(() => assertListOwnedFeaturedProjectsInput(context())).not.toThrow();
    expect(() =>
      assertListOwnedFeaturedProjectsInput({
        ...context(),
        craftsmanProfileId: "bad" as never,
      }),
    ).toThrow(FeaturedProjectValidationError);
  });
});

function context() {
  return {
    actorUserId: actorUserId as never,
    commandId,
    craftsmanProfileId: craftsmanProfileId as never,
    expectedRevision: 0,
  };
}

function pinInput(
  changes: Partial<PinFeaturedProjectInput> = {},
): PinFeaturedProjectInput {
  return {
    ...context(),
    portfolioProjectId: portfolioProjectId as never,
    ...changes,
  };
}
