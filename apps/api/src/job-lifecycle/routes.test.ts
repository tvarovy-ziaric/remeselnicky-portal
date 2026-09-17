import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type HookHandlerDoneFunction,
} from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { JobLifecycleIdempotencyError } from "@portal/db";
import type { UserId } from "@portal/domain";

import {
  JOB_CANCEL_PATH,
  JOB_START_PATH,
  registerJobLifecycleRoutes,
} from "./routes.js";

const actorUserId = "86200000-0000-4000-8000-000000000001" as UserId;
const jobId = "86200000-0000-4000-8000-000000000004";
const commandId = "86200000-0000-4000-8000-000000000005";
const startUrl = JOB_START_PATH.replace(":jobId", jobId);
const cancelUrl = JOB_CANCEL_PATH.replace(":jobId", jobId);
const recordedAt = new Date("2026-09-16T18:00:00.000Z");
const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function build(input?: {
  status?: "ACTIVE" | "ACCOUNT_NOT_ACTIVE" | "AUTHENTICATION_REQUIRED";
  csrf?: (
    request: FastifyRequest,
    reply: FastifyReply,
    done: HookHandlerDoneFunction,
  ) => void;
  start?: ReturnType<typeof vi.fn>;
  cancel?: ReturnType<typeof vi.fn>;
}) {
  const app = Fastify();
  const start =
    input?.start ?? vi.fn(() => Promise.resolve({ status: "NOT_FOUND" }));
  const cancel =
    input?.cancel ?? vi.fn(() => Promise.resolve({ status: "NOT_FOUND" }));
  registerJobLifecycleRoutes(app, {
    lifecycle: { start, cancel },
    csrfProtection: input?.csrf ?? ((_request, _reply, done) => done()),
    guard: {
      evaluate: () =>
        Promise.resolve(
          input?.status === "ACCOUNT_NOT_ACTIVE" ||
            input?.status === "AUTHENTICATION_REQUIRED"
            ? { status: input.status }
            : { status: "ACTIVE", user: { id: actorUserId } },
        ),
    },
    rateLimit: { max: 10, timeWindowMs: 60_000 },
  });
  apps.push(app);
  return { app, start, cancel };
}

describe("Job lifecycle HTTP commands", () => {
  it("derives the provider actor from the session and requires CSRF", async () => {
    const start = vi.fn(() =>
      Promise.resolve({
        recordedAt,
        state: "IN_PROGRESS" as const,
        status: "APPLIED" as const,
      }),
    );
    const csrf = vi.fn(
      (
        _request: FastifyRequest,
        _reply: FastifyReply,
        done: HookHandlerDoneFunction,
      ) => done(),
    );
    const { app } = build({ csrf, start });
    const response = await app.inject({
      method: "POST",
      payload: { commandId },
      url: startUrl,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      recordedAt: recordedAt.toISOString(),
      state: "IN_PROGRESS",
      status: "APPLIED",
    });
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(csrf).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledWith({ actorUserId, commandId, jobId });
  });

  it("denies anonymous, inactive and CSRF-rejected writes", async () => {
    const start = vi.fn(() =>
      Promise.resolve({ status: "NOT_FOUND" as const }),
    );
    for (const [status, expected] of [
      ["AUTHENTICATION_REQUIRED", 401],
      ["ACCOUNT_NOT_ACTIVE", 403],
    ] as const) {
      const { app } = build({ start, status });
      const response = await app.inject({
        method: "POST",
        payload: { commandId },
        url: startUrl,
      });
      expect(response.statusCode).toBe(expected);
    }
    const { app } = build({
      csrf: (_request, reply) => {
        void reply.code(403).send({ code: "CSRF_REJECTED" });
      },
      start,
    });
    const rejected = await app.inject({
      method: "POST",
      payload: { commandId },
      url: startUrl,
    });
    expect(rejected.statusCode).toBe(403);
    expect(start).not.toHaveBeenCalled();
  });

  it("validates exact command bodies and maps denial/stale/idempotency", async () => {
    const cancel = vi.fn(() =>
      Promise.resolve({ status: "STALE_STATE" as const }),
    );
    const { app } = build({ cancel });
    const body = {
      commandId,
      expectedState: "IN_PROGRESS",
      reason: "Zákazník ukončil práce.",
    };
    for (const payload of [
      { ...body, extra: "unsafe" },
      { ...body, reason: "short" },
      { ...body, expectedState: "CANCELLED" },
    ]) {
      expect(
        (await app.inject({ method: "POST", payload, url: cancelUrl }))
          .statusCode,
      ).toBe(400);
    }
    expect(cancel).not.toHaveBeenCalled();
    const stale = await app.inject({
      method: "POST",
      payload: body,
      url: cancelUrl,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ code: "STALE_STATE" });
    expect(cancel).toHaveBeenCalledWith({ ...body, actorUserId, jobId });
  });

  it("redacts internal failures and reports command ID conflicts", async () => {
    const start = vi.fn(() =>
      Promise.reject(new JobLifecycleIdempotencyError("private intent")),
    );
    const conflict = build({ start });
    const response = await conflict.app.inject({
      method: "POST",
      payload: { commandId },
      url: startUrl,
    });
    expect(response.statusCode).toBe(409);
    expect(response.body).not.toContain("private intent");
    const unavailable = build({
      start: vi.fn(() => Promise.reject(new Error("private database state"))),
    });
    const failure = await unavailable.app.inject({
      method: "POST",
      payload: { commandId },
      url: startUrl,
    });
    expect(failure.statusCode).toBe(503);
    expect(failure.body).not.toContain("private database state");
  });
});
