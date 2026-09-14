import type { EventPayload, PersistedDomainEvent } from "./event.js";

export interface OutboxDelivery {
  readonly attempt: number;
  readonly commandName: string;
  readonly correlationId: string;
  readonly event: PersistedDomainEvent<string, EventPayload>;
  readonly leaseToken: string;
}

export interface ClaimOutboxOptions {
  readonly leaseDurationMs: number;
  readonly now: Date;
}

export interface RetryOutboxOptions {
  readonly availableAt: Date;
  readonly errorCode: string;
}

export interface OutboxDeliveryStore {
  claimNext(options: ClaimOutboxOptions): Promise<OutboxDelivery | undefined>;
  markPublished(delivery: OutboxDelivery, publishedAt: Date): Promise<boolean>;
  moveToTerminal(
    delivery: OutboxDelivery,
    errorCode: string,
    failedAt: Date,
  ): Promise<boolean>;
  retry(
    delivery: OutboxDelivery,
    options: RetryOutboxOptions,
  ): Promise<boolean>;
}

export interface OutboxPublisher {
  /** Must use eventId/idempotencyKey when the downstream transport supports it. */
  publish(delivery: OutboxDelivery): Promise<void>;
}

export interface OutboxWorkerTelemetryEvent {
  readonly attempt: number;
  readonly eventId: string;
  readonly eventName: string;
  readonly occurredAt: Date;
  readonly outcome: "PUBLISHED" | "RETRY_SCHEDULED" | "TERMINAL_FAILURE";
  readonly errorCode?: string;
}

export interface OutboxWorkerTelemetry {
  /** Payload is deliberately absent from operational telemetry. */
  record(event: OutboxWorkerTelemetryEvent): void;
}

export interface OutboxWorker {
  processNext(): Promise<
    | { readonly status: "IDLE" }
    | {
        readonly eventId: string;
        readonly status:
          "PUBLISHED" | "RETRY_SCHEDULED" | "TERMINAL_FAILURE" | "LEASE_LOST";
      }
  >;
}

export function createOutboxWorker(options: {
  readonly backoffMs: (attempt: number) => number;
  readonly leaseDurationMs: number;
  readonly maxAttempts: number;
  readonly now?: () => Date;
  readonly publisher: OutboxPublisher;
  readonly store: OutboxDeliveryStore;
  readonly telemetry?: OutboxWorkerTelemetry;
}): OutboxWorker {
  assertPositiveInteger(options.leaseDurationMs, "leaseDurationMs");
  assertPositiveInteger(options.maxAttempts, "maxAttempts");
  const now = options.now ?? (() => new Date());

  return Object.freeze({
    async processNext() {
      const delivery = await options.store.claimNext({
        leaseDurationMs: options.leaseDurationMs,
        now: validDate(now()),
      });
      if (delivery === undefined) return { status: "IDLE" as const };

      try {
        await options.publisher.publish(delivery);
        const publishedAt = validDate(now());
        const recorded = await options.store.markPublished(
          delivery,
          publishedAt,
        );
        if (!recorded) {
          return {
            eventId: delivery.event.eventId,
            status: "LEASE_LOST" as const,
          };
        }
        emit(options.telemetry, delivery, "PUBLISHED", publishedAt);
        return {
          eventId: delivery.event.eventId,
          status: "PUBLISHED" as const,
        };
      } catch (error: unknown) {
        const failure = classifyFailure(error);
        const failedAt = validDate(now());
        if (!failure.retryable || delivery.attempt >= options.maxAttempts) {
          const recorded = await options.store.moveToTerminal(
            delivery,
            failure.code,
            failedAt,
          );
          if (!recorded) {
            return {
              eventId: delivery.event.eventId,
              status: "LEASE_LOST" as const,
            };
          }
          emit(
            options.telemetry,
            delivery,
            "TERMINAL_FAILURE",
            failedAt,
            failure.code,
          );
          return {
            eventId: delivery.event.eventId,
            status: "TERMINAL_FAILURE" as const,
          };
        }

        const delay = options.backoffMs(delivery.attempt);
        if (!Number.isSafeInteger(delay) || delay < 0) {
          throw new RangeError("backoffMs must return a non-negative integer", {
            cause: error,
          });
        }
        const availableAt = new Date(failedAt.getTime() + delay);
        const recorded = await options.store.retry(delivery, {
          availableAt,
          errorCode: failure.code,
        });
        if (!recorded) {
          return {
            eventId: delivery.event.eventId,
            status: "LEASE_LOST" as const,
          };
        }
        emit(
          options.telemetry,
          delivery,
          "RETRY_SCHEDULED",
          failedAt,
          failure.code,
        );
        return {
          eventId: delivery.event.eventId,
          status: "RETRY_SCHEDULED" as const,
        };
      }
    },
  });
}

export class PermanentOutboxError extends Error {
  public readonly code: string;

  public constructor(code: string) {
    super("Permanent outbox delivery failure");
    this.code = validateErrorCode(code);
    this.name = "PermanentOutboxError";
  }
}

export class RetryableOutboxError extends Error {
  public readonly code: string;

  public constructor(code: string) {
    super("Retryable outbox delivery failure");
    this.code = validateErrorCode(code);
    this.name = "RetryableOutboxError";
  }
}

function classifyFailure(error: unknown): {
  readonly code: string;
  readonly retryable: boolean;
} {
  if (error instanceof PermanentOutboxError) {
    return { code: error.code, retryable: false };
  }
  if (error instanceof RetryableOutboxError) {
    return { code: error.code, retryable: true };
  }
  return { code: "UNEXPECTED", retryable: true };
}

function emit(
  telemetry: OutboxWorkerTelemetry | undefined,
  delivery: OutboxDelivery,
  outcome: OutboxWorkerTelemetryEvent["outcome"],
  occurredAt: Date,
  errorCode?: string,
): void {
  try {
    telemetry?.record(
      Object.freeze({
        attempt: delivery.attempt,
        eventId: delivery.event.eventId,
        eventName: delivery.event.name,
        ...(errorCode === undefined ? {} : { errorCode }),
        occurredAt,
        outcome,
      }),
    );
  } catch {
    // Telemetry never changes outbox delivery state.
  }
}

function validateErrorCode(code: string): string {
  if (!/^[A-Z][A-Z0-9_.-]{0,63}$/u.test(code)) {
    throw new TypeError("error code must be a stable safe identifier");
  }
  return code;
}

function validDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("clock must return a valid Date");
  }
  return value;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}
