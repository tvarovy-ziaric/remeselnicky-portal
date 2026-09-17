import type { UserId } from "@portal/domain";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type HookHandlerDoneFunction,
} from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  JOB_MILESTONE_CONTEXT_PATHS,
  registerJobMilestoneContextRoutes,
} from "./context-routes.js";

const actorUserId = "86310000-0000-4000-8000-000000000001" as UserId;
const jobId = "86310000-0000-4000-8000-000000000002";
const milestoneId = "86310000-0000-4000-8000-000000000003";
const proposalId = "86310000-0000-4000-8000-000000000004";
const commandId = "86310000-0000-4000-8000-000000000005";
const mediaAssetId = "86310000-0000-4000-8000-000000000006";
const at = new Date("2026-09-17T08:00:00.000Z");
const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function build(
  status:
    "ACTIVE" | "AUTHENTICATION_REQUIRED" | "ACCOUNT_NOT_ACTIVE" = "ACTIVE",
) {
  const app = Fastify();
  const proposal = {
    id: proposalId,
    jobId,
    targetMilestoneId: milestoneId,
    baselineEventId: commandId,
    title: "Montáž",
    description: null,
    plannedStartOn: "2026-09-20",
    plannedEndOn: "2026-09-21",
    createdAt: at,
    decision: null,
    decidedAt: null,
    appliedMilestoneId: null,
    canDecide: true,
  } as const;
  const comment = {
    id: commandId,
    milestoneId,
    authorRole: "CUSTOMER" as const,
    body: "Prosím skontrolovať.",
    createdAt: at,
  };
  const media = {
    id: commandId,
    milestoneId,
    mediaAssetId,
    kind: "PHOTO" as const,
    sourceMessageId: proposalId,
    uploadedByUserId: actorUserId,
    uploadedAt: at,
    capturedAt: null,
    displayFilename: "foto.jpg",
    contentType: "image/jpeg",
    downloadPath: `/v1/media/${mediaAssetId}/download`,
    linkedAt: at,
  };
  const result = { status: "APPLIED" as const, id: commandId, createdAt: at };
  const context = {
    listProposals: vi.fn(() =>
      Promise.resolve({
        items: [proposal],
        nextCursor: { createdAt: at, id: proposalId },
      }),
    ),
    getProposal: vi.fn(() => Promise.resolve<typeof proposal | null>(proposal)),
    createProposal: vi.fn(() => Promise.resolve(result)),
    decideProposal: vi.fn(() =>
      Promise.resolve({ ...result, appliedMilestoneId: milestoneId }),
    ),
    listComments: vi.fn(() =>
      Promise.resolve({ items: [comment], nextCursor: null }),
    ),
    addComment: vi.fn(() => Promise.resolve(result)),
    listMedia: vi.fn(() =>
      Promise.resolve({ items: [media], nextCursor: null }),
    ),
    linkMedia: vi.fn(() => Promise.resolve(result)),
  };
  const guard = {
    evaluate: vi.fn(() =>
      Promise.resolve(
        status === "ACTIVE"
          ? { status: "ACTIVE" as const, user: { id: actorUserId } }
          : { status },
      ),
    ),
  };
  const csrfProtection = vi.fn(
    (
      request: FastifyRequest,
      reply: FastifyReply,
      done: HookHandlerDoneFunction,
    ) => {
      if (request.headers["x-csrf-token"] !== "valid") {
        void reply.code(403).send({ code: "INVALID_CSRF" });
        return;
      }
      done();
    },
  );
  registerJobMilestoneContextRoutes(app, {
    context,
    guard,
    csrfProtection,
    rateLimit: { max: 20, timeWindowMs: 60_000 },
  });
  apps.push(app);
  return { app, context };
}

const proposals = `/v1/me/jobs/${jobId}/milestone-proposals`;
const proposal = `${proposals}/${proposalId}`;
const comments = `/v1/me/jobs/${jobId}/milestones/${milestoneId}/comments`;
const media = `/v1/me/jobs/${jobId}/milestones/${milestoneId}/media`;

describe("private milestone proposal and context routes", () => {
  it("registers exact paths and returns a private cursor page without internal baseline identity", async () => {
    expect(JOB_MILESTONE_CONTEXT_PATHS.proposals).toContain(
      "milestone-proposals",
    );
    const { app, context } = build();
    const response = await app.inject({
      method: "GET",
      url: `${proposals}?limit=10`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(response.json()).toMatchObject({
      nextCursor: { beforeAt: at.toISOString(), beforeId: proposalId },
      items: [{ id: proposalId, createdAt: at.toISOString(), canDecide: true }],
    });
    expect(response.json<{ items: unknown[] }>().items[0]).not.toHaveProperty(
      "baselineEventId",
    );
    expect(context.listProposals).toHaveBeenCalledWith({
      actorUserId,
      jobId,
      limit: 10,
    });
    const exact = await app.inject({ method: "GET", url: proposal });
    expect(exact.statusCode).toBe(200);
    expect(context.getProposal).toHaveBeenCalledWith({
      actorUserId,
      jobId,
      proposalId,
    });
    const second = await app.inject({
      method: "GET",
      url: `${proposals}?limit=1&beforeAt=${encodeURIComponent(at.toISOString())}&beforeId=${proposalId}`,
    });
    expect(second.statusCode).toBe(200);
    expect(context.listProposals).toHaveBeenLastCalledWith({
      actorUserId,
      jobId,
      limit: 1,
      cursor: { createdAt: at, id: proposalId },
    });
  });

  it("denies anonymous/inactive/foreign and malformed reads", async () => {
    for (const [status, expected] of [
      ["AUTHENTICATION_REQUIRED", 401],
      ["ACCOUNT_NOT_ACTIVE", 403],
    ] as const) {
      const { app, context } = build(status);
      expect(
        (await app.inject({ method: "GET", url: proposals })).statusCode,
      ).toBe(expected);
      expect(context.listProposals).not.toHaveBeenCalled();
    }
    const { app, context } = build();
    context.getProposal.mockResolvedValueOnce(null);
    expect(
      (await app.inject({ method: "GET", url: proposal })).statusCode,
    ).toBe(404);
    for (const url of [
      `${proposals}?x=1`,
      `${proposals}?limit=1&limit=2`,
      `${proposals}?limit=0`,
      `${proposals}?beforeAt=${encodeURIComponent(at.toISOString())}`,
      `${proposals}?beforeAt=2026-09-17T08%3A00%3A00Z&beforeId=${proposalId}`,
      `${proposal}?x=1`,
      `/v1/me/jobs/not-a-uuid/milestone-proposals`,
    ])
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(400);
  });

  it("requires CSRF and exact noncommercial proposal/decision fields", async () => {
    const { app, context } = build();
    const body = {
      commandId,
      title: "Montáž",
      targetMilestoneId: milestoneId,
      plannedStartOn: "2026-09-20",
      plannedEndOn: "2026-09-21",
    };
    expect(
      (await app.inject({ method: "POST", url: proposals, payload: body }))
        .statusCode,
    ).toBe(403);
    expect(context.createProposal).not.toHaveBeenCalled();
    for (const payload of [
      { ...body, price: 100 },
      { ...body, plannedEndOn: "2026-09-19" },
      { ...body, plannedStartOn: "2026-02-30" },
    ])
      expect(
        (
          await app.inject({
            method: "POST",
            url: proposals,
            headers: { "x-csrf-token": "valid" },
            payload,
          })
        ).statusCode,
      ).toBe(400);
    const created = await app.inject({
      method: "POST",
      url: proposals,
      headers: { "x-csrf-token": "valid" },
      payload: body,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({ status: "APPLIED", id: commandId });
    expect(context.createProposal).toHaveBeenCalledWith({
      actorUserId,
      jobId,
      ...body,
    });
    const decision = await app.inject({
      method: "POST",
      url: `${proposal}/decision`,
      headers: { "x-csrf-token": "valid" },
      payload: { commandId, decision: "ACCEPT" },
    });
    expect(decision.statusCode).toBe(201);
    expect(decision.json()).toMatchObject({ appliedMilestoneId: milestoneId });
    expect(context.decideProposal).toHaveBeenCalledWith({
      actorUserId,
      jobId,
      proposalId,
      commandId,
      decision: "ACCEPT",
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${proposal}/decision`,
          headers: { "x-csrf-token": "valid" },
          payload: { commandId, decision: "APPROVE" },
        })
      ).statusCode,
    ).toBe(400);
  });

  it("keeps comments and media private, exact-Job and command-guarded", async () => {
    const { app, context } = build();
    const commentPage = await app.inject({ method: "GET", url: comments });
    expect(commentPage.json<{ items: unknown[] }>().items[0]).toMatchObject({
      authorRole: "CUSTOMER",
      createdAt: at.toISOString(),
    });
    expect(
      (await app.inject({ method: "GET", url: media })).json<{
        items: unknown[];
      }>().items[0],
    ).toMatchObject({
      downloadPath: `/v1/media/${mediaAssetId}/download`,
      uploadedAt: at.toISOString(),
    });
    context.listMedia.mockResolvedValueOnce(null as never);
    expect((await app.inject({ method: "GET", url: media })).statusCode).toBe(
      404,
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: comments,
          payload: { commandId, body: "Text" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: comments,
          headers: { "x-csrf-token": "valid" },
          payload: { commandId, body: "Text", state: "DONE" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: comments,
          headers: { "x-csrf-token": "valid" },
          payload: { commandId, body: "Text" },
        })
      ).statusCode,
    ).toBe(201);
    expect(context.addComment).toHaveBeenCalledWith({
      actorUserId,
      jobId,
      milestoneId,
      commandId,
      body: "Text",
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: media,
          headers: { "x-csrf-token": "valid" },
          payload: { commandId, mediaAssetId },
        })
      ).statusCode,
    ).toBe(201);
    expect(context.linkMedia).toHaveBeenCalledWith({
      actorUserId,
      jobId,
      milestoneId,
      commandId,
      mediaAssetId,
    });
  });
});
