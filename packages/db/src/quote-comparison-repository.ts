import {
  normalizeQuoteComparisonReadInput,
  serializeQuoteComparison,
  type QuoteComparison,
  type QuoteComparisonPersistence,
  type QuoteComparisonReadInput,
} from "@portal/domain";
import type { Sql, TransactionSql } from "postgres";

interface ComparisonRow {
  readonly authoringEligible: boolean;
  readonly authoringMode: string;
  readonly conditionalOnInspection: boolean | null;
  readonly conversationPath: string;
  readonly depositAmountCents: string | null;
  readonly depositMode: string | null;
  readonly depositPercentageBasisPoints: number | null;
  readonly depositNotes: string | null;
  readonly estimatedDurationDays: number | null;
  readonly estimatedStartOn: string | null;
  readonly externalDocumentReady: boolean;
  readonly externalSummaryConfirmed: boolean | null;
  readonly excludedScope: string[] | null;
  readonly includedScope: string[] | null;
  readonly inspectionConditions: string | null;
  readonly laborAmountCents: string | null;
  readonly laborDescription: string | null;
  readonly materialResponsibility: string | null;
  readonly lifecycleAcceptanceEligible: boolean;
  readonly materiallyStale: boolean;
  readonly pdfDownloadPath: string | null;
  readonly priceBasis: string | null;
  readonly priceMode: string;
  readonly providerApprovedCredentialCount: string | number;
  readonly providerDisplayName: string;
  readonly providerIdentityVerified: boolean;
  readonly quoteId: string;
  readonly quoteRevision: number;
  readonly rangeMaximumCents: string | null;
  readonly rangeMinimumCents: string | null;
  readonly submittedAt: Date;
  readonly summary: string | null;
  readonly title: string | null;
  readonly totalAmountCents: string | null;
  readonly travelAmountCents: string | null;
  readonly travelDescription: string | null;
  readonly materialAmountCents: string | null;
  readonly materialDescription: string | null;
  readonly otherAmountCents: string | null;
  readonly otherDescription: string | null;
  readonly providerNotes: string | null;
  readonly validUntil: Date | null;
  readonly vatStatus: string;
  readonly warrantyInformation: string | null;
}

export function createQuoteComparisonRepository(
  sql: Sql,
): QuoteComparisonPersistence {
  return Object.freeze({
    readCurrent(
      input: QuoteComparisonReadInput,
    ): Promise<QuoteComparison | null> {
      const normalized = normalizeQuoteComparisonReadInput(input);
      return sql.begin(async (transaction) =>
        readSnapshot(transaction, normalized),
      );
    },
  });
}

async function readSnapshot(
  sql: TransactionSql,
  input: Required<QuoteComparisonReadInput>,
): Promise<QuoteComparison | null> {
  const authorization = await sql`
    SELECT request.id
    FROM users actor
    JOIN customer_profiles customer ON customer.owner_user_id = actor.id
    JOIN job_requests request ON request.customer_profile_id = customer.id
    WHERE actor.id = ${input.actorUserId}
      AND actor.account_state = 'ACTIVE'
      AND request.id = ${input.jobRequestId}
    FOR UPDATE OF actor, customer, request
  `;
  if (authorization.length !== 1) return null;

  const rows = await sql<ComparisonRow[]>`
    SELECT
      lifecycle.authoring_eligible AS "authoringEligible",
      submitted.authoring_mode::text AS "authoringMode",
      CASE WHEN submitted.authoring_mode = 'PLATFORM_STRUCTURED'
        THEN structured.conditional_on_inspection ELSE NULL END AS "conditionalOnInspection",
      '/konverzacie/pozvanka/' || quote.invitation_id::text AS "conversationPath",
      CASE WHEN submitted.authoring_mode = 'PLATFORM_STRUCTURED'
        THEN structured.deposit_amount_cents::text ELSE external.deposit_amount_cents::text END AS "depositAmountCents",
      CASE WHEN submitted.authoring_mode = 'PLATFORM_STRUCTURED'
        THEN structured.deposit_mode::text ELSE external.deposit_mode::text END AS "depositMode",
      CASE WHEN submitted.authoring_mode = 'PLATFORM_STRUCTURED'
        THEN structured.deposit_percentage_basis_points ELSE external.deposit_percentage_basis_points END AS "depositPercentageBasisPoints",
      CASE WHEN submitted.authoring_mode = 'PLATFORM_STRUCTURED'
        THEN structured.deposit_notes ELSE NULL END AS "depositNotes",
      CASE WHEN submitted.authoring_mode = 'PLATFORM_STRUCTURED'
        THEN structured.estimated_duration_days ELSE external.estimated_duration_days END AS "estimatedDurationDays",
      CASE WHEN submitted.authoring_mode = 'PLATFORM_STRUCTURED'
        THEN structured.estimated_start_on::text ELSE external.estimated_start_on::text END AS "estimatedStartOn",
      (external.provider_confirmed_summary_matches_pdf IS TRUE
        AND external_document.quote_id IS NOT NULL AND external_asset.id IS NOT NULL
        AND external_object.id IS NOT NULL) AS "externalDocumentReady",
      external.provider_confirmed_summary_matches_pdf AS "externalSummaryConfirmed",
      CASE WHEN submitted.authoring_mode = 'PLATFORM_STRUCTURED'
        THEN structured.excluded_scope ELSE NULL END AS "excludedScope",
      CASE WHEN submitted.authoring_mode = 'PLATFORM_STRUCTURED'
        THEN structured.included_scope ELSE NULL END AS "includedScope",
      CASE WHEN submitted.authoring_mode = 'PLATFORM_STRUCTURED'
        THEN structured.inspection_conditions ELSE NULL END AS "inspectionConditions",
      CASE WHEN submitted.authoring_mode = 'PLATFORM_STRUCTURED'
        THEN structured.labor_amount_cents::text ELSE NULL END AS "laborAmountCents",
      CASE WHEN submitted.authoring_mode = 'PLATFORM_STRUCTURED'
        THEN structured.labor_description ELSE NULL END AS "laborDescription",
      CASE WHEN submitted.authoring_mode = 'PLATFORM_STRUCTURED'
        THEN structured.material_amount_cents::text ELSE NULL END AS "materialAmountCents",
      CASE WHEN submitted.authoring_mode = 'PLATFORM_STRUCTURED'
        THEN structured.material_description ELSE NULL END AS "materialDescription",
      CASE WHEN submitted.authoring_mode = 'PLATFORM_STRUCTURED'
        THEN structured.material_responsibility::text ELSE external.material_responsibility::text END AS "materialResponsibility",
      lifecycle.lifecycle_acceptance_eligible AS "lifecycleAcceptanceEligible",
      lifecycle.materially_stale AS "materiallyStale",
      CASE WHEN submitted.authoring_mode = 'EXTERNAL_PDF'
        THEN '/v1/media/' || external.pdf_media_asset_id::text || '/download' ELSE NULL END AS "pdfDownloadPath",
      CASE WHEN submitted.authoring_mode = 'PLATFORM_STRUCTURED'
        THEN structured.price_basis ELSE NULL END AS "priceBasis",
      CASE WHEN submitted.authoring_mode = 'PLATFORM_STRUCTURED'
        THEN structured.provider_notes ELSE NULL END AS "providerNotes",
      CASE WHEN submitted.authoring_mode = 'PLATFORM_STRUCTURED'
        THEN structured.price_mode::text ELSE external.price_mode::text END AS "priceMode",
      (SELECT count(DISTINCT claim.credential_type_code)::text
        FROM credential_claims claim
        WHERE claim.craftsman_profile_id = craftsman.id
          AND claim.state = 'APPROVED'
          AND (claim.expires_on IS NULL OR claim.expires_on >= CURRENT_DATE)
      ) AS "providerApprovedCredentialCount",
      CASE WHEN craftsman.profile_type = 'COMPANY'
        THEN craftsman.official_company_name
        ELSE coalesce(craftsman.nickname,
          craftsman.real_first_name || ' ' || craftsman.real_last_name)
      END AS "providerDisplayName",
      (craftsman.identity_verified_at IS NOT NULL) AS "providerIdentityVerified",
      quote.id AS "quoteId",
      submitted.revision AS "quoteRevision",
      CASE WHEN submitted.authoring_mode = 'PLATFORM_STRUCTURED'
        THEN structured.range_maximum_cents::text ELSE external.range_maximum_cents::text END AS "rangeMaximumCents",
      CASE WHEN submitted.authoring_mode = 'PLATFORM_STRUCTURED'
        THEN structured.range_minimum_cents::text ELSE external.range_minimum_cents::text END AS "rangeMinimumCents",
      submitted.submitted_at AS "submittedAt",
      CASE WHEN submitted.authoring_mode = 'PLATFORM_STRUCTURED'
        THEN structured.summary ELSE NULL END AS "summary",
      CASE WHEN submitted.authoring_mode = 'PLATFORM_STRUCTURED'
        THEN structured.title ELSE NULL END AS "title",
      CASE WHEN submitted.authoring_mode = 'PLATFORM_STRUCTURED'
        THEN structured.total_amount_cents::text ELSE external.total_amount_cents::text END AS "totalAmountCents",
      CASE WHEN submitted.authoring_mode = 'PLATFORM_STRUCTURED'
        THEN structured.transport_amount_cents::text ELSE NULL END AS "travelAmountCents",
      CASE WHEN submitted.authoring_mode = 'PLATFORM_STRUCTURED'
        THEN structured.transport_description ELSE NULL END AS "travelDescription",
      CASE WHEN submitted.authoring_mode = 'PLATFORM_STRUCTURED'
        THEN structured.other_amount_cents::text ELSE NULL END AS "otherAmountCents",
      CASE WHEN submitted.authoring_mode = 'PLATFORM_STRUCTURED'
        THEN structured.other_description ELSE NULL END AS "otherDescription",
      CASE WHEN submitted.authoring_mode = 'PLATFORM_STRUCTURED'
        THEN structured.valid_until ELSE external.valid_until END AS "validUntil",
      CASE WHEN submitted.authoring_mode = 'PLATFORM_STRUCTURED'
        THEN structured.vat_status::text ELSE external.vat_status::text END AS "vatStatus",
      CASE WHEN submitted.authoring_mode = 'PLATFORM_STRUCTURED'
        THEN structured.warranty_information ELSE NULL END AS "warrantyInformation"
    FROM current_submitted_quotes submitted
    JOIN current_quote_acceptance_context lifecycle
      ON lifecycle.quote_id = submitted.quote_id
      AND lifecycle.quote_revision = submitted.revision
      AND lifecycle.deadline_passed IS FALSE
    JOIN quotes quote ON quote.id = submitted.quote_id
    JOIN conversations conversation ON conversation.id = quote.conversation_id
      AND conversation.invitation_id = quote.invitation_id
    JOIN job_invitations invitation ON invitation.id = quote.invitation_id
      AND invitation.job_request_id = ${input.jobRequestId}
    JOIN customer_profiles customer ON customer.id = invitation.customer_profile_id
      AND customer.owner_user_id = ${input.actorUserId}
    JOIN users actor ON actor.id = customer.owner_user_id
      AND actor.account_state = 'ACTIVE'
    JOIN craftsman_profiles craftsman ON craftsman.id = invitation.craftsman_profile_id
    LEFT JOIN current_quote_structured_content structured
      ON structured.quote_id = submitted.quote_id
      AND structured.quote_revision = submitted.revision
      AND submitted.authoring_mode = 'PLATFORM_STRUCTURED'
    LEFT JOIN current_quote_external_pdf_content external
      ON external.quote_id = submitted.quote_id
      AND external.quote_revision = submitted.revision
      AND submitted.authoring_mode = 'EXTERNAL_PDF'
    LEFT JOIN quote_external_pdf_documents external_document
      ON external_document.quote_id = external.quote_id
      AND external_document.quote_revision = external.quote_revision
      AND external_document.pdf_media_asset_id = external.pdf_media_asset_id
    LEFT JOIN media_assets external_asset ON external_asset.id = external.pdf_media_asset_id
      AND external_asset.status = 'READY'
      AND external_asset.purpose = 'QUOTE_DOCUMENT'
      AND external_asset.kind = 'DOCUMENT'
      AND external_asset.declared_content_type = 'application/pdf'
      AND external_asset.provenance_entity_type = 'QUOTE_REVISION'
      AND external_asset.provenance_entity_id = submitted.quote_id
      AND external_asset.provenance_entity_revision = submitted.revision
    LEFT JOIN media_asset_storage_objects external_object
      ON external_object.media_asset_id = external.pdf_media_asset_id
      AND external_object.role = 'CANONICAL'
      AND external_object.storage_area = 'private'
      AND external_object.content_type = 'application/pdf'
      AND external_object.revoked_at IS NULL
    ORDER BY submitted.submitted_at, quote.id
    LIMIT ${QUOTE_COMPARISON_ROW_LIMIT}
  `;
  if (rows.length > 5) throw new Error("Quote comparison item bound exceeded.");
  return serializeQuoteComparison({
    items: rows.map(toCandidate),
    jobRequestId: input.jobRequestId,
    sort: input.sort,
  });
}

const QUOTE_COMPARISON_ROW_LIMIT = 6;

function toCandidate(row: ComparisonRow): unknown {
  if (
    row.authoringMode === "EXTERNAL_PDF" &&
    (row.externalDocumentReady !== true ||
      row.externalSummaryConfirmed !== true)
  ) {
    throw new Error("Corrupt external PDF Quote comparison binding.");
  }
  const submittedAt = validDate(row.submittedAt, "submittedAt");
  return {
    authoringEligible: row.authoringEligible,
    authoringMode: row.authoringMode,
    conditionalOnInspection: row.conditionalOnInspection,
    conversationPath: row.conversationPath,
    deposit: {
      amountCents: amount(row.depositAmountCents),
      mode: row.depositMode,
      percentageBasisPoints: row.depositPercentageBasisPoints,
    },
    details:
      row.authoringMode === "PLATFORM_STRUCTURED"
        ? {
            components: {
              labor: {
                amountCents: amount(row.laborAmountCents),
                description: row.laborDescription,
              },
              material: {
                amountCents: amount(row.materialAmountCents),
                description: row.materialDescription,
              },
              other: {
                amountCents: amount(row.otherAmountCents),
                description: row.otherDescription,
              },
            },
            depositNotes: row.depositNotes,
            priceBasis: row.priceBasis,
            providerNotes: row.providerNotes,
            summary: row.summary,
            title: row.title,
          }
        : null,
    estimatedDurationDays: row.estimatedDurationDays,
    estimatedStartOn: row.estimatedStartOn,
    excludedScope: row.excludedScope,
    includedScope: row.includedScope,
    inspectionConditions: row.inspectionConditions,
    materialResponsibility: row.materialResponsibility,
    lifecycleAcceptanceEligible: row.lifecycleAcceptanceEligible,
    materiallyStale: row.materiallyStale,
    pdfDownloadPath: row.pdfDownloadPath,
    price: {
      currency: "EUR",
      mode: row.priceMode,
      rangeMaximumCents: amount(row.rangeMaximumCents),
      rangeMinimumCents: amount(row.rangeMinimumCents),
      totalAmountCents: amount(row.totalAmountCents),
      vatStatus: row.vatStatus,
    },
    provider: {
      approvedCredentialCount: integer(row.providerApprovedCredentialCount),
      displayName: row.providerDisplayName,
      identityVerified: row.providerIdentityVerified,
    },
    quoteId: row.quoteId,
    quoteRevision: row.quoteRevision,
    submittedAt: submittedAt.toISOString(),
    travelAmountCents: amount(row.travelAmountCents),
    travelDescription: row.travelDescription,
    validUntil:
      row.validUntil === null
        ? null
        : validDate(row.validUntil, "validUntil").toISOString(),
    warrantyInformation: row.warrantyInformation,
  };
}

function amount(value: string | null): number | null {
  return value === null ? null : integer(value);
}
function integer(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed))
    throw new Error("Corrupt Quote comparison numeric fact.");
  return parsed;
}
function validDate(value: Date, field: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.valueOf()))
    throw new Error(`Corrupt Quote comparison ${field}.`);
  return value;
}
