import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UserId } from "@portal/domain";

import {
  JOB_DOCUMENTATION_PATH,
  registerJobDocumentationRoutes,
} from "./routes.js";

const actorUserId = "86200000-0000-4000-8000-000000000001" as UserId;
const jobId = "86200000-0000-4000-8000-000000000004";
const mediaAssetId = "86200000-0000-4000-8000-000000000006";
const url = JOB_DOCUMENTATION_PATH.replace(":jobId", jobId);
const timestamp = new Date("2026-09-16T18:00:00.000Z");
const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function build(input?: {
  status?: "ACTIVE" | "ACCOUNT_NOT_ACTIVE" | "AUTHENTICATION_REQUIRED";
  list?: ReturnType<typeof vi.fn>;
}) {
  const app = Fastify();
  const list = input?.list ?? vi.fn(() => Promise.resolve(null));
  registerJobDocumentationRoutes(app, {
    documentation: { listForPrimaryParty: list },
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
  return { app, list };
}

describe("private Job documentation route", () => {
  it("derives actor and bounds category/cursor with private headers", async () => {
    const list = vi.fn(() =>
      Promise.resolve({
        items: [],
        nextCursor: { chronologicalAt: timestamp, mediaAssetId },
      }),
    );
    const { app } = build({ list });
    const response = await app.inject({
      method: "GET",
      url: `${url}?category=PHOTO&limit=20&beforeAt=${encodeURIComponent(timestamp.toISOString())}&beforeId=${mediaAssetId}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(list).toHaveBeenCalledWith({
      actorUserId,
      category: "PHOTO",
      cursor: { chronologicalAt: timestamp, mediaAssetId },
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

  it("rejects malformed filters and redacts storage failures", async () => {
    const list = vi.fn(() => Promise.reject(new Error("private media key")));
    const { app } = build({ list });
    for (const suffix of [
      "?category=OTHER",
      "?limit=51",
      `?beforeId=${mediaAssetId}`,
      "?extra=secret",
    ]) {
      const result = await app.inject({
        method: "GET",
        url: `${url}${suffix}`,
      });
      expect(result.statusCode, suffix).toBe(400);
    }
    expect(list).not.toHaveBeenCalled();
    const failure = await app.inject({ method: "GET", url });
    expect(failure.statusCode).toBe(503);
    expect(failure.body).not.toContain("private media key");
  });
});
