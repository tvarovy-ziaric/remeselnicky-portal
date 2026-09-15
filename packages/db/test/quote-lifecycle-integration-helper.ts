import { randomUUID } from "node:crypto";

import {
  normalizeJobRequestContentSection,
  QuoteIdempotencyError,
  type JobRequestCoreContent,
  type QuoteId,
  type UserId,
} from "@portal/domain";
import type { Sql } from "postgres";
import { expect } from "vitest";

import { createQuoteComparisonRepository } from "../src/quote-comparison-repository.js";
import { createQuoteLifecycleRepository } from "../src/quote-lifecycle-repository.js";
import { createQuoteRepository } from "../src/quote-repository.js";
import { createStructuredQuoteRepository } from "../src/quote-structured-repository.js";
import { createJobRequestVersionRepository } from "../src/job-request-version-repository.js";

interface Fixture {
  readonly customerOwnerId: UserId;
  readonly jobRequestId: string;
  readonly providerOwnerId: UserId;
  readonly quoteId: QuoteId;
  readonly quoteRevision: number;
  readonly stateRevision: number;
  readonly validUntil: Date;
}

/** Standalone R3-019 live assertions; the single migration runner owns wiring. */
export async function runQuoteLifecycleIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const fixture = await findFixture(sql);
  const lifecycle = createQuoteLifecycleRepository(sql);
  const comparison = createQuoteComparisonRepository(sql);
  await sql`SELECT pg_sleep(GREATEST(EXTRACT(EPOCH FROM (${fixture.validUntil}::timestamptz - clock_timestamp())), 0) + 0.1)`;
  const beforeSweep = await comparison.readCurrent({
    actorUserId: fixture.customerOwnerId,
    jobRequestId: fixture.jobRequestId as never,
  });
  expect(
    beforeSweep?.items.some((item) => item.quoteId === fixture.quoteId),
  ).toBe(false);
  await expect(
    sql<Array<{ state: string }>>`
      SELECT state::text AS state FROM quote_revision_heads
      WHERE quote_id = ${fixture.quoteId}
        AND quote_revision = ${fixture.quoteRevision}
    `,
  ).resolves.toEqual([{ state: "SUBMITTED" }]);
  await expectRawExpiryMetadataOverwrittenAndRolledBack(sql, fixture);
  const expiryRacers = await Promise.all([
    lifecycle.expireDueSubmitted(),
    lifecycle.expireDueSubmitted(),
  ]);
  expect(expiryRacers.flat()).toContainEqual({
    quoteId: fixture.quoteId,
    quoteRevision: fixture.quoteRevision,
  });
  expect(
    expiryRacers.flat().filter((item) => item.quoteId === fixture.quoteId),
  ).toHaveLength(1);
  const expiredContext = await lifecycle.readOwnedContext({
    actorUserId: fixture.customerOwnerId,
    quoteId: fixture.quoteId,
  });
  expect(expiredContext).toMatchObject({
    deadlinePassed: true,
    lifecycleAcceptanceEligible: false,
    state: "EXPIRED",
  });
  const [systemCommand] = await sql<
    Array<{
      actorKind: string;
      actorUserId: string | null;
      systemReference: string;
      validUntilSnapshot: Date | null;
    }>
  >`SELECT actor_kind::text AS "actorKind", actor_user_id AS "actorUserId", actor_system_reference AS "systemReference", valid_until_snapshot AS "validUntilSnapshot" FROM quote_lifecycle_commands WHERE quote_id = ${fixture.quoteId} AND quote_revision = ${fixture.quoteRevision} AND command_kind = 'EXPIRE'`;
  expect(systemCommand).toMatchObject({
    actorKind: "SYSTEM",
    actorUserId: null,
    systemReference: "quote-lifecycle:deadline-sweeper",
  });
  expect(systemCommand?.validUntilSnapshot).toBeInstanceOf(Date);

  const reconfirmInput = {
    actorUserId: fixture.providerOwnerId,
    authoringMode: "PLATFORM_STRUCTURED" as const,
    commandId: randomUUID(),
    expectedSourceStateRevision: fixture.stateRevision + 1,
    quoteId: fixture.quoteId,
    sourceQuoteRevision: fixture.quoteRevision,
    sourceState: "EXPIRED" as const,
  };
  const reconfirmed = await lifecycle.reconfirm(reconfirmInput);
  if (!("quote" in reconfirmed) || reconfirmed.quote.currentDraft === null)
    throw new Error("Expected a reconfirmed Quote draft.");
  const draftRevision = reconfirmed.quote.currentDraft.revision;
  await expect(lifecycle.reconfirm(reconfirmInput)).resolves.toMatchObject({
    quote: { currentDraft: { revision: draftRevision } },
    status: "DEDUPLICATED",
  });
  await expect(
    createStructuredQuoteRepository(sql).saveDraft({
      actorUserId: fixture.providerOwnerId,
      commandId: randomUUID(),
      content: content(new Date("2100-01-01T00:00:00Z")),
      expectedContentRevision: 0,
      quoteId: fixture.quoteId,
      quoteRevision: draftRevision,
    }),
  ).resolves.toMatchObject({ status: "SAVED" });
  await expect(
    createQuoteRepository(sql).submit({
      actorUserId: fixture.providerOwnerId,
      commandId: randomUUID(),
      expectedDraftStateRevision: 1,
      expectedSubmittedStateRevision: null,
      quoteId: fixture.quoteId,
      revision: draftRevision,
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });
  await expect(
    lifecycle.readOwnedContext({
      actorUserId: fixture.customerOwnerId,
      quoteId: fixture.quoteId,
    }),
  ).resolves.toMatchObject({
    lifecycleAcceptanceEligible: true,
    materiallyStale: false,
    state: "SUBMITTED",
  });
  const futureSweep = await lifecycle.expireDueSubmitted();
  expect(futureSweep.some((item) => item.quoteId === fixture.quoteId)).toBe(
    false,
  );
  await expect(
    lifecycle.readOwnedContext({
      actorUserId: fixture.customerOwnerId,
      quoteId: fixture.quoteId,
    }),
  ).resolves.toMatchObject({ deadlinePassed: false, state: "SUBMITTED" });

  await expectNonMaterialAndMaterialStaleness(sql, fixture, draftRevision);
  await expectRawCustomerWithdrawRejected(sql, {
    ...fixture,
    quoteRevision: draftRevision,
    stateRevision: 2,
  });
  await expectOrphanLifecycleCommandRejected(sql, {
    ...fixture,
    quoteRevision: draftRevision,
    stateRevision: 2,
  });
  const withdrawCommandIds = [randomUUID(), randomUUID()] as const;
  const withdrawals = await Promise.all(
    withdrawCommandIds.map((commandId) =>
      lifecycle.withdraw({
        actorUserId: fixture.providerOwnerId,
        commandId,
        expectedStateRevision: 2,
        quoteId: fixture.quoteId,
        quoteRevision: draftRevision,
      }),
    ),
  );
  expect(withdrawals.map((result) => result.status).sort()).toEqual([
    "APPLIED",
    "STALE_REVISION",
  ]);
  const appliedIndex = withdrawals.findIndex(
    (result) => result.status === "APPLIED",
  );
  const withdrawCommandId = withdrawCommandIds[appliedIndex];
  if (withdrawCommandId === undefined)
    throw new Error("Expected one applied withdrawal.");
  await expect(
    lifecycle.withdraw({
      actorUserId: fixture.providerOwnerId,
      commandId: withdrawCommandId,
      expectedStateRevision: 2,
      quoteId: fixture.quoteId,
      quoteRevision: draftRevision,
    }),
  ).resolves.toMatchObject({
    context: { state: "WITHDRAWN" },
    status: "DEDUPLICATED",
  });
  await expect(
    lifecycle.withdraw({
      actorUserId: fixture.providerOwnerId,
      commandId: withdrawCommandId,
      expectedStateRevision: 2,
      quoteId: fixture.quoteId,
      quoteRevision: fixture.quoteRevision,
    }),
  ).rejects.toBeInstanceOf(QuoteIdempotencyError);
  await sql`UPDATE users SET account_state = 'SUSPENDED', account_state_changed_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = ${fixture.providerOwnerId}`;
  await expect(
    lifecycle.withdraw({
      actorUserId: fixture.providerOwnerId,
      commandId: withdrawCommandId,
      expectedStateRevision: 2,
      quoteId: fixture.quoteId,
      quoteRevision: draftRevision,
    }),
  ).resolves.toEqual({ status: "NOT_FOUND" });
  await sql`UPDATE users SET account_state = 'ACTIVE', account_state_changed_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = ${fixture.providerOwnerId}`;
  await expect(
    lifecycle.withdraw({
      actorUserId: fixture.customerOwnerId,
      commandId: randomUUID(),
      expectedStateRevision: 2,
      quoteId: fixture.quoteId,
      quoteRevision: draftRevision,
    }),
  ).resolves.toEqual({ status: "NOT_FOUND" });
  const afterWithdrawal = await lifecycle.reconfirm({
    actorUserId: fixture.providerOwnerId,
    authoringMode: "PLATFORM_STRUCTURED",
    commandId: randomUUID(),
    expectedSourceStateRevision: 3,
    quoteId: fixture.quoteId,
    sourceQuoteRevision: draftRevision,
    sourceState: "WITHDRAWN",
  });
  expect(afterWithdrawal).toMatchObject({
    quote: { currentDraft: { revision: draftRevision + 1, state: "DRAFT" } },
    status: "APPLIED",
  });
  const finalRevision = draftRevision + 1;
  await expect(
    createStructuredQuoteRepository(sql).saveDraft({
      actorUserId: fixture.providerOwnerId,
      commandId: randomUUID(),
      content: content(null),
      expectedContentRevision: 0,
      quoteId: fixture.quoteId,
      quoteRevision: finalRevision,
    }),
  ).resolves.toMatchObject({ status: "SAVED" });
  await expect(
    createQuoteRepository(sql).submit({
      actorUserId: fixture.providerOwnerId,
      commandId: randomUUID(),
      expectedDraftStateRevision: 1,
      expectedSubmittedStateRevision: null,
      quoteId: fixture.quoteId,
      revision: finalRevision,
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });
  const nullDeadlineSweep = await lifecycle.expireDueSubmitted();
  expect(
    nullDeadlineSweep.some((item) => item.quoteId === fixture.quoteId),
  ).toBe(false);
  await expect(
    lifecycle.readOwnedContext({
      actorUserId: fixture.customerOwnerId,
      quoteId: fixture.quoteId,
    }),
  ).resolves.toMatchObject({ deadlinePassed: false, state: "SUBMITTED" });
  await expect(
    sql`UPDATE quote_lifecycle_commands SET expected_state_revision = 99 WHERE command_id = ${withdrawCommandId}`,
  ).rejects.toThrow(/append-only/u);
  await expect(
    sql`DELETE FROM quote_revision_state_events WHERE lifecycle_command_id = ${withdrawCommandId}`,
  ).rejects.toThrow(/append-only/u);
}

async function findFixture(sql: Sql): Promise<Fixture> {
  const [fixture] = await sql<
    Fixture[]
  >`SELECT customer.owner_user_id AS "customerOwnerId", invitation.job_request_id AS "jobRequestId", craftsman.owner_user_id AS "providerOwnerId", submitted.quote_id AS "quoteId", submitted.revision AS "quoteRevision", submitted.state_revision AS "stateRevision", quote_revision_valid_until(submitted.quote_id, submitted.revision, submitted.authoring_mode) AS "validUntil" FROM current_submitted_quotes submitted JOIN quotes quote ON quote.id = submitted.quote_id JOIN job_invitations invitation ON invitation.id = quote.invitation_id JOIN customer_profiles customer ON customer.id = invitation.customer_profile_id JOIN craftsman_profiles craftsman ON craftsman.id = invitation.craftsman_profile_id JOIN users customer_owner ON customer_owner.id = customer.owner_user_id AND customer_owner.account_state = 'ACTIVE' JOIN users provider_owner ON provider_owner.id = craftsman.owner_user_id AND provider_owner.account_state = 'ACTIVE' JOIN current_job_requests request ON request.id = invitation.job_request_id AND request.state::text = 'ACTIVE' WHERE submitted.authoring_mode = 'EXTERNAL_PDF' AND quote_revision_valid_until(submitted.quote_id, submitted.revision, submitted.authoring_mode) IS NOT NULL AND quote_active_participant_context(quote.conversation_id, craftsman.owner_user_id, 'CRAFTSMAN', true) ORDER BY quote_revision_valid_until(submitted.quote_id, submitted.revision, submitted.authoring_mode), submitted.submitted_at, submitted.quote_id LIMIT 1`;
  if (fixture === undefined)
    throw new Error("R3-019 requires a writable submitted Quote fixture.");
  return fixture;
}

async function expectRawCustomerWithdrawRejected(
  sql: Sql,
  fixture: Fixture,
): Promise<void> {
  await expect(
    sql.begin(async (tx) => {
      const commandId = randomUUID();
      await tx`INSERT INTO quote_lifecycle_commands (command_id, command_kind, actor_kind, quote_id, quote_revision, conversation_id, actor_user_id, actor_system_reference, expected_state_revision, resulting_state_revision, target_state, valid_until_snapshot, payload_fingerprint, created_at) SELECT ${commandId}, 'WITHDRAW', 'PROVIDER', quote.id, ${fixture.quoteRevision}, quote.conversation_id, ${fixture.customerOwnerId}, NULL, ${fixture.stateRevision}, ${fixture.stateRevision + 1}, 'WITHDRAWN', NULL, ${"0".repeat(64)}, clock_timestamp() FROM quotes quote WHERE quote.id = ${fixture.quoteId}`;
    }),
  ).rejects.toThrow(/owned Quote lifecycle context required/u);
}

async function expectRawExpiryMetadataOverwrittenAndRolledBack(
  sql: Sql,
  fixture: Fixture,
): Promise<void> {
  await expect(
    sql.begin(async (tx) => {
      const commandId = randomUUID();
      const [stored] = await tx<
        Array<{
          actorKind: string;
          actorUserId: string | null;
          resultingStateRevision: number;
          systemReference: string;
          targetState: string;
        }>
      >`INSERT INTO quote_lifecycle_commands (command_id, command_kind, actor_kind, quote_id, quote_revision, conversation_id, actor_user_id, actor_system_reference, expected_state_revision, resulting_state_revision, target_state, valid_until_snapshot, payload_fingerprint, created_at) SELECT ${commandId}, 'EXPIRE', 'PROVIDER', quote.id, ${fixture.quoteRevision}, quote.conversation_id, ${fixture.providerOwnerId}, 'spoofed', ${fixture.stateRevision}, 999, 'WITHDRAWN', NULL, ${"1".repeat(64)}, '2000-01-01T00:00:00Z' FROM quotes quote WHERE quote.id = ${fixture.quoteId} RETURNING actor_kind::text AS "actorKind", actor_user_id AS "actorUserId", actor_system_reference AS "systemReference", resulting_state_revision AS "resultingStateRevision", target_state::text AS "targetState"`;
      expect(stored).toEqual({
        actorKind: "SYSTEM",
        actorUserId: null,
        resultingStateRevision: fixture.stateRevision + 1,
        systemReference: "quote-lifecycle:deadline-sweeper",
        targetState: "EXPIRED",
      });
      await tx`INSERT INTO quote_revision_state_events (quote_id, quote_revision, state_revision, command_id, lifecycle_command_id, state, rejection_reason, changed_at, submitted_at) VALUES (${fixture.quoteId}, ${fixture.quoteRevision}, 999, NULL, ${commandId}, 'EXPIRED', NULL, '2000-01-01T00:00:00Z', '2000-01-01T00:00:00Z')`;
      throw new Error("ROLLBACK_EXPIRY_PROBE");
    }),
  ).rejects.toThrow("ROLLBACK_EXPIRY_PROBE");
}

async function expectOrphanLifecycleCommandRejected(
  sql: Sql,
  fixture: Fixture,
): Promise<void> {
  await expect(
    sql.begin(async (tx) => {
      await tx`INSERT INTO quote_lifecycle_commands (command_id, command_kind, actor_kind, quote_id, quote_revision, conversation_id, actor_user_id, actor_system_reference, expected_state_revision, resulting_state_revision, target_state, valid_until_snapshot, payload_fingerprint, created_at) SELECT ${randomUUID()}, 'WITHDRAW', 'PROVIDER', quote.id, ${fixture.quoteRevision}, quote.conversation_id, ${fixture.providerOwnerId}, NULL, ${fixture.stateRevision}, 999, 'WITHDRAWN', NULL, ${"2".repeat(64)}, '2000-01-01T00:00:00Z' FROM quotes quote WHERE quote.id = ${fixture.quoteId}`;
      await tx`SET CONSTRAINTS ALL IMMEDIATE`;
    }),
  ).rejects.toThrow(/quote_lifecycle_command_effect_fk/u);
}

async function expectNonMaterialAndMaterialStaleness(
  sql: Sql,
  fixture: Fixture,
  quoteRevision: number,
): Promise<void> {
  const versions = createJobRequestVersionRepository(sql);
  const active = await versions.readActiveOwned({
    actorUserId: fixture.customerOwnerId,
    jobRequestId: fixture.jobRequestId as never,
  });
  if (active.status !== "OK")
    throw new Error("Expected active request content.");
  const core = active.snapshot.sections.find(
    (section) => section.key === "request.core",
  );
  if (core?.key !== "request.core") throw new Error("Expected request core.");
  const corePayload = core.payload as JobRequestCoreContent;
  const titlePayload = {
    ...corePayload,
    title: `${corePayload.title} upravené`,
  };
  const minor = await versions.reviseActiveOwned({
    actorUserId: fixture.customerOwnerId,
    commandId: randomUUID(),
    expectedContentRevision: active.snapshot.version.contentRevision,
    jobRequestId: fixture.jobRequestId as never,
    section: normalizeJobRequestContentSection({
      key: "request.core",
      payload: titlePayload,
      schemaVersion: 1,
    }),
  });
  if (!("version" in minor)) throw new Error("Expected non-material edit.");
  expect(minor.version).toMatchObject({
    material: false,
    visibleVersion: active.snapshot.version.visibleVersion,
  });
  await expect(
    createQuoteLifecycleRepository(sql).readOwnedContext({
      actorUserId: fixture.customerOwnerId,
      quoteId: fixture.quoteId,
    }),
  ).resolves.toMatchObject({
    lifecycleAcceptanceEligible: true,
    materiallyStale: false,
    quoteRevision,
  });
  const minorComparison = await createQuoteComparisonRepository(
    sql,
  ).readCurrent({
    actorUserId: fixture.customerOwnerId,
    jobRequestId: fixture.jobRequestId as never,
  });
  expect(minorComparison?.items).toContainEqual(
    expect.objectContaining({
      materiallyStale: false,
      quoteId: fixture.quoteId,
    }),
  );

  const material = await versions.reviseActiveOwned({
    actorUserId: fixture.customerOwnerId,
    commandId: randomUUID(),
    expectedContentRevision: minor.version.contentRevision,
    jobRequestId: fixture.jobRequestId as never,
    section: normalizeJobRequestContentSection({
      key: "request.core",
      payload: {
        ...titlePayload,
        description: `${titlePayload.description} Rozšírený rozsah.`,
      },
      schemaVersion: 1,
    }),
  });
  if (!("version" in material)) throw new Error("Expected material edit.");
  expect(material.version.visibleVersion).toBe(
    active.snapshot.version.visibleVersion + 1,
  );
  await expect(
    createQuoteLifecycleRepository(sql).readOwnedContext({
      actorUserId: fixture.customerOwnerId,
      quoteId: fixture.quoteId,
    }),
  ).resolves.toMatchObject({
    lifecycleAcceptanceEligible: false,
    materiallyStale: true,
    quoteRevision,
  });
  const staleComparison = await createQuoteComparisonRepository(
    sql,
  ).readCurrent({
    actorUserId: fixture.customerOwnerId,
    jobRequestId: fixture.jobRequestId as never,
  });
  expect(staleComparison?.items).toContainEqual(
    expect.objectContaining({
      lifecycleAcceptanceEligible: false,
      materiallyStale: true,
      quoteId: fixture.quoteId,
    }),
  );
}

function content(validUntil: Date | null) {
  return {
    components: { labor: { amountCents: 10_000, description: "Práca" } },
    conditionalOnInspection: false,
    currency: "EUR" as const,
    depositMode: "NONE" as const,
    estimatedDurationDays: 1,
    excludedScope: [],
    includedScope: ["Práca"],
    materialResponsibility: "PROVIDER" as const,
    priceBasis: "Celková cena",
    priceMode: "FIXED" as const,
    summary: "Aktuálna ponuka",
    title: "Potvrdená ponuka",
    totalAmountCents: 10_000,
    validUntil,
    vatStatus: "VAT_INCLUDED" as const,
  };
}
