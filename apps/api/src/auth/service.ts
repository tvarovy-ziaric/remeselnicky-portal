import { setTimeout as delay } from "node:timers/promises";

import { AUTH_INPUT_LIMITS } from "@portal/contracts";

import { createArgon2PasswordHasher } from "./password.js";
import { createResetTokenService } from "./reset-token.js";
import type {
  AuthPersistence,
  AuthUser,
  PasswordHasher,
  PasswordResetDeliveryPort,
  RegistrationEligibilityPort,
  ResetTokenService,
} from "./types.js";

export type RegistrationResult =
  | { readonly status: "CREATED"; readonly user: AuthUser }
  | { readonly status: "NOT_AVAILABLE" };
export type LoginResult =
  | { readonly status: "AUTHENTICATED"; readonly user: AuthUser }
  | { readonly status: "INVALID_CREDENTIALS" };

export interface AuthService {
  login(input: {
    readonly email: string;
    readonly password: string;
  }): Promise<LoginResult>;
  register(input: {
    readonly adultAttested: true;
    readonly email: string;
    readonly password: string;
  }): Promise<RegistrationResult>;
  requestPasswordReset(email: string): Promise<void>;
  resetPassword(input: {
    readonly newPassword: string;
    readonly token: string;
  }): Promise<"INVALID" | "UPDATED">;
}

export function createAuthService(input: {
  readonly clock?: () => Date;
  readonly delivery: PasswordResetDeliveryPort;
  readonly eligibility: RegistrationEligibilityPort;
  readonly hasher?: PasswordHasher;
  readonly passwordResetTtlMs: number;
  readonly persistence: AuthPersistence;
  readonly tokens?: ResetTokenService;
}): AuthService {
  const resetResponseFloorMs = 250;
  const clock = input.clock ?? (() => new Date());
  const hasher = input.hasher ?? createArgon2PasswordHasher();
  const tokens = input.tokens ?? createResetTokenService();
  const dummyHash = hasher.hash("portal-dummy-credential-not-a-user-password");

  return Object.freeze({
    async login(credentials: {
      readonly email: string;
      readonly password: string;
    }): Promise<LoginResult> {
      const normalizedEmail = normalizeAndValidateEmail(credentials.email);
      validatePassword(credentials.password);
      const credential =
        await input.persistence.findCredentialByEmail(normalizedEmail);
      const passwordMatches = await hasher.verify(
        credential?.passwordHash ?? (await dummyHash),
        credentials.password,
      );

      if (
        credential === undefined ||
        !passwordMatches ||
        credential.accountState !== "ACTIVE"
      ) {
        return { status: "INVALID_CREDENTIALS" };
      }
      return { status: "AUTHENTICATED", user: credential };
    },

    async register(registration: {
      readonly adultAttested: true;
      readonly email: string;
      readonly password: string;
    }): Promise<RegistrationResult> {
      const normalizedEmail = normalizeAndValidateEmail(registration.email);
      validatePassword(registration.password);
      if (registration.adultAttested !== true) {
        throw new AuthInputError();
      }
      if (!(await input.eligibility.isEligible({ normalizedEmail }))) {
        return { status: "NOT_AVAILABLE" };
      }

      const passwordHash = await hasher.hash(registration.password);
      const result = await input.persistence.register({
        adultAttested: true,
        normalizedEmail,
        passwordHash,
      });
      return result.status === "CREATED"
        ? { status: "CREATED", user: result.user }
        : { status: "NOT_AVAILABLE" };
    },

    async requestPasswordReset(email: string): Promise<void> {
      const startedAt = performance.now();
      try {
        const normalizedEmail = normalizeAndValidateEmail(email);
        const token = tokens.generate();
        const credential =
          await input.persistence.findCredentialByEmail(normalizedEmail);
        await hasher.verify(
          await dummyHash,
          "portal-password-reset-timing-equalizer",
        );
        if (credential === undefined) {
          return;
        }

        const now = clock();
        await input.persistence.createPasswordReset({
          expiresAt: new Date(now.valueOf() + input.passwordResetTtlMs),
          tokenDigest: tokens.digest(token),
          userId: credential.id,
        });
        try {
          await input.delivery.deliver({ normalizedEmail, token });
        } catch {
          // The delivery adapter must report failures separately. The public
          // response remains generic so the account cannot be enumerated.
        }
      } finally {
        // A common response floor reduces the observable difference between
        // the known- and unknown-account persistence paths. The delivery port
        // is expected to durably enqueue, rather than perform network I/O here.
        const remainingMs =
          resetResponseFloorMs - (performance.now() - startedAt);
        if (remainingMs > 0) {
          await delay(remainingMs);
        }
      }
    },

    async resetPassword(reset: {
      readonly newPassword: string;
      readonly token: string;
    }): Promise<"INVALID" | "UPDATED"> {
      validatePassword(reset.newPassword);
      validateResetToken(reset.token);
      const newPasswordHash = await hasher.hash(reset.newPassword);
      return input.persistence.consumePasswordReset({
        newPasswordHash,
        now: clock(),
        tokenDigest: tokens.digest(reset.token),
      });
    },
  });
}

export class AuthInputError extends Error {
  public constructor() {
    super("Invalid authentication request");
    this.name = "AuthInputError";
  }
}

export function normalizeAndValidateEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (
    normalized.length < 3 ||
    normalized.length > AUTH_INPUT_LIMITS.emailMaximumLength ||
    !/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(normalized)
  ) {
    throw new AuthInputError();
  }
  return normalized;
}

export function validatePassword(password: string): void {
  if (
    password.length < AUTH_INPUT_LIMITS.passwordMinimumLength ||
    password.length > AUTH_INPUT_LIMITS.passwordMaximumLength ||
    Buffer.byteLength(password, "utf8") > 512
  ) {
    throw new AuthInputError();
  }
}

function validateResetToken(token: string): void {
  if (
    token.length < 32 ||
    token.length > AUTH_INPUT_LIMITS.resetTokenMaximumLength ||
    !/^[A-Za-z0-9_-]+$/u.test(token)
  ) {
    throw new InvalidResetTokenError();
  }
}

export class InvalidResetTokenError extends AuthInputError {
  public constructor() {
    super();
    this.name = "InvalidResetTokenError";
  }
}
