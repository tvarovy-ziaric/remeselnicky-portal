import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { UserId } from "@portal/domain";

import {
  capabilitiesForRoles,
  type AdminAccessRepository,
  type AdminCapability,
  type AdminMfaFactorKind,
  type AdminMfaPurpose,
  type AdminRole,
  type AdminRoleChangeEvent,
} from "./model.js";

const safeResponsePattern = /^[\x20-\x7e]{1,8192}$/u;
const reasonPattern = /\S/u;

export interface AdminMfaProvider {
  begin(input: {
    readonly credentialReference: string;
    readonly factorKind: AdminMfaFactorKind;
    readonly purpose: AdminMfaPurpose;
    readonly userId: UserId;
  }): Promise<{
    readonly providerStateReference: string | null;
    readonly publicChallenge: string | null;
  }>;
  verify(input: {
    readonly credentialReference: string;
    readonly factorKind: AdminMfaFactorKind;
    readonly providerStateReference: string | null;
    readonly response: string;
    readonly userId: UserId;
  }): Promise<boolean>;
}

export interface PrivilegedSecurityEvent {
  readonly action:
    | "MFA_CHALLENGE_CREATED"
    | "MFA_VERIFICATION_FAILED"
    | "PRIVILEGED_SESSION_CREATED"
    | "PRIVILEGED_SESSION_DENIED";
  readonly actorUserId: UserId;
  readonly occurredAt: Date;
  readonly result: "DENIED" | "SUCCEEDED";
}

export interface PrivilegedSecurityEventSink {
  record(event: PrivilegedSecurityEvent): void | Promise<void>;
}

export interface PrivilegedActor {
  readonly capabilities: ReadonlySet<AdminCapability>;
  readonly mfaAuthenticatedAt: Date;
  readonly roles: readonly AdminRole[];
  readonly userId: UserId;
}

export type PrivilegedAuthorizationResult =
  | { readonly status: "AUTHORIZED"; readonly actor: PrivilegedActor }
  | {
      readonly status:
        "AUTHENTICATION_REQUIRED" | "CAPABILITY_DENIED" | "MFA_TOO_OLD";
    };

export interface AdminAccessService {
  authorize(input: {
    readonly capability: AdminCapability;
    readonly requireRecentMfa: boolean;
    readonly sessionId: string;
    readonly userId: UserId;
  }): Promise<PrivilegedAuthorizationResult>;
  beginMfa(input: {
    readonly purpose: AdminMfaPurpose;
    readonly userId: UserId;
  }): Promise<
    | {
        readonly status: "CHALLENGE_CREATED";
        readonly challengeToken: string;
        readonly factorKind: AdminMfaFactorKind;
        readonly publicChallenge: string | null;
      }
    | { readonly status: "NOT_ELIGIBLE" }
  >;
  changeRole(input: {
    readonly action: "GRANT" | "REVOKE";
    readonly actorSessionId: string;
    readonly actorUserId: UserId;
    readonly reason: string;
    readonly role: AdminRole;
    readonly targetUserId: UserId;
  }): Promise<
    | { readonly status: "CHANGED"; readonly event: AdminRoleChangeEvent }
    | {
        readonly status:
          "ALREADY_IN_STATE" | "AUTHORIZATION_DENIED" | "SELF_CHANGE_DENIED";
      }
  >;
  revokeSession(sessionId: string): Promise<void>;
  verifyMfa(input: {
    readonly challengeToken: string;
    readonly response: string;
    readonly sessionId: string;
    readonly userId: UserId;
  }): Promise<{ readonly status: "INVALID" | "VERIFIED" }>;
}

export function createAdminAccessService(input: {
  readonly challengeTtlMs: number;
  readonly clock?: () => Date;
  readonly eventSink?: PrivilegedSecurityEventSink;
  readonly mfaProvider: AdminMfaProvider;
  readonly privilegedSessionTtlMs: number;
  readonly reauthenticationMaxAgeMs: number;
  readonly repository: AdminAccessRepository;
}): AdminAccessService {
  validateDuration(input.challengeTtlMs, "challengeTtlMs", 60_000, 600_000);
  validateDuration(
    input.privilegedSessionTtlMs,
    "privilegedSessionTtlMs",
    300_000,
    43_200_000,
  );
  validateDuration(
    input.reauthenticationMaxAgeMs,
    "reauthenticationMaxAgeMs",
    30_000,
    input.privilegedSessionTtlMs,
  );
  const clock = input.clock ?? (() => new Date());
  const eventSink = input.eventSink ?? noOpEventSink;

  async function record(event: PrivilegedSecurityEvent): Promise<void> {
    try {
      await eventSink.record(Object.freeze(event));
    } catch {
      // Security logging failure must not disclose or grant privileged access.
    }
  }

  async function authorize(auth: {
    readonly capability: AdminCapability;
    readonly requireRecentMfa: boolean;
    readonly sessionId: string;
    readonly userId: UserId;
  }): Promise<PrivilegedAuthorizationResult> {
    const now = clock();
    const session = await input.repository.findPrivilegedSession({
      now,
      sessionIdDigest: digest(auth.sessionId),
      userId: auth.userId,
    });
    if (session === undefined) {
      await record({
        action: "PRIVILEGED_SESSION_DENIED",
        actorUserId: auth.userId,
        occurredAt: now,
        result: "DENIED",
      });
      return { status: "AUTHENTICATION_REQUIRED" };
    }
    const capabilities = capabilitiesForRoles(session.roles);
    if (!capabilities.has(auth.capability)) {
      return { status: "CAPABILITY_DENIED" };
    }
    if (
      auth.requireRecentMfa &&
      now.valueOf() - session.mfaAuthenticatedAt.valueOf() >
        input.reauthenticationMaxAgeMs
    ) {
      return { status: "MFA_TOO_OLD" };
    }
    return {
      actor: Object.freeze({
        capabilities,
        mfaAuthenticatedAt: session.mfaAuthenticatedAt,
        roles: Object.freeze([...session.roles]),
        userId: session.userId,
      }),
      status: "AUTHORIZED",
    };
  }

  return Object.freeze<AdminAccessService>({
    authorize,

    async beginMfa(begin): Promise<
      | {
          readonly status: "CHALLENGE_CREATED";
          readonly challengeToken: string;
          readonly factorKind: AdminMfaFactorKind;
          readonly publicChallenge: string | null;
        }
      | { readonly status: "NOT_ELIGIBLE" }
    > {
      const identity = await input.repository.findPrivilegedIdentity(
        begin.userId,
      );
      const factor = identity?.factors[0];
      if (
        identity === undefined ||
        identity.roles.length === 0 ||
        factor === undefined
      ) {
        return { status: "NOT_ELIGIBLE" };
      }
      validateOpaqueReference(factor.credentialReference, "credential");
      const providerChallenge = await input.mfaProvider.begin({
        credentialReference: factor.credentialReference,
        factorKind: factor.kind,
        purpose: begin.purpose,
        userId: begin.userId,
      });
      validateProviderReference(providerChallenge.providerStateReference);
      validatePublicChallenge(providerChallenge.publicChallenge);
      const challengeToken = randomBytes(32).toString("base64url");
      const now = clock();
      const created = await input.repository.createMfaChallenge({
        challengeDigest: digest(challengeToken),
        expiresAt: new Date(now.valueOf() + input.challengeTtlMs),
        factorId: factor.factorId,
        providerStateReference: providerChallenge.providerStateReference,
        purpose: begin.purpose,
        userId: begin.userId,
      });
      if (!created) return { status: "NOT_ELIGIBLE" };
      await record({
        action: "MFA_CHALLENGE_CREATED",
        actorUserId: begin.userId,
        occurredAt: now,
        result: "SUCCEEDED",
      });
      return Object.freeze({
        challengeToken,
        factorKind: factor.kind,
        publicChallenge: providerChallenge.publicChallenge,
        status: "CHALLENGE_CREATED" as const,
      });
    },

    async changeRole(change) {
      validateReason(change.reason);
      if (change.actorUserId === change.targetUserId) {
        return { status: "SELF_CHANGE_DENIED" };
      }
      const decision = await authorize({
        capability: "admin.roles.manage",
        requireRecentMfa: true,
        sessionId: change.actorSessionId,
        userId: change.actorUserId,
      });
      if (decision.status !== "AUTHORIZED") {
        return { status: "AUTHORIZATION_DENIED" };
      }
      const event = await input.repository.changeRole({
        action: change.action,
        actorSessionIdDigest: digest(change.actorSessionId),
        actorUserId: change.actorUserId,
        eventId: randomUUID(),
        reason: change.reason.trim(),
        reauthenticationMaxAgeMs: input.reauthenticationMaxAgeMs,
        role: change.role,
        targetUserId: change.targetUserId,
      });
      return event === undefined
        ? { status: "ALREADY_IN_STATE" }
        : { event, status: "CHANGED" };
    },

    async revokeSession(sessionId: string): Promise<void> {
      await input.repository.revokePrivilegedSession(digest(sessionId));
    },

    async verifyMfa(verification): Promise<{
      readonly status: "INVALID" | "VERIFIED";
    }> {
      if (
        !isValidChallengeToken(verification.challengeToken) ||
        !safeResponsePattern.test(verification.response)
      ) {
        return { status: "INVALID" };
      }
      const now = clock();
      const challengeDigest = digest(verification.challengeToken);
      const challenge = await input.repository.claimMfaChallenge({
        challengeDigest,
        now,
        userId: verification.userId,
      });
      if (challenge === undefined) return { status: "INVALID" };
      const valid = await input.mfaProvider
        .verify({
          credentialReference: challenge.credentialReference,
          factorKind: challenge.kind,
          providerStateReference: challenge.providerStateReference,
          response: verification.response,
          userId: verification.userId,
        })
        .catch(() => false);
      if (!valid) {
        await record({
          action: "MFA_VERIFICATION_FAILED",
          actorUserId: verification.userId,
          occurredAt: now,
          result: "DENIED",
        });
        return { status: "INVALID" };
      }
      const activated = await input.repository.completeMfaChallenge({
        challengeDigest,
        expiresAt: new Date(now.valueOf() + input.privilegedSessionTtlMs),
        now,
        sessionIdDigest: digest(verification.sessionId),
        userId: verification.userId,
      });
      if (!activated) return { status: "INVALID" };
      await record({
        action: "PRIVILEGED_SESSION_CREATED",
        actorUserId: verification.userId,
        occurredAt: now,
        result: "SUCCEEDED",
      });
      return { status: "VERIFIED" };
    },
  });
}

const noOpEventSink: PrivilegedSecurityEventSink = Object.freeze({
  record(): void {},
});

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isValidChallengeToken(value: string): boolean {
  return (
    value.length >= 40 && value.length <= 128 && /^[A-Za-z0-9_-]+$/u.test(value)
  );
}

function validateDuration(
  value: number,
  name: string,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} is outside the safe supported range`);
  }
}

function validateProviderReference(value: string | null): void {
  if (value !== null) validateOpaqueReference(value, "state");
}

function validatePublicChallenge(value: string | null): void {
  if (value !== null && (value.length < 1 || value.length > 8192)) {
    throw new Error("MFA provider returned an invalid public challenge");
  }
}

function validateReason(reason: string): void {
  if (reason.length < 8 || reason.length > 500 || !reasonPattern.test(reason)) {
    throw new TypeError("A bounded meaningful role-change reason is required");
  }
}

function validateOpaqueReference(value: string, label: string): void {
  if (
    !/^[A-Za-z][A-Za-z0-9.-]{1,31}:[A-Za-z0-9/][A-Za-z0-9._:/-]{0,223}$/u.test(
      value,
    )
  ) {
    throw new Error(
      `MFA provider returned an invalid opaque ${label} reference`,
    );
  }
}
