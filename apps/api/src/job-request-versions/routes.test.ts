import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import {
  createJobRequestVersionService,
  normalizeJobRequestContentSection,
  type JobRequestId,
  type UserId,
} from "@portal/domain";

import { registerJobRequestVersionRoutes } from "./routes.js";

const actor = "99000000-0000-4000-8000-000000000001" as UserId;
const requestId = "99000000-0000-4000-8000-000000000003" as JobRequestId;
const commandId = "99000000-0000-4000-8000-000000000004";
const changedAt = new Date("2026-09-15T10:00:00Z");

describe("active job request version routes", () => {
  it("returns a private exact historical snapshot", async () => {
    const fixture = createFixture();
    const app = Fastify();
    registerJobRequestVersionRoutes(app, fixture.dependencies);
    const response = await app.inject({
      method: "GET",
      url: `/v1/me/job-requests/${requestId}/versions/1`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({
      sections: [{ key: "request.core" }],
      version: { contentRevision: 1, visibleVersion: 1 },
    });
    expect(fixture.read).toHaveBeenCalledWith({
      actorUserId: actor,
      contentRevision: 1,
      jobRequestId: requestId,
    });
    await app.close();
  });

  it("normalizes a revision command and returns material provenance", async () => {
    const fixture = createFixture();
    const app = Fastify();
    registerJobRequestVersionRoutes(app, fixture.dependencies);
    const response = await app.inject({
      method: "POST",
      payload: {
        commandId,
        expectedContentRevision: 1,
        section: core({ description: "  Výmena celej strechy  " }),
      },
      url: `/v1/me/job-requests/${requestId}/sections`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      categories: ["SCOPE"],
      contentRevision: 2,
      material: true,
      status: "APPLIED",
      visibleVersion: 2,
    });
    expect(fixture.revise.mock.calls[0]?.[0]).toMatchObject({
      section: { payload: { description: "Výmena celej strechy" } },
    });
    await app.close();
  });

  it("fails closed for unauthenticated and malformed requests", async () => {
    const fixture = createFixture("AUTHENTICATION_REQUIRED");
    const app = Fastify();
    registerJobRequestVersionRoutes(app, fixture.dependencies);
    const denied = await app.inject({
      method: "GET",
      url: `/v1/me/job-requests/${requestId}`,
    });
    expect(denied.statusCode).toBe(401);
    expect(fixture.read).not.toHaveBeenCalled();
    const malformed = await app.inject({
      method: "POST",
      payload: {
        commandId,
        expectedContentRevision: 1,
        section: { ...core(), payload: { arbitrary: "leak" } },
      },
      url: `/v1/me/job-requests/${requestId}/sections`,
    });
    expect(malformed.statusCode).toBe(401);
    expect(fixture.revise).not.toHaveBeenCalled();
    await app.close();

    const active = createFixture();
    const activeApp = Fastify();
    registerJobRequestVersionRoutes(activeApp, active.dependencies);
    const invalid = await activeApp.inject({
      method: "POST",
      payload: {
        commandId,
        expectedContentRevision: 1,
        section: { ...core(), payload: { arbitrary: "leak" } },
      },
      url: `/v1/me/job-requests/${requestId}/sections`,
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ code: "INVALID_REQUEST" });
    expect(active.revise).not.toHaveBeenCalled();
    await activeApp.close();
  });
});

function createFixture(
  guardStatus: "ACTIVE" | "AUTHENTICATION_REQUIRED" = "ACTIVE",
) {
  const section = normalizeJobRequestContentSection(core());
  const read = vi.fn().mockResolvedValue({
    snapshot: {
      sections: [section],
      version: version(1, 1, [], false),
    },
    status: "OK",
  });
  const revise = vi.fn().mockResolvedValue({
    status: "APPLIED",
    version: version(2, 2, ["SCOPE"], true),
  });
  return {
    dependencies: {
      csrfProtection: (_request: unknown, _reply: unknown, done: () => void) =>
        done(),
      guard: {
        evaluate: () =>
          Promise.resolve(
            guardStatus === "ACTIVE"
              ? { status: "ACTIVE" as const, user: { id: actor } }
              : { status: "AUTHENTICATION_REQUIRED" as const },
          ),
      },
      versions: createJobRequestVersionService({
        persistence: { readActiveOwned: read, reviseActiveOwned: revise },
      }),
    },
    read,
    revise,
  };
}

function core(overrides: Record<string, unknown> = {}) {
  return {
    key: "request.core",
    payload: {
      description: "Oprava strechy",
      primaryProfessionCode: null,
      relatedProfessionCodes: [],
      skillCodes: [],
      specializationCode: null,
      title: "Strecha",
      ...overrides,
    },
    schemaVersion: 1,
  };
}

function version(
  contentRevision: number,
  visibleVersion: number,
  categories: readonly never[] | readonly ["SCOPE"],
  material: boolean,
) {
  return {
    categories,
    changedAt,
    contentRevision,
    jobRequestId: requestId,
    material,
    visibleVersion,
  };
}
