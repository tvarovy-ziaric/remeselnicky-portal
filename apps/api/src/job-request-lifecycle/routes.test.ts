import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import {
  createJobRequestLifecycleService,
  type JobRequestId,
  type JobRequestLifecyclePersistence,
  type UserId,
} from "@portal/domain";

import {
  JOB_REQUEST_LIFECYCLE_PATHS,
  registerJobRequestLifecycleRoutes,
} from "./routes.js";

const actor = "9b000000-0000-4000-8000-000000000001" as UserId;
const requestId = "9b000000-0000-4000-8000-000000000002" as JobRequestId;
const commandId = "9b000000-0000-4000-8000-000000000003";
const now = new Date("2026-09-15T08:00:00Z");

describe("job request lifecycle routes", () => {
  it("cancels with CSRF-protected, private lifecycle output", async () => {
    const fixture = createFixture();
    const app = Fastify();
    registerJobRequestLifecycleRoutes(app, fixture.dependencies);
    const response = await app.inject({
      method: "POST",
      payload: { commandId, expectedRevision: 3, reason: "PLANS_CHANGED" },
      url: path(JOB_REQUEST_LIFECYCLE_PATHS.cancel),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({
      cancellationReason: "PLANS_CHANGED",
      state: "CANCELLED",
      status: "APPLIED",
    });
    expect(fixture.cancelOwned).toHaveBeenCalledWith({
      actorUserId: actor,
      commandId,
      expectedRevision: 3,
      jobRequestId: requestId,
      reason: "PLANS_CHANGED",
    });
    await app.close();
  });

  it("lists bounded operational status including warning time", async () => {
    const fixture = createFixture();
    const app = Fastify();
    registerJobRequestLifecycleRoutes(app, fixture.dependencies);
    const response = await app.inject({
      method: "GET",
      url: JOB_REQUEST_LIFECYCLE_PATHS.collection,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      requests: [{ id: requestId, warningAt: "2026-10-08T08:00:00.000Z" }],
    });
    await app.close();
  });

  it("creates a new draft identifier without returning copied private content", async () => {
    const fixture = createFixture();
    const app = Fastify();
    registerJobRequestLifecycleRoutes(app, fixture.dependencies);
    const response = await app.inject({
      method: "POST",
      payload: { commandId },
      url: path(JOB_REQUEST_LIFECYCLE_PATHS.duplicate),
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      id: requestId,
      revision: 2,
      status: "APPLIED",
    });
    expect(JSON.stringify(response.json())).not.toContain("description");
    await app.close();
  });

  it("maps active limits and authentication failures without mutation", async () => {
    const fixture = createFixture();
    fixture.reactivateOwned.mockResolvedValueOnce({
      activeLimit: 5,
      status: "ACTIVE_LIMIT_REACHED",
    });
    const app = Fastify();
    registerJobRequestLifecycleRoutes(app, fixture.dependencies);
    const limited = await app.inject({
      method: "POST",
      payload: { commandId, expectedRevision: 4 },
      url: path(JOB_REQUEST_LIFECYCLE_PATHS.reactivate),
    });
    expect(limited.statusCode).toBe(409);
    expect(limited.json()).toEqual({
      activeLimit: 5,
      code: "ACTIVE_LIMIT_REACHED",
    });
    await app.close();

    const deniedFixture = createFixture("AUTHENTICATION_REQUIRED");
    const deniedApp = Fastify();
    registerJobRequestLifecycleRoutes(deniedApp, deniedFixture.dependencies);
    const denied = await deniedApp.inject({
      method: "POST",
      payload: { commandId, expectedRevision: 3 },
      url: path(JOB_REQUEST_LIFECYCLE_PATHS.extend),
    });
    expect(denied.statusCode).toBe(401);
    expect(deniedFixture.extendOwned).not.toHaveBeenCalled();
    await deniedApp.close();
  });
});

function createFixture(
  status: "ACTIVE" | "AUTHENTICATION_REQUIRED" = "ACTIVE",
) {
  const lifecycle = lifecycleRecord();
  const cancelOwned = vi.fn().mockResolvedValue({
    jobRequest: {
      ...lifecycle,
      cancellationReason: "PLANS_CHANGED",
      state: "CANCELLED",
    },
    status: "APPLIED",
  });
  const duplicateOwned = vi.fn().mockResolvedValue({
    jobRequestId: requestId,
    revision: 2,
    sections: [{ description: "must not leave service" }],
    status: "APPLIED",
  });
  const extendOwned = vi.fn().mockResolvedValue({
    jobRequest: lifecycle,
    status: "APPLIED",
  });
  const reactivateOwned = vi.fn().mockResolvedValue({
    jobRequest: lifecycle,
    status: "APPLIED",
  });
  const persistence: JobRequestLifecyclePersistence = {
    cancelOwned,
    duplicateOwned,
    expireInactive: vi.fn().mockResolvedValue([]),
    extendOwned,
    listOwned: vi
      .fn()
      .mockResolvedValue({ requests: [lifecycle], status: "OK" }),
    reactivateOwned,
  };
  return {
    cancelOwned,
    dependencies: {
      csrfProtection: (_request: unknown, _reply: unknown, done: () => void) =>
        done(),
      guard: {
        evaluate: () =>
          Promise.resolve(
            status === "ACTIVE"
              ? { status: "ACTIVE" as const, user: { id: actor } }
              : { status: "AUTHENTICATION_REQUIRED" as const },
          ),
      },
      lifecycle: createJobRequestLifecycleService({ persistence }),
    },
    extendOwned,
    reactivateOwned,
  };
}

function lifecycleRecord() {
  return {
    activatedAt: now,
    cancellationReason: null,
    changedAt: now,
    createdAt: now,
    customerProfileId: "9b000000-0000-4000-8000-000000000004",
    expiresAt: new Date("2026-10-15T08:00:00Z"),
    id: requestId,
    revision: 4,
    state: "ACTIVE" as const,
    warningAt: new Date("2026-10-08T08:00:00Z"),
  };
}

function path(template: string): string {
  return template.replace(":jobRequestId", requestId);
}
