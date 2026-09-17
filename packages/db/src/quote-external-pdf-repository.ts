import { createHash } from "node:crypto";

import {
  ExternalPdfQuoteIdempotencyError,
  normalizeExternalPdfQuoteEnvelope,
  normalizeSaveExternalPdfQuoteDraftInput,
  type ExternalPdfQuotePersistence,
  type ExternalPdfQuoteRevision,
  type QuoteId,
  type ReadExternalPdfQuoteInput,
  type SaveExternalPdfQuoteDraftInput,
  type SaveExternalPdfQuoteDraftResult,
} from "@portal/domain";
import {
  PRIVATE_MEDIA_DOWNLOAD_PATH,
  createServerMediaEntityAccess,
  createServerMediaProvenance,
  type MediaEntityAccessResolver,
  type PrivateMediaDeliverySnapshot,
  type QuoteDocumentUploadAuthorization,
} from "@portal/media";
import type { Sql, TransactionSql } from "postgres";

type RootOrTransactionSql = Sql | TransactionSql;

interface ContextRow {
  readonly conversationId: string;
  readonly invitationId: string;
}
interface CommandRow {
  readonly actorUserId: string;
  readonly payloadFingerprint: string;
  readonly pdfAssetId: string;
  readonly quoteId: string;
  readonly quoteRevision: number;
  readonly resultingContentRevision: number;
}
interface ContentRow {
  readonly confirmedAt: Date;
  readonly contentRevision: number;
  readonly currency: string;
  readonly depositAmountCents: string | null;
  readonly depositMode: string | null;
  readonly depositPercentageBasisPoints: number | null;
  readonly estimatedDurationDays: number | null;
  readonly estimatedStartOn: string | null;
  readonly materialResponsibility: string | null;
  readonly pdfAssetId: string;
  readonly priceMode: string;
  readonly providerConfirmedSummaryMatchesPdf: boolean;
  readonly quoteId: string;
  readonly quoteRevision: number;
  readonly rangeMaximumCents: string | null;
  readonly rangeMinimumCents: string | null;
  readonly savedAt: Date;
  readonly totalAmountCents: string | null;
  readonly validUntil: Date | null;
  readonly vatStatus: string;
}
interface DeliveryRow {
  readonly actorStateChangedAt: Date;
  readonly bindingKind: "EXTERNAL_PDF" | "SUPPORTING";
  readonly contentRevision: number;
  readonly participantRole: "CRAFTSMAN" | "CUSTOMER";
  readonly quoteId: string;
  readonly quoteRevision: number;
  readonly state: string;
  readonly stateRevision: number;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const quoteRevisionStatePattern =
  /^(?:DRAFT|SUBMITTED|SUPERSEDED|REJECTED|WITHDRAWN|EXPIRED|ACCEPTED|NOT_SELECTED)$/u;

export function createExternalPdfQuoteRepository(
  sql: RootOrTransactionSql,
): ExternalPdfQuotePersistence {
  return Object.freeze({
    readOwned(input: ReadExternalPdfQuoteInput) {
      assertRead(input);
      return withTransaction(sql, (transaction) =>
        readOwned(transaction, input),
      );
    },
    saveDraft(input: SaveExternalPdfQuoteDraftInput) {
      return saveDraft(sql, normalizeSaveExternalPdfQuoteDraftInput(input));
    },
  });
}

async function saveDraft(
  sql: RootOrTransactionSql,
  input: SaveExternalPdfQuoteDraftInput,
): Promise<SaveExternalPdfQuoteDraftResult> {
  const fingerprint = commandFingerprint(input);
  try {
    return await withTransaction(sql, async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${input.commandId}, 50001))`;
      if (!(await authorizeProviderLineage(transaction, input)))
        return { status: "NOT_FOUND" } as const;
      const [existing] = await transaction<CommandRow[]>`
        SELECT actor_user_id AS "actorUserId", quote_id AS "quoteId",
          quote_revision AS "quoteRevision", pdf_media_asset_id AS "pdfAssetId",
          payload_fingerprint AS "payloadFingerprint",
          resulting_content_revision AS "resultingContentRevision"
        FROM quote_external_pdf_authoring_commands
        WHERE command_id = ${input.commandId}
      `;
      if (existing !== undefined) {
        if (
          existing.actorUserId !== input.actorUserId ||
          existing.quoteId !== input.quoteId ||
          existing.quoteRevision !== input.quoteRevision ||
          existing.pdfAssetId !== input.pdfAssetId ||
          existing.payloadFingerprint !== fingerprint
        )
          throw new ExternalPdfQuoteIdempotencyError(
            "External PDF command id reused with another intent.",
          );
        return Object.freeze({
          revision: await loadRevision(
            transaction,
            input.quoteId,
            input.quoteRevision,
            existing.resultingContentRevision,
          ),
          status: "DEDUPLICATED" as const,
        });
      }
      const [command] = await transaction<
        Array<{ readonly resultingContentRevision: number }>
      >`
        INSERT INTO quote_external_pdf_authoring_commands (
          command_id, quote_id, quote_revision, actor_user_id,
          pdf_media_asset_id, provider_confirmed_summary_matches_pdf,
          expected_content_revision,
          resulting_content_revision, payload_fingerprint, created_at
        ) VALUES (${input.commandId}, ${input.quoteId}, ${input.quoteRevision},
          ${input.actorUserId}, ${input.pdfAssetId},
          ${input.envelope.providerConfirmedSummaryMatchesPdf},
          ${input.expectedContentRevision},
          1, ${fingerprint}, clock_timestamp())
        RETURNING resulting_content_revision AS "resultingContentRevision"
      `;
      if (command === undefined)
        throw new Error("External PDF command missing.");
      const existingBinding = await transaction`
        SELECT quote_id FROM quote_external_pdf_documents
        WHERE quote_id = ${input.quoteId}
          AND quote_revision = ${input.quoteRevision}
          AND pdf_media_asset_id = ${input.pdfAssetId}
      `;
      if (existingBinding.length === 0) {
        await transaction`
          INSERT INTO quote_external_pdf_documents (
            quote_id, quote_revision, pdf_media_asset_id,
            attached_by_command_id, attached_at
          ) VALUES (${input.quoteId}, ${input.quoteRevision},
            ${input.pdfAssetId}, ${input.commandId}, clock_timestamp())
        `;
      }
      await insertContent(transaction, input);
      return Object.freeze({
        revision: await loadRevision(
          transaction,
          input.quoteId,
          input.quoteRevision,
          command.resultingContentRevision,
        ),
        status: "SAVED" as const,
      });
    });
  } catch (error) {
    if (error instanceof ExternalPdfQuoteIdempotencyError) throw error;
    const message = error instanceof Error ? error.message : "";
    if (/owned external PDF Quote context required/u.test(message))
      return { status: "NOT_FOUND" };
    if (
      /writable external PDF Quote context|editable EXTERNAL_PDF Quote draft required/u.test(
        message,
      )
    )
      return { status: "READ_ONLY" };
    if (/exact READY private Quote PDF required/u.test(message))
      return { status: "PDF_NOT_READY" };
    if (/content revision is stale/u.test(message))
      return { status: "STALE_REVISION" };
    throw error;
  }
}

async function insertContent(
  sql: TransactionSql,
  input: SaveExternalPdfQuoteDraftInput,
): Promise<void> {
  const value = normalizeExternalPdfQuoteEnvelope(input.envelope);
  await sql`
    INSERT INTO quote_external_pdf_content_revisions (
      quote_id, quote_revision, content_revision, command_id,
      pdf_media_asset_id, price_mode, currency, total_amount_cents,
      range_minimum_cents, range_maximum_cents, vat_status,
      estimated_start_on, estimated_duration_days, valid_until,
      material_responsibility, deposit_mode, deposit_amount_cents,
      deposit_percentage_basis_points, provider_confirmed_summary_matches_pdf,
      confirmed_at, saved_at
    ) VALUES (${input.quoteId}, ${input.quoteRevision}, 1, ${input.commandId},
      ${input.pdfAssetId}, ${value.priceMode}, ${value.currency},
      ${value.totalAmountCents}, ${value.rangeMinimumCents}, ${value.rangeMaximumCents},
      ${value.vatStatus}, ${value.estimatedStartOn}, ${value.estimatedDurationDays},
      ${value.validUntil}, ${value.materialResponsibility}, ${value.depositMode},
      ${value.depositAmountCents}, ${value.depositPercentageBasisPoints}, true,
      clock_timestamp(), clock_timestamp())
  `;
}

async function authorizeProviderLineage(
  sql: TransactionSql,
  input: {
    readonly actorUserId: string;
    readonly quoteId: string;
    readonly quoteRevision: number;
  },
): Promise<boolean> {
  const actor = await sql`SELECT id FROM users WHERE id = ${input.actorUserId}
    AND account_state = 'ACTIVE' FOR UPDATE`;
  if (actor.length !== 1) return false;
  const [context] = await sql<ContextRow[]>`
    SELECT quote.invitation_id AS "invitationId", quote.conversation_id AS "conversationId"
    FROM quotes quote
    JOIN quote_revision_identities revision ON revision.quote_id = quote.id
      AND revision.revision = ${input.quoteRevision}
      AND revision.authoring_mode = 'EXTERNAL_PDF'
    JOIN current_conversations conversation ON conversation.id = quote.conversation_id
    JOIN craftsman_profiles craftsman ON craftsman.id = conversation.craftsman_profile_id
    WHERE quote.id = ${input.quoteId} AND craftsman.owner_user_id = ${input.actorUserId}
  `;
  if (context === undefined) return false;
  await sql`SELECT id FROM job_invitations WHERE id = ${context.invitationId} FOR UPDATE`;
  await sql`SELECT id FROM conversations WHERE id = ${context.conversationId} FOR UPDATE`;
  const quote =
    await sql`SELECT id FROM quotes WHERE id = ${input.quoteId} FOR UPDATE`;
  return quote.length === 1;
}

async function readOwned(
  sql: TransactionSql,
  input: ReadExternalPdfQuoteInput,
): Promise<ExternalPdfQuoteRevision | null> {
  const actor = await sql`SELECT id FROM users WHERE id = ${input.actorUserId}
    AND account_state = 'ACTIVE' FOR UPDATE`;
  if (actor.length !== 1) return null;
  const context = await sql`
    SELECT quote.id FROM quotes quote
    JOIN current_conversations conversation ON conversation.id = quote.conversation_id
    JOIN customer_profiles customer ON customer.id = conversation.customer_profile_id
    JOIN craftsman_profiles craftsman ON craftsman.id = conversation.craftsman_profile_id
    JOIN quote_revision_identities revision ON revision.quote_id = quote.id
      AND revision.revision = ${input.quoteRevision} AND revision.authoring_mode = 'EXTERNAL_PDF'
    JOIN quote_revision_heads head ON head.quote_id = quote.id
      AND head.quote_revision = revision.revision
    WHERE quote.id = ${input.quoteId} AND (craftsman.owner_user_id = ${input.actorUserId}
      OR (customer.owner_user_id = ${input.actorUserId} AND head.state <> 'DRAFT'))
    FOR UPDATE OF quote, customer, craftsman
  `;
  if (context.length !== 1) return null;
  const [row] = await selectCurrent(sql, input.quoteId, input.quoteRevision);
  return row === undefined ? null : toRevision(row);
}

function selectCurrent(
  sql: TransactionSql,
  quoteId: QuoteId,
  quoteRevision: number,
): Promise<ContentRow[]> {
  return sql<ContentRow[]>`
    SELECT quote_id AS "quoteId", quote_revision AS "quoteRevision",
      content_revision AS "contentRevision", pdf_media_asset_id AS "pdfAssetId",
      price_mode::text AS "priceMode", currency,
      total_amount_cents::text AS "totalAmountCents",
      range_minimum_cents::text AS "rangeMinimumCents",
      range_maximum_cents::text AS "rangeMaximumCents", vat_status::text AS "vatStatus",
      estimated_start_on::text AS "estimatedStartOn",
      estimated_duration_days AS "estimatedDurationDays", valid_until AS "validUntil",
      material_responsibility::text AS "materialResponsibility",
      deposit_mode::text AS "depositMode", deposit_amount_cents::text AS "depositAmountCents",
      deposit_percentage_basis_points AS "depositPercentageBasisPoints",
      provider_confirmed_summary_matches_pdf AS "providerConfirmedSummaryMatchesPdf",
      confirmed_at AS "confirmedAt", saved_at AS "savedAt"
    FROM current_quote_external_pdf_content
    WHERE quote_id = ${quoteId} AND quote_revision = ${quoteRevision}
  `;
}

async function loadRevision(
  sql: TransactionSql,
  quoteId: QuoteId,
  quoteRevision: number,
  contentRevision: number,
): Promise<ExternalPdfQuoteRevision> {
  const [row] = await sql<ContentRow[]>`
    SELECT quote_id AS "quoteId", quote_revision AS "quoteRevision",
      content_revision AS "contentRevision", pdf_media_asset_id AS "pdfAssetId",
      price_mode::text AS "priceMode", currency,
      total_amount_cents::text AS "totalAmountCents",
      range_minimum_cents::text AS "rangeMinimumCents",
      range_maximum_cents::text AS "rangeMaximumCents", vat_status::text AS "vatStatus",
      estimated_start_on::text AS "estimatedStartOn",
      estimated_duration_days AS "estimatedDurationDays", valid_until AS "validUntil",
      material_responsibility::text AS "materialResponsibility",
      deposit_mode::text AS "depositMode", deposit_amount_cents::text AS "depositAmountCents",
      deposit_percentage_basis_points AS "depositPercentageBasisPoints",
      provider_confirmed_summary_matches_pdf AS "providerConfirmedSummaryMatchesPdf",
      confirmed_at AS "confirmedAt", saved_at AS "savedAt"
    FROM quote_external_pdf_content_revisions
    WHERE quote_id = ${quoteId} AND quote_revision = ${quoteRevision}
      AND content_revision = ${contentRevision}
  `;
  if (row === undefined) throw new Error("External PDF Quote effect missing.");
  return toRevision(row);
}

function toRevision(row: ContentRow): ExternalPdfQuoteRevision {
  if (
    !uuidPattern.test(row.quoteId) ||
    !uuidPattern.test(row.pdfAssetId) ||
    !Number.isSafeInteger(row.quoteRevision) ||
    row.quoteRevision < 1 ||
    !Number.isSafeInteger(row.contentRevision) ||
    row.contentRevision < 1 ||
    !(row.confirmedAt instanceof Date) ||
    !Number.isFinite(row.confirmedAt.valueOf()) ||
    !(row.savedAt instanceof Date) ||
    !Number.isFinite(row.savedAt.valueOf()) ||
    row.confirmedAt.valueOf() !== row.savedAt.valueOf()
  )
    throw new Error("Corrupt external PDF Quote projection.");
  const envelope = normalizeExternalPdfQuoteEnvelope({
    currency: row.currency as "EUR",
    depositAmountCents: parseAmount(row.depositAmountCents),
    depositMode: row.depositMode as never,
    depositPercentageBasisPoints: row.depositPercentageBasisPoints,
    estimatedDurationDays: row.estimatedDurationDays,
    estimatedStartOn: row.estimatedStartOn,
    materialResponsibility: row.materialResponsibility as never,
    priceMode: row.priceMode as never,
    providerConfirmedSummaryMatchesPdf:
      row.providerConfirmedSummaryMatchesPdf as true,
    rangeMaximumCents: parseAmount(row.rangeMaximumCents),
    rangeMinimumCents: parseAmount(row.rangeMinimumCents),
    totalAmountCents: parseAmount(row.totalAmountCents),
    validUntil: row.validUntil,
    vatStatus: row.vatStatus as never,
  });
  return Object.freeze({
    ...envelope,
    confirmedAt: new Date(row.confirmedAt),
    contentRevision: row.contentRevision,
    pdfAssetId: row.pdfAssetId,
    pdfDownloadPath: PRIVATE_MEDIA_DOWNLOAD_PATH.replace(
      ":mediaAssetId",
      row.pdfAssetId,
    ),
    quoteId: row.quoteId as QuoteId,
    quoteRevision: row.quoteRevision,
    savedAt: new Date(row.savedAt),
  });
}

export function createQuoteDocumentUploadAuthorization(
  sql: Sql,
): QuoteDocumentUploadAuthorization {
  return Object.freeze({
    async prepareUpload(
      input: Parameters<QuoteDocumentUploadAuthorization["prepareUpload"]>[0],
    ) {
      if (
        !uuidPattern.test(input.actorUserId) ||
        !uuidPattern.test(input.quoteId) ||
        !Number.isSafeInteger(input.quoteRevision) ||
        input.quoteRevision < 1
      )
        return { status: "UPLOAD_UNAVAILABLE" } as const;
      return sql.begin(async (transaction) => {
        if (!(await authorizeProviderLineage(transaction, input)))
          return { status: "UPLOAD_UNAVAILABLE" } as const;
        const rows = await transaction`
          SELECT head.quote_id FROM quote_revision_heads head
          JOIN quotes quote ON quote.id = head.quote_id
          WHERE head.quote_id = ${input.quoteId} AND head.quote_revision = ${input.quoteRevision}
            AND head.state = 'DRAFT'
            AND quote_active_participant_context(
              quote.conversation_id, ${input.actorUserId}, 'CRAFTSMAN', true
            )
          FOR UPDATE OF head
        `;
        if (rows.length !== 1) return { status: "UPLOAD_UNAVAILABLE" } as const;
        return Object.freeze({
          provenance: createServerMediaProvenance({
            entityId: input.quoteId,
            entityRevision: input.quoteRevision,
            entityType: "QUOTE_REVISION",
          }),
          purpose: "QUOTE_DOCUMENT" as const,
          status: "AUTHORIZED" as const,
        });
      });
    },
  });
}

export function createQuoteDocumentMediaAccessResolver(
  sql: Sql,
): MediaEntityAccessResolver {
  return Object.freeze({
    async resolvePrivateMediaAccess(snapshot: PrivateMediaDeliverySnapshot) {
      if (
        snapshot.asset.purpose !== "QUOTE_DOCUMENT" ||
        snapshot.asset.provenanceEntityType !== "QUOTE_REVISION" ||
        snapshot.asset.provenanceEntityId === null ||
        snapshot.asset.provenanceEntityRevision === null
      )
        throw new Error("Unbound Quote document.");
      const [row] = await sql<DeliveryRow[]>`
        SELECT quote.id AS "quoteId", revision.revision AS "quoteRevision",
          head.state::text AS state, head.state_revision AS "stateRevision",
          coalesce(pdf_content.content_revision,
            structured_content.content_revision, 0) AS "contentRevision",
          CASE WHEN supporting.media_asset_id IS NOT NULL
            THEN 'SUPPORTING' ELSE 'EXTERNAL_PDF' END AS "bindingKind",
          actor.account_state_changed_at AS "actorStateChangedAt",
          CASE WHEN craftsman.owner_user_id = actor.id THEN 'CRAFTSMAN' ELSE 'CUSTOMER' END AS "participantRole"
        FROM media_assets asset
        JOIN quotes quote ON quote.id = asset.provenance_entity_id
        JOIN quote_revision_identities revision ON revision.quote_id = quote.id
          AND revision.revision = asset.provenance_entity_revision
        JOIN quote_revision_heads head ON head.quote_id = quote.id AND head.quote_revision = revision.revision
        LEFT JOIN quote_external_pdf_documents document
          ON document.quote_id = quote.id
          AND document.quote_revision = revision.revision
          AND document.pdf_media_asset_id = asset.id
        LEFT JOIN current_quote_revision_supporting_documents supporting
          ON supporting.quote_id = quote.id
          AND supporting.quote_revision = revision.revision
          AND supporting.media_asset_id = asset.id
        LEFT JOIN current_quote_external_pdf_content pdf_content
          ON pdf_content.quote_id = quote.id
          AND pdf_content.quote_revision = revision.revision
        LEFT JOIN current_quote_structured_content structured_content
          ON structured_content.quote_id = quote.id
          AND structured_content.quote_revision = revision.revision
        JOIN current_conversations conversation ON conversation.id = quote.conversation_id
        JOIN customer_profiles customer ON customer.id = conversation.customer_profile_id
        JOIN craftsman_profiles craftsman ON craftsman.id = conversation.craftsman_profile_id
        JOIN users actor ON actor.id = ${snapshot.actor.userId} AND actor.account_state = 'ACTIVE'
        WHERE asset.id = ${snapshot.asset.id} AND asset.owner_user_id = craftsman.owner_user_id
          AND asset.provenance_entity_id = quote.id AND asset.provenance_entity_revision = revision.revision
          AND (document.pdf_media_asset_id IS NOT NULL
            OR supporting.media_asset_id IS NOT NULL)
          AND (craftsman.owner_user_id = actor.id OR (customer.owner_user_id = actor.id
            AND head.state <> 'DRAFT'
            AND (supporting.media_asset_id IS NOT NULL
              OR pdf_content.pdf_media_asset_id = asset.id)))
      `;
      if (
        row === undefined ||
        !uuidPattern.test(row.quoteId) ||
        row.quoteRevision < 1 ||
        !Number.isSafeInteger(row.contentRevision) ||
        row.contentRevision < 0 ||
        (row.bindingKind !== "EXTERNAL_PDF" &&
          row.bindingKind !== "SUPPORTING") ||
        !quoteRevisionStatePattern.test(row.state) ||
        (row.participantRole !== "CRAFTSMAN" &&
          row.participantRole !== "CUSTOMER") ||
        !Number.isSafeInteger(row.stateRevision) ||
        row.stateRevision < 1 ||
        !(row.actorStateChangedAt instanceof Date) ||
        !Number.isFinite(row.actorStateChangedAt.getTime())
      )
        throw new Error("Unbound Quote document.");
      return createServerMediaEntityAccess({
        grants: [
          row.participantRole === "CRAFTSMAN"
            ? "QUOTE_AUTHOR"
            : "QUOTE_REQUEST_CUSTOMER",
        ],
        revision: [
          "quote-document",
          row.quoteId,
          row.quoteRevision,
          row.bindingKind,
          row.state,
          row.stateRevision,
          row.contentRevision,
          snapshot.asset.id,
          row.actorStateChangedAt.toISOString(),
        ].join(":"),
      });
    },
  });
}

function assertRead(input: ReadExternalPdfQuoteInput): void {
  if (
    !uuidPattern.test(input.actorUserId) ||
    !uuidPattern.test(input.quoteId) ||
    !Number.isSafeInteger(input.quoteRevision) ||
    input.quoteRevision < 1
  )
    throw new TypeError("Invalid external PDF Quote read.");
}
function parseAmount(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed))
    throw new Error("Corrupt external PDF amount.");
  return parsed;
}
function commandFingerprint(input: SaveExternalPdfQuoteDraftInput): string {
  return createHash("sha256")
    .update(JSON.stringify({ ...input, commandId: undefined }))
    .digest("hex");
}
function withTransaction<T>(
  sql: RootOrTransactionSql,
  callback: (transaction: TransactionSql) => Promise<T>,
): Promise<T> {
  return ("savepoint" in sql
    ? sql.savepoint(callback)
    : sql.begin((transaction) =>
        callback(transaction),
      )) as unknown as Promise<T>;
}
