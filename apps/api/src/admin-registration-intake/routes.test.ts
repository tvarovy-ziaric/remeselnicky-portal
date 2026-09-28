import type { PrivilegedActor } from "@portal/admin-auth";
import { AlphaRegistrationIntakeIdempotencyError } from "@portal/db";
import type { UserId } from "@portal/domain";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ADMIN_REGISTRATION_INTAKE_PATHS,
  registerAdminRegistrationIntakeRoutes,
} from "./routes.js";

const adminId = "a9900000-0000-4000-8000-000000000001" as UserId;
const commandId = "a9900000-0000-4000-8000-000000000002";
const invitationId = "a9900000-0000-4000-8000-000000000003";
const now = new Date("2026-09-28T10:00:00.000Z");
const expiresAt = "2026-10-05T10:00:00.000Z";
const actor: PrivilegedActor = {
  capabilities: new Set(["admin.users.manage"]),
  mfaAuthenticatedAt: now,
  roles: ["ADMIN"],
  userId: adminId,
};
const apps: FastifyInstance[] = [];

afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function fixture(input?: {
  csrf?: boolean;
  identity?: "ACTIVE" | "ANONYMOUS";
}) {
  const app = Fastify();
  apps.push(app);
  app.addHook("onRequest", (request, _reply, done) => {
    Object.defineProperty(request, "session", {
      configurable: true,
      value: { sessionId: "opaque-privileged-session" },
    });
    done();
  });
  const authorize = vi.fn().mockResolvedValue({ status: "AUTHORIZED", actor });
  const issue = vi.fn().mockResolvedValue({
    status: "APPLIED",
    invitationId,
    expiresAt: new Date(expiresAt),
  });
  const readStatus = vi.fn().mockResolvedValue({
    recordedAt: now,
    revision: 2,
    state: "OPEN",
  });
  const revoke = vi.fn().mockResolvedValue({ status: "APPLIED" });
  const setState = vi.fn().mockResolvedValue({ status: "APPLIED" });
  registerAdminRegistrationIntakeRoutes(app, {
    adminAccess: { authorize },
    clock: () => now,
    csrfProtection: (_request, reply, done) => {
      if (input?.csrf === false) {
        void reply.code(403).send({ code: "CSRF_DENIED" });
        return;
      }
      done();
    },
    guard: {
      evaluate: vi
        .fn()
        .mockResolvedValue(
          input?.identity === "ANONYMOUS"
            ? { status: "AUTHENTICATION_REQUIRED" }
            : { status: "ACTIVE", user: { id: adminId } },
        ),
    },
    intake: { issue, readStatus, revoke, setState },
    rateLimit: { max: 20, timeWindowMs: 60_000 },
  });
  return { app, authorize, issue, readStatus, revoke, setState };
}

describe("administrative alpha registration intake", () => {
  it("requires recent MFA to read the privacy-safe current state", async () => {
    const { app, authorize, readStatus } = fixture();
    const response = await app.inject({
      method: "GET",
      url: ADMIN_REGISTRATION_INTAKE_PATHS.status,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      recordedAt: now.toISOString(),
      revision: 2,
      state: "OPEN",
    });
    expect(authorize).toHaveBeenCalledWith({
      capability: "admin.users.manage",
      requireRecentMfa: true,
      sessionId: "opaque-privileged-session",
      userId: adminId,
    });
    expect(readStatus).toHaveBeenCalledOnce();
  });

  it("normalizes email before issuing and never returns email or its digest", async () => {
    const { app, issue } = fixture();
    const response = await app.inject({
      method: "POST",
      url: ADMIN_REGISTRATION_INTAKE_PATHS.invitation,
      payload: {
        cohortCode: "ALPHA_01",
        commandId,
        email: "  Invitee@Example.COM ",
        expiresAt,
      },
    });
    expect(response.statusCode).toBe(201);
    expect(issue).toHaveBeenCalledWith({
      actorUserId: adminId,
      cohortCode: "ALPHA_01",
      commandId,
      expiresAt: new Date(expiresAt),
      normalizedEmail: "invitee@example.com",
    });
    const serialized = JSON.stringify(response.json());
    expect(serialized).not.toContain("invitee@example.com");
    expect(serialized).not.toContain("email");
    expect(response.json()).toEqual({
      expiresAt,
      invitationId,
      status: "APPLIED",
    });
  });

  it("changes state and revokes invitations with admin provenance", async () => {
    const { app, revoke, setState } = fixture();
    const state = await app.inject({
      method: "POST",
      url: ADMIN_REGISTRATION_INTAKE_PATHS.state,
      payload: {
        commandId,
        reason: "Opening the approved synthetic alpha cohort.",
        state: "OPEN",
      },
    });
    expect(state.statusCode).toBe(201);
    expect(setState).toHaveBeenCalledWith({
      actorUserId: adminId,
      commandId,
      reason: "Opening the approved synthetic alpha cohort.",
      state: "OPEN",
    });

    const revokeResponse = await app.inject({
      method: "POST",
      url: ADMIN_REGISTRATION_INTAKE_PATHS.revokeInvitation.replace(
        ":invitationId",
        invitationId,
      ),
      payload: {
        commandId: "a9900000-0000-4000-8000-000000000004",
        reason: "Invitation withdrawn before account registration.",
      },
    });
    expect(revokeResponse.statusCode).toBe(201);
    expect(revoke).toHaveBeenCalledWith({
      actorUserId: adminId,
      commandId: "a9900000-0000-4000-8000-000000000004",
      invitationId,
      reason: "Invitation withdrawn before account registration.",
    });
  });

  it("fails closed for anonymous, stale MFA, CSRF failure and extra fields", async () => {
    const anonymous = fixture({ identity: "ANONYMOUS" });
    expect(
      (
        await anonymous.app.inject({
          method: "GET",
          url: ADMIN_REGISTRATION_INTAKE_PATHS.status,
        })
      ).statusCode,
    ).toBe(401);
    expect(anonymous.readStatus).not.toHaveBeenCalled();

    const denied = fixture();
    denied.authorize.mockResolvedValue({ status: "MFA_TOO_OLD" });
    expect(
      (
        await denied.app.inject({
          method: "GET",
          url: ADMIN_REGISTRATION_INTAKE_PATHS.status,
        })
      ).statusCode,
    ).toBe(403);
    expect(denied.readStatus).not.toHaveBeenCalled();

    const csrf = fixture({ csrf: false });
    expect(
      (
        await csrf.app.inject({
          method: "POST",
          url: ADMIN_REGISTRATION_INTAKE_PATHS.state,
          payload: {
            commandId,
            reason: "Opening the approved synthetic alpha cohort.",
            state: "OPEN",
          },
        })
      ).statusCode,
    ).toBe(403);

    const extra = fixture();
    expect(
      (
        await extra.app.inject({
          method: "POST",
          url: ADMIN_REGISTRATION_INTAKE_PATHS.invitation,
          payload: {
            cohortCode: "ALPHA_01",
            commandId,
            email: "invitee@example.com",
            expiresAt,
            role: "ADMIN",
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(extra.issue).not.toHaveBeenCalled();
  });

  it("maps invalid, stale and idempotency-conflict commands without leaking input", async () => {
    const invalid = fixture();
    const invalidResponse = await invalid.app.inject({
      method: "POST",
      url: ADMIN_REGISTRATION_INTAKE_PATHS.invitation,
      payload: {
        cohortCode: "ALPHA_01",
        commandId,
        email: "not-an-email",
        expiresAt,
      },
    });
    expect(invalidResponse.statusCode).toBe(400);
    expect(JSON.stringify(invalidResponse.json())).not.toContain(
      "not-an-email",
    );

    const stale = fixture();
    stale.issue.mockResolvedValue({ status: "STALE_STATE" });
    expect(
      (
        await stale.app.inject({
          method: "POST",
          url: ADMIN_REGISTRATION_INTAKE_PATHS.invitation,
          payload: {
            cohortCode: "ALPHA_01",
            commandId,
            email: "invitee@example.com",
            expiresAt,
          },
        })
      ).statusCode,
    ).toBe(409);

    const conflict = fixture();
    conflict.setState.mockRejectedValue(
      new AlphaRegistrationIntakeIdempotencyError(),
    );
    const conflictResponse = await conflict.app.inject({
      method: "POST",
      url: ADMIN_REGISTRATION_INTAKE_PATHS.state,
      payload: {
        commandId,
        reason: "Opening the approved synthetic alpha cohort.",
        state: "OPEN",
      },
    });
    expect(conflictResponse.statusCode).toBe(409);
    expect(conflictResponse.json()).toEqual({ code: "IDEMPOTENCY_CONFLICT" });
  });
});
