import type { Sql, TransactionSql } from "postgres";

import type {
  ChangeOrderPriceImpact,
  ChangeOrderScheduleImpact,
  ChangeOrderTerms,
} from "./change-order-repository.js";
import {
  deriveCurrentCommercialState,
  type CommercialChangeRevision,
  type CurrentCommercialState,
} from "./current-commercial-state.js";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface JobDashboardSummary {
  readonly acceptedAt: Date;
  readonly id: string;
  readonly providerDisplayName: string;
  readonly requestTitle: string;
  readonly role: "CUSTOMER" | "PRIMARY_PROVIDER";
  readonly state: "CONFIRMED" | "IN_PROGRESS" | "CANCELLED";
}

export interface JobDashboard extends JobDashboardSummary {
  readonly currentCommercialState: CurrentCommercialState;
  readonly customerDisplayName: string;
  readonly quote: Readonly<{
    authoringMode: "EXTERNAL_PDF" | "PLATFORM_STRUCTURED";
    commercialContent: Readonly<Record<string, unknown>>;
    pdfDownloadPath: string | null;
    quoteId: string;
    revision: number;
  }>;
  readonly request: Readonly<{
    contentRevision: number;
    description: string;
    municipalityCode: string;
    scopeDetails: Readonly<Record<string, unknown>>;
    title: string;
    visibleVersion: number;
  }>;
  readonly supportingDocuments: readonly Readonly<{
    displayFilename: string | null;
    downloadPath: string;
    mediaAssetId: string;
  }>[];
  readonly timeline: readonly Readonly<{
    eventId: string;
    eventType:
      | "JOB_CONFIRMED"
      | "CONTACT_ADDRESS_UNLOCKED"
      | "JOB_STARTED"
      | "JOB_CANCELLED"
      | "PARTICIPANT_JOINED"
      | "PARTICIPANT_LEFT"
      | "PARTICIPANT_REMOVED";
    occurredAt: Date;
    actorRole: "CUSTOMER" | "PRIMARY_PROVIDER" | "PARTICIPANT" | null;
    reason: string | null;
  }>[];
  readonly winningInvitationId: string;
}

interface JobRow {
  readonly acceptedAt: Date;
  readonly customerOwnerUserId: string;
  readonly id: string;
  readonly providerDisplayName: string;
  readonly quoteSnapshot: unknown;
  readonly requestSnapshot: unknown;
  readonly role: string;
  readonly state: string;
  readonly winningInvitationId: string;
}

interface DocumentRow {
  readonly displayFilename: string | null;
  readonly mediaAssetId: string;
}

interface TimelineRow {
  readonly eventId: string;
  readonly eventType: string;
  readonly occurredAt: Date;
  readonly actorRole: string | null;
  readonly reason: string | null;
}

interface ApprovedChangeRow {
  readonly changeOrderId: string;
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly approvedAt: Date;
  readonly title: string;
  readonly reason: string;
  readonly changeDescription: string;
  readonly scopeAdded: string[];
  readonly scopeRemoved: string[];
  readonly scopeChanged: string[];
  readonly priceImpactMode: ChangeOrderPriceImpact["mode"];
  readonly deltaAmountCents: string | null;
  readonly rangeMinimumDeltaCents: string | null;
  readonly rangeMaximumDeltaCents: string | null;
  readonly priceBasis: string | null;
  readonly vatStatus:
    "VAT_INCLUDED" | "VAT_EXCLUDED" | "NOT_VAT_REGISTERED" | null;
  readonly scheduleImpactMode: ChangeOrderScheduleImpact["mode"];
  readonly scheduleDeltaDays: number | null;
  readonly scheduleNewDate: string | null;
  readonly scheduleRangeStart: string | null;
  readonly scheduleRangeEnd: string | null;
  readonly materialResponsibility: "PROVIDER" | "CUSTOMER" | "MIXED" | null;
  readonly warrantyChange: string | null;
  readonly otherConditionChange: string | null;
  readonly affectedMilestoneIds: string[];
}

export function createJobDashboardRepository(sql: Sql | TransactionSql) {
  return Object.freeze({
    async listForPrimaryParty(input: {
      readonly actorUserId: string;
    }): Promise<readonly JobDashboardSummary[]> {
      if (!uuid.test(input.actorUserId)) return [];
      const rows = await sql<JobRow[]>`
        SELECT job.id, job.accepted_at AS "acceptedAt",
          current_state.state::text AS state,
          job.winning_invitation_id AS "winningInvitationId",
          customer.owner_user_id AS "customerOwnerUserId",
          CASE WHEN customer.owner_user_id = viewer.id
            THEN 'CUSTOMER' ELSE 'PRIMARY_PROVIDER' END AS role,
          CASE WHEN provider.profile_type = 'COMPANY'
            THEN provider.official_company_name
            ELSE coalesce(provider.nickname,
              provider.real_first_name || ' ' || provider.real_last_name)
          END AS "providerDisplayName",
          snapshot.request_snapshot AS "requestSnapshot",
          snapshot.quote_snapshot AS "quoteSnapshot"
        FROM users viewer
        JOIN jobs job ON true
        JOIN customer_profiles customer
          ON customer.id = job.customer_profile_id
        JOIN craftsman_profiles provider
          ON provider.id = job.primary_craftsman_profile_id
        JOIN job_acceptance_events accepted ON accepted.job_id = job.id
        JOIN job_agreement_snapshots snapshot ON snapshot.job_id = job.id
        JOIN current_job_states current_state ON current_state.job_id = job.id
        WHERE viewer.id = ${input.actorUserId}
          AND viewer.account_state = 'ACTIVE'
          AND (customer.owner_user_id = viewer.id
            OR provider.owner_user_id = viewer.id)
        ORDER BY job.accepted_at DESC, job.id DESC
        LIMIT 100
      `;
      return Object.freeze(rows.map(toSummary));
    },
    async readForPrimaryParty(input: {
      readonly actorUserId: string;
      readonly jobId: string;
    }): Promise<JobDashboard | null> {
      if (!uuid.test(input.actorUserId) || !uuid.test(input.jobId)) return null;
      return withReadTransaction(sql, async (transaction) => {
        const [row] = await transaction<JobRow[]>`
        SELECT job.id, job.accepted_at AS "acceptedAt",
          current_state.state::text AS state,
          job.winning_invitation_id AS "winningInvitationId",
          customer.owner_user_id AS "customerOwnerUserId",
          CASE WHEN customer.owner_user_id = viewer.id
            THEN 'CUSTOMER' ELSE 'PRIMARY_PROVIDER' END AS role,
          CASE WHEN provider.profile_type = 'COMPANY'
            THEN provider.official_company_name
            ELSE coalesce(provider.nickname,
              provider.real_first_name || ' ' || provider.real_last_name)
          END AS "providerDisplayName",
          snapshot.request_snapshot AS "requestSnapshot",
          snapshot.quote_snapshot AS "quoteSnapshot"
        FROM users viewer
        JOIN jobs job ON job.id = ${input.jobId}
        JOIN customer_profiles customer
          ON customer.id = job.customer_profile_id
        JOIN craftsman_profiles provider
          ON provider.id = job.primary_craftsman_profile_id
        JOIN job_acceptance_events accepted ON accepted.job_id = job.id
        JOIN job_agreement_snapshots snapshot ON snapshot.job_id = job.id
        JOIN current_job_states current_state ON current_state.job_id = job.id
        WHERE viewer.id = ${input.actorUserId}
          AND viewer.account_state = 'ACTIVE'
          AND (customer.owner_user_id = viewer.id
            OR provider.owner_user_id = viewer.id)
        FOR SHARE OF viewer
      `;
        if (row === undefined) return null;
        const summary = toSummary(row);
        const request = parseRequest(row.requestSnapshot);
        const quote = parseQuote(row.quoteSnapshot);
        if (
          request === null ||
          quote === null ||
          !uuid.test(row.winningInvitationId)
        )
          throw new Error("Invalid accepted Job snapshot.");
        const documents = await transaction<DocumentRow[]>`
        SELECT document.media_asset_id AS "mediaAssetId",
          document.display_filename AS "displayFilename"
        FROM job_quote_supporting_document_snapshots document
        JOIN media_assets asset ON asset.id = document.media_asset_id
          AND asset.status = 'READY'
          AND asset.malware_scan_verdict = 'CLEAN'
          AND asset.document_content_sha256 = document.content_sha256
        JOIN media_asset_storage_objects canonical
          ON canonical.media_asset_id = asset.id
          AND canonical.role = 'CANONICAL'
          AND canonical.storage_area = 'private'
          AND canonical.content_type = 'application/pdf'
          AND canonical.content_sha256 = document.content_sha256
          AND canonical.revoked_at IS NULL
        WHERE document.job_id = ${input.jobId}
        ORDER BY document.included_at, document.media_asset_id
      `;
        const [count] = await transaction<Array<{ readonly total: number }>>`
        SELECT count(*)::integer AS total
        FROM job_quote_supporting_document_snapshots
        WHERE job_id = ${input.jobId}
      `;
        if (count === undefined || count.total !== documents.length)
          throw new Error("Accepted Job documents are unavailable.");
        const approvedRows = await transaction<ApprovedChangeRow[]>`
        SELECT order_identity.id AS "changeOrderId", revision.id AS "revisionId",
          revision.revision_number AS "revisionNumber",
          approval.occurred_at AS "approvedAt",
          revision.title, revision.reason,
          revision.change_description AS "changeDescription",
          revision.scope_added AS "scopeAdded",
          revision.scope_removed AS "scopeRemoved",
          revision.scope_changed AS "scopeChanged",
          revision.price_impact_mode::text AS "priceImpactMode",
          revision.delta_amount_cents AS "deltaAmountCents",
          revision.range_minimum_delta_cents AS "rangeMinimumDeltaCents",
          revision.range_maximum_delta_cents AS "rangeMaximumDeltaCents",
          revision.price_basis AS "priceBasis",
          revision.vat_status::text AS "vatStatus",
          revision.schedule_impact_mode::text AS "scheduleImpactMode",
          revision.schedule_delta_days AS "scheduleDeltaDays",
          revision.schedule_new_date AS "scheduleNewDate",
          revision.schedule_range_start AS "scheduleRangeStart",
          revision.schedule_range_end AS "scheduleRangeEnd",
          revision.material_responsibility::text AS "materialResponsibility",
          revision.warranty_change AS "warrantyChange",
          revision.other_condition_change AS "otherConditionChange",
          revision.affected_milestone_ids AS "affectedMilestoneIds"
        FROM change_orders order_identity
        JOIN change_order_revisions revision
          ON revision.change_order_id = order_identity.id
        JOIN current_change_order_revision_states state
          ON state.revision_id = revision.id AND state.state = 'APPROVED'
        JOIN change_order_revision_actions approval
          ON approval.revision_id = revision.id AND approval.action = 'APPROVE'
        WHERE order_identity.job_id = ${input.jobId}
        ORDER BY approval.occurred_at, approval.id, order_identity.id
      `;
        const currentCommercialState = deriveCurrentCommercialState(
          quote,
          approvedRows.map(mapApprovedChange),
        );
        const timeline = await transaction<TimelineRow[]>`
        SELECT event_id AS "eventId", event_type AS "eventType",
          occurred_at AS "occurredAt", actor_role AS "actorRole", reason
        FROM job_chronological_system_events
        WHERE job_id = ${input.jobId}
        ORDER BY occurred_at, event_order, event_id
      `;
        const startCount = timeline.filter(
          (event) => event.eventType === "JOB_STARTED",
        ).length;
        const cancellationCount = timeline.filter(
          (event) => event.eventType === "JOB_CANCELLED",
        ).length;
        if (
          timeline.length < 2 ||
          timeline.some((event) => !validTimeline(event)) ||
          timeline.filter((event) => event.eventType === "JOB_CONFIRMED")
            .length !== 1 ||
          timeline.filter(
            (event) => event.eventType === "CONTACT_ADDRESS_UNLOCKED",
          ).length !== 1 ||
          startCount > 1 ||
          (summary.state === "CONFIRMED" && startCount !== 0) ||
          (summary.state === "IN_PROGRESS" && startCount !== 1) ||
          cancellationCount !== (summary.state === "CANCELLED" ? 1 : 0)
        )
          throw new Error("Accepted Job timeline is unavailable.");
        return Object.freeze({
          ...summary,
          customerDisplayName: `Konto ${row.customerOwnerUserId.slice(0, 8)}`,
          currentCommercialState,
          quote,
          request,
          supportingDocuments: Object.freeze(
            documents.map((document) => {
              if (!uuid.test(document.mediaAssetId))
                throw new Error("Invalid accepted Job document.");
              return Object.freeze({
                displayFilename: document.displayFilename,
                downloadPath: `/v1/media/${document.mediaAssetId}/download`,
                mediaAssetId: document.mediaAssetId,
              });
            }),
          ),
          timeline: Object.freeze(
            timeline.map((event) =>
              Object.freeze({
                eventId: event.eventId,
                eventType:
                  event.eventType as JobDashboard["timeline"][number]["eventType"],
                occurredAt: event.occurredAt,
                actorRole:
                  event.actorRole as JobDashboard["timeline"][number]["actorRole"],
                reason: event.reason,
              }),
            ),
          ),
          winningInvitationId: row.winningInvitationId,
        });
      });
    },
  });
}

function toSummary(row: JobRow): JobDashboardSummary {
  const request = parseRequest(row.requestSnapshot);
  if (
    !uuid.test(row.id) ||
    !uuid.test(row.customerOwnerUserId) ||
    !(row.acceptedAt instanceof Date) ||
    !Number.isFinite(row.acceptedAt.getTime()) ||
    !["CONFIRMED", "IN_PROGRESS", "CANCELLED"].includes(row.state) ||
    (row.role !== "CUSTOMER" && row.role !== "PRIMARY_PROVIDER") ||
    typeof row.providerDisplayName !== "string" ||
    row.providerDisplayName.length === 0 ||
    request === null
  )
    throw new Error("Invalid accepted Job read model.");
  return Object.freeze({
    acceptedAt: row.acceptedAt,
    id: row.id,
    providerDisplayName: row.providerDisplayName,
    requestTitle: request.title,
    role: row.role,
    state: row.state as JobDashboardSummary["state"],
  });
}

function parseRequest(value: unknown): JobDashboard["request"] | null {
  const snapshot = record(value);
  const sections = record(snapshot?.["sections"]);
  const core = record(record(sections?.["request.core"])?.["payload"]);
  const location = record(record(sections?.["request.location"])?.["payload"]);
  const timing = record(record(sections?.["request.timing"])?.["payload"]);
  const budget = record(record(sections?.["request.budget"])?.["payload"]);
  const details = record(record(sections?.["request.details"])?.["payload"]);
  if (
    (core?.["title"] !== null &&
      (typeof core?.["title"] !== "string" || core["title"].length === 0)) ||
    typeof core["description"] !== "string" ||
    typeof location?.["municipalityCode"] !== "string" ||
    timing === null ||
    budget === null ||
    details === null ||
    !positive(snapshot?.["contentRevision"]) ||
    !positive(snapshot["visibleVersion"])
  )
    return null;
  const scopeDetails: Record<string, unknown> = {};
  const mappings = [
    [core, "primaryProfessionCode", "primaryProfessionCode"],
    [core, "relatedProfessionCodes", "relatedProfessionCodes"],
    [core, "skillCodes", "skillCodes"],
    [core, "specializationCode", "specializationCode"],
    [timing, "mode", "timingMode"],
    [timing, "startsOn", "startsOn"],
    [timing, "endsOn", "endsOn"],
    [timing, "completionDeadline", "completionDeadline"],
    [budget, "mode", "budgetMode"],
    [budget, "minimumAmountCents", "minimumAmountCents"],
    [budget, "maximumAmountCents", "maximumAmountCents"],
    [budget, "currency", "currency"],
    [details, "approximateQuantity", "approximateQuantity"],
    [details, "customRequirements", "customRequirements"],
    [details, "materialResponsibility", "materialResponsibility"],
    [details, "siteInspection", "siteInspection"],
  ] as const;
  for (const [source, sourceKey, target] of mappings) {
    const field = source[sourceKey];
    if (field === undefined) return null;
    if (
      field !== null &&
      typeof field !== "string" &&
      !(typeof field === "number" && Number.isSafeInteger(field)) &&
      !(Array.isArray(field) && field.every((item) => typeof item === "string"))
    )
      return null;
    scopeDetails[target] = field;
  }
  return Object.freeze({
    contentRevision: snapshot["contentRevision"],
    description: core["description"],
    municipalityCode: location["municipalityCode"],
    scopeDetails: Object.freeze(scopeDetails),
    title: core["title"] === null ? "Zákazka" : core["title"],
    visibleVersion: snapshot["visibleVersion"],
  });
}

const commercialFields = Object.freeze({
  conditionalOnInspection: "conditional_on_inspection",
  currency: "currency",
  depositAmountCents: "deposit_amount_cents",
  depositMode: "deposit_mode",
  depositNotes: "deposit_notes",
  depositPercentageBasisPoints: "deposit_percentage_basis_points",
  estimatedDurationDays: "estimated_duration_days",
  estimatedStartOn: "estimated_start_on",
  excludedScope: "excluded_scope",
  includedScope: "included_scope",
  inspectionConditions: "inspection_conditions",
  materialResponsibility: "material_responsibility",
  priceBasis: "price_basis",
  priceMode: "price_mode",
  providerNotes: "provider_notes",
  rangeMaximumCents: "range_maximum_cents",
  rangeMinimumCents: "range_minimum_cents",
  summary: "summary",
  title: "title",
  totalAmountCents: "total_amount_cents",
  transportAmountCents: "transport_amount_cents",
  transportDescription: "transport_description",
  validUntil: "valid_until",
  vatStatus: "vat_status",
  warrantyInformation: "warranty_information",
});

function parseQuote(value: unknown): JobDashboard["quote"] | null {
  const snapshot = record(value);
  const source = record(snapshot?.["commercialContent"]);
  const quoteId = snapshot?.["quoteId"];
  const pdfMediaAssetId = snapshot?.["pdfMediaAssetId"];
  if (
    source === null ||
    typeof quoteId !== "string" ||
    !uuid.test(quoteId) ||
    !positive(snapshot?.["revision"]) ||
    (snapshot["authoringMode"] !== "EXTERNAL_PDF" &&
      snapshot["authoringMode"] !== "PLATFORM_STRUCTURED") ||
    (pdfMediaAssetId !== null &&
      (typeof pdfMediaAssetId !== "string" || !uuid.test(pdfMediaAssetId)))
  )
    return null;
  const commercialContent: Record<string, unknown> = {};
  for (const [target, sourceKey] of Object.entries(commercialFields)) {
    const field = source[sourceKey];
    if (
      field === null ||
      typeof field === "string" ||
      typeof field === "boolean" ||
      (typeof field === "number" && Number.isSafeInteger(field)) ||
      (Array.isArray(field) && field.every((item) => typeof item === "string"))
    ) {
      commercialContent[target] = field;
    } else if (field !== undefined) {
      return null;
    }
  }
  return Object.freeze({
    authoringMode: snapshot["authoringMode"],
    commercialContent: Object.freeze(commercialContent),
    pdfDownloadPath:
      pdfMediaAssetId === null ? null : `/v1/media/${pdfMediaAssetId}/download`,
    quoteId,
    revision: snapshot["revision"],
  });
}

function mapApprovedChange(row: ApprovedChangeRow): CommercialChangeRevision {
  if (
    !uuid.test(row.changeOrderId) ||
    !uuid.test(row.revisionId) ||
    !positive(row.revisionNumber) ||
    !(row.approvedAt instanceof Date) ||
    !Number.isFinite(row.approvedAt.getTime()) ||
    ![row.scopeAdded, row.scopeRemoved, row.scopeChanged].every(
      (lines) =>
        Array.isArray(lines) && lines.every((line) => typeof line === "string"),
    ) ||
    !Array.isArray(row.affectedMilestoneIds) ||
    !row.affectedMilestoneIds.every((id) => uuid.test(id))
  )
    throw new Error("Invalid approved Change-order provenance.");
  let priceImpact: ChangeOrderPriceImpact;
  if (row.priceImpactMode === "NONE") priceImpact = { mode: "NONE" };
  else if (row.priceImpactMode === "FIXED_DELTA")
    priceImpact = {
      mode: "FIXED_DELTA",
      amountCents: cents(row.deltaAmountCents),
      vatStatus: requiredVat(row.vatStatus),
    };
  else if (row.priceImpactMode === "ESTIMATE_DELTA")
    priceImpact = {
      mode: "ESTIMATE_DELTA",
      amountCents: cents(row.deltaAmountCents),
      basis: requiredText(row.priceBasis),
      vatStatus: requiredVat(row.vatStatus),
    };
  else if (row.priceImpactMode === "RANGE_DELTA")
    priceImpact = {
      mode: "RANGE_DELTA",
      minimumCents: cents(row.rangeMinimumDeltaCents),
      maximumCents: cents(row.rangeMaximumDeltaCents),
      basis: requiredText(row.priceBasis),
      vatStatus: requiredVat(row.vatStatus),
    };
  else throw new Error("Invalid approved Change-order price impact.");
  let scheduleImpact: ChangeOrderScheduleImpact;
  if (row.scheduleImpactMode === "NONE") scheduleImpact = { mode: "NONE" };
  else if (row.scheduleImpactMode === "DAYS") {
    if (!Number.isSafeInteger(row.scheduleDeltaDays))
      throw new Error("Invalid approved Change-order schedule.");
    scheduleImpact = { mode: "DAYS", deltaDays: row.scheduleDeltaDays! };
  } else if (row.scheduleImpactMode === "DATE")
    scheduleImpact = {
      mode: "DATE",
      newDate: requiredText(row.scheduleNewDate),
    };
  else if (row.scheduleImpactMode === "RANGE")
    scheduleImpact = {
      mode: "RANGE",
      startDate: requiredText(row.scheduleRangeStart),
      endDate: requiredText(row.scheduleRangeEnd),
    };
  else throw new Error("Invalid approved Change-order schedule impact.");
  const terms: ChangeOrderTerms = {
    title: requiredText(row.title),
    reason: requiredText(row.reason),
    changeDescription: requiredText(row.changeDescription),
    scopeAdded: row.scopeAdded,
    scopeRemoved: row.scopeRemoved,
    scopeChanged: row.scopeChanged,
    priceImpact,
    scheduleImpact,
    materialResponsibility: row.materialResponsibility,
    warrantyChange: row.warrantyChange,
    otherConditionChange: row.otherConditionChange,
    affectedMilestoneIds: row.affectedMilestoneIds,
  };
  return {
    changeOrderId: row.changeOrderId,
    revisionId: row.revisionId,
    revisionNumber: row.revisionNumber,
    state: "APPROVED",
    approvedAt: row.approvedAt,
    terms,
  };
}

function cents(value: string | null): number {
  if (typeof value !== "string" || !/^-?\d{1,13}$/u.test(value))
    throw new Error("Invalid approved Change-order amount.");
  const result = Number(value);
  if (!Number.isSafeInteger(result) || Math.abs(result) > 1_000_000_000_000)
    throw new Error("Invalid approved Change-order amount.");
  return result;
}

function requiredText(value: string | null): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error("Invalid approved Change-order text.");
  return value;
}

function requiredVat(
  value: ApprovedChangeRow["vatStatus"],
): NonNullable<ApprovedChangeRow["vatStatus"]> {
  if (
    value !== "VAT_INCLUDED" &&
    value !== "VAT_EXCLUDED" &&
    value !== "NOT_VAT_REGISTERED"
  )
    throw new Error("Invalid approved Change-order VAT.");
  return value;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validTimeline(event: TimelineRow): boolean {
  const initial =
    (event.eventType === "JOB_CONFIRMED" ||
      event.eventType === "CONTACT_ADDRESS_UNLOCKED") &&
    event.actorRole === null &&
    event.reason === null;
  const started =
    event.eventType === "JOB_STARTED" &&
    event.actorRole === "PRIMARY_PROVIDER" &&
    event.reason === null;
  const cancelled =
    event.eventType === "JOB_CANCELLED" &&
    (event.actorRole === "CUSTOMER" ||
      event.actorRole === "PRIMARY_PROVIDER") &&
    typeof event.reason === "string" &&
    event.reason.trim().length >= 8;
  const participant =
    ((event.eventType === "PARTICIPANT_JOINED" ||
      event.eventType === "PARTICIPANT_LEFT") &&
      event.actorRole === "PARTICIPANT" &&
      event.reason === null) ||
    (event.eventType === "PARTICIPANT_REMOVED" &&
      event.actorRole === "PRIMARY_PROVIDER" &&
      event.reason === null);
  return (
    uuid.test(event.eventId) &&
    event.occurredAt instanceof Date &&
    Number.isFinite(event.occurredAt.getTime()) &&
    (initial || started || cancelled || participant)
  );
}

function withReadTransaction<T>(
  sql: Sql | TransactionSql,
  callback: (transaction: TransactionSql) => Promise<T>,
): Promise<T> {
  return (
    "savepoint" in sql
      ? sql.savepoint(callback)
      : sql.begin((transaction) => callback(transaction))
  ) as Promise<T>;
}
