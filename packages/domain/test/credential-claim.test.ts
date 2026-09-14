import { describe, expect, it } from "vitest";

import {
  CredentialClaimValidationError,
  isApprovedCredentialCurrentlyValid,
  normalizeCreateCredentialClaimInput,
  normalizeCredentialReviewCommand,
  type CraftsmanProfessionId,
  type CraftsmanProfileId,
  type CredentialClaimId,
  type UserId,
} from "../src/index.js";

const actorUserId = "10000000-0000-4000-8000-000000000001" as UserId;
const claimId = "10000000-0000-4000-8000-000000000002" as CredentialClaimId;
const craftsmanProfileId =
  "10000000-0000-4000-8000-000000000003" as CraftsmanProfileId;
const craftsmanProfessionId =
  "10000000-0000-4000-8000-000000000004" as CraftsmanProfessionId;
const commandId = "10000000-0000-4000-8000-000000000005";

describe("credential claim domain", () => {
  it("normalizes an explicit type and nullable expiry", () => {
    expect(
      normalizeCreateCredentialClaimInput({
        actorUserId,
        claimId,
        commandId,
        craftsmanProfileId,
        craftsmanProfessionId,
        credentialTypeCode: "  SK.ELECTRICAL-AUTH  ",
        expiresOn: "2030-06-30",
      }),
    ).toMatchObject({
      credentialTypeCode: "sk.electrical-auth",
      expiresOn: "2030-06-30",
    });
  });

  it.each(["2030-02-30", "30.06.2030", "", "2030-6-1"])(
    "rejects invalid expiry %s",
    (expiresOn) => {
      expect(() =>
        normalizeCreateCredentialClaimInput({
          actorUserId,
          claimId,
          commandId,
          craftsmanProfileId,
          craftsmanProfessionId,
          credentialTypeCode: "sk.electrical",
          expiresOn,
        }),
      ).toThrow(CredentialClaimValidationError);
    },
  );

  it.each([
    "Napíšte na admin@example.sk",
    "Podklady sú na https://example.sk",
    "Volajte +421 900 123 456",
    "Bearer abc.def.secret",
    "Heslo bolo odoslané",
  ])("rejects sensitive moderation reason %s", (reason) => {
    expect(() =>
      normalizeCredentialReviewCommand({
        claimId,
        commandId,
        decision: "REJECT",
        expectedRevision: 1,
        reason,
        reasonCategory: "INSUFFICIENT_EVIDENCE",
      }),
    ).toThrow(CredentialClaimValidationError);
  });

  it("keeps expiry validity separate from the recorded APPROVED state", () => {
    expect(
      isApprovedCredentialCurrentlyValid(
        { expiresOn: "2027-01-01", state: "APPROVED" },
        "2026-12-31",
      ),
    ).toBe(true);
    expect(
      isApprovedCredentialCurrentlyValid(
        { expiresOn: "2027-01-01", state: "APPROVED" },
        "2027-01-02",
      ),
    ).toBe(false);
    expect(
      isApprovedCredentialCurrentlyValid(
        { expiresOn: null, state: "REVOKED" },
        "2026-12-31",
      ),
    ).toBe(false);
  });
});
