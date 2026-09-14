import { createHmac } from "node:crypto";

import type { UserId } from "@portal/domain";
import { describe, expect, it, vi } from "vitest";

import {
  createPhoneOtpCrypto,
  createPhoneVerificationService,
  createSyntheticPhoneVerificationDelivery,
  InvalidPhoneVerificationInputError,
  normalizeAndValidatePhone,
  PhoneVerificationDeliveryUnavailableError,
  type PhoneVerificationPersistence,
} from "./phone-verification.js";

const USER_ID = "0198ddec-56bd-7f4c-8752-1daa51fd9921" as UserId;
const CHALLENGE_ID = "0198ddec-56bd-7f4c-8752-1daa51fd9931";
const PEPPER = "phone-verification-test-pepper-32-bytes-minimum";
const OTP = "038271";
const SALT = "a".repeat(32);

describe("phone-verification primitives", () => {
  it("generates bounded CSPRNG values and salted HMAC digests", () => {
    const crypto = createPhoneOtpCrypto({ pepper: PEPPER });
    const otps = Array.from({ length: 64 }, () => crypto.generateOtp());
    const salts = Array.from({ length: 32 }, () => crypto.generateSalt());

    expect(otps.every((otp) => /^[0-9]{6}$/u.test(otp))).toBe(true);
    expect(new Set(salts)).toHaveLength(salts.length);
    expect(salts.every((salt) => /^[0-9a-f]{32}$/u.test(salt))).toBe(true);
    expect(crypto.digest({ otp: OTP, salt: SALT })).toBe(
      createHmac("sha256", PEPPER)
        .update("portal-phone-verification-v1\0", "utf8")
        .update(SALT, "utf8")
        .update("\0", "utf8")
        .update(OTP, "utf8")
        .digest("hex"),
    );
    expect(crypto.digest({ otp: OTP, salt: SALT })).not.toContain(OTP);
    expect(crypto.digest({ otp: OTP, salt: "b".repeat(32) })).not.toBe(
      crypto.digest({ otp: OTP, salt: SALT }),
    );
  });

  it("passes plaintext OTP only to delivery and digest only to persistence", async () => {
    const issued: Parameters<PhoneVerificationPersistence["issue"]>[0][] = [];
    const deliveries: { normalizedPhone: string; otp: string }[] = [];
    const crypto = createPhoneOtpCrypto({ pepper: PEPPER });
    const persistence = persistenceStub({
      issue(input) {
        issued.push(input);
        return Promise.resolve("ISSUED");
      },
    });
    const service = createPhoneVerificationService({
      clock: () => new Date("2026-09-14T12:00:00.000Z"),
      crypto: {
        ...crypto,
        generateOtp: () => OTP,
        generateSalt: () => SALT,
      },
      delivery: {
        deliver(input) {
          deliveries.push(input);
          return Promise.resolve();
        },
      },
      maxAttempts: 5,
      persistence,
      ttlMs: 600_000,
      uuid: () => CHALLENGE_ID,
    });

    await expect(
      service.request({
        normalizedPhone: "+421 901 234 567",
        userId: USER_ID,
      }),
    ).resolves.toEqual({ accepted: true, challengeId: CHALLENGE_ID });
    expect(deliveries).toEqual([
      { normalizedPhone: "+421901234567", otp: OTP },
    ]);
    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatchObject({
      challengeId: CHALLENGE_ID,
      maxAttempts: 5,
      normalizedPhone: "+421901234567",
      otpSalt: SALT,
      userId: USER_ID,
    });
    expect(issued[0]?.otpDigest).not.toContain(OTP);
    expect(JSON.stringify(issued)).not.toContain(OTP);
  });

  it("invalidates an issued challenge and returns a sanitized delivery error", async () => {
    const invalidate = vi.fn(() => Promise.resolve());
    const service = createPhoneVerificationService({
      crypto: {
        digest: () => "b".repeat(64),
        generateOtp: () => OTP,
        generateSalt: () => SALT,
      },
      delivery: {
        deliver: () => Promise.reject(new Error(`provider exposed ${OTP}`)),
      },
      maxAttempts: 5,
      persistence: persistenceStub({ invalidate }),
      ttlMs: 600_000,
      uuid: () => CHALLENGE_ID,
    });

    await expect(
      service.request({ normalizedPhone: "+421901234567", userId: USER_ID }),
    ).rejects.toEqual(new PhoneVerificationDeliveryUnavailableError());
    expect(invalidate).toHaveBeenCalledWith({
      challengeId: CHALLENGE_ID,
      userId: USER_ID,
    });
    try {
      await service.request({
        normalizedPhone: "+421901234567",
        userId: USER_ID,
      });
    } catch (error: unknown) {
      expect(String(error)).not.toContain(OTP);
      expect(String(error)).not.toContain("provider exposed");
    }
  });

  it("uses challenge salt for verification without sending raw OTP to persistence", async () => {
    const crypto = createPhoneOtpCrypto({ pepper: PEPPER });
    const verifyAttempt = vi.fn(() => Promise.resolve("VERIFIED" as const));
    const service = createPhoneVerificationService({
      crypto,
      delivery: { deliver: () => Promise.resolve() },
      maxAttempts: 5,
      persistence: persistenceStub({
        findDigestMaterial: () => Promise.resolve({ otpSalt: SALT }),
        verifyAttempt,
      }),
      ttlMs: 600_000,
    });

    await expect(
      service.verify({
        challengeId: CHALLENGE_ID,
        otp: OTP,
        userId: USER_ID,
      }),
    ).resolves.toBe("VERIFIED");
    expect(verifyAttempt).toHaveBeenCalledWith({
      challengeId: CHALLENGE_ID,
      otpDigest: crypto.digest({ otp: OTP, salt: SALT }),
      userId: USER_ID,
    });
    expect(JSON.stringify(verifyAttempt.mock.calls)).not.toContain(OTP);
  });

  it("normalizes bounded E.164 input and rejects ambiguous local numbers", () => {
    expect(normalizeAndValidatePhone("00421 (901) 234-567")).toBe(
      "+421901234567",
    );
    expect(() => normalizeAndValidatePhone("0901 234 567")).toThrow(
      InvalidPhoneVerificationInputError,
    );
    expect(() => createPhoneOtpCrypto({ pepper: "too-short" })).toThrow(
      /at least 32 bytes/u,
    );
  });

  it("exposes an explicit synthetic adapter without logging or production mode", async () => {
    const sink = vi.fn(() => Promise.resolve());
    const delivery = createSyntheticPhoneVerificationDelivery({
      environment: "test",
      sink,
    });
    await delivery.deliver({ normalizedPhone: "+421901234567", otp: OTP });
    expect(sink).toHaveBeenCalledOnce();
    expect(() =>
      createSyntheticPhoneVerificationDelivery({
        environment: "production",
        sink,
      } as unknown as Parameters<
        typeof createSyntheticPhoneVerificationDelivery
      >[0]),
    ).toThrow(/forbidden outside non-production/u);
  });
});

function persistenceStub(
  overrides: Partial<PhoneVerificationPersistence> = {},
): PhoneVerificationPersistence {
  return {
    findDigestMaterial: () => Promise.resolve(null),
    invalidate: () => Promise.resolve(),
    issue: () => Promise.resolve("ISSUED"),
    verifyAttempt: () => Promise.resolve("INVALID"),
    ...overrides,
  };
}
