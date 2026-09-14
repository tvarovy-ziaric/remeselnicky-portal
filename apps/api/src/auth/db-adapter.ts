import { createHash } from "node:crypto";

import type {
  AuthRepository,
  AuthSessionPayload,
  AuthUser as DatabaseAuthUser,
} from "@portal/db";
import type { UserId } from "@portal/domain";

import type { AuthPersistence, AuthUser } from "./types.js";

export function createAuthPersistence(
  repository: AuthRepository,
): AuthPersistence {
  const persistence: AuthPersistence = {
    async consumePasswordReset(input) {
      const result = await repository.consumePasswordReset(
        input.tokenDigest,
        input.newPasswordHash,
      );
      return result.status === "SUCCESS" ? "UPDATED" : "INVALID";
    },

    async consumeRateLimit(input) {
      const result = await repository.consumeRateLimit({
        expiresAt: new Date(input.now.valueOf() + input.timeWindowMs),
        keyDigest: input.keyDigest,
        limit: input.limit,
        scope: input.scope,
        windowStartedAt: input.now,
      });
      return {
        current: result.attemptCount,
        ttlMs: Math.max(0, result.expiresAt.valueOf() - input.now.valueOf()),
      };
    },

    createPasswordReset(input) {
      return repository
        .createPasswordReset({
          expiresAt: input.expiresAt,
          tokenDigest: input.tokenDigest,
          userId: input.userId,
        })
        .then(() => undefined);
    },

    destroySession(sessionId) {
      return repository
        .revokeSession(sessionDigest(sessionId))
        .then(() => undefined);
    },

    async findCredentialByEmail(normalizedEmail) {
      const credential =
        await repository.findCredentialByNormalizedEmail(normalizedEmail);
      return credential === null
        ? undefined
        : { ...authUser(credential), passwordHash: credential.passwordHash };
    },

    async findUserById(userId) {
      const user = await repository.findAuthUserById(userId);
      return user === null ? undefined : authUser(user);
    },

    async readSession(sessionId) {
      const session = await repository.findSession(sessionDigest(sessionId));
      if (session === null) {
        return undefined;
      }
      return {
        expiresAt: session.expiresAt,
        id: sessionId,
        payload: session.payload,
        userId:
          session.userId === null ? undefined : (session.userId as UserId),
      };
    },

    async register(input) {
      const result = await repository.registerUserWithCredential({
        adultAttested: input.adultAttested,
        normalizedEmail: input.normalizedEmail,
        passwordHash: input.passwordHash,
      });
      if (result.status === "DUPLICATE") {
        return { status: "DUPLICATE" };
      }
      return { status: "CREATED", user: authUser(result.user) };
    },

    revokeAllSessions(userId) {
      return repository.revokeAllUserSessions(userId).then(() => undefined);
    },

    async writeSession(session) {
      const saved = await repository.saveSession({
        expiresAt: session.expiresAt,
        payload: session.payload as AuthSessionPayload,
        sessionIdHash: sessionDigest(session.id),
        userId: session.userId ?? null,
      });
      if (saved === null) {
        throw new Error("Session persistence unavailable");
      }
    },
  };
  return Object.freeze(persistence);
}

function authUser(user: DatabaseAuthUser): AuthUser {
  return {
    accountState: user.accountState,
    adultAttestedAt: user.adultAttestedAt,
    emailVerifiedAt: user.emailVerifiedAt,
    id: user.id as UserId,
    phoneVerifiedAt: user.phoneVerifiedAt,
  };
}

function sessionDigest(sessionId: string): string {
  return createHash("sha256").update(sessionId, "utf8").digest("hex");
}
