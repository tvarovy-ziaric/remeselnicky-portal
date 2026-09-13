import { redactTelemetryValue, sanitizeTelemetryString } from "./redaction.js";
import type {
  CentralErrorTracker,
  ErrorCaptureContext,
  ErrorTrackerTransport,
  ServiceTelemetryContext,
  StructuredLogger,
  TrackedError,
} from "./types.js";

export interface CentralErrorTrackerOptions {
  readonly clock?: () => Date;
  readonly context: ServiceTelemetryContext;
  readonly transport: ErrorTrackerTransport;
}

export function createCentralErrorTracker(
  options: CentralErrorTrackerOptions,
): CentralErrorTracker {
  const clock = options.clock ?? (() => new Date());

  function send(
    error: unknown,
    context: ErrorCaptureContext,
    signaledName?: string,
  ): void {
    try {
      const details = errorDetails(error, options.context.environment);
      const correlationId = safeIdentifier(context.correlationId);
      const eventId = safeIdentifier(context.eventId);
      const jobId = safeIdentifier(context.jobId);
      const requestId = safeIdentifier(context.requestId);
      const runId = safeIdentifier(context.runId);
      const report: TrackedError = Object.freeze({
        ...(details.code === undefined ? {} : { code: details.code }),
        ...(correlationId === undefined ? {} : { correlationId }),
        environment: options.context.environment,
        errorName: safeErrorName(signaledName ?? details.name),
        ...(eventId === undefined ? {} : { eventId }),
        handled: context.handled ?? false,
        ...(jobId === undefined ? {} : { jobId }),
        mechanism: context.mechanism,
        releaseRevision: options.context.releaseRevision,
        ...(requestId === undefined ? {} : { requestId }),
        ...(runId === undefined ? {} : { runId }),
        service: options.context.service,
        ...(context.sourceEnvironment === undefined
          ? {}
          : { sourceEnvironment: context.sourceEnvironment }),
        ...(context.sourceReleaseRevision === undefined
          ? {}
          : {
              sourceReleaseRevision: sanitizeTelemetryString(
                context.sourceReleaseRevision,
              ).slice(0, 128),
            }),
        ...(details.stack === undefined ? {} : { stack: details.stack }),
        timestamp: clock().toISOString(),
      });
      const result = options.transport.capture(report);
      if (result instanceof Promise) void result.catch(() => undefined);
    } catch {
      // Error reporting is best effort and cannot break the application.
    }
  }

  return Object.freeze({
    capture(error: unknown, context: ErrorCaptureContext): void {
      send(error, context);
    },
    captureSignal(errorName: string, context: ErrorCaptureContext): void {
      send(undefined, context, errorName);
    },
  });
}

export function createLoggerErrorTransport(
  logger: StructuredLogger,
): ErrorTrackerTransport {
  return Object.freeze({
    capture(report: TrackedError): void {
      logger.error("application_error", { error: report });
    },
  });
}

function errorDetails(
  error: unknown,
  environment: ServiceTelemetryContext["environment"],
): { readonly code?: string; readonly name: string; readonly stack?: string } {
  if (!(error instanceof Error)) return { name: "UnknownError" };
  const candidate = error as Error & { readonly code?: unknown };
  const safe = redactTelemetryValue({
    code: typeof candidate.code === "string" ? candidate.code : undefined,
    name: error.name,
    stack: error.stack,
  }) as {
    readonly code?: unknown;
    readonly name?: unknown;
    readonly stack?: unknown;
  };
  return {
    ...(typeof safe.code === "string"
      ? { code: sanitizeTelemetryString(safe.code).slice(0, 128) }
      : {}),
    name: typeof safe.name === "string" ? safe.name : "Error",
    ...(environment !== "production" && typeof safe.stack === "string"
      ? { stack: safeStackFrames(safe.stack) }
      : {}),
  };
}

function safeErrorName(value: string): string {
  const safe = sanitizeTelemetryString(value).slice(0, 128);
  return /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(safe) ? safe : "UnknownError";
}

function safeIdentifier(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const sanitized = sanitizeTelemetryString(value);
  return sanitized === value &&
    /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value)
    ? value
    : undefined;
}

function safeStackFrames(stack: string): string {
  return stack
    .split("\n")
    .filter((line) => /^\s*at\s/u.test(line))
    .slice(0, 40)
    .join("\n");
}
