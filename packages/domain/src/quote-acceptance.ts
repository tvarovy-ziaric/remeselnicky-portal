import type { EntityId } from "./index.js";
import type { JobRequestId } from "./job-request.js";
import type { QuoteId } from "./quote.js";
import type { UserId } from "./user.js";

declare const jobIdBrand: unique symbol;
export type JobId = EntityId & { readonly [jobIdBrand]: "JobId" };

export interface QuoteAcceptanceCommandInput {
  readonly actorUserId: UserId;
  readonly commandId: string;
  readonly explicitlyConfirmed: true;
  readonly expectedQuoteStateRevision: number;
  readonly expectedRequestContentRevision: number;
  readonly expectedRequestVisibleVersion: number;
  readonly finalExactAddress?: string;
  readonly jobRequestId: JobRequestId;
  readonly quoteId: QuoteId;
  readonly quoteRevision: number;
}

export type QuoteAcceptanceCommandResult = Readonly<
  | {
      readonly acceptedAt: Date;
      readonly jobId: JobId;
      readonly status: "APPLIED" | "DEDUPLICATED";
    }
  | {
      readonly status:
        "ADDRESS_REQUIRED" | "NOT_ACCEPTABLE" | "NOT_FOUND" | "STALE_REVISION";
    }
>;

export interface QuoteAcceptancePersistence {
  accept(
    input: QuoteAcceptanceCommandInput,
  ): Promise<QuoteAcceptanceCommandResult>;
}

export class QuoteAcceptanceIdempotencyError extends Error {
  readonly code = "QUOTE_ACCEPTANCE_IDEMPOTENCY_CONFLICT";
}

export function assertQuoteAcceptanceCommandInput(
  input: QuoteAcceptanceCommandInput,
): void {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    invalid("input");
  }
  const keys = Object.keys(input).sort();
  const allowed = [
    "actorUserId",
    "commandId",
    "explicitlyConfirmed",
    "expectedQuoteStateRevision",
    "expectedRequestContentRevision",
    "expectedRequestVisibleVersion",
    ...(input.finalExactAddress === undefined ? [] : ["finalExactAddress"]),
    "jobRequestId",
    "quoteId",
    "quoteRevision",
  ].sort();
  if (
    keys.length !== allowed.length ||
    keys.some((key, i) => key !== allowed[i])
  ) {
    invalid("fields");
  }
  for (const key of [
    "actorUserId",
    "commandId",
    "jobRequestId",
    "quoteId",
  ] as const) {
    if (
      typeof input[key] !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        input[key],
      )
    ) {
      invalid(key);
    }
  }
  for (const key of [
    "expectedQuoteStateRevision",
    "expectedRequestContentRevision",
    "expectedRequestVisibleVersion",
    "quoteRevision",
  ] as const) {
    if (!Number.isSafeInteger(input[key]) || input[key] < 1) invalid(key);
  }
  if (input.explicitlyConfirmed !== true) invalid("explicitlyConfirmed");
  if (
    input.finalExactAddress !== undefined &&
    (typeof input.finalExactAddress !== "string" ||
      input.finalExactAddress.trim().length < 1 ||
      input.finalExactAddress.trim().length > 500 ||
      input.finalExactAddress !== input.finalExactAddress.trim())
  )
    invalid("finalExactAddress");
}

function invalid(field: string): never {
  throw new TypeError(`Invalid Quote acceptance field: ${field}.`);
}
