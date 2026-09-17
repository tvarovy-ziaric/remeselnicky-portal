import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type HookHandlerDoneFunction,
} from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UserId } from "@portal/domain";

import {
  COMPLETION_PROPOSAL_PATHS,
  registerCompletionProposalRoutes,
} from "./proposal-routes.js";

const actorUserId = "89600000-0000-4000-8000-000000000001" as UserId;
const jobId = "89600000-0000-4000-8000-000000000002";
const proposalId = "89600000-0000-4000-8000-000000000003";
const commandId = "89600000-0000-4000-8000-000000000004";
const at = new Date("2026-09-17T10:00:00.000Z");
const path = (template: string) =>
  template.replace(":jobId", jobId).replace(":proposalId", proposalId);
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
  const proposals = {
    list: vi.fn(() =>
      Promise.resolve([
        {
          id: proposalId,
          proposalNumber: 1,
          proposedAt: at,
          note: "Súkromný návrh",
          outcome: "PENDING" as const,
          decidedAt: null,
          disagreementReason: null,
        },
      ]),
    ),
    propose: vi.fn(() =>
      Promise.resolve({
        status: "APPLIED" as const,
        proposalId,
        recordedAt: at,
      }),
    ),
    agree: vi.fn(() =>
      Promise.resolve({
        status: "APPLIED" as const,
        proposalId,
        recordedAt: at,
      }),
    ),
    disagree: vi.fn(() =>
      Promise.resolve({
        status: "APPLIED" as const,
        proposalId,
        recordedAt: at,
      }),
    ),
  };
  registerCompletionProposalRoutes(app, {
    proposals,
    guard: {
      evaluate: () =>
        Promise.resolve(
          input?.status === "AUTHENTICATION_REQUIRED" ||
            input?.status === "ACCOUNT_NOT_ACTIVE"
            ? { status: input.status }
            : { status: "ACTIVE", user: { id: actorUserId } },
        ),
    },
    csrfProtection: input?.csrf ?? ((_request, _reply, done) => done()),
    rateLimit: { max: 20, timeWindowMs: 60_000 },
  });
  apps.push(app);
  return { app, proposals };
}

describe("customer completion proposal transport", () => {
  it("returns a private, actor-derived proposal history without provider identity", async () => {
    const { app, proposals } = build();
    const response = await app.inject({
      method: "GET",
      url: path(COMPLETION_PROPOSAL_PATHS.collection),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(response.json()).toEqual({
      proposals: [
        {
          id: proposalId,
          proposalNumber: 1,
          proposedAt: at.toISOString(),
          note: "Súkromný návrh",
          outcome: "PENDING",
          decidedAt: null,
          disagreementReason: null,
        },
      ],
    });
    expect(response.body).not.toContain("providerUserId");
    expect(proposals.list).toHaveBeenCalledWith({ actorUserId, jobId });
    proposals.list.mockResolvedValueOnce(null as never);
    expect(
      (
        await app.inject({
          method: "GET",
          url: path(COMPLETION_PROPOSAL_PATHS.collection),
        })
      ).statusCode,
    ).toBe(404);
  });

  it("requires an active session, CSRF and exact inputs before invoking a command", async () => {
    const csrf = (
      request: FastifyRequest,
      reply: FastifyReply,
      done: HookHandlerDoneFunction,
    ) => {
      if (request.headers["x-csrf-token"] !== "ok") {
        void reply.code(403).send({ code: "CSRF_REQUIRED" });
        return;
      }
      done();
    };
    const { app, proposals } = build({ csrf });
    const url = path(COMPLETION_PROPOSAL_PATHS.collection);
    expect(
      (await app.inject({ method: "POST", url, payload: { commandId } }))
        .statusCode,
    ).toBe(403);
    expect(proposals.propose).not.toHaveBeenCalled();
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          headers: { "x-csrf-token": "ok" },
          payload: { commandId, paymentConfirmed: true },
        })
      ).statusCode,
    ).toBe(400);
    const response = await app.inject({
      method: "POST",
      url,
      headers: { "x-csrf-token": "ok" },
      payload: { commandId, note: "Práca podľa mňa skončila." },
    });
    expect(response.statusCode).toBe(201);
    expect(proposals.propose).toHaveBeenCalledWith({
      actorUserId,
      commandId,
      jobId,
      note: "Práca podľa mňa skončila.",
    });
    const inactive = build({ status: "ACCOUNT_NOT_ACTIVE" });
    expect(
      (
        await inactive.app.inject({
          method: "POST",
          url,
          payload: { commandId },
        })
      ).statusCode,
    ).toBe(403);
    expect(inactive.proposals.propose).not.toHaveBeenCalled();
  });

  it("maps provider agreement and reasoned disagreement without direct completion", async () => {
    const { app, proposals } = build();
    const agree = await app.inject({
      method: "POST",
      url: path(COMPLETION_PROPOSAL_PATHS.agree),
      payload: { commandId },
    });
    expect(agree.statusCode).toBe(201);
    expect(agree.json()).toEqual({
      status: "APPLIED",
      proposalId,
      recordedAt: at.toISOString(),
    });
    expect(proposals.agree).toHaveBeenCalledWith({
      actorUserId,
      commandId,
      jobId,
      proposalId,
    });
    const disagree = await app.inject({
      method: "POST",
      url: path(COMPLETION_PROPOSAL_PATHS.disagree),
      payload: { commandId, reason: "Práca ešte nie je dokončená." },
    });
    expect(disagree.statusCode).toBe(201);
    expect(proposals.disagree).toHaveBeenCalledWith({
      actorUserId,
      commandId,
      jobId,
      proposalId,
      reason: "Práca ešte nie je dokončená.",
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: path(COMPLETION_PROPOSAL_PATHS.disagree),
          payload: { commandId, reason: "Krátke" },
        })
      ).statusCode,
    ).toBe(400);
    proposals.agree.mockResolvedValueOnce({
      status: "STALE_PROPOSAL",
    } as never);
    expect(
      (
        await app.inject({
          method: "POST",
          url: path(COMPLETION_PROPOSAL_PATHS.agree),
          payload: { commandId },
        })
      ).statusCode,
    ).toBe(409);
  });
});
