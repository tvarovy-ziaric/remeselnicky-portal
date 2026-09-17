import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UserId } from "@portal/domain";
import { JobParticipantRoleDecisionIdempotencyError } from "@portal/db";

import {
  JOB_PARTICIPATION_ROLE_DECISION_PATHS,
  registerJobParticipationRoleDecisionRoutes,
} from "./routes.js";

const actorUserId = "86600000-0000-4000-8000-000000000001" as UserId;
const participantId = "86600000-0000-4000-8000-000000000002";
const assignmentEventId = "86600000-0000-4000-8000-000000000003";
const commandId = "86600000-0000-4000-8000-000000000004";
const decisionId = "86600000-0000-4000-8000-000000000005";
const assignedAt = new Date("2026-09-17T12:00:00.000Z");
const decidedAt = new Date("2026-09-17T13:00:00.000Z");
const pendingPath = JOB_PARTICIPATION_ROLE_DECISION_PATHS.pending.replace(
  ":participantId",
  participantId,
);
const decisionPath = JOB_PARTICIPATION_ROLE_DECISION_PATHS.decide
  .replace(":participantId", participantId)
  .replace(":assignmentEventId", assignmentEventId);
const apps: FastifyInstance[] = [];

afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function build(input?: {
  status?: "ACTIVE" | "ACCOUNT_NOT_ACTIVE" | "AUTHENTICATION_REQUIRED";
  listPending?: ReturnType<typeof vi.fn>;
  decide?: ReturnType<typeof vi.fn>;
  csrfDenied?: boolean;
}) {
  const app = Fastify();
  const listPending = input?.listPending ?? vi.fn(() => Promise.resolve(null));
  const decide =
    input?.decide ?? vi.fn(() => Promise.resolve({ status: "NOT_FOUND" }));
  registerJobParticipationRoleDecisionRoutes(app, {
    roles: { listPending, decide },
    csrfProtection: (_request, reply, done) =>
      input?.csrfDenied
        ? void reply.code(403).send({ code: "CSRF_INVALID" })
        : done(),
    guard: {
      evaluate: () =>
        Promise.resolve(
          input?.status === "ACCOUNT_NOT_ACTIVE" ||
            input?.status === "AUTHENTICATION_REQUIRED"
            ? { status: input.status }
            : { status: "ACTIVE", user: { id: actorUserId } },
        ),
    },
    rateLimit: { max: 20, timeWindowMs: 60_000 },
  });
  apps.push(app);
  return { app, listPending, decide };
}

describe("private Job participant role decision routes", () => {
  it("returns only the participant's pending assignments with private headers", async () => {
    const listPending = vi.fn(() =>
      Promise.resolve([
        { assignmentEventId, participantId, role: "LEAD", assignedAt },
      ]),
    );
    const { app } = build({ listPending });
    const response = await app.inject({ method: "GET", url: pendingPath });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(response.json()).toEqual({
      items: [
        {
          assignmentEventId,
          participantId,
          role: "LEAD",
          assignedAt: assignedAt.toISOString(),
        },
      ],
    });
    expect(listPending).toHaveBeenCalledWith({ actorUserId, participantId });
    expect(
      (await app.inject({ method: "GET", url: `${pendingPath}?all=true` }))
        .statusCode,
    ).toBe(400);
  });

  it("denies unauthenticated and inactive reads and writes before repository access", async () => {
    for (const status of [
      "AUTHENTICATION_REQUIRED",
      "ACCOUNT_NOT_ACTIVE",
    ] as const) {
      const { app, listPending, decide } = build({ status });
      const read = await app.inject({ method: "GET", url: pendingPath });
      const write = await app.inject({
        method: "POST",
        url: decisionPath,
        payload: { commandId, decision: "CONFIRM" },
      });
      const expectedStatus = status === "AUTHENTICATION_REQUIRED" ? 401 : 403;
      expect(read.statusCode).toBe(expectedStatus);
      expect(write.statusCode).toBe(expectedStatus);
      expect(listPending).not.toHaveBeenCalled();
      expect(decide).not.toHaveBeenCalled();
      expect(read.headers["cache-control"]).toBe("private, no-store");
      expect(write.headers["cache-control"]).toBe("private, no-store");
    }
  });

  it("uniformly hides unrelated and unknown participant reads and writes", async () => {
    const { app, decide } = build();
    const read = await app.inject({ method: "GET", url: pendingPath });
    const write = await app.inject({
      method: "POST",
      url: decisionPath,
      payload: { commandId, decision: "CONFIRM" },
    });
    expect(read.statusCode).toBe(404);
    expect(read.json()).toEqual({ code: "NOT_FOUND" });
    expect(write.statusCode).toBe(404);
    expect(write.json()).toEqual({ code: "NOT_FOUND" });
    expect(decide).toHaveBeenCalledWith({
      actorUserId,
      commandId,
      participantId,
      assignmentEventId,
      decision: "CONFIRM",
    });
  });

  it("confirms with a session-derived actor, exact body and CSRF", async () => {
    const decide = vi.fn(() =>
      Promise.resolve({
        status: "APPLIED",
        decisionId,
        decision: "CONFIRM",
        decidedAt,
      }),
    );
    const { app } = build({ decide });
    const response = await app.inject({
      method: "POST",
      url: decisionPath,
      payload: { commandId, decision: "CONFIRM" },
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.json()).toEqual({
      status: "APPLIED",
      decisionId,
      decision: "CONFIRM",
      decidedAt: decidedAt.toISOString(),
    });
    expect(decide).toHaveBeenCalledWith({
      actorUserId,
      commandId,
      participantId,
      assignmentEventId,
      decision: "CONFIRM",
    });
    const csrf = build({ csrfDenied: true });
    expect(
      (
        await csrf.app.inject({
          method: "POST",
          url: decisionPath,
          payload: { commandId, decision: "CONFIRM" },
        })
      ).statusCode,
    ).toBe(403);
    expect(csrf.decide).not.toHaveBeenCalled();
  });

  it("requires a correction reason and returns deduplicated result", async () => {
    const reason = "Rola vedúceho nezodpovedá skutočnosti.";
    const decide = vi.fn(() =>
      Promise.resolve({
        status: "DEDUPLICATED",
        decisionId,
        decision: "REQUEST_CORRECTION",
        decidedAt,
      }),
    );
    const { app } = build({ decide });
    const response = await app.inject({
      method: "POST",
      url: decisionPath,
      payload: { commandId, decision: "REQUEST_CORRECTION", reason },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "DEDUPLICATED",
      decisionId,
      decision: "REQUEST_CORRECTION",
      decidedAt: decidedAt.toISOString(),
    });
    expect(decide).toHaveBeenCalledWith({
      actorUserId,
      commandId,
      participantId,
      assignmentEventId,
      decision: "REQUEST_CORRECTION",
      reason,
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: decisionPath,
          payload: { commandId, decision: "REQUEST_CORRECTION" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: decisionPath,
          payload: { commandId, decision: "CONFIRM", reason },
        })
      ).statusCode,
    ).toBe(400);
  });

  it("rejects malformed IDs, extra body fields and invalid transitions", async () => {
    const { app, decide } = build();
    expect(
      (
        await app.inject({
          method: "GET",
          url: pendingPath.replace(participantId, "not-a-uuid"),
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: decisionPath.replace(assignmentEventId, "not-a-uuid"),
          payload: { commandId, decision: "CONFIRM" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: decisionPath,
          payload: { commandId, decision: "CONFIRM", actorUserId },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: decisionPath,
          payload: { commandId, decision: "REQUEST_CORRECTION", reason: "x" },
        })
      ).statusCode,
    ).toBe(400);
    expect(decide).not.toHaveBeenCalled();
    const stale = build({
      decide: vi.fn(() => Promise.resolve({ status: "STALE_STATE" })),
    });
    expect(
      (
        await stale.app.inject({
          method: "POST",
          url: decisionPath,
          payload: { commandId, decision: "CONFIRM" },
        })
      ).statusCode,
    ).toBe(409);
  });

  it("redacts repository failures", async () => {
    const listPending = vi.fn(() => Promise.reject(new Error("private SQL")));
    const decide = vi.fn(() => Promise.reject(new Error("private SQL")));
    const { app } = build({ listPending, decide });
    const read = await app.inject({ method: "GET", url: pendingPath });
    const write = await app.inject({
      method: "POST",
      url: decisionPath,
      payload: { commandId, decision: "CONFIRM" },
    });
    expect(read.statusCode).toBe(503);
    expect(write.statusCode).toBe(503);
    expect(read.json()).toEqual({ code: "TEMPORARILY_UNAVAILABLE" });
    expect(write.json()).toEqual({ code: "TEMPORARILY_UNAVAILABLE" });
    expect(read.body).not.toContain("private SQL");
    expect(write.body).not.toContain("private SQL");
  });

  it("reports reuse of a command ID with a different payload as a conflict", async () => {
    const { app } = build({
      decide: vi.fn(() =>
        Promise.reject(new JobParticipantRoleDecisionIdempotencyError()),
      ),
    });
    const response = await app.inject({
      method: "POST",
      url: decisionPath,
      payload: { commandId, decision: "CONFIRM" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("rejects repository-level invalid input without exposing internals", async () => {
    const { app } = build({
      decide: vi.fn(() => Promise.reject(new TypeError("private validation"))),
    });
    const response = await app.inject({
      method: "POST",
      url: decisionPath,
      payload: { commandId, decision: "CONFIRM" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: "INVALID_REQUEST" });
    expect(response.body).not.toContain("private validation");
  });
});
