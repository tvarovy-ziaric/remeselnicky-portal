import { createHmac, randomBytes, randomInt, randomUUID } from "node:crypto";

import {
  AUTH_INPUT_LIMITS,
  type AuthPhoneVerificationSendResponse,
} from "@portal/contracts";
import type { PhoneVerificationRepository } from "@portal/db";
import type { UserId } from "@portal/domain";

export interface PhoneVerificationDeliveryPort {
  deliver(input: {
    readonly normalizedPhone: string;
    readonly otp: string;
  }): Promise<void>;
}

export interface PhoneVerificationPersistence {
  findDigestMaterial(input: {
    readonly challengeId: string;
    readonly userId: UserId;
  }): Promise<{ readonly otpSalt: string } | null>;
  invalidate(input: {
    readonly challengeId: string;
    readonly userId: UserId;
  }): Promise<void>;
  issue(input: {
    readonly challengeId: string;
    readonly expiresAt: Date;
    readonly maxAttempts: number;
    readonly normalizedPhone: string;
    readonly otpDigest: string;
    readonly otpSalt: string;
    readonly userId: UserId;
  }): Promise<"ISSUED" | "NOT_ELIGIBLE">;
  verifyAttempt(input: {
    readonly challengeId: string;
    readonly otpDigest: string;
    readonly userId: UserId;
  }): Promise<"INVALID" | "VERIFIED">;
}

export interface PhoneOtpCrypto {
  digest(input: { readonly otp: string; readonly salt: string }): string;
  generateOtp(): string;
  generateSalt(): string;
}

export interface PhoneVerificationService {
  request(input: {
    readonly normalizedPhone: string;
    readonly userId: UserId;
  }): Promise<AuthPhoneVerificationSendResponse>;
  verify(input: {
    readonly challengeId: string;
    readonly otp: string;
    readonly userId: UserId;
  }): Promise<"INVALID" | "VERIFIED">;
}

export function createPhoneVerificationPersistence(
  repository: PhoneVerificationRepository,
): PhoneVerificationPersistence {
  return Object.freeze({
    findDigestMaterial: (input: {
      readonly challengeId: string;
      readonly userId: UserId;
    }) => repository.findDigestMaterial(input),
    invalidate: (input: {
      readonly challengeId: string;
      readonly userId: UserId;
    }) => repository.invalidate(input),
    async issue(input: Parameters<PhoneVerificationPersistence["issue"]>[0]) {
      const result = await repository.issue(input);
      return result.status;
    },
    async verifyAttempt(
      input: Parameters<PhoneVerificationPersistence["verifyAttempt"]>[0],
    ) {
      const result = await repository.verifyAttempt(input);
      return result.status;
    },
  });
}

export function createPhoneVerificationService(input: {
  readonly clock?: () => Date;
  readonly crypto: PhoneOtpCrypto;
  readonly delivery: PhoneVerificationDeliveryPort;
  readonly maxAttempts: number;
  readonly persistence: PhoneVerificationPersistence;
  readonly ttlMs: number;
  readonly uuid?: () => string;
}): PhoneVerificationService {
  assertBoundedInteger(input.maxAttempts, 1, 20, "OTP max attempts");
  assertBoundedInteger(input.ttlMs, 1_000, 86_400_000, "OTP TTL");
  const clock = input.clock ?? (() => new Date());
  const uuid = input.uuid ?? randomUUID;

  return Object.freeze({
    async request(request: {
      readonly normalizedPhone: string;
      readonly userId: UserId;
    }) {
      const normalizedPhone = normalizeAndValidatePhone(
        request.normalizedPhone,
      );
      const challengeId = uuid();
      assertUuid(challengeId);
      const otp = input.crypto.generateOtp();
      const otpSalt = input.crypto.generateSalt();
      const now = clock();
      const issued = await input.persistence.issue({
        challengeId,
        expiresAt: new Date(now.valueOf() + input.ttlMs),
        maxAttempts: input.maxAttempts,
        normalizedPhone,
        otpDigest: input.crypto.digest({ otp, salt: otpSalt }),
        otpSalt,
        userId: request.userId,
      });

      if (issued === "NOT_ELIGIBLE") {
        return Object.freeze({ accepted: true, challengeId });
      }

      try {
        await input.delivery.deliver({ normalizedPhone, otp });
      } catch {
        await input.persistence.invalidate({
          challengeId,
          userId: request.userId,
        });
        throw new PhoneVerificationDeliveryUnavailableError();
      }

      return Object.freeze({ accepted: true, challengeId });
    },

    async verify(request: {
      readonly challengeId: string;
      readonly otp: string;
      readonly userId: UserId;
    }) {
      assertUuid(request.challengeId);
      validateOtp(request.otp);
      const material = await input.persistence.findDigestMaterial({
        challengeId: request.challengeId,
        userId: request.userId,
      });
      if (material === null) return "INVALID";

      return input.persistence.verifyAttempt({
        challengeId: request.challengeId,
        otpDigest: input.crypto.digest({
          otp: request.otp,
          salt: material.otpSalt,
        }),
        userId: request.userId,
      });
    },
  });
}

export function createPhoneOtpCrypto(input: {
  readonly pepper: string;
}): PhoneOtpCrypto {
  if (Buffer.byteLength(input.pepper, "utf8") < 32) {
    throw new RangeError("Phone OTP pepper must contain at least 32 bytes.");
  }

  return Object.freeze({
    digest({ otp, salt }: { readonly otp: string; readonly salt: string }) {
      if (!/^[0-9a-f]{32}$/u.test(salt)) {
        throw new TypeError("Phone OTP salt must be 128-bit hexadecimal.");
      }
      validateOtp(otp);
      return createHmac("sha256", input.pepper)
        .update("portal-phone-verification-v1\0", "utf8")
        .update(salt, "utf8")
        .update("\0", "utf8")
        .update(otp, "utf8")
        .digest("hex");
    },
    generateOtp() {
      return randomInt(0, 1_000_000).toString().padStart(6, "0");
    },
    generateSalt() {
      return randomBytes(16).toString("hex");
    },
  });
}

/**
 * Explicit non-production adapter for deterministic development and staging
 * harnesses. The sink receives the secret directly and must never log it.
 */
export function createSyntheticPhoneVerificationDelivery(input: {
  readonly environment: "development" | "staging" | "test";
  readonly sink: (delivery: {
    readonly normalizedPhone: string;
    readonly otp: string;
  }) => Promise<void>;
}): PhoneVerificationDeliveryPort {
  if (
    input.environment !== "development" &&
    input.environment !== "staging" &&
    input.environment !== "test"
  ) {
    throw new TypeError(
      "Synthetic phone delivery is forbidden outside non-production environments.",
    );
  }
  return Object.freeze({ deliver: input.sink });
}

export function normalizeAndValidatePhone(phone: string): string {
  const normalized = phone
    .trim()
    .replace(/[\s().-]/gu, "")
    .replace(/^00/u, "+");
  if (
    normalized.length > AUTH_INPUT_LIMITS.phoneMaximumLength ||
    !/^\+[1-9][0-9]{7,14}$/u.test(normalized)
  ) {
    throw new InvalidPhoneVerificationInputError();
  }
  return normalized;
}

export class InvalidPhoneVerificationInputError extends Error {
  public constructor() {
    super("Invalid phone-verification input");
    this.name = "InvalidPhoneVerificationInputError";
  }
}

export class PhoneVerificationDeliveryUnavailableError extends Error {
  public constructor() {
    super("Phone-verification delivery is unavailable");
    this.name = "PhoneVerificationDeliveryUnavailableError";
  }
}

function validateOtp(otp: string): void {
  if (!/^[0-9]{6}$/u.test(otp)) {
    throw new InvalidPhoneVerificationInputError();
  }
}

function assertUuid(value: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    throw new InvalidPhoneVerificationInputError();
  }
}

function assertBoundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be between ${minimum} and ${maximum}.`);
  }
}
