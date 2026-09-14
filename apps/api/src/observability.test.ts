import {
  createCentralErrorTracker,
  createPortalMetrics,
  createStructuredLogger,
  type TrackedError,
} from "@portal/observability";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApi } from "./app.js";
import {
  createDatabaseFrontendErrorAdmission,
  FRONTEND_ERROR_PATH,
} from "./observability.js";

const openApps: ReturnType<typeof buildApi>[] = [];
const context = {
  environment: "production",
  releaseRevision: "git-a1b2c3d4",
} as const;

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
});

describe("API observability boundary", () => {
  it("records bounded HTTP and database health metrics without changing responses", async () => {
    const metrics = createPortalMetrics({ ...context, service: "api" });
    const app = buildApi({
      database: { ping: () => Promise.resolve() },
      observability: {
        appOrigin: "https://portal.example",
        context,
        metrics,
      },
    });
    openApps.push(app);

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(200);
    const output = metrics.render();
    expect(output).toContain('route="/health/ready"');
    expect(output).toContain("portal_database_available");
    expect(output).not.toMatch(/user_?id=/iu);
    expect(output).not.toMatch(/job_?id=/iu);
  });

  it("keeps HTTP and readiness outcomes unchanged when metrics fail", async () => {
    const fail = () => {
      throw new Error("collector unavailable");
    };
    const app = buildApi({
      database: { ping: () => Promise.resolve() },
      observability: {
        appOrigin: "https://portal.example",
        context,
        metrics: {
          contentType: "text/plain; version=0.0.4; charset=utf-8",
          recordDatabaseProbe: fail,
          recordHttp: fail,
          recordQueueEvent: fail,
          render: () => "",
          setQueueSnapshot: fail,
          setWorkerReady: fail,
        },
      },
    });
    openApps.push(app);

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ready" });
  });

  it("propagates a safe correlation ID and logs bounded request context", async () => {
    const output: string[] = [];
    const logger = createStructuredLogger({
      clock: () => new Date("2026-09-14T12:00:00.000Z"),
      context: { ...context, service: "api" },
      destination: { write: (line) => output.push(line) },
    });
    const app = buildApi({
      database: { ping: () => Promise.resolve() },
      observability: {
        appOrigin: "https://portal.example",
        context,
        createCorrelationId: () => "generated-correlation-id",
        logger,
      },
    });
    openApps.push(app);

    const response = await app.inject({
      headers: { "x-correlation-id": "upstream-correlation-id" },
      method: "GET",
      url: "/health/live?private=value",
    });

    expect(response.headers["x-correlation-id"]).toBe(
      "upstream-correlation-id",
    );
    const requestLog = output
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((record) => record.event === "http_request_completed");
    expect(requestLog).toMatchObject({
      correlationId: "upstream-correlation-id",
      environment: "production",
      method: "GET",
      releaseRevision: "git-a1b2c3d4",
      route: "/health/live",
      service: "api",
      statusCode: 200,
    });
    expect(JSON.stringify(requestLog)).not.toContain("private=value");
  });

  it("replaces malformed correlation IDs instead of reflecting them", async () => {
    const app = buildApi({
      database: { ping: () => Promise.resolve() },
      observability: {
        appOrigin: "https://portal.example",
        context,
        createCorrelationId: () => "generated-correlation-id",
      },
    });
    openApps.push(app);

    const response = await app.inject({
      headers: {
        "x-correlation-id": "person@example.com\r\nx-private: secret",
      },
      method: "GET",
      url: "/health/live",
    });

    expect(response.headers["x-correlation-id"]).toBe(
      "generated-correlation-id",
    );
  });

  it("tracks unexpected backend failures and returns no production details", async () => {
    const reports: TrackedError[] = [];
    const errorTracker = createCentralErrorTracker({
      context: { ...context, service: "api" },
      transport: {
        capture(report): void {
          reports.push(report);
        },
      },
    });
    const app = buildApi({
      database: { ping: () => Promise.resolve() },
      observability: {
        appOrigin: "https://portal.example",
        context,
        createCorrelationId: () => "generated-correlation-id",
        errorTracker,
      },
    });
    app.get("/test/unhandled", () => {
      throw new Error(
        "postgresql://person:secret@db.example/portal private details",
      );
    });
    openApps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/test/unhandled",
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ code: "INTERNAL_ERROR" });
    expect(response.body).not.toContain("secret");
    expect(response.body).not.toContain("stack");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      correlationId: "generated-correlation-id",
      environment: "production",
      errorName: "Error",
      mechanism: "http_request",
      releaseRevision: "git-a1b2c3d4",
      service: "api",
    });
    expect(reports[0]).not.toHaveProperty("stack");
  });

  it("accepts only the privacy-safe frontend error envelope", async () => {
    const captureSignal = vi.fn();
    const app = buildApi({
      database: { ping: () => Promise.resolve() },
      observability: {
        appOrigin: "https://portal.example",
        context,
        errorTracker: { capture: vi.fn(), captureSignal },
        frontendErrorAdmission: {
          admit: () => Promise.resolve("ADMITTED"),
        },
      },
    });
    openApps.push(app);
    const safeBody = {
      correlationId: "browser-correlation-123",
      environment: "staging",
      errorName: "TypeError",
      mechanism: "frontend_render",
      releaseRevision: "web-a1b2c3d4",
    } as const;

    const accepted = await app.inject({
      headers: { origin: "https://portal.example" },
      method: "POST",
      payload: safeBody,
      url: FRONTEND_ERROR_PATH,
    });
    const rejected = await app.inject({
      headers: { origin: "https://portal.example" },
      method: "POST",
      payload: { ...safeBody, message: "Person@example.com private input" },
      url: FRONTEND_ERROR_PATH,
    });

    expect(accepted.statusCode).toBe(202);
    expect(accepted.headers["cache-control"]).toBe("no-store");
    expect(captureSignal).toHaveBeenCalledWith("TypeError", {
      correlationId: "browser-correlation-123",
      mechanism: "frontend_render",
      sourceEnvironment: "staging",
      sourceReleaseRevision: "web-a1b2c3d4",
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.body).not.toContain("Person@example.com");
    expect(captureSignal).toHaveBeenCalledTimes(1);
  });

  it("fails frontend telemetry closed for missing and cross-site origins", async () => {
    const captureSignal = vi.fn();
    const admit = vi.fn(() => Promise.resolve("ADMITTED" as const));
    const app = buildApi({
      database: { ping: () => Promise.resolve() },
      observability: {
        appOrigin: "https://portal.example",
        context,
        errorTracker: { capture: vi.fn(), captureSignal },
        frontendErrorAdmission: { admit },
      },
    });
    openApps.push(app);
    const payload = frontendErrorPayload();

    const missing = await app.inject({
      method: "POST",
      payload,
      url: FRONTEND_ERROR_PATH,
    });
    const crossSite = await app.inject({
      headers: { origin: "https://attacker.example" },
      method: "POST",
      payload,
      url: FRONTEND_ERROR_PATH,
    });

    expect(missing.statusCode).toBe(403);
    expect(crossSite.statusCode).toBe(403);
    expect(admit).not.toHaveBeenCalled();
    expect(captureSignal).not.toHaveBeenCalled();
  });

  it("uses a route-and-IP digest in a shared authoritative rate bucket", async () => {
    let current = 0;
    const observed: { keyDigest: string; scope: string }[] = [];
    const persistence = {
      consumeRateLimit(input: { keyDigest: string; scope: string }) {
        observed.push(input);
        current += 1;
        return Promise.resolve({ current });
      },
    };
    const admission = createDatabaseFrontendErrorAdmission({
      clock: () => new Date("2026-09-14T12:00:00.000Z"),
      limit: 1,
      persistence,
      timeWindowMs: 60_000,
    });
    const captureSignal = vi.fn();
    const createApp = () => {
      const app = buildApi({
        database: { ping: () => Promise.resolve() },
        observability: {
          appOrigin: "https://portal.example",
          context,
          errorTracker: { capture: vi.fn(), captureSignal },
          frontendErrorAdmission: admission,
        },
      });
      openApps.push(app);
      return app;
    };
    const firstApp = createApp();
    const secondApp = createApp();
    const request = {
      headers: { origin: "https://portal.example" },
      method: "POST" as const,
      payload: frontendErrorPayload(),
      url: FRONTEND_ERROR_PATH,
    };

    const first = await firstApp.inject(request);
    const second = await secondApp.inject(request);

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(429);
    expect(captureSignal).toHaveBeenCalledTimes(1);
    expect(observed).toHaveLength(2);
    expect(observed[0]?.scope).toBe("observability:frontend-error");
    expect(observed[0]?.keyDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(observed[0]?.keyDigest).not.toContain("127.0.0.1");
    expect(observed[1]?.keyDigest).toBe(observed[0]?.keyDigest);
  });

  it("fails frontend telemetry closed when no admission provider exists", async () => {
    const app = buildApi({
      database: { ping: () => Promise.resolve() },
      observability: {
        appOrigin: "https://portal.example",
        context,
      },
    });
    openApps.push(app);

    const response = await app.inject({
      headers: { origin: "https://portal.example" },
      method: "POST",
      payload: frontendErrorPayload(),
      url: FRONTEND_ERROR_PATH,
    });

    expect(response.statusCode).toBe(503);
  });
});

function frontendErrorPayload() {
  return {
    correlationId: "browser-correlation-123",
    environment: "staging",
    errorName: "TypeError",
    mechanism: "frontend_render",
    releaseRevision: "web-a1b2c3d4",
  } as const;
}
