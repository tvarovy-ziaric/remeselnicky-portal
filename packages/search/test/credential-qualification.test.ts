import { describe, expect, it, vi } from "vitest";

import {
  CredentialQualificationValidationError,
  createCredentialQualificationGate,
  serializeCredentialQualification,
  type CredentialQualificationPersistence,
  type CredentialQualificationRow,
} from "../src/credential-qualification.js";

const input = Object.freeze({
  craftsmanProfileId: "76000000-0000-4000-8000-000000000001",
  credentialTypeCode: "test.electrical-inspection",
  professionCode: "PROF:ELECTRICIAN",
});

describe("credential qualification gate", () => {
  it.each([
    [
      "required approved",
      row("QUALIFIED", "REQUIRED", true, "REQUIRED_CREDENTIAL_APPROVED"),
      true,
    ],
    [
      "required missing",
      row("NOT_QUALIFIED", "REQUIRED", false, "REQUIRED_CREDENTIAL_MISSING"),
      false,
    ],
    [
      "optional approved",
      row("QUALIFIED", "OPTIONAL", true, "OPTIONAL_CREDENTIAL_APPROVED"),
      true,
    ],
    [
      "optional missing",
      row("QUALIFIED", "OPTIONAL", false, "OPTIONAL_CREDENTIAL_NOT_APPROVED"),
      true,
    ],
  ] as const)(
    "serializes %s deterministically",
    async (_label, value, eligible) => {
      const persistence = fakePersistence(value);
      const result =
        await createCredentialQualificationGate(persistence).evaluate(input);
      expect(result).toEqual({
        currentApproved: value.currentApproved,
        eligible,
        reasonCode: value.reasonCode,
        requirement: value.requirement,
        status: "OK",
      });
      expect(persistence.evaluateMock).toHaveBeenCalledWith(input);
    },
  );

  it.each([
    null,
    row("QUALIFIED", "REQUIRED", false, "REQUIRED_CREDENTIAL_MISSING"),
    row("NOT_QUALIFIED", "OPTIONAL", false, "OPTIONAL_CREDENTIAL_NOT_APPROVED"),
    row("QUALIFIED", "OPTIONAL", true, "REQUIRED_CREDENTIAL_APPROVED"),
    row("QUALIFIED", "UNKNOWN", true, "OPTIONAL_CREDENTIAL_APPROVED"),
  ])("fails closed for missing or corrupt policy data", (value) => {
    expect(serializeCredentialQualification(value)).toEqual({
      eligible: false,
      status: "UNAVAILABLE",
    });
  });

  it.each([
    { ...input, craftsmanProfileId: "not-a-uuid" },
    { ...input, professionCode: "electrician" },
    { ...input, credentialTypeCode: "TEST SECRET" },
  ])("rejects invalid server-derived identity codes", async (invalid) => {
    const persistence = fakePersistence(null);
    await expect(
      createCredentialQualificationGate(persistence).evaluate(invalid),
    ).rejects.toBeInstanceOf(CredentialQualificationValidationError);
    expect(persistence.evaluateMock).not.toHaveBeenCalled();
  });

  it("accepts the governed TEST namespace used by isolated integration taxonomies", async () => {
    const persistence = fakePersistence(null);
    await expect(
      createCredentialQualificationGate(persistence).evaluate({
        ...input,
        professionCode: "TEST:INTEGRATION_PROFESSION",
      }),
    ).resolves.toEqual({ eligible: false, status: "UNAVAILABLE" });
  });

  it("returns only the bounded qualification allowlist", () => {
    const result = serializeCredentialQualification(
      row("QUALIFIED", "REQUIRED", true, "REQUIRED_CREDENTIAL_APPROVED", {
        claimId: "private-claim",
        evidence: ["private-document"],
        mediaAssetId: "private-media",
        reviewReason: "private reason",
        reviewerUserId: "private-admin",
        storageKey: "private/key",
      }),
    );
    expect(Object.keys(result).sort()).toEqual([
      "currentApproved",
      "eligible",
      "reasonCode",
      "requirement",
      "status",
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /claim|evidence|media|review|reason(?!Code)|storage|hash|userId/iu,
    );
  });
});

function row(
  eligibility: unknown,
  requirement: unknown,
  currentApproved: unknown,
  reasonCode: unknown,
  extra: Record<string, unknown> = {},
): CredentialQualificationRow {
  return { currentApproved, eligibility, reasonCode, requirement, ...extra };
}

function fakePersistence(
  value: CredentialQualificationRow | null,
): CredentialQualificationPersistence & {
  readonly evaluateMock: ReturnType<typeof vi.fn>;
} {
  const evaluateMock = vi.fn().mockResolvedValue(value);
  return {
    evaluate: async (candidate) => {
      await evaluateMock(candidate);
      return value;
    },
    evaluateMock,
  };
}
