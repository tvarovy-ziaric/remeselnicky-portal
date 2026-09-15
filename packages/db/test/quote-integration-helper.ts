import { createHash, randomUUID } from "node:crypto";

import type { ConversationId, QuoteId, UserId } from "@portal/domain";
import type { Sql, TransactionSql } from "postgres";
import { expect } from "vitest";

import { createQuoteRepository } from "../src/quote-repository.js";

interface Fixture {
  readonly conversationId: ConversationId;
  readonly customerOwnerId: UserId;
  readonly providerOwnerId: UserId;
  readonly requestContentRevision: number;
  readonly requestVisibleVersion: number;
}

const rollbackProbe = "ROLLBACK_R3_015_QUOTE_PROBE";

/**
 * Standalone live-PostgreSQL assertions. The root runner may wire this after
 * 0048 and before any helper closes the selected ENGAGED invitation.
 */
export async function runQuoteIntegrationAssertions(sql: Sql): Promise<void> {
  await expect(
    sql.begin(async (transaction) => {
      const fixture = await findFixture(transaction);
      const repository = createQuoteRepository(transaction);

      // Exercise the core state machine without claiming either later
      // authoring schema: this replacement and all test data roll back.
      await transaction`
        CREATE OR REPLACE FUNCTION quote_revision_authoring_is_eligible(
          target_quote_id uuid,
          target_quote_revision integer,
          target_mode quote_authoring_mode
        ) RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER
        SET search_path = public, pg_temp AS 'SELECT true;'
      `;

      await expectOrphanCreateDraftRejected(transaction, fixture);

      const createCommandId = randomUUID();
      const created = await repository.createDraft({
        actorUserId: fixture.providerOwnerId,
        authoringMode: "PLATFORM_STRUCTURED",
        commandId: createCommandId,
        conversationId: fixture.conversationId,
        requestContentRevision: fixture.requestContentRevision,
        requestVisibleVersion: fixture.requestVisibleVersion,
      });
      if (!("quote" in created)) throw new Error("Expected Quote draft.");
      expect(created).toMatchObject({
        quote: {
          currentDraft: { revision: 1, state: "DRAFT", stateRevision: 1 },
          currentSubmitted: null,
          participantRole: "CRAFTSMAN",
        },
        status: "APPLIED",
      });
      const quoteId = created.quote.id;

      await expect(
        repository.createDraft({
          actorUserId: fixture.providerOwnerId,
          authoringMode: "PLATFORM_STRUCTURED",
          commandId: createCommandId,
          conversationId: fixture.conversationId,
          requestContentRevision: fixture.requestContentRevision,
          requestVisibleVersion: fixture.requestVisibleVersion,
        }),
      ).resolves.toMatchObject({ status: "DEDUPLICATED" });

      const outsiderId = randomUUID() as UserId;
      await transaction`INSERT INTO users (id) VALUES (${outsiderId})`;
      await expect(
        repository.readOwned({ actorUserId: outsiderId, quoteId }),
      ).resolves.toBeNull();
      await expect(
        repository.createRevision({
          actorUserId: outsiderId,
          authoringMode: "PLATFORM_STRUCTURED",
          commandId: randomUUID(),
          expectedSubmittedStateRevision: 2,
          quoteId,
          requestContentRevision: fixture.requestContentRevision,
          requestVisibleVersion: fixture.requestVisibleVersion,
        }),
      ).resolves.toEqual({ status: "NOT_FOUND" });

      await transaction`
        UPDATE users SET account_state = 'SUSPENDED',
          account_state_changed_at = clock_timestamp(),
          updated_at = clock_timestamp()
        WHERE id = ${fixture.providerOwnerId}
      `;
      await expect(
        repository.readOwned({
          actorUserId: fixture.providerOwnerId,
          quoteId,
        }),
      ).resolves.toBeNull();
      await transaction`
        UPDATE users SET account_state = 'ACTIVE',
          account_state_changed_at = clock_timestamp(),
          updated_at = clock_timestamp()
        WHERE id = ${fixture.providerOwnerId}
      `;

      const submitted = await repository.submit({
        actorUserId: fixture.providerOwnerId,
        commandId: randomUUID(),
        expectedDraftStateRevision: 1,
        expectedSubmittedStateRevision: null,
        quoteId,
        revision: 1,
      });
      expect(submitted).toMatchObject({
        quote: {
          currentDraft: null,
          currentSubmitted: { revision: 1, state: "SUBMITTED" },
        },
        status: "APPLIED",
      });

      await expectOrphanCreateRevisionRejected(transaction, fixture, quoteId);
      const revision = await repository.createRevision({
        actorUserId: fixture.providerOwnerId,
        authoringMode: "EXTERNAL_PDF",
        commandId: randomUUID(),
        expectedSubmittedStateRevision: 2,
        quoteId,
        requestContentRevision: fixture.requestContentRevision,
        requestVisibleVersion: fixture.requestVisibleVersion,
      });
      expect(revision).toMatchObject({
        quote: {
          currentDraft: { revision: 2, state: "DRAFT" },
          currentSubmitted: { revision: 1, state: "SUBMITTED" },
        },
      });

      const customerBeforeSubmit = await repository.readOwned({
        actorUserId: fixture.customerOwnerId,
        quoteId,
      });
      expect(customerBeforeSubmit).toMatchObject({
        currentDraft: null,
        currentSubmitted: { revision: 1 },
        participantRole: "CUSTOMER",
        revisions: [{ revision: 1 }],
      });

      await expectOrphanSubmitRejected(transaction, fixture, quoteId);
      const resubmitted = await repository.submit({
        actorUserId: fixture.providerOwnerId,
        commandId: randomUUID(),
        expectedDraftStateRevision: 1,
        expectedSubmittedStateRevision: 2,
        quoteId,
        revision: 2,
      });
      expect(resubmitted).toMatchObject({
        quote: {
          currentDraft: null,
          currentSubmitted: { revision: 2, state: "SUBMITTED" },
          revisions: [
            { revision: 1, state: "SUPERSEDED" },
            { revision: 2, state: "SUBMITTED" },
          ],
        },
      });

      await expectOrphanRejectRejected(transaction, fixture, quoteId);
      const rejected = await repository.reject({
        actorUserId: fixture.customerOwnerId,
        commandId: randomUUID(),
        expectedStateRevision: 2,
        quoteId,
        rejectionReason: "Prosím doplniť rozsah dopravy.",
        revision: 2,
      });
      expect(rejected).toMatchObject({
        quote: {
          currentDraft: null,
          currentSubmitted: null,
          revisions: [
            { revision: 1, state: "SUPERSEDED" },
            {
              rejectionReason: "Prosím doplniť rozsah dopravy.",
              revision: 2,
              state: "REJECTED",
            },
          ],
        },
      });

      await expect(
        transaction`UPDATE quote_revision_state_events
          SET changed_at = clock_timestamp() WHERE quote_id = ${quoteId}`,
      ).rejects.toThrow(/append-only/u);
      throw new Error(rollbackProbe);
    }),
  ).rejects.toThrow(rollbackProbe);
}

async function findFixture(sql: TransactionSql): Promise<Fixture> {
  const [fixture] = await sql<Fixture[]>`
    SELECT conversation.id AS "conversationId",
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
    throw new Error("R3-015 requires a fresh ENGAGED conversation fixture.");
  }
  return fixture;
}

async function expectOrphanCreateDraftRejected(
  transaction: TransactionSql,
  fixture: Fixture,
): Promise<void> {
  await expect(
    transaction.savepoint(async (savepoint) => {
      const commandId = randomUUID();
      const effect = await insertRawCommand(savepoint, {
        actorUserId: fixture.providerOwnerId,
        authoringMode: "PLATFORM_STRUCTURED",
        commandId,
        conversationId: fixture.conversationId,
        expectedDraft: null,
        expectedSubmitted: null,
        kind: "CREATE_DRAFT",
        quoteId: randomUUID(),
        requestContentRevision: fixture.requestContentRevision,
        requestVisibleVersion: fixture.requestVisibleVersion,
        revision: 1,
        target: "DRAFT",
      });
      await savepoint`
        INSERT INTO quotes (
          id, invitation_id, conversation_id, create_command_id, created_at
        ) SELECT ${effect.quoteId}, conversation.invitation_id,
          ${fixture.conversationId}, ${commandId}, ${effect.createdAt}
        FROM conversations conversation
        WHERE conversation.id = ${fixture.conversationId}
      `;
      await savepoint`
        INSERT INTO quote_revision_identities (
          quote_id, revision, create_command_id, authoring_mode,
          request_content_revision, request_visible_version, created_at
        ) VALUES (
          ${effect.quoteId}, ${effect.quoteRevision}, ${commandId},
          'PLATFORM_STRUCTURED', ${fixture.requestContentRevision},
          ${fixture.requestVisibleVersion}, ${effect.createdAt}
        )
      `;
      await savepoint`SET CONSTRAINTS ALL IMMEDIATE`;
    }),
  ).rejects.toThrow(/quote_command_primary_state_effect_fk/u);
}

async function expectOrphanCreateRevisionRejected(
  transaction: TransactionSql,
  fixture: Fixture,
  quoteId: QuoteId,
): Promise<void> {
  await expect(
    transaction.savepoint(async (savepoint) => {
      const commandId = randomUUID();
      const effect = await insertRawCommand(savepoint, {
        actorUserId: fixture.providerOwnerId,
        authoringMode: "EXTERNAL_PDF",
        commandId,
        conversationId: fixture.conversationId,
        expectedDraft: null,
        expectedSubmitted: 2,
        kind: "CREATE_REVISION",
        quoteId,
        requestContentRevision: fixture.requestContentRevision,
        requestVisibleVersion: fixture.requestVisibleVersion,
        revision: 99,
        target: "DRAFT",
      });
      await savepoint`
        INSERT INTO quote_revision_identities (
          quote_id, revision, create_command_id, authoring_mode,
          request_content_revision, request_visible_version, created_at
        ) VALUES (
          ${quoteId}, ${effect.quoteRevision}, ${commandId}, 'EXTERNAL_PDF',
          ${fixture.requestContentRevision}, ${fixture.requestVisibleVersion},
          ${effect.createdAt}
        )
      `;
      await savepoint`SET CONSTRAINTS ALL IMMEDIATE`;
    }),
  ).rejects.toThrow(/quote_command_primary_state_effect_fk/u);
}

async function expectOrphanSubmitRejected(
  transaction: TransactionSql,
  fixture: Fixture,
  quoteId: QuoteId,
): Promise<void> {
  await expect(
    transaction.savepoint(async (savepoint) => {
      await insertRawCommand(savepoint, {
        actorUserId: fixture.providerOwnerId,
        authoringMode: null,
        commandId: randomUUID(),
        conversationId: fixture.conversationId,
        expectedDraft: 1,
        expectedSubmitted: 2,
        kind: "SUBMIT",
        quoteId,
        requestContentRevision: null,
        requestVisibleVersion: null,
        revision: 2,
        target: "SUBMITTED",
      });
      await savepoint`SET CONSTRAINTS ALL IMMEDIATE`;
    }),
  ).rejects.toThrow(/quote_command_(primary|prior)_state_effect_fk/u);
}

async function expectOrphanRejectRejected(
  transaction: TransactionSql,
  fixture: Fixture,
  quoteId: QuoteId,
): Promise<void> {
  await expect(
    transaction.savepoint(async (savepoint) => {
      await insertRawCommand(savepoint, {
        actorUserId: fixture.customerOwnerId,
        authoringMode: null,
        commandId: randomUUID(),
        conversationId: fixture.conversationId,
        expectedDraft: null,
        expectedSubmitted: 2,
        kind: "REJECT",
        quoteId,
        requestContentRevision: null,
        requestVisibleVersion: null,
        revision: 2,
        target: "REJECTED",
      });
      await savepoint`SET CONSTRAINTS ALL IMMEDIATE`;
    }),
  ).rejects.toThrow(/quote_command_primary_state_effect_fk/u);
}

interface RawCommand {
  readonly actorUserId: UserId;
  readonly authoringMode: "EXTERNAL_PDF" | "PLATFORM_STRUCTURED" | null;
  readonly commandId: string;
  readonly conversationId: ConversationId;
  readonly expectedDraft: number | null;
  readonly expectedSubmitted: number | null;
  readonly kind: "CREATE_DRAFT" | "CREATE_REVISION" | "REJECT" | "SUBMIT";
  readonly quoteId: string;
  readonly requestContentRevision: number | null;
  readonly requestVisibleVersion: number | null;
  readonly revision: number;
  readonly target: "DRAFT" | "REJECTED" | "SUBMITTED";
}

async function insertRawCommand(
  sql: TransactionSql,
  command: RawCommand,
): Promise<{
  readonly createdAt: Date;
  readonly quoteId: string;
  readonly quoteRevision: number;
}> {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(command))
    .digest("hex");
  const [effect] = await sql<
    Array<{
      readonly createdAt: Date;
      readonly quoteId: string;
      readonly quoteRevision: number;
    }>
  >`
    INSERT INTO quote_core_commands (
      command_id, quote_id, conversation_id, actor_user_id, command_kind,
      quote_revision, authoring_mode, request_content_revision,
      request_visible_version, expected_draft_state_revision,
      expected_submitted_state_revision, resulting_state_revision,
      target_state, rejection_reason, payload_fingerprint, created_at
    ) VALUES (
      ${command.commandId}, ${command.quoteId}, ${command.conversationId},
      ${command.actorUserId}, ${command.kind}, ${command.revision},
      ${command.authoringMode}, ${command.requestContentRevision},
      ${command.requestVisibleVersion}, ${command.expectedDraft},
      ${command.expectedSubmitted}, 1, ${command.target}, NULL,
      ${fingerprint}, clock_timestamp()
    )
    RETURNING quote_id AS "quoteId", quote_revision AS "quoteRevision",
      created_at AS "createdAt"
  `;
  if (effect === undefined) throw new Error("Raw Quote command missing.");
  return effect;
}
