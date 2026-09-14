import { describe, expect, it } from "vitest";

import {
  assertCraftsmanExperienceReadInput,
  assertReplaceCraftsmanExperienceInput,
  CraftsmanExperienceValidationError,
  type CraftsmanProfileId,
  type UserId,
} from "../src/index.js";

const actorUserId = "48000000-0000-4000-8000-000000000001" as UserId;
const craftsmanProfileId =
  "48000000-0000-4000-8000-000000000002" as CraftsmanProfileId;
const commandId = "48000000-0000-4000-8000-000000000003";

describe("craftsman experience domain", () => {
  it("stores an optional working-since year rather than maintained years", () => {
    const input = {
      actorUserId,
      commandId,
      craftsmanProfileId,
      expectedRevision: 0,
      workingSinceYear: 2012,
    } as const;

    expect(() => assertReplaceCraftsmanExperienceInput(input)).not.toThrow();
    expect(input).not.toHaveProperty("yearsOfExperience");
    expect(input).not.toHaveProperty("evidenceSupportedLevel");
  });

  it("permits a broad historical year and explicit clearing", () => {
    expect(() =>
      assertReplaceCraftsmanExperienceInput({
        actorUserId,
        commandId,
        craftsmanProfileId,
        expectedRevision: 3,
        workingSinceYear: 1800,
      }),
    ).not.toThrow();
    expect(() =>
      assertReplaceCraftsmanExperienceInput({
        actorUserId,
        commandId,
        craftsmanProfileId,
        expectedRevision: 3,
        workingSinceYear: null,
      }),
    ).not.toThrow();
  });

  it.each([
    { expectedRevision: -1, workingSinceYear: 2012 },
    { expectedRevision: 1.5, workingSinceYear: 2012 },
    { expectedRevision: 0, workingSinceYear: 1799 },
    { expectedRevision: 0, workingSinceYear: 2012.5 },
    { expectedRevision: 0, workingSinceYear: 9999 },
  ])("rejects invalid revision/year input %#", (change) => {
    expect(() =>
      assertReplaceCraftsmanExperienceInput({
        actorUserId,
        commandId,
        craftsmanProfileId,
        ...change,
      }),
    ).toThrow(CraftsmanExperienceValidationError);
  });

  it("validates owner-scoped reads", () => {
    expect(() =>
      assertCraftsmanExperienceReadInput({
        actorUserId,
        craftsmanProfileId,
      }),
    ).not.toThrow();
    expect(() =>
      assertCraftsmanExperienceReadInput({
        actorUserId: "not-a-uuid" as UserId,
        craftsmanProfileId,
      }),
    ).toThrow(CraftsmanExperienceValidationError);
  });
});
