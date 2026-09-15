import {
  analyticsEventCatalog,
  analyticsEventDefinition,
  analyticsEventNames,
  SEARCH_ANALYTICS_VERSION,
  type AnalyticsEventDefinition,
  type AnalyticsEventName,
  type AnalyticsPropertyKind,
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
const ctaOrigins = new Set(["PUBLIC_PROFILE", "SEARCH_RESULTS"]);
const locationAreaGranularities = new Set(["DISTRICT", "REGION"]);
const locationScopes = new Set(["NONE", "MUNICIPALITY_SELECTED"]);
const resultCountBuckets = new Set(["ZERO", "ONE_TO_FOUR", "FIVE_PLUS"]);
const availabilityCountBuckets = new Set([
  "NOT_APPLICABLE",
  ...resultCountBuckets,
]);
const searchSortModes = new Set(["RECOMMENDED", "NEAREST", "BEST_RATED"]);
const shortlistSizeBuckets = new Set([
  "ZERO",
  "ONE",
  "TWO_TO_FOUR",
  "FIVE_TO_NINE",
  "TEN_PLUS",
]);
const authoringModes = new Set(["PLATFORM_STRUCTURED", "EXTERNAL_PDF"]);
const cancellationReasons = new Set([
  "DUPLICATE",
  "NO_LONGER_NEEDED",
  "OTHER",
  "PLANS_CHANGED",
]);
const declineReasons = new Set([
  "NO_CAPACITY",
  "NOT_MY_WORK",
  "OTHER",
  "TIMING",
  "TOO_FAR",
]);
const draftOrigins = new Set(["INITIAL", "REVISION", "RECONFIRM"]);
const attachmentCountBuckets = new Set(["ONE", "TWO_TO_FOUR", "FIVE_TO_TEN"]);
const attachmentTypeBuckets = new Set(["IMAGE", "PDF", "MIXED"]);
const effectInitiators = new Set(["SYSTEM", "USER"]);
const invitationWithdrawalSources = new Set([
  "CUSTOMER",
  "CRAFTSMAN",
  "REQUEST_CLOSED",
]);
const materialRevisionCountBuckets = new Set(["ONE", "TWO", "THREE_PLUS"]);
const messageCountBuckets = new Set([
  "TWO_TO_FOUR",
  "FIVE_TO_NINE",
  "TEN_PLUS",
]);
const photoCountBuckets = new Set(["NONE", "ONE_TO_FOUR", "FIVE_TO_TEN"]);
const priceModes = new Set(["FIXED", "ESTIMATE", "RANGE"]);
const profileContexts = new Set(["CUSTOMER", "CRAFTSMAN"]);
const timingOptions = new Set([
  "AS_SOON_AS_POSSIBLE",
  "SPECIFIC_PERIOD",
  "FLEXIBLE",
  "NOT_PROVIDED",
]);
const professionCodePattern = /^PROF:[A-Z0-9][A-Z0-9_]{1,62}$/u;
const specializationCodePattern = /^SPEC:[A-Z0-9][A-Z0-9_]{1,62}$/u;
const governedLocationAreaCodePattern = /^[A-Z0-9][A-Z0-9._:-]{0,63}$/u;

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
  const definition = analyticsEventDefinition(
    eventName,
    assertSchemaVersion(envelope.schema_version),
  );
  if (definition === undefined)
    throw new TypeError("analytics schema_version does not match the catalog");
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
  const properties = validatePropertiesForDefinition(
    eventName,
    definition,
    envelope.properties,
    "ENVELOPE",
  );

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
    schema_version: envelope.schema_version as number,
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
      ["kind", "anonymous_id", "is_internal", "is_test", "session_id"],
      ["kind", "anonymous_id", "is_internal", "is_test"],
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
  return validatePropertiesFor(eventName, value, "ENVELOPE");
}

export function validateCaptureProperties(
  eventName: AnalyticsEventName,
  value: unknown,
): Readonly<Record<string, string>> {
  return validatePropertiesFor(eventName, value, "CAPTURE");
}

export function validateCapturePropertiesVersion(
  eventName: AnalyticsEventName,
  schemaVersion: number,
  value: unknown,
): Readonly<Record<string, string>> {
  const definition = analyticsEventDefinition(eventName, schemaVersion);
  if (definition === undefined) {
    throw new TypeError("analytics schema_version does not match the catalog");
  }
  return validatePropertiesForDefinition(
    eventName,
    definition,
    value,
    "CAPTURE",
  );
}

function validatePropertiesFor(
  eventName: AnalyticsEventName,
  value: unknown,
  representation: "CAPTURE" | "ENVELOPE",
): Readonly<Record<string, string>> {
  const rules = analyticsEventCatalog[eventName].properties;
  return validatePropertiesForDefinition(
    eventName,
    { properties: rules },
    value,
    representation,
  );
}

function validatePropertiesForDefinition(
  eventName: AnalyticsEventName,
  definition: Pick<AnalyticsEventDefinition, "properties">,
  value: unknown,
  representation: "CAPTURE" | "ENVELOPE",
): Readonly<Record<string, string>> {
  const properties = assertPlainObject(value, "analytics properties");
  const rules = definition.properties;
  const keys = Object.keys(rules);
  const requiredKeys = keys.filter((key) => {
    const rule = rules[key];
    return typeof rule === "string";
  });
  assertExactKeys(properties, keys, requiredKeys, `${eventName} properties`);

  const validated: Record<string, string> = {};
  for (const key of keys) {
    const rule = rules[key];
    if (rule === undefined) {
      throw new TypeError("analytics catalog contains an unsupported rule");
    }
    if (properties[key] === undefined && typeof rule !== "string") continue;
    const kind = typeof rule === "string" ? rule : rule.kind;
    validated[key] = validateProperty(
      kind,
      properties[key],
      key,
      representation,
    );
  }
  validatePropertyCoherence(eventName, validated);
  return Object.freeze({ ...validated });
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
    ["kind", "anonymous_id", "is_internal", "is_test", "session_id"],
    ["anonymous_id", "is_internal", "is_test"],
    "analytics anonymous context",
  );
  if (
    typeof anonymous.anonymous_id !== "string" ||
    !anonymousIdPattern.test(anonymous.anonymous_id)
  ) {
    throw new TypeError("analytics anonymous_id must be a random opaque ID");
  }
  if (
    typeof anonymous.is_internal !== "boolean" ||
    typeof anonymous.is_test !== "boolean"
  ) {
    throw new TypeError("analytics exclusion flags must be boolean");
  }
  const session =
    anonymous.session_id === undefined
      ? {}
      : {
          session_id: assertSessionId(anonymous.session_id),
        };
  return Object.freeze({
    anonymous_id: anonymous.anonymous_id,
    is_internal: anonymous.is_internal,
    is_test: anonymous.is_test,
    ...session,
  });
}

function validateProperty(
  kind: AnalyticsPropertyKind,
  value: unknown,
  key: string,
  representation: "CAPTURE" | "ENVELOPE",
): string {
  switch (kind) {
    case "UUID":
      return assertUuid(value, key);
    case "BOOLEAN":
      if (representation === "CAPTURE" && typeof value === "boolean") {
        return String(value);
      }
      if (
        representation === "ENVELOPE" &&
        (value === "false" || value === "true")
      ) {
        return value;
      }
      throw new TypeError(`${key} must be boolean`);
    case "PROFESSION_CODE":
      return assertPattern(value, professionCodePattern, key);
    case "SPECIALIZATION_CODE":
      return assertPattern(value, specializationCodePattern, key);
    case "GOVERNED_LOCATION_AREA_CODE":
      return assertPattern(value, governedLocationAreaCodePattern, key);
    case "CTA_ORIGIN":
      return assertEnum(value, ctaOrigins, key);
    case "LOCATION_AREA_GRANULARITY":
      return assertEnum(value, locationAreaGranularities, key);
    case "LOCATION_SCOPE":
      return assertEnum(value, locationScopes, key);
    case "RESULT_COUNT_BUCKET":
      return assertEnum(value, resultCountBuckets, key);
    case "SEARCH_AVAILABILITY_COUNT_BUCKET":
      return assertEnum(value, availabilityCountBuckets, key);
    case "SEARCH_SORT_MODE":
      return assertEnum(value, searchSortModes, key);
    case "SEARCH_VERSION":
      if (value !== SEARCH_ANALYTICS_VERSION) {
        throw new TypeError(`${key} is not the catalog search version`);
      }
      return value;
    case "SHORTLIST_SIZE_BUCKET":
      return assertEnum(value, shortlistSizeBuckets, key);
    case "AUTHORING_MODE":
      return assertEnum(value, authoringModes, key);
    case "ATTACHMENT_COUNT_BUCKET":
      return assertEnum(value, attachmentCountBuckets, key);
    case "ATTACHMENT_TYPE_BUCKET":
      return assertEnum(value, attachmentTypeBuckets, key);
    case "CANCELLATION_REASON":
      return assertEnum(value, cancellationReasons, key);
    case "DECLINE_REASON":
      return assertEnum(value, declineReasons, key);
    case "DRAFT_ORIGIN":
      return assertEnum(value, draftOrigins, key);
    case "EFFECT_INITIATOR":
      return assertEnum(value, effectInitiators, key);
    case "INVITATION_WITHDRAWAL_SOURCE":
      return assertEnum(value, invitationWithdrawalSources, key);
    case "MATERIAL_REVISION_COUNT_BUCKET":
      return assertEnum(value, materialRevisionCountBuckets, key);
    case "MESSAGE_COUNT_BUCKET":
      return assertEnum(value, messageCountBuckets, key);
    case "PHOTO_COUNT_BUCKET":
      return assertEnum(value, photoCountBuckets, key);
    case "PRICE_MODE":
      return assertEnum(value, priceModes, key);
    case "PROFILE_CONTEXT":
      return assertEnum(value, profileContexts, key);
    case "TIMING_OPTION":
      return assertEnum(value, timingOptions, key);
    case "BOUNDED_QUOTE_COUNT":
      return assertBoundedInteger(value, key, representation, 0, 5);
    case "POSITIVE_INTEGER":
      return assertBoundedInteger(value, key, representation, 1, 2_147_483_647);
    case "RESULT_POSITION":
      if (representation === "CAPTURE") {
        if (
          !Number.isSafeInteger(value) ||
          (value as number) < 1 ||
          (value as number) > 100
        ) {
          throw new TypeError(`${key} must be an integer from 1 through 100`);
        }
        return String(value);
      }
      if (
        typeof value !== "string" ||
        !/^(?:[1-9]|[1-9][0-9]|100)$/u.test(value)
      ) {
        throw new TypeError(`${key} must be an integer from 1 through 100`);
      }
      return value;
  }
}

function assertBoundedInteger(
  value: unknown,
  key: string,
  representation: "CAPTURE" | "ENVELOPE",
  minimum: number,
  maximum: number,
): string {
  const parsed =
    representation === "CAPTURE"
      ? value
      : typeof value === "string" && /^\d+$/u.test(value)
        ? Number(value)
        : Number.NaN;
  if (
    !Number.isSafeInteger(parsed) ||
    (parsed as number) < minimum ||
    (parsed as number) > maximum
  ) {
    throw new TypeError(`${key} must be a bounded integer`);
  }
  return String(parsed);
}

function validatePropertyCoherence(
  eventName: AnalyticsEventName,
  properties: Readonly<Record<string, string>>,
): void {
  if (eventName === "search_executed") {
    const hasAreaGranularity =
      properties.location_area_granularity !== undefined;
    const hasAreaCode = properties.location_area_code !== undefined;
    if (hasAreaGranularity !== hasAreaCode) {
      throw new TypeError(
        "search_executed coarse location area requires both granularity and code",
      );
    }
    if (
      properties.location_scope === "NONE" &&
      (hasAreaGranularity || hasAreaCode)
    ) {
      throw new TypeError(
        "search_executed cannot attach a location area without a selected location",
      );
    }
    if (
      properties.timing_supplied === "false" &&
      (properties.indicative_availability_filter === "true" ||
        properties.indicatively_available_count_bucket !== "NOT_APPLICABLE")
    ) {
      throw new TypeError(
        "search_executed availability analytics requires supplied timing",
      );
    }
    if (
      properties.timing_supplied === "true" &&
      properties.indicatively_available_count_bucket === "NOT_APPLICABLE"
    ) {
      throw new TypeError(
        "search_executed supplied timing requires an availability count bucket",
      );
    }
  }
  if (
    eventName === "craftsman_request_cta_clicked" &&
    (properties.origin === "SEARCH_RESULTS") !==
      (properties.search_id !== undefined)
  ) {
    throw new TypeError(
      `${eventName} search_id must appear exactly for SEARCH_RESULTS context`,
    );
  }
  if (
    eventName === "shortlist_added" &&
    properties.shortlist_size_bucket === "ZERO"
  ) {
    throw new TypeError("shortlist_added cannot result in an empty shortlist");
  }
}

function assertPattern(value: unknown, pattern: RegExp, key: string): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new TypeError(`${key} is not a governed code`);
  }
  return value;
}

function assertEnum(
  value: unknown,
  values: ReadonlySet<string>,
  key: string,
): string {
  if (typeof value !== "string" || !values.has(value)) {
    throw new TypeError(`${key} is not an allowlisted enum value`);
  }
  return value;
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

function assertSchemaVersion(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > 32_767
  ) {
    throw new TypeError("analytics schema_version is invalid");
  }
  return value as number;
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
