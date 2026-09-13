import { describe, expect, it, vi } from "vitest";

import {
  createCentralErrorTracker,
  createLoggerErrorTransport,
  createStructuredLogger,
  redactTelemetryValue,
  type TrackedError,
} from "../src/index.js";

const context = {
  environment: "production",
  releaseRevision: "git-a1b2c3d4",
  service: "api",
} as const;
const now = new Date("2026-09-14T12:00:00.000Z");

describe("structured server telemetry", () => {
  it("writes machine-readable records with mandatory deployment context", () => {
    const output: string[] = [];
    const logger = createStructuredLogger({
      clock: () => now,
      context,
      destination: { write: (line) => output.push(line) },
    });

    logger.info("http_request_completed", {
      correlationId: "correlation-123",
      durationMs: 12,
      requestId: "request-456",
      statusCode: 200,
    });

    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0] ?? "")).toEqual({
      correlationId: "correlation-123",
      durationMs: 12,
      environment: "production",
      event: "http_request_completed",
      level: "info",
      releaseRevision: "git-a1b2c3d4",
      requestId: "request-456",
      service: "api",
      statusCode: 200,
      timestamp: now.toISOString(),
    });
  });

  it("recursively redacts credential, PII, content and database URL fields", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const value = redactTelemetryValue({
      authorization: "Bearer raw-token",
      databaseUrl: "postgresql://user:password@db.example/portal",
      nested: {
        chat: "private conversation",
        contact: "Person@example.com or +421 900 123 456",
        headers: { cookie: "portal.sid=secret" },
        password: "correct horse battery staple",
        reset_token: "one-time-secret",
      },
      safe: "opaque-domain-id",
      signedUrl: "https://storage.example/private/file?X-Amz-Signature=secret",
      cyclic,
    });

    expect(value).toEqual({
      authorization: "[REDACTED]",
      databaseUrl: "[REDACTED]",
      nested: {
        chat: "[REDACTED]",
        contact: "[REDACTED] or [REDACTED]",
        headers: { cookie: "[REDACTED]" },
        password: "[REDACTED]",
        reset_token: "[REDACTED]",
      },
      safe: "opaque-domain-id",
      signedUrl: "[REDACTED]",
      cyclic: { self: "[CIRCULAR]" },
    });
  });

  it("does not let a logging destination failure affect callers", () => {
    const logger = createStructuredLogger({
      context,
      destination: {
        write(): void {
          throw new Error("collector unavailable");
        },
      },
    });

    expect(() => logger.error("business_command_failed")).not.toThrow();

    const hostileFields = Object.defineProperty({}, "secret", {
      enumerable: true,
      get(): never {
        throw new Error("hostile getter");
      },
    });
    expect(() => logger.info("hostile_fields", hostileFields)).not.toThrow();
  });

  it("sends production errors centrally without stack or message leakage", () => {
    const reports: TrackedError[] = [];
    const tracker = createCentralErrorTracker({
      clock: () => now,
      context,
      transport: {
        capture(report): void {
          reports.push(report);
        },
      },
    });
    const error = Object.assign(
      new Error(
        "postgresql://person:secret@db.example/portal Person@example.com",
      ),
      { code: "DB_UNAVAILABLE" },
    );

    tracker.capture(error, {
      correlationId: "correlation-123",
      mechanism: "http_request",
      requestId: "request-456",
    });

    expect(reports).toEqual([
      {
        code: "DB_UNAVAILABLE",
        correlationId: "correlation-123",
        environment: "production",
        errorName: "Error",
        handled: false,
        mechanism: "http_request",
        releaseRevision: "git-a1b2c3d4",
        requestId: "request-456",
        service: "api",
        timestamp: now.toISOString(),
      },
    ]);
    expect(JSON.stringify(reports)).not.toContain("Person@example.com");
    expect(JSON.stringify(reports)).not.toContain("secret");
    expect(reports[0]).not.toHaveProperty("stack");
  });

  it("keeps development stack context but sanitizes embedded secrets", () => {
    const reports: TrackedError[] = [];
    const tracker = createCentralErrorTracker({
      context: { ...context, environment: "development" },
      transport: {
        capture(report): void {
          reports.push(report);
        },
      },
    });
    const error = new Error("Bearer raw-token");
    error.stack = "Error: Bearer raw-token\n at Person@example.com";

    tracker.capture(error, { mechanism: "worker" });

    expect(reports[0]?.stack).toBe(" at [REDACTED]");
    expect(reports[0]?.stack).not.toContain("raw-token");

    tracker.capture(new Error("private JobRequest description"), {
      correlationId: "0900123456",
      mechanism: "worker",
    });
    expect(reports[1]).not.toHaveProperty("correlationId");
    expect(reports[1]?.stack).not.toContain("private JobRequest description");
  });

  it("routes an error tracker through the same structured logger", () => {
    const output: string[] = [];
    const logger = createStructuredLogger({
      clock: () => now,
      context,
      destination: { write: (line) => output.push(line) },
    });
    const tracker = createCentralErrorTracker({
      clock: () => now,
      context,
      transport: createLoggerErrorTransport(logger),
    });

    tracker.captureSignal("FrontendRenderError", {
      correlationId: "browser-correlation",
      mechanism: "frontend_render",
    });

    expect(JSON.parse(output[0] ?? "")).toMatchObject({
      environment: "production",
      error: {
        correlationId: "browser-correlation",
        errorName: "FrontendRenderError",
        mechanism: "frontend_render",
        releaseRevision: "git-a1b2c3d4",
        service: "api",
      },
      event: "application_error",
      releaseRevision: "git-a1b2c3d4",
      service: "api",
    });
  });

  it("swallows synchronous and asynchronous tracker transport failures", async () => {
    const tracker = createCentralErrorTracker({
      context,
      transport: {
        capture: vi
          .fn()
          .mockRejectedValueOnce(new Error("collector unavailable"))
          .mockImplementationOnce(() => {
            throw new Error("collector unavailable");
          }),
      },
    });

    expect(() =>
      tracker.capture(new Error("failure"), { mechanism: "worker" }),
    ).not.toThrow();
    await Promise.resolve();
    expect(() =>
      tracker.capture(new Error("failure"), { mechanism: "worker" }),
    ).not.toThrow();
  });
});
