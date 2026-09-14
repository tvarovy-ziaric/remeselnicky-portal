import { randomUUID } from "node:crypto";

import { analyticsEventCatalog } from "./catalog.js";
import type {
  AnalyticsCaptureResult,
  AnalyticsDiagnostic,
  AnalyticsEnvironment,
  AnalyticsPlatform,
  AnalyticsPort,
  AnalyticsReadiness,
  AnalyticsTransport,
  AnyAnalyticsCaptureInput,
} from "./types.js";
import {
  assertAppVersion,
  assertEnvironment,
  assertEventName,
  assertPlatform,
  validateAnalyticsEnvelope,
  validateProperties,
  validateSubject,
} from "./validation.js";

export interface CreateAnalyticsOptions {
  readonly appVersion: string;
  readonly clock?: () => Date;
  readonly environment: AnalyticsEnvironment;
  readonly eventId?: () => string;
  readonly onDiagnostic?: (diagnostic: AnalyticsDiagnostic) => void;
  readonly platform: AnalyticsPlatform;
  readonly transport: AnalyticsTransport;
}

export function createAnalytics(
  options: CreateAnalyticsOptions,
): AnalyticsPort {
  const environment = assertEnvironment(options.environment);
  const platform = assertPlatform(options.platform);
  const appVersion = assertAppVersion(options.appVersion);
  const clock = options.clock ?? (() => new Date());
  const eventId = options.eventId ?? randomUUID;
  const readiness = transportReadiness(environment, options.transport);

  return Object.freeze({
    async capture(
      input: AnyAnalyticsCaptureInput,
    ): Promise<AnalyticsCaptureResult> {
      let envelope;
      try {
        const record = asInputRecord(input);
        const eventName = assertEventName(record.event_name);
        const generatedEventId = record.event_id ?? eventId();
        const occurredAt = clock();
        if (
          !(occurredAt instanceof Date) ||
          !Number.isFinite(occurredAt.getTime())
        ) {
          throw new TypeError("analytics clock returned an invalid timestamp");
        }
        envelope = validateAnalyticsEnvelope({
          ...validateSubject(record.subject),
          app_version: appVersion,
          environment,
          event_id: generatedEventId,
          event_name: eventName,
          event_source: analyticsEventCatalog[eventName].source,
          occurred_at: occurredAt.toISOString(),
          platform,
          properties: validateProperties(eventName, record.properties),
          schema_version: analyticsEventCatalog[eventName].schema_version,
        });
      } catch {
        report(options.onDiagnostic, {
          code: "INVALID_EVENT",
          environment,
        });
        return Object.freeze({
          reason: "INVALID_EVENT" as const,
          status: "DROPPED" as const,
        });
      }

      if (readiness.status === "DISABLED") {
        report(options.onDiagnostic, {
          code: "TRANSPORT_DISABLED",
          environment,
          event_id: envelope.event_id,
          event_name: envelope.event_name,
        });
        return Object.freeze({
          event_id: envelope.event_id,
          reason: "TRANSPORT_DISABLED" as const,
          status: "DROPPED" as const,
        });
      }
      if (readiness.status === "MISCONFIGURED") {
        report(options.onDiagnostic, {
          code: "TRANSPORT_MISCONFIGURED",
          environment,
          event_id: envelope.event_id,
          event_name: envelope.event_name,
        });
        return Object.freeze({
          event_id: envelope.event_id,
          reason: "TRANSPORT_MISCONFIGURED" as const,
          status: "DROPPED" as const,
        });
      }

      try {
        await options.transport.deliver(envelope);
        return Object.freeze({
          event_id: envelope.event_id,
          status: "DELIVERED" as const,
        });
      } catch {
        report(options.onDiagnostic, {
          code: "TRANSPORT_UNAVAILABLE",
          environment,
          event_id: envelope.event_id,
          event_name: envelope.event_name,
        });
        return Object.freeze({
          event_id: envelope.event_id,
          reason: "TRANSPORT_UNAVAILABLE" as const,
          status: "DROPPED" as const,
        });
      }
    },
    readiness() {
      return readiness;
    },
  });
}

function transportReadiness(
  environment: AnalyticsEnvironment,
  transport: AnalyticsTransport,
): AnalyticsReadiness {
  if (transport.environment !== environment) {
    return Object.freeze({
      reason: "CROSS_ENVIRONMENT_TRANSPORT" as const,
      status: "MISCONFIGURED" as const,
    });
  }
  if (environment === "production" && transport.kind === "TEST") {
    return Object.freeze({
      reason: "TEST_TRANSPORT_IN_PRODUCTION" as const,
      status: "MISCONFIGURED" as const,
    });
  }
  if (transport.kind === "NOOP") {
    return Object.freeze({ status: "DISABLED" as const });
  }
  return Object.freeze({ status: "ACTIVE" as const });
}

function asInputRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("analytics capture input must be an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  for (const key of keys) {
    if (!["event_id", "event_name", "properties", "subject"].includes(key)) {
      throw new TypeError(`analytics capture key is not allowlisted: ${key}`);
    }
  }
  for (const key of ["event_name", "properties", "subject"]) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw new TypeError(`analytics capture input is missing ${key}`);
    }
  }
  return record;
}

function report(
  diagnostic: CreateAnalyticsOptions["onDiagnostic"],
  value: AnalyticsDiagnostic,
): void {
  try {
    diagnostic?.(Object.freeze(value));
  } catch {
    // Diagnostics must preserve the same non-interference guarantee as delivery.
  }
}
