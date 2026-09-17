import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type HookHandlerDoneFunction,
} from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UserId } from "@portal/domain";

import { registerJobMilestoneRoutes } from "./routes.js";

const actorUserId = "86210000-0000-4000-8000-000000000001" as UserId;
const jobId = "86210000-0000-4000-8000-000000000002";
const milestoneId = "86210000-0000-4000-8000-000000000003";
const commandId = "86210000-0000-4000-8000-000000000004";
const quoteId = "86210000-0000-4000-8000-000000000005";
const at = new Date("2026-09-17T08:00:00.000Z");
const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));
type CommandResultMock =
  | {
      readonly status: "APPLIED" | "DEDUPLICATED";
      readonly milestoneId: string;
    }
  | { readonly status: "NOT_FOUND" | "STALE_STATE" };
const applied = (): Promise<CommandResultMock> =>
  Promise.resolve({ status: "APPLIED", milestoneId });

function build(
  status:
    "ACTIVE" | "AUTHENTICATION_REQUIRED" | "ACCOUNT_NOT_ACTIVE" = "ACTIVE",
) {
  const app = Fastify();
  const item = {
    id: milestoneId,
    jobId,
    title: "Príprava pracoviska",
    description: null,
    state: "PLANNED" as const,
    orderIndex: 0,
    originalPlannedStartOn: "2026-09-20",
    originalPlannedEndOn: "2026-09-21",
    currentPlannedStartOn: "2026-09-20",
    currentPlannedEndOn: "2026-09-21",
    acceptedStageLabel: "Etapa 1",
    sourceQuoteId: quoteId,
    sourceQuoteRevision: 2,
    sourcePdfDownloadPath: null,
    responsibility: null,
    createdAt: at,
    updatedAt: at,
    acknowledgedAt: null,
    capabilities: {
      canEdit: true,
      canSetState: true,
      canMarkDone: true,
      canReorder: true,
      canAssign: true,
      canAcknowledge: false,
    },
  };
  const milestones = {
    list: vi.fn(() =>
      Promise.resolve({ items: [item], canCreate: true, nextCursor: null }),
    ),
    get: vi.fn(() => Promise.resolve<typeof item | null>(item)),
    listHistory: vi.fn(() =>
      Promise.resolve({
        items: [
          {
            eventId: commandId,
            sequence: 2,
            kind: "STATE" as const,
            actorUserId,
            title: item.title,
            description: null,
            plannedStartOn: "2026-09-20",
            plannedEndOn: "2026-09-21",
            state: "IN_PROGRESS" as const,
            orderKey: "1.00000000000000000000",
            responsibility: null,
            acceptedStageLabel: item.acceptedStageLabel,
            sourceQuoteId: quoteId,
            sourceQuoteRevision: 2,
            sourcePdfDownloadPath: null,
            recordedAt: at,
          },
        ],
        nextCursor: 2,
      }),
    ),
    create: vi.fn(applied),
    edit: vi.fn(applied),
    setState: vi.fn(applied),
    reorder: vi.fn(applied),
    assign: vi.fn(applied),
    acknowledge: vi.fn(applied),
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
  registerJobMilestoneRoutes(app, {
    milestones,
    guard,
    csrfProtection,
    rateLimit: { max: 20, timeWindowMs: 60_000 },
  });
  apps.push(app);
  return { app, milestones, guard, csrfProtection };
}

const collection = `/v1/me/jobs/${jobId}/milestones`;
const detail = `${collection}/${milestoneId}`;

describe("private Job milestone routes", () => {
  it("reads an exact authorized ordered page with private headers and source provenance", async () => {
    const { app, milestones } = build();
    const response = await app.inject({
      method: "GET",
      url: `${collection}?limit=20`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(response.json()).toMatchObject({
      canCreate: true,
      items: [
        {
          id: milestoneId,
          sourceQuoteId: quoteId,
          sourceQuoteRevision: 2,
          createdAt: at.toISOString(),
          capabilities: { canMarkDone: true },
        },
      ],
    });
    expect(milestones.list).toHaveBeenCalledWith({
      actorUserId,
      jobId,
      limit: 20,
    });
    const exact = await app.inject({ method: "GET", url: detail });
    expect(exact.statusCode).toBe(200);
    expect(milestones.get).toHaveBeenCalledWith({
      actorUserId,
      jobId,
      milestoneId,
    });
  });

  it("fails closed for anonymous/inactive/foreign or malformed reads", async () => {
    for (const [status, expected] of [
      ["AUTHENTICATION_REQUIRED", 401],
      ["ACCOUNT_NOT_ACTIVE", 403],
    ] as const) {
      const { app, milestones } = build(status);
      const result = await app.inject({ method: "GET", url: collection });
      expect(result.statusCode).toBe(expected);
      expect(result.headers["cache-control"]).toBe("private, no-store");
      expect(milestones.list).not.toHaveBeenCalled();
    }
    const { app, milestones } = build();
    milestones.get.mockResolvedValueOnce(null);
    expect((await app.inject({ method: "GET", url: detail })).statusCode).toBe(
      404,
    );
    expect(
      (await app.inject({ method: "GET", url: `${collection}?unexpected=1` }))
        .statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "GET", url: `${collection}?afterOrder=1` }))
        .statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "GET", url: `${detail}?x=1` })).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/me/jobs/not-a-uuid/milestones",
        })
      ).statusCode,
    ).toBe(400);
  });

  it("serves private exact milestone history and rejects malformed or unauthorized history", async () => {
    const { app, milestones } = build();
    const url = `${detail}/history`;
    const response = await app.inject({
      method: "GET",
      url: `${url}?limit=10&beforeSequence=3`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.json()).toMatchObject({
      nextCursor: 2,
      items: [
        {
          sequence: 2,
          orderKey: "1.00000000000000000000",
          recordedAt: at.toISOString(),
        },
      ],
    });
    expect(milestones.listHistory).toHaveBeenCalledWith({
      actorUserId,
      jobId,
      milestoneId,
      limit: 10,
      beforeSequence: 3,
    });
    for (const suffix of [
      "?limit=0",
      "?limit=21",
      "?beforeSequence=0",
      "?x=1",
      "?limit=1&limit=2",
    ]) {
      expect(
        (await app.inject({ method: "GET", url: `${url}${suffix}` }))
          .statusCode,
      ).toBe(400);
    }
    milestones.listHistory.mockResolvedValueOnce(null as never);
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(404);
    const anonymous = build("AUTHENTICATION_REQUIRED");
    expect(
      (await anonymous.app.inject({ method: "GET", url })).statusCode,
    ).toBe(401);
    expect(anonymous.milestones.listHistory).not.toHaveBeenCalled();
  });

  it("creates only with CSRF and exact operational fields, never price or agreement mutation", async () => {
    const { app, milestones } = build();
    const body = {
      commandId,
      title: "Príprava pracoviska",
      plannedStartOn: "2026-09-20",
      plannedEndOn: "2026-09-21",
      acceptedStageLabel: "Etapa 1",
    };
    const denied = await app.inject({
      method: "POST",
      url: collection,
      payload: body,
    });
    expect(denied.statusCode).toBe(403);
    expect(milestones.create).not.toHaveBeenCalled();
    const result = await app.inject({
      method: "POST",
      url: collection,
      headers: { "x-csrf-token": "valid" },
      payload: body,
    });
    expect(result.statusCode).toBe(201);
    expect(result.json()).toEqual({ status: "APPLIED", milestoneId });
    expect(milestones.create).toHaveBeenCalledWith({
      actorUserId,
      jobId,
      ...body,
    });
    for (const invalid of [
      { ...body, priceCents: 100 },
      { ...body, plannedStartOn: "2026-02-30" },
      { ...body, plannedEndOn: "2026-09-19" },
    ]) {
      expect(
        (
          await app.inject({
            method: "POST",
            url: collection,
            headers: { "x-csrf-token": "valid" },
            payload: invalid,
          })
        ).statusCode,
      ).toBe(400);
    }
    expect(milestones.create).toHaveBeenCalledTimes(1);
    milestones.create.mockResolvedValueOnce({
      status: "DEDUPLICATED",
      milestoneId,
    });
    const replay = await app.inject({
      method: "POST",
      url: collection,
      headers: { "x-csrf-token": "valid" },
      payload: body,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ status: "DEDUPLICATED", milestoneId });
  });

  it("routes edit/state/reorder/assign/ack to server-derived actor and exact Job", async () => {
    const { app, milestones } = build();
    const commands = [
      [
        "edit",
        {
          commandId,
          title: "Príprava 2",
          description: null,
          plannedStartOn: null,
          plannedEndOn: null,
        },
        "edit",
      ],
      ["state", { commandId, state: "DONE" }, "setState"],
      ["reorder", { commandId, afterMilestoneId: null }, "reorder"],
      ["assign", { commandId, responsibility: null }, "assign"],
      ["acknowledge", { commandId }, "acknowledge"],
    ] as const;
    for (const [suffix, body, method] of commands) {
      const response = await app.inject({
        method: "POST",
        url: `${detail}/${suffix}`,
        headers: { "x-csrf-token": "valid" },
        payload: body,
      });
      expect(response.statusCode).toBe(200);
      expect(milestones[method]).toHaveBeenCalledWith({
        actorUserId,
        jobId,
        milestoneId,
        ...body,
      });
    }
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${detail}/reorder`,
          headers: { "x-csrf-token": "valid" },
          payload: { commandId, afterMilestoneId: milestoneId },
        })
      ).statusCode,
    ).toBe(400);
    milestones.setState.mockResolvedValueOnce({ status: "NOT_FOUND" });
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${detail}/state`,
          headers: { "x-csrf-token": "valid" },
          payload: { commandId, state: "DONE" },
        })
      ).statusCode,
    ).toBe(404);
  });
});
