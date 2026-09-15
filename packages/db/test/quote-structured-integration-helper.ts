import { createHash, randomUUID } from "node:crypto";

import {
  StructuredQuoteIdempotencyError,
  normalizeSaveStructuredQuoteDraftInput,
  type QuoteCommandResult,
  type ConversationId,
  type QuoteId,
  type SaveStructuredQuoteDraftInput,
  type SaveStructuredQuoteDraftResult,
  type UserId,
} from "@portal/domain";
import type { Sql, TransactionSql } from "postgres";
import { expect } from "vitest";

import { createQuoteRepository } from "../src/quote-repository.js";
import { createStructuredQuoteRepository } from "../src/quote-structured-repository.js";

interface Fixture {
  readonly conversationId: ConversationId;
  readonly customerOwnerId: UserId;
  readonly invitationId: string;
  readonly providerOwnerId: UserId;
  readonly requestContentRevision: number;
  readonly requestVisibleVersion: number;
}

/** Standalone R3-016 live assertions; root wires it before fixture closure. */
export async function runStructuredQuoteIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const fixture = await findFixture(sql);
  const quotes = createQuoteRepository(sql);
  const structured = createStructuredQuoteRepository(sql);
  const created = await quotes.createDraft({
    actorUserId: fixture.providerOwnerId,
    authoringMode: "PLATFORM_STRUCTURED",
    commandId: randomUUID(),
    conversationId: fixture.conversationId,
    requestContentRevision: fixture.requestContentRevision,
    requestVisibleVersion: fixture.requestVisibleVersion,
  });
  if (!("quote" in created))
    throw new Error("Expected structured Quote draft.");
  const quoteId = created.quote.id;

  await expectOrphanCommandRejected(sql, fixture, quoteId);

  const firstCommandId = randomUUID();
  const firstInput = saveInput(
    fixture,
    quoteId,
    firstCommandId,
    0,
    "Prvá verzia",
  );
  const first = await structured.saveDraft(firstInput);
  expect(first).toMatchObject({
    content: { contentRevision: 1, title: "Prvá verzia" },
    status: "SAVED",
  });
  await expectRawCommandReuseRejected(sql, firstCommandId);
  await expectRawContentConstraintGuards(sql, fixture, quoteId);
  await expect(structured.saveDraft(firstInput)).resolves.toMatchObject({
    content: { contentRevision: 1 },
    status: "DEDUPLICATED",
  });
  await expect(
    structured.saveDraft({
      ...firstInput,
      content: { ...firstInput.content, title: "Iný úmysel" },
    }),
  ).rejects.toBeInstanceOf(StructuredQuoteIdempotencyError);
  await expectReplayDeniedAfterSuspension(sql, firstInput);

  await expect(
    structured.readOwned({
      actorUserId: fixture.customerOwnerId,
      quoteId,
      quoteRevision: 1,
    }),
  ).resolves.toBeNull();
  const outsiderId = randomUUID() as UserId;
  await sql`INSERT INTO users (id) VALUES (${outsiderId})`;
  await expectRawActorSpoofRejected(sql, fixture, quoteId, outsiderId);
  await expect(
    structured.readOwned({
      actorUserId: outsiderId,
      quoteId,
      quoteRevision: 1,
    }),
  ).resolves.toBeNull();
  await expect(
    structured.saveDraft(
      saveInput(fixture, quoteId, randomUUID(), 1, "Cudzí zápis", outsiderId),
    ),
  ).resolves.toEqual({ status: "NOT_FOUND" });

  const competingSaves = await Promise.all([
    structured.saveDraft(
      saveInput(fixture, quoteId, randomUUID(), 1, "Súbežná verzia A"),
    ),
    structured.saveDraft(
      saveInput(fixture, quoteId, randomUUID(), 1, "Súbežná verzia B"),
    ),
  ]);
  expect(competingSaves.map((result) => result.status).sort()).toEqual([
    "SAVED",
    "STALE_REVISION",
  ]);
  const current = await structured.readOwned({
    actorUserId: fixture.providerOwnerId,
    quoteId,
    quoteRevision: 1,
  });
  expect(current).toMatchObject({ contentRevision: 2 });

  const expiredSave = saveInput(
    fixture,
    quoteId,
    randomUUID(),
    2,
    "Uloženie pred odoslaním",
    fixture.providerOwnerId,
    1,
    new Date("2000-01-01T00:00:00.000Z"),
  );
  const saveFirst = deferred<SaveStructuredQuoteDraftResult>();
  const releaseSave = deferred<void>();
  const saveTransaction = sql.begin(async (transaction) => {
    const result =
      await createStructuredQuoteRepository(transaction).saveDraft(expiredSave);
    saveFirst.resolve(result);
    await releaseSave.promise;
    return result;
  });
  await expect(saveFirst.promise).resolves.toMatchObject({ status: "SAVED" });
  const submitPid = deferred<number>();
  const submitAfterSave = sql.begin(async (transaction) => {
    submitPid.resolve(await backendPid(transaction));
    return createQuoteRepository(transaction).submit({
      actorUserId: fixture.providerOwnerId,
      commandId: randomUUID(),
      expectedDraftStateRevision: 1,
      expectedSubmittedStateRevision: null,
      quoteId,
      revision: 1,
    });
  });
  await waitUntilLockBlocked(sql, await submitPid.promise);
  releaseSave.resolve(undefined);
  await expect(saveTransaction).resolves.toMatchObject({ status: "SAVED" });
  await expect(submitAfterSave).resolves.toEqual({
    status: "AUTHORING_NOT_READY",
  });

  const eligibleSave = saveInput(
    fixture,
    quoteId,
    randomUUID(),
    3,
    "Aktuálna ponuka",
  );
  await expect(structured.saveDraft(eligibleSave)).resolves.toMatchObject({
    content: { contentRevision: 4 },
    status: "SAVED",
  });
  await expect(
    quotes.submit({
      actorUserId: fixture.providerOwnerId,
      commandId: randomUUID(),
      expectedDraftStateRevision: 1,
      expectedSubmittedStateRevision: null,
      quoteId,
      revision: 1,
    }),
  ).resolves.toMatchObject({
    quote: { currentSubmitted: { revision: 1, state: "SUBMITTED" } },
    status: "APPLIED",
  });

  await expect(
    structured.readOwned({
      actorUserId: fixture.customerOwnerId,
      quoteId,
      quoteRevision: 1,
    }),
  ).resolves.toMatchObject({ priceMode: "FIXED", quoteRevision: 1 });
  await expect(
    sql<Array<{ readonly eligible: boolean }>>`
      SELECT quote_revision_authoring_is_eligible(
        ${quoteId}, 1, 'EXTERNAL_PDF'
      ) AS eligible
    `,
  ).resolves.toEqual([{ eligible: false }]);
  await expectRawTextPolicy(sql);

  const revision = await quotes.createRevision({
    actorUserId: fixture.providerOwnerId,
    authoringMode: "PLATFORM_STRUCTURED",
    commandId: randomUUID(),
    expectedSubmittedStateRevision: 2,
    quoteId,
    requestContentRevision: fixture.requestContentRevision,
    requestVisibleVersion: fixture.requestVisibleVersion,
  });
  expect(revision).toMatchObject({
    quote: { currentDraft: { revision: 2, state: "DRAFT" } },
  });
  const revisionTwoContent = saveInput(
    fixture,
    quoteId,
    randomUUID(),
    0,
    "Druhá ponuka",
    fixture.providerOwnerId,
    2,
  );
  await expect(structured.saveDraft(revisionTwoContent)).resolves.toMatchObject(
    {
      status: "SAVED",
    },
  );
  const submitFirst = deferred<QuoteCommandResult>();
  const releaseSubmit = deferred<void>();
  const submitTransaction = sql.begin(async (transaction) => {
    const result = await createQuoteRepository(transaction).submit({
      actorUserId: fixture.providerOwnerId,
      commandId: randomUUID(),
      expectedDraftStateRevision: 1,
      expectedSubmittedStateRevision: 2,
      quoteId,
      revision: 2,
    });
    submitFirst.resolve(result);
    await releaseSubmit.promise;
    return result;
  });
  await expect(submitFirst.promise).resolves.toMatchObject({
    status: "APPLIED",
  });
  const savePid = deferred<number>();
  const expiredAfterSubmit = sql.begin(async (transaction) => {
    savePid.resolve(await backendPid(transaction));
    return createStructuredQuoteRepository(transaction).saveDraft(
      saveInput(
        fixture,
        quoteId,
        randomUUID(),
        1,
        "Oneskorené uloženie",
        fixture.providerOwnerId,
        2,
        new Date("2000-01-01T00:00:00.000Z"),
      ),
    );
  });
  await waitUntilLockBlocked(sql, await savePid.promise);
  releaseSubmit.resolve(undefined);
  await expect(submitTransaction).resolves.toMatchObject({ status: "APPLIED" });
  await expect(expiredAfterSubmit).resolves.toEqual({ status: "READ_ONLY" });
  await expect(structured.saveDraft(revisionTwoContent)).resolves.toMatchObject(
    {
      content: { contentRevision: 1 },
      status: "DEDUPLICATED",
    },
  );

  const revisionThree = await quotes.createRevision({
    actorUserId: fixture.providerOwnerId,
    authoringMode: "PLATFORM_STRUCTURED",
    commandId: randomUUID(),
    expectedSubmittedStateRevision: 2,
    quoteId,
    requestContentRevision: fixture.requestContentRevision,
    requestVisibleVersion: fixture.requestVisibleVersion,
  });
  expect(revisionThree).toMatchObject({
    quote: { currentDraft: { revision: 3, state: "DRAFT" } },
  });
  await sql.begin(async (transaction) => {
    const [clock] = await transaction<Array<{ readonly validUntil: Date }>>`
      SELECT clock_timestamp() + interval '750 milliseconds'
        AS "validUntil"
    `;
    if (clock === undefined) throw new Error("Expected DB-relative validity.");
    await expect(
      createStructuredQuoteRepository(transaction).saveDraft(
        saveInput(
          fixture,
          quoteId,
          randomUUID(),
          0,
          "Platnosť počas transakcie",
          fixture.providerOwnerId,
          3,
          clock.validUntil,
        ),
      ),
    ).resolves.toMatchObject({ status: "SAVED" });
    await transaction`SELECT pg_sleep(1.25)`;
    await expect(
      createQuoteRepository(transaction).submit({
        actorUserId: fixture.providerOwnerId,
        commandId: randomUUID(),
        expectedDraftStateRevision: 1,
        expectedSubmittedStateRevision: 2,
        quoteId,
        revision: 3,
      }),
    ).resolves.toEqual({ status: "AUTHORING_NOT_READY" });
  });

  await expect(
    sql`UPDATE quote_structured_content_revisions
      SET title = 'Prepísané' WHERE quote_id = ${quoteId}`,
  ).rejects.toThrow(/append-only/u);
}

async function findFixture(sql: Sql): Promise<Fixture> {
  const [fixture] = await sql<Fixture[]>`
    SELECT conversation.id AS "conversationId",
      conversation.invitation_id AS "invitationId",
      customer.owner_user_id AS "customerOwnerId",
      craftsman.owner_user_id AS "providerOwnerId",
      provenance.content_revision AS "requestContentRevision",
      provenance.visible_version AS "requestVisibleVersion"
    FROM current_conversations conversation
    JOIN customer_profiles customer
      ON customer.id = conversation.customer_profile_id
    JOIN craftsman_profiles craftsman
      ON craftsman.id = conversation.craftsman_profile_id
    JOIN LATERAL (
      SELECT content_revision, visible_version
      FROM job_request_active_content_revisions provenance
      WHERE provenance.job_request_id = conversation.job_request_id
      ORDER BY content_revision DESC LIMIT 1
    ) provenance ON true
    JOIN users customer_owner ON customer_owner.id = customer.owner_user_id
      AND customer_owner.account_state = 'ACTIVE'
    JOIN users provider_owner ON provider_owner.id = craftsman.owner_user_id
      AND provider_owner.account_state = 'ACTIVE'
    WHERE conversation.access_state = 'WRITABLE'
      AND conversation.invitation_state = 'ENGAGED'
      AND NOT EXISTS (
        SELECT 1 FROM quotes quote
        WHERE quote.conversation_id = conversation.id
      )
    ORDER BY conversation.created_at DESC, conversation.id DESC LIMIT 1
  `;
  if (fixture === undefined) {
    throw new Error("R3-016 requires a fresh ENGAGED conversation fixture.");
  }
  return fixture;
}

async function expectOrphanCommandRejected(
  sql: Sql,
  fixture: Fixture,
  quoteId: QuoteId,
): Promise<void> {
  await expect(
    sql.begin(async (transaction) => {
      const input = normalizeSaveStructuredQuoteDraftInput(
        saveInput(fixture, quoteId, randomUUID(), 0, "Orphan"),
      );
      const stored = await insertRawCommand(transaction, input);
      expect(stored.resultingContentRevision).toBe(1);
      expect(stored.createdAt.valueOf()).toBeGreaterThan(
        new Date("2020-01-01T00:00:00.000Z").valueOf(),
      );
      await transaction`SET CONSTRAINTS ALL IMMEDIATE`;
    }),
  ).rejects.toThrow(/quote_structured_command_effect_fk/u);
}

async function insertRawCommand(
  sql: TransactionSql,
  input: SaveStructuredQuoteDraftInput,
): Promise<{
  readonly createdAt: Date;
  readonly resultingContentRevision: number;
}> {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ ...input, commandId: undefined }))
    .digest("hex");
  const [stored] = await sql<
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
      ${input.actorUserId}, ${input.expectedContentRevision}, 999,
      ${fingerprint}, '2000-01-01T00:00:00Z'
    )
    RETURNING resulting_content_revision AS "resultingContentRevision",
      created_at AS "createdAt"
  `;
  if (stored === undefined) throw new Error("Expected raw command effect.");
  return stored;
}

async function expectRawCommandReuseRejected(
  sql: Sql,
  commandId: string,
): Promise<void> {
  await expect(
    sql`
      INSERT INTO quote_structured_authoring_commands (
        command_id, quote_id, quote_revision, actor_user_id,
        expected_content_revision, resulting_content_revision,
        payload_fingerprint, created_at
      ) SELECT command_id, quote_id, quote_revision, actor_user_id,
        expected_content_revision, 999, repeat('f', 64),
        '2000-01-01T00:00:00Z'
      FROM quote_structured_authoring_commands
      WHERE command_id = ${commandId}
    `,
  ).rejects.toThrow(/stale|duplicate|unique/u);
}

async function expectRawActorSpoofRejected(
  sql: Sql,
  fixture: Fixture,
  quoteId: QuoteId,
  outsiderId: UserId,
): Promise<void> {
  const input = normalizeSaveStructuredQuoteDraftInput(
    saveInput(fixture, quoteId, randomUUID(), 1, "Falšovaný autor", outsiderId),
  );
  await expect(
    sql.begin(async (transaction) => insertRawCommand(transaction, input)),
  ).rejects.toThrow(/owned structured Quote context required/u);
}

async function expectRawContentConstraintGuards(
  sql: Sql,
  fixture: Fixture,
  quoteId: QuoteId,
): Promise<void> {
  for (const invalidShape of ["EDGE_TEXT", "MULTIDIMENSIONAL", "LOWER_BOUND"])
    await expect(
      sql.begin(async (transaction) => {
        const input = normalizeSaveStructuredQuoteDraftInput(
          saveInput(fixture, quoteId, randomUUID(), 1, `Raw ${invalidShape}`),
        );
        await insertRawCommand(transaction, input);
        await transaction`
          INSERT INTO quote_structured_content_revisions (
            quote_id, quote_revision, content_revision, command_id,
            title, summary, price_mode, currency, total_amount_cents,
            range_minimum_cents, range_maximum_cents, price_basis, vat_status,
            labor_amount_cents, labor_description, material_amount_cents,
            material_description, transport_amount_cents,
            transport_description, other_amount_cents, other_description,
            included_scope, excluded_scope, conditional_on_inspection,
            inspection_conditions, estimated_start_on,
            estimated_duration_days, valid_until, warranty_information,
            material_responsibility, deposit_mode, deposit_amount_cents,
            deposit_percentage_basis_points, deposit_notes, provider_notes,
            changed_at
          )
          SELECT content.quote_id, content.quote_revision, 1,
            ${input.commandId},
            CASE WHEN ${invalidShape} = 'EDGE_TEXT'
              THEN E'Neplatný názov\\n' ELSE content.title END,
            content.summary, content.price_mode, content.currency,
            content.total_amount_cents, content.range_minimum_cents,
            content.range_maximum_cents, content.price_basis,
            content.vat_status, content.labor_amount_cents,
            content.labor_description, content.material_amount_cents,
            content.material_description, content.transport_amount_cents,
            content.transport_description, content.other_amount_cents,
            content.other_description,
            CASE ${invalidShape}
              WHEN 'MULTIDIMENSIONAL' THEN '{{A,B},{C,D}}'::text[]
              WHEN 'LOWER_BOUND' THEN '[2:3]={A,B}'::text[]
              ELSE content.included_scope
            END,
            content.excluded_scope, content.conditional_on_inspection,
            content.inspection_conditions, content.estimated_start_on,
            content.estimated_duration_days, content.valid_until,
            content.warranty_information, content.material_responsibility,
            content.deposit_mode, content.deposit_amount_cents,
            content.deposit_percentage_basis_points, content.deposit_notes,
            content.provider_notes, '2000-01-01T00:00:00Z'
          FROM current_quote_structured_content content
          WHERE content.quote_id = ${quoteId}
            AND content.quote_revision = 1
        `;
      }),
    ).rejects.toThrow(/structured_(required_text|scope_bounds)/u);
}

function saveInput(
  fixture: Fixture,
  quoteId: QuoteId,
  commandId: string,
  expectedContentRevision: number,
  title: string,
  actorUserId: UserId = fixture.providerOwnerId,
  quoteRevision = 1,
  validUntil = new Date("2100-01-01T00:00:00.000Z"),
): SaveStructuredQuoteDraftInput {
  return {
    actorUserId,
    commandId,
    content: {
      components: {
        labor: { amountCents: 100_000, description: "Montážne práce" },
        material: { amountCents: 45_000, description: "Bežný materiál" },
        transport: {
          amountCents: 5_000,
          description: "Paušálna doprava",
        },
      },
      conditionalOnInspection: false,
      currency: "EUR",
      depositMode: "PERCENTAGE",
      depositNotes: "Informačná záloha na materiál",
      depositPercentageBasisPoints: 3_000,
      estimatedDurationDays: 5,
      estimatedStartOn: "2026-10-05",
      excludedScope: ["Nebezpečný odpad"],
      includedScope: ["Montáž", "Bežný materiál"],
      materialResponsibility: "MIXED",
      priceBasis: "Celková cena za uvedený rozsah",
      priceMode: "FIXED",
      providerNotes: "Termín potvrdíme po objednaní materiálu.",
      summary: "Kompletná montáž podľa zadania.",
      title,
      totalAmountCents: 150_000,
      validUntil,
      vatStatus: "VAT_INCLUDED",
      warrantyInformation: "Záruka 24 mesiacov.",
    },
    expectedContentRevision,
    quoteId,
    quoteRevision,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function backendPid(sql: TransactionSql): Promise<number> {
  const [row] = await sql<Array<{ readonly pid: number }>>`
    SELECT pg_backend_pid() AS pid
  `;
  if (row === undefined) throw new Error("Expected PostgreSQL backend pid.");
  return row.pid;
}

async function waitUntilLockBlocked(sql: Sql, pid: number): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const [activity] = await sql<
      Array<{ readonly waitEventType: string | null }>
    >`
      SELECT wait_event_type AS "waitEventType"
      FROM pg_stat_activity WHERE pid = ${pid}
    `;
    if (activity?.waitEventType === "Lock") return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Backend ${pid} did not reach a lock barrier.`);
}

async function expectReplayDeniedAfterSuspension(
  sql: Sql,
  input: SaveStructuredQuoteDraftInput,
): Promise<void> {
  await sql.begin(async (transaction) => {
    await transaction`
      UPDATE users SET account_state = 'SUSPENDED'
      WHERE id = ${input.actorUserId}
    `;
    await expect(
      createStructuredQuoteRepository(transaction).saveDraft(input),
    ).resolves.toEqual({ status: "NOT_FOUND" });
    await transaction`
      UPDATE users SET account_state = 'ACTIVE'
      WHERE id = ${input.actorUserId}
    `;
  });
}

async function expectRawTextPolicy(sql: Sql): Promise<void> {
  await expect(
    sql<
      Array<{
        readonly contact: boolean;
        readonly edgeCr: boolean;
        readonly edgeLf: boolean;
        readonly edgeNbsp: boolean;
        readonly edgeTab: boolean;
        readonly onlyLf: boolean;
        readonly onlyNbsp: boolean;
      }>
    >`
      SELECT
        quote_structured_text_is_valid(
          'Kontakt +421 900 123 456', 160
        ) AS contact,
        quote_structured_text_is_valid(E'Názov\\r', 160) AS "edgeCr",
        quote_structured_text_is_valid(E'Názov\\n', 160) AS "edgeLf",
        quote_structured_text_is_valid('Názov' || chr(160), 160)
          AS "edgeNbsp",
        quote_structured_text_is_valid(E'\\tNázov', 160) AS "edgeTab",
        quote_structured_text_is_valid(E'\\n', 160) AS "onlyLf",
        quote_structured_text_is_valid(chr(160), 160) AS "onlyNbsp"
    `,
  ).resolves.toEqual([
    {
      contact: false,
      edgeCr: false,
      edgeLf: false,
      edgeNbsp: false,
      edgeTab: false,
      onlyLf: false,
      onlyNbsp: false,
    },
  ]);
}
