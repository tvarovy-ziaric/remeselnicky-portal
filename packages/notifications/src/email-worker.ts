import type { NotificationContext, NotificationPriority } from "./model.js";

export interface EmailDelivery {
  readonly attempt: number;
  readonly context: NotificationContext;
  readonly deliveryId: string;
  readonly idempotencyKey: string;
  readonly leaseToken: string;
  readonly notificationId: string;
  readonly notificationType: string;
  readonly priority: NotificationPriority;
  readonly recipientUserId: string;
}

export interface TransactionalEmailRequest {
  /** The adapter resolves current verified contact data without persisting it here. */
  readonly recipientUserId: string;
  readonly context: NotificationContext;
  readonly idempotencyKey: string;
  readonly notificationType: string;
  readonly priority: NotificationPriority;
}

export type TransactionalEmailResult =
  | {
      readonly providerMessageReference?: string;
      readonly status: "SENT";
    }
  | {
      readonly providerMessageReference?: string;
      readonly status: "DELIVERED";
    };

export interface TransactionalEmailAdapter {
  /** Provider calls must reuse idempotencyKey and never include private content. */
  deliver(
    request: TransactionalEmailRequest,
  ): Promise<TransactionalEmailResult>;
}

export interface ClaimEmailDeliveryOptions {
  readonly leaseDurationMs: number;
  readonly now: Date;
}

export interface EmailDeliveryStore {
  claimNextEmail(
    options: ClaimEmailDeliveryOptions,
  ): Promise<EmailDelivery | undefined>;
  markEmailDelivered(
    delivery: EmailDelivery,
    providerMessageReference: string | undefined,
    deliveredAt: Date,
  ): Promise<boolean>;
  markEmailSent(
    delivery: EmailDelivery,
    providerMessageReference: string | undefined,
    sentAt: Date,
  ): Promise<boolean>;
  retryEmail(
    delivery: EmailDelivery,
    input: { readonly availableAt: Date; readonly errorCode: string },
  ): Promise<boolean>;
  terminalizeEmail(
    delivery: EmailDelivery,
    input: { readonly errorCode: string; readonly failedAt: Date },
  ): Promise<boolean>;
}

export interface EmailDeliveryTelemetryEvent {
  readonly attempt: number;
  readonly deliveryId: string;
  readonly errorCode?: string;
  readonly notificationType: string;
  readonly occurredAt: Date;
  readonly outcome:
    "SENT" | "DELIVERED" | "RETRY_SCHEDULED" | "TERMINAL_FAILURE";
}

export interface EmailDeliveryTelemetry {
  /** Recipient and notification payload are deliberately excluded. */
  record(event: EmailDeliveryTelemetryEvent): void;
}

export interface NotificationEmailWorker {
  processNext(): Promise<
    | { readonly status: "IDLE" }
    | {
        readonly deliveryId: string;
        readonly status:
          | "SENT"
          | "DELIVERED"
          | "RETRY_SCHEDULED"
          | "TERMINAL_FAILURE"
          | "LEASE_LOST";
      }
  >;
}

export function createNotificationEmailWorker(options: {
  readonly adapter: TransactionalEmailAdapter;
  readonly backoffMs: (attempt: number) => number;
  readonly leaseDurationMs: number;
  readonly maxAttempts: number;
  readonly now?: () => Date;
  readonly store: EmailDeliveryStore;
  readonly telemetry?: EmailDeliveryTelemetry;
}): NotificationEmailWorker {
  assertPositiveInteger(options.leaseDurationMs, "leaseDurationMs");
  assertPositiveInteger(options.maxAttempts, "maxAttempts");
  const now = options.now ?? (() => new Date());

  return Object.freeze({
    async processNext() {
      const delivery = await options.store.claimNextEmail({
        leaseDurationMs: options.leaseDurationMs,
        now: validDate(now()),
      });
      if (delivery === undefined) return { status: "IDLE" as const };

      try {
        const result = await options.adapter.deliver({
          context: delivery.context,
          idempotencyKey: delivery.idempotencyKey,
          notificationType: delivery.notificationType,
          priority: delivery.priority,
          recipientUserId: delivery.recipientUserId,
        });
        const occurredAt = validDate(now());
        const recorded =
          result.status === "DELIVERED"
            ? await options.store.markEmailDelivered(
                delivery,
                result.providerMessageReference,
                occurredAt,
              )
            : await options.store.markEmailSent(
                delivery,
                result.providerMessageReference,
                occurredAt,
              );
        if (!recorded) {
          return {
            deliveryId: delivery.deliveryId,
            status: "LEASE_LOST" as const,
          };
        }
        emit(options.telemetry, delivery, result.status, occurredAt);
        return { deliveryId: delivery.deliveryId, status: result.status };
      } catch (error: unknown) {
        const failure = classifyEmailFailure(error);
        const failedAt = validDate(now());
        if (!failure.retryable || delivery.attempt >= options.maxAttempts) {
          const recorded = await options.store.terminalizeEmail(delivery, {
            errorCode: failure.code,
            failedAt,
          });
          if (!recorded) {
            return {
              deliveryId: delivery.deliveryId,
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
            deliveryId: delivery.deliveryId,
            status: "TERMINAL_FAILURE" as const,
          };
        }

        const delay = options.backoffMs(delivery.attempt);
        if (!Number.isSafeInteger(delay) || delay < 0) {
          throw new RangeError("backoffMs must return a non-negative integer", {
            cause: error,
          });
        }
        const recorded = await options.store.retryEmail(delivery, {
          availableAt: new Date(failedAt.getTime() + delay),
          errorCode: failure.code,
        });
        if (!recorded) {
          return {
            deliveryId: delivery.deliveryId,
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
          deliveryId: delivery.deliveryId,
          status: "RETRY_SCHEDULED" as const,
        };
      }
    },
  });
}

export class RetryableEmailDeliveryError extends Error {
  public readonly code: string;
  public constructor(code: string) {
    super("Retryable email delivery failure");
    this.code = validateErrorCode(code);
    this.name = "RetryableEmailDeliveryError";
  }
}

export class PermanentEmailDeliveryError extends Error {
  public readonly code: string;
  public constructor(code: string) {
    super("Permanent email delivery failure");
    this.code = validateErrorCode(code);
    this.name = "PermanentEmailDeliveryError";
  }
}

/** Explicit fail-closed adapter used until a production provider is authorized. */
export function createUnavailableEmailAdapter(): TransactionalEmailAdapter {
  return Object.freeze({
    deliver(): Promise<never> {
      return Promise.reject(
        new PermanentEmailDeliveryError("EMAIL_PROVIDER_UNAVAILABLE"),
      );
    },
  });
}

function classifyEmailFailure(error: unknown): {
  readonly code: string;
  readonly retryable: boolean;
} {
  if (error instanceof PermanentEmailDeliveryError) {
    return { code: error.code, retryable: false };
  }
  if (error instanceof RetryableEmailDeliveryError) {
    return { code: error.code, retryable: true };
  }
  return { code: "UNEXPECTED", retryable: true };
}

function emit(
  telemetry: EmailDeliveryTelemetry | undefined,
  delivery: EmailDelivery,
  outcome: EmailDeliveryTelemetryEvent["outcome"],
  occurredAt: Date,
  errorCode?: string,
): void {
  try {
    telemetry?.record(
      Object.freeze({
        attempt: delivery.attempt,
        deliveryId: delivery.deliveryId,
        ...(errorCode === undefined ? {} : { errorCode }),
        notificationType: delivery.notificationType,
        occurredAt,
        outcome,
      }),
    );
  } catch {
    // Delivery state is authoritative; telemetry is best effort.
  }
}

function validateErrorCode(code: string): string {
  if (!/^[A-Z][A-Z0-9_.-]{0,63}$/u.test(code)) {
    throw new TypeError("error code must be a bounded machine identifier");
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
