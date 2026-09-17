import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { JobWorkGroupIdempotencyError } from "@portal/db";
import type { UserId } from "@portal/domain";

import { JOB_WORK_GROUP_PATHS, registerJobWorkGroupRoutes } from "./routes.js";

const actorUserId = "86200000-0000-4000-8000-000000000001" as UserId;
const jobId = "86200000-0000-4000-8000-000000000002";
const workGroupId = "86200000-0000-4000-8000-000000000003";
const participantId = "86200000-0000-4000-8000-000000000004";
const assignmentId = "86200000-0000-4000-8000-000000000005";
const commandId = "86200000-0000-4000-8000-000000000006";
const timestamp = new Date("2026-09-16T18:00:00.000Z");
const createUrl = JOB_WORK_GROUP_PATHS.create.replace(":jobId", jobId);
const assignUrl = JOB_WORK_GROUP_PATHS.assign.replace(
  ":workGroupId",
  workGroupId,
);
const departUrl = JOB_WORK_GROUP_PATHS.depart.replace(
  ":assignmentId",
  assignmentId,
);
const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function build(input?: {
  status?: "ACTIVE" | "ACCOUNT_NOT_ACTIVE" | "AUTHENTICATION_REQUIRED";
  list?: ReturnType<typeof vi.fn>;
  create?: ReturnType<typeof vi.fn>;
  assign?: ReturnType<typeof vi.fn>;
  depart?: ReturnType<typeof vi.fn>;
}) {
  const app = Fastify();
  const list =
    input?.list ??
    vi.fn(() => Promise.resolve({ groups: [], nextCursor: null }));
  const create =
    input?.create ?? vi.fn(() => Promise.resolve({ status: "NOT_FOUND" }));
  const assign =
    input?.assign ?? vi.fn(() => Promise.resolve({ status: "NOT_FOUND" }));
  const depart =
    input?.depart ?? vi.fn(() => Promise.resolve({ status: "NOT_FOUND" }));
  registerJobWorkGroupRoutes(app, {
    workGroups: { listForPrimaryParty: list, create, assign, depart },
    csrfProtection: (_request, _reply, done) => done(),
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
  return { app, list, create, assign, depart };
}

describe("private Job work-group commands", () => {
  it("lists concrete groups including empty groups with private cursor", async () => {
    const list = vi.fn(() =>
      Promise.resolve({
        groups: [
          {
            id: workGroupId,
            name: "Montáž",
            crewName: null,
            createdAt: timestamp,
          },
        ],
        nextCursor: { createdAt: timestamp, id: workGroupId },
      }),
    );
    const { app } = build({ list });
    const response = await app.inject({
      method: "GET",
      url: `${createUrl}?limit=20&beforeAt=${encodeURIComponent(timestamp.toISOString())}&beforeId=${workGroupId}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.json()).toEqual({
      groups: [
        {
          id: workGroupId,
          name: "Montáž",
          crewName: null,
          createdAt: timestamp.toISOString(),
        },
      ],
      nextCursor: { createdAt: timestamp.toISOString(), id: workGroupId },
    });
    expect(list).toHaveBeenCalledWith({
      actorUserId,
      jobId,
      cursor: { createdAt: timestamp, id: workGroupId },
      limit: 20,
    });
  });

  it("uses session actor and returns bounded success results", async () => {
    const create = vi.fn(() =>
      Promise.resolve({ status: "APPLIED", workGroupId, createdAt: timestamp }),
    );
    const assign = vi.fn(() =>
      Promise.resolve({
        status: "DEDUPLICATED",
        assignmentId,
        assignedAt: timestamp,
      }),
    );
    const depart = vi.fn(() =>
      Promise.resolve({ status: "APPLIED", endedAt: timestamp }),
    );
    const { app } = build({ create, assign, depart });
    const created = await app.inject({
      method: "POST",
      url: createUrl,
      payload: { commandId, name: "Montáž" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers["cache-control"]).toBe("private, no-store");
    expect(created.json()).toEqual({
      status: "APPLIED",
      workGroupId,
      createdAt: timestamp.toISOString(),
    });
    expect(create).toHaveBeenCalledWith({
      actorUserId,
      commandId,
      jobId,
      name: "Montáž",
    });
    const assigned = await app.inject({
      method: "POST",
      url: assignUrl,
      payload: { commandId, participantId },
    });
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json()).toEqual({
      status: "DEDUPLICATED",
      assignmentId,
      assignedAt: timestamp.toISOString(),
    });
    expect(assign).toHaveBeenCalledWith({
      actorUserId,
      commandId,
      workGroupId,
      participantId,
    });
    const departed = await app.inject({
      method: "POST",
      url: departUrl,
      payload: { commandId, action: "REMOVE", reason: "Zmena zloženia" },
    });
    expect(departed.statusCode).toBe(201);
    expect(departed.json()).toEqual({
      status: "APPLIED",
      endedAt: timestamp.toISOString(),
    });
    expect(depart).toHaveBeenCalledWith({
      actorUserId,
      commandId,
      assignmentId,
      action: "REMOVE",
      reason: "Zmena zloženia",
    });
  });

  it("denies missing and inactive sessions before private repository access", async () => {
    const list = vi.fn();
    const create = vi.fn();
    const assign = vi.fn();
    const depart = vi.fn();
    for (const [status, code] of [
      ["AUTHENTICATION_REQUIRED", 401],
      ["ACCOUNT_NOT_ACTIVE", 403],
    ] as const) {
      const { app } = build({ status, list, create, assign, depart });
      expect(
        (await app.inject({ method: "GET", url: createUrl })).statusCode,
      ).toBe(code);
      expect(
        (
          await app.inject({
            method: "POST",
            url: createUrl,
            payload: { commandId, name: "Montáž" },
          })
        ).statusCode,
      ).toBe(code);
      expect(
        (
          await app.inject({
            method: "POST",
            url: assignUrl,
            payload: { commandId, participantId },
          })
        ).statusCode,
      ).toBe(code);
      expect(
        (
          await app.inject({
            method: "POST",
            url: departUrl,
            payload: { commandId, action: "LEAVE" },
          })
        ).statusCode,
      ).toBe(code);
    }
    expect(list).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
    expect(depart).not.toHaveBeenCalled();
  });

  it("rejects unknown fields and invalid values before repository access", async () => {
    const list = vi.fn();
    const create = vi.fn();
    const assign = vi.fn();
    const depart = vi.fn();
    const { app } = build({ list, create, assign, depart });
    for (const suffix of [
      "?limit=51",
      `?beforeId=${workGroupId}`,
      "?extra=secret",
      "?limit=1&limit=2",
    ])
      expect(
        (await app.inject({ method: "GET", url: `${createUrl}${suffix}` }))
          .statusCode,
      ).toBe(400);
    for (const request of [
      { url: createUrl, payload: { commandId, name: "Montáž", actorUserId } },
      { url: createUrl, payload: { commandId, name: "x" } },
      {
        url: assignUrl,
        payload: { commandId, participantId, crewId: workGroupId },
      },
      { url: departUrl, payload: { commandId, action: "DELETE" } },
      {
        url: departUrl,
        payload: { commandId, action: "REMOVE", reason: "short" },
      },
    ])
      expect(
        (await app.inject({ method: "POST", ...request })).statusCode,
      ).toBe(400);
    expect(list).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
    expect(depart).not.toHaveBeenCalled();
  });

  it("masks foreign targets, handles stale state and redacts storage errors", async () => {
    const create = vi.fn(() => Promise.resolve({ status: "NOT_FOUND" }));
    const assign = vi.fn(() => Promise.resolve({ status: "STALE_STATE" }));
    const depart = vi.fn(() => Promise.reject(new Error("private address")));
    const { app } = build({ create, assign, depart });
    expect(
      (
        await app.inject({
          method: "POST",
          url: createUrl,
          payload: { commandId, name: "Montáž" },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: assignUrl,
          payload: { commandId, participantId },
        })
      ).statusCode,
    ).toBe(409);
    const response = await app.inject({
      method: "POST",
      url: departUrl,
      payload: { commandId, action: "LEAVE" },
    });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("private address");
    const conflictApp = build({
      depart: vi.fn(() =>
        Promise.reject(new JobWorkGroupIdempotencyError("reused")),
      ),
    }).app;
    expect(
      (
        await conflictApp.inject({
          method: "POST",
          url: departUrl,
          payload: { commandId, action: "LEAVE" },
        })
      ).json(),
    ).toEqual({ code: "IDEMPOTENCY_CONFLICT" });
  });
});
