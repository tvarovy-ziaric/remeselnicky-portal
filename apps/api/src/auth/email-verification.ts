import { createHash, randomBytes } from "node:crypto";

import { AUTH_INPUT_LIMITS } from "@portal/contracts";
import type { EmailVerificationRepository } from "@portal/db";
import type { UserId } from "@portal/domain";

export interface EmailVerificationPersistence {
  consume(tokenDigest: string): Promise<"INVALID" | "VERIFIED">;
  issue(input: {
    readonly expiresAt: Date;
    readonly tokenDigest: string;
    readonly userId: UserId;
  }): Promise<
    | { readonly normalizedEmail: string; readonly status: "ISSUED" }
    | { readonly status: "NOT_ELIGIBLE" }
  >;
}

export interface EmailVerificationDeliveryPort {
  /** Durably accepts delivery; network sending belongs outside domain state. */
  deliver(input: {
    readonly normalizedEmail: string;
    readonly token: string;
  }): Promise<void>;
}

export interface EmailVerificationTokenService {
  digest(token: string): string;
  generate(): string;
}

export interface EmailVerificationService {
  confirm(token: string): Promise<"INVALID" | "VERIFIED">;
  request(userId: UserId): Promise<void>;
}

export function createEmailVerificationPersistence(
  repository: EmailVerificationRepository,
): EmailVerificationPersistence {
  return Object.freeze({
    async consume(tokenDigest: string) {
      const result = await repository.consume(tokenDigest);
      return result.status;
    },
    async issue(input: {
      readonly expiresAt: Date;
      readonly tokenDigest: string;
      readonly userId: UserId;
    }) {
      const result = await repository.issue(input);
      return result.status === "ISSUED"
        ? {
            normalizedEmail: result.normalizedEmail,
            status: "ISSUED" as const,
          }
        : { status: "NOT_ELIGIBLE" as const };
    },
  });
}

export function createEmailVerificationService(input: {
  readonly clock?: () => Date;
  readonly delivery: EmailVerificationDeliveryPort;
  readonly persistence: EmailVerificationPersistence;
  readonly tokenTtlMs: number;
  readonly tokens?: EmailVerificationTokenService;
}): EmailVerificationService {
  if (!Number.isSafeInteger(input.tokenTtlMs) || input.tokenTtlMs < 1) {
    throw new RangeError("Email-verification TTL must be positive.");
  }
  const clock = input.clock ?? (() => new Date());
  const tokens = input.tokens ?? createEmailVerificationTokenService();

  return Object.freeze({
    async confirm(token: string): Promise<"INVALID" | "VERIFIED"> {
      validateVerificationToken(token);
      return input.persistence.consume(tokens.digest(token));
    },

    async request(userId: UserId): Promise<void> {
      const token = tokens.generate();
      const now = clock();
      const issued = await input.persistence.issue({
        expiresAt: new Date(now.valueOf() + input.tokenTtlMs),
        tokenDigest: tokens.digest(token),
        userId,
      });
      if (issued.status !== "ISSUED") return;

      try {
        await input.delivery.deliver({
          normalizedEmail: issued.normalizedEmail,
          token,
        });
      } catch {
        // Delivery telemetry belongs to the adapter/worker. This boundary must
        // neither expose account state nor leak the plaintext token in errors.
      }
    },
  });
}

export function createEmailVerificationTokenService(): EmailVerificationTokenService {
  return Object.freeze({
    digest(token: string): string {
      return createHash("sha256").update(token, "utf8").digest("hex");
    },
    generate(): string {
      return randomBytes(32).toString("base64url");
    },
  });
}

export class InvalidEmailVerificationTokenError extends Error {
  public constructor() {
    super("Invalid email-verification token");
    this.name = "InvalidEmailVerificationTokenError";
  }
}

function validateVerificationToken(token: string): void {
  if (
    token.length < 32 ||
    token.length > AUTH_INPUT_LIMITS.verificationTokenMaximumLength ||
    !/^[A-Za-z0-9_-]+$/u.test(token)
  ) {
    throw new InvalidEmailVerificationTokenError();
  }
}
