import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createAlphaRegistrationAdmission,
  createAlphaRegistrationIntakeOperations,
} from "./db-adapter.js";

const key = "d".repeat(64);
const registration = {
  adultAttested: true as const,
  normalizedEmail: "invited@example.invalid",
  passwordHash: "opaque-password-hash",
};

describe("Alpha invitation registration admission", () => {
  it("passes only a keyed email digest into the atomic repository", async () => {
    const user = {
      activeModerationScopes: [],
      accountState: "ACTIVE" as const,
      adultAttestedAt: new Date("2026-09-28T08:00:00.000Z"),
      emailVerifiedAt: null,
      id: "0198ddec-56bd-7f4c-8752-1daa51fd9921",
      phoneVerifiedAt: null,
    };
    const registerInvitedUser = vi.fn().mockResolvedValue({
      invitationId: "0198ddec-56bd-7f4c-8752-1daa51fd9922",
      status: "CREATED" as const,
      user,
    });
    const admission = createAlphaRegistrationAdmission(
      { registerInvitedUser },
      key,
    );

    await expect(admission.register(registration)).resolves.toMatchObject({
      status: "CREATED",
      user: { id: user.id },
    });
    expect(registerInvitedUser).toHaveBeenCalledWith({
      ...registration,
      emailHmacDigest: createHmac("sha256", key)
        .update(
          `portal-alpha-registration-invitation-v1\0${registration.normalizedEmail}`,
          "utf8",
        )
        .digest("hex"),
    });
    expect(JSON.stringify(registerInvitedUser.mock.calls)).not.toContain(key);
  });

  it("keeps duplicate and unavailable admission externally uniform", async () => {
    for (const status of ["DUPLICATE", "NOT_AVAILABLE"] as const) {
      const admission = createAlphaRegistrationAdmission(
        {
          registerInvitedUser: () => Promise.resolve({ status }),
        },
        key,
      );
      await expect(admission.register(registration)).resolves.toEqual({
        status,
      });
    }
  });

  it("rejects malformed invitation HMAC configuration", () => {
    expect(() =>
      createAlphaRegistrationAdmission(
        { registerInvitedUser: vi.fn() },
        "not-a-secret",
      ),
    ).toThrow("Alpha registration intake configuration is invalid.");
  });

  it("keeps the HMAC key and normalized email out of invitation persistence", async () => {
    const issue = vi.fn().mockResolvedValue({
      expiresAt: new Date("2026-10-05T10:00:00.000Z"),
      invitationId: "0198ddec-56bd-7f4c-8752-1daa51fd9923",
      status: "APPLIED",
    });
    const operations = createAlphaRegistrationIntakeOperations(
      {
        issue,
        readStatus: vi.fn(),
        revoke: vi.fn(),
        setState: vi.fn(),
      },
      key,
    );
    const input = {
      actorUserId: "0198ddec-56bd-7f4c-8752-1daa51fd9924",
      cohortCode: "ALPHA_01",
      commandId: "0198ddec-56bd-7f4c-8752-1daa51fd9925",
      expiresAt: new Date("2026-10-05T10:00:00.000Z"),
      normalizedEmail: registration.normalizedEmail,
    };
    await operations.issue(input);
    expect(issue).toHaveBeenCalledWith({
      actorUserId: input.actorUserId,
      cohortCode: input.cohortCode,
      commandId: input.commandId,
      emailHmacDigest: createHmac("sha256", key)
        .update(
          `portal-alpha-registration-invitation-v1\0${input.normalizedEmail}`,
          "utf8",
        )
        .digest("hex"),
      expiresAt: input.expiresAt,
    });
    expect(JSON.stringify(issue.mock.calls)).not.toContain(key);
    expect(JSON.stringify(issue.mock.calls)).not.toContain(
      registration.normalizedEmail,
    );
  });
});
