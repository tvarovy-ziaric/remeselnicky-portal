import { createHash } from "node:crypto";

import {
  createServerMediaEntityAccess,
  createServerMediaProvenance,
  type MediaEntityAccessResolver,
  type PrivateMediaDeliverySnapshot,
} from "@portal/media";
import type { Sql, TransactionSql } from "postgres";

type RootSql = Sql | TransactionSql;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const control = /[\p{Cc}]/u;

export const DISPUTE_CATEGORIES = Object.freeze([
  "UNFINISHED_WORK",
  "QUALITY_DEFECT",
  "SCOPE",
  "PRICE_CHANGE_ORDER",
  "SCHEDULE",
  "MATERIAL",
  "DOCUMENTS",
  "CANCELLATION",
  "COMMUNICATION_BEHAVIOR",
  "OTHER",
] as const);
export type DisputeCategory = (typeof DISPUTE_CATEGORIES)[number];
export type DisputePartyRole = "CUSTOMER" | "PRIMARY_PROVIDER";
export type DisputeCaseState =
  "OPEN" | "WAITING_FOR_PARTY" | "UNDER_REVIEW" | "RESOLVED" | "CLOSED";
export type DisputeCaseOutcomeCategory =
  | "RESOLVED_BY_PARTIES"
  | "OPERATIONAL_ADMIN_RESOLUTION"
  | "NO_ACTION"
  | "REFERRED_OUTSIDE_PLATFORM"
  | "ACCOUNT_POLICY_ACTION"
  | "OTHER";

export interface DisputeCaseSummary {
  readonly id: string;
  readonly jobId: string;
  readonly openedByRole: DisputePartyRole;
  readonly viewerRole: DisputePartyRole;
  readonly category: DisputeCategory;
  readonly description: string;
  readonly desiredResolution: string;
  readonly state: DisputeCaseState;
  readonly stateRevision: number;
  readonly createdAt: Date;
  readonly stateChangedAt: Date;
  readonly canAddContent: boolean;
}

export interface DisputeStatement {
  readonly id: string;
  readonly authorRole: DisputePartyRole;
  readonly kind: "STATEMENT" | "ADDENDUM";
  readonly body: string;
  readonly createdAt: Date;
}

export interface DisputeEvidence {
  readonly id: string;
  readonly submittedByRole: DisputePartyRole;
  readonly source: "NEW_UPLOAD" | "EXISTING_JOB_EVIDENCE";
  readonly mediaAssetId: string;
  readonly kind: "PHOTO" | "DOCUMENT";
  readonly description: string;
  readonly displayFilename: string | null;
  readonly contentType: string;
  readonly downloadPath: string;
  readonly createdAt: Date;
}

export interface DisputeCaseDetail extends DisputeCaseSummary {
  readonly statements: readonly DisputeStatement[];
  readonly evidence: readonly DisputeEvidence[];
  readonly adminRequests: readonly Readonly<{
    id: string;
    recipient: DisputePartyRole | "BOTH";
    requestText: string;
    replyDeadline: Date | null;
    requestedAt: Date;
  }>[];
  readonly outcome: Readonly<{
    id: string;
    category: DisputeCaseOutcomeCategory;
    basis: "MUTUAL_PARTY_AGREEMENT" | "ADMINISTRATIVE_CLOSURE";
    summary: string;
    recordedAt: Date;
  }> | null;
  readonly caseTimeline: readonly Readonly<{
    eventId: string;
    action: string;
    fromState: DisputeCaseState | null;
    toState: DisputeCaseState;
    occurredAt: Date;
  }>[];
  readonly commercialBaseline: Readonly<{
    acceptedRequestContentRevision: number;
    acceptedRequestVisibleVersion: number;
    acceptedQuoteId: string;
    acceptedQuoteRevision: number;
    acceptedQuoteMode: "PLATFORM_STRUCTURED" | "EXTERNAL_PDF";
    acceptedQuotePdfDownloadPath: string | null;
    approvedChanges: readonly Readonly<{
      changeOrderId: string;
      revisionId: string;
      revisionNumber: number;
      title: string;
      changeDescription: string;
      approvedAt: Date;
    }>[];
    jobDashboardPath: string;
  }>;
  readonly jobTimeline: readonly Readonly<{
    eventId: string;
    eventType: string;
    occurredAt: Date;
  }>[];
}

export type DisputeCommandResult =
  | Readonly<{
      status: "APPLIED" | "DEDUPLICATED";
      id: string;
      disputeId: string;
      occurredAt: Date;
    }>
  | Readonly<{
      status: "NOT_FOUND" | "CASE_CLOSED" | "DUPLICATE_EVIDENCE";
    }>;

export class DisputeIdempotencyError extends Error {
  override readonly name = "DisputeIdempotencyError";
}

interface Party {
  readonly role: DisputePartyRole;
}
interface ExistingCommand {
  readonly id: string;
  readonly kind: "CASE" | "STATEMENT" | "EVIDENCE";
  readonly actorUserId: string;
  readonly disputeId: string;
  readonly jobId: string;
  readonly intent: string;
  readonly occurredAt: Date;
}
interface SummaryRow {
  readonly id: string;
  readonly jobId: string;
  readonly openedByRole: string;
  readonly category: string;
  readonly description: string;
  readonly desiredResolution: string;
  readonly state: string;
  readonly stateRevision: number;
  readonly createdAt: Date;
  readonly stateChangedAt: Date;
}

export function createJobDisputeRepository(sql: RootSql) {
  async function openCase(input: {
    actorUserId: string;
    commandId: string;
    jobId: string;
    category: DisputeCategory;
    description: string;
    desiredResolution: string;
  }): Promise<DisputeCommandResult> {
    ids(input.actorUserId, input.commandId, input.jobId);
    if (!DISPUTE_CATEGORIES.includes(input.category))
      throw new TypeError("Invalid dispute category.");
    const description = bounded(input.description, 10, 4000);
    const desiredResolution = bounded(input.desiredResolution, 1, 2000);
    const intent = fingerprint({
      kind: "OPEN",
      actorUserId: input.actorUserId,
      jobId: input.jobId,
      category: input.category,
      description,
      desiredResolution,
    });
    return transaction(sql, async (tx) => {
      await lockCommand(tx, input.commandId);
      const prior = await existingCommand(tx, input.commandId);
      if (prior !== null)
        return replay(prior, "CASE", intent, input.actorUserId, input.jobId);
      const party = await authorizeParty(
        tx,
        input.actorUserId,
        input.jobId,
        true,
      );
      if (party === null) return { status: "NOT_FOUND" };
      const [row] = await tx<Array<{ createdAt: Date }>>`
        INSERT INTO dispute_cases
          (id, job_id, opened_by_user_id, opened_by_role, category,
            description, desired_resolution, command_intent_sha256)
        VALUES (${input.commandId}, ${input.jobId}, ${input.actorUserId},
          ${party.role}, ${input.category}, ${description},
          ${desiredResolution}, ${intent})
        RETURNING created_at AS "createdAt"`;
      if (!row) throw new Error("Dispute case insert missing.");
      return applied(input.commandId, input.commandId, row.createdAt);
    });
  }

  async function addStatement(input: {
    actorUserId: string;
    commandId: string;
    jobId: string;
    disputeId: string;
    kind: "STATEMENT" | "ADDENDUM";
    body: string;
  }): Promise<DisputeCommandResult> {
    ids(input.actorUserId, input.commandId, input.jobId, input.disputeId);
    if (input.kind !== "STATEMENT" && input.kind !== "ADDENDUM")
      throw new TypeError("Invalid dispute statement kind.");
    const body = bounded(input.body, 1, 4000);
    const intent = fingerprint({
      kind: "STATEMENT",
      actorUserId: input.actorUserId,
      jobId: input.jobId,
      disputeId: input.disputeId,
      statementKind: input.kind,
      body,
    });
    return transaction(sql, async (tx) => {
      await lockCommand(tx, input.commandId);
      const prior = await existingCommand(tx, input.commandId);
      if (prior !== null)
        return replay(
          prior,
          "STATEMENT",
          intent,
          input.actorUserId,
          input.jobId,
          input.disputeId,
        );
      const party = await authorizeCase(
        tx,
        input.actorUserId,
        input.jobId,
        input.disputeId,
        true,
      );
      if (party === null) return { status: "NOT_FOUND" };
      if (!party.acceptsContent) return { status: "CASE_CLOSED" };
      const [row] = await tx<Array<{ createdAt: Date }>>`
        INSERT INTO dispute_case_statements
          (id, dispute_id, author_user_id, author_role, kind, body,
            command_intent_sha256)
        VALUES (${input.commandId}, ${input.disputeId}, ${input.actorUserId},
          ${party.role}, ${input.kind}, ${body}, ${intent})
        RETURNING created_at AS "createdAt"`;
      if (!row) throw new Error("Dispute statement insert missing.");
      return applied(input.commandId, input.disputeId, row.createdAt);
    });
  }

  async function addEvidence(input: {
    actorUserId: string;
    commandId: string;
    jobId: string;
    disputeId: string;
    source: "NEW_UPLOAD" | "EXISTING_JOB_EVIDENCE";
    mediaAssetId: string;
    description: string;
  }): Promise<DisputeCommandResult> {
    ids(
      input.actorUserId,
      input.commandId,
      input.jobId,
      input.disputeId,
      input.mediaAssetId,
    );
    if (
      input.source !== "NEW_UPLOAD" &&
      input.source !== "EXISTING_JOB_EVIDENCE"
    )
      throw new TypeError("Invalid dispute evidence source.");
    const description = bounded(input.description, 1, 1000);
    const intent = fingerprint({
      kind: "EVIDENCE",
      actorUserId: input.actorUserId,
      jobId: input.jobId,
      disputeId: input.disputeId,
      source: input.source,
      mediaAssetId: input.mediaAssetId,
      description,
    });
    return transaction(sql, async (tx) => {
      await lockCommand(tx, input.commandId);
      const prior = await existingCommand(tx, input.commandId);
      if (prior !== null)
        return replay(
          prior,
          "EVIDENCE",
          intent,
          input.actorUserId,
          input.jobId,
          input.disputeId,
        );
      const party = await authorizeCase(
        tx,
        input.actorUserId,
        input.jobId,
        input.disputeId,
        true,
      );
      if (party === null) return { status: "NOT_FOUND" };
      if (!party.acceptsContent) return { status: "CASE_CLOSED" };
      const [duplicate] = await tx<Array<{ id: string }>>`
        SELECT id FROM dispute_case_evidence
        WHERE dispute_id = ${input.disputeId}
          AND media_asset_id = ${input.mediaAssetId}`;
      if (duplicate) return { status: "DUPLICATE_EVIDENCE" };
      const [row] = await tx<Array<{ createdAt: Date }>>`
        INSERT INTO dispute_case_evidence
          (id, dispute_id, submitted_by_user_id, submitted_by_role,
            source, media_asset_id, description, command_intent_sha256)
        VALUES (${input.commandId}, ${input.disputeId}, ${input.actorUserId},
          ${party.role}, ${input.source}, ${input.mediaAssetId},
          ${description}, ${intent})
        RETURNING created_at AS "createdAt"`;
      if (!row) throw new Error("Dispute evidence insert missing.");
      return applied(input.commandId, input.disputeId, row.createdAt);
    });
  }

  async function listCases(input: {
    actorUserId: string;
    jobId: string;
  }): Promise<readonly DisputeCaseSummary[] | null> {
    ids(input.actorUserId, input.jobId);
    return transaction(sql, async (tx) => {
      const party = await authorizeParty(
        tx,
        input.actorUserId,
        input.jobId,
        false,
      );
      if (party === null) return null;
      const rows = await tx<SummaryRow[]>`
        SELECT dispute.id, dispute.job_id AS "jobId",
          dispute.opened_by_role::text AS "openedByRole",
          dispute.category::text, dispute.description,
          dispute.desired_resolution AS "desiredResolution",
          dispute.state::text, dispute.state_revision AS "stateRevision",
          dispute.created_at AS "createdAt",
          dispute.state_changed_at AS "stateChangedAt"
        FROM current_dispute_cases dispute
        WHERE dispute.job_id = ${input.jobId}
        ORDER BY dispute.created_at DESC, dispute.id DESC`;
      return Object.freeze(rows.map((row) => mapSummary(row, party.role)));
    });
  }

  async function getCase(input: {
    actorUserId: string;
    jobId: string;
    disputeId: string;
  }): Promise<DisputeCaseDetail | null> {
    ids(input.actorUserId, input.jobId, input.disputeId);
    return transaction(sql, async (tx) => {
      const party = await authorizeCase(
        tx,
        input.actorUserId,
        input.jobId,
        input.disputeId,
        false,
      );
      if (party === null) return null;
      const [row] = await tx<SummaryRow[]>`
        SELECT dispute.id, dispute.job_id AS "jobId",
          dispute.opened_by_role::text AS "openedByRole",
          dispute.category::text, dispute.description,
          dispute.desired_resolution AS "desiredResolution",
          dispute.state::text, dispute.state_revision AS "stateRevision",
          dispute.created_at AS "createdAt",
          dispute.state_changed_at AS "stateChangedAt"
        FROM current_dispute_cases dispute
        WHERE dispute.id = ${input.disputeId}
          AND dispute.job_id = ${input.jobId}`;
      if (!row) return null;
      const statements = await tx<
        Array<{
          id: string;
          authorRole: string;
          kind: string;
          body: string;
          createdAt: Date;
        }>
      >`
        SELECT id, author_role::text AS "authorRole", kind::text,
          body, created_at AS "createdAt"
        FROM dispute_case_statements
        WHERE dispute_id = ${input.disputeId}
        ORDER BY created_at, id`;
      const evidence = await tx<
        Array<{
          id: string;
          submittedByRole: string;
          source: string;
          mediaAssetId: string;
          mediaKind: string;
          description: string;
          displayFilename: string | null;
          contentType: string;
          createdAt: Date;
        }>
      >`
        SELECT evidence.id,
          evidence.submitted_by_role::text AS "submittedByRole",
          evidence.source::text, evidence.media_asset_id AS "mediaAssetId",
          asset.kind::text AS "mediaKind", evidence.description,
          asset.display_filename AS "displayFilename",
          canonical.content_type AS "contentType",
          evidence.created_at AS "createdAt"
        FROM dispute_case_evidence evidence
        JOIN media_assets asset ON asset.id = evidence.media_asset_id
          AND asset.status = 'READY'
        JOIN media_asset_storage_objects canonical
          ON canonical.media_asset_id = asset.id
          AND canonical.role = 'CANONICAL'
          AND canonical.storage_area = 'private'
          AND canonical.revoked_at IS NULL
        WHERE evidence.dispute_id = ${input.disputeId}
        ORDER BY evidence.created_at, evidence.id`;
      const adminRequests = await tx<
        Array<{
          id: string;
          recipient: DisputePartyRole | "BOTH";
          requestText: string;
          replyDeadline: Date | null;
          requestedAt: Date;
        }>
      >`
        SELECT id, recipient::text, request_text AS "requestText",
          reply_deadline AS "replyDeadline", requested_at AS "requestedAt"
        FROM dispute_case_information_requests
        WHERE dispute_id = ${input.disputeId}
          AND recipient::text IN ('BOTH', ${party.role})
        ORDER BY requested_at, id`;
      const [outcome] = await tx<
        Array<{
          id: string;
          category: DisputeCaseOutcomeCategory;
          basis: "MUTUAL_PARTY_AGREEMENT" | "ADMINISTRATIVE_CLOSURE";
          summary: string;
          recordedAt: Date;
        }>
      >`
        SELECT id, category::text, basis::text, summary,
          recorded_at AS "recordedAt"
        FROM current_dispute_case_outcomes
        WHERE dispute_id = ${input.disputeId}`;
      const caseTimeline = await tx<
        Array<{
          eventId: string;
          action: string;
          fromState: DisputeCaseState | null;
          toState: DisputeCaseState;
          occurredAt: Date;
        }>
      >`
        SELECT event_id AS "eventId", action::text,
          from_state::text AS "fromState", to_state::text AS "toState",
          occurred_at AS "occurredAt"
        FROM dispute_case_state_events
        WHERE dispute_id = ${input.disputeId}
        ORDER BY event_sequence`;
      const [baseline] = await tx<
        Array<{
          requestRevision: number;
          requestVersion: number;
          quoteId: string;
          quoteRevision: number;
          quoteMode: string;
          pdfMediaAssetId: string | null;
        }>
      >`
        SELECT (snapshot.request_snapshot ->> 'contentRevision')::integer
            AS "requestRevision",
          (snapshot.request_snapshot ->> 'visibleVersion')::integer
            AS "requestVersion",
          snapshot.quote_snapshot ->> 'quoteId' AS "quoteId",
          (snapshot.quote_snapshot ->> 'revision')::integer AS "quoteRevision",
          snapshot.quote_snapshot ->> 'authoringMode' AS "quoteMode",
          snapshot.pdf_media_asset_id AS "pdfMediaAssetId"
        FROM job_agreement_snapshots snapshot
        WHERE snapshot.job_id = ${input.jobId}`;
      if (!baseline) throw new Error("Dispute commercial baseline missing.");
      const changes = await tx<
        Array<{
          changeOrderId: string;
          revisionId: string;
          revisionNumber: number;
          title: string;
          changeDescription: string;
          approvedAt: Date;
        }>
      >`
        SELECT identity.id AS "changeOrderId", revision.id AS "revisionId",
          revision.revision_number AS "revisionNumber", revision.title,
          revision.change_description AS "changeDescription",
          approval.occurred_at AS "approvedAt"
        FROM change_orders identity
        JOIN change_order_revisions revision
          ON revision.change_order_id = identity.id
        JOIN current_change_order_revision_states state
          ON state.revision_id = revision.id AND state.state = 'APPROVED'
        JOIN change_order_revision_actions approval
          ON approval.revision_id = revision.id AND approval.action = 'APPROVE'
        WHERE identity.job_id = ${input.jobId}
        ORDER BY approval.occurred_at, revision.id`;
      const timeline = await tx<
        Array<{ eventId: string; eventType: string; occurredAt: Date }>
      >`
        SELECT event_id AS "eventId", event_type AS "eventType",
          occurred_at AS "occurredAt"
        FROM job_chronological_system_events
        WHERE job_id = ${input.jobId}
        ORDER BY occurred_at, event_order, event_id`;
      validateDetailRows(statements, evidence, baseline, changes, timeline);
      validateAdminContextRows(adminRequests, outcome ?? null, caseTimeline);
      return Object.freeze({
        ...mapSummary(row, party.role),
        statements: Object.freeze(
          statements.map((statement) =>
            Object.freeze({
              ...statement,
              authorRole: statement.authorRole as DisputePartyRole,
              kind: statement.kind as DisputeStatement["kind"],
            }),
          ),
        ),
        evidence: Object.freeze(
          evidence.map((item) =>
            Object.freeze({
              id: item.id,
              submittedByRole: item.submittedByRole as DisputePartyRole,
              source: item.source as DisputeEvidence["source"],
              mediaAssetId: item.mediaAssetId,
              kind: item.mediaKind === "IMAGE" ? "PHOTO" : "DOCUMENT",
              description: item.description,
              displayFilename: item.displayFilename,
              contentType: item.contentType,
              downloadPath: `/v1/media/${item.mediaAssetId}/download`,
              createdAt: item.createdAt,
            }),
          ),
        ),
        adminRequests: Object.freeze(
          adminRequests.map((request) => Object.freeze(request)),
        ),
        outcome: outcome === undefined ? null : Object.freeze(outcome),
        caseTimeline: Object.freeze(
          caseTimeline.map((event) => Object.freeze(event)),
        ),
        commercialBaseline: Object.freeze({
          acceptedRequestContentRevision: baseline.requestRevision,
          acceptedRequestVisibleVersion: baseline.requestVersion,
          acceptedQuoteId: baseline.quoteId,
          acceptedQuoteRevision: baseline.quoteRevision,
          acceptedQuoteMode: baseline.quoteMode as
            "PLATFORM_STRUCTURED" | "EXTERNAL_PDF",
          acceptedQuotePdfDownloadPath:
            baseline.pdfMediaAssetId === null
              ? null
              : `/v1/media/${baseline.pdfMediaAssetId}/download`,
          approvedChanges: Object.freeze(
            changes.map((change) => Object.freeze(change)),
          ),
          jobDashboardPath: `/zakazky/${input.jobId}`,
        }),
        jobTimeline: Object.freeze(
          timeline.map((event) => Object.freeze(event)),
        ),
      });
    });
  }

  async function prepareEvidenceUpload(input: {
    actorUserId: string;
    jobId: string;
    disputeId: string;
  }) {
    ids(input.actorUserId, input.jobId, input.disputeId);
    const party = await transaction(sql, (tx) =>
      authorizeCase(tx, input.actorUserId, input.jobId, input.disputeId, false),
    );
    if (party === null || !party.acceptsContent)
      return { status: "UPLOAD_UNAVAILABLE" as const };
    return Object.freeze({
      status: "AUTHORIZED" as const,
      purpose: "DISPUTE_EVIDENCE" as const,
      provenance: createServerMediaProvenance({
        entityType: "DISPUTE_CASE",
        entityId: input.disputeId,
      }),
    });
  }

  async function getEvidenceUploadStatus(input: {
    actorUserId: string;
    jobId: string;
    disputeId: string;
    mediaAssetId: string;
  }): Promise<Readonly<{
    status: "PROCESSING" | "READY" | "REJECTED";
    canBind: boolean;
  }> | null> {
    ids(input.actorUserId, input.jobId, input.disputeId, input.mediaAssetId);
    return transaction(sql, async (tx) => {
      const party = await authorizeCase(
        tx,
        input.actorUserId,
        input.jobId,
        input.disputeId,
        false,
      );
      if (party === null) return null;
      const [row] = await tx<
        Array<{
          status: "PROCESSING" | "READY" | "REJECTED";
          canonicalReady: boolean;
          alreadyBound: boolean;
        }>
      >`
        SELECT asset.status::text,
          CASE
            WHEN asset.status <> 'READY' THEN false
            WHEN asset.kind = 'IMAGE' THEN EXISTS (
              SELECT 1 FROM media_asset_storage_objects canonical
              WHERE canonical.media_asset_id = asset.id
                AND canonical.role = 'CANONICAL'
                AND canonical.storage_area = 'private'
                AND canonical.content_type = 'image/webp'
                AND canonical.revoked_at IS NULL
            )
            WHEN asset.kind = 'DOCUMENT' THEN
              asset.malware_scan_verdict = 'CLEAN' AND EXISTS (
                SELECT 1 FROM media_asset_storage_objects canonical
                WHERE canonical.media_asset_id = asset.id
                  AND canonical.role = 'CANONICAL'
                  AND canonical.storage_area = 'private'
                  AND canonical.content_type = 'application/pdf'
                  AND canonical.content_sha256 = asset.document_content_sha256
                  AND canonical.revoked_at IS NULL
              )
            ELSE false
          END AS "canonicalReady",
          EXISTS (SELECT 1 FROM dispute_case_evidence evidence
            WHERE evidence.dispute_id = ${input.disputeId}
              AND evidence.media_asset_id = asset.id) AS "alreadyBound"
        FROM media_assets asset
        WHERE asset.id = ${input.mediaAssetId}
          AND asset.owner_user_id = ${input.actorUserId}
          AND asset.uploaded_by_user_id = ${input.actorUserId}
          AND asset.purpose = 'DISPUTE_EVIDENCE'
          AND asset.provenance_entity_type = 'DISPUTE_CASE'
          AND asset.provenance_entity_id = ${input.disputeId}
          AND asset.provenance_entity_revision IS NULL
          AND EXISTS (SELECT 1 FROM media_asset_storage_objects original
            WHERE original.media_asset_id = asset.id
              AND original.role = 'ORIGINAL_UPLOAD'
              AND original.storage_area = 'private')`;
      return row
        ? Object.freeze({
            status: row.status,
            canBind:
              party.acceptsContent && row.canonicalReady && !row.alreadyBound,
          })
        : null;
    });
  }

  return Object.freeze({
    openCase,
    addStatement,
    addEvidence,
    listCases,
    getCase,
    prepareEvidenceUpload,
    getEvidenceUploadStatus,
  });
}

export function createDisputeEvidenceMediaAccessResolver(
  sql: RootSql,
): MediaEntityAccessResolver {
  return Object.freeze({
    async resolvePrivateMediaAccess(snapshot: PrivateMediaDeliverySnapshot) {
      const disputeId = snapshot.asset.provenanceEntityId;
      if (
        snapshot.asset.purpose !== "DISPUTE_EVIDENCE" ||
        snapshot.asset.provenanceEntityType !== "DISPUTE_CASE" ||
        disputeId === null ||
        !uuid.test(disputeId) ||
        snapshot.asset.provenanceEntityRevision !== null
      )
        return createServerMediaEntityAccess({ revision: "dispute:invalid" });
      const [row] = await sql<
        Array<{ stateRevision: number; role: string | null; bound: boolean }>
      >`
        SELECT dispute.state_revision AS "stateRevision",
          dispute_actor_role(dispute.job_id,
            ${snapshot.actor.userId}::uuid)::text AS role,
          EXISTS (SELECT 1 FROM dispute_case_evidence evidence
            WHERE evidence.dispute_id = dispute.id
              AND evidence.media_asset_id = ${snapshot.asset.id}) AS bound
        FROM current_dispute_cases dispute
        WHERE dispute.id = ${disputeId}`;
      const allowed =
        row !== undefined &&
        row.bound &&
        (row.role === "CUSTOMER" || row.role === "PRIMARY_PROVIDER");
      return createServerMediaEntityAccess({
        grants: allowed ? ["DISPUTE_CASE_MEMBER"] : [],
        revision:
          row === undefined
            ? `dispute:${disputeId}:missing`
            : `dispute:${disputeId}:${row.stateRevision}:${row.bound ? "bound" : "unbound"}:${row.role ?? "none"}`,
      });
    },
  });
}

async function authorizeParty(
  tx: TransactionSql,
  actorUserId: string,
  jobId: string,
  lock: boolean,
): Promise<Party | null> {
  const lockClause = lock ? tx`FOR UPDATE OF job` : tx``;
  const [row] = await tx<Array<{ role: string | null }>>`
    SELECT dispute_actor_role(job.id, ${actorUserId}::uuid)::text AS role
    FROM jobs job WHERE job.id = ${jobId} ${lockClause}`;
  return row?.role === "CUSTOMER" || row?.role === "PRIMARY_PROVIDER"
    ? { role: row.role }
    : null;
}

async function authorizeCase(
  tx: TransactionSql,
  actorUserId: string,
  jobId: string,
  disputeId: string,
  lock: boolean,
): Promise<(Party & { acceptsContent: boolean }) | null> {
  const lockClause = lock ? tx`FOR UPDATE OF identity` : tx``;
  const [row] = await tx<
    Array<{ role: string | null; state: string; acceptsContent: boolean }>
  >`
    SELECT dispute_actor_role(identity.job_id,
        ${actorUserId}::uuid)::text AS role,
      current.state::text,
      current.state IN ('OPEN', 'WAITING_FOR_PARTY', 'UNDER_REVIEW')
        AS "acceptsContent"
    FROM dispute_cases identity
    JOIN current_dispute_cases current ON current.id = identity.id
    WHERE identity.id = ${disputeId} AND identity.job_id = ${jobId}
    ${lockClause}`;
  return row && (row.role === "CUSTOMER" || row.role === "PRIMARY_PROVIDER")
    ? { role: row.role, acceptsContent: row.acceptsContent }
    : null;
}

async function existingCommand(
  tx: TransactionSql,
  commandId: string,
): Promise<ExistingCommand | null> {
  const rows = await tx<ExistingCommand[]>`
    SELECT dispute.id, 'CASE' AS kind,
      dispute.opened_by_user_id AS "actorUserId",
      dispute.id AS "disputeId", dispute.job_id AS "jobId",
      dispute.command_intent_sha256 AS intent,
      dispute.created_at AS "occurredAt"
    FROM dispute_cases dispute WHERE dispute.id = ${commandId}
    UNION ALL
    SELECT statement.id, 'STATEMENT' AS kind,
      statement.author_user_id AS "actorUserId",
      statement.dispute_id AS "disputeId", dispute.job_id AS "jobId",
      statement.command_intent_sha256 AS intent,
      statement.created_at AS "occurredAt"
    FROM dispute_case_statements statement
    JOIN dispute_cases dispute ON dispute.id = statement.dispute_id
    WHERE statement.id = ${commandId}
    UNION ALL
    SELECT evidence.id, 'EVIDENCE' AS kind,
      evidence.submitted_by_user_id AS "actorUserId",
      evidence.dispute_id AS "disputeId", dispute.job_id AS "jobId",
      evidence.command_intent_sha256 AS intent,
      evidence.created_at AS "occurredAt"
    FROM dispute_case_evidence evidence
    JOIN dispute_cases dispute ON dispute.id = evidence.dispute_id
    WHERE evidence.id = ${commandId}`;
  if (rows.length > 1) throw conflict("Dispute command ID collision.");
  return rows[0] ?? null;
}

function replay(
  prior: ExistingCommand,
  kind: ExistingCommand["kind"],
  intent: string,
  actorUserId: string,
  jobId: string,
  disputeId: string = prior.disputeId,
): DisputeCommandResult {
  if (
    prior.kind !== kind ||
    prior.intent !== intent ||
    prior.actorUserId !== actorUserId ||
    prior.jobId !== jobId ||
    prior.disputeId !== disputeId
  )
    throw conflict("Dispute command ID reused with different intent.");
  return Object.freeze({
    status: "DEDUPLICATED" as const,
    id: prior.id,
    disputeId: prior.disputeId,
    occurredAt: prior.occurredAt,
  });
}

function applied(id: string, disputeId: string, occurredAt: Date) {
  return Object.freeze({
    status: "APPLIED" as const,
    id,
    disputeId,
    occurredAt,
  });
}

function mapSummary(
  row: SummaryRow,
  viewerRole: DisputePartyRole,
): DisputeCaseSummary {
  if (
    !uuid.test(row.id) ||
    !uuid.test(row.jobId) ||
    (row.openedByRole !== "CUSTOMER" &&
      row.openedByRole !== "PRIMARY_PROVIDER") ||
    !DISPUTE_CATEGORIES.includes(row.category as DisputeCategory) ||
    ![
      "OPEN",
      "WAITING_FOR_PARTY",
      "UNDER_REVIEW",
      "RESOLVED",
      "CLOSED",
    ].includes(row.state) ||
    !Number.isSafeInteger(row.stateRevision) ||
    row.stateRevision < 1 ||
    !(row.createdAt instanceof Date) ||
    !(row.stateChangedAt instanceof Date)
  )
    throw new Error("Invalid dispute case projection.");
  return Object.freeze({
    ...row,
    openedByRole: row.openedByRole,
    viewerRole,
    category: row.category as DisputeCategory,
    state: row.state as DisputeCaseState,
    canAddContent: ["OPEN", "WAITING_FOR_PARTY", "UNDER_REVIEW"].includes(
      row.state,
    ),
  });
}

function validateDetailRows(
  statements: readonly {
    id: string;
    authorRole: string;
    kind: string;
    body: string;
    createdAt: Date;
  }[],
  evidence: readonly {
    id: string;
    submittedByRole: string;
    source: string;
    mediaAssetId: string;
    mediaKind: string;
    description: string;
    displayFilename: string | null;
    contentType: string;
    createdAt: Date;
  }[],
  baseline: {
    requestRevision: number;
    requestVersion: number;
    quoteId: string;
    quoteRevision: number;
    quoteMode: string;
    pdfMediaAssetId: string | null;
  },
  changes: readonly {
    changeOrderId: string;
    revisionId: string;
    revisionNumber: number;
    title: string;
    changeDescription: string;
    approvedAt: Date;
  }[],
  timeline: readonly {
    eventId: string;
    eventType: string;
    occurredAt: Date;
  }[],
): void {
  if (
    statements.some(
      (item) =>
        !uuid.test(item.id) ||
        !["CUSTOMER", "PRIMARY_PROVIDER"].includes(item.authorRole) ||
        !["STATEMENT", "ADDENDUM"].includes(item.kind) ||
        !(item.createdAt instanceof Date),
    ) ||
    evidence.some(
      (item) =>
        !uuid.test(item.id) ||
        !uuid.test(item.mediaAssetId) ||
        !["CUSTOMER", "PRIMARY_PROVIDER"].includes(item.submittedByRole) ||
        !["NEW_UPLOAD", "EXISTING_JOB_EVIDENCE"].includes(item.source) ||
        !["IMAGE", "DOCUMENT"].includes(item.mediaKind) ||
        !["image/webp", "application/pdf"].includes(item.contentType) ||
        !(item.createdAt instanceof Date),
    ) ||
    !Number.isSafeInteger(baseline.requestRevision) ||
    baseline.requestRevision < 1 ||
    !Number.isSafeInteger(baseline.requestVersion) ||
    baseline.requestVersion < 1 ||
    !uuid.test(baseline.quoteId) ||
    !Number.isSafeInteger(baseline.quoteRevision) ||
    baseline.quoteRevision < 1 ||
    !["PLATFORM_STRUCTURED", "EXTERNAL_PDF"].includes(baseline.quoteMode) ||
    (baseline.pdfMediaAssetId !== null &&
      !uuid.test(baseline.pdfMediaAssetId)) ||
    changes.some(
      (change) =>
        !uuid.test(change.changeOrderId) ||
        !uuid.test(change.revisionId) ||
        !Number.isSafeInteger(change.revisionNumber) ||
        change.revisionNumber < 1 ||
        !(change.approvedAt instanceof Date),
    ) ||
    timeline.some(
      (event) =>
        !uuid.test(event.eventId) ||
        typeof event.eventType !== "string" ||
        !(event.occurredAt instanceof Date),
    )
  )
    throw new Error("Invalid dispute case detail projection.");
}

function validateAdminContextRows(
  requests: readonly {
    id: string;
    recipient: DisputePartyRole | "BOTH";
    requestText: string;
    replyDeadline: Date | null;
    requestedAt: Date;
  }[],
  outcome: {
    id: string;
    category: DisputeCaseOutcomeCategory;
    basis: "MUTUAL_PARTY_AGREEMENT" | "ADMINISTRATIVE_CLOSURE";
    summary: string;
    recordedAt: Date;
  } | null,
  timeline: readonly {
    eventId: string;
    action: string;
    fromState: DisputeCaseState | null;
    toState: DisputeCaseState;
    occurredAt: Date;
  }[],
): void {
  const states = [
    "OPEN",
    "WAITING_FOR_PARTY",
    "UNDER_REVIEW",
    "RESOLVED",
    "CLOSED",
  ];
  if (
    requests.some(
      (request) =>
        !uuid.test(request.id) ||
        !["CUSTOMER", "PRIMARY_PROVIDER", "BOTH"].includes(request.recipient) ||
        request.requestText.length < 1 ||
        control.test(request.requestText) ||
        (request.replyDeadline !== null &&
          !(request.replyDeadline instanceof Date)) ||
        !(request.requestedAt instanceof Date),
    ) ||
    (outcome !== null &&
      (!uuid.test(outcome.id) ||
        ![
          "RESOLVED_BY_PARTIES",
          "OPERATIONAL_ADMIN_RESOLUTION",
          "NO_ACTION",
          "REFERRED_OUTSIDE_PLATFORM",
          "ACCOUNT_POLICY_ACTION",
          "OTHER",
        ].includes(outcome.category) ||
        !["MUTUAL_PARTY_AGREEMENT", "ADMINISTRATIVE_CLOSURE"].includes(
          outcome.basis,
        ) ||
        outcome.summary.length < 1 ||
        control.test(outcome.summary) ||
        !(outcome.recordedAt instanceof Date))) ||
    timeline.some(
      (event) =>
        !uuid.test(event.eventId) ||
        ![
          "OPEN",
          "START_REVIEW",
          "REQUEST_INFORMATION",
          "RECORD_OUTCOME",
          "CLOSE",
          "REOPEN",
        ].includes(event.action) ||
        (event.fromState !== null && !states.includes(event.fromState)) ||
        !states.includes(event.toState) ||
        !(event.occurredAt instanceof Date),
    )
  )
    throw new Error("Invalid dispute administrative context projection.");
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function conflict(message: string): DisputeIdempotencyError {
  return new DisputeIdempotencyError(message);
}
function bounded(value: string, minimum: number, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < minimum ||
    value.length > maximum ||
    control.test(value)
  )
    throw new TypeError("Invalid dispute text.");
  return value;
}
function ids(...values: string[]): void {
  if (values.some((value) => typeof value !== "string" || !uuid.test(value)))
    throw new TypeError("Invalid dispute identity.");
}
async function lockCommand(tx: TransactionSql, id: string): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${id}::text, 51021))`;
}
function transaction<T>(
  sql: RootSql,
  work: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return ("savepoint" in sql
    ? sql.savepoint(work)
    : sql.begin(work)) as unknown as Promise<T>;
}
