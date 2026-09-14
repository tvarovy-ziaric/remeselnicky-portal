import { describe, expect, it } from "vitest";

import {
  assertPreparedCredentialQualificationPolicyRelease,
  prepareCredentialQualificationPolicyRelease,
} from "../src/credential-qualification-policy.js";

const seed = Object.freeze({
  entries: Object.freeze([
    Object.freeze({
      credentialTypeCode: "test.optional-card",
      professionCode: "PROF:ELECTRICIAN",
      requirement: "OPTIONAL" as const,
    }),
    Object.freeze({
      credentialTypeCode: "test.required-license",
      professionCode: "PROF:ELECTRICIAN",
      requirement: "REQUIRED" as const,
    }),
  ]),
  releaseId: "76000000-0000-4000-8000-000000000010",
  reviewReference: "legal-review:R2-006-fixture",
  supersedesReleaseId: null,
  taxonomyReleaseId: "76000000-0000-4000-8000-000000000011",
  version: 1,
});

describe("credential qualification policy release", () => {
  it("canonicalizes and checksums the full ordered release", () => {
    const first = prepareCredentialQualificationPolicyRelease(seed);
    const second = prepareCredentialQualificationPolicyRelease({
      ...seed,
      entries: [...seed.entries].reverse(),
    });
    expect(first).toEqual(second);
    expect(first.checksumSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(first.contentClass).toBe("CANONICAL");
    expect(first.reviewState).toBe("HUMAN_REVIEW_APPROVED");
    expect(() =>
      assertPreparedCredentialQualificationPolicyRelease(first),
    ).not.toThrow();
  });

  it("rejects a forged checksum or noncanonical ordering", () => {
    const prepared = prepareCredentialQualificationPolicyRelease(seed);
    expect(() =>
      assertPreparedCredentialQualificationPolicyRelease({
        ...prepared,
        checksumSha256: "0".repeat(64),
      }),
    ).toThrow(/checksum/u);
    expect(() =>
      assertPreparedCredentialQualificationPolicyRelease({
        ...prepared,
        entries: [...prepared.entries].reverse(),
      }),
    ).toThrow(/ordering/u);
  });

  it.each([
    { ...seed, entries: [] },
    { ...seed, reviewReference: "short" },
    { ...seed, version: 2 },
    {
      ...seed,
      entries: [seed.entries[0]!, seed.entries[0]!],
    },
    {
      ...seed,
      entries: [{ ...seed.entries[0]!, professionCode: "not-canonical" }],
    },
  ])("rejects malformed or incoherent full releases", (invalid) => {
    expect(() => prepareCredentialQualificationPolicyRelease(invalid)).toThrow(
      /policy/u,
    );
  });
});
