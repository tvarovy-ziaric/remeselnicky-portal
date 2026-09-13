import { redactTelemetryValue } from "./redaction.js";
import type {
  LogDestination,
  LogFields,
  LogLevel,
  ServiceTelemetryContext,
  StructuredLogger,
} from "./types.js";

export interface StructuredLoggerOptions {
  readonly clock?: () => Date;
  readonly context: ServiceTelemetryContext;
  readonly destination: LogDestination;
}

export function createStructuredLogger(
  options: StructuredLoggerOptions,
): StructuredLogger {
  const clock = options.clock ?? (() => new Date());

  function write(level: LogLevel, event: string, fields?: LogFields): void {
    try {
      const safeEvent = normalizeEvent(event);
      const safeFields =
        fields === undefined ? {} : (redactTelemetryValue(fields) as object);
      const record = {
        ...safeFields,
        environment: options.context.environment,
        event: safeEvent,
        level,
        releaseRevision: options.context.releaseRevision,
        service: options.context.service,
        timestamp: clock().toISOString(),
      };
      options.destination.write(`${JSON.stringify(record)}\n`);
    } catch {
      // Telemetry must never change a business outcome.
    }
  }

  return Object.freeze({
    debug: (event: string, fields?: LogFields) => write("debug", event, fields),
    error: (event: string, fields?: LogFields) => write("error", event, fields),
    info: (event: string, fields?: LogFields) => write("info", event, fields),
    warn: (event: string, fields?: LogFields) => write("warn", event, fields),
  });
}

export function createStreamDestination(stream: {
  write(chunk: string): unknown;
}): LogDestination {
  return Object.freeze({
    write(serializedRecord: string): void {
      stream.write(serializedRecord);
    },
  });
}

function normalizeEvent(event: string): string {
  const normalized = event.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.-]{0,127}$/u.test(normalized)) {
    return "invalid_telemetry_event";
  }
  return normalized;
}
