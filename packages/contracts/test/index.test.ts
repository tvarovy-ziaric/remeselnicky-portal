import { describe, expect, it } from "vitest";

import {
  ADMIN_AUTH_API_PATHS,
  AUTH_API_PATHS,
  AUTH_INPUT_LIMITS,
  platformContract,
  type ApiResourceReference,
  type PlatformContract,
} from "../src/index.js";

describe("@portal/contracts", () => {
  it("exports a stable runtime and transport contract", () => {
    const resource: ApiResourceReference = { id: "entity-1" };
    const contract: PlatformContract = platformContract;

    expect(resource).toEqual({ id: "entity-1" });
    expect(contract.apiVersion).toBe("v1");
  });

  it("exports bounded authentication transport contracts", () => {
    expect(AUTH_API_PATHS.session).toBe("/v1/auth/session");
    expect(AUTH_INPUT_LIMITS).toEqual({
      emailMaximumLength: 254,
      passwordMaximumLength: 128,
      passwordMinimumLength: 12,
      phoneMaximumLength: 32,
      phoneOtpLength: 6,
      resetTokenMaximumLength: 128,
      verificationTokenMaximumLength: 128,
    });
    expect(AUTH_API_PATHS.emailVerification).toBe(
      "/v1/auth/email-verification",
    );
    expect(AUTH_API_PATHS.phoneVerificationSend).toBe(
      "/v1/auth/phone-verification/send",
    );
  });

  it("keeps privileged MFA routes distinct from ordinary authentication", () => {
    expect(ADMIN_AUTH_API_PATHS).toEqual({
      challenge: "/v1/admin/auth/mfa/challenge",
      session: "/v1/admin/auth/session",
      verify: "/v1/admin/auth/mfa/verify",
    });
  });
});
