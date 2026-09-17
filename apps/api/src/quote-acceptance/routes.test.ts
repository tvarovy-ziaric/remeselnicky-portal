import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type HookHandlerDoneFunction,
} from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { QuoteAcceptanceIdempotencyError, type UserId } from "@portal/domain";

import {
  QUOTE_ACCEPTANCE_PATH,
  registerQuoteAcceptanceRoutes,
} from "./routes.js";

const actorUserId = "86200000-0000-4000-8000-000000000001" as UserId;
const jobRequestId = "86200000-0000-4000-8000-000000000002";
const quoteId = "86200000-0000-4000-8000-000000000003";
const jobId = "86200000-0000-4000-8000-000000000004";
const commandId = "86200000-0000-4000-8000-000000000005";
const acceptedAt = new Date("2026-09-16T13:00:00.000Z");
const path = QUOTE_ACCEPTANCE_PATH.replace(
  ":jobRequestId",
  jobRequestId,
).replace(":quoteId", quoteId);
const body = {
  commandId,
  explicitlyConfirmed: true,
  expectedQuoteStateRevision: 3,
  expectedRequestContentRevision: 5,
  expectedRequestVisibleVersion: 2,
  quoteRevision: 1,
};
const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe("Quote acceptance route", () => {
  it("derives the customer actor, enforces CSRF and returns only Job identity", async () => {
    const accept = vi.fn(() =>
      Promise.resolve({ acceptedAt, jobId, status: "APPLIED" as const }),
    );
    const csrf = vi.fn(
      (
        _request: FastifyRequest,
        _reply: FastifyReply,
        done: HookHandlerDoneFunction,
      ): void => done(),
    );
    const app = build({ accept, csrf });
    const response = await app.inject({
      method: "POST",
      payload: body,
      url: path,
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(response.json()).toEqual({
      acceptedAt: acceptedAt.toISOString(),
      jobId,
      status: "APPLIED",
    });
    expect(csrf).toHaveBeenCalledOnce();
    expect(accept).toHaveBeenCalledWith({
      actorUserId,
      commandId,
      explicitlyConfirmed: true,
      expectedQuoteStateRevision: 3,
      expectedRequestContentRevision: 5,
      expectedRequestVisibleVersion: 2,
      jobRequestId,
      quoteId,
      quoteRevision: 1,
    });
  });

  it("returns an idempotent replay without a second creation response", async () => {
    const app = build({
      accept: vi.fn(() =>
        Promise.resolve({ acceptedAt, jobId, status: "DEDUPLICATED" as const }),
      ),
    });
    const response = await app.inject({
      method: "POST",
      payload: body,
      url: path,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      acceptedAt: acceptedAt.toISOString(),
      jobId,
      status: "DEDUPLICATED",
    });
  });

  it("passes a bounded final exact address to the atomic command without accepting a location override", async () => {
    const accept = vi.fn(() =>
      Promise.resolve({ acceptedAt, jobId, status: "APPLIED" as const }),
    );
    const app = build({ accept });
    const response = await app.inject({
      method: "POST",
      payload: { ...body, finalExactAddress: "Hlavná 12" },
      url: path,
    });
    expect(response.statusCode).toBe(201);
    expect(accept).toHaveBeenCalledWith(
      expect.objectContaining({ finalExactAddress: "Hlavná 12" }),
    );
    for (const payload of [
      { ...body, finalExactAddress: "" },
      { ...body, finalExactAddress: "x".repeat(501) },
      { ...body, finalExactAddress: "Hlavná 12", municipalityCode: "OTHER" },
    ]) {
      expect(
        (await app.inject({ method: "POST", payload, url: path })).statusCode,
      ).toBe(400);
    }
    expect(accept).toHaveBeenCalledTimes(1);
  });

  it("rejects absent/inactive actors and CSRF before persistence", async () => {
    const accept = vi.fn(() =>
      Promise.resolve({ status: "NOT_FOUND" as const }),
    );
    const unauthenticated = build({
      accept,
      status: "AUTHENTICATION_REQUIRED",
    });
    const inactive = build({ accept, status: "ACCOUNT_NOT_ACTIVE" });
    const deniedCsrf = build({
      accept,
      csrf: (_request, reply) => {
        void reply.code(403).send({ code: "CSRF_REJECTED" });
      },
    });
    expect(
      (
        await unauthenticated.inject({
          method: "POST",
          payload: body,
          url: path,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await inactive.inject({ method: "POST", payload: body, url: path }))
        .statusCode,
    ).toBe(403);
    expect(
      (await deniedCsrf.inject({ method: "POST", payload: body, url: path }))
        .statusCode,
    ).toBe(403);
    expect(accept).not.toHaveBeenCalled();
  });

  it("rejects malformed IDs, missing explicit confirmation and extra fields", async () => {
    const accept = vi.fn(() =>
      Promise.resolve({ status: "NOT_FOUND" as const }),
    );
    const app = build({ accept });
    const invalid = [
      { ...body, explicitlyConfirmed: false },
      { ...body, unexpected: "client-status" },
      { ...body, expectedQuoteStateRevision: 0 },
      { ...body, commandId: "not-a-command-id" },
    ];
    for (const payload of invalid)
      expect(
        (await app.inject({ method: "POST", payload, url: path })).statusCode,
      ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          payload: body,
          url: path.replace(jobRequestId, "not-a-request"),
        })
      ).statusCode,
    ).toBe(400);
    expect(accept).not.toHaveBeenCalled();
  });

  it("uses uniform private failure codes and hides persistence exceptions", async () => {
    const cases = [
      { result: "NOT_FOUND", expected: 404 },
      { result: "STALE_REVISION", expected: 409 },
      { result: "NOT_ACCEPTABLE", expected: 409 },
      { result: "ADDRESS_REQUIRED", expected: 409 },
    ] as const;
    for (const item of cases) {
      const app = build({
        accept: vi.fn(() => Promise.resolve({ status: item.result })),
      });
      const response = await app.inject({
        method: "POST",
        payload: body,
        url: path,
      });
      expect(response.statusCode).toBe(item.expected);
      expect(response.json()).toEqual({ code: item.result });
    }
    const conflict = build({
      accept: vi.fn(() =>
        Promise.reject(new QuoteAcceptanceIdempotencyError("private intent")),
      ),
    });
    expect(
      (
        await conflict.inject({ method: "POST", payload: body, url: path })
      ).json(),
    ).toEqual({ code: "IDEMPOTENCY_CONFLICT" });
    const broken = build({
      accept: vi.fn(() => Promise.reject(new Error("private database detail"))),
    });
    const response = await broken.inject({
      method: "POST",
      payload: body,
      url: path,
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ code: "TEMPORARILY_UNAVAILABLE" });
    expect(response.body).not.toContain("private database detail");
  });
});

function build(overrides: {
  accept?: ReturnType<typeof vi.fn>;
  csrf?: (
    request: FastifyRequest,
    reply: FastifyReply,
    done: HookHandlerDoneFunction,
  ) => void;
  status?: "ACTIVE" | "ACCOUNT_NOT_ACTIVE" | "AUTHENTICATION_REQUIRED";
}) {
  const app = Fastify();
  apps.push(app);
  registerQuoteAcceptanceRoutes(app, {
    acceptance: {
      accept: (overrides.accept ??
        vi.fn(() =>
          Promise.resolve({ status: "NOT_FOUND" as const }),
        )) as never,
    },
    csrfProtection: overrides.csrf ?? ((_request, _reply, done) => done()),
    guard: {
      evaluate: () =>
        Promise.resolve(
          overrides.status === undefined || overrides.status === "ACTIVE"
            ? { status: "ACTIVE" as const, user: { id: actorUserId } }
            : { status: overrides.status },
        ),
    },
    rateLimit: { max: 10, timeWindowMs: 60_000 },
  });
  return app;
}
