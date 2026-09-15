import type { JobRequestId } from "./job-request.js";
import type { QuoteAuthoringMode, QuoteId } from "./quote.js";
import {
  STRUCTURED_QUOTE_DEPOSIT_MODES,
  STRUCTURED_QUOTE_MATERIAL_RESPONSIBILITIES,
  STRUCTURED_QUOTE_MAX_AMOUNT_CENTS,
  STRUCTURED_QUOTE_PRICE_MODES,
  STRUCTURED_QUOTE_SCOPE_ITEM_LIMIT,
  STRUCTURED_QUOTE_VAT_STATUSES,
  type StructuredQuoteDepositMode,
  type StructuredQuoteMaterialResponsibility,
  type StructuredQuotePriceMode,
  type StructuredQuoteVatStatus,
} from "./quote-structured.js";
import type { UserId } from "./user.js";
import { evaluateConversationMessagePolicy } from "./conversation-message-policy.js";

export const QUOTE_COMPARISON_SORTS = Object.freeze([
  "RECEIVED",
  "LOWEST_COMPARABLE_PRICE",
] as const);
export const QUOTE_COMPARISON_MAX_ITEMS = 5;
export const QUOTE_COMPARISON_MISSING_LABEL = "Neuvedené" as const;

export type QuoteComparisonSort = (typeof QUOTE_COMPARISON_SORTS)[number];

export interface QuoteComparisonReadInput {
  readonly actorUserId: UserId;
  readonly jobRequestId: JobRequestId;
  readonly sort?: QuoteComparisonSort;
}

export interface QuoteComparisonProvider {
  readonly approvedCredentialCount: number;
  readonly displayName: string;
  readonly identityVerified: boolean;
}

export interface QuoteComparisonPrice {
  readonly currency: "EUR";
  readonly mode: StructuredQuotePriceMode;
  readonly rangeMaximumCents: number | null;
  readonly rangeMinimumCents: number | null;
  readonly totalAmountCents: number | null;
  readonly vatStatus: StructuredQuoteVatStatus;
}

export interface QuoteComparisonDeposit {
  readonly amountCents: number | null;
  readonly mode: StructuredQuoteDepositMode | null;
  readonly percentageBasisPoints: number | null;
}

export interface QuoteComparisonComponent {
  readonly amountCents: number | null;
  readonly description: string | null;
}

export interface QuoteComparisonStructuredDetails {
  readonly components: Readonly<{
    readonly labor: QuoteComparisonComponent;
    readonly material: QuoteComparisonComponent;
    readonly other: QuoteComparisonComponent;
  }>;
  readonly depositNotes: string | null;
  readonly priceBasis: string;
  readonly providerNotes: string | null;
  readonly summary: string;
  readonly title: string;
}

export interface QuoteComparisonCard {
  readonly authoringEligible: boolean;
  readonly authoringMode: QuoteAuthoringMode;
  readonly conditionalOnInspection: boolean | null;
  readonly conversationPath: string;
  readonly deposit: QuoteComparisonDeposit;
  readonly details: QuoteComparisonStructuredDetails | null;
  readonly estimatedDurationDays: number | null;
  readonly estimatedStartOn: string | null;
  readonly excludedScope: readonly string[] | null;
  readonly includedScope: readonly string[] | null;
  readonly inspectionConditions: string | null;
  readonly materialResponsibility: StructuredQuoteMaterialResponsibility | null;
  readonly lifecycleAcceptanceEligible: boolean;
  readonly materiallyStale: boolean;
  readonly pdfDownloadPath: string | null;
  readonly price: QuoteComparisonPrice;
  readonly provider: QuoteComparisonProvider;
  readonly quoteId: QuoteId;
  readonly quoteRevision: number;
  readonly submittedAt: string;
  readonly travelAmountCents: number | null;
  readonly travelDescription: string | null;
  readonly validUntil: string | null;
  readonly warrantyInformation: string | null;
}

export interface QuoteComparison {
  readonly items: readonly QuoteComparisonCard[];
  readonly jobRequestId: JobRequestId;
  readonly sort: QuoteComparisonSort;
}

export interface QuoteComparisonPersistence {
  readCurrent(input: QuoteComparisonReadInput): Promise<QuoteComparison | null>;
}

export class QuoteComparisonIntegrityError extends Error {
  readonly code = "QUOTE_COMPARISON_INTEGRITY";
}

export function normalizeQuoteComparisonReadInput(
  input: QuoteComparisonReadInput,
): Required<QuoteComparisonReadInput> {
  record(input, "input");
  uuid(input.actorUserId, "actorUserId");
  uuid(input.jobRequestId, "jobRequestId");
  const sort = input.sort ?? "RECEIVED";
  if (!QUOTE_COMPARISON_SORTS.includes(sort)) invalid("sort");
  return Object.freeze({
    actorUserId: input.actorUserId,
    jobRequestId: input.jobRequestId,
    sort,
  });
}

/** Strict public/private-boundary parser: unknown keys or malformed facts fail closed. */
export function serializeQuoteComparison(value: unknown): QuoteComparison {
  record(value, "comparison");
  exactKeys(value, ["items", "jobRequestId", "sort"], "comparison");
  uuid(value.jobRequestId, "jobRequestId");
  if (!QUOTE_COMPARISON_SORTS.includes(value.sort as QuoteComparisonSort)) {
    invalid("sort");
  }
  if (
    !Array.isArray(value.items) ||
    value.items.length > QUOTE_COMPARISON_MAX_ITEMS
  ) {
    invalid("items");
  }
  const items = value.items.map(parseCard);
  if (new Set(items.map((item) => item.quoteId)).size !== items.length) {
    invalid("items");
  }
  return Object.freeze({
    items: Object.freeze(
      sortQuoteComparisonCards(items, value.sort as QuoteComparisonSort),
    ),
    jobRequestId: value.jobRequestId as JobRequestId,
    sort: value.sort as QuoteComparisonSort,
  });
}

export function sortQuoteComparisonCards(
  cards: readonly QuoteComparisonCard[],
  sort: QuoteComparisonSort,
): readonly QuoteComparisonCard[] {
  const neutral = [...cards].sort(compareNeutral);
  if (sort === "RECEIVED") return Object.freeze(neutral);
  const priced = neutral.filter((card) => comparableTotal(card) !== null);
  const tail = neutral.filter((card) => comparableTotal(card) === null);
  priced.sort((left, right) => {
    const leftAmount = comparableTotal(left) as number;
    const rightAmount = comparableTotal(right) as number;
    return leftAmount - rightAmount || compareNeutral(left, right);
  });
  return Object.freeze([...priced, ...tail]);
}

function comparableTotal(card: QuoteComparisonCard): number | null {
  return card.price.mode === "FIXED" && card.price.vatStatus !== "VAT_EXCLUDED"
    ? card.price.totalAmountCents
    : null;
}

function compareNeutral(
  left: QuoteComparisonCard,
  right: QuoteComparisonCard,
): number {
  return (
    codePointCompare(left.submittedAt, right.submittedAt) ||
    codePointCompare(left.quoteId, right.quoteId)
  );
}

function parseCard(value: unknown): QuoteComparisonCard {
  record(value, "item");
  exactKeys(
    value,
    [
      "authoringMode",
      "authoringEligible",
      "conditionalOnInspection",
      "conversationPath",
      "deposit",
      "details",
      "estimatedDurationDays",
      "estimatedStartOn",
      "excludedScope",
      "includedScope",
      "inspectionConditions",
      "materialResponsibility",
      "lifecycleAcceptanceEligible",
      "materiallyStale",
      "pdfDownloadPath",
      "price",
      "provider",
      "quoteId",
      "quoteRevision",
      "submittedAt",
      "travelAmountCents",
      "travelDescription",
      "validUntil",
      "warrantyInformation",
    ],
    "item",
  );
  if (
    value.authoringMode !== "PLATFORM_STRUCTURED" &&
    value.authoringMode !== "EXTERNAL_PDF"
  )
    invalid("authoringMode");
  if (typeof value.authoringEligible !== "boolean")
    invalid("authoringEligible");
  if (typeof value.lifecycleAcceptanceEligible !== "boolean")
    invalid("lifecycleAcceptanceEligible");
  if (typeof value.materiallyStale !== "boolean") invalid("materiallyStale");
  if (
    value.lifecycleAcceptanceEligible &&
    (value.materiallyStale || !value.authoringEligible)
  )
    invalid("lifecycleAcceptanceEligible");
  uuid(value.quoteId, "quoteId");
  positive(value.quoteRevision, "quoteRevision", Number.MAX_SAFE_INTEGER);
  const submittedAt = timestamp(value.submittedAt, "submittedAt");
  const provider = parseProvider(value.provider);
  const price = parsePrice(value.price);
  const deposit = parseDeposit(value.deposit);
  const details = value.details === null ? null : parseDetails(value.details);
  const includedScope = textArray(value.includedScope, "includedScope");
  const excludedScope = textArray(value.excludedScope, "excludedScope");
  const conditional = nullableBoolean(
    value.conditionalOnInspection,
    "conditionalOnInspection",
  );
  const inspection = nullableText(
    value.inspectionConditions,
    "inspectionConditions",
    1_000,
  );
  if (conditional === true && inspection === null)
    invalid("inspectionConditions");
  if ((conditional === false || conditional === null) && inspection !== null)
    invalid("inspectionConditions");
  const material = value.materialResponsibility;
  if (
    material !== null &&
    !STRUCTURED_QUOTE_MATERIAL_RESPONSIBILITIES.includes(
      material as StructuredQuoteMaterialResponsibility,
    )
  )
    invalid("materialResponsibility");
  const pdfPath = nullablePath(value.pdfDownloadPath, "pdfDownloadPath");
  if ((value.authoringMode === "EXTERNAL_PDF") !== (pdfPath !== null))
    invalid("pdfDownloadPath");
  if (
    value.authoringMode === "EXTERNAL_PDF" &&
    (conditional !== null ||
      includedScope !== null ||
      excludedScope !== null ||
      inspection !== null ||
      value.travelAmountCents !== null ||
      value.travelDescription !== null ||
      value.warrantyInformation !== null ||
      details !== null)
  )
    invalid("authoringMode");
  if (
    value.authoringMode === "PLATFORM_STRUCTURED" &&
    (conditional === null ||
      includedScope === null ||
      excludedScope === null ||
      material === null ||
      details === null)
  )
    invalid("authoringMode");
  if (typeof value.conversationPath !== "string") invalid("conversationPath");
  const conversationMatch = /^\/konverzacie\/pozvanka\/([^/]+)$/u.exec(
    value.conversationPath,
  );
  if (conversationMatch === null) invalid("conversationPath");
  uuid(conversationMatch[1], "conversationPath");
  return Object.freeze({
    authoringEligible: value.authoringEligible,
    authoringMode: value.authoringMode,
    conditionalOnInspection: conditional,
    conversationPath: value.conversationPath,
    deposit,
    details,
    estimatedDurationDays: nullablePositive(
      value.estimatedDurationDays,
      "estimatedDurationDays",
      3_650,
    ),
    estimatedStartOn: dateOnly(value.estimatedStartOn, "estimatedStartOn"),
    excludedScope,
    includedScope,
    inspectionConditions: inspection,
    materialResponsibility:
      material as StructuredQuoteMaterialResponsibility | null,
    lifecycleAcceptanceEligible: value.lifecycleAcceptanceEligible,
    materiallyStale: value.materiallyStale,
    pdfDownloadPath: pdfPath,
    price,
    provider,
    quoteId: value.quoteId as QuoteId,
    quoteRevision: value.quoteRevision as number,
    submittedAt,
    travelAmountCents: nullableAmount(
      value.travelAmountCents,
      "travelAmountCents",
      true,
    ),
    travelDescription: nullableText(
      value.travelDescription,
      "travelDescription",
      1_000,
    ),
    validUntil: nullableTimestamp(value.validUntil, "validUntil"),
    warrantyInformation: nullableText(
      value.warrantyInformation,
      "warrantyInformation",
      1_000,
    ),
  });
}

function parseProvider(value: unknown): QuoteComparisonProvider {
  record(value, "provider");
  exactKeys(
    value,
    ["approvedCredentialCount", "displayName", "identityVerified"],
    "provider",
  );
  if (
    typeof value.displayName !== "string" ||
    value.displayName.trim() !== value.displayName ||
    [...value.displayName].length < 1 ||
    [...value.displayName].length > 200
  )
    invalid("displayName");
  if (
    evaluateConversationMessagePolicy({
      body: value.displayName,
      stage: "PRE_CONFIRM",
    }).status !== "ALLOW"
  )
    invalid("displayName");
  if (typeof value.identityVerified !== "boolean") invalid("identityVerified");
  if (
    !Number.isSafeInteger(value.approvedCredentialCount) ||
    (value.approvedCredentialCount as number) < 0 ||
    (value.approvedCredentialCount as number) > 1_000
  )
    invalid("approvedCredentialCount");
  return Object.freeze({
    approvedCredentialCount: value.approvedCredentialCount as number,
    displayName: value.displayName,
    identityVerified: value.identityVerified,
  });
}

function parsePrice(value: unknown): QuoteComparisonPrice {
  record(value, "price");
  exactKeys(
    value,
    [
      "currency",
      "mode",
      "rangeMaximumCents",
      "rangeMinimumCents",
      "totalAmountCents",
      "vatStatus",
    ],
    "price",
  );
  if (
    value.currency !== "EUR" ||
    !STRUCTURED_QUOTE_PRICE_MODES.includes(
      value.mode as StructuredQuotePriceMode,
    ) ||
    !STRUCTURED_QUOTE_VAT_STATUSES.includes(
      value.vatStatus as StructuredQuoteVatStatus,
    )
  )
    invalid("price");
  const total = nullableAmount(
    value.totalAmountCents,
    "totalAmountCents",
    false,
  );
  const minimum = nullableAmount(
    value.rangeMinimumCents,
    "rangeMinimumCents",
    false,
  );
  const maximum = nullableAmount(
    value.rangeMaximumCents,
    "rangeMaximumCents",
    false,
  );
  if (
    (value.mode === "RANGE" &&
      (total !== null ||
        minimum === null ||
        maximum === null ||
        minimum > maximum)) ||
    (value.mode !== "RANGE" &&
      (total === null || minimum !== null || maximum !== null))
  )
    invalid("price");
  return Object.freeze({
    currency: "EUR",
    mode: value.mode as StructuredQuotePriceMode,
    rangeMaximumCents: maximum,
    rangeMinimumCents: minimum,
    totalAmountCents: total,
    vatStatus: value.vatStatus as StructuredQuoteVatStatus,
  });
}

function parseDeposit(value: unknown): QuoteComparisonDeposit {
  record(value, "deposit");
  exactKeys(value, ["amountCents", "mode", "percentageBasisPoints"], "deposit");
  const mode = value.mode;
  if (
    mode !== null &&
    !STRUCTURED_QUOTE_DEPOSIT_MODES.includes(mode as StructuredQuoteDepositMode)
  )
    invalid("deposit");
  const amount = nullableAmount(
    value.amountCents,
    "deposit.amountCents",
    false,
  );
  const percentage = nullablePositive(
    value.percentageBasisPoints,
    "deposit.percentageBasisPoints",
    10_000,
  );
  if (
    (mode === "FIXED_AMOUNT" && (amount === null || percentage !== null)) ||
    (mode === "PERCENTAGE" && (amount !== null || percentage === null)) ||
    ((mode === null || mode === "NONE") &&
      (amount !== null || percentage !== null))
  )
    invalid("deposit");
  return Object.freeze({
    amountCents: amount,
    mode: mode as StructuredQuoteDepositMode | null,
    percentageBasisPoints: percentage,
  });
}

function parseDetails(value: unknown): QuoteComparisonStructuredDetails {
  record(value, "details");
  exactKeys(
    value,
    [
      "components",
      "depositNotes",
      "priceBasis",
      "providerNotes",
      "summary",
      "title",
    ],
    "details",
  );
  record(value.components, "components");
  exactKeys(value.components, ["labor", "material", "other"], "components");
  return Object.freeze({
    components: Object.freeze({
      labor: parseComponent(value.components.labor, "labor"),
      material: parseComponent(value.components.material, "material"),
      other: parseComponent(value.components.other, "other"),
    }),
    depositNotes: nullableText(value.depositNotes, "depositNotes", 500),
    priceBasis: requiredText(value.priceBasis, "priceBasis", 500),
    providerNotes: nullableText(value.providerNotes, "providerNotes", 2_000),
    summary: requiredText(value.summary, "summary", 1_000),
    title: requiredText(value.title, "title", 160),
  });
}

function parseComponent(
  value: unknown,
  field: string,
): QuoteComparisonComponent {
  record(value, field);
  exactKeys(value, ["amountCents", "description"], field);
  return Object.freeze({
    amountCents: nullableAmount(
      value.amountCents,
      `${field}.amountCents`,
      true,
    ),
    description: nullableText(value.description, `${field}.description`, 1_000),
  });
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  field: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  )
    invalid(field);
}
function record(
  value: unknown,
  field: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    invalid(field);
}
function uuid(value: unknown, field: string): void {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  )
    invalid(field);
}
function positive(value: unknown, field: string, maximum: number): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > maximum
  )
    invalid(field);
  return value as number;
}
function nullablePositive(
  value: unknown,
  field: string,
  maximum: number,
): number | null {
  return value === null ? null : positive(value, field, maximum);
}
function nullableAmount(
  value: unknown,
  field: string,
  allowZero: boolean,
): number | null {
  if (value === null) return null;
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < (allowZero ? 0 : 1) ||
    (value as number) > STRUCTURED_QUOTE_MAX_AMOUNT_CENTS
  )
    invalid(field);
  return value as number;
}
function nullableBoolean(value: unknown, field: string): boolean | null {
  if (value !== null && typeof value !== "boolean") invalid(field);
  return value;
}
function nullableText(
  value: unknown,
  field: string,
  maximum: number,
): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    [...value].length < 1 ||
    [...value].length > maximum ||
    [...value].some((character) => {
      const code = character.codePointAt(0);
      return (
        code !== undefined &&
        (code < 32 || code === 127) &&
        code !== 9 &&
        code !== 10
      );
    })
  )
    invalid(field);
  return value;
}
function requiredText(value: unknown, field: string, maximum: number): string {
  return nullableText(value, field, maximum) ?? invalid(field);
}
function textArray(value: unknown, field: string): readonly string[] | null {
  if (value === null) return null;
  if (
    !Array.isArray(value) ||
    value.length > STRUCTURED_QUOTE_SCOPE_ITEM_LIMIT ||
    Object.keys(value).length !== value.length
  )
    invalid(field);
  return Object.freeze(
    value.map((item) => nullableText(item, field, 300) ?? invalid(field)),
  );
}
function dateOnly(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value))
    invalid(field);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(parsed.valueOf()) ||
    parsed.toISOString().slice(0, 10) !== value
  )
    invalid(field);
  return value;
}
function timestamp(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    invalid(field);
  return value;
}
function nullableTimestamp(value: unknown, field: string): string | null {
  return value === null ? null : timestamp(value, field);
}
function nullablePath(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") invalid(field);
  const match = /^\/v1\/media\/([^/]+)\/download$/u.exec(value);
  if (match === null) invalid(field);
  uuid(match[1], field);
  return value;
}
function codePointCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function invalid(field: string): never {
  throw new QuoteComparisonIntegrityError(
    `Invalid Quote comparison field: ${field}.`,
  );
}
