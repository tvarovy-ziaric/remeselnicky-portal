import { createHash } from "node:crypto";

import {
  StructuredQuoteIdempotencyError,
  assertReadStructuredQuoteInput,
  normalizeSaveStructuredQuoteDraftInput,
  normalizeStructuredQuoteContent,
  type QuoteId,
  type ReadStructuredQuoteInput,
  type SaveStructuredQuoteDraftInput,
  type SaveStructuredQuoteDraftResult,
  type StructuredQuoteComponent,
  type StructuredQuoteContentRevision,
  type StructuredQuoteDepositMode,
  type StructuredQuoteMaterialResponsibility,
  type StructuredQuotePersistence,
  type StructuredQuotePriceMode,
  type StructuredQuoteVatStatus,
} from "@portal/domain";
import type { Sql, TransactionSql } from "postgres";

type RootOrTransactionSql = Sql | TransactionSql;

interface CommandRow {
  readonly actorUserId: string;
  readonly payloadFingerprint: string;
  readonly quoteId: string;
  readonly quoteRevision: number;
  readonly resultingContentRevision: number;
}

interface QuoteAuthorContextRow {
  readonly conversationId: string;
  readonly invitationId: string;
}

interface StructuredContentRow {
  readonly changedAt: Date;
  readonly conditionalOnInspection: boolean;
  readonly contentRevision: number;
  readonly currency: string;
  readonly depositAmountCents: string | null;
  readonly depositMode: string | null;
  readonly depositNotes: string | null;
  readonly depositPercentageBasisPoints: number | null;
  readonly estimatedDurationDays: number | null;
  readonly estimatedStartOn: string | null;
  readonly excludedScope: string[];
  readonly includedScope: string[];
  readonly inspectionConditions: string | null;
  readonly laborAmountCents: string | null;
  readonly laborDescription: string | null;
  readonly materialAmountCents: string | null;
  readonly materialDescription: string | null;
  readonly materialResponsibility: string;
  readonly otherAmountCents: string | null;
  readonly otherDescription: string | null;
  readonly priceBasis: string;
  readonly priceMode: string;
  readonly providerNotes: string | null;
  readonly quoteId: string;
  readonly quoteRevision: number;
  readonly rangeMaximumCents: string | null;
  readonly rangeMinimumCents: string | null;
  readonly summary: string;
  readonly title: string;
  readonly totalAmountCents: string | null;
  readonly transportAmountCents: string | null;
  readonly transportDescription: string | null;
  readonly validUntil: Date | null;
  readonly vatStatus: string;
  readonly warrantyInformation: string | null;
}

export function createStructuredQuoteRepository(
  sql: RootOrTransactionSql,
): StructuredQuotePersistence {
  return Object.freeze({
    readOwned(input: ReadStructuredQuoteInput) {
      assertReadStructuredQuoteInput(input);
      return withTransaction(sql, (transaction) =>
        readOwned(transaction, input),
      );
    },
    saveDraft(input: SaveStructuredQuoteDraftInput) {
      const normalized = normalizeSaveStructuredQuoteDraftInput(input);
      return saveDraft(sql, normalized);
    },
  });
}

async function saveDraft(
  sql: RootOrTransactionSql,
  input: SaveStructuredQuoteDraftInput,
): Promise<SaveStructuredQuoteDraftResult> {
  const fingerprint = fingerprintCommand(input);
  try {
    return await withTransaction(sql, async (transaction) => {
      await transaction`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${input.commandId}, 49001)
        )
      `;
      const authorized = await authorizeProviderLineage(transaction, input);
      if (!authorized) return Object.freeze({ status: "NOT_FOUND" as const });

      const [existing] = await transaction<CommandRow[]>`
        SELECT actor_user_id AS "actorUserId", quote_id AS "quoteId",
          quote_revision AS "quoteRevision",
          resulting_content_revision AS "resultingContentRevision",
          payload_fingerprint AS "payloadFingerprint"
        FROM quote_structured_authoring_commands
        WHERE command_id = ${input.commandId}
      `;
      if (existing !== undefined) {
        if (
          existing.actorUserId !== input.actorUserId ||
          existing.quoteId !== input.quoteId ||
          existing.quoteRevision !== input.quoteRevision ||
          existing.payloadFingerprint !== fingerprint
        ) {
          throw new StructuredQuoteIdempotencyError(
            "Structured Quote command id was reused with another intent.",
          );
        }
        const replay = await loadContentRevision(
          transaction,
          input.quoteId,
          input.quoteRevision,
          existing.resultingContentRevision,
        );
        return Object.freeze({ content: replay, status: "DEDUPLICATED" });
      }

      const [command] = await transaction<
        Array<{
          readonly createdAt: Date;
          readonly resultingContentRevision: number;
        }>
      >`
        INSERT INTO quote_structured_authoring_commands (
          command_id, quote_id, quote_revision, actor_user_id,
          expected_content_revision, resulting_content_revision,
          payload_fingerprint, created_at
        ) VALUES (
          ${input.commandId}, ${input.quoteId}, ${input.quoteRevision},
          ${input.actorUserId}, ${input.expectedContentRevision}, 1,
          ${fingerprint}, clock_timestamp()
        ) RETURNING created_at AS "createdAt",
          resulting_content_revision AS "resultingContentRevision"
      `;
      if (command === undefined) {
        throw new Error("Structured Quote command was not stored.");
      }
      await insertContentRevision(transaction, input, command.createdAt);
      const content = await loadContentRevision(
        transaction,
        input.quoteId,
        input.quoteRevision,
        command.resultingContentRevision,
      );
      return Object.freeze({ content, status: "SAVED" });
    });
  } catch (error) {
    if (error instanceof StructuredQuoteIdempotencyError) throw error;
    const message = error instanceof Error ? error.message : "";
    if (/owned structured Quote context required/u.test(message)) {
      return Object.freeze({ status: "NOT_FOUND" });
    }
    if (/writable structured Quote context|required.*draft/u.test(message)) {
      return Object.freeze({ status: "READ_ONLY" });
    }
    if (/content revision is stale/u.test(message)) {
      return Object.freeze({ status: "STALE_REVISION" });
    }
    throw error;
  }
}

async function authorizeProviderLineage(
  sql: TransactionSql,
  input: Pick<
    SaveStructuredQuoteDraftInput,
    "actorUserId" | "quoteId" | "quoteRevision"
  >,
): Promise<boolean> {
  const actors = await sql`
    SELECT id FROM users
    WHERE id = ${input.actorUserId} AND account_state = 'ACTIVE'
    FOR UPDATE
  `;
  if (actors.length !== 1) return false;
  const [context] = await sql<QuoteAuthorContextRow[]>`
    SELECT quote.invitation_id AS "invitationId",
      quote.conversation_id AS "conversationId"
    FROM quotes quote
    JOIN quote_revision_identities revision
      ON revision.quote_id = quote.id
      AND revision.revision = ${input.quoteRevision}
      AND revision.authoring_mode = 'PLATFORM_STRUCTURED'
    JOIN current_conversations conversation
      ON conversation.id = quote.conversation_id
    JOIN craftsman_profiles craftsman
      ON craftsman.id = conversation.craftsman_profile_id
    WHERE quote.id = ${input.quoteId}
      AND craftsman.owner_user_id = ${input.actorUserId}
  `;
  if (context === undefined) return false;
  await sql`SELECT id FROM job_invitations
    WHERE id = ${context.invitationId} FOR UPDATE`;
  await sql`SELECT id FROM conversations
    WHERE id = ${context.conversationId} FOR UPDATE`;
  const quotes = await sql`SELECT id FROM quotes
    WHERE id = ${input.quoteId} FOR UPDATE`;
  return quotes.length === 1;
}

async function insertContentRevision(
  sql: TransactionSql,
  input: SaveStructuredQuoteDraftInput,
  createdAt: Date,
): Promise<void> {
  const { content } = input;
  await sql`
    INSERT INTO quote_structured_content_revisions (
      quote_id, quote_revision, content_revision, command_id, title, summary,
      price_mode, currency, total_amount_cents, range_minimum_cents,
      range_maximum_cents, price_basis, vat_status, labor_amount_cents,
      labor_description, material_amount_cents, material_description,
      transport_amount_cents, transport_description, other_amount_cents,
      other_description, included_scope, excluded_scope,
      conditional_on_inspection, inspection_conditions, estimated_start_on,
      estimated_duration_days, valid_until, warranty_information,
      material_responsibility, deposit_mode, deposit_amount_cents,
      deposit_percentage_basis_points, deposit_notes, provider_notes, changed_at
    ) VALUES (
      ${input.quoteId}, ${input.quoteRevision}, 1, ${input.commandId},
      ${content.title}, ${content.summary}, ${content.priceMode},
      ${content.currency}, ${content.totalAmountCents ?? null},
      ${content.rangeMinimumCents ?? null}, ${content.rangeMaximumCents ?? null},
      ${content.priceBasis}, ${content.vatStatus},
      ${content.components.labor?.amountCents ?? null},
      ${content.components.labor?.description ?? null},
      ${content.components.material?.amountCents ?? null},
      ${content.components.material?.description ?? null},
      ${content.components.transport?.amountCents ?? null},
      ${content.components.transport?.description ?? null},
      ${content.components.other?.amountCents ?? null},
      ${content.components.other?.description ?? null},
      ${content.includedScope ?? []}, ${content.excludedScope ?? []},
      ${content.conditionalOnInspection}, ${content.inspectionConditions ?? null},
      ${content.estimatedStartOn ?? null},
      ${content.estimatedDurationDays ?? null}, ${content.validUntil ?? null},
      ${content.warrantyInformation ?? null}, ${content.materialResponsibility},
      ${content.depositMode ?? null}, ${content.depositAmountCents ?? null},
      ${content.depositPercentageBasisPoints ?? null},
      ${content.depositNotes ?? null}, ${content.providerNotes ?? null},
      ${createdAt}
    )
  `;
}

async function readOwned(
  sql: TransactionSql,
  input: ReadStructuredQuoteInput,
): Promise<StructuredQuoteContentRevision | null> {
  const actors = await sql`
    SELECT id FROM users
    WHERE id = ${input.actorUserId} AND account_state = 'ACTIVE'
    FOR UPDATE
  `;
  if (actors.length !== 1) return null;
  const contexts = await sql`
    SELECT quote.id
    FROM quotes quote
    JOIN current_conversations conversation
      ON conversation.id = quote.conversation_id
    JOIN customer_profiles customer
      ON customer.id = conversation.customer_profile_id
    JOIN craftsman_profiles craftsman
      ON craftsman.id = conversation.craftsman_profile_id
    JOIN quote_revision_identities revision
      ON revision.quote_id = quote.id
      AND revision.revision = ${input.quoteRevision}
      AND revision.authoring_mode = 'PLATFORM_STRUCTURED'
    JOIN quote_revision_heads head
      ON head.quote_id = revision.quote_id
      AND head.quote_revision = revision.revision
    WHERE quote.id = ${input.quoteId}
      AND (craftsman.owner_user_id = ${input.actorUserId}
        OR (customer.owner_user_id = ${input.actorUserId}
          AND head.state <> 'DRAFT'))
    FOR UPDATE OF quote, customer, craftsman
  `;
  if (contexts.length !== 1) return null;
  const [row] = await sql<StructuredContentRow[]>`
    SELECT content.quote_id AS "quoteId",
      content.quote_revision AS "quoteRevision",
      content.content_revision AS "contentRevision",
      content.changed_at AS "changedAt", content.title, content.summary,
      content.price_mode::text AS "priceMode", content.currency,
      content.total_amount_cents::text AS "totalAmountCents",
      content.range_minimum_cents::text AS "rangeMinimumCents",
      content.range_maximum_cents::text AS "rangeMaximumCents",
      content.price_basis AS "priceBasis",
      content.vat_status::text AS "vatStatus",
      content.labor_amount_cents::text AS "laborAmountCents",
      content.labor_description AS "laborDescription",
      content.material_amount_cents::text AS "materialAmountCents",
      content.material_description AS "materialDescription",
      content.transport_amount_cents::text AS "transportAmountCents",
      content.transport_description AS "transportDescription",
      content.other_amount_cents::text AS "otherAmountCents",
      content.other_description AS "otherDescription", content.included_scope AS "includedScope",
      content.excluded_scope AS "excludedScope",
      content.conditional_on_inspection AS "conditionalOnInspection",
      content.inspection_conditions AS "inspectionConditions",
      content.estimated_start_on::text AS "estimatedStartOn",
      content.estimated_duration_days AS "estimatedDurationDays",
      content.valid_until AS "validUntil",
      content.warranty_information AS "warrantyInformation",
      content.material_responsibility::text AS "materialResponsibility",
      content.deposit_mode::text AS "depositMode",
      content.deposit_amount_cents::text AS "depositAmountCents",
      content.deposit_percentage_basis_points AS "depositPercentageBasisPoints",
      content.deposit_notes AS "depositNotes",
      content.provider_notes AS "providerNotes"
    FROM current_quote_structured_content content
    WHERE content.quote_id = ${input.quoteId}
      AND content.quote_revision = ${input.quoteRevision}
  `;
  return row === undefined ? null : toContent(row);
}

async function loadContentRevision(
  sql: TransactionSql,
  quoteId: QuoteId,
  quoteRevision: number,
  contentRevision: number,
): Promise<StructuredQuoteContentRevision> {
  const [row] = await sql<StructuredContentRow[]>`
    SELECT content.quote_id AS "quoteId",
      content.quote_revision AS "quoteRevision",
      content.content_revision AS "contentRevision",
      content.changed_at AS "changedAt", content.title, content.summary,
      content.price_mode::text AS "priceMode", content.currency,
      content.total_amount_cents::text AS "totalAmountCents",
      content.range_minimum_cents::text AS "rangeMinimumCents",
      content.range_maximum_cents::text AS "rangeMaximumCents",
      content.price_basis AS "priceBasis",
      content.vat_status::text AS "vatStatus",
      content.labor_amount_cents::text AS "laborAmountCents",
      content.labor_description AS "laborDescription",
      content.material_amount_cents::text AS "materialAmountCents",
      content.material_description AS "materialDescription",
      content.transport_amount_cents::text AS "transportAmountCents",
      content.transport_description AS "transportDescription",
      content.other_amount_cents::text AS "otherAmountCents",
      content.other_description AS "otherDescription",
      content.included_scope AS "includedScope",
      content.excluded_scope AS "excludedScope",
      content.conditional_on_inspection AS "conditionalOnInspection",
      content.inspection_conditions AS "inspectionConditions",
      content.estimated_start_on::text AS "estimatedStartOn",
      content.estimated_duration_days AS "estimatedDurationDays",
      content.valid_until AS "validUntil",
      content.warranty_information AS "warrantyInformation",
      content.material_responsibility::text AS "materialResponsibility",
      content.deposit_mode::text AS "depositMode",
      content.deposit_amount_cents::text AS "depositAmountCents",
      content.deposit_percentage_basis_points AS "depositPercentageBasisPoints",
      content.deposit_notes AS "depositNotes",
      content.provider_notes AS "providerNotes"
    FROM quote_structured_content_revisions content
    WHERE content.quote_id = ${quoteId}
      AND content.quote_revision = ${quoteRevision}
      AND content.content_revision = ${contentRevision}
  `;
  if (row === undefined) throw new Error("Structured Quote effect is missing.");
  return toContent(row);
}

function toContent(row: StructuredContentRow): StructuredQuoteContentRevision {
  if (
    !isUuid(row.quoteId) ||
    !positiveInteger(row.quoteRevision) ||
    !positiveInteger(row.contentRevision) ||
    !(row.changedAt instanceof Date) ||
    Number.isNaN(row.changedAt.valueOf()) ||
    row.currency !== "EUR"
  ) {
    throw new Error("Corrupt structured Quote projection.");
  }
  const normalized = normalizeStructuredQuoteContent({
    components: {
      labor: component(row.laborAmountCents, row.laborDescription),
      material: component(row.materialAmountCents, row.materialDescription),
      other: component(row.otherAmountCents, row.otherDescription),
      transport: component(row.transportAmountCents, row.transportDescription),
    },
    conditionalOnInspection: row.conditionalOnInspection,
    currency: "EUR",
    depositAmountCents: amount(row.depositAmountCents),
    depositMode: row.depositMode as StructuredQuoteDepositMode | null,
    depositNotes: row.depositNotes,
    depositPercentageBasisPoints: row.depositPercentageBasisPoints,
    estimatedDurationDays: row.estimatedDurationDays,
    estimatedStartOn: row.estimatedStartOn,
    excludedScope: row.excludedScope,
    includedScope: row.includedScope,
    inspectionConditions: row.inspectionConditions,
    materialResponsibility:
      row.materialResponsibility as StructuredQuoteMaterialResponsibility,
    priceBasis: row.priceBasis,
    priceMode: row.priceMode as StructuredQuotePriceMode,
    providerNotes: row.providerNotes,
    rangeMaximumCents: amount(row.rangeMaximumCents),
    rangeMinimumCents: amount(row.rangeMinimumCents),
    summary: row.summary,
    title: row.title,
    totalAmountCents: amount(row.totalAmountCents),
    validUntil: row.validUntil,
    vatStatus: row.vatStatus as StructuredQuoteVatStatus,
    warrantyInformation: row.warrantyInformation,
  });
  return Object.freeze({
    ...normalized,
    changedAt: new Date(row.changedAt),
    contentRevision: row.contentRevision,
    quoteId: row.quoteId as QuoteId,
    quoteRevision: row.quoteRevision,
  });
}

function component(
  amountValue: string | null,
  description: string | null,
): StructuredQuoteComponent {
  return Object.freeze({ amountCents: amount(amountValue), description });
}

function amount(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 0 ||
    parsed > 1_000_000_000_000
  ) {
    throw new Error("Corrupt structured Quote amount.");
  }
  return parsed;
}

function fingerprintCommand(input: SaveStructuredQuoteDraftInput): string {
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

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
