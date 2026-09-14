import { createHash, randomUUID } from "node:crypto";

import {
  createCentralErrorTracker,
  createLoggerErrorTransport,
  createStructuredLogger,
  createPortalMetrics,
  sanitizeTelemetryString,
  type CentralErrorTracker,
  type ObservabilityEnvironment,
  type PortalMetrics,
  type StructuredLogger,
} from "@portal/observability";
import type { FastifyInstance, FastifyRequest } from "fastify";

export const FRONTEND_ERROR_PATH = "/v1/observability/frontend-errors";

interface ApiObservabilityContext {
  readonly environment: ObservabilityEnvironment;
  readonly releaseRevision: string;
}

export interface ApiObservabilityDependencies {
  readonly appOrigin: string;
  readonly clock?: () => Date;
  readonly context: ApiObservabilityContext;
  readonly createCorrelationId?: () => string;
  readonly errorTracker?: CentralErrorTracker;
  readonly frontendErrorAdmission?: FrontendErrorAdmission;
  readonly logger?: StructuredLogger;
  readonly metrics?: PortalMetrics;
}

export interface FrontendErrorAdmission {
  admit(input: { readonly ip: string }): Promise<"ADMITTED" | "RATE_LIMITED">;
}

export interface FrontendErrorRateLimitPersistence {
  consumeRateLimit(input: {
    readonly keyDigest: string;
    readonly limit: number;
    readonly now: Date;
    readonly scope: string;
    readonly timeWindowMs: number;
  }): Promise<{ readonly current: number }>;
}

export function createDatabaseFrontendErrorAdmission(input: {
  readonly clock?: () => Date;
  readonly limit: number;
  readonly persistence: FrontendErrorRateLimitPersistence;
  readonly timeWindowMs: number;
}): FrontendErrorAdmission {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
    throw new RangeError("frontend error rate limit must be positive");
  }
  if (!Number.isSafeInteger(input.timeWindowMs) || input.timeWindowMs < 1) {
    throw new RangeError("frontend error rate window must be positive");
  }
  const clock = input.clock ?? (() => new Date());
  return Object.freeze({
    async admit(request: {
      readonly ip: string;
    }): Promise<"ADMITTED" | "RATE_LIMITED"> {
      const keyDigest = createHash("sha256")
        .update(`${FRONTEND_ERROR_PATH}\u0000${request.ip}`, "utf8")
        .digest("hex");
      const result = await input.persistence.consumeRateLimit({
        keyDigest,
        limit: input.limit,
        now: clock(),
        scope: "observability:frontend-error",
        timeWindowMs: input.timeWindowMs,
      });
      return result.current > input.limit ? "RATE_LIMITED" : "ADMITTED";
    },
  });
}

interface RequestTelemetryState {
  readonly correlationId: string;
  readonly startedAt: number;
}

interface FrontendErrorBody {
  readonly correlationId: string;
  readonly environment: ObservabilityEnvironment;
  readonly errorName: string;
  readonly mechanism:
    "frontend_error" | "frontend_rejection" | "frontend_render";
  readonly releaseRevision: string;
}

export function registerApiObservability(
  app: FastifyInstance,
  dependencies?: ApiObservabilityDependencies,
): PortalMetrics {
  const context = dependencies?.context ?? {
    environment: "development",
    releaseRevision: "test",
  };
  const clock = dependencies?.clock ?? (() => new Date());
  const logger =
    dependencies?.logger ??
    createStructuredLogger({
      clock,
      context: { ...context, service: "api" },
      destination: { write: () => undefined },
    });
  const errorTracker =
    dependencies?.errorTracker ??
    createCentralErrorTracker({
      clock,
      context: { ...context, service: "api" },
      transport: createLoggerErrorTransport(logger),
    });
  const createCorrelationId = dependencies?.createCorrelationId ?? randomUUID;
  const metrics =
    dependencies?.metrics ??
    createPortalMetrics({ ...context, service: "api" });
  const requests = new WeakMap<FastifyRequest, RequestTelemetryState>();

  app.addHook("onRequest", (request, reply, done) => {
    const correlationId =
      incomingCorrelationId(request) ?? createCorrelationId();
    requests.set(request, {
      correlationId,
      startedAt: performance.now(),
    });
    void reply.header("x-correlation-id", correlationId);
    done();
  });

  app.addHook("onError", (request, reply, error, done) => {
    if (reply.statusCode >= 500 || statusCode(error) >= 500) {
      const state = requests.get(request);
      errorTracker.capture(error, {
        ...(state === undefined ? {} : { correlationId: state.correlationId }),
        mechanism: "http_request",
        requestId: request.id,
      });
    }
    done();
  });

  app.addHook("onResponse", (request, reply, done) => {
    const state = requests.get(request);
    const durationMs =
      state === undefined
        ? 0
        : Math.max(
            0,
            Math.round((performance.now() - state.startedAt) * 100) / 100,
          );
    logger.info("http_request_completed", {
      ...(state === undefined ? {} : { correlationId: state.correlationId }),
      durationMs,
      method: request.method,
      requestId: request.id,
      route: request.routeOptions.url ?? "unmatched",
      statusCode: reply.statusCode,
    });
    try {
      metrics.recordHttp({
        durationMs,
        method: request.method,
        route: request.routeOptions.url,
        statusCode: reply.statusCode,
      });
    } catch {
      // Metrics are best effort and cannot change an HTTP outcome.
    }
    requests.delete(request);
    done();
  });

  app.post<{ Body: FrontendErrorBody }>(
    FRONTEND_ERROR_PATH,
    {
      bodyLimit: 2_048,
      preValidation: async (request, reply) => {
        if (hasUnexpectedFrontendField(request.body)) {
          await reply.code(400).send({ code: "INVALID_REQUEST" });
        }
      },
      schema: { body: frontendErrorSchema },
    },
    async (request, reply) => {
      if (
        dependencies === undefined ||
        request.headers.origin !== dependencies.appOrigin
      ) {
        return reply.code(403).send({ code: "ORIGIN_NOT_ALLOWED" });
      }
      if (dependencies.frontendErrorAdmission === undefined) {
        return reply.code(503).send({ code: "TELEMETRY_UNAVAILABLE" });
      }
      const admission = await dependencies.frontendErrorAdmission.admit({
        ip: request.ip,
      });
      if (admission === "RATE_LIMITED") {
        return reply.code(429).send({ code: "RATE_LIMITED" });
      }
      errorTracker.captureSignal(request.body.errorName, {
        correlationId: request.body.correlationId,
        mechanism: request.body.mechanism,
        sourceEnvironment: request.body.environment,
        sourceReleaseRevision: request.body.releaseRevision,
      });
      return reply.header("cache-control", "no-store").code(202).send();
    },
  );

  app.setErrorHandler((error, _request, reply) => {
    const requestedStatus = statusCode(error);
    if (requestedStatus >= 400 && requestedStatus < 500) {
      void reply.code(requestedStatus).send({ code: "INVALID_REQUEST" });
      return;
    }
    void reply.code(500).send({ code: "INTERNAL_ERROR" });
  });

  return metrics;
}

const frontendErrorFields = new Set([
  "correlationId",
  "environment",
  "errorName",
  "mechanism",
  "releaseRevision",
]);

function hasUnexpectedFrontendField(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    Object.keys(body).some((key) => !frontendErrorFields.has(key))
  );
}

function incomingCorrelationId(request: FastifyRequest): string | undefined {
  const value = request.headers["x-correlation-id"];
  return typeof value === "string" &&
    sanitizeTelemetryString(value) === value &&
    /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/u.test(value)
    ? value
    : undefined;
}

function statusCode(error: unknown): number {
  if (typeof error !== "object" || error === null) return 500;
  const value = (error as { readonly statusCode?: unknown }).statusCode;
  return typeof value === "number" && Number.isInteger(value) ? value : 500;
}

const boundedIdentifier = {
  maxLength: 128,
  minLength: 8,
  pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$",
  type: "string",
} as const;
const frontendErrorSchema = {
  additionalProperties: false,
  properties: {
    correlationId: boundedIdentifier,
    environment: {
      enum: ["development", "staging", "production"],
      type: "string",
    },
    errorName: {
      maxLength: 80,
      pattern: "^[A-Za-z][A-Za-z0-9_.-]{0,79}$",
      type: "string",
    },
    mechanism: {
      enum: ["frontend_error", "frontend_rejection", "frontend_render"],
      type: "string",
    },
    releaseRevision: {
      maxLength: 128,
      minLength: 1,
      pattern: "^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$",
      type: "string",
    },
  },
  required: [
    "correlationId",
    "environment",
    "errorName",
    "mechanism",
    "releaseRevision",
  ],
  type: "object",
} as const;
