import { evaluateConversationMessagePolicy } from "./conversation-message-policy.js";
import type { QuoteId } from "./quote.js";
import type { UserId } from "./user.js";

export const STRUCTURED_QUOTE_PRICE_MODES = Object.freeze([
  "FIXED",
  "ESTIMATE",
  "RANGE",
] as const);
export const STRUCTURED_QUOTE_VAT_STATUSES = Object.freeze([
  "VAT_INCLUDED",
  "VAT_EXCLUDED",
  "NOT_VAT_REGISTERED",
] as const);
export const STRUCTURED_QUOTE_MATERIAL_RESPONSIBILITIES = Object.freeze([
  "PROVIDER",
  "CUSTOMER",
  "MIXED",
] as const);
export const STRUCTURED_QUOTE_DEPOSIT_MODES = Object.freeze([
  "NONE",
  "FIXED_AMOUNT",
  "PERCENTAGE",
] as const);
export const STRUCTURED_QUOTE_SCOPE_ITEM_LIMIT = 20;
export const STRUCTURED_QUOTE_MAX_AMOUNT_CENTS = 1_000_000_000_000;

export type StructuredQuotePriceMode =
  (typeof STRUCTURED_QUOTE_PRICE_MODES)[number];
export type StructuredQuoteVatStatus =
  (typeof STRUCTURED_QUOTE_VAT_STATUSES)[number];
export type StructuredQuoteMaterialResponsibility =
  (typeof STRUCTURED_QUOTE_MATERIAL_RESPONSIBILITIES)[number];
export type StructuredQuoteDepositMode =
  (typeof STRUCTURED_QUOTE_DEPOSIT_MODES)[number];

export interface StructuredQuoteComponentInput {
  readonly amountCents?: number | null;
  readonly description?: string | null;
}

export interface StructuredQuoteComponent {
  readonly amountCents: number | null;
  readonly description: string | null;
}

export interface StructuredQuoteDraftContentInput {
  readonly components: Readonly<{
    readonly labor?: StructuredQuoteComponentInput;
    readonly material?: StructuredQuoteComponentInput;
    readonly other?: StructuredQuoteComponentInput;
    readonly transport?: StructuredQuoteComponentInput;
  }>;
  readonly conditionalOnInspection: boolean;
  readonly currency: "EUR";
  readonly depositAmountCents?: number | null;
  readonly depositMode?: StructuredQuoteDepositMode | null;
  readonly depositNotes?: string | null;
  readonly depositPercentageBasisPoints?: number | null;
  readonly estimatedDurationDays?: number | null;
  readonly estimatedStartOn?: string | null;
  readonly excludedScope?: readonly string[];
  readonly includedScope?: readonly string[];
  readonly inspectionConditions?: string | null;
  readonly materialResponsibility: StructuredQuoteMaterialResponsibility;
  readonly priceBasis: string;
  readonly priceMode: StructuredQuotePriceMode;
  readonly providerNotes?: string | null;
  readonly rangeMaximumCents?: number | null;
  readonly rangeMinimumCents?: number | null;
  readonly summary: string;
  readonly title: string;
  readonly totalAmountCents?: number | null;
  readonly validUntil?: Date | null;
  readonly vatStatus: StructuredQuoteVatStatus;
  readonly warrantyInformation?: string | null;
}

export interface StructuredQuoteContent extends Omit<
  StructuredQuoteDraftContentInput,
  "components"
> {
  readonly components: Readonly<{
    readonly labor: StructuredQuoteComponent;
    readonly material: StructuredQuoteComponent;
    readonly other: StructuredQuoteComponent;
    readonly transport: StructuredQuoteComponent;
  }>;
  readonly depositAmountCents: number | null;
  readonly depositMode: StructuredQuoteDepositMode | null;
  readonly depositNotes: string | null;
  readonly depositPercentageBasisPoints: number | null;
  readonly estimatedDurationDays: number | null;
  readonly estimatedStartOn: string | null;
  readonly excludedScope: readonly string[];
  readonly includedScope: readonly string[];
  readonly inspectionConditions: string | null;
  readonly providerNotes: string | null;
  readonly rangeMaximumCents: number | null;
  readonly rangeMinimumCents: number | null;
  readonly totalAmountCents: number | null;
  readonly validUntil: Date | null;
  readonly warrantyInformation: string | null;
}

export interface StructuredQuoteContentRevision extends StructuredQuoteContent {
  readonly changedAt: Date;
  readonly contentRevision: number;
  readonly quoteId: QuoteId;
  readonly quoteRevision: number;
}

export interface SaveStructuredQuoteDraftInput {
  readonly actorUserId: UserId;
  readonly commandId: string;
  readonly content: StructuredQuoteDraftContentInput;
  readonly expectedContentRevision: number;
  readonly quoteId: QuoteId;
  readonly quoteRevision: number;
}

export interface ReadStructuredQuoteInput {
  readonly actorUserId: UserId;
  readonly quoteId: QuoteId;
  readonly quoteRevision: number;
}

export type SaveStructuredQuoteDraftResult = Readonly<
  | {
      readonly content: StructuredQuoteContentRevision;
      readonly status: "DEDUPLICATED" | "SAVED";
    }
  | {
      readonly currentContentRevision?: number;
      readonly status: "NOT_FOUND" | "READ_ONLY" | "STALE_REVISION";
    }
>;

export interface StructuredQuotePersistence {
  readOwned(
    input: ReadStructuredQuoteInput,
  ): Promise<StructuredQuoteContentRevision | null>;
  saveDraft(
    input: SaveStructuredQuoteDraftInput,
  ): Promise<SaveStructuredQuoteDraftResult>;
}

export class StructuredQuoteIdempotencyError extends Error {
  readonly code = "STRUCTURED_QUOTE_IDEMPOTENCY_CONFLICT";
}

export function createStructuredQuoteService(input: {
  readonly persistence: StructuredQuotePersistence;
}): StructuredQuotePersistence {
  return Object.freeze({
    readOwned(command: ReadStructuredQuoteInput) {
      assertReadStructuredQuoteInput(command);
      return input.persistence.readOwned(command);
    },
    saveDraft(command: SaveStructuredQuoteDraftInput) {
      const normalized = normalizeSaveStructuredQuoteDraftInput(command);
      return input.persistence.saveDraft(normalized);
    },
  });
}

export function assertReadStructuredQuoteInput(
  input: ReadStructuredQuoteInput,
): void {
  assertRecord(input);
  assertUuid(input.actorUserId, "actorUserId");
  assertUuid(input.quoteId, "quoteId");
  assertPositiveInteger(input.quoteRevision, "quoteRevision");
}

export function normalizeSaveStructuredQuoteDraftInput(
  input: SaveStructuredQuoteDraftInput,
): SaveStructuredQuoteDraftInput {
  assertRecord(input);
  assertUuid(input.actorUserId, "actorUserId");
  assertUuid(input.commandId, "commandId");
  assertUuid(input.quoteId, "quoteId");
  assertPositiveInteger(input.quoteRevision, "quoteRevision");
  if (
    !Number.isSafeInteger(input.expectedContentRevision) ||
    input.expectedContentRevision < 0
  ) {
    throw invalid("expectedContentRevision");
  }
  return Object.freeze({
    actorUserId: input.actorUserId,
    commandId: input.commandId,
    content: normalizeStructuredQuoteContent(input.content),
    expectedContentRevision: input.expectedContentRevision,
    quoteId: input.quoteId,
    quoteRevision: input.quoteRevision,
  });
}

export function normalizeStructuredQuoteContent(
  input: StructuredQuoteDraftContentInput,
): StructuredQuoteContent {
  assertRecord(input);
  assertRecord(input.components);
  if (!STRUCTURED_QUOTE_PRICE_MODES.includes(input.priceMode)) {
    throw invalid("priceMode");
  }
  if (!STRUCTURED_QUOTE_VAT_STATUSES.includes(input.vatStatus)) {
    throw invalid("vatStatus");
  }
  if (
    !STRUCTURED_QUOTE_MATERIAL_RESPONSIBILITIES.includes(
      input.materialResponsibility,
    )
  ) {
    throw invalid("materialResponsibility");
  }
  if (input.currency !== "EUR") throw invalid("currency");
  if (typeof input.conditionalOnInspection !== "boolean") {
    throw invalid("conditionalOnInspection");
  }

  const totalAmountCents = optionalAmount(
    input.totalAmountCents,
    "totalAmountCents",
    false,
  );
  const rangeMinimumCents = optionalAmount(
    input.rangeMinimumCents,
    "rangeMinimumCents",
    false,
  );
  const rangeMaximumCents = optionalAmount(
    input.rangeMaximumCents,
    "rangeMaximumCents",
    false,
  );
  if (
    (input.priceMode === "RANGE" &&
      (totalAmountCents !== null ||
        rangeMinimumCents === null ||
        rangeMaximumCents === null ||
        rangeMinimumCents > rangeMaximumCents)) ||
    (input.priceMode !== "RANGE" &&
      (totalAmountCents === null ||
        rangeMinimumCents !== null ||
        rangeMaximumCents !== null))
  ) {
    throw invalid("price");
  }

  const depositMode = input.depositMode ?? null;
  if (
    depositMode !== null &&
    !STRUCTURED_QUOTE_DEPOSIT_MODES.includes(depositMode)
  ) {
    throw invalid("depositMode");
  }
  const depositAmountCents = optionalAmount(
    input.depositAmountCents,
    "depositAmountCents",
    false,
  );
  const depositPercentageBasisPoints =
    input.depositPercentageBasisPoints ?? null;
  if (
    depositPercentageBasisPoints !== null &&
    (!Number.isSafeInteger(depositPercentageBasisPoints) ||
      depositPercentageBasisPoints <= 0 ||
      depositPercentageBasisPoints > 10_000)
  ) {
    throw invalid("depositPercentageBasisPoints");
  }
  if (
    (depositMode === "FIXED_AMOUNT" &&
      (depositAmountCents === null || depositPercentageBasisPoints !== null)) ||
    (depositMode === "PERCENTAGE" &&
      (depositPercentageBasisPoints === null || depositAmountCents !== null)) ||
    ((depositMode === null || depositMode === "NONE") &&
      (depositAmountCents !== null || depositPercentageBasisPoints !== null))
  ) {
    throw invalid("deposit");
  }

  const inspectionConditions = optionalText(
    input.inspectionConditions,
    "inspectionConditions",
    1_000,
  );
  if (input.conditionalOnInspection && inspectionConditions === null) {
    throw invalid("inspectionConditions");
  }
  if (!input.conditionalOnInspection && inspectionConditions !== null) {
    throw invalid("inspectionConditions");
  }

  const transport = normalizeComponent(input.components.transport, "transport");
  if (transport.amountCents !== null && transport.description === null) {
    throw invalid("transport.description");
  }

  return Object.freeze({
    components: Object.freeze({
      labor: normalizeComponent(input.components.labor, "labor"),
      material: normalizeComponent(input.components.material, "material"),
      other: normalizeComponent(input.components.other, "other"),
      transport,
    }),
    conditionalOnInspection: input.conditionalOnInspection,
    currency: "EUR",
    depositAmountCents,
    depositMode,
    depositNotes: optionalText(input.depositNotes, "depositNotes", 500),
    depositPercentageBasisPoints,
    estimatedDurationDays: optionalPositiveInteger(
      input.estimatedDurationDays,
      "estimatedDurationDays",
      3_650,
    ),
    estimatedStartOn: optionalDateOnly(
      input.estimatedStartOn,
      "estimatedStartOn",
    ),
    excludedScope: normalizeScope(input.excludedScope, "excludedScope"),
    includedScope: normalizeScope(input.includedScope, "includedScope"),
    inspectionConditions,
    materialResponsibility: input.materialResponsibility,
    priceBasis: requiredText(input.priceBasis, "priceBasis", 500),
    priceMode: input.priceMode,
    providerNotes: optionalText(input.providerNotes, "providerNotes", 2_000),
    rangeMaximumCents,
    rangeMinimumCents,
    summary: requiredText(input.summary, "summary", 1_000),
    title: requiredText(input.title, "title", 160),
    totalAmountCents,
    validUntil: optionalDate(input.validUntil, "validUntil"),
    vatStatus: input.vatStatus,
    warrantyInformation: optionalText(
      input.warrantyInformation,
      "warrantyInformation",
      1_000,
    ),
  });
}

function normalizeComponent(
  input: StructuredQuoteComponentInput | undefined,
  field: string,
): StructuredQuoteComponent {
  if (input === undefined) {
    return Object.freeze({ amountCents: null, description: null });
  }
  assertRecord(input);
  const amountCents = optionalAmount(
    input.amountCents,
    `${field}.amountCents`,
    true,
  );
  const description = optionalText(
    input.description,
    `${field}.description`,
    1_000,
  );
  if (amountCents === null && description === null) {
    return Object.freeze({ amountCents: null, description: null });
  }
  return Object.freeze({ amountCents, description });
}

function normalizeScope(
  value: readonly string[] | undefined,
  field: string,
): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (
    !Array.isArray(value) ||
    value.length > STRUCTURED_QUOTE_SCOPE_ITEM_LIMIT ||
    !Array.from({ length: value.length }, (_, index) => index).every((index) =>
      Object.prototype.hasOwnProperty.call(value, index),
    )
  ) {
    throw invalid(field);
  }
  return Object.freeze(
    value.map((item, index) => requiredText(item, `${field}.${index}`, 300)),
  );
}

function requiredText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string") throw invalid(field);
  const normalized = value.replace(/\r\n?/gu, "\n").trim();
  if (
    normalized.length < 1 ||
    [...normalized].length > maximum ||
    !isSafePreConfirmationText(normalized)
  ) {
    throw invalid(field);
  }
  return normalized;
}

function optionalText(
  value: unknown,
  field: string,
  maximum: number,
): string | null {
  if (value === undefined || value === null) return null;
  return requiredText(value, field, maximum);
}

function optionalAmount(
  value: unknown,
  field: string,
  allowZero: boolean,
): number | null {
  if (value === undefined || value === null) return null;
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < (allowZero ? 0 : 1) ||
    (value as number) > STRUCTURED_QUOTE_MAX_AMOUNT_CENTS
  ) {
    throw invalid(field);
  }
  return value as number;
}

function optionalDate(value: unknown, field: string): Date | null {
  if (value === undefined || value === null) return null;
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw invalid(field);
  }
  return new Date(value);
}

function optionalDateOnly(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
    Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)) ||
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value
  ) {
    throw invalid(field);
  }
  return value;
}

function optionalPositiveInteger(
  value: unknown,
  field: string,
  maximum: number,
): number | null {
  if (value === undefined || value === null) return null;
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > maximum
  ) {
    throw invalid(field);
  }
  return value as number;
}

function isSafePreConfirmationText(value: string): boolean {
  if (
    [...value].some((character) => {
      const point = character.codePointAt(0);
      return (
        point !== undefined &&
        ((point < 32 && point !== 9 && point !== 10) || point === 127)
      );
    })
  ) {
    return false;
  }
  return (
    evaluateConversationMessagePolicy({ body: value, stage: "PRE_CONFIRM" })
      .status === "ALLOW"
  );
}

function assertRecord(
  value: unknown,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("input");
  }
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

function assertPositiveInteger(value: unknown, field: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw invalid(field);
  }
}

function invalid(field: string): TypeError {
  return new TypeError(`Invalid structured Quote field: ${field}.`);
}
