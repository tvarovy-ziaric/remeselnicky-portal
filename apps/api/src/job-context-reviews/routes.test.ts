import {
  JobContextReviewIdempotencyError,
  type JobContextReviewPage,
  type JobContextReviewRepository,
} from "@portal/db";
import type { UserId } from "@portal/domain";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type HookHandlerDoneFunction,
} from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  JOB_CONTEXT_REVIEW_PATHS,
  registerJobContextReviewRoutes,
} from "./routes.js";

const actorUserId = "91800000-0000-4000-8000-000000000001" as UserId;
const jobId = "91800000-0000-4000-8000-000000000002";
const participantId = "91800000-0000-4000-8000-000000000003";
const participantProfileId = "91800000-0000-4000-8000-000000000004";
const workGroupId = "91800000-0000-4000-8000-000000000005";
const assignmentId = "91800000-0000-4000-8000-000000000006";
const commandId = "91800000-0000-4000-8000-000000000007";
const completedAt = new Date("2026-09-17T08:00:00.000Z");
const submissionDeadline = new Date("2026-10-01T08:00:00.000Z");
const startedAt = new Date("2026-09-01T08:00:00.000Z");
const endedAt = new Date("2026-09-16T16:00:00.000Z");
const recordedAt = new Date("2026-09-18T09:00:00.000Z");
const editDeadline = new Date("2026-09-18T10:00:00.000Z");
const apps: FastifyInstance[] = [];

const participantRatings = Object.freeze({
  work_quality: 5 as const,
  price_adherence: 4 as const,
  schedule_adherence: null,
  communication: 5 as const,
  cleanliness: 4 as const,
  problem_solving: 5 as const,
  would_hire_again: 5 as const,
});
const workGroupRatings = Object.freeze({
  result_quality: 5 as const,
  coordination: 4 as const,
  timing: null,
  communication: 5 as const,
  cleanliness: 4 as const,
  problem_solving: 5 as const,
});

afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function page(): JobContextReviewPage {
  return {
    jobId,
    completedAt,
    submissionDeadline,
    participants: [
      {
        targetKind: "PARTICIPANT",
        participantId,
        participantProfileId,
        displayName: "Ján Elektrikár",
        participationStartedAt: startedAt,
        participationEndedAt: endedAt,
        verifiedProfessionCodes: ["PROF:ELECTRICIAN"],
        verifiedRoles: ["MEMBER", "LEAD"],
        review: {
          revisionId: commandId,
          version: 1,
          submittedAt: recordedAt,
          revisedAt: recordedAt,
          editDeadline,
          ratings: participantRatings,
          comment: "Spoľahlivá práca.",
        },
      },
    ],
    workGroups: [
      {
        targetKind: "WORK_GROUP",
        workGroupId,
        name: "Montážna skupina",
        members: [
          {
            assignmentId,
            participantId,
            participantProfileId,
            displayName: "Ján Elektrikár",
            overlapStartedAt: startedAt,
            overlapEndedAt: endedAt,
          },
        ],
        review: null,
      },
    ],
  };
}

function build(input?: {
  readonly status?: "ACTIVE" | "AUTHENTICATION_REQUIRED" | "ACCOUNT_NOT_ACTIVE";
  readonly page?: JobContextReviewPage | null;
}) {
  const app = Fastify();
  const getForCustomer = vi.fn<JobContextReviewRepository["getForCustomer"]>(
    () => Promise.resolve(input?.page === undefined ? page() : input.page),
  );
  const submit = vi.fn<JobContextReviewRepository["submit"]>((request) =>
    Promise.resolve({
      status: "APPLIED" as const,
      targetKind: request.targetKind,
      targetId: request.targetId,
      revisionId: request.commandId,
      version: request.expectedVersion + 1,
      recordedAt,
    }),
  );
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
  registerJobContextReviewRoutes(app, {
    reviews: { getForCustomer, submit },
    csrfProtection,
    guard: {
      evaluate: () =>
        Promise.resolve(
          input?.status === "AUTHENTICATION_REQUIRED" ||
            input?.status === "ACCOUNT_NOT_ACTIVE"
            ? { status: input.status }
            : { status: "ACTIVE", user: { id: actorUserId } },
        ),
    },
    rateLimit: { max: 7, timeWindowMs: 60_000 },
  });
  apps.push(app);
  return { app, csrfProtection, getForCustomer, submit };
}

const listPath = JOB_CONTEXT_REVIEW_PATHS.list.replace(":jobId", jobId);
const participantPath = JOB_CONTEXT_REVIEW_PATHS.participant
  .replace(":jobId", jobId)
  .replace(":participantId", participantId);
const workGroupPath = JOB_CONTEXT_REVIEW_PATHS.workGroup
  .replace(":jobId", jobId)
  .replace(":workGroupId", workGroupId);
const participantBody = Object.freeze({
  commandId,
  expectedVersion: 0,
  ratings: participantRatings,
  comment: "Spoľahlivá práca.",
});
const workGroupBody = Object.freeze({
  commandId,
  expectedVersion: 0,
  ratings: workGroupRatings,
  comment: null,
});

describe("private secondary Job review routes", () => {
  it("returns only the session customer's verified targets with private headers", async () => {
    const { app, getForCustomer } = build();
    const response = await app.inject({ method: "GET", url: listPath });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(getForCustomer).toHaveBeenCalledWith({ actorUserId, jobId });
    expect(response.json()).toEqual({
      jobId,
      completedAt: completedAt.toISOString(),
      submissionDeadline: submissionDeadline.toISOString(),
      participants: [
        {
          targetKind: "PARTICIPANT",
          participantId,
          participantProfileId,
          displayName: "Ján Elektrikár",
          participationStartedAt: startedAt.toISOString(),
          participationEndedAt: endedAt.toISOString(),
          verifiedProfessionCodes: ["PROF:ELECTRICIAN"],
          verifiedRoles: ["MEMBER", "LEAD"],
          review: {
            revisionId: commandId,
            version: 1,
            submittedAt: recordedAt.toISOString(),
            revisedAt: recordedAt.toISOString(),
            editDeadline: editDeadline.toISOString(),
            ratings: participantRatings,
            comment: "Spoľahlivá práca.",
          },
        },
      ],
      workGroups: [
        {
          targetKind: "WORK_GROUP",
          workGroupId,
          name: "Montážna skupina",
          members: [
            {
              assignmentId,
              participantId,
              participantProfileId,
              displayName: "Ján Elektrikár",
              overlapStartedAt: startedAt.toISOString(),
              overlapEndedAt: endedAt.toISOString(),
            },
          ],
          review: null,
        },
      ],
    });
  });

  it("uses uniform not-found and denies anonymous or inactive sessions before persistence", async () => {
    const foreign = build({ page: null });
    const foreignResponse = await foreign.app.inject({
      method: "GET",
      url: listPath,
    });
    expect(foreignResponse.statusCode).toBe(404);
    expect(foreignResponse.json()).toEqual({ code: "NOT_FOUND" });

    for (const [status, expected] of [
      ["AUTHENTICATION_REQUIRED", 401],
      ["ACCOUNT_NOT_ACTIVE", 403],
    ] as const) {
      const denied = build({ status });
      expect(
        (await denied.app.inject({ method: "GET", url: listPath })).statusCode,
      ).toBe(expected);
      expect(denied.getForCustomer).not.toHaveBeenCalled();
      expect(
        (
          await denied.app.inject({
            method: "POST",
            url: participantPath,
            headers: { "x-csrf-token": "valid" },
            payload: participantBody,
          })
        ).statusCode,
      ).toBe(expected);
      expect(denied.submit).not.toHaveBeenCalled();
    }
  });

  it("requires CSRF and derives participant target metadata exclusively from the route", async () => {
    const { app, csrfProtection, submit } = build();
    expect(
      (
        await app.inject({
          method: "POST",
          url: participantPath,
          payload: participantBody,
        })
      ).statusCode,
    ).toBe(403);
    expect(submit).not.toHaveBeenCalled();

    const response = await app.inject({
      method: "POST",
      url: participantPath,
      headers: { "x-csrf-token": "valid" },
      payload: participantBody,
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.json()).toEqual({
      status: "APPLIED",
      targetKind: "PARTICIPANT",
      targetId: participantId,
      revisionId: commandId,
      version: 1,
      recordedAt: recordedAt.toISOString(),
    });
    expect(submit).toHaveBeenCalledWith({
      actorUserId,
      jobId,
      targetKind: "PARTICIPANT",
      targetId: participantId,
      ...participantBody,
    });
    expect(csrfProtection).toHaveBeenCalled();
  });

  it("submits work-group dimensions without accepting participant dimensions", async () => {
    const { app, submit } = build();
    const response = await app.inject({
      method: "POST",
      url: workGroupPath,
      headers: { "x-csrf-token": "valid" },
      payload: workGroupBody,
    });
    expect(response.statusCode).toBe(201);
    expect(submit).toHaveBeenCalledWith({
      actorUserId,
      jobId,
      targetKind: "WORK_GROUP",
      targetId: workGroupId,
      ...workGroupBody,
    });

    expect(
      (
        await app.inject({
          method: "POST",
          url: workGroupPath,
          headers: { "x-csrf-token": "valid" },
          payload: participantBody,
        })
      ).statusCode,
    ).toBe(400);
  });

  it("rejects malformed, all-N/A, partial, unexpected and client-directed bodies", async () => {
    const { app, submit } = build();
    const invalid = [
      { ...participantBody, actorUserId },
      { ...participantBody, targetKind: "PARTICIPANT" },
      { ...participantBody, targetId: participantId },
      { ...participantBody, expectedVersion: -1 },
      { ...participantBody, expectedVersion: 0.5 },
      { ...participantBody, commandId: "not-a-uuid" },
      {
        ...participantBody,
        ratings: { ...participantRatings, work_quality: 6 },
      },
      {
        ...participantBody,
        ratings: Object.fromEntries(
          Object.keys(participantRatings).map((key) => [key, null]),
        ),
      },
      { ...participantBody, ratings: { work_quality: 5 } },
      { ...participantBody, ratings: { ...participantRatings, secret: 5 } },
      { ...participantBody, comment: " medzery " },
      { ...participantBody, comment: "riadok\nnavyše" },
    ];
    for (const payload of invalid) {
      const response = await app.inject({
        method: "POST",
        url: participantPath,
        headers: { "x-csrf-token": "valid" },
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
    expect(submit).not.toHaveBeenCalled();
  });

  it("rejects query strings and malformed route identities", async () => {
    const { app, getForCustomer, submit } = build();
    expect(
      (await app.inject({ method: "GET", url: `${listPath}?target=x` }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${participantPath}?target=x`,
          headers: { "x-csrf-token": "valid" },
          payload: participantBody,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: JOB_CONTEXT_REVIEW_PATHS.participant
            .replace(":jobId", jobId)
            .replace(":participantId", "not-a-uuid"),
          headers: { "x-csrf-token": "valid" },
          payload: participantBody,
        })
      ).statusCode,
    ).toBe(400);
    expect(getForCustomer).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("maps safe command and state conflicts", async () => {
    const { app, submit } = build();
    const post = () =>
      app.inject({
        method: "POST",
        url: participantPath,
        headers: { "x-csrf-token": "valid" },
        payload: participantBody,
      });

    submit.mockResolvedValueOnce({
      status: "DEDUPLICATED",
      targetKind: "PARTICIPANT",
      targetId: participantId,
      revisionId: commandId,
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
  });

  it("redacts validation, idempotency and unexpected persistence errors", async () => {
    const { app, getForCustomer, submit } = build();
    const post = () =>
      app.inject({
        method: "POST",
        url: participantPath,
        headers: { "x-csrf-token": "valid" },
        payload: participantBody,
      });

    submit.mockRejectedValueOnce(
      new JobContextReviewIdempotencyError("private command and rating detail"),
    );
    expect((await post()).json()).toEqual({ code: "IDEMPOTENCY_CONFLICT" });
    submit.mockRejectedValueOnce(new TypeError("private rating detail"));
    expect((await post()).json()).toEqual({ code: "INVALID_REQUEST" });
    submit.mockRejectedValueOnce(new Error("private comment detail"));
    const unavailable = await post();
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toEqual({ code: "TEMPORARILY_UNAVAILABLE" });
    expect(unavailable.body).not.toContain("private comment detail");

    getForCustomer.mockRejectedValueOnce(new Error("private target detail"));
    const readFailure = await app.inject({ method: "GET", url: listPath });
    expect(readFailure.statusCode).toBe(503);
    expect(readFailure.body).not.toContain("private target detail");
  });
});
