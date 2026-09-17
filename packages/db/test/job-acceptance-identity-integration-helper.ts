import { randomUUID } from "node:crypto";

import type { Sql, TransactionSql } from "postgres";
import { expect } from "vitest";

interface SourceIdentity {
  readonly acceptedByUserId: string;
  readonly acceptedQuoteId: string;
  readonly acceptedQuoteRevision: number;
  readonly acceptedRequestContentRevision: number;
  readonly acceptedRequestVisibleVersion: number;
  readonly authoringMode: string;
  readonly customerProfileId: string;
  readonly jobRequestId: string;
  readonly primaryCraftsmanProfileId: string;
  readonly winningConversationId: string;
  readonly winningInvitationId: string;
}

/** R4-002 structural assertions; no accepted Job is committed by this helper. */
export async function runJobAcceptanceIdentityIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const [source] = await sql<SourceIdentity[]>`
    SELECT customer.owner_user_id AS "acceptedByUserId",
      quote.id AS "acceptedQuoteId", identity.revision AS "acceptedQuoteRevision",
      identity.request_content_revision AS "acceptedRequestContentRevision",
      identity.request_visible_version AS "acceptedRequestVisibleVersion",
      identity.authoring_mode::text AS "authoringMode",
      invitation.customer_profile_id AS "customerProfileId",
      invitation.job_request_id AS "jobRequestId",
      invitation.craftsman_profile_id AS "primaryCraftsmanProfileId",
      quote.conversation_id AS "winningConversationId",
      quote.invitation_id AS "winningInvitationId"
    FROM quote_revision_identities identity
    JOIN quotes quote ON quote.id = identity.quote_id
    JOIN current_quote_revision_states state
      ON state.quote_id = identity.quote_id
      AND state.revision = identity.revision
      AND state.state = 'SUBMITTED'
    JOIN current_quote_acceptance_context context
      ON context.quote_id = identity.quote_id
      AND context.quote_revision = identity.revision
      AND context.lifecycle_acceptance_eligible
    JOIN job_invitations invitation ON invitation.id = quote.invitation_id
    JOIN current_job_invitations invitation_state
      ON invitation_state.id = invitation.id
      AND invitation_state.state = 'ENGAGED'
    JOIN customer_profiles customer ON customer.id = invitation.customer_profile_id
    ORDER BY identity.created_at, identity.quote_id, identity.revision
    LIMIT 1
  `;
  if (source === undefined)
    throw new Error("Quote identity fixture is missing.");
  const [before] = await sql<Array<{ count: number }>>`
    SELECT count(*)::integer AS count FROM jobs
  `;
  const marker = new Error("rollback job-identity test");
  await expect(
    sql.begin(async (transaction) => {
      const media = await createWinningConversationMediaFixture(
        transaction,
        source,
      );
      const commandId = randomUUID();
      const [created] = await transaction<
        Array<{ acceptedAt: Date; id: string; initialState: string }>
      >`
        INSERT INTO jobs (
          id, job_request_id, customer_profile_id, primary_craftsman_profile_id,
          winning_invitation_id, winning_conversation_id, accepted_quote_id,
          accepted_quote_revision, accepted_request_content_revision,
          accepted_request_visible_version, acceptance_command_id,
          acceptance_payload_fingerprint, accepted_by_user_id, accepted_at
        ) VALUES (
          ${randomUUID()}, ${source.jobRequestId}, ${source.customerProfileId},
          ${source.primaryCraftsmanProfileId}, ${source.winningInvitationId},
          ${source.winningConversationId}, ${source.acceptedQuoteId},
          ${source.acceptedQuoteRevision},
          ${source.acceptedRequestContentRevision},
          ${source.acceptedRequestVisibleVersion}, ${commandId},
          ${"a".repeat(64)}, ${source.acceptedByUserId},
          ${new Date("2000-01-01T00:00:00.000Z")}
        ) RETURNING id, initial_state::text AS "initialState",
          accepted_at AS "acceptedAt"
      `;
      expect(created?.id).not.toBeNull();
      expect(created?.initialState).toBe("CONFIRMED");
      expect(created?.acceptedAt.getUTCFullYear()).toBeGreaterThan(2020);
      const jobMedia = await transaction<
        Array<{
          chronologicalAt: Date;
          conversationId: string;
          mediaAssetId: string;
          mediaKind: string;
          sourceMessageId: string;
          uploadedByUserId: string;
        }>
      >`
        SELECT chronological_at AS "chronologicalAt",
          conversation_id AS "conversationId",
          media_asset_id AS "mediaAssetId", media_kind::text AS "mediaKind",
          source_message_id AS "sourceMessageId",
          uploaded_by_user_id AS "uploadedByUserId"
        FROM job_conversation_media
        WHERE job_id = ${created!.id}
        ORDER BY chronological_at, source_message_sequence, media_asset_id
      `;
      expect(jobMedia).toEqual([
        expect.objectContaining({
          chronologicalAt: media.capturedAt,
          conversationId: source.winningConversationId,
          mediaAssetId: media.readyAssetId,
          mediaKind: "IMAGE",
          sourceMessageId: media.messageId,
          uploadedByUserId: source.acceptedByUserId,
        }),
      ]);
      expect(
        jobMedia.some((item) => item.mediaAssetId === media.processingAssetId),
      ).toBe(false);
      await transaction`
        UPDATE media_asset_storage_objects
        SET revoked_at = clock_timestamp()
        WHERE media_asset_id = ${media.readyAssetId} AND role = 'CANONICAL'
      `;
      const revokedJobMedia = await transaction`
        SELECT media_asset_id FROM job_conversation_media
        WHERE job_id = ${created!.id}
      `;
      expect(revokedJobMedia).toEqual([]);
      const [snapshot] = await transaction<
        Array<{
          pdfMediaAssetId: string | null;
          quoteSnapshot: {
            authoringMode: string;
            commercialContent: unknown;
            pdfContentSha256: string | null;
            quoteId: string;
            revision: number;
          };
          requestSnapshot: {
            contentRevision: number;
            sections: Record<string, unknown>;
            visibleVersion: number;
          };
        }>
      >`
        SELECT pdf_media_asset_id AS "pdfMediaAssetId",
          quote_snapshot AS "quoteSnapshot",
          request_snapshot AS "requestSnapshot"
        FROM job_agreement_snapshots WHERE job_id = ${created!.id}
      `;
      expect(snapshot?.requestSnapshot.contentRevision).toBe(
        source.acceptedRequestContentRevision,
      );
      expect(snapshot?.requestSnapshot.visibleVersion).toBe(
        source.acceptedRequestVisibleVersion,
      );
      expect(
        Object.keys(snapshot?.requestSnapshot.sections ?? {}),
      ).toHaveLength(6);
      expect(snapshot?.quoteSnapshot.quoteId).toBe(source.acceptedQuoteId);
      expect(snapshot?.quoteSnapshot.revision).toBe(
        source.acceptedQuoteRevision,
      );
      expect(snapshot?.quoteSnapshot.commercialContent).toBeTruthy();
      expect(snapshot?.quoteSnapshot.authoringMode).toBe(source.authoringMode);
      if (source.authoringMode === "EXTERNAL_PDF") {
        expect(snapshot?.pdfMediaAssetId).toBeTruthy();
        expect(snapshot?.quoteSnapshot.pdfContentSha256).toMatch(
          /^[0-9a-f]{64}$/u,
        );
      } else {
        expect(snapshot?.pdfMediaAssetId).toBeNull();
      }
      const [qualification] = await transaction<
        Array<{
          approvedClaims: unknown[];
          professionCode: string;
          requirements: unknown[];
        }>
      >`
        SELECT profession_code AS "professionCode",
          approved_claims AS "approvedClaims", requirements
        FROM job_qualification_snapshots WHERE job_id = ${created!.id}
      `;
      expect(qualification?.professionCode).toBeTruthy();
      expect(Array.isArray(qualification?.requirements)).toBe(true);
      expect(Array.isArray(qualification?.approvedClaims)).toBe(true);
      const [acceptanceEvent] = await transaction<
        Array<{
          actorUserId: string;
          commandId: string;
          confirmationContract: string;
          occurredAt: Date;
        }>
      >`
        SELECT actor_user_id AS "actorUserId", command_id AS "commandId",
          confirmation_contract AS "confirmationContract",
          occurred_at AS "occurredAt"
        FROM job_acceptance_events WHERE job_id = ${created!.id}
      `;
      expect(acceptanceEvent?.actorUserId).toBe(source.acceptedByUserId);
      expect(acceptanceEvent?.commandId).toBe(commandId);
      expect(acceptanceEvent?.confirmationContract).toBe(
        "SERVER_ACCEPT_QUOTE_V1",
      );
      expect(acceptanceEvent?.occurredAt).toEqual(created?.acceptedAt);
      const [converted] = await transaction<
        Array<{ state: string }>
      >`SELECT state::text AS state FROM current_job_requests
        WHERE id = ${source.jobRequestId}`;
      expect(converted?.state).toBe("CONVERTED");
      await expect(
        transaction.savepoint(
          async (savepoint) => savepoint`
            INSERT INTO quote_revision_state_events (
              quote_id, quote_revision, state_revision, command_id,
              lifecycle_command_id, acceptance_job_id, state,
              changed_at, submitted_at
            ) VALUES (
              ${source.acceptedQuoteId}, ${source.acceptedQuoteRevision}, 1,
              NULL, NULL, ${created!.id}, 'NOT_SELECTED',
              clock_timestamp(), clock_timestamp()
            )
          `,
        ),
      ).rejects.toThrow("winning Quote cannot be not-selected");
      const [acceptedEvent] = await transaction<
        Array<{ state: string; stateRevision: number }>
      >`
        INSERT INTO quote_revision_state_events (
          quote_id, quote_revision, state_revision, command_id,
          lifecycle_command_id, acceptance_job_id, state,
          changed_at, submitted_at
        ) VALUES (
          ${source.acceptedQuoteId}, ${source.acceptedQuoteRevision}, 1,
          NULL, NULL, ${created!.id}, 'ACCEPTED',
          clock_timestamp(), clock_timestamp()
        ) RETURNING state::text AS state,
          state_revision AS "stateRevision"
      `;
      expect(acceptedEvent?.state).toBe("ACCEPTED");
      expect(acceptedEvent?.stateRevision).toBeGreaterThan(1);
      const [currentQuote] = await transaction<
        Array<{ state: string }>
      >`SELECT state::text AS state FROM current_quote_revision_states
        WHERE quote_id = ${source.acceptedQuoteId}
          AND revision = ${source.acceptedQuoteRevision}`;
      expect(currentQuote?.state).toBe("ACCEPTED");
      await expect(
        transaction.savepoint(
          async (savepoint) => savepoint`
            INSERT INTO jobs (
              job_request_id, customer_profile_id,
              primary_craftsman_profile_id, winning_invitation_id,
              winning_conversation_id, accepted_quote_id,
              accepted_quote_revision, accepted_request_content_revision,
              accepted_request_visible_version, acceptance_command_id,
              acceptance_payload_fingerprint, accepted_by_user_id
            ) VALUES (
              ${source.jobRequestId}, ${source.customerProfileId},
              ${source.primaryCraftsmanProfileId},
              ${source.winningInvitationId}, ${source.winningConversationId},
              ${source.acceptedQuoteId}, ${source.acceptedQuoteRevision},
              ${source.acceptedRequestContentRevision},
              ${source.acceptedRequestVisibleVersion}, ${randomUUID()},
              ${"b".repeat(64)}, ${source.acceptedByUserId}
            )
          `,
        ),
      ).rejects.toThrow();
      await expect(
        transaction.savepoint(
          async (savepoint) => savepoint`
            UPDATE jobs SET accepted_at = clock_timestamp()
            WHERE id = ${created!.id}
          `,
        ),
      ).rejects.toThrow("accepted Job identity is immutable");
      await expect(
        transaction.savepoint(
          async (savepoint) => savepoint`
            DELETE FROM jobs WHERE id = ${created!.id}
          `,
        ),
      ).rejects.toThrow("accepted Job identity is immutable");
      await expect(
        transaction.savepoint(
          async (savepoint) => savepoint`
            UPDATE job_agreement_snapshots
            SET request_snapshot = '{}'::jsonb
            WHERE job_id = ${created!.id}
          `,
        ),
      ).rejects.toThrow("accepted Job agreement snapshot is immutable");
      await expect(
        transaction.savepoint(
          async (savepoint) => savepoint`
            DELETE FROM job_agreement_snapshots WHERE job_id = ${created!.id}
          `,
        ),
      ).rejects.toThrow("accepted Job agreement snapshot is immutable");
      await expect(
        transaction.savepoint(
          async (savepoint) => savepoint`
            UPDATE job_qualification_snapshots
            SET requirements = '[]'::jsonb
            WHERE job_id = ${created!.id}
          `,
        ),
      ).rejects.toThrow("accepted Job qualification snapshot is immutable");
      await expect(
        transaction.savepoint(
          async (savepoint) => savepoint`
            UPDATE job_acceptance_events SET occurred_at = clock_timestamp()
            WHERE job_id = ${created!.id}
          `,
        ),
      ).rejects.toThrow("Job acceptance event is immutable");
      throw marker;
    }),
  ).rejects.toBe(marker);
  const [after] = await sql<Array<{ count: number }>>`
    SELECT count(*)::integer AS count FROM jobs
  `;
  expect(after?.count).toBe(before?.count);
}

async function createWinningConversationMediaFixture(
  transaction: TransactionSql,
  source: SourceIdentity,
): Promise<{
  capturedAt: Date;
  messageId: string;
  processingAssetId: string;
  readyAssetId: string;
}> {
  const messageCommandId = randomUUID();
  const [messageCommand] = await transaction<
    Array<{ resultingMessageId: string }>
  >`
    INSERT INTO conversation_message_commands (
      command_id, conversation_id, actor_user_id, body,
      resulting_message_id, payload_fingerprint, created_at
    ) VALUES (
      ${messageCommandId}, ${source.winningConversationId},
      ${source.acceptedByUserId}, 'Dokumentácia k dopytu', ${randomUUID()},
      ${"a".repeat(64)}, clock_timestamp()
    ) RETURNING resulting_message_id AS "resultingMessageId"
  `;
  if (messageCommand === undefined) throw new Error("Media message missing.");
  const [message] = await transaction<Array<{ sequence: number }>>`
    INSERT INTO conversation_timeline_entries (
      id, conversation_id, sequence, entry_kind, author_user_id, body,
      message_command_id, created_at
    ) VALUES (
      ${messageCommand.resultingMessageId}, ${source.winningConversationId},
      1, 'HUMAN_MESSAGE', ${source.acceptedByUserId},
      'Dokumentácia k dopytu', ${messageCommandId}, clock_timestamp()
    ) RETURNING sequence::integer AS sequence
  `;
  if (message === undefined) throw new Error("Media timeline missing.");
  const [readyAsset] = await transaction<Array<{ id: string }>>`
    INSERT INTO media_assets (
      owner_user_id, uploaded_by_user_id, kind, purpose,
      declared_content_type, byte_size, provenance_entity_type,
      provenance_entity_id, provenance_entity_revision
    ) VALUES (
      ${source.acceptedByUserId}, ${source.acceptedByUserId},
      'IMAGE', 'CHAT_IMAGE', 'image/jpeg', 3, 'CONVERSATION_MESSAGE',
      ${messageCommand.resultingMessageId}, ${message.sequence}
    ) RETURNING id
  `;
  const [processingAsset] = await transaction<Array<{ id: string }>>`
    INSERT INTO media_assets (
      owner_user_id, uploaded_by_user_id, kind, purpose,
      declared_content_type, byte_size, provenance_entity_type,
      provenance_entity_id, provenance_entity_revision
    ) VALUES (
      ${source.acceptedByUserId}, ${source.acceptedByUserId},
      'IMAGE', 'CHAT_IMAGE', 'image/jpeg', 3, 'CONVERSATION_MESSAGE',
      ${messageCommand.resultingMessageId}, ${message.sequence}
    ) RETURNING id
  `;
  if (readyAsset === undefined || processingAsset === undefined)
    throw new Error("Media assets missing.");
  await transaction`
    INSERT INTO media_asset_storage_objects (
      media_asset_id, role, storage_area, storage_key, content_type,
      byte_size, content_sha256
    ) VALUES (
      ${readyAsset.id}, 'CANONICAL', 'private',
      ${`private/2026/09/${randomUUID()}`}, 'image/webp', 3,
      ${"b".repeat(64)}
    )
  `;
  const capturedAt = new Date("2026-08-01T09:00:00.000Z");
  await transaction`
    UPDATE media_assets SET status = 'READY', ready_at = clock_timestamp(),
      status_changed_at = clock_timestamp(), updated_at = clock_timestamp(),
      canonical_width = 10, canonical_height = 10,
      captured_at = ${capturedAt}
    WHERE id = ${readyAsset.id}
  `;
  return {
    capturedAt,
    messageId: messageCommand.resultingMessageId,
    processingAssetId: processingAsset.id,
    readyAssetId: readyAsset.id,
  };
}
