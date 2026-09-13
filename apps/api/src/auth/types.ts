import type { UserAccountState, UserId } from "@portal/domain";

export interface AuthUser {
  readonly accountState: UserAccountState;
  readonly adultAttestedAt: Date;
  readonly id: UserId;
}

export interface AuthCredential extends AuthUser {
  readonly passwordHash: string;
}

export type RegistrationPersistenceResult =
  | { readonly status: "CREATED"; readonly user: AuthUser }
  | { readonly status: "DUPLICATE" };

export interface StoredSession {
  readonly expiresAt: Date;
  readonly id: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly userId: UserId | undefined;
}

export interface RateLimitConsumption {
  readonly current: number;
  readonly ttlMs: number;
}

export interface AuthPersistence {
  consumePasswordReset(input: {
    readonly newPasswordHash: string;
    readonly now: Date;
    readonly tokenDigest: string;
  }): Promise<"INVALID" | "UPDATED">;
  consumeRateLimit(input: {
    readonly keyDigest: string;
    readonly limit: number;
    readonly now: Date;
    readonly scope: string;
    readonly timeWindowMs: number;
  }): Promise<RateLimitConsumption>;
  createPasswordReset(input: {
    readonly expiresAt: Date;
    readonly tokenDigest: string;
    readonly userId: UserId;
  }): Promise<void>;
  destroySession(sessionId: string): Promise<void>;
  findCredentialByEmail(
    normalizedEmail: string,
  ): Promise<AuthCredential | undefined>;
  findUserById(userId: UserId): Promise<AuthUser | undefined>;
  readSession(sessionId: string, now: Date): Promise<StoredSession | undefined>;
  register(input: {
    readonly adultAttested: true;
    readonly normalizedEmail: string;
    readonly passwordHash: string;
  }): Promise<RegistrationPersistenceResult>;
  revokeAllSessions(userId: UserId): Promise<void>;
  writeSession(session: StoredSession): Promise<void>;
}

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
}

export interface ResetTokenService {
  digest(token: string): string;
  generate(): string;
}

export interface RegistrationEligibilityPort {
  isEligible(input: { readonly normalizedEmail: string }): Promise<boolean>;
}

export interface PasswordResetDeliveryPort {
  deliver(input: {
    readonly normalizedEmail: string;
    readonly token: string;
  }): Promise<void>;
}

export interface AuthRuntimeConfig {
  readonly appOrigin: string;
  readonly cookieName: string;
  readonly cookieSecure: boolean;
  readonly passwordResetTtlMs: number;
  readonly rateLimitMax: number;
  readonly rateLimitWindowMs: number;
  readonly sessionSecret: string;
  readonly sessionTtlMs: number;
  readonly trustProxyHops: number;
}
