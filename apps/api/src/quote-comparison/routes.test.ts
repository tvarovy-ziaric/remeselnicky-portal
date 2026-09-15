import type { JobRequestId, UserId } from "@portal/domain";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  QUOTE_COMPARISON_PATH,
  registerQuoteComparisonRoutes,
} from "./routes.js";

const actorUserId = "82000000-0000-4000-8000-000000000001" as UserId;
const jobRequestId = "82000000-0000-4000-8000-000000000002" as JobRequestId;
const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe("Quote comparison route", () => {
  it("derives the actor, returns no-store and does not add private identifiers", async () => {
    const readCurrent = vi.fn(() =>
      Promise.resolve({ items: [], jobRequestId, sort: "RECEIVED" as const }),
    );
    const app = Fastify();
    apps.push(app);
    registerQuoteComparisonRoutes(app, dependencies(readCurrent));
    const response = await app.inject({
      method: "GET",
      url: path("?sort=RECEIVED"),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(readCurrent).toHaveBeenCalledWith({
      actorUserId,
      jobRequestId,
      sort: "RECEIVED",
    });
    expect(response.body).not.toMatch(
      /ownerUserId|customerProfileId|storageKey|sha256|evidenceId/iu,
    );
  });

  it("uses uniform absence and blocks anonymous/suspended reads", async () => {
    for (const status of [
      "AUTHENTICATION_REQUIRED",
      "ACCOUNT_NOT_ACTIVE",
    ] as const) {
      const readCurrent = vi.fn();
      const app = Fastify();
      apps.push(app);
      registerQuoteComparisonRoutes(app, dependencies(readCurrent, status));
      expect(
        (await app.inject({ method: "GET", url: path() })).statusCode,
      ).toBe(status === "AUTHENTICATION_REQUIRED" ? 401 : 403);
      expect(readCurrent).not.toHaveBeenCalled();
    }
    const app = Fastify();
    apps.push(app);
    registerQuoteComparisonRoutes(
      app,
      dependencies(vi.fn(() => Promise.resolve(null))),
    );
    expect((await app.inject({ method: "GET", url: path() })).statusCode).toBe(
      404,
    );
  });

  it("rejects malformed sort and fails closed without error details", async () => {
    const app = Fastify();
    apps.push(app);
    registerQuoteComparisonRoutes(
      app,
      dependencies(vi.fn(() => Promise.reject(new Error("storage_secret")))),
    );
    expect(
      (await app.inject({ method: "GET", url: path("?sort=PRICE") }))
        .statusCode,
    ).toBe(400);
    const failed = await app.inject({ method: "GET", url: path() });
    expect(failed.statusCode).toBe(503);
    expect(failed.body).not.toContain("storage_secret");
  });
});

function path(suffix = "") {
  return QUOTE_COMPARISON_PATH.replace(":jobRequestId", jobRequestId) + suffix;
}
function dependencies(
  readCurrent: ReturnType<typeof vi.fn>,
  status:
    "ACTIVE" | "AUTHENTICATION_REQUIRED" | "ACCOUNT_NOT_ACTIVE" = "ACTIVE",
) {
  return {
    comparison: { readCurrent },
    guard: {
      evaluate: vi.fn(() =>
        Promise.resolve(
          status === "ACTIVE"
            ? { status, user: { id: actorUserId } }
            : { status },
        ),
      ),
    },
  } as Parameters<typeof registerQuoteComparisonRoutes>[1];
}
