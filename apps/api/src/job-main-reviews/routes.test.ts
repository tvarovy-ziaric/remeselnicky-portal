import {
  JobMainReviewIdempotencyError,
  type JobMainReviewOpportunity,
  type JobMainReviewRepository,
} from "@portal/db";
import type { UserId } from "@portal/domain";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type HookHandlerDoneFunction,
} from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { JOB_MAIN_REVIEW_PATH, registerJobMainReviewRoutes } from "./routes.js";

const actorUserId = "91700000-0000-4000-8000-000000000001" as UserId;
const jobId = "91700000-0000-4000-8000-000000000002";
const targetProfileId = "91700000-0000-4000-8000-000000000003";
const commandId = "91700000-0000-4000-8000-000000000004";
const revisionId = commandId;
const completedAt = new Date("2026-09-17T08:00:00.000Z");
const submissionDeadline = new Date("2026-10-01T08:00:00.000Z");
const recordedAt = new Date("2026-09-18T09:00:00.000Z");
const apps: FastifyInstance[] = [];

const customerRatings = Object.freeze({
  work_quality: 5 as const,
  price_adherence: 4 as const,
  schedule_adherence: null,
  communication: 5 as const,
  cleanliness: 4 as const,
  problem_solving: 5 as const,
  would_hire_again: 5 as const,
});
const providerRatings = Object.freeze({
  agreement_payment_experience: 4 as const,
  site_readiness: 5 as const,
  brief_clarity: null,
  communication: 5 as const,
  unplanned_changes: 3 as const,
  fairness: 5 as const,
});

afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function opportunity(
  input: Partial<JobMainReviewOpportunity> = {},
): JobMainReviewOpportunity {
  return {
    jobId,
    direction: "CUSTOMER_TO_PROVIDER",
    targetProfileId,
    targetKind: "CRAFTSMAN_PROFILE",
    acceptedProfessionCode: "PROF:ELECTRICIAN",
    completedAt,
    submissionDeadline,
    state: "OPEN",
    ownReview: null,
    counterpartyReview: null,
    ...input,
  };
}

function build(input?: {
  readonly status?: "ACTIVE" | "AUTHENTICATION_REQUIRED" | "ACCOUNT_NOT_ACTIVE";
  readonly page?: JobMainReviewOpportunity | null;
}) {
  const app = Fastify();
  const get = vi.fn<JobMainReviewRepository["get"]>(() =>
    Promise.resolve(input?.page === undefined ? opportunity() : input.page),
  );
  const submit = vi.fn<JobMainReviewRepository["submit"]>(() =>
    Promise.resolve({
      status: "APPLIED" as const,
      direction: "CUSTOMER_TO_PROVIDER" as const,
      revisionId,
      version: 1,
      recordedAt,
    }),
  );
  const reviews = { get, submit };
  const csrfProtection = vi.fn(
    (
      request: FastifyRequest,
      reply: FastifyReply,
      done: HookHandlerDoneFunction,
    ) => {
      if (request.headers["x-csrf-token"] !== "valid") {
        void reply.code(403).send({ code: "CSRF_INVALID" });
        return;
      }
      done();
    },
  );
  const evaluate = vi.fn(() =>
    Promise.resolve(
      input?.status === "AUTHENTICATION_REQUIRED" ||
        input?.status === "ACCOUNT_NOT_ACTIVE"
        ? { status: input.status }
        : { status: "ACTIVE" as const, user: { id: actorUserId } },
    ),
  );
  registerJobMainReviewRoutes(app, {
    reviews,
    csrfProtection,
    guard: { evaluate },
    rateLimit: { max: 7, timeWindowMs: 60_000 },
  });
  apps.push(app);
  return { app, csrfProtection, evaluate, get, submit };
}

const path = JOB_MAIN_REVIEW_PATH.replace(":jobId", jobId);
const validBody = Object.freeze({
  commandId,
  expectedVersion: 0,
  ratings: customerRatings,
  comment: "Spoľahlivo dokončená práca.",
});

describe("private main bilateral review routes", () => {
  it("reads only the session actor's privacy-minimized opportunity with private headers", async () => {
    const own = {
      revisionId,
      version: 2,
      submittedAt: recordedAt,
      revisedAt: new Date("2026-09-18T09:20:00.000Z"),
      ratings: customerRatings,
      comment: "Dobrá práca.",
    } as const;
    const counterparty = {
      direction: "PROVIDER_TO_CUSTOMER" as const,
      revisionId: "91700000-0000-4000-8000-000000000005",
      submittedAt: new Date("2026-09-18T09:30:00.000Z"),
      revisedAt: new Date("2026-09-18T09:30:00.000Z"),
      unlockedAt: new Date("2026-09-18T09:30:00.000Z"),
      ratings: providerRatings,
      comment: null,
    };
    const { app, evaluate, get } = build({
      page: opportunity({
        state: "UNLOCKED",
        ownReview: own,
        counterpartyReview: counterparty,
      }),
    });
    const response = await app.inject({ method: "GET", url: path });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(get).toHaveBeenCalledWith({ actorUserId, jobId });
    expect(evaluate).toHaveBeenCalledWith(expect.anything(), undefined);
    expect(response.json()).toEqual({
      jobId,
      direction: "CUSTOMER_TO_PROVIDER",
      targetProfileId,
      targetKind: "CRAFTSMAN_PROFILE",
      acceptedProfessionCode: "PROF:ELECTRICIAN",
      completedAt: completedAt.toISOString(),
      submissionDeadline: submissionDeadline.toISOString(),
      state: "UNLOCKED",
      ownReview: {
        ...own,
        submittedAt: own.submittedAt.toISOString(),
        revisedAt: own.revisedAt.toISOString(),
      },
      counterpartyReview: {
        ...counterparty,
        submittedAt: counterparty.submittedAt.toISOString(),
        revisedAt: counterparty.revisedAt.toISOString(),
        unlockedAt: counterparty.unlockedAt.toISOString(),
      },
    });
  });

  it("keeps sealed counterparty content absent and maps unauthorized or foreign reads uniformly", async () => {
    const sealed = build({
      page: opportunity({
        state: "SUBMITTED_SEALED",
        ownReview: {
          revisionId,
          version: 1,
          submittedAt: recordedAt,
          revisedAt: recordedAt,
          ratings: customerRatings,
          comment: "Vlastné hodnotenie.",
        },
      }),
    });
    const response = await sealed.app.inject({ method: "GET", url: path });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      state: "SUBMITTED_SEALED",
      counterpartyReview: null,
    });

    const foreign = build({ page: null });
    expect(
      (await foreign.app.inject({ method: "GET", url: path })).statusCode,
    ).toBe(404);
    for (const [status, expected] of [
      ["AUTHENTICATION_REQUIRED", 401],
      ["ACCOUNT_NOT_ACTIVE", 403],
    ] as const) {
      const denied = build({ status });
      expect(
        (await denied.app.inject({ method: "GET", url: path })).statusCode,
      ).toBe(expected);
      expect(denied.get).not.toHaveBeenCalled();
    }
  });

  it("requires CSRF and submits only server-derived direction through the session actor", async () => {
    const { app, csrfProtection, evaluate, submit } = build();
    expect(
      (await app.inject({ method: "POST", url: path, payload: validBody }))
        .statusCode,
    ).toBe(403);
    expect(submit).not.toHaveBeenCalled();

    const response = await app.inject({
      method: "POST",
      url: path,
      headers: { "x-csrf-token": "valid" },
      payload: validBody,
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.json()).toEqual({
      status: "APPLIED",
      direction: "CUSTOMER_TO_PROVIDER",
      revisionId,
      version: 1,
      recordedAt: recordedAt.toISOString(),
    });
    expect(submit).toHaveBeenCalledWith({
      actorUserId,
      jobId,
      ...validBody,
    });
    expect(evaluate).toHaveBeenCalledWith(expect.anything(), "REVIEWS");
    expect(csrfProtection).toHaveBeenCalled();
  });

  it("rejects malformed, all-N/A, partial, unexpected and client-directed payloads", async () => {
    const { app, submit } = build();
    const invalid = [
      { ...validBody, direction: "CUSTOMER_TO_PROVIDER" },
      { ...validBody, expectedVersion: -1 },
      { ...validBody, expectedVersion: 0.5 },
      { ...validBody, commandId: "not-a-uuid" },
      { ...validBody, ratings: { ...customerRatings, work_quality: 6 } },
      {
        ...validBody,
        ratings: Object.fromEntries(
          Object.keys(customerRatings).map((key) => [key, null]),
        ),
      },
      {
        ...validBody,
        ratings: { work_quality: 5, communication: 5 },
      },
      { ...validBody, ratings: { ...customerRatings, hidden_score: 5 } },
      { ...validBody, comment: " medzery " },
      { ...validBody, comment: "riadok\nnavyše" },
    ];
    for (const payload of invalid) {
      const response = await app.inject({
        method: "POST",
        url: path,
        headers: { "x-csrf-token": "valid" },
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
    expect(submit).not.toHaveBeenCalled();
    expect(
      (await app.inject({ method: "GET", url: `${path}?direction=x` }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${path}?direction=x`,
          headers: { "x-csrf-token": "valid" },
          payload: validBody,
        })
      ).statusCode,
    ).toBe(400);
  });

  it("maps command/state conflicts and redacts unexpected persistence errors", async () => {
    const { app, submit, get } = build();
    const post = () =>
      app.inject({
        method: "POST",
        url: path,
        headers: { "x-csrf-token": "valid" },
        payload: validBody,
      });

    submit.mockResolvedValueOnce({
      status: "DEDUPLICATED",
      direction: "CUSTOMER_TO_PROVIDER",
      revisionId,
      version: 1,
      recordedAt,
    });
    expect((await post()).statusCode).toBe(200);
    for (const [status, expected] of [
      ["NOT_FOUND", 404],
      ["WINDOW_CLOSED", 409],
      ["EDIT_LOCKED", 409],
      ["STALE_VERSION", 409],
    ] as const) {
      submit.mockResolvedValueOnce({ status });
      const response = await post();
      expect(response.statusCode).toBe(expected);
      expect(response.json()).toEqual({ code: status });
    }
    submit.mockRejectedValueOnce(
      new JobMainReviewIdempotencyError("private command detail"),
    );
    expect((await post()).json()).toEqual({ code: "IDEMPOTENCY_CONFLICT" });
    submit.mockRejectedValueOnce(new TypeError("private validation detail"));
    expect((await post()).json()).toEqual({ code: "INVALID_REQUEST" });
    submit.mockRejectedValueOnce(new Error("private database detail"));
    const unavailable = await post();
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.body).not.toContain("private database detail");

    get.mockRejectedValueOnce(new Error("private query detail"));
    const unavailableRead = await app.inject({ method: "GET", url: path });
    expect(unavailableRead.statusCode).toBe(503);
    expect(unavailableRead.body).not.toContain("private query detail");
  });
});
