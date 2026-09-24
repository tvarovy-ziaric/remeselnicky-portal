import type { PrivilegedActor } from "@portal/admin-auth";
import type { UserId } from "@portal/domain";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ADMIN_JOB_CANCELLATION_PATH,
  registerAdminJobCancellationRoutes,
} from "./admin-cancel-routes.js";

const adminId = "a9800000-0000-4000-8000-000000000001" as UserId;
const jobId = "a9800000-0000-4000-8000-000000000002";
const commandId = "a9800000-0000-4000-8000-000000000003";
const actor: PrivilegedActor = {
  capabilities: new Set(["admin.jobs.correct"]),
  mfaAuthenticatedAt: new Date(),
  roles: ["ADMIN"],
  userId: adminId,
};
const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function fixture(authorized = true) {
  const app = Fastify();
  apps.push(app);
  app.addHook("onRequest", (request, _reply, done) => {
    Object.defineProperty(request, "session", {
      configurable: true,
      value: { sessionId: "opaque-privileged-session" },
    });
    done();
  });
  const authorize = vi
    .fn()
    .mockResolvedValue(
      authorized ? { status: "AUTHORIZED", actor } : { status: "MFA_TOO_OLD" },
    );
  const forceCancel = vi.fn().mockResolvedValue({
    status: "APPLIED",
    commandId,
    recordedAt: new Date("2026-09-24T10:00:00.000Z"),
  });
  registerAdminJobCancellationRoutes(app, {
    adminAccess: { authorize },
    cancellation: { forceCancel },
    guard: {
      evaluate: vi
        .fn()
        .mockResolvedValue({ status: "ACTIVE", user: { id: adminId } }),
    },
    csrfProtection: (_request, _reply, done) => done(),
    rateLimit: { max: 20, timeWindowMs: 60_000 },
  });
  return { app, authorize, forceCancel };
}

describe("explicit administrative Job cancellation", () => {
  it("requires recent correction authority and returns distinct admin provenance", async () => {
    const { app, authorize, forceCancel } = fixture();
    const payload = {
      commandId,
      expectedState: "IN_PROGRESS",
      reason: "Zrušenie po preverení závažnej prevádzkovej prekážky.",
      userFacingReason:
        "Zákazka bola administratívne zrušená po preverení prípadu.",
    };
    const response = await app.inject({
      method: "POST",
      url: ADMIN_JOB_CANCELLATION_PATH.replace(":jobId", jobId),
      payload,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      jobState: "CANCELLED",
      status: "APPLIED",
    });
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "admin.jobs.correct",
        requireRecentMfa: true,
      }),
    );
    expect(forceCancel).toHaveBeenCalledWith({
      actor,
      privilegedSessionId: "opaque-privileged-session",
      jobId,
      ...payload,
    });
  });

  it("fails closed when recent MFA authority is absent", async () => {
    const { app, forceCancel } = fixture(false);
    const response = await app.inject({
      method: "POST",
      url: ADMIN_JOB_CANCELLATION_PATH.replace(":jobId", jobId),
      payload: {
        commandId,
        expectedState: "CONFIRMED",
        reason: "Zrušenie po preverení prípadu.",
        userFacingReason: "Zákazka bola administratívne zrušená.",
      },
    });
    expect(response.statusCode).toBe(403);
    expect(forceCancel).not.toHaveBeenCalled();
  });
});
