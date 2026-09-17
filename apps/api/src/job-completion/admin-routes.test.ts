import type { PrivilegedActor } from "@portal/admin-auth";
import type { UserId } from "@portal/domain";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ADMIN_JOB_COMPLETION_PATH,
  registerAdminJobCompletionRoutes,
} from "./admin-routes.js";

const adminId = "a9600000-0000-4000-8000-000000000001" as UserId;
const jobId = "a9600000-0000-4000-8000-000000000002";
const commandId = "a9600000-0000-4000-8000-000000000003";
const path = ADMIN_JOB_COMPLETION_PATH.replace(":jobId", jobId);
const body = {
  commandId,
  expectedState: "IN_PROGRESS" as const,
  reason: "Výnimka po preverení odovzdania práce.",
};
const actor: PrivilegedActor = {
  capabilities: new Set(["admin.jobs.correct"]),
  mfaAuthenticatedAt: new Date("2026-09-17T10:00:00.000Z"),
  roles: ["ADMIN"],
  userId: adminId,
};
const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function fixture(input?: {
  identity?: "ACTIVE" | "ANONYMOUS";
  csrf?: boolean;
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
  const forceComplete = vi.fn().mockResolvedValue({
    status: "APPLIED",
    commandId,
    recordedAt: new Date("2026-09-17T10:05:00.000Z"),
  });
  registerAdminJobCompletionRoutes(app, {
    adminAccess: { authorize },
    completion: { forceComplete },
    guard: {
      evaluate: vi
        .fn()
        .mockResolvedValue(
          input?.identity === "ANONYMOUS"
            ? { status: "AUTHENTICATION_REQUIRED" }
            : { status: "ACTIVE", user: { id: adminId } },
        ),
    },
    csrfProtection: (_request, reply, done) => {
      if (input?.csrf === false) {
        void reply.code(403).send({ code: "CSRF_DENIED" });
        return;
      }
      done();
    },
    rateLimit: { max: 20, timeWindowMs: 60_000 },
  });
  return { app, authorize, forceComplete };
}

describe("separate administrative Job completion", () => {
  it("requires a recent MFA-backed correction capability and preserves admin provenance", async () => {
    const { app, authorize, forceComplete } = fixture();
    const response = await app.inject({
      method: "POST",
      url: path,
      payload: body,
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({
      status: "APPLIED",
      jobState: "COMPLETED",
      commandId,
    });
    expect(authorize).toHaveBeenCalledWith({
      capability: "admin.jobs.correct",
      requireRecentMfa: true,
      sessionId: "opaque-privileged-session",
      userId: adminId,
    });
    expect(forceComplete).toHaveBeenCalledWith({
      actor,
      privilegedSessionId: "opaque-privileged-session",
      ...body,
      jobId,
    });
  });

  it("fails closed for anonymous, CSRF failure, missing capability and extra fields", async () => {
    const anonymous = fixture({ identity: "ANONYMOUS" });
    expect(
      (await anonymous.app.inject({ method: "POST", url: path, payload: body }))
        .statusCode,
    ).toBe(401);
    expect(anonymous.forceComplete).not.toHaveBeenCalled();
    const csrf = fixture({ csrf: false });
    expect(
      (await csrf.app.inject({ method: "POST", url: path, payload: body }))
        .statusCode,
    ).toBe(403);
    const denied = fixture();
    denied.authorize.mockResolvedValue({ status: "MFA_TOO_OLD" });
    expect(
      (await denied.app.inject({ method: "POST", url: path, payload: body }))
        .statusCode,
    ).toBe(403);
    expect(denied.forceComplete).not.toHaveBeenCalled();
    const extra = fixture();
    expect(
      (
        await extra.app.inject({
          method: "POST",
          url: path,
          payload: { ...body, customerUserId: adminId },
        })
      ).statusCode,
    ).toBe(400);
    expect(extra.forceComplete).not.toHaveBeenCalled();
  });
});
