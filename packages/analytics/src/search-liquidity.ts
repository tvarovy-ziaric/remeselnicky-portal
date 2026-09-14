import { createHash } from "node:crypto";

import {
  SEARCH_ANALYTICS_VERSION,
  type AnalyticsLocationAreaGranularity,
  type AnalyticsResultCountBucket,
  type AnalyticsSearchSortMode,
  type AnalyticsShortlistSizeBucket,
} from "./catalog.js";
import type {
  AnalyticsCaptureResult,
  AnalyticsPort,
  AnalyticsSubject,
} from "./types.js";

export type SearchAnalyticsLocation = Readonly<
  | { scope: "NONE" }
  | {
      /** Indicates that a governed municipality was selected, without exporting it. */
      scope: "MUNICIPALITY_SELECTED";
      /** Optional coarsening must be derived by the trusted server catalog. */
      area?: Readonly<{
        code: string;
        granularity: AnalyticsLocationAreaGranularity;
      }>;
    }
>;

export type SearchAnalyticsAvailability = Readonly<
  | {
      filterUsed: false;
      indicativelyAvailableCount: null;
      timingSupplied: false;
    }
  | {
      filterUsed: boolean;
      indicativelyAvailableCount: SearchLiquidityCountEvidence;
      timingSupplied: true;
    }
>;

export interface RecordSearchExecutedInput {
  readonly analytics: AnalyticsPort;
  readonly availability: SearchAnalyticsAvailability;
  /** Exact total or a server probe proving that at least five candidates exist. */
  readonly eligibleResultCount: SearchLiquidityCountEvidence;
  readonly includeOutsideDeclaredArea: boolean;
  readonly location: SearchAnalyticsLocation;
  readonly professionCode: string;
  readonly searchId: string;
  readonly skillFilterUsed: boolean;
  readonly sortMode: AnalyticsSearchSortMode;
  readonly specializationCode?: string;
  readonly subject: AnalyticsSubject;
}

export interface RecordAppliedShortlistTransitionInput {
  /** Server-authored active membership count after the committed transition. */
  readonly activeShortlistSize: number;
  readonly analytics: AnalyticsPort;
  /** R2-012 command UUID; retries must reuse it. */
  readonly commandId: string;
  readonly state: "ACTIVE" | "REMOVED";
  readonly subject: AnalyticsSubject;
}

export type SearchLiquidityCountEvidence = Readonly<
  { count: number; kind: "EXACT" } | { kind: "AT_LEAST_FIVE" }
>;

/**
 * Records the authoritative first-page liquidity fact after the complete
 * eligible search snapshot succeeds. The helper emits buckets only and cannot
 * accept raw query/location text, coordinates or result identity lists.
 */
export async function recordSearchExecuted(
  input: RecordSearchExecutedInput,
): Promise<AnalyticsCaptureResult> {
  try {
    const locationArea =
      input.location.scope === "MUNICIPALITY_SELECTED" &&
      input.location.area !== undefined
        ? {
            location_area_code: input.location.area.code,
            location_area_granularity: input.location.area.granularity,
          }
        : {};
    const specialization =
      input.specializationCode === undefined
        ? {}
        : { specialization_code: input.specializationCode };

    return await input.analytics.capture({
      event_id: deriveSearchExecutedEventId(input.searchId),
      event_name: "search_executed",
      properties: {
        eligible_result_count_bucket: bucketResultCount(
          input.eligibleResultCount,
        ),
        include_outside_declared_area: input.includeOutsideDeclaredArea,
        indicative_availability_filter: input.availability.filterUsed,
        indicatively_available_count_bucket:
          input.availability.indicativelyAvailableCount === null
            ? "NOT_APPLICABLE"
            : bucketResultCount(input.availability.indicativelyAvailableCount),
        ...locationArea,
        location_scope: input.location.scope,
        profession_code: input.professionCode,
        search_id: input.searchId,
        search_version: SEARCH_ANALYTICS_VERSION,
        skill_filter_used: input.skillFilterUsed,
        sort_mode: input.sortMode,
        ...specialization,
        timing_supplied: input.availability.timingSupplied,
      },
      subject: input.subject,
    });
  } catch {
    return Object.freeze({
      reason: "INVALID_EVENT" as const,
      status: "DROPPED" as const,
    });
  }
}

/**
 * Post-commit R2-012 hook. Call only for an APPLIED command; replay,
 * DEDUPLICATED, UNCHANGED, stale and denied outcomes must never reach it.
 */
export async function recordAppliedShortlistTransition(
  input: RecordAppliedShortlistTransitionInput,
): Promise<AnalyticsCaptureResult> {
  let shortlistSizeBucket: AnalyticsShortlistSizeBucket;
  try {
    if (input.state !== "ACTIVE" && input.state !== "REMOVED") {
      throw new TypeError("analytics shortlist transition state is invalid");
    }
    shortlistSizeBucket = bucketShortlistSize(input.activeShortlistSize);
  } catch {
    return Object.freeze({
      reason: "INVALID_EVENT" as const,
      status: "DROPPED" as const,
    });
  }
  try {
    return await input.analytics.capture({
      event_id: input.commandId,
      event_name:
        input.state === "ACTIVE" ? "shortlist_added" : "shortlist_removed",
      properties: { shortlist_size_bucket: shortlistSizeBucket },
      subject: input.subject,
    });
  } catch {
    return Object.freeze({
      reason: "TRANSPORT_UNAVAILABLE" as const,
      status: "DROPPED" as const,
    });
  }
}

export function bucketResultCount(
  count: SearchLiquidityCountEvidence,
): AnalyticsResultCountBucket {
  if (typeof count !== "object" || count === null || Array.isArray(count)) {
    throw new TypeError("analytics result count evidence is invalid");
  }
  const keys = Object.keys(count);
  if (
    count.kind === "AT_LEAST_FIVE" &&
    keys.length === 1 &&
    keys[0] === "kind"
  ) {
    return "FIVE_PLUS";
  }
  if (
    count.kind === "EXACT" &&
    keys.length === 2 &&
    keys.includes("kind") &&
    keys.includes("count")
  ) {
    return bucketExactResultCount(count.count);
  }
  throw new TypeError(
    "analytics result count requires exact total or at-least-five evidence",
  );
}

function bucketExactResultCount(count: number): AnalyticsResultCountBucket {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new TypeError(
      "analytics result count must be a non-negative integer",
    );
  }
  if (count === 0) return "ZERO";
  return count < 5 ? "ONE_TO_FOUR" : "FIVE_PLUS";
}

export function bucketShortlistSize(
  count: number,
): AnalyticsShortlistSizeBucket {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new TypeError(
      "analytics shortlist size must be a non-negative integer",
    );
  }
  if (count === 0) return "ZERO";
  if (count === 1) return "ONE";
  if (count < 5) return "TWO_TO_FOUR";
  return count < 10 ? "FIVE_TO_NINE" : "TEN_PLUS";
}

function deriveSearchExecutedEventId(searchId: string): string {
  const digest = createHash("sha256")
    .update(`R2_SEARCH_EXECUTED_V1:${searchId}`, "utf8")
    .digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(
    13,
    16,
  )}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}
