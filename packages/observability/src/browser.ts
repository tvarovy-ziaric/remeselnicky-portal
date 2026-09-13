export type BrowserErrorMechanism =
  "frontend_error" | "frontend_rejection" | "frontend_render";

export interface BrowserErrorSignal {
  readonly correlationId: string;
  readonly environment: "development" | "production" | "staging";
  readonly errorName: string;
  readonly mechanism: BrowserErrorMechanism;
  readonly releaseRevision: string;
}

export interface BrowserErrorTransport {
  capture(signal: BrowserErrorSignal): Promise<void> | void;
}

export interface BrowserErrorTracker {
  capture(error: unknown, mechanism: BrowserErrorMechanism): void;
}

export interface BrowserErrorTrackerOptions {
  readonly createCorrelationId?: () => string;
  readonly environment: BrowserErrorSignal["environment"];
  readonly releaseRevision: string;
  readonly transport: BrowserErrorTransport;
}

export function createBrowserErrorTracker(
  options: BrowserErrorTrackerOptions,
): BrowserErrorTracker {
  const createCorrelationId =
    options.createCorrelationId ?? (() => globalThis.crypto.randomUUID());

  return Object.freeze({
    capture(error: unknown, mechanism: BrowserErrorMechanism): void {
      try {
        const signal = Object.freeze({
          correlationId: boundedIdentifier(createCorrelationId()),
          environment: options.environment,
          errorName: browserErrorName(error),
          mechanism,
          releaseRevision: boundedRelease(options.releaseRevision),
        });
        const result = options.transport.capture(signal);
        if (result instanceof Promise) void result.catch(() => undefined);
      } catch {
        // Browser telemetry is best effort and cannot break the page.
      }
    },
  });
}

export function createFetchErrorTransport(options: {
  readonly endpoint: string;
  readonly fetch?: typeof fetch;
}): BrowserErrorTransport {
  const send = options.fetch ?? globalThis.fetch;
  return Object.freeze({
    capture(signal: BrowserErrorSignal): void {
      void send(options.endpoint, {
        body: JSON.stringify(signal),
        credentials: "omit",
        headers: { "content-type": "application/json" },
        keepalive: true,
        method: "POST",
      }).catch(() => undefined);
    },
  });
}

export function installGlobalErrorTracking(options: {
  readonly target: Pick<Window, "addEventListener" | "removeEventListener">;
  readonly tracker: BrowserErrorTracker;
}): () => void {
  const onError = (event: ErrorEvent): void => {
    options.tracker.capture(event.error, "frontend_error");
  };
  const onRejection = (event: PromiseRejectionEvent): void => {
    options.tracker.capture(event.reason, "frontend_rejection");
  };

  options.target.addEventListener("error", onError as EventListener);
  options.target.addEventListener(
    "unhandledrejection",
    onRejection as EventListener,
  );

  return () => {
    options.target.removeEventListener("error", onError as EventListener);
    options.target.removeEventListener(
      "unhandledrejection",
      onRejection as EventListener,
    );
  };
}

function browserErrorName(error: unknown): string {
  if (!(error instanceof Error)) return "UnknownError";
  const name = error.name.slice(0, 80);
  return /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/u.test(name) ? name : "Error";
}

function boundedIdentifier(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/u.test(value)
    ? value
    : "invalid-correlation-id";
}

function boundedRelease(value: string): string {
  const trimmed = value.trim().slice(0, 128);
  return /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/u.test(trimmed)
    ? trimmed
    : "unknown";
}
