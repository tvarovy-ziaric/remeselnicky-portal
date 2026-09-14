import { describe, expect, it } from "vitest";

import {
  assertAssignCraftsmanProfessionInput,
  assertChangeDeclaredProficiencyInput,
  assertDeactivateCraftsmanProfessionInput,
  CRAFTSMAN_PROFESSION_STATES,
  CraftsmanProfessionValidationError,
  PROFESSION_PROFICIENCY_LEVELS,
  type AssignCraftsmanProfessionInput,
  type CraftsmanProfessionId,
} from "../src/craftsman-profession.js";
import type { CraftsmanProfileId } from "../src/craftsman-profile.js";
import type { UserId } from "../src/user.js";

const actorUserId = "10000000-0000-4000-8000-000000000001" as UserId;
const craftsmanProfileId =
  "10000000-0000-4000-8000-000000000002" as CraftsmanProfileId;
const craftsmanProfessionId =
  "10000000-0000-4000-8000-000000000003" as CraftsmanProfessionId;

describe("craftsman profession domain", () => {
  it("locks the shared three profession-specific proficiency labels", () => {
    expect(PROFESSION_PROFICIENCY_LEVELS).toEqual([
      "BEGINNER",
      "ADVANCED",
      "MASTER",
    ]);
    expect(CRAFTSMAN_PROFESSION_STATES).toEqual(["ACTIVE", "INACTIVE"]);
  });

  it("accepts a governed profession assignment command", () => {
    expect(() =>
      assertAssignCraftsmanProfessionInput(validAssignment()),
    ).not.toThrow();
  });

  it.each([
    ["professionCode", "electrician"],
    ["declaredLevel", "EXPERT"],
    ["taxonomyReleaseId", "current"],
    ["commandId", "retry-me"],
  ] as const)("rejects invalid %s", (field, value) => {
    expect(() =>
      assertAssignCraftsmanProfessionInput({
        ...validAssignment(),
        [field]: value,
      }),
    ).toThrow(CraftsmanProfessionValidationError);
  });

  it("requires an optimistic declared-level revision", () => {
    expect(() =>
      assertChangeDeclaredProficiencyInput({
        actorUserId,
        commandId: "10000000-0000-4000-8000-000000000004",
        craftsmanProfessionId,
        craftsmanProfileId,
        declaredLevel: "ADVANCED",
        expectedDeclaredLevelRevision: 0,
      }),
    ).toThrow(/expectedDeclaredLevelRevision/u);
  });

  it("validates deactivation without accepting a level payload", () => {
    expect(() =>
      assertDeactivateCraftsmanProfessionInput({
        actorUserId,
        commandId: "10000000-0000-4000-8000-000000000005",
        craftsmanProfessionId,
        craftsmanProfileId,
      }),
    ).not.toThrow();
  });
});

function validAssignment(): AssignCraftsmanProfessionInput {
  return {
    actorUserId,
    commandId: "10000000-0000-4000-8000-000000000004",
    craftsmanProfessionId,
    craftsmanProfileId,
    declaredLevel: "BEGINNER",
    professionCode: "PROF:ELECTRICIAN",
    taxonomyReleaseId: "10000000-0000-4000-8000-000000000006",
  };
}
