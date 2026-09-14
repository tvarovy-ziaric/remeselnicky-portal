import {
  analyticsEventCatalog,
  analyticsEventNames,
  type AnalyticsEventName,
} from "./catalog.js";
import type {
  AnalyticsActorContext,
  AnalyticsAnonymousContext,
  AnalyticsEnvelope,
  AnalyticsEnvironment,
  AnalyticsPlatform,
} from "./types.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const anonymousIdPattern = /^anon_[0-9a-f]{32,64}$/u;
const sessionIdPattern = /^session_[0-9a-f]{32,64}$/u;
const appVersionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const environments = new Set<AnalyticsEnvironment>([
  "development",
  "staging",
  "production",
]);
const platforms = new Set<AnalyticsPlatform>(["WEB", "IOS", "ANDROID"]);
const eventNames = new Set<string>(analyticsEventNames);
const actorProfiles = new Set(["CUSTOMER", "CRAFTSMAN", "BOTH"]);

export function validateAnalyticsEnvelope(value: unknown): AnalyticsEnvelope {
  const envelope = assertPlainObject(value, "analytics envelope");
  assertExactKeys(
    envelope,
    [
      "actor_context",
      "anonymous_context",
      "app_version",
      "environment",
      "event_id",
      "event_name",
      "event_source",
      "occurred_at",
      "platform",
      "properties",
      "schema_version",
    ],
    [
      "app_version",
      "environment",
      "event_id",
      "event_name",
      "event_source",
      "occurred_at",
      "platform",
      "properties",
      "schema_version",
    ],
    "analytics envelope",
  );

  const eventName = assertEventName(envelope.event_name);
  const definition = analyticsEventCatalog[eventName];
  if (envelope.schema_version !== definition.schema_version) {
    throw new TypeError("analytics schema_version does not match the catalog");
  }
  if (envelope.event_source !== definition.source) {
    throw new TypeError("analytics event_source does not match the catalog");
  }

  const hasActor = envelope.actor_context !== undefined;
  const hasAnonymous = envelope.anonymous_context !== undefined;
  if (hasActor === hasAnonymous) {
    throw new TypeError(
      "analytics envelope needs exactly one actor or anonymous context",
    );
  }

  const identity = hasActor
    ? {
        actor_context: validateActorContext(envelope.actor_context),
      }
    : {
        anonymous_context: validateAnonymousContext(envelope.anonymous_context),
      };

  const occurredAt = assertCanonicalTimestamp(envelope.occurred_at);
  const environment = assertEnvironment(envelope.environment);
  const platform = assertPlatform(envelope.platform);
  const properties = validateProperties(eventName, envelope.properties);

  return Object.freeze({
    ...identity,
    app_version: assertAppVersion(envelope.app_version),
    environment,
    event_id: assertUuid(envelope.event_id, "event_id"),
    event_name: eventName,
    event_source: definition.source,
    occurred_at: occurredAt,
    platform,
    properties,
    schema_version: definition.schema_version,
  });
}

export function assertEnvironment(value: unknown): AnalyticsEnvironment {
  if (
    typeof value !== "string" ||
    !environments.has(value as AnalyticsEnvironment)
  ) {
    throw new TypeError("analytics environment is invalid");
  }
  return value as AnalyticsEnvironment;
}

export function assertPlatform(value: unknown): AnalyticsPlatform {
  if (typeof value !== "string" || !platforms.has(value as AnalyticsPlatform)) {
    throw new TypeError("analytics platform is invalid");
  }
  return value as AnalyticsPlatform;
}

export function assertAppVersion(value: unknown): string {
  if (typeof value !== "string" || !appVersionPattern.test(value)) {
    throw new TypeError(
      "analytics app_version must be a bounded machine value",
    );
  }
  return value;
}

export function assertEventName(value: unknown): AnalyticsEventName {
  if (typeof value !== "string" || !eventNames.has(value)) {
    throw new TypeError("analytics event_name is not in the explicit catalog");
  }
  return value as AnalyticsEventName;
}

export function validateSubject(subject: unknown):
  | Readonly<{ actor_context: Readonly<Omit<AnalyticsActorContext, "kind">> }>
  | Readonly<{
      anonymous_context: Readonly<Omit<AnalyticsAnonymousContext, "kind">>;
    }> {
  const record = assertPlainObject(subject, "analytics subject");
  if (record.kind === "ACTOR") {
    assertExactKeys(
      record,
      ["kind", "user_id", "profile_context", "is_internal", "is_test"],
      ["kind", "user_id", "profile_context", "is_internal", "is_test"],
      "analytics actor subject",
    );
    return Object.freeze({
      actor_context: validateActorContext(record),
    });
  }
  if (record.kind === "ANONYMOUS") {
    assertExactKeys(
      record,
      ["kind", "anonymous_id", "session_id"],
      ["kind", "anonymous_id"],
      "analytics anonymous subject",
    );
    return Object.freeze({
      anonymous_context: validateAnonymousContext(record),
    });
  }
  throw new TypeError("analytics subject kind is invalid");
}

export function validateProperties(
  eventName: AnalyticsEventName,
  value: unknown,
): Readonly<Record<string, string>> {
  const properties = assertPlainObject(value, "analytics properties");
  const rules = analyticsEventCatalog[eventName].properties;
  const keys = Object.keys(rules);
  assertExactKeys(properties, keys, keys, `${eventName} properties`);

  const validated: Record<string, string> = {};
  for (const key of keys) {
    const rule = rules[key];
    if (rule !== "UUID") {
      throw new TypeError("analytics catalog contains an unsupported rule");
    }
    validated[key] = assertUuid(properties[key], key);
  }
  return Object.freeze(validated);
}

function validateActorContext(
  value: unknown,
): Readonly<Omit<AnalyticsActorContext, "kind">> {
  const actor = assertPlainObject(value, "analytics actor context");
  const allowedKeys = [
    "kind",
    "user_id",
    "profile_context",
    "is_internal",
    "is_test",
  ];
  const requiredKeys = ["user_id", "profile_context", "is_internal", "is_test"];
  assertExactKeys(actor, allowedKeys, requiredKeys, "analytics actor context");
  if (
    typeof actor.profile_context !== "string" ||
    !actorProfiles.has(actor.profile_context)
  ) {
    throw new TypeError("analytics profile_context is invalid");
  }
  if (
    typeof actor.is_internal !== "boolean" ||
    typeof actor.is_test !== "boolean"
  ) {
    throw new TypeError("analytics exclusion flags must be boolean");
  }
  return Object.freeze({
    is_internal: actor.is_internal,
    is_test: actor.is_test,
    profile_context:
      actor.profile_context as AnalyticsActorContext["profile_context"],
    user_id: assertUuid(actor.user_id, "actor user_id"),
  });
}

function validateAnonymousContext(
  value: unknown,
): Readonly<Omit<AnalyticsAnonymousContext, "kind">> {
  const anonymous = assertPlainObject(value, "analytics anonymous context");
  assertExactKeys(
    anonymous,
    ["kind", "anonymous_id", "session_id"],
    ["anonymous_id"],
    "analytics anonymous context",
  );
  if (
    typeof anonymous.anonymous_id !== "string" ||
    !anonymousIdPattern.test(anonymous.anonymous_id)
  ) {
    throw new TypeError("analytics anonymous_id must be a random opaque ID");
  }
  const session =
    anonymous.session_id === undefined
      ? {}
      : {
          session_id: assertSessionId(anonymous.session_id),
        };
  return Object.freeze({
    anonymous_id: anonymous.anonymous_id,
    ...session,
  });
}

function assertSessionId(value: unknown): string {
  if (typeof value !== "string" || !sessionIdPattern.test(value)) {
    throw new TypeError("analytics session_id must be a random opaque ID");
  }
  return value;
}

function assertUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new TypeError(`${label} must be a UUID`);
  }
  return value.toLowerCase();
}

function assertCanonicalTimestamp(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("analytics occurred_at must be a server timestamp");
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TypeError("analytics occurred_at must be canonical ISO-8601 UTC");
  }
  return value;
}

function assertPlainObject(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(`${label} cannot have symbol properties`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const descriptor of Object.values(descriptors)) {
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new TypeError(`${label} cannot have accessor properties`);
    }
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  record: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  required: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) {
      throw new TypeError(`${label} key is not allowlisted: ${key}`);
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw new TypeError(`${label} is missing required key: ${key}`);
    }
  }
}
