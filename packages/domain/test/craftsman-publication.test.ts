import { describe, expect, it } from "vitest";

import {
  assertPrivilegedProfileCommandInput,
  assertRequireProfileIdentityReviewInput,
  assertSetProfileModerationInput,
  PROFILE_IDENTITY_REVIEW_SYSTEM_REFERENCE,
  PROFILE_MODERATION_STATES,
  PROFILE_OWNER_VISIBILITY_STATES,
  PROFILE_READINESS_REQUIREMENTS,
  PROFILE_REVIEW_STATES,
  type CraftsmanProfileId,
  type PrivilegedProfileCommandInput,
  type UserId,
} from "../src/index.js";

describe("craftsman publication state", () => {
  it("keeps review, owner preference and moderation as independent axes", () => {
    expect(PROFILE_REVIEW_STATES).toEqual([
      "DRAFT",
      "PENDING",
      "APPROVED",
      "REJECTED",
    ]);
    expect(PROFILE_OWNER_VISIBILITY_STATES).toEqual(["PUBLIC", "HIDDEN"]);
    expect(PROFILE_MODERATION_STATES).toEqual([
      "ALLOWED",
      "HIDDEN",
      "RESTRICTED",
    ]);
  });

  it("locks the exact D08 publication minimum without optional profile fields", () => {
    expect(PROFILE_READINESS_REQUIREMENTS).toEqual([
      "VALID_IDENTITY",
      "ABOUT",
      "ACTIVE_PROFESSION_WITH_DECLARED_LEVEL",
      "BASE_MUNICIPALITY",
      "NORMAL_RADIUS",
    ]);
    expect(PROFILE_READINESS_REQUIREMENTS).not.toEqual(
      expect.arrayContaining([
        "PHOTO",
        "LOGO",
        "SKILL",
        "SPECIALIZATION",
        "PRICE",
        "PORTFOLIO",
        "CREDENTIAL",
      ]),
    );
  });

  it("requires MFA session context and stable moderation policy reasons", () => {
    expect(() =>
      assertPrivilegedProfileCommandInput(adminInput()),
    ).not.toThrow();
    expect(() =>
      assertSetProfileModerationInput({
        ...adminInput(),
        moderationState: "HIDDEN",
        policyVersion: "MODERATION.2026-01",
        reasonCategory: "CONTENT_POLICY",
        reasonCode: "PROFILE_POLICY_VIOLATION",
      }),
    ).not.toThrow();
    expect(() =>
      assertPrivilegedProfileCommandInput({
        ...adminInput(),
        actorSessionIdDigest: "not-a-digest",
      }),
    ).toThrow();
  });

  it("keeps identity re-review behind a namespaced trusted system boundary", () => {
    expect(() =>
      assertRequireProfileIdentityReviewInput({
        commandId: "74000000-0000-4000-8000-000000000010",
        craftsmanProfileId: adminInput().craftsmanProfileId,
        expectedRevision: 2,
        reasonCode: "SENSITIVE_IDENTITY_CHANGED",
        ruleReference: "PROFILE.IDENTITY.REVIEW_V1",
      }),
    ).not.toThrow();
    expect(PROFILE_IDENTITY_REVIEW_SYSTEM_REFERENCE).toBe(
      "profile-service:identity-change",
    );
  });
});

function adminInput(): PrivilegedProfileCommandInput {
  return {
    actorSessionIdDigest: "a".repeat(64),
    actorUserId: "74000000-0000-4000-8000-000000000001" as UserId,
    commandId: "74000000-0000-4000-8000-000000000002",
    correlationId: "74000000-0000-4000-8000-000000000003",
    craftsmanProfileId:
      "74000000-0000-4000-8000-000000000004" as CraftsmanProfileId,
    expectedRevision: 1,
    reason: "Profile review decision recorded.",
  };
}
