import { randomUUID } from "node:crypto";

import { analyticsEventCatalog, analyticsEventDefinition } from "./catalog.js";
import type {
  AnalyticsCaptureResult,
  AnalyticsDiagnostic,
  AnalyticsEnvironment,
  AnalyticsPlatform,
  AnalyticsPort,
  AnalyticsReadiness,
  AnalyticsTransport,
  AnyAnalyticsCaptureInput,
  TrustedAnalyticsPublisher,
  TrustedAnalyticsCaptureInput,
} from "./types.js";
import {
  assertAppVersion,
  assertEnvironment,
  assertEventName,
  assertPlatform,
  validateAnalyticsEnvelope,
  validateCaptureProperties,
  validateCapturePropertiesVersion,
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
  const runtime = createAnalyticsRuntime(options);
  return Object.freeze({
    capture: (input: AnyAnalyticsCaptureInput) => runtime.capture(input),
    readiness: () => runtime.readiness(),
  });
}

/** Server-only factory preserving DB-authored time/version semantics. */
export function createTrustedAnalyticsPublisher(
  options: CreateAnalyticsOptions,
): TrustedAnalyticsPublisher {
  const runtime = createAnalyticsRuntime(options);
  return Object.freeze({
    captureTrusted: (input: TrustedAnalyticsCaptureInput) =>
      runtime.captureTrusted(input),
    readiness: () => runtime.readiness(),
  });
}

function createAnalyticsRuntime(
  options: CreateAnalyticsOptions,
): AnalyticsPort & TrustedAnalyticsPublisher {
  const environment = assertEnvironment(options.environment);
  const platform = assertPlatform(options.platform);
  const appVersion = assertAppVersion(options.appVersion);
  const clock = options.clock ?? (() => new Date());
  const eventId = options.eventId ?? randomUUID;
  const readiness = transportReadiness(environment, options.transport);

  async function deliver(
    envelope: ReturnType<typeof validateAnalyticsEnvelope>,
  ): Promise<AnalyticsCaptureResult> {
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
  }

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
          properties: validateCaptureProperties(eventName, record.properties),
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

      return deliver(envelope);
    },
    async captureTrusted(
      input: TrustedAnalyticsCaptureInput,
    ): Promise<AnalyticsCaptureResult> {
      let envelope;
      try {
        const record = asTrustedInputRecord(input);
        const eventName = assertEventName(record.event_name);
        const schemaVersion = assertTrustedSchemaVersion(record.schema_version);
        const definition = analyticsEventDefinition(eventName, schemaVersion);
        if (definition === undefined) {
          throw new TypeError("analytics trusted schema version is unknown");
        }
        if (
          !(record.occurred_at instanceof Date) ||
          !Number.isFinite(record.occurred_at.getTime())
        ) {
          throw new TypeError("analytics trusted timestamp is invalid");
        }
        envelope = validateAnalyticsEnvelope({
          ...validateSubject(record.subject),
          app_version: appVersion,
          environment,
          event_id: record.event_id,
          event_name: eventName,
          event_source: definition.source,
          occurred_at: record.occurred_at.toISOString(),
          platform,
          properties: validateCapturePropertiesVersion(
            eventName,
            schemaVersion,
            record.properties,
          ),
          schema_version: schemaVersion,
        });
      } catch {
        report(options.onDiagnostic, { code: "INVALID_EVENT", environment });
        return Object.freeze({
          reason: "INVALID_EVENT" as const,
          status: "DROPPED" as const,
        });
      }
      return deliver(envelope);
    },
    readiness() {
      return readiness;
    },
  });
}

function asTrustedInputRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("trusted analytics capture input must be an object");
  }
  const record = value as Record<string, unknown>;
  const expected = [
    "event_id",
    "event_name",
    "occurred_at",
    "properties",
    "schema_version",
    "subject",
  ];
  if (
    Object.keys(record).length !== expected.length ||
    expected.some((key) => !Object.prototype.hasOwnProperty.call(record, key))
  ) {
    throw new TypeError("trusted analytics capture keys are invalid");
  }
  return record;
}

function assertTrustedSchemaVersion(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > 32_767
  ) {
    throw new TypeError("trusted analytics schema version is invalid");
  }
  return value as number;
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
