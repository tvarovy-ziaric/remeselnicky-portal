import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type HookHandlerDoneFunction,
} from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UserId } from "@portal/domain";

import { JOB_COMPLETION_PATHS, registerJobCompletionRoutes } from "./routes.js";

const actorUserId = "89600000-0000-4000-8000-000000000001" as UserId;
const jobId = "89600000-0000-4000-8000-000000000002";
const attemptId = "89600000-0000-4000-8000-000000000003";
const commandId = "89600000-0000-4000-8000-000000000004";
const mediaId = "89600000-0000-4000-8000-000000000005";
const at = new Date("2026-09-17T09:00:00.000Z");
const path = (template: string) =>
  template.replace(":jobId", jobId).replace(":attemptId", attemptId);
const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function build(input?: {
  status?: "ACTIVE" | "AUTHENTICATION_REQUIRED" | "ACCOUNT_NOT_ACTIVE";
  csrf?: (
    request: FastifyRequest,
    reply: FastifyReply,
    done: HookHandlerDoneFunction,
  ) => void;
}) {
  const app = Fastify();
  const completion = {
    list: vi.fn(() =>
      Promise.resolve({
        jobState: "COMPLETION_REQUESTED",
        attempts: [
          {
            id: attemptId,
            attemptNumber: 1,
            requestedAt: at,
            requestedByUserId: actorUserId,
            note: "Súkromná poznámka",
            physicalWorkFinishedOn: "2026-09-16",
            finalMediaAssetIds: [mediaId],
            outcome: "PENDING" as const,
            decidedAt: null,
            decidedByUserId: null,
            rejectionCategory: null,
            rejectionReason: null,
            objectionMediaAssetIds: [],
          },
        ],
      }),
    ),
    request: vi.fn(() =>
      Promise.resolve({
        status: "APPLIED" as const,
        jobState: "COMPLETION_REQUESTED",
        attemptId,
        recordedAt: at,
      }),
    ),
    accept: vi.fn(() =>
      Promise.resolve({
        status: "APPLIED" as const,
        jobState: "COMPLETED",
        attemptId,
        recordedAt: at,
      }),
    ),
    reject: vi.fn(() =>
      Promise.resolve({
        status: "APPLIED" as const,
        jobState: "IN_PROGRESS",
        attemptId,
        recordedAt: at,
      }),
    ),
    withdraw: vi.fn(() =>
      Promise.resolve({
        status: "APPLIED" as const,
        jobState: "IN_PROGRESS",
        attemptId,
        recordedAt: at,
      }),
    ),
  };
  registerJobCompletionRoutes(app, {
    completion,
    csrfProtection: input?.csrf ?? ((_request, _reply, done) => done()),
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
  return { app, completion };
}

describe("private Job completion transport", () => {
  it("reads only through the session actor and exposes bounded private download paths", async () => {
    const { app, completion } = build();
    const response = await app.inject({
      method: "GET",
      url: path(JOB_COMPLETION_PATHS.collection),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(completion.list).toHaveBeenCalledWith({ actorUserId, jobId });
    expect(response.json()).toMatchObject({
      jobState: "COMPLETION_REQUESTED",
      attempts: [
        {
          id: attemptId,
          requestedAt: at.toISOString(),
          finalMediaDownloadPaths: [`/v1/media/${mediaId}/download`],
        },
      ],
    });
    expect(response.body).not.toContain("requestedByUserId");
    expect(response.body).not.toContain("finalMediaAssetIds");
    completion.list.mockResolvedValueOnce(null as never);
    const foreign = await app.inject({
      method: "GET",
      url: path(JOB_COMPLETION_PATHS.collection),
    });
    expect(foreign.statusCode).toBe(404);
  });

  it("requires active account, CSRF and exact command fields", async () => {
    const csrf = vi.fn(
      (
        _request: FastifyRequest,
        reply: FastifyReply,
        done: HookHandlerDoneFunction,
      ) => {
        if (_request.headers["x-csrf-token"] !== "ok") {
          void reply.code(403).send({ code: "CSRF_REQUIRED" });
          return;
        }
        done();
      },
    );
    const { app, completion } = build({ csrf });
    const requestUrl = path(JOB_COMPLETION_PATHS.request);
    expect(
      (
        await app.inject({
          method: "POST",
          url: requestUrl,
          payload: { commandId },
        })
      ).statusCode,
    ).toBe(403);
    const body = {
      commandId,
      note: "Práca dokončená",
      physicalWorkFinishedOn: "2026-09-16",
      finalMediaAssetIds: [mediaId],
    };
    const accepted = await app.inject({
      method: "POST",
      url: requestUrl,
      headers: { "x-csrf-token": "ok" },
      payload: body,
    });
    expect(accepted.statusCode).toBe(201);
    expect(completion.request).toHaveBeenCalledWith({
      actorUserId,
      jobId,
      ...body,
    });
    for (const invalid of [
      { ...body, paymentStatus: "PAID" },
      { ...body, finalMediaAssetIds: [mediaId, mediaId] },
      { ...body, physicalWorkFinishedOn: "tomorrow" },
    ]) {
      expect(
        (
          await app.inject({
            method: "POST",
            url: requestUrl,
            headers: { "x-csrf-token": "ok" },
            payload: invalid,
          })
        ).statusCode,
      ).toBe(400);
    }
    expect(completion.request).toHaveBeenCalledTimes(1);
    expect(csrf).toHaveBeenCalled();
    const anonymous = build({ status: "AUTHENTICATION_REQUIRED" });
    expect(
      (
        await anonymous.app.inject({
          method: "GET",
          url: path(JOB_COMPLETION_PATHS.collection),
        })
      ).statusCode,
    ).toBe(401);
    expect(anonymous.completion.list).not.toHaveBeenCalled();
  });

  it("routes exact-attempt accept/reject/withdraw and hides persistence errors", async () => {
    const { app, completion } = build();
    const accept = await app.inject({
      method: "POST",
      url: path(JOB_COMPLETION_PATHS.accept),
      payload: { commandId },
    });
    expect(accept.statusCode).toBe(201);
    expect(completion.accept).toHaveBeenCalledWith({
      actorUserId,
      jobId,
      attemptId,
      commandId,
    });
    const reject = await app.inject({
      method: "POST",
      url: path(JOB_COMPLETION_PATHS.reject),
      payload: {
        commandId,
        category: "DEFECT",
        reason: "Treba odstrániť nedostatok",
        evidenceMediaAssetIds: [mediaId],
      },
    });
    expect(reject.statusCode).toBe(201);
    expect(completion.reject).toHaveBeenCalledWith({
      actorUserId,
      jobId,
      attemptId,
      commandId,
      category: "DEFECT",
      reason: "Treba odstrániť nedostatok",
      evidenceMediaAssetIds: [mediaId],
    });
    const withdraw = await app.inject({
      method: "POST",
      url: path(JOB_COMPLETION_PATHS.withdraw),
      payload: { commandId, reason: "Potrebná schválená zmena" },
    });
    expect(withdraw.statusCode).toBe(201);
    expect(completion.withdraw).toHaveBeenCalledWith({
      actorUserId,
      jobId,
      attemptId,
      commandId,
      reason: "Potrebná schválená zmena",
    });
    completion.accept.mockRejectedValueOnce(
      new Error("private database detail"),
    );
    const unavailable = await app.inject({
      method: "POST",
      url: path(JOB_COMPLETION_PATHS.accept),
      payload: { commandId },
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.body).not.toContain("private database detail");
  });
});
