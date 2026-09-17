import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type HookHandlerDoneFunction,
} from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  JobLocationIdempotencyError,
  type JobContactDetails,
} from "@portal/db";
import type { UserId } from "@portal/domain";

import {
  JOB_CONTACTS_PATH,
  JOB_LOCATION_CLARIFICATION_PATH,
  registerJobContactRoutes,
} from "./routes.js";

const actorUserId = "86200000-0000-4000-8000-000000000001" as UserId;
const jobId = "86200000-0000-4000-8000-000000000004";
const url = JOB_CONTACTS_PATH.replace(":jobId", jobId);
const clarifyUrl = JOB_LOCATION_CLARIFICATION_PATH.replace(":jobId", jobId);
const commandId = "86200000-0000-4000-8000-000000000005";
const commandBody = {
  commandId,
  expectedRevision: 1,
  location: {
    exactAddress: "Syntetická 12",
    mapPin: null,
    municipalityCode: "TEST:MUNICIPALITY_ALPHA",
    textClarification: null,
  },
  reason: "Doplnenie miesta realizácie",
};
const details: JobContactDetails = {
  customer: { email: "customer@portal.invalid", phone: "+421900000001" },
  jobId,
  locationRevision: 1,
  provider: { email: "provider@portal.invalid", phone: "+421900000002" },
  workLocation: {
    exactAddress: "Syntetická 1",
    mapPin: null,
    municipalityCode: "TEST:MUNICIPALITY_ALPHA",
    textClarification: null,
  },
};
const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe("confirmed Job contacts route", () => {
  it("reads only as the session actor with private response headers", async () => {
    const read = vi.fn(() => Promise.resolve(details));
    const app = build({ read });
    const response = await app.inject({ method: "GET", url });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(details);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(read).toHaveBeenCalledWith({ actorUserId, jobId });
  });

  it("denies missing or inactive sessions before querying private data", async () => {
    const read = vi.fn(() => Promise.resolve(details));
    const anonymous = build({ read, status: "AUTHENTICATION_REQUIRED" });
    const inactive = build({ read, status: "ACCOUNT_NOT_ACTIVE" });
    const unauthenticated = await anonymous.inject({ method: "GET", url });
    const disabled = await inactive.inject({ method: "GET", url });
    expect(unauthenticated.statusCode).toBe(401);
    expect(disabled.statusCode).toBe(403);
    expect(unauthenticated.headers["cache-control"]).toBe("private, no-store");
    expect(disabled.headers["cache-control"]).toBe("private, no-store");
    expect(read).not.toHaveBeenCalled();
  });

  it("uses the same missing response for unknown Jobs and unrelated actors", async () => {
    const read = vi.fn(() => Promise.resolve(null));
    const app = build({ read });
    const response = await app.inject({ method: "GET", url });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ code: "NOT_FOUND" });
    expect(response.headers["cache-control"]).toBe("private, no-store");
  });

  it("rejects malformed IDs and does not disclose persistence errors", async () => {
    const read = vi.fn(() => Promise.reject(new Error("private contact data")));
    const app = build({ read });
    const invalid = await app.inject({
      method: "GET",
      url: JOB_CONTACTS_PATH.replace(":jobId", "not-a-job"),
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.headers["cache-control"]).toBe("private, no-store");
    expect(read).not.toHaveBeenCalled();
    const failure = await app.inject({ method: "GET", url });
    expect(failure.statusCode).toBe(503);
    expect(failure.json()).toEqual({ code: "TEMPORARILY_UNAVAILABLE" });
    expect(failure.body).not.toContain("private contact data");
  });

  it("derives the customer actor and enforces CSRF for additive location writes", async () => {
    const recordedAt = new Date("2026-09-16T18:00:00.000Z");
    const clarify = vi.fn(() =>
      Promise.resolve({ recordedAt, revision: 2, status: "APPLIED" as const }),
    );
    const csrf = vi.fn(
      (
        _request: FastifyRequest,
        _reply: FastifyReply,
        done: HookHandlerDoneFunction,
      ) => done(),
    );
    const app = build({ clarify, csrf, read: vi.fn() });
    const response = await app.inject({
      method: "POST",
      payload: commandBody,
      url: clarifyUrl,
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.json()).toEqual({
      recordedAt: recordedAt.toISOString(),
      revision: 2,
      status: "APPLIED",
    });
    expect(csrf).toHaveBeenCalledOnce();
    expect(clarify).toHaveBeenCalledWith({
      ...commandBody,
      actorUserId,
      jobId,
    });
  });

  it("denies anonymous, inactive and CSRF-rejected location writes", async () => {
    const clarify = vi.fn(() =>
      Promise.resolve({ status: "NOT_FOUND" as const }),
    );
    const anonymous = build({
      clarify,
      read: vi.fn(),
      status: "AUTHENTICATION_REQUIRED",
    });
    const inactive = build({
      clarify,
      read: vi.fn(),
      status: "ACCOUNT_NOT_ACTIVE",
    });
    const rejected = build({
      clarify,
      csrf: (_request, reply) => {
        void reply.code(403).send({ code: "CSRF_REJECTED" });
      },
      read: vi.fn(),
    });
    for (const [app, expected] of [
      [anonymous, 401],
      [inactive, 403],
      [rejected, 403],
    ] as const) {
      const response = await app.inject({
        method: "POST",
        payload: commandBody,
        url: clarifyUrl,
      });
      expect(response.statusCode).toBe(expected);
      expect(response.headers["cache-control"]).toBe("private, no-store");
    }
    expect(clarify).not.toHaveBeenCalled();
  });

  it("rejects malformed and unexpected nested fields before persistence", async () => {
    const clarify = vi.fn(() =>
      Promise.resolve({ status: "NOT_FOUND" as const }),
    );
    const app = build({ clarify, read: vi.fn() });
    for (const payload of [
      { ...commandBody, expectedRevision: 0 },
      { ...commandBody, reason: "short" },
      { ...commandBody, extra: "client-status" },
      { ...commandBody, location: { ...commandBody.location, extra: "x" } },
      {
        ...commandBody,
        location: {
          ...commandBody.location,
          mapPin: { latitude: 48, longitude: 17, extra: "x" },
        },
      },
    ]) {
      const response = await app.inject({
        method: "POST",
        payload,
        url: clarifyUrl,
      });
      expect(response.statusCode).toBe(400);
    }
    expect(clarify).not.toHaveBeenCalled();
  });

  it("returns private conflict/absence codes without persistence detail", async () => {
    for (const [status, expected] of [
      ["NOT_FOUND", 404],
      ["STALE_REVISION", 409],
      ["NOT_CLARIFICATION", 409],
    ] as const) {
      const app = build({
        clarify: vi.fn(() => Promise.resolve({ status })),
        read: vi.fn(),
      });
      const response = await app.inject({
        method: "POST",
        payload: commandBody,
        url: clarifyUrl,
      });
      expect(response.statusCode).toBe(expected);
      expect(response.json()).toEqual({ code: status });
    }
    const conflict = build({
      clarify: vi.fn(() =>
        Promise.reject(new JobLocationIdempotencyError("private intent")),
      ),
      read: vi.fn(),
    });
    expect(
      (
        await conflict.inject({
          method: "POST",
          payload: commandBody,
          url: clarifyUrl,
        })
      ).json(),
    ).toEqual({ code: "IDEMPOTENCY_CONFLICT" });
    const broken = build({
      clarify: vi.fn(() => Promise.reject(new Error("private address"))),
      read: vi.fn(),
    });
    const response = await broken.inject({
      method: "POST",
      payload: commandBody,
      url: clarifyUrl,
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ code: "TEMPORARILY_UNAVAILABLE" });
    expect(response.body).not.toContain("private address");
  });
});

function build(overrides: {
  clarify?: ReturnType<typeof vi.fn>;
  csrf?: (
    request: FastifyRequest,
    reply: FastifyReply,
    done: HookHandlerDoneFunction,
  ) => void;
  read: ReturnType<typeof vi.fn>;
  status?: "ACTIVE" | "ACCOUNT_NOT_ACTIVE" | "AUTHENTICATION_REQUIRED";
}): FastifyInstance {
  const app = Fastify();
  apps.push(app);
  registerJobContactRoutes(app, {
    clarifications: {
      clarify: (overrides.clarify ??
        vi.fn(() =>
          Promise.resolve({ status: "NOT_FOUND" as const }),
        )) as never,
    },
    contacts: { readForPrimaryParty: overrides.read },
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
