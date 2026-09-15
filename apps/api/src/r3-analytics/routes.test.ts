import fastifyRateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import type { onRequestHookHandler } from "fastify";
import { describe, expect, it, vi } from "vitest";

import {
  R3_ANALYTICS_OBSERVATION_PATH,
  registerR3AnalyticsRoutes,
} from "./routes.js";

const actorId = "91000000-0000-4000-8000-000000000002";
const requestId = "91000000-0000-4000-8000-000000000003";
const rateLimit = { max: 100, timeWindowMs: 60_000 } as const;

describe("R3 analytics observation route", () => {
  it("accepts only server-authorized minimal observation input behind CSRF", async () => {
    const app = Fastify();
    const record = vi.fn().mockResolvedValue("RECORDED");
    const csrfSpy = vi.fn();
    const csrf: onRequestHookHandler = (_request, _reply, done) => {
      csrfSpy();
      done();
    };
    registerR3AnalyticsRoutes(app, {
      csrfProtection: csrf,
      guard: {
        evaluate: vi.fn().mockResolvedValue({
          status: "ACTIVE",
          user: { id: actorId },
        }),
      },
      observations: { record },
      rateLimit,
    });
    const response = await app.inject({
      method: "POST",
      payload: {
        commandId: "91000000-0000-4000-8000-000000000001",
        jobRequestId: requestId,
        kind: "QUOTE_COMPARISON_OPENED",
      },
      url: R3_ANALYTICS_OBSERVATION_PATH,
    });
    expect(response.statusCode).toBe(204);
    expect(csrfSpy).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith({
      actorUserId: actorId,
      commandId: "91000000-0000-4000-8000-000000000001",
      jobRequestId: requestId,
      kind: "QUOTE_COMPARISON_OPENED",
    });
  });

  it("accepts the exact provider invitation-view target without client metadata", async () => {
    const app = Fastify();
    const record = vi.fn().mockResolvedValue("RECORDED");
    registerR3AnalyticsRoutes(app, {
      csrfProtection: (_request, _reply, done) => done(),
      guard: {
        evaluate: vi.fn().mockResolvedValue({
          status: "ACTIVE",
          user: { id: actorId },
        }),
      },
      observations: { record },
      rateLimit,
    });
    const invitationId = "91000000-0000-4000-8000-000000000005";
    expect(
      (
        await app.inject({
          method: "POST",
          payload: {
            commandId: "91000000-0000-4000-8000-000000000001",
            invitationId,
            jobRequestId: requestId,
            kind: "INVITATION_VIEWED",
          },
          url: R3_ANALYTICS_OBSERVATION_PATH,
        })
      ).statusCode,
    ).toBe(204);
    expect(record).toHaveBeenCalledWith({
      actorUserId: actorId,
      commandId: "91000000-0000-4000-8000-000000000001",
      invitationId,
      jobRequestId: requestId,
      kind: "INVITATION_VIEWED",
    });
  });

  it.each(["UNCHANGED", "NOT_AVAILABLE"])(
    "keeps %s a privacy-safe no-op",
    async (status) => {
      const app = Fastify();
      registerR3AnalyticsRoutes(app, {
        csrfProtection: (_request, _reply, done) => done(),
        guard: {
          evaluate: vi.fn().mockResolvedValue({
            status: "ACTIVE",
            user: { id: actorId },
          }),
        },
        observations: { record: vi.fn().mockResolvedValue(status) },
        rateLimit,
      });
      const response = await app.inject({
        method: "POST",
        payload: {
          commandId: "91000000-0000-4000-8000-000000000001",
          jobRequestId: requestId,
          kind: "QUOTE_COMPARISON_OPENED",
        },
        url: R3_ANALYTICS_OBSERVATION_PATH,
      });
      expect(response.statusCode).toBe(204);
      expect(response.body).toBe("");
    },
  );

  it("rejects client-controlled classification, time and schema metadata", async () => {
    const app = Fastify();
    registerR3AnalyticsRoutes(app, {
      csrfProtection: (_request, _reply, done) => done(),
      guard: {
        evaluate: vi.fn().mockResolvedValue({
          status: "ACTIVE",
          user: { id: actorId },
        }),
      },
      observations: { record: vi.fn() },
      rateLimit,
    });
    const response = await app.inject({
      method: "POST",
      payload: {
        commandId: "91000000-0000-4000-8000-000000000001",
        occurredAt: "2026-09-15T10:00:00.000Z",
        isTest: false,
        jobRequestId: requestId,
        kind: "QUOTE_COMPARISON_OPENED",
        schemaVersion: 99,
      },
      url: R3_ANALYTICS_OBSERVATION_PATH,
    });
    expect(response.statusCode).toBe(400);
  });

  it("applies the configured route admission limit before repeated DB work", async () => {
    const app = Fastify();
    await app.register(fastifyRateLimit, { global: false });
    const record = vi.fn().mockResolvedValue("RECORDED");
    registerR3AnalyticsRoutes(app, {
      csrfProtection: (_request, _reply, done) => done(),
      guard: {
        evaluate: vi.fn().mockResolvedValue({
          status: "ACTIVE",
          user: { id: actorId },
        }),
      },
      observations: { record },
      rateLimit: { max: 1, timeWindowMs: 60_000 },
    });
    const request = {
      method: "POST" as const,
      payload: {
        commandId: "91000000-0000-4000-8000-000000000001",
        jobRequestId: requestId,
        kind: "QUOTE_COMPARISON_OPENED",
      },
      url: R3_ANALYTICS_OBSERVATION_PATH,
    };

    expect((await app.inject(request)).statusCode).toBe(204);
    expect(
      (
        await app.inject({
          ...request,
          payload: {
            ...request.payload,
            commandId: "91000000-0000-4000-8000-000000000004",
          },
        })
      ).statusCode,
    ).toBe(429);
    expect(record).toHaveBeenCalledOnce();
  });
});
