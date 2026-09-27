import {
  buildAlphaAnalyticsDashboard,
  type AlphaAnalyticsDashboard,
  type AlphaAnalyticsTrafficClass,
  type AlphaRequestJourneyFact,
  type AlphaResultCountBucket,
  type AlphaSearchLiquidityFact,
  type AlphaSupplyFact,
} from "@portal/analytics";
import type { Sql, TransactionSql } from "postgres";

type RootSql = Sql | TransactionSql;

export interface AlphaAnalyticsDashboardQuery {
  readonly from: Date;
  readonly to: Date;
}

export interface AlphaSearchFactInput {
  readonly actorUserId?: string;
  readonly candidateCount: number;
  readonly professionCode: string;
  readonly regionCode?: string;
  readonly resultCountBucket: AlphaResultCountBucket;
  readonly searchId: string;
}

export interface AlphaAnalyticsDashboardRepository {
  load(query: AlphaAnalyticsDashboardQuery): Promise<AlphaAnalyticsDashboard>;
  recordProfileOpen(searchId: string): Promise<"RECORDED" | "UNCHANGED">;
  recordSearch(input: AlphaSearchFactInput): Promise<"RECORDED" | "UNCHANGED">;
}

interface RequestRow {
  readonly changeOrderCount: number;
  readonly completedAt: Date | null;
  readonly completionAttemptCount: number;
  readonly confirmedAt: Date | null;
  readonly disputeCount: number;
  readonly firstEngagedAt: Date | null;
  readonly firstQuoteAt: Date | null;
  readonly invitationCount: number;
  readonly jobId: string | null;
  readonly professionCode: string;
  readonly quoteCount: number;
  readonly regionCode: string | null;
  readonly reportCount: number;
  readonly requestId: string;
  readonly reviewedAt: Date | null;
  readonly startedAt: Date | null;
  readonly submittedAt: Date;
  readonly trafficClass: AlphaAnalyticsTrafficClass;
}

interface SearchRow {
  readonly candidateCount: number;
  readonly occurredAt: Date;
  readonly professionCode: string;
  readonly profileOpened: boolean;
  readonly regionCode: string | null;
  readonly resultCountBucket: AlphaResultCountBucket;
  readonly searchId: string;
  readonly trafficClass: AlphaAnalyticsTrafficClass;
}

interface SupplyRow {
  readonly completedJobCount: number;
  readonly craftsmanProfileId: string;
  readonly engagedCount: number;
  readonly invitationCount: number;
  readonly professionCode: string;
  readonly quoteCount: number;
  readonly regionCode: string | null;
  readonly trafficClass: AlphaAnalyticsTrafficClass;
  readonly wonJobCount: number;
}

interface SearchIdentityRow {
  readonly actorUserId: string | null;
  readonly candidateCount: number;
  readonly professionCode: string;
  readonly regionCode: string | null;
  readonly resultCountBucket: AlphaResultCountBucket;
  readonly searchId: string;
}

export function createAlphaAnalyticsDashboardRepository(
  sql: RootSql,
): AlphaAnalyticsDashboardRepository {
  return Object.freeze({
    async load(query: AlphaAnalyticsDashboardQuery) {
      validRange(query);
      const [requestRows, searchRows, supplyRows] = await Promise.all([
        sql<RequestRow[]>`
          SELECT request_id AS "requestId", traffic_class AS "trafficClass",
            submitted_at AS "submittedAt",
            profession_code AS "professionCode", region_code AS "regionCode",
            first_engaged_at AS "firstEngagedAt",
            first_quote_at AS "firstQuoteAt", quote_count AS "quoteCount",
            job_id AS "jobId", confirmed_at AS "confirmedAt",
            started_at AS "startedAt", completed_at AS "completedAt",
            reviewed_at AS "reviewedAt",
            invitation_count AS "invitationCount",
            completion_attempt_count AS "completionAttemptCount",
            change_order_count AS "changeOrderCount",
            dispute_count AS "disputeCount", report_count AS "reportCount"
          FROM r4_alpha_request_journey_facts
          WHERE submitted_at >= ${query.from} AND submitted_at < ${query.to}
          ORDER BY submitted_at, request_id
        `,
        sql<SearchRow[]>`
          SELECT search_id AS "searchId", traffic_class AS "trafficClass",
            occurred_at AS "occurredAt", profession_code AS "professionCode",
            region_code AS "regionCode",
            result_count_bucket AS "resultCountBucket",
            profile_opened AS "profileOpened",
            candidate_count AS "candidateCount"
          FROM r4_alpha_search_liquidity_facts
          WHERE occurred_at >= ${query.from} AND occurred_at < ${query.to}
          ORDER BY occurred_at, search_id
        `,
        sql<SupplyRow[]>`
          SELECT craftsman_profile_id AS "craftsmanProfileId",
            traffic_class AS "trafficClass",
            profession_code AS "professionCode", region_code AS "regionCode",
            invitation_count AS "invitationCount",
            engaged_count AS "engagedCount", quote_count AS "quoteCount",
            won_job_count AS "wonJobCount",
            completed_job_count AS "completedJobCount"
          FROM r4_alpha_supply_facts
          ORDER BY craftsman_profile_id, profession_code, region_code
        `,
      ]);
      return buildAlphaAnalyticsDashboard({
        generated_at: query.to.toISOString(),
        requests: requestRows.map(toRequestFact),
        searches: searchRows.map(toSearchFact),
        supply: supplyRows.map(toSupplyFact),
      });
    },
    async recordSearch(input: AlphaSearchFactInput) {
      assertUuid(input.searchId, "searchId");
      if (input.actorUserId !== undefined) {
        assertUuid(input.actorUserId, "actorUserId");
      }
      const inserted = await sql<SearchIdentityRow[]>`
        INSERT INTO r4_analytics_search_facts (
          search_id, actor_user_id, traffic_class, profession_code,
          region_code, result_count_bucket, candidate_count
        ) VALUES (
          ${input.searchId}, ${input.actorUserId ?? null}, 'REAL',
          ${input.professionCode}, ${input.regionCode ?? null},
          ${input.resultCountBucket}, ${input.candidateCount}
        ) ON CONFLICT (search_id) DO NOTHING
        RETURNING search_id AS "searchId", actor_user_id AS "actorUserId",
          profession_code AS "professionCode", region_code AS "regionCode",
          result_count_bucket AS "resultCountBucket",
          candidate_count AS "candidateCount"
      `;
      if (inserted.length === 1) return "RECORDED";
      const [existing] = await sql<SearchIdentityRow[]>`
        SELECT search_id AS "searchId", actor_user_id AS "actorUserId",
          profession_code AS "professionCode", region_code AS "regionCode",
          result_count_bucket AS "resultCountBucket",
          candidate_count AS "candidateCount"
        FROM r4_analytics_search_facts WHERE search_id = ${input.searchId}
      `;
      if (existing === undefined || !sameSearch(existing, input)) {
        throw new TypeError("analytics search_id collision");
      }
      return "UNCHANGED";
    },
    async recordProfileOpen(searchId: string) {
      assertUuid(searchId, "searchId");
      const inserted = await sql<{ readonly searchId: string }[]>`
        INSERT INTO r4_analytics_search_profile_open_facts (search_id)
        VALUES (${searchId}) ON CONFLICT (search_id) DO NOTHING
        RETURNING search_id AS "searchId"
      `;
      return inserted.length === 1 ? "RECORDED" : "UNCHANGED";
    },
  });
}

function toRequestFact(row: RequestRow): AlphaRequestJourneyFact {
  return {
    request_id: row.requestId,
    traffic_class: row.trafficClass,
    submitted_at: row.submittedAt.toISOString(),
    profession_code: row.professionCode,
    ...(row.regionCode === null ? {} : { region_code: row.regionCode }),
    ...(row.firstEngagedAt === null
      ? {}
      : { first_engaged_at: row.firstEngagedAt.toISOString() }),
    ...(row.firstQuoteAt === null
      ? {}
      : { first_quote_at: row.firstQuoteAt.toISOString() }),
    quote_count: row.quoteCount,
    ...(row.jobId === null ? {} : { job_id: row.jobId }),
    ...(row.confirmedAt === null
      ? {}
      : { confirmed_at: row.confirmedAt.toISOString() }),
    ...(row.startedAt === null
      ? {}
      : { started_at: row.startedAt.toISOString() }),
    ...(row.completedAt === null
      ? {}
      : { completed_at: row.completedAt.toISOString() }),
    ...(row.reviewedAt === null
      ? {}
      : { reviewed_at: row.reviewedAt.toISOString() }),
    invitation_count: row.invitationCount,
    completion_attempt_count: row.completionAttemptCount,
    change_order_count: row.changeOrderCount,
    dispute_count: row.disputeCount,
    report_count: row.reportCount,
  };
}

function toSearchFact(row: SearchRow): AlphaSearchLiquidityFact {
  return {
    search_id: row.searchId,
    traffic_class: row.trafficClass,
    occurred_at: row.occurredAt.toISOString(),
    profession_code: row.professionCode,
    ...(row.regionCode === null ? {} : { region_code: row.regionCode }),
    result_count_bucket: row.resultCountBucket,
    profile_opened: row.profileOpened,
    candidate_count: row.candidateCount,
  };
}

function toSupplyFact(row: SupplyRow): AlphaSupplyFact {
  return {
    craftsman_profile_id: row.craftsmanProfileId,
    traffic_class: row.trafficClass,
    profession_code: row.professionCode,
    ...(row.regionCode === null ? {} : { region_code: row.regionCode }),
    invitation_count: row.invitationCount,
    engaged_count: row.engagedCount,
    quote_count: row.quoteCount,
    won_job_count: row.wonJobCount,
    completed_job_count: row.completedJobCount,
  };
}

function validRange(query: AlphaAnalyticsDashboardQuery): void {
  if (
    !Number.isFinite(query.from.getTime()) ||
    !Number.isFinite(query.to.getTime()) ||
    query.from >= query.to
  ) {
    throw new TypeError("analytics dashboard requires a valid half-open range");
  }
}

function sameSearch(
  row: SearchIdentityRow,
  input: AlphaSearchFactInput,
): boolean {
  return (
    row.searchId === input.searchId &&
    row.actorUserId === (input.actorUserId ?? null) &&
    row.professionCode === input.professionCode &&
    row.regionCode === (input.regionCode ?? null) &&
    row.resultCountBucket === input.resultCountBucket &&
    row.candidateCount === input.candidateCount
  );
}

function assertUuid(value: string, name: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    throw new TypeError(`${name} must be a UUID`);
  }
}
