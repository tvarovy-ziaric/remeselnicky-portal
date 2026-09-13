export type ObservabilityEnvironment = "development" | "staging" | "production";

export type LogLevel = "debug" | "error" | "info" | "warn";

export interface ServiceTelemetryContext {
  readonly environment: ObservabilityEnvironment;
  readonly releaseRevision: string;
  readonly service: string;
}

export interface LogFields {
  readonly [key: string]: unknown;
}

export interface LogWrite {
  readonly event: string;
  readonly fields?: LogFields;
  readonly level: LogLevel;
}

export interface StructuredLogger {
  debug(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
}

export interface LogDestination {
  write(serializedRecord: string): void;
}

export type ErrorMechanism =
  | "frontend_error"
  | "frontend_rejection"
  | "frontend_render"
  | "http_request"
  | "startup"
  | "worker";

export interface ErrorCaptureContext {
  readonly correlationId?: string;
  readonly eventId?: string;
  readonly handled?: boolean;
  readonly jobId?: string;
  readonly mechanism: ErrorMechanism;
  readonly requestId?: string;
  readonly runId?: string;
  readonly sourceEnvironment?: ObservabilityEnvironment;
  readonly sourceReleaseRevision?: string;
}

export interface TrackedError {
  readonly code?: string;
  readonly correlationId?: string;
  readonly environment: ObservabilityEnvironment;
  readonly errorName: string;
  readonly eventId?: string;
  readonly handled: boolean;
  readonly jobId?: string;
  readonly mechanism: ErrorMechanism;
  readonly releaseRevision: string;
  readonly requestId?: string;
  readonly runId?: string;
  readonly service: string;
  readonly sourceEnvironment?: ObservabilityEnvironment;
  readonly sourceReleaseRevision?: string;
  readonly stack?: string;
  readonly timestamp: string;
}

export interface ErrorTrackerTransport {
  capture(report: TrackedError): Promise<void> | void;
}

export interface CentralErrorTracker {
  capture(error: unknown, context: ErrorCaptureContext): void;
  captureSignal(errorName: string, context: ErrorCaptureContext): void;
}
