import { randomUUID } from "node:crypto";

import { createPrivateMediaDeliveryService } from "@portal/media";
import {
  ExternalPdfQuoteIdempotencyError,
  type ConversationId,
  type QuoteId,
  type UserId,
} from "@portal/domain";
import type { Sql, TransactionSql } from "postgres";
import { expect } from "vitest";

import {
  createExternalPdfQuoteRepository,
  createQuoteDocumentMediaAccessResolver,
  createQuoteDocumentUploadAuthorization,
} from "../src/quote-external-pdf-repository.js";
import { createPrivateMediaDeliveryRepository } from "../src/media-delivery-repository.js";
import { createQuoteRepository } from "../src/quote-repository.js";
import {
  createQuoteSupportingDocumentRepository,
  createQuoteSupportingDocumentUploadAuthorization,
  QuoteSupportingDocumentIdempotencyError,
} from "../src/quote-supporting-document-repository.js";
import { createStructuredQuoteRepository } from "../src/quote-structured-repository.js";
import { runQuoteComparisonIntegrationAssertions } from "./quote-comparison-integration-helper.js";

interface Fixture {
  readonly conversationId: ConversationId;
  readonly customerOwnerId: UserId;
  readonly providerOwnerId: UserId;
  readonly quoteId: QuoteId;
  readonly requestContentRevision: number;
  readonly requestVisibleVersion: number;
  readonly structuredDraftRevision: number;
  readonly structuredDraftStateRevision: number;
  readonly submittedStateRevision: number;
}

/** Standalone R3-017 assertions; the root migration runner owns wiring. */
export async function runExternalPdfQuoteIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const fixture = await findFixture(sql);
  const structuredSupportingPdf = await expectStructuredQuoteDocumentAllowed(
    sql,
    fixture,
  );
  await expect(
    sql<Array<{ readonly eligible: boolean }>>`
      SELECT quote_revision_authoring_is_eligible(
        ${fixture.quoteId},
        ${fixture.structuredDraftRevision},
        'PLATFORM_STRUCTURED'
      ) AS eligible
    `,
  ).resolves.toEqual([{ eligible: false }]);
  const quotes = createQuoteRepository(sql);
  const external = createExternalPdfQuoteRepository(sql);
  const structured = createStructuredQuoteRepository(sql);
  const currentStructured = await structured.readOwned({
    actorUserId: fixture.providerOwnerId,
    quoteId: fixture.quoteId,
    quoteRevision: fixture.structuredDraftRevision,
  });
  if (currentStructured === null)
    throw new Error("Expected the R3-016 structured draft.");
  await expect(
    structured.saveDraft({
      actorUserId: fixture.providerOwnerId,
      commandId: randomUUID(),
      content: {
        ...currentStructured,
        validUntil: new Date("2100-01-01T00:00:00Z"),
      },
      expectedContentRevision: currentStructured.contentRevision,
      quoteId: fixture.quoteId,
      quoteRevision: fixture.structuredDraftRevision,
    }),
  ).resolves.toMatchObject({ status: "SAVED" });
  await expect(
    quotes.submit({
      actorUserId: fixture.providerOwnerId,
      commandId: randomUUID(),
      expectedDraftStateRevision: fixture.structuredDraftStateRevision,
      expectedSubmittedStateRevision: fixture.submittedStateRevision,
      quoteId: fixture.quoteId,
      revision: fixture.structuredDraftRevision,
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });
  await expectDeliveryGrant(
    sql,
    fixture.customerOwnerId,
    structuredSupportingPdf,
    303,
  );

  const created = await quotes.createRevision({
    actorUserId: fixture.providerOwnerId,
    authoringMode: "EXTERNAL_PDF",
    commandId: randomUUID(),
    expectedSubmittedStateRevision: 2,
    quoteId: fixture.quoteId,
    requestContentRevision: fixture.requestContentRevision,
    requestVisibleVersion: fixture.requestVisibleVersion,
  });
  if (!("quote" in created) || created.quote.currentDraft === null)
    throw new Error("Expected external PDF Quote revision.");
  const quoteId = created.quote.id;
  const quoteRevision = created.quote.currentDraft.revision;
  await expectRawMediaGuards(sql, fixture, quoteId, quoteRevision);

  await expect(
    createQuoteDocumentUploadAuthorization(sql).prepareUpload({
      actorUserId: fixture.providerOwnerId,
      quoteId,
      quoteRevision,
    }),
  ).resolves.toMatchObject({ purpose: "QUOTE_DOCUMENT", status: "AUTHORIZED" });

  const pdfA = await createDocument(
    sql,
    fixture.providerOwnerId,
    quoteId,
    quoteRevision,
    false,
  );
  await expectRawMediaIdentityMutationRejected(
    sql,
    pdfA,
    fixture.customerOwnerId,
  );
  await expect(
    external.saveDraft(saveInput(fixture, quoteId, quoteRevision, pdfA, 0)),
  ).resolves.toEqual({ status: "PDF_NOT_READY" });
  await markReady(sql, pdfA);
  await expect(
    sql`UPDATE media_assets SET status = 'PROCESSING' WHERE id = ${pdfA}`,
  ).rejects.toThrow(/terminal Quote document media state is immutable/u);
  await expectRawCommandGuards(sql, fixture, quoteId, quoteRevision, pdfA);
  const firstInput = saveInput(fixture, quoteId, quoteRevision, pdfA, 0);
  await expect(external.saveDraft(firstInput)).resolves.toMatchObject({
    revision: {
      contentRevision: 1,
      pdfAssetId: pdfA,
      providerConfirmedSummaryMatchesPdf: true,
    },
    status: "SAVED",
  });
  await expect(external.saveDraft(firstInput)).resolves.toMatchObject({
    status: "DEDUPLICATED",
  });
  await expect(
    external.saveDraft({
      ...firstInput,
      envelope: {
        ...firstInput.envelope,
        totalAmountCents: 151_000,
      },
    }),
  ).rejects.toBeInstanceOf(ExternalPdfQuoteIdempotencyError);
  await sql.begin(async (transaction) => {
    await transaction`UPDATE users SET account_state = 'SUSPENDED'
      WHERE id = ${fixture.providerOwnerId}`;
    await expect(
      createExternalPdfQuoteRepository(transaction).saveDraft(firstInput),
    ).resolves.toEqual({ status: "NOT_FOUND" });
    await transaction`UPDATE users SET account_state = 'ACTIVE'
      WHERE id = ${fixture.providerOwnerId}`;
  });

  await expect(
    external.readOwned({
      actorUserId: fixture.customerOwnerId,
      quoteId,
      quoteRevision,
    }),
  ).resolves.toBeNull();
  const outsider = randomUUID() as UserId;
  await sql`INSERT INTO users (id) VALUES (${outsider})`;
  await expect(
    external.readOwned({ actorUserId: outsider, quoteId, quoteRevision }),
  ).resolves.toBeNull();
  await expect(
    external.saveDraft({
      ...saveInput(fixture, quoteId, quoteRevision, pdfA, 1),
      actorUserId: outsider,
    }),
  ).resolves.toEqual({ status: "NOT_FOUND" });

  const pdfB = await createDocument(
    sql,
    fixture.providerOwnerId,
    quoteId,
    quoteRevision,
    true,
  );
  await expect(
    external.saveDraft(saveInput(fixture, quoteId, quoteRevision, pdfB, 1)),
  ).resolves.toMatchObject({
    revision: { contentRevision: 2, pdfAssetId: pdfB },
    status: "SAVED",
  });
  const pdfC = await createDocument(
    sql,
    fixture.providerOwnerId,
    quoteId,
    quoteRevision,
    true,
  );
  const pdfD = await createDocument(
    sql,
    fixture.providerOwnerId,
    quoteId,
    quoteRevision,
    true,
  );
  const firstReplacement = deferred<unknown>();
  const releaseReplacement = deferred<void>();
  const heldReplacement = sql.begin(async (transaction) => {
    const result = await createExternalPdfQuoteRepository(
      transaction,
    ).saveDraft(saveInput(fixture, quoteId, quoteRevision, pdfC, 2));
    firstReplacement.resolve(result);
    await releaseReplacement.promise;
    return result;
  });
  await firstReplacement.promise;
  const replacementPid = deferred<number>();
  const blockedReplacement = sql.begin(async (transaction) => {
    replacementPid.resolve(await backendPid(transaction));
    return createExternalPdfQuoteRepository(transaction).saveDraft(
      saveInput(fixture, quoteId, quoteRevision, pdfD, 2),
    );
  });
  await waitForLock(sql, await replacementPid.promise);
  releaseReplacement.resolve(undefined);
  await expect(heldReplacement).resolves.toMatchObject({ status: "SAVED" });
  await expect(blockedReplacement).resolves.toEqual({
    status: "STALE_REVISION",
  });
  const current = await external.readOwned({
    actorUserId: fixture.providerOwnerId,
    quoteId,
    quoteRevision,
  });
  if (current === null) throw new Error("Expected current external content.");
  expect(current.pdfAssetId).toBe(pdfC);
  await expect(external.saveDraft(firstInput)).resolves.toMatchObject({
    revision: { contentRevision: 1, pdfAssetId: pdfA },
    status: "DEDUPLICATED",
  });
  await expect(sql<Array<{ readonly count: number }>>`
    SELECT count(*)::integer AS count FROM quote_external_pdf_documents
    WHERE quote_id = ${quoteId} AND quote_revision = ${quoteRevision}
  `).resolves.toEqual([{ count: 3 }]);
  await expectDeliveryGrant(sql, fixture.providerOwnerId, pdfC, 303);
  await expectDeliveryGrant(sql, fixture.customerOwnerId, pdfC, 404);
  await expectDeliveryGrant(sql, outsider, pdfC, 404);

  const expiredPdf = await createDocument(
    sql,
    fixture.providerOwnerId,
    quoteId,
    quoteRevision,
    true,
  );
  const saveEffect = deferred<unknown>();
  const releaseSave = deferred<void>();
  const heldSave = sql.begin(async (transaction) => {
    const result = await createExternalPdfQuoteRepository(
      transaction,
    ).saveDraft(
      saveInput(
        fixture,
        quoteId,
        quoteRevision,
        expiredPdf,
        3,
        new Date("2000-01-01T00:00:00Z"),
      ),
    );
    saveEffect.resolve(result);
    await releaseSave.promise;
    return result;
  });
  await saveEffect.promise;
  const submitPid = deferred<number>();
  const blockedSubmit = sql.begin(async (transaction) => {
    submitPid.resolve(await backendPid(transaction));
    return createQuoteRepository(transaction).submit({
      actorUserId: fixture.providerOwnerId,
      commandId: randomUUID(),
      expectedDraftStateRevision: 1,
      expectedSubmittedStateRevision: 2,
      quoteId,
      revision: quoteRevision,
    });
  });
  await waitForLock(sql, await submitPid.promise);
  releaseSave.resolve(undefined);
  await expect(heldSave).resolves.toMatchObject({ status: "SAVED" });
  await expect(blockedSubmit).resolves.toEqual({
    status: "AUTHORING_NOT_READY",
  });

  const validPdf = await createDocument(
    sql,
    fixture.providerOwnerId,
    quoteId,
    quoteRevision,
    true,
  );
  const latePdf = await createDocument(
    sql,
    fixture.providerOwnerId,
    quoteId,
    quoteRevision,
    true,
  );
  const supportingPdf = await createDocument(
    sql,
    fixture.providerOwnerId,
    quoteId,
    quoteRevision,
    true,
  );
  await assertSupportingDocumentBinding(
    sql,
    fixture,
    quoteId,
    quoteRevision,
    supportingPdf,
  );
  const removedPdf = await createDocument(
    sql,
    fixture.providerOwnerId,
    quoteId,
    quoteRevision,
    true,
  );
  await assertSupportingDocumentRemoval(
    sql,
    fixture,
    quoteId,
    quoteRevision,
    removedPdf,
  );
  await assertRevokedSupportingDocumentFailClosed(
    sql,
    fixture,
    quoteId,
    quoteRevision,
  );
  await expectDeliveryGrant(sql, fixture.providerOwnerId, supportingPdf, 303);
  await expectDeliveryGrant(sql, fixture.customerOwnerId, supportingPdf, 404);
  await expectDeliveryGrant(sql, fixture.providerOwnerId, removedPdf, 404);
  await external.saveDraft(
    saveInput(fixture, quoteId, quoteRevision, validPdf, 4),
  );
  const submitEffect = deferred<unknown>();
  const releaseSubmit = deferred<void>();
  const heldSubmit = sql.begin(async (transaction) => {
    const result = await createQuoteRepository(transaction).submit({
      actorUserId: fixture.providerOwnerId,
      commandId: randomUUID(),
      expectedDraftStateRevision: 1,
      expectedSubmittedStateRevision: 2,
      quoteId,
      revision: quoteRevision,
    });
    submitEffect.resolve(result);
    await releaseSubmit.promise;
    return result;
  });
  await submitEffect.promise;
  const savePid = deferred<number>();
  const blockedSave = sql.begin(async (transaction) => {
    savePid.resolve(await backendPid(transaction));
    return createExternalPdfQuoteRepository(transaction).saveDraft(
      saveInput(fixture, quoteId, quoteRevision, latePdf, 5),
    );
  });
  await waitForLock(sql, await savePid.promise);
  releaseSubmit.resolve(undefined);
  await expect(heldSubmit).resolves.toMatchObject({ status: "APPLIED" });
  await expect(blockedSave).resolves.toEqual({ status: "READ_ONLY" });
  await expect(
    createDocument(sql, fixture.providerOwnerId, quoteId, quoteRevision, false),
  ).rejects.toThrow(/exact owned Quote revision PDF provenance required/u);
  await expect(
    external.readOwned({
      actorUserId: fixture.customerOwnerId,
      quoteId,
      quoteRevision,
    }),
  ).resolves.toMatchObject({
    pdfAssetId: validPdf,
    pdfDownloadPath: `/v1/media/${validPdf}/download`,
  });
  await expectDeliveryGrant(sql, fixture.customerOwnerId, validPdf, 303);
  await expectDeliveryGrant(sql, fixture.customerOwnerId, supportingPdf, 303);
  await expectDeliveryGrant(sql, fixture.customerOwnerId, removedPdf, 404);
  await expect(
    createQuoteSupportingDocumentRepository(sql).readOwned({
      actorUserId: fixture.customerOwnerId,
      quoteId,
      quoteRevision,
    }),
  ).resolves.toEqual([
    expect.objectContaining({ mediaAssetId: supportingPdf }),
  ]);
  await expectDeliveryGrant(sql, fixture.customerOwnerId, pdfC, 404);
  await expectDeliveryGrant(sql, fixture.providerOwnerId, pdfC, 303);
  await expect(sql`
    INSERT INTO quote_revision_supporting_documents (
      quote_id, quote_revision, media_asset_id, attachment_command_id,
      attached_by_user_id, content_sha256, attached_at
    ) VALUES (
      ${quoteId}, ${quoteRevision}, ${latePdf}, ${randomUUID()},
      ${fixture.providerOwnerId}, ${"a".repeat(64)}, clock_timestamp()
    )
  `).rejects.toThrow(/owned draft Quote required/u);
  await expect(
    createQuoteSupportingDocumentRepository(sql).remove({
      actorUserId: fixture.providerOwnerId,
      commandId: randomUUID(),
      mediaAssetId: supportingPdf,
      quoteId,
      quoteRevision,
    }),
  ).resolves.toEqual({ status: "NOT_FOUND" });
  await assertAcceptedSupportingDocumentSnapshot(
    sql,
    fixture,
    quoteId,
    quoteRevision,
    supportingPdf,
  );
  await runQuoteComparisonIntegrationAssertions(sql, "EXTERNAL_PDF");

  const second = await quotes.createRevision({
    actorUserId: fixture.providerOwnerId,
    authoringMode: "EXTERNAL_PDF",
    commandId: randomUUID(),
    expectedSubmittedStateRevision: 2,
    quoteId,
    requestContentRevision: fixture.requestContentRevision,
    requestVisibleVersion: fixture.requestVisibleVersion,
  });
  const secondRevision = quoteRevision + 1;
  expect(second).toMatchObject({
    quote: { currentDraft: { revision: secondRevision } },
  });
  await assertSupportingDocumentTechnicalLimit(
    sql,
    fixture,
    quoteId,
    secondRevision,
  );
  await expectDeliveryGrant(sql, fixture.customerOwnerId, validPdf, 303);
  await expect(
    external.saveDraft(
      saveInput(fixture, quoteId, secondRevision, validPdf, 0),
    ),
  ).resolves.toEqual({ status: "PDF_NOT_READY" });
  const secondPdf = await createDocument(
    sql,
    fixture.providerOwnerId,
    quoteId,
    secondRevision,
    true,
  );
  await external.saveDraft(
    saveInput(fixture, quoteId, secondRevision, secondPdf, 0),
  );

  const revokeStarted = deferred<void>();
  const releaseRevoke = deferred<void>();
  const revoke = sql.begin(async (transaction) => {
    await transaction`UPDATE media_asset_storage_objects SET revoked_at = clock_timestamp()
      WHERE media_asset_id = ${secondPdf} AND role = 'CANONICAL'`;
    revokeStarted.resolve(undefined);
    await releaseRevoke.promise;
  });
  await revokeStarted.promise;
  const revokeSubmitPid = deferred<number>();
  const submitAfterRevoke = sql.begin(async (transaction) => {
    revokeSubmitPid.resolve(await backendPid(transaction));
    return createQuoteRepository(transaction).submit({
      actorUserId: fixture.providerOwnerId,
      commandId: randomUUID(),
      expectedDraftStateRevision: 1,
      expectedSubmittedStateRevision: 2,
      quoteId,
      revision: secondRevision,
    });
  });
  await waitForLock(sql, await revokeSubmitPid.promise);
  releaseRevoke.resolve(undefined);
  await revoke;
  await expect(submitAfterRevoke).resolves.toEqual({
    status: "AUTHORING_NOT_READY",
  });

  const replacement = await createDocument(
    sql,
    fixture.providerOwnerId,
    quoteId,
    secondRevision,
    true,
  );
  const [lifecycleClock] = await sql<Array<{ validUntil: Date }>>`
    SELECT clock_timestamp() + interval '5 seconds' AS "validUntil"
  `;
  if (lifecycleClock === undefined)
    throw new Error("Expected DB lifecycle clock.");
  await external.saveDraft(
    saveInput(
      fixture,
      quoteId,
      secondRevision,
      replacement,
      1,
      lifecycleClock.validUntil,
    ),
  );
  const submitStarted = deferred<unknown>();
  const releaseSubmitted = deferred<void>();
  const submitBeforeRevoke = sql.begin(async (transaction) => {
    const result = await createQuoteRepository(transaction).submit({
      actorUserId: fixture.providerOwnerId,
      commandId: randomUUID(),
      expectedDraftStateRevision: 1,
      expectedSubmittedStateRevision: 2,
      quoteId,
      revision: secondRevision,
    });
    submitStarted.resolve(result);
    await releaseSubmitted.promise;
    return result;
  });
  await submitStarted.promise;
  const revokePid = deferred<number>();
  const revokeAfterSubmit = sql.begin(async (transaction) => {
    revokePid.resolve(await backendPid(transaction));
    await transaction`UPDATE media_asset_storage_objects SET revoked_at = clock_timestamp()
      WHERE media_asset_id = ${replacement} AND role = 'CANONICAL'`;
  });
  await waitForLock(sql, await revokePid.promise);
  releaseSubmitted.resolve(undefined);
  await expect(submitBeforeRevoke).resolves.toMatchObject({
    status: "APPLIED",
  });
  await revokeAfterSubmit;
  await expectDeliveryGrant(sql, fixture.customerOwnerId, validPdf, 303);
  await expectDeliveryGrant(sql, fixture.customerOwnerId, replacement, 404);
  const structuredEligibility = await sql<
    Array<{ readonly eligible: boolean }>
  >`
    SELECT quote_revision_authoring_is_eligible(content.quote_id,
      content.quote_revision, 'PLATFORM_STRUCTURED') AS eligible
    FROM current_quote_structured_content content
    ORDER BY content.valid_until NULLS LAST
  `;
  expect(structuredEligibility.some((item) => item.eligible)).toBe(true);
  await expect(sql`UPDATE quote_external_pdf_content_revisions SET total_amount_cents = 1
    WHERE quote_id = ${quoteId}`).rejects.toThrow(/append-only/u);
}

async function expectStructuredQuoteDocumentAllowed(
  sql: Sql,
  fixture: Fixture,
): Promise<string> {
  await expect(
    createQuoteSupportingDocumentUploadAuthorization(sql).prepareUpload({
      actorUserId: fixture.providerOwnerId,
      quoteId: fixture.quoteId,
      quoteRevision: fixture.structuredDraftRevision,
    }),
  ).resolves.toMatchObject({
    purpose: "QUOTE_DOCUMENT",
    status: "AUTHORIZED",
  });
  const assetId = await createDocument(
    sql,
    fixture.providerOwnerId,
    fixture.quoteId,
    fixture.structuredDraftRevision,
    true,
  );
  await expect(
    createQuoteSupportingDocumentRepository(sql).attach({
      actorUserId: fixture.providerOwnerId,
      commandId: randomUUID(),
      mediaAssetId: assetId,
      quoteId: fixture.quoteId,
      quoteRevision: fixture.structuredDraftRevision,
    }),
  ).resolves.toMatchObject({ status: "ATTACHED" });
  await expectDeliveryGrant(sql, fixture.providerOwnerId, assetId, 303);
  await expectDeliveryGrant(sql, fixture.customerOwnerId, assetId, 404);
  return assetId;
}

async function findFixture(sql: Sql): Promise<Fixture> {
  const [row] = await sql<Fixture[]>`
    SELECT conversation.id AS "conversationId", customer.owner_user_id AS "customerOwnerId",
      craftsman.owner_user_id AS "providerOwnerId", quote.id AS "quoteId",
      draft.revision AS "structuredDraftRevision",
      draft_head.state_revision AS "structuredDraftStateRevision",
      submitted_head.state_revision AS "submittedStateRevision",
      provenance.content_revision AS "requestContentRevision",
      provenance.visible_version AS "requestVisibleVersion"
    FROM current_conversations conversation
    JOIN customer_profiles customer ON customer.id = conversation.customer_profile_id
    JOIN craftsman_profiles craftsman ON craftsman.id = conversation.craftsman_profile_id
    JOIN quotes quote ON quote.conversation_id = conversation.id
    JOIN quote_revision_identities draft ON draft.quote_id = quote.id
      AND draft.authoring_mode = 'PLATFORM_STRUCTURED'
    JOIN quote_revision_heads draft_head ON draft_head.quote_id = quote.id
      AND draft_head.quote_revision = draft.revision AND draft_head.state = 'DRAFT'
    JOIN LATERAL (SELECT state_revision FROM quote_revision_heads submitted
      WHERE submitted.quote_id = quote.id AND submitted.state = 'SUBMITTED'
      ORDER BY submitted.quote_revision DESC LIMIT 1) submitted_head ON true
    JOIN LATERAL (SELECT content_revision, visible_version
      FROM job_request_active_content_revisions item
      WHERE item.job_request_id = conversation.job_request_id
      ORDER BY content_revision DESC LIMIT 1) provenance ON true
    WHERE conversation.access_state = 'WRITABLE' AND conversation.invitation_state = 'ENGAGED'
    LIMIT 1`;
  if (row === undefined)
    throw new Error("R3-017 requires the R3-016 structured Quote fixture.");
  return row;
}

async function createDocument(
  sql: Sql | TransactionSql,
  owner: UserId,
  quoteId: QuoteId,
  revision: number,
  ready: boolean,
): Promise<string> {
  const assetId = randomUUID();
  await sql`INSERT INTO media_assets (id, owner_user_id, uploaded_by_user_id, kind,
    purpose, status, declared_content_type, byte_size, provenance_entity_type,
    provenance_entity_id, provenance_entity_revision)
    VALUES (${assetId}, ${owner}, ${owner}, 'DOCUMENT', 'QUOTE_DOCUMENT',
      'PROCESSING', 'application/pdf', 100, 'QUOTE_REVISION', ${quoteId}, ${revision})`;
  if (ready) await markReady(sql, assetId);
  return assetId;
}

async function assertSupportingDocumentBinding(
  sql: Sql,
  fixture: Fixture,
  quoteId: QuoteId,
  quoteRevision: number,
  assetId: string,
): Promise<void> {
  const processing = await createDocument(
    sql,
    fixture.providerOwnerId,
    quoteId,
    quoteRevision,
    false,
  );
  await expect(sql`
    INSERT INTO quote_revision_supporting_documents (
      quote_id, quote_revision, media_asset_id, attachment_command_id,
      attached_by_user_id, content_sha256, attached_at
    ) VALUES (
      ${quoteId}, ${quoteRevision}, ${processing}, ${randomUUID()},
      ${fixture.providerOwnerId}, ${"f".repeat(64)}, clock_timestamp()
    )
  `).rejects.toThrow(/exact READY private Quote supporting PDF required/u);
  await expect(sql`
    INSERT INTO quote_revision_supporting_documents (
      quote_id, quote_revision, media_asset_id, attachment_command_id,
      attached_by_user_id, content_sha256, attached_at
    ) VALUES (
      ${quoteId}, ${quoteRevision}, ${assetId}, ${randomUUID()},
      ${fixture.customerOwnerId}, ${"f".repeat(64)}, clock_timestamp()
    )
  `).rejects.toThrow(/owned draft Quote required/u);
  const commandId = randomUUID();
  const repository = createQuoteSupportingDocumentRepository(sql);
  const input = {
    actorUserId: fixture.providerOwnerId,
    commandId,
    mediaAssetId: assetId,
    quoteId,
    quoteRevision,
  };
  await expect(repository.attach(input)).resolves.toMatchObject({
    document: { mediaAssetId: assetId },
    status: "ATTACHED",
  });
  await expect(repository.attach(input)).resolves.toMatchObject({
    status: "DEDUPLICATED",
  });
  await expect(
    repository.attach({ ...input, mediaAssetId: processing }),
  ).rejects.toBeInstanceOf(QuoteSupportingDocumentIdempotencyError);
  await expect(
    repository.readOwned({
      actorUserId: fixture.providerOwnerId,
      quoteId,
      quoteRevision,
    }),
  ).resolves.toEqual([expect.objectContaining({ mediaAssetId: assetId })]);
  await expect(
    repository.readOwned({
      actorUserId: fixture.customerOwnerId,
      quoteId,
      quoteRevision,
    }),
  ).resolves.toBeNull();
  const [bound] = await sql<Array<{ attachedAt: Date; contentSha256: string }>>`
    SELECT content_sha256 AS "contentSha256",
      attached_at AS "attachedAt"
    FROM quote_revision_supporting_documents
    WHERE attachment_command_id = ${commandId}
  `;
  expect(bound?.contentSha256).toBe("a".repeat(64));
  expect(bound?.attachedAt.getUTCFullYear()).toBeGreaterThan(2020);
  await expect(sql`
    UPDATE quote_revision_supporting_documents
    SET content_sha256 = ${"b".repeat(64)}
    WHERE attachment_command_id = ${commandId}
  `).rejects.toThrow(/inclusion is immutable/u);
  await expect(sql`
    DELETE FROM quote_revision_supporting_documents
    WHERE attachment_command_id = ${commandId}
  `).rejects.toThrow(/inclusion is immutable/u);
}

async function assertSupportingDocumentRemoval(
  sql: Sql,
  fixture: Fixture,
  quoteId: QuoteId,
  quoteRevision: number,
  assetId: string,
): Promise<void> {
  const repository = createQuoteSupportingDocumentRepository(sql);
  await expect(
    repository.attach({
      actorUserId: fixture.providerOwnerId,
      commandId: randomUUID(),
      mediaAssetId: assetId,
      quoteId,
      quoteRevision,
    }),
  ).resolves.toMatchObject({ status: "ATTACHED" });
  const commandId = randomUUID();
  const input = {
    actorUserId: fixture.providerOwnerId,
    commandId,
    mediaAssetId: assetId,
    quoteId,
    quoteRevision,
  };
  await expect(repository.remove(input)).resolves.toEqual({
    status: "REMOVED",
  });
  await expect(repository.remove(input)).resolves.toEqual({
    status: "DEDUPLICATED",
  });
  await expect(
    repository.remove({ ...input, mediaAssetId: randomUUID() }),
  ).rejects.toBeInstanceOf(QuoteSupportingDocumentIdempotencyError);
  const active = await repository.readOwned({
    actorUserId: fixture.providerOwnerId,
    quoteId,
    quoteRevision,
  });
  expect(active?.some((document) => document.mediaAssetId === assetId)).toBe(
    false,
  );
  const [history] = await sql<Array<{ included: number; removed: number }>>`
    SELECT (SELECT count(*)::integer FROM quote_revision_supporting_documents
      WHERE media_asset_id = ${assetId}) AS included,
      (SELECT count(*)::integer
        FROM quote_revision_supporting_document_removals
        WHERE media_asset_id = ${assetId}) AS removed
  `;
  expect(history).toEqual({ included: 1, removed: 1 });
  await expect(sql`
    DELETE FROM quote_revision_supporting_document_removals
    WHERE removal_command_id = ${commandId}
  `).rejects.toThrow(/immutable/u);
}

async function assertRevokedSupportingDocumentFailClosed(
  sql: Sql,
  fixture: Fixture,
  quoteId: QuoteId,
  quoteRevision: number,
): Promise<void> {
  const assetId = await createDocument(
    sql,
    fixture.providerOwnerId,
    quoteId,
    quoteRevision,
    true,
  );
  const repository = createQuoteSupportingDocumentRepository(sql);
  await expect(
    repository.attach({
      actorUserId: fixture.providerOwnerId,
      commandId: randomUUID(),
      mediaAssetId: assetId,
      quoteId,
      quoteRevision,
    }),
  ).resolves.toMatchObject({ status: "ATTACHED" });
  await sql`
    UPDATE media_asset_storage_objects SET revoked_at = clock_timestamp()
    WHERE media_asset_id = ${assetId} AND role = 'CANONICAL'
  `;
  await expect(
    repository.readOwned({
      actorUserId: fixture.providerOwnerId,
      quoteId,
      quoteRevision,
    }),
  ).resolves.toBeNull();
  await expect(
    repository.remove({
      actorUserId: fixture.providerOwnerId,
      commandId: randomUUID(),
      mediaAssetId: assetId,
      quoteId,
      quoteRevision,
    }),
  ).resolves.toEqual({ status: "REMOVED" });
}

async function assertSupportingDocumentTechnicalLimit(
  sql: Sql,
  fixture: Fixture,
  quoteId: QuoteId,
  quoteRevision: number,
): Promise<void> {
  const marker = new Error("rollback supporting-document limit assertions");
  await expect(
    sql.begin(async (transaction) => {
      const attached: string[] = [];
      for (let index = 0; index < 10; index += 1) {
        const assetId = await createDocument(
          transaction,
          fixture.providerOwnerId,
          quoteId,
          quoteRevision,
          true,
        );
        await transaction`
          INSERT INTO quote_revision_supporting_documents (
            quote_id, quote_revision, media_asset_id,
            attachment_command_id, attached_by_user_id,
            content_sha256, attached_at
          ) VALUES (
            ${quoteId}, ${quoteRevision}, ${assetId}, ${randomUUID()},
            ${fixture.providerOwnerId}, ${"0".repeat(64)}, clock_timestamp()
          )
        `;
        attached.push(assetId);
      }
      const overflow = await createDocument(
        transaction,
        fixture.providerOwnerId,
        quoteId,
        quoteRevision,
        true,
      );
      await expect(
        transaction.savepoint(
          async (savepoint) => savepoint`
          INSERT INTO quote_revision_supporting_documents (
            quote_id, quote_revision, media_asset_id,
            attachment_command_id, attached_by_user_id,
            content_sha256, attached_at
          ) VALUES (
            ${quoteId}, ${quoteRevision}, ${overflow}, ${randomUUID()},
            ${fixture.providerOwnerId}, ${"0".repeat(64)}, clock_timestamp()
          )
        `,
        ),
      ).rejects.toThrow(/Quote supporting document limit reached/u);
      await transaction`
        INSERT INTO quote_revision_supporting_document_removals (
          quote_id, quote_revision, media_asset_id,
          removal_command_id, removed_by_user_id, removed_at
        ) VALUES (
          ${quoteId}, ${quoteRevision}, ${attached[0]!}, ${randomUUID()},
          ${fixture.providerOwnerId}, clock_timestamp()
        )
      `;
      await expect(transaction`
        INSERT INTO quote_revision_supporting_documents (
          quote_id, quote_revision, media_asset_id,
          attachment_command_id, attached_by_user_id,
          content_sha256, attached_at
        ) VALUES (
          ${quoteId}, ${quoteRevision}, ${overflow}, ${randomUUID()},
          ${fixture.providerOwnerId}, ${"0".repeat(64)}, clock_timestamp()
        )
      `).resolves.toBeDefined();
      throw marker;
    }),
  ).rejects.toBe(marker);
}

async function assertAcceptedSupportingDocumentSnapshot(
  sql: Sql,
  fixture: Fixture,
  quoteId: QuoteId,
  quoteRevision: number,
  assetId: string,
): Promise<void> {
  const [source] = await sql<
    Array<{
      craftsmanProfileId: string;
      customerProfileId: string;
      invitationId: string;
      jobRequestId: string;
      requestContentRevision: number;
      requestVisibleVersion: number;
    }>
  >`
    SELECT invitation.id AS "invitationId",
      invitation.job_request_id AS "jobRequestId",
      invitation.customer_profile_id AS "customerProfileId",
      invitation.craftsman_profile_id AS "craftsmanProfileId",
      identity.request_content_revision AS "requestContentRevision",
      identity.request_visible_version AS "requestVisibleVersion"
    FROM quotes quote
    JOIN job_invitations invitation ON invitation.id = quote.invitation_id
    JOIN quote_revision_identities identity ON identity.quote_id = quote.id
      AND identity.revision = ${quoteRevision}
    WHERE quote.id = ${quoteId}
  `;
  if (source === undefined) throw new Error("Accepted Quote source missing.");
  const marker = new Error("rollback supporting-document Job assertions");
  await expect(
    sql.begin(async (transaction) => {
      await expect(
        transaction.savepoint(async (savepoint) => {
          await savepoint`
        UPDATE media_asset_storage_objects SET revoked_at = clock_timestamp()
        WHERE media_asset_id = ${assetId} AND role = 'CANONICAL'
      `;
          await savepoint`
        INSERT INTO jobs (
          job_request_id, customer_profile_id, primary_craftsman_profile_id,
          winning_invitation_id, winning_conversation_id, accepted_quote_id,
          accepted_quote_revision, accepted_request_content_revision,
          accepted_request_visible_version, acceptance_command_id,
          acceptance_payload_fingerprint, accepted_by_user_id
        ) VALUES (
          ${source.jobRequestId}, ${source.customerProfileId},
          ${source.craftsmanProfileId}, ${source.invitationId},
          ${fixture.conversationId}, ${quoteId}, ${quoteRevision},
          ${source.requestContentRevision}, ${source.requestVisibleVersion},
          ${randomUUID()}, ${"c".repeat(64)}, ${fixture.customerOwnerId}
        )
      `;
        }),
      ).rejects.toThrow(
        /complete accepted Quote supporting documents required/u,
      );
      const [job] = await transaction<Array<{ id: string }>>`
      INSERT INTO jobs (
        job_request_id, customer_profile_id, primary_craftsman_profile_id,
        winning_invitation_id, winning_conversation_id, accepted_quote_id,
        accepted_quote_revision, accepted_request_content_revision,
        accepted_request_visible_version, acceptance_command_id,
        acceptance_payload_fingerprint, accepted_by_user_id
      ) VALUES (
        ${source.jobRequestId}, ${source.customerProfileId},
        ${source.craftsmanProfileId}, ${source.invitationId},
        ${fixture.conversationId}, ${quoteId}, ${quoteRevision},
        ${source.requestContentRevision}, ${source.requestVisibleVersion},
        ${randomUUID()}, ${"d".repeat(64)}, ${fixture.customerOwnerId}
      ) RETURNING id
    `;
      if (job === undefined) throw new Error("Job snapshot fixture missing.");
      const snapshots = await transaction<
        Array<{ contentSha256: string; mediaAssetId: string }>
      >`
      SELECT media_asset_id AS "mediaAssetId",
        content_sha256 AS "contentSha256"
      FROM job_quote_supporting_document_snapshots
      WHERE job_id = ${job.id}
    `;
      expect(snapshots).toEqual([
        { contentSha256: "a".repeat(64), mediaAssetId: assetId },
      ]);
      await expect(
        transaction.savepoint(
          async (savepoint) => savepoint`
      DELETE FROM job_quote_supporting_document_snapshots
      WHERE job_id = ${job.id}
    `,
        ),
      ).rejects.toThrow(/inclusion is immutable/u);
      throw marker;
    }),
  ).rejects.toBe(marker);
}

async function expectRawMediaGuards(
  sql: Sql,
  fixture: Fixture,
  quoteId: QuoteId,
  quoteRevision: number,
): Promise<void> {
  for (const row of [
    { owner: fixture.customerOwnerId, provenance: quoteId },
    { owner: fixture.providerOwnerId, provenance: randomUUID() },
  ]) {
    await expect(sql`INSERT INTO media_assets (id, owner_user_id,
      uploaded_by_user_id, kind, purpose, status, declared_content_type,
      byte_size, provenance_entity_type, provenance_entity_id,
      provenance_entity_revision) VALUES (${randomUUID()}, ${row.owner},
      ${row.owner}, 'DOCUMENT', 'QUOTE_DOCUMENT', 'PROCESSING',
      'application/pdf', 100, 'QUOTE_REVISION', ${row.provenance}, ${quoteRevision})`).rejects.toThrow(
      /exact owned Quote revision PDF provenance required/u,
    );
  }
}

async function expectRawMediaIdentityMutationRejected(
  sql: Sql,
  assetId: string,
  otherOwner: UserId,
): Promise<void> {
  await expect(
    sql`UPDATE media_assets SET owner_user_id = ${otherOwner}
      WHERE id = ${assetId}`,
  ).rejects.toThrow(/media identity is immutable/iu);
  await expect(
    sql`UPDATE media_assets SET provenance_entity_revision = 99
      WHERE id = ${assetId}`,
  ).rejects.toThrow(/media identity is immutable/iu);
  await expect(
    sql`UPDATE media_assets SET purpose = 'JOB_DOCUMENT'
      WHERE id = ${assetId}`,
  ).rejects.toThrow(/media identity is immutable/iu);
}

async function expectRawCommandGuards(
  sql: Sql,
  fixture: Fixture,
  quoteId: QuoteId,
  quoteRevision: number,
  pdfAssetId: string,
): Promise<void> {
  await expect(
    sql.begin(async (transaction) => {
      await transaction`INSERT INTO quote_external_pdf_authoring_commands (
      command_id, quote_id, quote_revision, actor_user_id, pdf_media_asset_id,
      provider_confirmed_summary_matches_pdf, expected_content_revision,
      resulting_content_revision, payload_fingerprint, created_at
    ) VALUES (${randomUUID()}, ${quoteId}, ${quoteRevision}, ${fixture.providerOwnerId},
      ${pdfAssetId}, false, 0, 999, ${"f".repeat(64)},
      '2000-01-01T00:00:00Z')`;
    }),
  ).rejects.toThrow(/quote_external_pdf_command_confirmation_true/u);

  await expect(
    sql.begin(async (transaction) => {
      const [stored] = await transaction<
        Array<{
          readonly createdAt: Date;
          readonly resultingContentRevision: number;
        }>
      >`INSERT INTO quote_external_pdf_authoring_commands (
      command_id, quote_id, quote_revision, actor_user_id, pdf_media_asset_id,
      provider_confirmed_summary_matches_pdf, expected_content_revision,
      resulting_content_revision, payload_fingerprint, created_at
    ) VALUES (${randomUUID()}, ${quoteId}, ${quoteRevision}, ${fixture.providerOwnerId},
      ${pdfAssetId}, true, 0, 999, ${"e".repeat(64)},
      '2000-01-01T00:00:00Z')
    RETURNING resulting_content_revision AS "resultingContentRevision",
      created_at AS "createdAt"`;
      expect(stored?.resultingContentRevision).toBe(1);
      expect(stored?.createdAt.valueOf()).toBeGreaterThan(
        new Date("2020-01-01").valueOf(),
      );
      await transaction`SET CONSTRAINTS ALL IMMEDIATE`;
    }),
  ).rejects.toThrow(/quote_external_pdf_command_effect_fk/u);
}

async function markReady(
  sql: Sql | TransactionSql,
  assetId: string,
): Promise<void> {
  const hash = "a".repeat(64);
  await sql`INSERT INTO media_asset_storage_objects (media_asset_id, role, storage_area,
    storage_key, content_type, byte_size, content_sha256)
    VALUES (${assetId}, 'CANONICAL', 'private',
      ${`private/2026/09/${randomUUID()}`}, 'application/pdf', 100, ${hash})`;
  await sql`UPDATE media_assets SET status = 'READY', ready_at = clock_timestamp(),
    status_changed_at = clock_timestamp(), updated_at = clock_timestamp(),
    document_page_count = 1, document_content_sha256 = ${hash},
    malware_scan_verdict = 'CLEAN', malware_scanned_at = clock_timestamp(),
    malware_scanner_engine = 'test', malware_scanner_engine_version = '1',
    malware_signature_version = '1' WHERE id = ${assetId}`;
}

function saveInput(
  fixture: Fixture,
  quoteId: QuoteId,
  revision: number,
  pdfAssetId: string,
  expectedContentRevision: number,
  validUntil: Date = new Date("2100-01-01T00:00:00Z"),
) {
  return {
    actorUserId: fixture.providerOwnerId,
    commandId: randomUUID(),
    envelope: {
      currency: "EUR" as const,
      priceMode: "FIXED" as const,
      providerConfirmedSummaryMatchesPdf: true as const,
      totalAmountCents: 150_000,
      validUntil,
      vatStatus: "VAT_INCLUDED" as const,
    },
    expectedContentRevision,
    pdfAssetId,
    quoteId,
    quoteRevision: revision,
  };
}

async function backendPid(sql: TransactionSql): Promise<number> {
  const [row] = await sql<
    Array<{ readonly pid: number }>
  >`SELECT pg_backend_pid() AS pid`;
  if (row === undefined) throw new Error("Missing backend pid.");
  return row.pid;
}
async function waitForLock(sql: Sql, pid: number): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const [row] = await sql<Array<{ readonly wait: string | null }>>`
      SELECT wait_event_type AS wait FROM pg_stat_activity WHERE pid = ${pid}`;
    if (row?.wait === "Lock") return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Backend ${pid} did not reach lock barrier.`);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function expectDeliveryGrant(
  sql: Sql,
  actorUserId: UserId,
  mediaAssetId: string,
  statusCode: 303 | 404,
): Promise<void> {
  const service = createPrivateMediaDeliveryService({
    applicationOrigin: "https://portal.test",
    entityAccess: createQuoteDocumentMediaAccessResolver(sql),
    repository: createPrivateMediaDeliveryRepository(sql),
    storage: {
      createPrivateDownload: () =>
        Promise.resolve({
          expiresAt: new Date(Date.now() + 30_000),
          url: new URL("https://storage.test/private-download"),
        }),
    } as never,
  });
  const response = await service.handleDownload({ actorUserId, mediaAssetId });
  expect(response.statusCode).toBe(statusCode);
}
