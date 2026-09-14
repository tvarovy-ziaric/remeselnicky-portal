import type { AdminAccessService } from "@portal/admin-auth";
import { ADMIN_AUTH_API_PATHS } from "@portal/contracts";
import type { UserId } from "@portal/domain";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthPersistence, AuthUser } from "../auth/types.js";
import { registerAdminAuthRoutes } from "./routes.js";

const USER_ID = "11111111-1111-4111-8111-111111111111" as UserId;
const activeUser: AuthUser = {
  accountState: "ACTIVE",
  adultAttestedAt: new Date("2026-01-01T00:00:00.000Z"),
  emailVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
  id: USER_ID,
  phoneVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
};
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe("admin MFA routes", () => {
  it("enforces the backend identity guard independent of route discovery", async () => {
    const fixture = createFixture("ANONYMOUS");
    const response = await fixture.app.inject({
      method: "GET",
      url: ADMIN_AUTH_API_PATHS.session,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ code: "AUTHENTICATION_REQUIRED" });
    expect(fixture.service.authorize).not.toHaveBeenCalled();
  });

  it("denies an authenticated session without an MFA-backed admin capability", async () => {
    const fixture = createFixture("ACTIVE");
    fixture.service.authorize.mockResolvedValue({
      status: "AUTHENTICATION_REQUIRED",
    });
    const response = await fixture.app.inject({
      method: "GET",
      url: ADMIN_AUTH_API_PATHS.session,
    });

    expect(response.statusCode).toBe(403);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
  });

  it("projects only roles, capabilities and MFA time from an authorized session", async () => {
    const fixture = createFixture("ACTIVE");
    fixture.service.authorize.mockResolvedValue({
      actor: {
        capabilities: new Set(["admin.access"]),
        mfaAuthenticatedAt: new Date("2026-09-14T10:00:00.000Z"),
        roles: ["ADMIN"],
        userId: USER_ID,
      },
      status: "AUTHORIZED",
    });
    const response = await fixture.app.inject({
      method: "GET",
      url: ADMIN_AUTH_API_PATHS.session,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      capabilities: ["admin.access"],
      mfaAuthenticatedAt: "2026-09-14T10:00:00.000Z",
      roles: ["ADMIN"],
    });
    expect(response.body).not.toContain("credential");
    expect(response.body).not.toContain("secret");
  });

  it("uses the shared database rate bucket before issuing MFA challenges", async () => {
    const fixture = createFixture("ACTIVE", 6);
    const response = await fixture.app.inject({
      method: "POST",
      payload: { purpose: "PRIVILEGED_SESSION" },
      url: ADMIN_AUTH_API_PATHS.challenge,
    });

    expect(response.statusCode).toBe(429);
    expect(fixture.persistence.consumeRateLimit).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ limit: 5, scope: "admin-mfa-user" }),
    );
    expect(fixture.persistence.consumeRateLimit).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ limit: 30, scope: "admin-mfa-ip" }),
    );
    expect(fixture.service.beginMfa).not.toHaveBeenCalled();
  });

  it("keeps the account bucket stable across IP rotation and a separate looser IP ceiling", async () => {
    const fixture = createFixture("ACTIVE");
    await fixture.app.inject({
      method: "POST",
      payload: { purpose: "PRIVILEGED_SESSION" },
      remoteAddress: "198.51.100.10",
      url: ADMIN_AUTH_API_PATHS.challenge,
    });
    await fixture.app.inject({
      method: "POST",
      payload: { purpose: "PRIVILEGED_SESSION" },
      remoteAddress: "198.51.100.11",
      url: ADMIN_AUTH_API_PATHS.challenge,
    });

    const calls = fixture.persistence.consumeRateLimit.mock.calls;
    expect(calls[0]?.[0].scope).toBe("admin-mfa-user");
    expect(calls[2]?.[0].scope).toBe("admin-mfa-user");
    expect(calls[0]?.[0].keyDigest).toBe(calls[2]?.[0].keyDigest);
    expect(calls[1]?.[0].scope).toBe("admin-mfa-ip");
    expect(calls[3]?.[0].scope).toBe("admin-mfa-ip");
    expect(calls[1]?.[0].keyDigest).not.toBe(calls[3]?.[0].keyDigest);
    expect(calls[1]?.[0].limit).toBeGreaterThan(calls[0]?.[0].limit ?? 0);
  });

  it("binds successful MFA verification to the current opaque base session", async () => {
    const fixture = createFixture("ACTIVE");
    fixture.service.verifyMfa.mockResolvedValue({ status: "VERIFIED" });
    const response = await fixture.app.inject({
      method: "POST",
      payload: {
        challengeToken: "a".repeat(43),
        response: "123456",
      },
      url: ADMIN_AUTH_API_PATHS.verify,
    });

    expect(response.statusCode).toBe(204);
    expect(fixture.service.verifyMfa).toHaveBeenCalledWith({
      challengeToken: "a".repeat(43),
      response: "123456",
      sessionId: "fresh-post-mfa-session-id",
      userId: USER_ID,
    });
  });
});

function createFixture(identity: "ACTIVE" | "ANONYMOUS", rateCurrent = 1) {
  const app = Fastify({ logger: false });
  apps.push(app);
  app.decorate(
    "csrfProtection",
    (
      _request: FastifyRequest,
      _reply: unknown,
      done: (error?: Error) => void,
    ) => done(),
  );
  app.addHook("onRequest", (request, _reply, done) => {
    const session = {
      regenerate: vi.fn(() => {
        session.sessionId = "fresh-post-mfa-session-id";
        return Promise.resolve();
      }),
      save: vi.fn(() => Promise.resolve()),
      sessionId: "opaque-base-session-id",
    };
    Object.defineProperty(request, "session", {
      configurable: true,
      value: session,
    });
    done();
  });
  const service = {
    authorize: vi.fn<AdminAccessService["authorize"]>(),
    beginMfa: vi.fn<AdminAccessService["beginMfa"]>(),
    changeRole: vi.fn<AdminAccessService["changeRole"]>(),
    revokeSession: vi.fn<AdminAccessService["revokeSession"]>(),
    verifyMfa: vi.fn<AdminAccessService["verifyMfa"]>(),
  };
  service.beginMfa.mockResolvedValue({ status: "NOT_ELIGIBLE" });
  const persistence = {
    consumeRateLimit: vi
      .fn<AuthPersistence["consumeRateLimit"]>()
      .mockResolvedValue({ current: rateCurrent, ttlMs: 60_000 }),
  };
  registerAdminAuthRoutes(app, {
    config: {
      rateLimitMax: 10,
      rateLimitWindowMs: 60_000,
      sessionSecret: "test-session-secret-with-more-than-thirty-two-characters",
    },
    guard: {
      evaluate: vi
        .fn()
        .mockResolvedValue(
          identity === "ACTIVE"
            ? { status: "ACTIVE", user: activeUser }
            : { status: "AUTHENTICATION_REQUIRED" },
        ),
    },
    persistence,
    service,
  });
  return { app, persistence, service };
}
