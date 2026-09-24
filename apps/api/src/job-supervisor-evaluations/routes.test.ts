import {
  JobSupervisorEvaluationIdempotencyError,
  type JobSupervisorEvaluationDetail,
  type JobSupervisorEvaluationPage,
  type JobSupervisorEvaluationRepository,
  type ReceivedJobSupervisorEvaluationPage,
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
  JOB_SUPERVISOR_EVALUATION_PATHS,
  registerJobSupervisorEvaluationRoutes,
} from "./routes.js";

const actorUserId = "91900000-0000-4000-8000-000000000001" as UserId;
const jobId = "91900000-0000-4000-8000-000000000002";
const participantId = "91900000-0000-4000-8000-000000000003";
const participantProfileId = "91900000-0000-4000-8000-000000000004";
const evaluationId = "91900000-0000-4000-8000-000000000005";
const revisionId = "91900000-0000-4000-8000-000000000006";
const commandId = "91900000-0000-4000-8000-000000000007";
const completedAt = new Date("2026-09-17T08:00:00.000Z");
const submissionDeadline = new Date("2026-10-01T08:00:00.000Z");
const overlapStartedAt = new Date("2026-09-02T08:00:00.000Z");
const overlapEndedAt = new Date("2026-09-16T16:00:00.000Z");
const submittedAt = new Date("2026-09-18T09:00:00.000Z");
const editDeadline = new Date("2026-09-18T10:00:00.000Z");
const apps: FastifyInstance[] = [];

const ratings = Object.freeze({
  competence_quality: 5 as const,
  reliability: 4 as const,
  independence: null,
  productivity: 5 as const,
  collaboration: 4 as const,
  problem_solving: 5 as const,
  would_take_into_crew_again: 5 as const,
});

const content = Object.freeze({
  evaluationId,
  revisionId,
  version: 1,
  submittedAt,
  revisedAt: submittedAt,
  editDeadline,
  ratings,
  comment: "Odborne samostatná práca.",
});

function evaluatorPage(): JobSupervisorEvaluationPage {
  return {
    jobId,
    completedAt,
    submissionDeadline,
    targets: [
      {
        targetParticipantId: participantId,
        targetProfileId: participantProfileId,
        displayName: "Ján Elektrikár",
        relationshipKind: "SITE_MANAGER",
        overlapStartedAt,
        overlapEndedAt,
        verifiedProfessionCodes: ["PROF:ELECTRICIAN"],
        verifiedRoles: ["MEMBER"],
        evaluation: content,
      },
    ],
  };
}

function detail(): JobSupervisorEvaluationDetail {
  return {
    evaluationId,
    jobId,
    targetParticipantId: participantId,
    targetProfileId: participantProfileId,
    evaluatorDisplayName: "Stavbyvedúci Milan",
    relationshipKind: "SITE_MANAGER",
    overlapStartedAt,
    overlapEndedAt,
    verifiedProfessionCodes: ["PROF:ELECTRICIAN"],
    verifiedRoles: ["MEMBER"],
    content,
  };
}

function receivedPage(): ReceivedJobSupervisorEvaluationPage {
  return { jobId, evaluations: [detail()] };
}

afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function build(input?: {
  readonly evaluatorPage?: JobSupervisorEvaluationPage | null;
  readonly receivedPage?: ReceivedJobSupervisorEvaluationPage | null;
  readonly detail?: JobSupervisorEvaluationDetail | null;
  readonly status?: "ACTIVE" | "AUTHENTICATION_REQUIRED" | "ACCOUNT_NOT_ACTIVE";
}) {
  const app = Fastify();
  const getForEvaluator = vi.fn<
    JobSupervisorEvaluationRepository["getForEvaluator"]
  >(() =>
    Promise.resolve(
      input?.evaluatorPage === undefined
        ? evaluatorPage()
        : input.evaluatorPage,
    ),
  );
  const getReceivedForTarget = vi.fn<
    JobSupervisorEvaluationRepository["getReceivedForTarget"]
  >(() =>
    Promise.resolve(
      input?.receivedPage === undefined ? receivedPage() : input.receivedPage,
    ),
  );
  const getById = vi.fn<JobSupervisorEvaluationRepository["getById"]>(() =>
    Promise.resolve(input?.detail === undefined ? detail() : input.detail),
  );
  const submit = vi.fn<JobSupervisorEvaluationRepository["submit"]>((request) =>
    Promise.resolve({
      status: "APPLIED" as const,
      evaluationId,
      revisionId: request.commandId,
      version: request.expectedVersion + 1,
      recordedAt: submittedAt,
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
  registerJobSupervisorEvaluationRoutes(app, {
    evaluations: {
      getForEvaluator,
      getReceivedForTarget,
      getById,
      submit,
    },
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
    rateLimit: {
      read: { max: 42, timeWindowMs: 60_000 },
      write: { max: 7, timeWindowMs: 60_000 },
    },
  });
  apps.push(app);
  return {
    app,
    csrfProtection,
    getById,
    getForEvaluator,
    getReceivedForTarget,
    submit,
  };
}

const evaluatorPath = JOB_SUPERVISOR_EVALUATION_PATHS.evaluator.replace(
  ":jobId",
  jobId,
);
const receivedPath = JOB_SUPERVISOR_EVALUATION_PATHS.received.replace(
  ":jobId",
  jobId,
);
const detailPath = JOB_SUPERVISOR_EVALUATION_PATHS.detail
  .replace(":jobId", jobId)
  .replace(":evaluationId", evaluationId);
const participantPath = JOB_SUPERVISOR_EVALUATION_PATHS.participant
  .replace(":jobId", jobId)
  .replace(":participantId", participantId);
const body = Object.freeze({
  commandId,
  expectedVersion: 0,
  ratings,
  comment: "Odborne samostatná práca.",
});

describe("private supervisor evaluation routes", () => {
  it("returns only the evaluator's server-derived eligible target list", async () => {
    const { app, getForEvaluator } = build();
    const response = await app.inject({ method: "GET", url: evaluatorPath });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(getForEvaluator).toHaveBeenCalledWith({ actorUserId, jobId });
    expect(response.json()).toEqual({
      jobId,
      completedAt: completedAt.toISOString(),
      submissionDeadline: submissionDeadline.toISOString(),
      targets: [
        {
          participantId,
          participantProfileId,
          displayName: "Ján Elektrikár",
          relationshipKind: "SITE_MANAGER",
          overlapStartedAt: overlapStartedAt.toISOString(),
          overlapEndedAt: overlapEndedAt.toISOString(),
          verifiedProfessionCodes: ["PROF:ELECTRICIAN"],
          verifiedRoles: ["MEMBER"],
          evaluation: {
            evaluationId,
            revisionId,
            version: 1,
            submittedAt: submittedAt.toISOString(),
            revisedAt: submittedAt.toISOString(),
            editDeadline: editDeadline.toISOString(),
            ratings,
            comment: "Odborne samostatná práca.",
          },
        },
      ],
    });
  });

  it("returns target-owned received evaluations and one authorized raw detail", async () => {
    const { app, getById, getReceivedForTarget } = build();
    const received = await app.inject({ method: "GET", url: receivedPath });
    const rawDetail = await app.inject({ method: "GET", url: detailPath });

    const expected = {
      sourceType: "SUPERVISOR_EVALUATION",
      evaluationId,
      targetParticipantId: participantId,
      targetProfileId: participantProfileId,
      evaluatorDisplayName: "Stavbyvedúci Milan",
      relationshipKind: "SITE_MANAGER",
      overlapStartedAt: overlapStartedAt.toISOString(),
      overlapEndedAt: overlapEndedAt.toISOString(),
      verifiedProfessionCodes: ["PROF:ELECTRICIAN"],
      verifiedTargetRoles: ["MEMBER"],
      submittedAt: submittedAt.toISOString(),
      revisedAt: submittedAt.toISOString(),
      ratings,
      comment: "Odborne samostatná práca.",
    };
    expect(received.statusCode).toBe(200);
    expect(received.json()).toEqual({ jobId, evaluations: [expected] });
    expect(received.body).not.toContain(actorUserId);
    expect(rawDetail.statusCode).toBe(200);
    expect(rawDetail.json()).toEqual(expected);
    expect(rawDetail.body).not.toContain(actorUserId);
    expect(getReceivedForTarget).toHaveBeenCalledWith({ actorUserId, jobId });
    expect(getById).toHaveBeenCalledWith({
      actorUserId,
      jobId,
      evaluationId,
    });
  });

  it("uses uniform not-found for every unauthorized private read", async () => {
    const { app } = build({
      evaluatorPage: null,
      receivedPage: null,
      detail: null,
    });
    for (const url of [evaluatorPath, receivedPath, detailPath]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ code: "NOT_FOUND" });
    }
  });

  it("denies anonymous and inactive sessions before all persistence calls", async () => {
    for (const [status, expected] of [
      ["AUTHENTICATION_REQUIRED", 401],
      ["ACCOUNT_NOT_ACTIVE", 403],
    ] as const) {
      const fixture = build({ status });
      for (const url of [evaluatorPath, receivedPath, detailPath]) {
        expect(
          (await fixture.app.inject({ method: "GET", url })).statusCode,
        ).toBe(expected);
      }
      expect(
        (
          await fixture.app.inject({
            method: "POST",
            url: participantPath,
            headers: { "x-csrf-token": "valid" },
            payload: body,
          })
        ).statusCode,
      ).toBe(expected);
      expect(fixture.getForEvaluator).not.toHaveBeenCalled();
      expect(fixture.getReceivedForTarget).not.toHaveBeenCalled();
      expect(fixture.getById).not.toHaveBeenCalled();
      expect(fixture.submit).not.toHaveBeenCalled();
    }
  });

  it("requires CSRF and derives author, Job and target only from session and path", async () => {
    const { app, csrfProtection, submit } = build();
    expect(
      (
        await app.inject({
          method: "POST",
          url: participantPath,
          payload: body,
        })
      ).statusCode,
    ).toBe(403);
    expect(submit).not.toHaveBeenCalled();

    const response = await app.inject({
      method: "POST",
      url: participantPath,
      headers: { "x-csrf-token": "valid" },
      payload: body,
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.json()).toEqual({
      status: "APPLIED",
      evaluationId,
      revisionId: commandId,
      version: 1,
      recordedAt: submittedAt.toISOString(),
    });
    expect(submit).toHaveBeenCalledWith({
      actorUserId,
      commandId,
      expectedVersion: 0,
      jobId,
      targetParticipantId: participantId,
      ratings,
      comment: "Odborne samostatná práca.",
    });
    expect(csrfProtection).toHaveBeenCalled();
  });

  it("rejects client-directed, malformed, partial, extra and all-N/A bodies", async () => {
    const { app, submit } = build();
    const invalid = [
      { ...body, actorUserId },
      { ...body, targetParticipantId: participantId },
      { ...body, sourceType: "SUPERVISOR_EVALUATION" },
      { ...body, relationshipKind: "SITE_MANAGER" },
      { ...body, expectedVersion: -1 },
      { ...body, expectedVersion: 0.5 },
      { ...body, commandId: "not-a-uuid" },
      { ...body, ratings: { ...ratings, reliability: 6 } },
      {
        ...body,
        ratings: Object.fromEntries(
          Object.keys(ratings).map((key) => [key, null]),
        ),
      },
      { ...body, ratings: { competence_quality: 5 } },
      { ...body, ratings: { ...ratings, hidden_score: 5 } },
      { ...body, comment: " medzery " },
      { ...body, comment: "riadok\nnavyše" },
      { ...body, comment: "x".repeat(2_001) },
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

  it("rejects query strings and malformed private route identities", async () => {
    const fixture = build();
    for (const url of [evaluatorPath, receivedPath, detailPath]) {
      expect(
        (await fixture.app.inject({ method: "GET", url: `${url}?raw=true` }))
          .statusCode,
      ).toBe(400);
    }
    expect(
      (
        await fixture.app.inject({
          method: "POST",
          url: `${participantPath}?author=${actorUserId}`,
          headers: { "x-csrf-token": "valid" },
          payload: body,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await fixture.app.inject({
          method: "GET",
          url: JOB_SUPERVISOR_EVALUATION_PATHS.detail
            .replace(":jobId", jobId)
            .replace(":evaluationId", "not-a-uuid"),
        })
      ).statusCode,
    ).toBe(400);
    expect(fixture.getForEvaluator).not.toHaveBeenCalled();
    expect(fixture.getReceivedForTarget).not.toHaveBeenCalled();
    expect(fixture.getById).not.toHaveBeenCalled();
    expect(fixture.submit).not.toHaveBeenCalled();
  });

  it("maps retry, state and idempotency outcomes without leaking internals", async () => {
    const { app, getById, submit } = build();
    const post = () =>
      app.inject({
        method: "POST",
        url: participantPath,
        headers: { "x-csrf-token": "valid" },
        payload: body,
      });

    submit.mockResolvedValueOnce({
      status: "DEDUPLICATED",
      evaluationId,
      revisionId: commandId,
      version: 1,
      recordedAt: submittedAt,
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
      new JobSupervisorEvaluationIdempotencyError(
        "private evaluator and target detail",
      ),
    );
    expect((await post()).json()).toEqual({ code: "IDEMPOTENCY_CONFLICT" });
    submit.mockRejectedValueOnce(new TypeError("private rating detail"));
    expect((await post()).json()).toEqual({ code: "INVALID_REQUEST" });
    submit.mockRejectedValueOnce(new Error("private comment detail"));
    const unavailable = await post();
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toEqual({ code: "TEMPORARILY_UNAVAILABLE" });
    expect(unavailable.body).not.toContain("private comment detail");

    getById.mockRejectedValueOnce(new Error("private raw evaluation detail"));
    const readFailure = await app.inject({ method: "GET", url: detailPath });
    expect(readFailure.statusCode).toBe(503);
    expect(readFailure.body).not.toContain("private raw evaluation detail");
  });
});
