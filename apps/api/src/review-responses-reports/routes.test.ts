import {
  ModerationReportIdempotencyError,
  ReviewResponseIdempotencyError,
  type ReviewResponseReportRepository,
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
  registerReviewResponseReportRoutes,
  REVIEW_RESPONSE_REPORT_PATHS,
} from "./routes.js";

const actorUserId = "a2000000-0000-4000-8000-000000000001" as UserId;
const reviewId = "a2000000-0000-4000-8000-000000000002";
const commandId = "a2000000-0000-4000-8000-000000000003";
const responseId = "a2000000-0000-4000-8000-000000000004";
const recordedAt = new Date("2026-09-24T15:00:00.000Z");
const editDeadline = new Date("2026-09-24T16:00:00.000Z");
const apps: FastifyInstance[] = [];

function build(
  status:
    "ACTIVE" | "AUTHENTICATION_REQUIRED" | "ACCOUNT_NOT_ACTIVE" = "ACTIVE",
) {
  const app = Fastify();
  const getResponseForOwner = vi.fn<
    ReviewResponseReportRepository["getResponseForOwner"]
  >(() =>
    Promise.resolve({
      responseId,
      reviewId,
      revisionId: commandId,
      version: 1,
      body: "Ďakujeme za vecnú spätnú väzbu.",
      respondedAt: recordedAt,
      revisedAt: recordedAt,
      editDeadline,
    }),
  );
  const submitResponse = vi.fn<
    ReviewResponseReportRepository["submitResponse"]
  >(() =>
    Promise.resolve({
      status: "APPLIED",
      responseId,
      revisionId: commandId,
      version: 1,
      recordedAt,
    }),
  );
  const createReport = vi.fn<ReviewResponseReportRepository["createReport"]>(
    () =>
      Promise.resolve({
        status: "APPLIED",
        reportId: commandId,
        state: "OPEN",
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
  registerReviewResponseReportRoutes(app, {
    persistence: { createReport, getResponseForOwner, submitResponse },
    csrfProtection,
    guard: {
      evaluate: () =>
        Promise.resolve(
          status === "ACTIVE"
            ? { status: "ACTIVE" as const, user: { id: actorUserId } }
            : { status },
        ),
    },
    rateLimit: {
      read: { max: 30, timeWindowMs: 60_000 },
      write: { max: 5, timeWindowMs: 60_000 },
    },
  });
  apps.push(app);
  return {
    app,
    createReport,
    csrfProtection,
    getResponseForOwner,
    submitResponse,
  };
}

afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

const responsePath = REVIEW_RESPONSE_REPORT_PATHS.response.replace(
  ":reviewId",
  reviewId,
);

describe("review response and report routes", () => {
  it("reads only the reviewed owner's response with private headers", async () => {
    const { app, getResponseForOwner } = build();
    const response = await app.inject({ method: "GET", url: responsePath });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(response.json()).toEqual({
      responseId,
      reviewId,
      revisionId: commandId,
      version: 1,
      body: "Ďakujeme za vecnú spätnú väzbu.",
      respondedAt: recordedAt.toISOString(),
      revisedAt: recordedAt.toISOString(),
      editDeadline: editDeadline.toISOString(),
    });
    expect(getResponseForOwner).toHaveBeenCalledWith({ actorUserId, reviewId });
  });

  it("requires CSRF and submits one privacy-safe response as the session actor", async () => {
    const { app, submitResponse } = build();
    const payload = {
      commandId,
      expectedVersion: 0,
      body: "Ďakujeme za vecnú spätnú väzbu.",
    };
    expect(
      (await app.inject({ method: "POST", url: responsePath, payload }))
        .statusCode,
    ).toBe(403);
    expect(submitResponse).not.toHaveBeenCalled();
    const response = await app.inject({
      method: "POST",
      url: responsePath,
      headers: { "x-csrf-token": "valid" },
      payload,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      responseId,
      status: "APPLIED",
      version: 1,
    });
    expect(submitResponse).toHaveBeenCalledWith({
      actorUserId,
      reviewId,
      ...payload,
    });
  });

  it("creates a separate OPEN claim without accepting a client-selected state", async () => {
    const { app, createReport } = build();
    const payload = {
      commandId,
      targetType: "MAIN_REVIEW",
      targetId: reviewId,
      reason: "EXTORTION_RETALIATION",
      details: "Požiadavka na protislužbu za zmenu hodnotenia.",
    };
    const response = await app.inject({
      method: "POST",
      url: REVIEW_RESPONSE_REPORT_PATHS.reports,
      headers: { "x-csrf-token": "valid" },
      payload,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      status: "APPLIED",
      reportId: commandId,
      state: "OPEN",
      recordedAt: recordedAt.toISOString(),
    });
    expect(createReport).toHaveBeenCalledWith({ actorUserId, ...payload });

    const invalid = await app.inject({
      method: "POST",
      url: REVIEW_RESPONSE_REPORT_PATHS.reports,
      headers: { "x-csrf-token": "valid" },
      payload: { ...payload, state: "ACTIONED" },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("rejects malformed, unsafe, unexpected and query-bearing requests before persistence", async () => {
    const { app, createReport, submitResponse } = build();
    for (const payload of [
      { commandId, expectedVersion: 0, body: "Kontakt +421 900 123 456" },
      { commandId, expectedVersion: -1, body: "Platný text." },
      { commandId, expectedVersion: 0, body: " medzery " },
      { commandId, expectedVersion: 0, body: "Platný text.", extra: true },
    ]) {
      expect(
        (
          await app.inject({
            method: "POST",
            url: responsePath,
            headers: { "x-csrf-token": "valid" },
            payload,
          })
        ).statusCode,
      ).toBe(400);
    }
    expect(
      (
        await app.inject({
          method: "POST",
          url: REVIEW_RESPONSE_REPORT_PATHS.reports,
          headers: { "x-csrf-token": "valid" },
          payload: {
            commandId,
            targetType: "MESSAGE",
            targetId: reviewId,
            reason: "DISLIKE",
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "GET", url: `${responsePath}?private=1` }))
        .statusCode,
    ).toBe(400);
    expect(submitResponse).not.toHaveBeenCalled();
    expect(createReport).not.toHaveBeenCalled();
  });

  it("maps absence and conflicts narrowly while redacting unexpected errors", async () => {
    const { app, getResponseForOwner, submitResponse, createReport } = build();
    getResponseForOwner.mockResolvedValueOnce(null);
    expect(
      (await app.inject({ method: "GET", url: responsePath })).statusCode,
    ).toBe(404);
    submitResponse.mockResolvedValueOnce({ status: "EDIT_LOCKED" });
    expect(
      (
        await app.inject({
          method: "POST",
          url: responsePath,
          headers: { "x-csrf-token": "valid" },
          payload: { commandId, expectedVersion: 1, body: "Vecná odpoveď." },
        })
      ).statusCode,
    ).toBe(409);
    submitResponse.mockRejectedValueOnce(
      new ReviewResponseIdempotencyError("private response detail"),
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: responsePath,
          headers: { "x-csrf-token": "valid" },
          payload: { commandId, expectedVersion: 0, body: "Vecná odpoveď." },
        })
      ).json(),
    ).toEqual({ code: "IDEMPOTENCY_CONFLICT" });
    createReport.mockRejectedValueOnce(
      new ModerationReportIdempotencyError("private report detail"),
    );
    const report = await app.inject({
      method: "POST",
      url: REVIEW_RESPONSE_REPORT_PATHS.reports,
      headers: { "x-csrf-token": "valid" },
      payload: {
        commandId,
        targetType: "MAIN_REVIEW",
        targetId: reviewId,
        reason: "OTHER",
      },
    });
    expect(report.json()).toEqual({ code: "IDEMPOTENCY_CONFLICT" });
    expect(report.body).not.toContain("private report detail");
  });

  it.each([
    ["AUTHENTICATION_REQUIRED", 401],
    ["ACCOUNT_NOT_ACTIVE", 403],
  ] as const)("rejects %s before persistence", async (status, expected) => {
    const { app, getResponseForOwner } = build(status);
    expect(
      (await app.inject({ method: "GET", url: responsePath })).statusCode,
    ).toBe(expected);
    expect(getResponseForOwner).not.toHaveBeenCalled();
  });
});
