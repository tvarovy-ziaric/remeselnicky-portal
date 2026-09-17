import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { JobDashboard, JobDashboardSummary } from "@portal/db";
import type { UserId } from "@portal/domain";

import { JOB_DASHBOARD_PATHS, registerJobDashboardRoutes } from "./routes.js";

const actorUserId = "86200000-0000-4000-8000-000000000001" as UserId;
const jobId = "86200000-0000-4000-8000-000000000004";
const detailPath = JOB_DASHBOARD_PATHS.detail.replace(":jobId", jobId);
const summary: JobDashboardSummary = {
  acceptedAt: new Date("2026-09-16T18:00:00.000Z"),
  id: jobId,
  providerDisplayName: "Testovací remeselník",
  requestTitle: "Syntetická práca",
  role: "CUSTOMER",
  state: "CONFIRMED",
};
const detail: JobDashboard = {
  ...summary,
  customerDisplayName: "Konto 86200000",
  quote: {
    authoringMode: "PLATFORM_STRUCTURED",
    commercialContent: { priceMode: "FIXED", totalAmountCents: 100_000 },
    pdfDownloadPath: null,
    quoteId: "86200000-0000-4000-8000-000000000003",
    revision: 1,
  },
  currentCommercialState: {
    base: {
      source: "BASE_QUOTE",
      quoteId: "86200000-0000-4000-8000-000000000003",
      revision: 1,
      authoringMode: "PLATFORM_STRUCTURED",
      commercialContent: { priceMode: "FIXED", totalAmountCents: 100_000 },
    },
    approvedChanges: [],
    originalTotalCents: 100_000,
    fixedDeltaCents: null,
    exactTotalCents: null,
    exactTotalUnavailableReason: "BASE_CURRENCY_UNSUPPORTED",
  },
  request: {
    contentRevision: 1,
    description: "Montáž",
    municipalityCode: "TEST:MUNICIPALITY_ALPHA",
    scopeDetails: { primaryProfessionCode: "PROF:ALPHA_SYNTHETIC" },
    title: "Syntetická práca",
    visibleVersion: 1,
  },
  supportingDocuments: [],
  timeline: [
    {
      eventId: "86200000-0000-4000-8000-000000000006",
      eventType: "JOB_CONFIRMED",
      occurredAt: new Date("2026-09-16T18:00:00.000Z"),
      actorRole: null,
      reason: null,
    },
    {
      eventId: "86200000-0000-4000-8000-000000000007",
      eventType: "CONTACT_ADDRESS_UNLOCKED",
      occurredAt: new Date("2026-09-16T18:00:00.000Z"),
      actorRole: null,
      reason: null,
    },
  ],
  winningInvitationId: "86200000-0000-4000-8000-000000000005",
};

const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe("primary-party Job dashboard routes", () => {
  it("returns only the session actor's Job list and detail with private headers", async () => {
    const list = vi.fn(() => Promise.resolve([summary]));
    const read = vi.fn(() => Promise.resolve(detail));
    const app = build({ list, read });
    const collection = await app.inject({
      method: "GET",
      url: JOB_DASHBOARD_PATHS.collection,
    });
    expect(collection.statusCode).toBe(200);
    expect(collection.json()).toEqual({
      jobs: [{ ...summary, acceptedAt: summary.acceptedAt.toISOString() }],
    });
    expect(collection.headers["cache-control"]).toBe("private, no-store");
    expect(collection.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(list).toHaveBeenCalledWith({ actorUserId });
    const item = await app.inject({ method: "GET", url: detailPath });
    expect(item.statusCode, item.body).toBe(200);
    expect(item.json()).toMatchObject({
      id: jobId,
      request: { title: "Syntetická práca" },
      state: "CONFIRMED",
    });
    expect(item.headers["cache-control"]).toBe("private, no-store");
    expect(read).toHaveBeenCalledWith({ actorUserId, jobId });
  });

  it("denies anonymous and inactive viewers before either private read", async () => {
    const list = vi.fn();
    const read = vi.fn();
    for (const [status, code] of [
      ["AUTHENTICATION_REQUIRED", 401],
      ["ACCOUNT_NOT_ACTIVE", 403],
    ] as const) {
      const app = build({ list, read, status });
      expect(
        (await app.inject({ method: "GET", url: detailPath })).statusCode,
      ).toBe(code);
      expect(
        (
          await app.inject({
            method: "GET",
            url: JOB_DASHBOARD_PATHS.collection,
          })
        ).statusCode,
      ).toBe(code);
    }
    expect(list).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it("uses uniform 404 for an unrelated or unknown Job and redacts failures", async () => {
    const app = build({
      list: vi.fn(() => Promise.resolve([])),
      read: vi.fn(() => Promise.resolve(null)),
    });
    const missing = await app.inject({ method: "GET", url: detailPath });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ code: "NOT_FOUND" });
    const broken = build({
      list: vi.fn(() => Promise.reject(new Error("private Job data"))),
      read: vi.fn(() => Promise.reject(new Error("private Job data"))),
    });
    const failure = await broken.inject({ method: "GET", url: detailPath });
    expect(failure.statusCode).toBe(503);
    expect(failure.body).not.toContain("private Job data");
    expect(failure.headers["cache-control"]).toBe("private, no-store");
    expect(
      (
        await broken.inject({
          method: "GET",
          url: JOB_DASHBOARD_PATHS.collection,
        })
      ).statusCode,
    ).toBe(503);
  });

  it("rejects malformed Job IDs without querying the repository", async () => {
    const read = vi.fn();
    const app = build({ list: vi.fn(), read });
    const response = await app.inject({
      method: "GET",
      url: JOB_DASHBOARD_PATHS.detail.replace(":jobId", "not-a-job"),
    });
    expect(response.statusCode).toBe(400);
    expect(read).not.toHaveBeenCalled();
    expect(response.headers["cache-control"]).toBe("private, no-store");
  });
});

function build(input: {
  readonly list: ReturnType<typeof vi.fn>;
  readonly read: ReturnType<typeof vi.fn>;
  readonly status?: "ACCOUNT_NOT_ACTIVE" | "AUTHENTICATION_REQUIRED";
}): FastifyInstance {
  const app = Fastify();
  apps.push(app);
  registerJobDashboardRoutes(app, {
    dashboard: {
      listForPrimaryParty: input.list,
      readForPrimaryParty: input.read,
    },
    guard: {
      evaluate: () =>
        Promise.resolve(
          input.status === undefined
            ? { status: "ACTIVE" as const, user: { id: actorUserId } }
            : { status: input.status },
        ),
    },
    rateLimit: { max: 10, timeWindowMs: 60_000 },
  });
  return app;
}
