import type { QuoteId } from "./quote.js";
import {
  STRUCTURED_QUOTE_DEPOSIT_MODES,
  STRUCTURED_QUOTE_MATERIAL_RESPONSIBILITIES,
  STRUCTURED_QUOTE_MAX_AMOUNT_CENTS,
  STRUCTURED_QUOTE_PRICE_MODES,
  STRUCTURED_QUOTE_VAT_STATUSES,
  type StructuredQuoteDepositMode,
  type StructuredQuoteMaterialResponsibility,
  type StructuredQuotePriceMode,
  type StructuredQuoteVatStatus,
} from "./quote-structured.js";
import type { UserId } from "./user.js";

export interface ExternalPdfQuoteEnvelopeInput {
  readonly currency: "EUR";
  readonly depositAmountCents?: number | null;
  readonly depositMode?: StructuredQuoteDepositMode | null;
  readonly depositPercentageBasisPoints?: number | null;
  readonly estimatedDurationDays?: number | null;
  readonly estimatedStartOn?: string | null;
  readonly materialResponsibility?: StructuredQuoteMaterialResponsibility | null;
  readonly priceMode: StructuredQuotePriceMode;
  readonly providerConfirmedSummaryMatchesPdf: true;
  readonly rangeMaximumCents?: number | null;
  readonly rangeMinimumCents?: number | null;
  readonly totalAmountCents?: number | null;
  readonly validUntil?: Date | null;
  readonly vatStatus: StructuredQuoteVatStatus;
}

export interface ExternalPdfQuoteEnvelope {
  readonly currency: "EUR";
  readonly depositAmountCents: number | null;
  readonly depositMode: StructuredQuoteDepositMode | null;
  readonly depositPercentageBasisPoints: number | null;
  readonly estimatedDurationDays: number | null;
  readonly estimatedStartOn: string | null;
  readonly materialResponsibility: StructuredQuoteMaterialResponsibility | null;
  readonly priceMode: StructuredQuotePriceMode;
  readonly providerConfirmedSummaryMatchesPdf: true;
  readonly rangeMaximumCents: number | null;
  readonly rangeMinimumCents: number | null;
  readonly totalAmountCents: number | null;
  readonly validUntil: Date | null;
  readonly vatStatus: StructuredQuoteVatStatus;
}

export interface ExternalPdfQuoteRevision extends ExternalPdfQuoteEnvelope {
  readonly confirmedAt: Date;
  readonly contentRevision: number;
  readonly pdfAssetId: string;
  readonly pdfDownloadPath: string;
  readonly quoteId: QuoteId;
  readonly quoteRevision: number;
  readonly savedAt: Date;
}

export interface SaveExternalPdfQuoteDraftInput {
  readonly actorUserId: UserId;
  readonly commandId: string;
  readonly envelope: ExternalPdfQuoteEnvelopeInput;
  readonly expectedContentRevision: number;
  readonly pdfAssetId: string;
  readonly quoteId: QuoteId;
  readonly quoteRevision: number;
}

export interface ReadExternalPdfQuoteInput {
  readonly actorUserId: UserId;
  readonly quoteId: QuoteId;
  readonly quoteRevision: number;
}

export type SaveExternalPdfQuoteDraftResult = Readonly<
  | {
      readonly revision: ExternalPdfQuoteRevision;
      readonly status: "DEDUPLICATED" | "SAVED";
    }
  | {
      readonly status:
        "NOT_FOUND" | "PDF_NOT_READY" | "READ_ONLY" | "STALE_REVISION";
    }
>;

export interface ExternalPdfQuotePersistence {
  readOwned(
    input: ReadExternalPdfQuoteInput,
  ): Promise<ExternalPdfQuoteRevision | null>;
  saveDraft(
    input: SaveExternalPdfQuoteDraftInput,
  ): Promise<SaveExternalPdfQuoteDraftResult>;
}

export class ExternalPdfQuoteIdempotencyError extends Error {
  readonly code = "EXTERNAL_PDF_QUOTE_IDEMPOTENCY_CONFLICT";
}

export function normalizeSaveExternalPdfQuoteDraftInput(
  input: SaveExternalPdfQuoteDraftInput,
): SaveExternalPdfQuoteDraftInput {
  assertRecord(input);
  uuid(input.actorUserId, "actorUserId");
  uuid(input.commandId, "commandId");
  uuid(input.pdfAssetId, "pdfAssetId");
  uuid(input.quoteId, "quoteId");
  positive(input.quoteRevision, "quoteRevision");
  if (
    !Number.isSafeInteger(input.expectedContentRevision) ||
    input.expectedContentRevision < 0
  )
    throw invalid("expectedContentRevision");
  return Object.freeze({
    actorUserId: input.actorUserId,
    commandId: input.commandId,
    envelope: normalizeExternalPdfQuoteEnvelope(input.envelope),
    expectedContentRevision: input.expectedContentRevision,
    pdfAssetId: input.pdfAssetId,
    quoteId: input.quoteId,
    quoteRevision: input.quoteRevision,
  });
}

export function normalizeExternalPdfQuoteEnvelope(
  input: ExternalPdfQuoteEnvelopeInput,
): ExternalPdfQuoteEnvelope {
  assertRecord(input);
  if (!STRUCTURED_QUOTE_PRICE_MODES.includes(input.priceMode))
    throw invalid("priceMode");
  if (!STRUCTURED_QUOTE_VAT_STATUSES.includes(input.vatStatus))
    throw invalid("vatStatus");
  if (input.currency !== "EUR") throw invalid("currency");
  if (input.providerConfirmedSummaryMatchesPdf !== true)
    throw invalid("providerConfirmedSummaryMatchesPdf");
  const total = amount(input.totalAmountCents, "totalAmountCents");
  const minimum = amount(input.rangeMinimumCents, "rangeMinimumCents");
  const maximum = amount(input.rangeMaximumCents, "rangeMaximumCents");
  if (
    (input.priceMode === "RANGE" &&
      (total !== null ||
        minimum === null ||
        maximum === null ||
        minimum > maximum)) ||
    (input.priceMode !== "RANGE" &&
      (total === null || minimum !== null || maximum !== null))
  )
    throw invalid("price");
  const depositMode = input.depositMode ?? null;
  if (
    depositMode !== null &&
    !STRUCTURED_QUOTE_DEPOSIT_MODES.includes(depositMode)
  )
    throw invalid("depositMode");
  const depositAmount = amount(input.depositAmountCents, "depositAmountCents");
  const depositPercentage = input.depositPercentageBasisPoints ?? null;
  if (
    depositPercentage !== null &&
    (!Number.isSafeInteger(depositPercentage) ||
      depositPercentage < 1 ||
      depositPercentage > 10_000)
  )
    throw invalid("depositPercentageBasisPoints");
  if (
    (depositMode === "FIXED_AMOUNT" &&
      (depositAmount === null || depositPercentage !== null)) ||
    (depositMode === "PERCENTAGE" &&
      (depositPercentage === null || depositAmount !== null)) ||
    ((depositMode === null || depositMode === "NONE") &&
      (depositAmount !== null || depositPercentage !== null))
  )
    throw invalid("deposit");
  const material = input.materialResponsibility ?? null;
  if (
    material !== null &&
    !STRUCTURED_QUOTE_MATERIAL_RESPONSIBILITIES.includes(material)
  )
    throw invalid("materialResponsibility");
  return Object.freeze({
    currency: "EUR",
    depositAmountCents: depositAmount,
    depositMode,
    depositPercentageBasisPoints: depositPercentage,
    estimatedDurationDays: optionalPositive(
      input.estimatedDurationDays,
      "estimatedDurationDays",
      3_650,
    ),
    estimatedStartOn: dateOnly(input.estimatedStartOn, "estimatedStartOn"),
    materialResponsibility: material,
    priceMode: input.priceMode,
    providerConfirmedSummaryMatchesPdf: true,
    rangeMaximumCents: maximum,
    rangeMinimumCents: minimum,
    totalAmountCents: total,
    validUntil: date(input.validUntil, "validUntil"),
    vatStatus: input.vatStatus,
  });
}

function amount(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > STRUCTURED_QUOTE_MAX_AMOUNT_CENTS
  )
    throw invalid(field);
  return value as number;
}
function optionalPositive(
  value: unknown,
  field: string,
  maximum: number,
): number | null {
  if (value === undefined || value === null) return null;
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > maximum
  )
    throw invalid(field);
  return value as number;
}
function date(value: unknown, field: string): Date | null {
  if (value === undefined || value === null) return null;
  if (!(value instanceof Date) || !Number.isFinite(value.valueOf()))
    throw invalid(field);
  return new Date(value);
}
function dateOnly(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value
  )
    throw invalid(field);
  return value;
}
function assertRecord(
  value: unknown,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw invalid("input");
}
function uuid(value: unknown, field: string): void {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  )
    throw invalid(field);
}
function positive(value: unknown, field: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw invalid(field);
}
function invalid(field: string): TypeError {
  return new TypeError(`Invalid external PDF Quote field: ${field}.`);
}
