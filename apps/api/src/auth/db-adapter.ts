import { createHash, createHmac } from "node:crypto";

import type {
  AlphaRegistrationIntakeRepository,
  AuthRepository,
  AuthSessionPayload,
  AuthUser as DatabaseAuthUser,
} from "@portal/db";
import type { UserId } from "@portal/domain";

import type {
  AuthPersistence,
  AuthUser,
  RegistrationAdmissionPort,
} from "./types.js";

export function createAlphaRegistrationAdmission(
  repository: Pick<AlphaRegistrationIntakeRepository, "registerInvitedUser">,
  hmacKey: string,
): RegistrationAdmissionPort {
  if (!/^[a-f0-9]{64}$/u.test(hmacKey))
    throw new Error("Alpha registration intake configuration is invalid.");
  return Object.freeze({
    async register(
      input: Parameters<RegistrationAdmissionPort["register"]>[0],
    ) {
      const result = await repository.registerInvitedUser({
        ...input,
        emailHmacDigest: invitationEmailDigest(hmacKey, input.normalizedEmail),
      });
      if (result.status !== "CREATED")
        return { status: result.status } as const;
      return { status: "CREATED", user: authUser(result.user) } as const;
    },
  });
}

export function createAlphaRegistrationIntakeOperations(
  repository: Pick<
    AlphaRegistrationIntakeRepository,
    "issue" | "readStatus" | "revoke" | "setState"
  >,
  hmacKey: string,
) {
  if (!/^[a-f0-9]{64}$/u.test(hmacKey))
    throw new Error("Alpha registration intake configuration is invalid.");
  return Object.freeze({
    issue(input: {
      actorUserId: string;
      cohortCode: string;
      commandId: string;
      expiresAt: Date;
      normalizedEmail: string;
    }) {
      return repository.issue({
        actorUserId: input.actorUserId,
        cohortCode: input.cohortCode,
        commandId: input.commandId,
        emailHmacDigest: invitationEmailDigest(hmacKey, input.normalizedEmail),
        expiresAt: input.expiresAt,
      });
    },
    readStatus: () => repository.readStatus(),
    revoke: repository.revoke.bind(repository),
    setState: repository.setState.bind(repository),
  });
}

export function createAuthPersistence(
  repository: AuthRepository,
  options: Readonly<{ registrationTrafficClass?: "TEST" }> = {},
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
        ...(options.registrationTrafficClass === undefined
          ? {}
          : { trafficClass: options.registrationTrafficClass }),
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
    activeModerationScopes: user.activeModerationScopes,
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

function invitationEmailDigest(hmacKey: string, normalizedEmail: string) {
  return createHmac("sha256", hmacKey)
    .update(
      `portal-alpha-registration-invitation-v1\0${normalizedEmail}`,
      "utf8",
    )
    .digest("hex");
}
