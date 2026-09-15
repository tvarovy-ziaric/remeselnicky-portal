import type {
  AnalyticsDiagnosticCode,
  TrustedAnalyticsCaptureInput,
  TrustedAnalyticsPublisher,
} from "./types.js";

export const R3_ANALYTICS_CONSUMER_NAME = "analytics.r3-funnel" as const;

export type R3AnalyticsObservationKind =
  | "INVITATION_VIEWED"
  | "QUOTE_VIEWED"
  | "QUOTE_COMPARISON_OPENED"
  | "QUOTE_COMPARISON_PDF_OPENED";

export interface R3AnalyticsObservationInput {
  readonly actorUserId: string;
  readonly commandId: string;
  readonly jobRequestId: string;
  readonly kind: R3AnalyticsObservationKind;
  readonly invitationId?: string;
  readonly quoteId?: string;
  readonly quoteRevision?: number;
}

export interface R3AnalyticsObservationPersistence {
  record(
    input: R3AnalyticsObservationInput,
  ): Promise<"RECORDED" | "UNCHANGED" | "NOT_AVAILABLE">;
}

export interface R3PdfDeliveryObservationPersistence {
  recordSuccessfulDelivery(input: {
    readonly actorUserId: string;
    readonly mediaAssetId: string;
  }): Promise<void>;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function assertR3AnalyticsObservationInput(
  input: R3AnalyticsObservationInput,
): void {
  if (
    input.kind !== "INVITATION_VIEWED" &&
    input.kind !== "QUOTE_VIEWED" &&
    input.kind !== "QUOTE_COMPARISON_OPENED" &&
    input.kind !== "QUOTE_COMPARISON_PDF_OPENED"
  ) {
    throw new TypeError("analytics observation kind is invalid");
  }
  for (const [label, value] of [
    ["actorUserId", input.actorUserId],
    ["commandId", input.commandId],
    ["jobRequestId", input.jobRequestId],
  ] as const) {
    if (!uuidPattern.test(value))
      throw new TypeError(`${label} must be a UUID`);
  }
  const quoteKind =
    input.kind === "QUOTE_VIEWED" ||
    input.kind === "QUOTE_COMPARISON_PDF_OPENED";
  const invitationKind = input.kind === "INVITATION_VIEWED";
  if (
    quoteKind !== (input.quoteId !== undefined) ||
    quoteKind !== (input.quoteRevision !== undefined)
  ) {
    throw new TypeError("analytics observation target shape is invalid");
  }
  if (input.quoteId !== undefined && !uuidPattern.test(input.quoteId)) {
    throw new TypeError("quoteId must be a UUID");
  }
  if (
    invitationKind !== (input.invitationId !== undefined) ||
    (input.invitationId !== undefined && !uuidPattern.test(input.invitationId))
  ) {
    throw new TypeError("analytics invitation target shape is invalid");
  }
  if (
    input.quoteRevision !== undefined &&
    (!Number.isSafeInteger(input.quoteRevision) || input.quoteRevision < 1)
  ) {
    throw new TypeError("quoteRevision must be a positive integer");
  }
}

export interface R3AnalyticsLease {
  readonly attempt: number;
  readonly eventId: string;
  readonly kind: "VALID";
  readonly leaseToken: string;
  readonly observation: TrustedAnalyticsCaptureInput;
}

export interface R3AnalyticsInvalidLease {
  readonly attempt: number;
  readonly eventId: string;
  readonly kind: "INVALID";
  readonly leaseToken: string;
}

export type R3AnalyticsClaim = R3AnalyticsLease | R3AnalyticsInvalidLease;

export interface R3AnalyticsLeaseStore {
  claimNext(input: {
    readonly leaseDurationMs: number;
    readonly now: Date;
  }): Promise<R3AnalyticsClaim | undefined>;
  markDelivered(lease: R3AnalyticsClaim, at: Date): Promise<boolean>;
  markTerminal(
    lease: R3AnalyticsClaim,
    outcome: "INVALID_EVENT" | "TRANSPORT_DISABLED",
    at: Date,
  ): Promise<boolean>;
  retry(
    lease: R3AnalyticsClaim,
    input: {
      readonly at: Date;
      readonly availableAt: Date;
      readonly reason: "TRANSPORT_MISCONFIGURED" | "TRANSPORT_UNAVAILABLE";
    },
  ): Promise<boolean>;
}

export type R3AnalyticsProcessResult = Readonly<
  | { status: "IDLE" }
  | {
      eventId: string;
      status: "DELIVERED" | "LEASE_LOST" | "RETRY_SCHEDULED" | "TERMINAL";
    }
>;

/**
 * Independent analytics delivery loop. It never mutates the global domain
 * outbox status used by transactional notifications.
 */
export function createR3AnalyticsProcessor(input: {
  readonly backoffMs: (attempt: number) => number;
  readonly leaseDurationMs: number;
  readonly now?: () => Date;
  readonly publisher: TrustedAnalyticsPublisher;
  readonly store: R3AnalyticsLeaseStore;
}): Readonly<{ processNext(): Promise<R3AnalyticsProcessResult> }> {
  positiveInteger(input.leaseDurationMs, "leaseDurationMs");
  const now = input.now ?? (() => new Date());
  return Object.freeze({
    async processNext(): Promise<R3AnalyticsProcessResult> {
      const claimedAt = validDate(now());
      const lease = await input.store.claimNext({
        leaseDurationMs: input.leaseDurationMs,
        now: claimedAt,
      });
      if (lease === undefined)
        return Object.freeze({ status: "IDLE" as const });

      if (lease.kind === "INVALID") {
        return effectResult(
          lease.eventId,
          await input.store.markTerminal(lease, "INVALID_EVENT", claimedAt),
          "TERMINAL",
        );
      }

      const result = await input.publisher.captureTrusted(lease.observation);
      const completedAt = validDate(now());
      if (result.status === "DELIVERED") {
        return effectResult(
          lease.eventId,
          await input.store.markDelivered(lease, completedAt),
          "DELIVERED",
        );
      }
      if (
        result.reason === "INVALID_EVENT" ||
        result.reason === "TRANSPORT_DISABLED"
      ) {
        return effectResult(
          lease.eventId,
          await input.store.markTerminal(lease, result.reason, completedAt),
          "TERMINAL",
        );
      }
      const reason = retryReason(result.reason);
      const delay = input.backoffMs(lease.attempt);
      if (!Number.isSafeInteger(delay) || delay < 0) {
        throw new RangeError("backoffMs must return a non-negative integer");
      }
      return effectResult(
        lease.eventId,
        await input.store.retry(lease, {
          at: completedAt,
          availableAt: new Date(completedAt.getTime() + delay),
          reason,
        }),
        "RETRY_SCHEDULED",
      );
    },
  });
}

function retryReason(
  reason: AnalyticsDiagnosticCode,
): "TRANSPORT_MISCONFIGURED" | "TRANSPORT_UNAVAILABLE" {
  if (
    reason !== "TRANSPORT_MISCONFIGURED" &&
    reason !== "TRANSPORT_UNAVAILABLE"
  ) {
    throw new TypeError("unsupported analytics retry outcome");
  }
  return reason;
}

function effectResult(
  eventId: string,
  applied: boolean,
  status: "DELIVERED" | "RETRY_SCHEDULED" | "TERMINAL",
): R3AnalyticsProcessResult {
  return Object.freeze({
    eventId,
    status: applied ? status : ("LEASE_LOST" as const),
  });
}

function validDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("analytics processor clock returned an invalid date");
  }
  return value;
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive integer`);
  }
}
