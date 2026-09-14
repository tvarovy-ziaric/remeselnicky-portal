import { createHash } from "node:crypto";

import type {
  AdminAccessRepository,
  AdminMfaProvider,
  AdminRole,
  AdminRoleChangeEvent,
  ClaimedMfaChallenge,
  PrivilegedIdentity,
  PrivilegedSessionRecord,
} from "../src/index.js";
import {
  capabilitiesForRoles,
  createAdminAccessService,
} from "../src/index.js";
import type { UserId } from "@portal/domain";
import { describe, expect, it } from "vitest";

const ADMIN_ID = "11111111-1111-4111-8111-111111111111" as UserId;
const SUPER_ID = "22222222-2222-4222-8222-222222222222" as UserId;
const USER_ID = "33333333-3333-4333-8333-333333333333" as UserId;
const NOW = new Date("2026-09-14T10:00:00.000Z");

describe("admin privileged access", () => {
  it("keeps ADMIN and SUPER_ADMIN capabilities distinguishable", () => {
    const admin = capabilitiesForRoles(["ADMIN"]);
    const superAdmin = capabilitiesForRoles(["SUPER_ADMIN"]);

    expect(admin.has("admin.access")).toBe(true);
    expect(admin.has("admin.roles.manage")).toBe(false);
    expect(admin.has("admin.sensitive.read")).toBe(false);
    expect(superAdmin.has("admin.roles.manage")).toBe(true);
    expect(superAdmin.has("admin.sensitive.read")).toBe(true);
  });

  it("requires an active role and provider-managed MFA factor", async () => {
    const fixture = createFixture();
    await expect(
      fixture.service.beginMfa({
        purpose: "PRIVILEGED_SESSION",
        userId: USER_ID,
      }),
    ).resolves.toEqual({ status: "NOT_ELIGIBLE" });

    fixture.repository.identities.set(USER_ID, {
      factors: [],
      roles: ["ADMIN"],
      userId: USER_ID,
    });
    await expect(
      fixture.service.beginMfa({
        purpose: "PRIVILEGED_SESSION",
        userId: USER_ID,
      }),
    ).resolves.toEqual({ status: "NOT_ELIGIBLE" });
  });

  it("rejects unnamespaced secret-like factor material instead of persisting it", async () => {
    const fixture = createFixture();
    fixture.repository.identities.set(USER_ID, {
      factors: [
        {
          credentialReference: "JBSWY3DPEHPK3PXP",
          factorId: "factor-unsafe",
          kind: "TOTP",
        },
      ],
      roles: ["ADMIN"],
      userId: USER_ID,
    });

    await expect(
      fixture.service.beginMfa({
        purpose: "PRIVILEGED_SESSION",
        userId: USER_ID,
      }),
    ).rejects.toThrow(/opaque credential reference/u);
    expect(fixture.repository.lastCreatedDigest).toBeUndefined();
  });

  it("stores only a challenge digest and establishes a bounded privileged session after MFA", async () => {
    const fixture = createFixture();
    fixture.repository.addIdentity(ADMIN_ID, "ADMIN");
    const challenge = await fixture.service.beginMfa({
      purpose: "PRIVILEGED_SESSION",
      userId: ADMIN_ID,
    });
    expect(challenge.status).toBe("CHALLENGE_CREATED");
    if (challenge.status !== "CHALLENGE_CREATED") return;

    expect(fixture.repository.lastCreatedDigest).toBe(
      createHash("sha256").update(challenge.challengeToken).digest("hex"),
    );
    expect(fixture.repository.lastCreatedDigest).not.toContain(
      challenge.challengeToken,
    );
    expect(challenge).not.toHaveProperty("credentialReference");

    await expect(
      fixture.service.authorize({
        capability: "admin.access",
        requireRecentMfa: false,
        sessionId: "base-session",
        userId: ADMIN_ID,
      }),
    ).resolves.toEqual({ status: "AUTHENTICATION_REQUIRED" });

    await expect(
      fixture.service.verifyMfa({
        challengeToken: challenge.challengeToken,
        response: "123456",
        sessionId: "fresh-session",
        userId: ADMIN_ID,
      }),
    ).resolves.toEqual({ status: "VERIFIED" });

    const decision = await fixture.service.authorize({
      capability: "admin.access",
      requireRecentMfa: false,
      sessionId: "fresh-session",
      userId: ADMIN_ID,
    });
    expect(decision.status).toBe("AUTHORIZED");
    if (decision.status === "AUTHORIZED") {
      expect(decision.actor.roles).toEqual(["ADMIN"]);
      expect(decision.actor.capabilities.has("admin.roles.manage")).toBe(false);
    }
    await expect(
      fixture.service.authorize({
        capability: "admin.access",
        requireRecentMfa: false,
        sessionId: "base-session",
        userId: ADMIN_ID,
      }),
    ).resolves.toEqual({ status: "AUTHENTICATION_REQUIRED" });
  });

  it("single-claims every verification attempt to prevent replay and online guessing", async () => {
    const fixture = createFixture();
    fixture.repository.addIdentity(ADMIN_ID, "ADMIN");
    const challenge = await fixture.service.beginMfa({
      purpose: "PRIVILEGED_SESSION",
      userId: ADMIN_ID,
    });
    if (challenge.status !== "CHALLENGE_CREATED") throw new Error("challenge");

    await expect(
      fixture.service.verifyMfa({
        challengeToken: challenge.challengeToken,
        response: "000000",
        sessionId: "base-session",
        userId: ADMIN_ID,
      }),
    ).resolves.toEqual({ status: "INVALID" });
    await expect(
      fixture.service.verifyMfa({
        challengeToken: challenge.challengeToken,
        response: "123456",
        sessionId: "base-session",
        userId: ADMIN_ID,
      }),
    ).resolves.toEqual({ status: "INVALID" });
    expect(fixture.provider.verifyCalls).toBe(1);
  });

  it("fails closed when the MFA provider fails", async () => {
    const fixture = createFixture();
    fixture.repository.addIdentity(ADMIN_ID, "ADMIN");
    fixture.provider.throwOnVerify = true;
    const challenge = await fixture.service.beginMfa({
      purpose: "PRIVILEGED_SESSION",
      userId: ADMIN_ID,
    });
    if (challenge.status !== "CHALLENGE_CREATED") throw new Error("challenge");

    await expect(
      fixture.service.verifyMfa({
        challengeToken: challenge.challengeToken,
        response: "123456",
        sessionId: "base-session",
        userId: ADMIN_ID,
      }),
    ).resolves.toEqual({ status: "INVALID" });
  });

  it("denies self-escalation and requires recent SUPER_ADMIN MFA for role commands", async () => {
    const fixture = createFixture();
    fixture.repository.addSession("admin-session", ADMIN_ID, ["ADMIN"], NOW);
    fixture.repository.addSession(
      "super-session",
      SUPER_ID,
      ["SUPER_ADMIN"],
      NOW,
    );

    await expect(
      fixture.service.changeRole({
        action: "GRANT",
        actorSessionId: "admin-session",
        actorUserId: ADMIN_ID,
        reason: "Approved support assignment",
        role: "SUPER_ADMIN",
        targetUserId: USER_ID,
      }),
    ).resolves.toEqual({ status: "AUTHORIZATION_DENIED" });
    await expect(
      fixture.service.changeRole({
        action: "GRANT",
        actorSessionId: "super-session",
        actorUserId: SUPER_ID,
        reason: "Attempted self role mutation",
        role: "ADMIN",
        targetUserId: SUPER_ID,
      }),
    ).resolves.toEqual({ status: "SELF_CHANGE_DENIED" });

    const changed = await fixture.service.changeRole({
      action: "GRANT",
      actorSessionId: "super-session",
      actorUserId: SUPER_ID,
      reason: "Approved operational administrator",
      role: "ADMIN",
      targetUserId: USER_ID,
    });
    expect(changed.status).toBe("CHANGED");
    if (changed.status === "CHANGED") {
      expect(changed.event).toMatchObject({
        action: "ADMIN_ROLE_GRANTED",
        actorUserId: SUPER_ID,
        reason: "Approved operational administrator",
        role: "ADMIN",
        targetUserId: USER_ID,
      });
    }
  });

  it("requires reauthentication freshness for privileged role changes", async () => {
    let now = NOW;
    const fixture = createFixture(() => now);
    fixture.repository.addSession(
      "super-session",
      SUPER_ID,
      ["SUPER_ADMIN"],
      NOW,
    );
    now = new Date(NOW.valueOf() + 5 * 60_000 + 1);

    await expect(
      fixture.service.changeRole({
        action: "GRANT",
        actorSessionId: "super-session",
        actorUserId: SUPER_ID,
        reason: "Approved operational administrator",
        role: "ADMIN",
        targetUserId: USER_ID,
      }),
    ).resolves.toEqual({ status: "AUTHORIZATION_DENIED" });
  });

  it("does not expose provider references through actor/session projections", async () => {
    const fixture = createFixture();
    fixture.repository.addSession("admin-session", ADMIN_ID, ["ADMIN"], NOW);
    const decision = await fixture.service.authorize({
      capability: "admin.access",
      requireRecentMfa: false,
      sessionId: "admin-session",
      userId: ADMIN_ID,
    });
    expect(decision.status).toBe("AUTHORIZED");
    expect(JSON.stringify(decision)).not.toContain("provider://");
    expect(JSON.stringify(decision)).not.toContain("credentialReference");
  });
});

function createFixture(clock: () => Date = () => NOW) {
  const repository = new MemoryAdminRepository();
  const provider = new SyntheticProvider();
  return {
    provider,
    repository,
    service: createAdminAccessService({
      challengeTtlMs: 2 * 60_000,
      clock,
      mfaProvider: provider,
      privilegedSessionTtlMs: 30 * 60_000,
      reauthenticationMaxAgeMs: 5 * 60_000,
      repository,
    }),
  };
}

class SyntheticProvider implements AdminMfaProvider {
  public throwOnVerify = false;
  public verifyCalls = 0;

  public begin(): Promise<{
    providerStateReference: string;
    publicChallenge: null;
  }> {
    return Promise.resolve({
      providerStateReference: "provider://challenge-state",
      publicChallenge: null,
    });
  }

  public verify(input: { response: string }): Promise<boolean> {
    this.verifyCalls += 1;
    if (this.throwOnVerify) return Promise.reject(new Error("unavailable"));
    return Promise.resolve(input.response === "123456");
  }
}

class MemoryAdminRepository implements AdminAccessRepository {
  public readonly identities = new Map<UserId, PrivilegedIdentity>();
  public lastCreatedDigest: string | undefined;
  private readonly challenges = new Map<
    string,
    ClaimedMfaChallenge & { claimed: boolean; expiresAt: Date }
  >();
  private readonly sessions = new Map<string, PrivilegedSessionRecord>();

  public addIdentity(userId: UserId, role: AdminRole): void {
    this.identities.set(userId, {
      factors: [
        {
          credentialReference: `provider://credential/${userId}`,
          factorId: `factor-${userId}`,
          kind: "TOTP",
        },
      ],
      roles: [role],
      userId,
    });
  }

  public addSession(
    sessionId: string,
    userId: UserId,
    roles: AdminRole[],
    mfaAuthenticatedAt: Date,
  ): void {
    this.sessions.set(digest(sessionId), {
      expiresAt: new Date(mfaAuthenticatedAt.valueOf() + 30 * 60_000),
      factorId: `factor-${userId}`,
      mfaAuthenticatedAt,
      roles,
      userId,
    });
  }

  public changeRole(input: {
    action: "GRANT" | "REVOKE";
    actorSessionIdDigest: string;
    actorUserId: UserId;
    eventId: string;
    reason: string;
    reauthenticationMaxAgeMs: number;
    role: AdminRole;
    targetUserId: UserId;
  }): Promise<AdminRoleChangeEvent | undefined> {
    return Promise.resolve({
      action:
        input.action === "GRANT" ? "ADMIN_ROLE_GRANTED" : "ADMIN_ROLE_REVOKED",
      actorUserId: input.actorUserId,
      eventId: input.eventId,
      occurredAt: NOW,
      reason: input.reason,
      role: input.role,
      targetUserId: input.targetUserId,
    });
  }

  public claimMfaChallenge(input: {
    challengeDigest: string;
    now: Date;
    userId: UserId;
  }): Promise<ClaimedMfaChallenge | undefined> {
    const challenge = this.challenges.get(input.challengeDigest);
    if (
      challenge === undefined ||
      challenge.claimed ||
      challenge.userId !== input.userId ||
      challenge.expiresAt <= input.now
    ) {
      return Promise.resolve(undefined);
    }
    challenge.claimed = true;
    return Promise.resolve(challenge);
  }

  public completeMfaChallenge(input: {
    challengeDigest: string;
    expiresAt: Date;
    now: Date;
    sessionIdDigest: string;
    userId: UserId;
  }): Promise<boolean> {
    const challenge = this.challenges.get(input.challengeDigest);
    const identity = this.identities.get(input.userId);
    if (
      challenge === undefined ||
      !challenge.claimed ||
      identity === undefined
    ) {
      return Promise.resolve(false);
    }
    this.challenges.delete(input.challengeDigest);
    this.sessions.set(input.sessionIdDigest, {
      expiresAt: input.expiresAt,
      factorId: challenge.factorId,
      mfaAuthenticatedAt: input.now,
      roles: identity.roles,
      userId: input.userId,
    });
    return Promise.resolve(true);
  }

  public createMfaChallenge(input: {
    challengeDigest: string;
    expiresAt: Date;
    factorId: string;
    providerStateReference: string | null;
    purpose: "PRIVILEGED_SESSION" | "ROLE_CHANGE";
    userId: UserId;
  }): Promise<boolean> {
    const identity = this.identities.get(input.userId);
    const factor = identity?.factors.find(
      ({ factorId }) => factorId === input.factorId,
    );
    if (factor === undefined) return Promise.resolve(false);
    this.lastCreatedDigest = input.challengeDigest;
    this.challenges.set(input.challengeDigest, {
      claimed: false,
      credentialReference: factor.credentialReference,
      expiresAt: input.expiresAt,
      factorId: input.factorId,
      kind: factor.kind,
      providerStateReference: input.providerStateReference,
      purpose: input.purpose,
      userId: input.userId,
    });
    return Promise.resolve(true);
  }

  public findPrivilegedIdentity(
    userId: UserId,
  ): Promise<PrivilegedIdentity | undefined> {
    return Promise.resolve(this.identities.get(userId));
  }

  public findPrivilegedSession(input: {
    now: Date;
    sessionIdDigest: string;
    userId: UserId;
  }): Promise<PrivilegedSessionRecord | undefined> {
    const session = this.sessions.get(input.sessionIdDigest);
    return Promise.resolve(
      session !== undefined &&
        session.userId === input.userId &&
        session.expiresAt > input.now
        ? session
        : undefined,
    );
  }

  public revokePrivilegedSession(sessionIdDigest: string): Promise<void> {
    this.sessions.delete(sessionIdDigest);
    return Promise.resolve();
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
