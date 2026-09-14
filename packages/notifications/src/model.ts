import type { EventPayload } from "@portal/outbox";

export const NOTIFICATION_PRIORITIES = [
  "INFO",
  "IMPORTANT",
  "CRITICAL",
] as const;
export type NotificationPriority = (typeof NOTIFICATION_PRIORITIES)[number];

export const NOTIFICATION_CHANNELS = ["IN_APP", "EMAIL", "PUSH"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_DELIVERY_STATES = [
  "QUEUED",
  "PROCESSING",
  "SENT",
  "DELIVERED",
  "TERMINAL_FAILED",
] as const;
export type NotificationDeliveryState =
  (typeof NOTIFICATION_DELIVERY_STATES)[number];

export interface NotificationContext {
  /** Opaque object identifier; it is never an authorization credential. */
  readonly entityId: string;
  readonly entityRevision?: number;
  readonly entityType: string;
  /** Authenticated application path without query parameters or bearer data. */
  readonly path: string;
}

export interface NotificationDraft {
  readonly channels: readonly NotificationChannel[];
  readonly context: NotificationContext;
  readonly payload: EventPayload;
  readonly priority: NotificationPriority;
  readonly recipientUserId: string;
  readonly type: string;
}

export interface NotificationRecord {
  readonly archivedAt: Date | null;
  readonly context: NotificationContext;
  readonly createdAt: Date;
  readonly domainEventId: string;
  readonly eventIdempotencyKey: string;
  readonly id: string;
  readonly payload: EventPayload;
  readonly priority: NotificationPriority;
  readonly readAt: Date | null;
  readonly recipientUserId: string;
  readonly type: string;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const typePattern = /^[a-z][a-z0-9]*(?:[._][a-z0-9]+)*$/u;
const entityTypePattern = /^[A-Z][A-Z0-9_]{0,79}$/u;
const entityIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const pathPattern = /^\/[A-Za-z0-9/_-]{1,511}$/u;
const safeKeyPattern = /^[a-z][a-z0-9_]{0,63}$/u;
const safeStringPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;
const forbiddenPayloadKeys = new Set([
  "address",
  "body",
  "chat_text",
  "content",
  "cookie",
  "coordinates",
  "description",
  "dispute_text",
  "email",
  "exact_address",
  "filename",
  "latitude",
  "longitude",
  "message_text",
  "otp",
  "password",
  "phone",
  "quote_text",
  "review_text",
  "secret",
  "token",
]);

export function validateNotificationDraft(
  draft: NotificationDraft,
): NotificationDraft {
  if (!uuidPattern.test(draft.recipientUserId)) {
    throw new TypeError("recipientUserId must be a UUID");
  }
  if (draft.type.length > 128 || !typePattern.test(draft.type)) {
    throw new TypeError(
      "notification type must be a stable bounded identifier",
    );
  }
  if (!NOTIFICATION_PRIORITIES.includes(draft.priority)) {
    throw new TypeError("notification priority is invalid");
  }
  const channels = [...new Set(draft.channels)];
  if (!channels.includes("IN_APP")) {
    throw new TypeError("in-app is the canonical notification channel");
  }
  if (
    channels.length !== draft.channels.length ||
    channels.some((channel) => !NOTIFICATION_CHANNELS.includes(channel))
  ) {
    throw new TypeError("notification channels must be unique and supported");
  }
  validateContext(draft.context);
  validatePrivacySafePayload(draft.payload);
  return Object.freeze({
    ...draft,
    channels: Object.freeze(channels),
    context: Object.freeze({ ...draft.context }),
    payload: Object.freeze({ ...draft.payload }),
  });
}

export function validatePrivacySafePayload(payload: EventPayload): void {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload) ||
    Object.getPrototypeOf(payload) !== Object.prototype
  ) {
    throw new TypeError("notification payload must be a plain object");
  }
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > 2_048) {
    throw new RangeError("notification payload exceeds 2048 bytes");
  }
  for (const [key, value] of Object.entries(payload)) {
    if (!safeKeyPattern.test(key) || forbiddenPayloadKeys.has(key)) {
      throw new TypeError(`notification payload key is forbidden: ${key}`);
    }
    if (Array.isArray(value)) {
      if (value.length > 32 || value.some((item) => !isSafeScalar(item))) {
        throw new TypeError(`notification payload value is unsafe: ${key}`);
      }
    } else if (!isSafeScalar(value)) {
      throw new TypeError(`notification payload value is unsafe: ${key}`);
    }
  }
}

function validateContext(context: NotificationContext): void {
  if (!entityTypePattern.test(context.entityType)) {
    throw new TypeError(
      "context entityType must be a stable uppercase identifier",
    );
  }
  if (!entityIdPattern.test(context.entityId)) {
    throw new TypeError("context entityId must be an opaque identifier");
  }
  if (
    context.entityRevision !== undefined &&
    (!Number.isSafeInteger(context.entityRevision) ||
      context.entityRevision < 1)
  ) {
    throw new TypeError("context entityRevision must be a positive integer");
  }
  if (!pathPattern.test(context.path) || context.path.includes("//")) {
    throw new TypeError(
      "context path must be a safe relative application path",
    );
  }
}

function isSafeScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" && safeStringPattern.test(value))
  );
}
