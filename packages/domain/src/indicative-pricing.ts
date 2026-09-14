import type { CraftsmanProfessionId } from "./craftsman-profession.js";
import type { CraftsmanProfileId } from "./craftsman-profile.js";
import type { EntityId } from "./index.js";
import type { UserId } from "./user.js";

export const INDICATIVE_PRICE_MODES = Object.freeze([
  "FROM",
  "APPROXIMATE",
  "HOURLY",
  "PER_SQUARE_METER",
  "PER_UNIT",
  "OTHER",
] as const);

export const INDICATIVE_PRICING_ENTRY_STATES = Object.freeze([
  "ACTIVE",
  "ARCHIVED",
] as const);

export type IndicativePriceMode = (typeof INDICATIVE_PRICE_MODES)[number];
export type IndicativePricingEntryState =
  (typeof INDICATIVE_PRICING_ENTRY_STATES)[number];

declare const indicativePricingEntryIdBrand: unique symbol;
export type IndicativePricingEntryId = EntityId & {
  readonly [indicativePricingEntryIdBrand]: "IndicativePricingEntryId";
};

/**
 * Optional, non-binding profile information. It is deliberately separate from
 * Quote and Job commercial state and never represents an agreed total.
 */
export interface IndicativePricingEntry {
  readonly id: IndicativePricingEntryId;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly craftsmanProfessionId: CraftsmanProfessionId | null;
  readonly serviceName: string;
  readonly priceMode: IndicativePriceMode;
  /** Exact integer minor units avoid floating-point and rounding ambiguity. */
  readonly amountCents: number;
  readonly currency: "EUR";
  readonly note: string | null;
  readonly state: IndicativePricingEntryState;
  readonly revision: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly archivedAt: Date | null;
}

export interface AddIndicativePricingEntryInput {
  readonly commandId: string;
  readonly entryId: IndicativePricingEntryId;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly actorUserId: UserId;
  readonly craftsmanProfessionId?: CraftsmanProfessionId | null;
  readonly serviceName: string;
  readonly priceMode: IndicativePriceMode;
  readonly amountCents: number;
  readonly note?: string | null;
}

export interface EditIndicativePricingEntryInput {
  readonly commandId: string;
  readonly entryId: IndicativePricingEntryId;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly actorUserId: UserId;
  readonly expectedRevision: number;
  readonly craftsmanProfessionId: CraftsmanProfessionId | null;
  readonly serviceName: string;
  readonly priceMode: IndicativePriceMode;
  readonly amountCents: number;
  readonly note: string | null;
}

export interface ArchiveIndicativePricingEntryInput {
  readonly commandId: string;
  readonly entryId: IndicativePricingEntryId;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly actorUserId: UserId;
  readonly expectedRevision: number;
}

export type AddIndicativePricingEntryResult = Readonly<
  | {
      status: "APPLIED" | "DEDUPLICATED";
      entry: IndicativePricingEntry;
    }
  | {
      status:
        | "PROFILE_UNAVAILABLE"
        | "PROFESSION_UNAVAILABLE"
        | "ENTRY_ALREADY_EXISTS";
    }
>;

export type EditIndicativePricingEntryResult = Readonly<
  | {
      status: "APPLIED" | "DEDUPLICATED";
      entry: IndicativePricingEntry;
    }
  | {
      status:
        | "PROFILE_UNAVAILABLE"
        | "ENTRY_UNAVAILABLE"
        | "ENTRY_ARCHIVED"
        | "PROFESSION_UNAVAILABLE"
        | "STALE_REVISION"
        | "UNCHANGED";
    }
>;

export type ArchiveIndicativePricingEntryResult = Readonly<
  | {
      status: "APPLIED" | "DEDUPLICATED";
      entry: IndicativePricingEntry;
    }
  | {
      status:
        | "PROFILE_UNAVAILABLE"
        | "ENTRY_UNAVAILABLE"
        | "ENTRY_ARCHIVED"
        | "STALE_REVISION";
    }
>;

export interface IndicativePricingPersistence {
  add(
    input: AddIndicativePricingEntryInput,
  ): Promise<AddIndicativePricingEntryResult>;
  edit(
    input: EditIndicativePricingEntryInput,
  ): Promise<EditIndicativePricingEntryResult>;
  archive(
    input: ArchiveIndicativePricingEntryInput,
  ): Promise<ArchiveIndicativePricingEntryResult>;
  listOwned(input: {
    readonly actorUserId: UserId;
    readonly craftsmanProfileId: CraftsmanProfileId;
    readonly includeArchived?: boolean;
  }): Promise<readonly IndicativePricingEntry[]>;
}

export type IndicativePricingService = IndicativePricingPersistence;

export class IndicativePricingValidationError extends TypeError {
  readonly code = "INVALID_INDICATIVE_PRICING_COMMAND";
}

export function createIndicativePricingService(
  persistence: IndicativePricingPersistence,
): IndicativePricingService {
  return Object.freeze({
    add(input: AddIndicativePricingEntryInput) {
      return persistence.add(normalizeAddInput(input));
    },
    edit(input: EditIndicativePricingEntryInput) {
      return persistence.edit(normalizeEditInput(input));
    },
    archive(input: ArchiveIndicativePricingEntryInput) {
      assertCommonIdentity(input);
      assertPositiveRevision(input.expectedRevision);
      return persistence.archive(Object.freeze({ ...input }));
    },
    listOwned(input: {
      readonly actorUserId: UserId;
      readonly craftsmanProfileId: CraftsmanProfileId;
      readonly includeArchived?: boolean;
    }) {
      assertUuid(input.actorUserId, "actorUserId");
      assertUuid(input.craftsmanProfileId, "craftsmanProfileId");
      if (
        input.includeArchived !== undefined &&
        typeof input.includeArchived !== "boolean"
      ) {
        throw invalid("includeArchived");
      }
      return persistence.listOwned(
        Object.freeze({
          actorUserId: input.actorUserId,
          craftsmanProfileId: input.craftsmanProfileId,
          includeArchived: input.includeArchived ?? false,
        }),
      );
    },
  });
}

export function assertNormalizedAddIndicativePricingEntryInput(
  input: AddIndicativePricingEntryInput,
): void {
  assertCommonIdentity(input);
  assertOptionalProfessionId(input.craftsmanProfessionId);
  assertNormalizedPricingFields(input);
}

export function assertNormalizedEditIndicativePricingEntryInput(
  input: EditIndicativePricingEntryInput,
): void {
  assertCommonIdentity(input);
  assertPositiveRevision(input.expectedRevision);
  assertOptionalProfessionId(input.craftsmanProfessionId);
  assertNormalizedPricingFields(input);
}

export function assertArchiveIndicativePricingEntryInput(
  input: ArchiveIndicativePricingEntryInput,
): void {
  assertCommonIdentity(input);
  assertPositiveRevision(input.expectedRevision);
}

export function assertIndicativePricingListInput(input: {
  readonly actorUserId: UserId;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly includeArchived?: boolean;
}): void {
  assertUuid(input.actorUserId, "actorUserId");
  assertUuid(input.craftsmanProfileId, "craftsmanProfileId");
  if (
    input.includeArchived !== undefined &&
    typeof input.includeArchived !== "boolean"
  ) {
    throw invalid("includeArchived");
  }
}

function normalizeAddInput(
  input: AddIndicativePricingEntryInput,
): AddIndicativePricingEntryInput {
  assertCommonIdentity(input);
  assertOptionalProfessionId(input.craftsmanProfessionId);
  return Object.freeze({
    actorUserId: input.actorUserId,
    amountCents: normalizeAmount(input.amountCents),
    commandId: input.commandId,
    craftsmanProfessionId: input.craftsmanProfessionId ?? null,
    craftsmanProfileId: input.craftsmanProfileId,
    entryId: input.entryId,
    note: normalizeOptionalText(input.note, "note", 500),
    priceMode: normalizePriceMode(input.priceMode),
    serviceName: normalizeRequiredText(input.serviceName, "serviceName", 160),
  });
}

function normalizeEditInput(
  input: EditIndicativePricingEntryInput,
): EditIndicativePricingEntryInput {
  assertCommonIdentity(input);
  assertPositiveRevision(input.expectedRevision);
  assertOptionalProfessionId(input.craftsmanProfessionId);
  return Object.freeze({
    actorUserId: input.actorUserId,
    amountCents: normalizeAmount(input.amountCents),
    commandId: input.commandId,
    craftsmanProfessionId: input.craftsmanProfessionId,
    craftsmanProfileId: input.craftsmanProfileId,
    entryId: input.entryId,
    expectedRevision: input.expectedRevision,
    note: normalizeOptionalText(input.note, "note", 500),
    priceMode: normalizePriceMode(input.priceMode),
    serviceName: normalizeRequiredText(input.serviceName, "serviceName", 160),
  });
}

function assertCommonIdentity(input: {
  readonly actorUserId: UserId;
  readonly commandId: string;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly entryId: IndicativePricingEntryId;
}): void {
  assertUuid(input.actorUserId, "actorUserId");
  assertUuid(input.commandId, "commandId");
  assertUuid(input.craftsmanProfileId, "craftsmanProfileId");
  assertUuid(input.entryId, "entryId");
}

function assertOptionalProfessionId(
  value: CraftsmanProfessionId | null | undefined,
): void {
  if (value !== null && value !== undefined) {
    assertUuid(value, "craftsmanProfessionId");
  }
}

function assertNormalizedPricingFields(input: {
  readonly amountCents: number;
  readonly note?: string | null;
  readonly priceMode: IndicativePriceMode;
  readonly serviceName: string;
}): void {
  if (normalizeAmount(input.amountCents) !== input.amountCents) {
    throw invalid("amountCents");
  }
  if (normalizePriceMode(input.priceMode) !== input.priceMode) {
    throw invalid("priceMode");
  }
  if (
    normalizeRequiredText(input.serviceName, "serviceName", 160) !==
    input.serviceName
  ) {
    throw invalid("serviceName");
  }
  const normalizedNote = normalizeOptionalText(input.note, "note", 500);
  if (normalizedNote !== (input.note ?? null)) {
    throw invalid("note");
  }
}

function normalizePriceMode(value: unknown): IndicativePriceMode {
  const mode = INDICATIVE_PRICE_MODES.find((candidate) => candidate === value);
  if (mode === undefined) throw invalid("priceMode");
  return mode;
}

function normalizeAmount(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw invalid("amountCents");
  }
  return value;
}

function normalizeRequiredText(
  value: string,
  field: string,
  maxLength: number,
): string {
  const normalized = normalizeOptionalText(value, field, maxLength);
  if (normalized === null) throw invalid(field);
  return normalized;
}

function normalizeOptionalText(
  value: string | null | undefined,
  field: string,
  maxLength: number,
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw invalid(field);
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (normalized.length === 0) return null;
  if (normalized.length > maxLength || hasControlCharacter(normalized)) {
    throw invalid(field);
  }
  assertNoSensitivePublicText(normalized, field);
  return normalized;
}

function assertNoSensitivePublicText(value: string, field: string): void {
  const patterns = [
    /[\p{L}\d._%+-]+@[\p{L}\d.-]+\.[\p{L}]{2,}/iu,
    /@[\p{L}\d_]{2,}/iu,
    /(?:\+|00)?\d(?:[\s()./-]*\d){6,}/u,
    /\b(?:https?:\/\/|www\.)/iu,
    /\b[\p{L}\d][\p{L}\d-]{0,62}(?:\.[\p{L}\d-]{1,63})*\.[\p{L}]{2,24}\b/iu,
    /\b\d{3}\s?\d{2}\b/u,
    /(?:\b(?:adresa|ulica|námestie|trieda|číslo domu|číslo bytu)\b|\b(?:ul|nám)\.)/iu,
    /\b(?:heslo|password|api[ _-]?key|access[ _-]?token|secret|tajný kľúč)\b/iu,
  ];
  if (patterns.some((pattern) => pattern.test(value))) {
    throw invalid(`${field}: public contact, address or secret text`);
  }
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0);
    return point !== undefined && (point <= 31 || point === 127);
  });
}

function assertPositiveRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw invalid("expectedRevision");
  }
}

function assertUuid(value: string, field: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    throw invalid(field);
  }
}

function invalid(field: string): IndicativePricingValidationError {
  return new IndicativePricingValidationError(
    `Invalid indicative pricing command field: ${field}.`,
  );
}
