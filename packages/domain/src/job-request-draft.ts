import type { CustomerProfileId } from "./customer-profile.js";
import type { JobRequestId } from "./job-request.js";
import type { UserId } from "./user.js";

declare const jobRequestDraftSectionKeyBrand: unique symbol;

export type JobRequestDraftSectionKey = string & {
  readonly [jobRequestDraftSectionKeyBrand]: "JobRequestDraftSectionKey";
};

export type DraftJsonValue =
  | boolean
  | null
  | number
  | string
  | readonly DraftJsonValue[]
  | { readonly [key: string]: DraftJsonValue };

export interface JobRequestDraftSection {
  readonly key: JobRequestDraftSectionKey;
  readonly payload: Readonly<Record<string, DraftJsonValue>>;
  readonly savedAt: Date;
  readonly schemaVersion: number;
}

export interface JobRequestDraftSnapshot {
  readonly changedAt: Date;
  readonly createdAt: Date;
  readonly id: JobRequestId;
  readonly revision: number;
  readonly sections: readonly JobRequestDraftSection[];
}

export interface JobRequestDraftSummary {
  readonly changedAt: Date;
  readonly createdAt: Date;
  readonly id: JobRequestId;
  readonly revision: number;
  readonly sectionCount: number;
}

export interface AutosaveJobRequestDraftInput {
  readonly actorUserId: UserId;
  readonly commandId: string;
  readonly expectedRevision: number;
  readonly jobRequestId: JobRequestId;
  readonly section: JobRequestDraftSectionInput;
}

export interface JobRequestDraftSectionInput {
  readonly key: string;
  readonly payload: unknown;
  readonly schemaVersion: number;
}

export interface PersistAutosaveJobRequestDraftInput extends Omit<
  AutosaveJobRequestDraftInput,
  "section"
> {
  readonly section: Readonly<{
    readonly canonicalPayload: string;
    readonly key: JobRequestDraftSectionKey;
    readonly payload: Readonly<Record<string, DraftJsonValue>>;
    readonly schemaVersion: number;
  }>;
}

/** Internal transactional seam for the later R3-003 authenticated handoff. */
export interface PersistCreateDraftWithInitialSectionInput {
  readonly actorUserId: UserId;
  readonly commandId: string;
  readonly customerProfileId: CustomerProfileId;
  readonly section: PersistAutosaveJobRequestDraftInput["section"];
}

export type JobRequestDraftAutosaveResult = Readonly<
  | {
      readonly jobRequestId: JobRequestId;
      readonly originalStatus?: "APPLIED" | "UNCHANGED";
      readonly revision: number;
      readonly savedAt: Date;
      readonly status: "APPLIED" | "DEDUPLICATED" | "UNCHANGED";
    }
  | {
      readonly currentRevision?: number;
      readonly status:
        | "ACCOUNT_NOT_ACTIVE"
        | "INVALID_STATE"
        | "NOT_FOUND"
        | "SECTION_LIMIT_REACHED"
        | "STALE_REVISION";
    }
>;

export type JobRequestDraftRecoveryResult = Readonly<
  | { readonly draft: JobRequestDraftSnapshot; readonly status: "OK" }
  | { readonly status: "ACCOUNT_NOT_ACTIVE" | "NOT_FOUND" }
>;

export type JobRequestDraftListResult = Readonly<
  | {
      readonly drafts: readonly JobRequestDraftSummary[];
      readonly status: "OK";
    }
  | { readonly status: "ACCOUNT_NOT_ACTIVE" }
>;

export interface JobRequestDraftPersistence {
  autosaveOwned(
    input: PersistAutosaveJobRequestDraftInput,
  ): Promise<JobRequestDraftAutosaveResult>;
  createDraftWithInitialSectionOwned(
    input: PersistCreateDraftWithInitialSectionInput,
  ): Promise<JobRequestDraftAutosaveResult>;
  listRecentOwned(actorUserId: UserId): Promise<JobRequestDraftListResult>;
  recoverOwned(input: {
    readonly actorUserId: UserId;
    readonly jobRequestId: JobRequestId;
  }): Promise<JobRequestDraftRecoveryResult>;
}

export interface JobRequestDraftService {
  autosave(
    input: AutosaveJobRequestDraftInput,
  ): Promise<JobRequestDraftAutosaveResult>;
  listRecent(actorUserId: UserId): Promise<JobRequestDraftListResult>;
  recover(input: {
    readonly actorUserId: UserId;
    readonly jobRequestId: JobRequestId;
  }): Promise<JobRequestDraftRecoveryResult>;
}

export const JOB_REQUEST_DRAFT_MAX_SECTION_BYTES = 32 * 1024;
export const JOB_REQUEST_DRAFT_MAX_CURRENT_SECTIONS = 32;
export const JOB_REQUEST_DRAFT_RECENT_LIMIT = 50;
export const JOB_REQUEST_DRAFT_MAX_DEPTH = 8;
export const JOB_REQUEST_DRAFT_MAX_KEYS = 256;
export const JOB_REQUEST_DRAFT_MAX_ARRAY_ITEMS = 512;
export const JOB_REQUEST_DRAFT_MAX_ARRAY_LENGTH = 128;
export const JOB_REQUEST_DRAFT_MAX_STRING_BYTES = 8 * 1024;

export class JobRequestDraftIdempotencyError extends Error {
  readonly code = "JOB_REQUEST_DRAFT_IDEMPOTENCY_CONFLICT";
}

export class JobRequestDraftValidationError extends TypeError {
  readonly code = "INVALID_JOB_REQUEST_DRAFT_AUTOSAVE";
}

export function createJobRequestDraftService(input: {
  readonly persistence: JobRequestDraftPersistence;
}): JobRequestDraftService {
  return Object.freeze({
    autosave(command: AutosaveJobRequestDraftInput) {
      const normalized = normalizeAutosaveJobRequestDraftInput(command);
      return input.persistence.autosaveOwned(normalized);
    },
    listRecent(actorUserId: UserId) {
      assertUuid(actorUserId, "actorUserId");
      return input.persistence.listRecentOwned(actorUserId);
    },
    recover(command: {
      readonly actorUserId: UserId;
      readonly jobRequestId: JobRequestId;
    }) {
      assertUuid(command.actorUserId, "actorUserId");
      assertUuid(command.jobRequestId, "jobRequestId");
      return input.persistence.recoverOwned(command);
    },
  });
}

export function normalizeAutosaveJobRequestDraftInput(
  input: AutosaveJobRequestDraftInput,
): PersistAutosaveJobRequestDraftInput {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw invalid("command");
  }
  assertUuid(input.actorUserId, "actorUserId");
  assertUuid(input.commandId, "commandId");
  assertUuid(input.jobRequestId, "jobRequestId");
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 1
  ) {
    throw invalid("expectedRevision");
  }
  const section = normalizeJobRequestDraftSection(input.section);
  return Object.freeze({
    actorUserId: input.actorUserId,
    commandId: input.commandId,
    expectedRevision: input.expectedRevision,
    jobRequestId: input.jobRequestId,
    section,
  });
}

export function normalizeJobRequestDraftSection(
  input: JobRequestDraftSectionInput,
): PersistAutosaveJobRequestDraftInput["section"] {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw invalid("section");
  }
  if (!/^[a-z][a-z0-9._-]{0,63}$/u.test(input.key)) {
    throw invalid("section.key");
  }
  if (
    !Number.isSafeInteger(input.schemaVersion) ||
    input.schemaVersion < 1 ||
    input.schemaVersion > 65_535
  ) {
    throw invalid("section.schemaVersion");
  }
  const budget: JsonBudget = { arrayItems: 0, keys: 0 };
  const payload = normalizeObject(input.payload, 0, budget);
  const canonicalPayload = canonicalJson(payload);
  if (utf8Bytes(canonicalPayload) > JOB_REQUEST_DRAFT_MAX_SECTION_BYTES) {
    throw invalid("section.payloadBytes");
  }
  return Object.freeze({
    canonicalPayload,
    key: input.key as JobRequestDraftSectionKey,
    payload,
    schemaVersion: input.schemaVersion,
  });
}

interface JsonBudget {
  arrayItems: number;
  keys: number;
}

function normalizeObject(
  value: unknown,
  depth: number,
  budget: JsonBudget,
): Readonly<Record<string, DraftJsonValue>> {
  if (!isPlainObject(value)) throw invalid("section.payload");
  return normalizeRecord(value, depth, budget);
}

function normalizeRecord(
  value: Record<string, unknown>,
  depth: number,
  budget: JsonBudget,
): Readonly<Record<string, DraftJsonValue>> {
  assertDepth(depth);
  const keys = Object.keys(value).sort(compareCodePoints);
  budget.keys += keys.length;
  if (budget.keys > JOB_REQUEST_DRAFT_MAX_KEYS)
    throw invalid("section.keyCount");
  const normalized: Record<string, DraftJsonValue> = {};
  for (const key of keys) {
    if (
      key.length < 1 ||
      key.length > 64 ||
      hasControlCharacter(key) ||
      key === "__proto__" ||
      key === "constructor" ||
      key === "prototype"
    ) {
      throw invalid("section.payloadKey");
    }
    normalized[key] = normalizeValue(value[key], depth + 1, budget);
  }
  return Object.freeze(normalized);
}

function normalizeValue(
  value: unknown,
  depth: number,
  budget: JsonBudget,
): DraftJsonValue {
  assertDepth(depth);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalid("section.numericValue");
    return value;
  }
  if (typeof value === "string") {
    if (utf8Bytes(value) > JOB_REQUEST_DRAFT_MAX_STRING_BYTES) {
      throw invalid("section.stringBytes");
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > JOB_REQUEST_DRAFT_MAX_ARRAY_LENGTH) {
      throw invalid("section.arrayLength");
    }
    budget.arrayItems += value.length;
    if (budget.arrayItems > JOB_REQUEST_DRAFT_MAX_ARRAY_ITEMS) {
      throw invalid("section.arrayItems");
    }
    return Object.freeze(
      value.map((item) => normalizeValue(item, depth + 1, budget)),
    );
  }
  if (isPlainObject(value)) return normalizeRecord(value, depth, budget);
  throw invalid("section.payloadValue");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function assertDepth(depth: number): void {
  if (depth > JOB_REQUEST_DRAFT_MAX_DEPTH) throw invalid("section.depth");
}

function canonicalJson(value: DraftJsonValue): string {
  if (isDraftJsonArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort(compareCodePoints)
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isDraftJsonArray(
  value: DraftJsonValue,
): value is readonly DraftJsonValue[] {
  return Array.isArray(value);
}

function utf8Bytes(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    bytes +=
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
  }
  return bytes;
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}

function assertUuid(value: unknown, field: string): void {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    throw invalid(field);
  }
}

function invalid(field: string): JobRequestDraftValidationError {
  return new JobRequestDraftValidationError(
    `Invalid job request draft autosave field: ${field}.`,
  );
}
