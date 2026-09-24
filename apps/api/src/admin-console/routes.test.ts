import type { AdminAccessService, PrivilegedActor } from "@portal/admin-auth";
import type { UserId } from "@portal/domain";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthUser } from "../auth/types.js";
import { ADMIN_CONSOLE_BASE_PATH } from "./model.js";
import { registerAdminConsoleRoutes } from "./routes.js";

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

describe("admin console routes", () => {
  it("denies an unauthenticated request before privileged authorization", async () => {
    const fixture = createFixture("ANONYMOUS", adminActor());
    const response = await fixture.app.inject({
      method: "GET",
      url: ADMIN_CONSOLE_BASE_PATH,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ code: "AUTHENTICATION_REQUIRED" });
    expect(fixture.authorize).not.toHaveBeenCalled();
  });

  it("denies a suspended user even if an old privileged session remains", async () => {
    const fixture = createFixture("SUSPENDED", adminActor());
    const response = await fixture.app.inject({
      method: "GET",
      url: ADMIN_CONSOLE_BASE_PATH,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ code: "ACCOUNT_NOT_ACTIVE" });
    expect(fixture.authorize).not.toHaveBeenCalled();
  });

  it.each(["AUTHENTICATION_REQUIRED", "MFA_TOO_OLD"] as const)(
    "fails closed for a %s privileged-session decision",
    async (decision) => {
      const fixture = createFixture("ACTIVE", undefined, decision);
      const response = await fixture.app.inject({
        method: "GET",
        url: ADMIN_CONSOLE_BASE_PATH,
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ code: "PRIVILEGED_ACCESS_DENIED" });
    },
  );

  it("returns only modules allowed to a normal ADMIN", async () => {
    const fixture = createFixture("ACTIVE", adminActor());
    const response = await fixture.app.inject({
      method: "GET",
      url: ADMIN_CONSOLE_BASE_PATH,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
    const ids = response
      .json<{ modules: { id: string }[] }>()
      .modules.map(({ id }) => id);
    expect(ids).toContain("dashboard");
    expect(ids).toContain("profiles");
    expect(ids).not.toContain("audit");
    expect(response.body).not.toMatch(/password|sql|impersonat/iu);
  });

  it("allows SUPER_ADMIN to open a capability-protected audit deep link", async () => {
    const fixture = createFixture("ACTIVE", superAdminActor());
    const response = await fixture.app.inject({
      method: "GET",
      url: `${ADMIN_CONSOLE_BASE_PATH}/modules/audit`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      description: "Nemenná história privilegovaných operácií.",
      id: "audit",
      label: "Audit",
      state: "PLACEHOLDER",
    });
    expect(fixture.authorize).toHaveBeenCalledWith(
      expect.objectContaining({ capability: "admin.sensitive.read" }),
    );
  });

  it("denies an ADMIN audit deep link at the backend", async () => {
    const fixture = createFixture("ACTIVE", adminActor());
    const response = await fixture.app.inject({
      method: "GET",
      url: `${ADMIN_CONSOLE_BASE_PATH}/modules/audit`,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ code: "PRIVILEGED_ACCESS_DENIED" });
  });

  it("marks implemented dispute and Job modules as operational", async () => {
    const fixture = createFixture("ACTIVE", adminActor());
    for (const moduleId of ["disputes", "jobs"] as const) {
      const response = await fixture.app.inject({
        method: "GET",
        url: `${ADMIN_CONSOLE_BASE_PATH}/modules/${moduleId}`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        id: moduleId,
        state: "OPERATIONAL",
      });
    }
  });

  it("fails closed if a service returns an actor for a different identity", async () => {
    const actor = adminActor();
    const fixture = createFixture("ACTIVE", {
      ...actor,
      userId: "22222222-2222-4222-8222-222222222222" as UserId,
    });
    const response = await fixture.app.inject({
      method: "GET",
      url: ADMIN_CONSOLE_BASE_PATH,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ code: "PRIVILEGED_ACCESS_DENIED" });
  });

  it("does not reveal whether an unknown module exists behind a capability", async () => {
    const fixture = createFixture("ACTIVE", superAdminActor());
    const response = await fixture.app.inject({
      method: "GET",
      url: `${ADMIN_CONSOLE_BASE_PATH}/modules/raw-database`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ code: "NOT_FOUND" });
    expect(fixture.authorize).not.toHaveBeenCalled();
  });
});

function createFixture(
  identity: "ACTIVE" | "ANONYMOUS" | "SUSPENDED",
  actor?: PrivilegedActor,
  deniedStatus:
    | "AUTHENTICATION_REQUIRED"
    | "MFA_TOO_OLD"
    | "CAPABILITY_DENIED" = "CAPABILITY_DENIED",
) {
  const app = Fastify({ logger: false });
  apps.push(app);
  app.addHook("onRequest", (request, _reply, done) => {
    Object.defineProperty(request, "session", {
      configurable: true,
      value: { sessionId: "opaque-session-id" },
    });
    done();
  });
  const authorize = vi.fn<AdminAccessService["authorize"]>();
  authorize.mockImplementation(({ capability }) => {
    if (actor === undefined || !actor.capabilities.has(capability)) {
      return Promise.resolve({ status: deniedStatus });
    }
    return Promise.resolve({ actor, status: "AUTHORIZED" });
  });
  registerAdminConsoleRoutes(app, {
    guard: {
      evaluate: vi
        .fn()
        .mockResolvedValue(
          identity === "ANONYMOUS"
            ? { status: "AUTHENTICATION_REQUIRED" }
            : identity === "SUSPENDED"
              ? { status: "ACCOUNT_NOT_ACTIVE" }
              : { status: "ACTIVE", user: activeUser },
        ),
    },
    service: { authorize },
  });
  return { app, authorize };
}

function adminActor(): PrivilegedActor {
  return {
    capabilities: new Set([
      "admin.access",
      "admin.credentials.review",
      "admin.disputes.manage",
      "admin.jobs.correct",
      "admin.profiles.review",
      "admin.reviews.moderate",
      "admin.users.manage",
    ]),
    mfaAuthenticatedAt: new Date("2026-09-14T10:00:00.000Z"),
    roles: ["ADMIN"],
    userId: USER_ID,
  };
}

function superAdminActor(): PrivilegedActor {
  return {
    capabilities: new Set([
      ...adminActor().capabilities,
      "admin.sensitive.read",
    ]),
    mfaAuthenticatedAt: new Date("2026-09-14T10:00:00.000Z"),
    roles: ["SUPER_ADMIN"],
    userId: USER_ID,
  };
}
