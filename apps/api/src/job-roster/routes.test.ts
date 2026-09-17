import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UserId } from "@portal/domain";

import { JOB_ROSTER_PATH, registerJobRosterRoutes } from "./routes.js";

const actorUserId = "86200000-0000-4000-8000-000000000001" as UserId;
const jobId = "86200000-0000-4000-8000-000000000004";
const participantId = "86200000-0000-4000-8000-000000000006";
const url = JOB_ROSTER_PATH.replace(":jobId", jobId);
const timestamp = new Date("2026-09-16T18:00:00.000Z");
const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function build(input?: {
  status?: "ACTIVE" | "ACCOUNT_NOT_ACTIVE" | "AUTHENTICATION_REQUIRED";
  list?: ReturnType<typeof vi.fn>;
}) {
  const app = Fastify();
  const list = input?.list ?? vi.fn(() => Promise.resolve(null));
  registerJobRosterRoutes(app, {
    roster: { listForPrimaryParty: list },
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
  return { app, list };
}

describe("private Job roster route", () => {
  it("derives the actor and bounds cursor with private headers", async () => {
    const list = vi.fn(() =>
      Promise.resolve({
        role: "CUSTOMER",
        participants: [],
        nextCursor: { invitedAt: timestamp, id: participantId },
      }),
    );
    const { app } = build({ list });
    const response = await app.inject({
      method: "GET",
      url: `${url}?limit=20&beforeAt=${encodeURIComponent(timestamp.toISOString())}&beforeId=${participantId}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(list).toHaveBeenCalledWith({
      actorUserId,
      cursor: { invitedAt: timestamp, id: participantId },
      jobId,
      limit: 20,
    });
  });

  it("denies missing/inactive sessions and masks unknown and unrelated Jobs", async () => {
    const list = vi.fn(() => Promise.resolve(null));
    for (const [status, expected] of [
      ["AUTHENTICATION_REQUIRED", 401],
      ["ACCOUNT_NOT_ACTIVE", 403],
    ] as const) {
      const { app } = build({ list, status });
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(
        expected,
      );
    }
    expect(list).not.toHaveBeenCalled();
    const { app } = build({ list });
    const unknown = await app.inject({ method: "GET", url });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ code: "NOT_FOUND" });
  });

  it("rejects malformed filters and redacts persistence failures", async () => {
    const list = vi.fn(() =>
      Promise.reject(new Error("private roster secret")),
    );
    const { app } = build({ list });
    for (const suffix of [
      "?limit=51",
      `?beforeId=${participantId}`,
      "?beforeAt=2026-09-16T18%3A00%3A00.000Z",
      "?extra=secret",
      "?limit=1&limit=2",
    ]) {
      const response = await app.inject({
        method: "GET",
        url: `${url}${suffix}`,
      });
      expect(response.statusCode, suffix).toBe(400);
    }
    expect(list).not.toHaveBeenCalled();
    const failure = await app.inject({ method: "GET", url });
    expect(failure.statusCode).toBe(503);
    expect(failure.body).not.toContain("private roster secret");
  });
});
