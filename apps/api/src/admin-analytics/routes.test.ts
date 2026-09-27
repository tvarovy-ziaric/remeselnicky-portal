import type { PrivilegedActor } from "@portal/admin-auth";
import type { AlphaAnalyticsDashboardRepository } from "@portal/db";
import type { UserId } from "@portal/domain";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthUser } from "../auth/types.js";
import {
  ADMIN_ALPHA_ANALYTICS_PATH,
  registerAdminAnalyticsRoutes,
} from "./routes.js";

const USER_ID = "11111111-1111-4111-8111-111111111111" as UserId;
const activeUser: AuthUser = {
  activeModerationScopes: [],
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

describe("admin alpha analytics route", () => {
  it("returns only the versioned aggregate behind active admin access", async () => {
    const dashboard = emptyDashboard();
    const fixture = createFixture("ACTIVE", adminActor(), dashboard);
    const response = await fixture.app.inject({
      method: "GET",
      url: `${ADMIN_ALPHA_ANALYTICS_PATH}?from=2026-09-01T00%3A00%3A00.000Z&to=2026-10-01T00%3A00%3A00.000Z`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(response.json()).toEqual({
      dashboard,
      range: {
        from: "2026-09-01T00:00:00.000Z",
        to: "2026-10-01T00:00:00.000Z",
      },
    });
    expect(fixture.load).toHaveBeenCalledWith({
      from: new Date("2026-09-01T00:00:00.000Z"),
      to: new Date("2026-10-01T00:00:00.000Z"),
    });
    expect(fixture.authorize).toHaveBeenCalledWith(
      expect.objectContaining({ capability: "admin.access" }),
    );
    expect(response.body).not.toMatch(/email|phone|address|comment|message/iu);
  });

  it("denies anonymous/inactive/unprivileged requests before reading facts", async () => {
    for (const identity of ["ANONYMOUS", "SUSPENDED", "ACTIVE"] as const) {
      const fixture = createFixture(
        identity,
        identity === "ACTIVE" ? undefined : adminActor(),
        emptyDashboard(),
      );
      const response = await fixture.app.inject({
        method: "GET",
        url: `${ADMIN_ALPHA_ANALYTICS_PATH}?from=2026-09-01T00%3A00%3A00.000Z&to=2026-10-01T00%3A00%3A00.000Z`,
      });
      expect(response.statusCode).toBe(identity === "ANONYMOUS" ? 401 : 403);
      expect(fixture.load).not.toHaveBeenCalled();
    }
  });

  it("rejects non-canonical, reversed, oversized and unknown query input", async () => {
    const fixture = createFixture("ACTIVE", adminActor(), emptyDashboard());
    for (const query of [
      "from=2026-09-01&to=2026-10-01",
      "from=2026-10-01T00%3A00%3A00.000Z&to=2026-09-01T00%3A00%3A00.000Z",
      "from=2025-01-01T00%3A00%3A00.000Z&to=2026-10-01T00%3A00%3A00.000Z",
      "from=2026-09-01T00%3A00%3A00.000Z&to=2026-10-01T00%3A00%3A00.000Z&email=x",
    ]) {
      const response = await fixture.app.inject({
        method: "GET",
        url: `${ADMIN_ALPHA_ANALYTICS_PATH}?${query}`,
      });
      expect(response.statusCode).toBe(400);
    }
    expect(fixture.load).not.toHaveBeenCalled();
  });
});

function createFixture(
  identity: "ACTIVE" | "ANONYMOUS" | "SUSPENDED",
  actor: PrivilegedActor | undefined,
  dashboard: ReturnType<typeof emptyDashboard>,
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
  const authorize = vi
    .fn()
    .mockResolvedValue(
      actor === undefined
        ? { status: "CAPABILITY_DENIED" }
        : { actor, status: "AUTHORIZED" },
    );
  const load = vi.fn().mockResolvedValue(dashboard);
  registerAdminAnalyticsRoutes(app, {
    analytics: {
      load,
      recordProfileOpen: vi.fn(),
      recordSearch: vi.fn(),
    } satisfies AlphaAnalyticsDashboardRepository,
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
  return { app, authorize, load };
}

function adminActor(): PrivilegedActor {
  return {
    capabilities: new Set(["admin.access"]),
    mfaAuthenticatedAt: new Date("2026-09-14T10:00:00.000Z"),
    roles: ["ADMIN"],
    userId: USER_ID,
  };
}

function emptyDashboard() {
  return {
    core_funnel: [],
    definition_version: "D28_ALPHA_V1" as const,
    generated_at: "2026-10-01T00:00:00.000Z",
    quality_process: [],
    review: [],
    search_liquidity: [],
    speed: [],
    supply: [],
  };
}
