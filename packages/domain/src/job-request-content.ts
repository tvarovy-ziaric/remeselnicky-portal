import type { MunicipalityCode } from "./craftsman-service-area.js";
import {
  normalizeJobRequestDraftSection,
  type JobRequestDraftSectionKey,
  type JobRequestDraftSectionInput,
} from "./job-request-draft.js";
import type { JobRequestSubmissionRequirement } from "./job-request.js";

export const JOB_REQUEST_CONTENT_SECTION_KEYS = Object.freeze([
  "request.core",
  "request.location",
  "request.timing",
  "request.budget",
  "request.details",
  "request.media",
] as const);

export const JOB_REQUEST_CONTENT_SECTION_VERSIONS = Object.freeze({
  "request.budget": 1,
  "request.core": 1,
  "request.details": 1,
  "request.location": 1,
  "request.media": 1,
  "request.timing": 1,
} as const);

export const JOB_REQUEST_MAX_PHOTOS = 10;
export const JOB_REQUEST_DOCUMENT_TECHNICAL_LIMIT = 128;
export const JOB_REQUEST_RELATED_PROFESSION_TECHNICAL_LIMIT = 32;
export const JOB_REQUEST_SKILL_TECHNICAL_LIMIT = 128;
export const JOB_REQUEST_MAX_BUDGET_CENTS = 2_147_483_647;

export const JOB_REQUEST_TIMING_MODES = Object.freeze([
  "AS_SOON_AS_POSSIBLE",
  "SPECIFIC_PERIOD",
  "FLEXIBLE",
] as const);
export const JOB_REQUEST_BUDGET_MODES = Object.freeze([
  "UP_TO",
  "RANGE",
  "UNKNOWN",
] as const);
export const JOB_REQUEST_MATERIAL_RESPONSIBILITIES = Object.freeze([
  "CUSTOMER_PROVIDES",
  "CRAFTSMAN_PROVIDES",
  "ADVICE_NEEDED",
  "COMBINATION",
] as const);
export const JOB_REQUEST_SITE_INSPECTION_PREFERENCES = Object.freeze([
  "LIKELY",
  "MAYBE",
  "UNKNOWN",
] as const);

export type JobRequestContentSectionKey =
  (typeof JOB_REQUEST_CONTENT_SECTION_KEYS)[number];
export type JobRequestTimingMode = (typeof JOB_REQUEST_TIMING_MODES)[number];
export type JobRequestBudgetMode = (typeof JOB_REQUEST_BUDGET_MODES)[number];
export type JobRequestMaterialResponsibility =
  (typeof JOB_REQUEST_MATERIAL_RESPONSIBILITIES)[number];
export type JobRequestSiteInspectionPreference =
  (typeof JOB_REQUEST_SITE_INSPECTION_PREFERENCES)[number];

export interface JobRequestCoreContent {
  readonly description: string | null;
  readonly primaryProfessionCode: string | null;
  readonly relatedProfessionCodes: readonly string[];
  readonly skillCodes: readonly string[];
  readonly specializationCode: string | null;
  readonly title: string | null;
}

export interface JobRequestLocationContent {
  /** Private until the confirmed-job authorization boundary. */
  readonly exactAddress: string | null;
  /** Private exact pin; public/request-stage projections must omit it. */
  readonly mapPin: Readonly<{
    readonly latitude: number;
    readonly longitude: number;
  }> | null;
  readonly municipalityCode: MunicipalityCode | null;
  readonly textClarification: string | null;
}

export interface JobRequestTimingContent {
  readonly completionDeadline: string | null;
  readonly endsOn: string | null;
  readonly mode: JobRequestTimingMode | null;
  readonly startsOn: string | null;
}

export interface JobRequestBudgetContent {
  readonly currency: "EUR";
  readonly maximumAmountCents: number | null;
  readonly minimumAmountCents: number | null;
  readonly mode: JobRequestBudgetMode | null;
}

export interface JobRequestDetailsContent {
  readonly approximateQuantity: string | null;
  readonly customRequirements: string | null;
  readonly materialResponsibility: JobRequestMaterialResponsibility | null;
  readonly siteInspection: JobRequestSiteInspectionPreference | null;
}

export interface JobRequestMediaContent {
  readonly documentMediaAssetIds: readonly string[];
  readonly photoMediaAssetIds: readonly string[];
}

type JobRequestContentPayloadByKey = Readonly<{
  "request.budget": JobRequestBudgetContent;
  "request.core": JobRequestCoreContent;
  "request.details": JobRequestDetailsContent;
  "request.location": JobRequestLocationContent;
  "request.media": JobRequestMediaContent;
  "request.timing": JobRequestTimingContent;
}>;

export type JobRequestContentPayload =
  JobRequestContentPayloadByKey[JobRequestContentSectionKey];

export interface JobRequestContentSection {
  readonly canonicalPayload: string;
  readonly key: JobRequestDraftSectionKey;
  readonly payload: JobRequestContentPayload;
  readonly schemaVersion: 1;
}

export class JobRequestContentValidationError extends TypeError {
  readonly code = "INVALID_JOB_REQUEST_CONTENT";
}

export function normalizeJobRequestContentSection(
  input: JobRequestDraftSectionInput,
): JobRequestContentSection {
  assertRecord(input, "section");
  if (!isSectionKey(input.key)) throw invalid("section.key");
  if (input.schemaVersion !== JOB_REQUEST_CONTENT_SECTION_VERSIONS[input.key]) {
    throw invalid("section.schemaVersion");
  }
  const payload = normalizePayload(input.key, input.payload);
  const canonical = normalizeJobRequestDraftSection({
    key: input.key,
    payload,
    schemaVersion: input.schemaVersion,
  });
  return Object.freeze({
    canonicalPayload: canonical.canonicalPayload,
    key: canonical.key,
    payload: canonical.payload,
    schemaVersion: 1,
  }) as unknown as JobRequestContentSection;
}

export function normalizeJobRequestContentSections(
  inputs: readonly JobRequestDraftSectionInput[],
): readonly JobRequestContentSection[] {
  if (!isRuntimeArray(inputs)) throw invalid("sections");
  const sections = inputs.map(normalizeJobRequestContentSection);
  if (new Set(sections.map(({ key }) => key)).size !== sections.length) {
    throw invalid("sections.duplicateKey");
  }
  return Object.freeze(
    [...sections].sort(({ key: left }, { key: right }) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
}

export function jobRequestContentMissingSubmissionRequirements(
  sections: readonly JobRequestContentSection[],
): readonly JobRequestSubmissionRequirement[] {
  if (!isRuntimeArray(sections)) throw invalid("sections");
  const byKey = new Map<
    JobRequestContentSectionKey,
    JobRequestContentSection
  >();
  for (const section of sections) {
    const normalized = normalizeJobRequestContentSection({
      key: section.key,
      payload: section.payload,
      schemaVersion: section.schemaVersion,
    });
    if (!isSectionKey(normalized.key)) throw invalid("sections.key");
    if (byKey.has(normalized.key)) throw invalid("sections.duplicateKey");
    byKey.set(normalized.key, normalized);
  }
  const core = byKey.get("request.core")?.payload as
    JobRequestCoreContent | undefined;
  const location = byKey.get("request.location")?.payload as
    JobRequestLocationContent | undefined;
  return Object.freeze([
    ...(core?.primaryProfessionCode === null || core === undefined
      ? (["PRIMARY_PROFESSION"] as const)
      : []),
    ...(core?.description === null || core === undefined
      ? (["DESCRIPTION"] as const)
      : []),
    ...(location?.municipalityCode === null || location === undefined
      ? (["MUNICIPALITY"] as const)
      : []),
  ]);
}

function normalizePayload(
  key: JobRequestContentSectionKey,
  payload: unknown,
): JobRequestContentPayloadByKey[JobRequestContentSectionKey] {
  switch (key) {
    case "request.core":
      return normalizeCore(payload);
    case "request.location":
      return normalizeLocation(payload);
    case "request.timing":
      return normalizeTiming(payload);
    case "request.budget":
      return normalizeBudget(payload);
    case "request.details":
      return normalizeDetails(payload);
    case "request.media":
      return normalizeMedia(payload);
  }
}

function normalizeCore(payload: unknown): JobRequestCoreContent {
  const value = exactRecord(
    payload,
    [
      "description",
      "primaryProfessionCode",
      "relatedProfessionCodes",
      "skillCodes",
      "specializationCode",
      "title",
    ],
    "core",
  );
  const primaryProfessionCode = optionalCode(
    value.primaryProfessionCode,
    /^(?:PROF|TEST):[A-Z0-9][A-Z0-9_]{1,62}$/u,
    "core.primaryProfessionCode",
  );
  const relatedProfessionCodes = codeArray(
    value.relatedProfessionCodes,
    /^(?:PROF|TEST):[A-Z0-9][A-Z0-9_]{1,62}$/u,
    JOB_REQUEST_RELATED_PROFESSION_TECHNICAL_LIMIT,
    "core.relatedProfessionCodes",
  );
  if (
    primaryProfessionCode !== null &&
    relatedProfessionCodes.includes(primaryProfessionCode)
  ) {
    throw invalid("core.relatedProfessionCodes");
  }
  return Object.freeze({
    description: optionalSafeText(
      value.description,
      4_000,
      true,
      "core.description",
    ),
    primaryProfessionCode,
    relatedProfessionCodes,
    skillCodes: codeArray(
      value.skillCodes,
      /^(?:SKILL|TEST):[A-Z0-9][A-Z0-9_]{1,62}$/u,
      JOB_REQUEST_SKILL_TECHNICAL_LIMIT,
      "core.skillCodes",
    ),
    specializationCode: optionalCode(
      value.specializationCode,
      /^(?:SPEC|TEST):[A-Z0-9][A-Z0-9_]{1,62}$/u,
      "core.specializationCode",
    ),
    title: optionalSafeText(value.title, 160, false, "core.title"),
  });
}

function normalizeLocation(payload: unknown): JobRequestLocationContent {
  const value = exactRecord(
    payload,
    ["exactAddress", "mapPin", "municipalityCode", "textClarification"],
    "location",
  );
  return Object.freeze({
    exactAddress: optionalPrivateText(
      value.exactAddress,
      500,
      false,
      "location.exactAddress",
    ),
    mapPin: normalizeMapPin(value.mapPin),
    municipalityCode: optionalCode(
      value.municipalityCode,
      /^[A-Z0-9][A-Z0-9._:-]{0,63}$/u,
      "location.municipalityCode",
    ) as MunicipalityCode | null,
    textClarification: optionalSafeText(
      value.textClarification,
      1_000,
      true,
      "location.textClarification",
    ),
  });
}

function normalizeTiming(payload: unknown): JobRequestTimingContent {
  const value = exactRecord(
    payload,
    ["completionDeadline", "endsOn", "mode", "startsOn"],
    "timing",
  );
  const mode = optionalEnum(
    value.mode,
    JOB_REQUEST_TIMING_MODES,
    "timing.mode",
  );
  const startsOn = optionalDate(value.startsOn, "timing.startsOn");
  const endsOn = optionalDate(value.endsOn, "timing.endsOn");
  const completionDeadline = optionalDate(
    value.completionDeadline,
    "timing.completionDeadline",
  );
  if (
    (mode !== "SPECIFIC_PERIOD" && (startsOn !== null || endsOn !== null)) ||
    (endsOn !== null && startsOn === null) ||
    (startsOn !== null && endsOn !== null && endsOn < startsOn) ||
    (startsOn !== null &&
      completionDeadline !== null &&
      completionDeadline < startsOn)
  ) {
    throw invalid("timing.interval");
  }
  return Object.freeze({ completionDeadline, endsOn, mode, startsOn });
}

function normalizeBudget(payload: unknown): JobRequestBudgetContent {
  const value = exactRecord(
    payload,
    ["currency", "maximumAmountCents", "minimumAmountCents", "mode"],
    "budget",
  );
  if (value.currency !== "EUR") throw invalid("budget.currency");
  const mode = optionalEnum(
    value.mode,
    JOB_REQUEST_BUDGET_MODES,
    "budget.mode",
  );
  const minimumAmountCents = optionalMoney(
    value.minimumAmountCents,
    "budget.minimumAmountCents",
  );
  const maximumAmountCents = optionalMoney(
    value.maximumAmountCents,
    "budget.maximumAmountCents",
  );
  const valid =
    (mode === null &&
      minimumAmountCents === null &&
      maximumAmountCents === null) ||
    (mode === "UNKNOWN" &&
      minimumAmountCents === null &&
      maximumAmountCents === null) ||
    (mode === "UP_TO" &&
      minimumAmountCents === null &&
      maximumAmountCents !== null) ||
    (mode === "RANGE" &&
      minimumAmountCents !== null &&
      maximumAmountCents !== null &&
      minimumAmountCents <= maximumAmountCents);
  if (!valid) throw invalid("budget.amounts");
  return Object.freeze({
    currency: "EUR",
    maximumAmountCents,
    minimumAmountCents,
    mode,
  });
}

function normalizeDetails(payload: unknown): JobRequestDetailsContent {
  const value = exactRecord(
    payload,
    [
      "approximateQuantity",
      "customRequirements",
      "materialResponsibility",
      "siteInspection",
    ],
    "details",
  );
  return Object.freeze({
    approximateQuantity: optionalSafeText(
      value.approximateQuantity,
      300,
      false,
      "details.approximateQuantity",
    ),
    customRequirements: optionalSafeText(
      value.customRequirements,
      2_000,
      true,
      "details.customRequirements",
    ),
    materialResponsibility: optionalEnum(
      value.materialResponsibility,
      JOB_REQUEST_MATERIAL_RESPONSIBILITIES,
      "details.materialResponsibility",
    ),
    siteInspection: optionalEnum(
      value.siteInspection,
      JOB_REQUEST_SITE_INSPECTION_PREFERENCES,
      "details.siteInspection",
    ),
  });
}

function normalizeMedia(payload: unknown): JobRequestMediaContent {
  const value = exactRecord(
    payload,
    ["documentMediaAssetIds", "photoMediaAssetIds"],
    "media",
  );
  return Object.freeze({
    documentMediaAssetIds: uuidArray(
      value.documentMediaAssetIds,
      JOB_REQUEST_DOCUMENT_TECHNICAL_LIMIT,
      "media.documentMediaAssetIds",
    ),
    photoMediaAssetIds: uuidArray(
      value.photoMediaAssetIds,
      JOB_REQUEST_MAX_PHOTOS,
      "media.photoMediaAssetIds",
    ),
  });
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  field: string,
): Record<string, unknown> {
  assertRecord(value, field);
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw invalid(`${field}.shape`);
  }
  return value;
}

function assertRecord(
  value: unknown,
  field: string,
): asserts value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(
      Object.getPrototypeOf(value) as object | null,
    )
  ) {
    throw invalid(field);
  }
}

function optionalSafeText(
  value: unknown,
  maximumCharacters: number,
  multiline: boolean,
  field: string,
): string | null {
  const normalized = optionalPrivateText(
    value,
    maximumCharacters,
    multiline,
    field,
  );
  if (
    normalized !== null &&
    (/\b[^\s@]+@[^\s@]+\.[a-z]{2,}\b/iu.test(normalized) ||
      /(^|[^0-9])(?:\+|00)?[0-9](?:[\s()./-]*[0-9]){6,}([^0-9]|$)/u.test(
        normalized,
      ))
  ) {
    throw invalid(field);
  }
  return normalized;
}

function optionalPrivateText(
  value: unknown,
  maximumCharacters: number,
  multiline: boolean,
  field: string,
): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string") throw invalid(field);
  const normalized = value.replace(/\r\n?/gu, "\n").trim();
  if (
    normalized.length === 0 ||
    [...normalized].length > maximumCharacters ||
    [...normalized].some((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point === 127 || (point < 32 && !(multiline && point === 10));
    }) ||
    (!multiline && normalized.includes("\n"))
  ) {
    throw invalid(field);
  }
  return normalized;
}

function optionalCode(
  value: unknown,
  pattern: RegExp,
  field: string,
): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !pattern.test(value)) throw invalid(field);
  return value;
}

function codeArray(
  value: unknown,
  pattern: RegExp,
  limit: number,
  field: string,
): readonly string[] {
  if (!Array.isArray(value)) throw invalid(field);
  const items: readonly unknown[] = value;
  if (
    items.length > limit ||
    items.some((item) => typeof item !== "string" || !pattern.test(item)) ||
    new Set(items).size !== items.length
  ) {
    throw invalid(field);
  }
  return Object.freeze(items.map((item) => item as string).sort());
}

function uuidArray(
  value: unknown,
  limit: number,
  field: string,
): readonly string[] {
  if (!Array.isArray(value)) throw invalid(field);
  const items: readonly unknown[] = value;
  if (
    items.length > limit ||
    items.some((item) => !isUuid(item)) ||
    new Set(items).size !== items.length
  ) {
    throw invalid(field);
  }
  return Object.freeze(items.map((item) => item as string));
}

function normalizeMapPin(value: unknown): JobRequestLocationContent["mapPin"] {
  if (value === null) return null;
  const pin = exactRecord(value, ["latitude", "longitude"], "location.mapPin");
  if (
    typeof pin.latitude !== "number" ||
    !Number.isFinite(pin.latitude) ||
    pin.latitude < -90 ||
    pin.latitude > 90 ||
    typeof pin.longitude !== "number" ||
    !Number.isFinite(pin.longitude) ||
    pin.longitude < -180 ||
    pin.longitude > 180
  ) {
    throw invalid("location.mapPin");
  }
  return Object.freeze({
    latitude: Object.is(pin.latitude, -0) ? 0 : pin.latitude,
    longitude: Object.is(pin.longitude, -0) ? 0 : pin.longitude,
  });
}

function optionalDate(value: unknown, field: string): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw invalid(field);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(parsed.valueOf()) ||
    parsed.toISOString().slice(0, 10) !== value ||
    value < "2000-01-01" ||
    value > "2200-12-31"
  ) {
    throw invalid(field);
  }
  return value;
}

function optionalMoney(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > JOB_REQUEST_MAX_BUDGET_CENTS
  ) {
    throw invalid(field);
  }
  return value as number;
}

function optionalEnum<Value extends string>(
  value: unknown,
  allowed: readonly Value[],
  field: string,
): Value | null {
  if (value === null || value === "") return null;
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) throw invalid(field);
  return match;
}

function isSectionKey(value: unknown): value is JobRequestContentSectionKey {
  return JOB_REQUEST_CONTENT_SECTION_KEYS.some((key) => key === value);
}

function isRuntimeArray(value: unknown): boolean {
  return Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}

function invalid(field: string): JobRequestContentValidationError {
  return new JobRequestContentValidationError(
    `Invalid job request content field: ${field}.`,
  );
}
