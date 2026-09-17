import { randomUUID } from "node:crypto";

import type { Sql, TransactionSql } from "postgres";
import { expect } from "vitest";

import {
  createJobOperationalRepository,
  JobOperationalIdempotencyError,
} from "../src/job-operational-repository.js";

interface Fixture {
  readonly jobId: string;
  readonly conversationId: string;
  readonly providerUserId: string;
  readonly customerUserId: string;
}

export async function runJobOperationalMediaIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const [fixture] = await sql<Fixture[]>`
    SELECT job.id AS "jobId", job.winning_conversation_id AS "conversationId",
      provider.owner_user_id AS "providerUserId",
      customer.owner_user_id AS "customerUserId"
    FROM jobs job
    JOIN craftsman_profiles provider ON provider.id = job.primary_craftsman_profile_id
    JOIN customer_profiles customer ON customer.id = job.customer_profile_id
    JOIN current_job_states state ON state.job_id = job.id
    WHERE state.state = 'CONFIRMED'
    ORDER BY job.accepted_at DESC, job.id DESC LIMIT 1
  `;
  if (fixture === undefined)
    throw new Error("Confirmed Job media fixture missing.");
  const rollback = new Error("rollback operational media fixtures");
  await expect(
    sql.begin(async (tx: TransactionSql) => {
      const message = await makeMessage(tx, fixture);
      const imageId = await makeReadyMedia(
        tx,
        fixture.providerUserId,
        message.id,
        message.sequence,
        "IMAGE",
      );
      const pdfId = await makeReadyMedia(
        tx,
        fixture.providerUserId,
        message.id,
        message.sequence,
        "DOCUMENT",
      );
      const [processing] = await tx<Array<{ id: string }>>`
      INSERT INTO media_assets (owner_user_id, uploaded_by_user_id,
        kind, purpose, declared_content_type, byte_size,
        provenance_entity_type, provenance_entity_id, provenance_entity_revision)
      VALUES (${fixture.providerUserId}, ${fixture.providerUserId},
        'DOCUMENT', 'CHAT_DOCUMENT', 'application/pdf', 100,
        'CONVERSATION_MESSAGE', ${message.id}, ${message.sequence})
      RETURNING id
    `;
      if (processing === undefined)
        throw new Error("Processing media missing.");
      const repository = createJobOperationalRepository(tx);
      const progressId = randomUUID();
      const progress = {
        actorUserId: fixture.providerUserId,
        commandId: progressId,
        jobId: fixture.jobId,
        body: "Príprava podkladu je zdokumentovaná fotografiou.",
        mediaAssetIds: [imageId],
      };
      expect(await repository.createProgress(progress)).toMatchObject({
        status: "APPLIED",
        id: progressId,
      });
      expect(await repository.createProgress(progress)).toMatchObject({
        status: "DEDUPLICATED",
        id: progressId,
      });
      await expect(
        repository.createProgress({ ...progress, mediaAssetIds: [] }),
      ).rejects.toBeInstanceOf(JobOperationalIdempotencyError);
      expect(
        await repository.createProgress({
          ...progress,
          commandId: randomUUID(),
          mediaAssetIds: [pdfId],
        }),
      ).toEqual({ status: "NOT_FOUND" });
      expect(
        await repository.createProgress({
          ...progress,
          commandId: randomUUID(),
          mediaAssetIds: [processing.id],
        }),
      ).toEqual({ status: "NOT_FOUND" });
      expect(
        await repository.createProgress({
          ...progress,
          commandId: randomUUID(),
          mediaAssetIds: [randomUUID()],
        }),
      ).toEqual({ status: "NOT_FOUND" });
      const progressRead = await repository.getProgress({
        actorUserId: fixture.customerUserId,
        jobId: fixture.jobId,
        updateId: progressId,
      });
      expect(progressRead?.media).toHaveLength(1);
      expect(progressRead?.media[0]).toMatchObject({
        mediaAssetId: imageId,
        kind: "PHOTO",
        source: "WINNING_CONVERSATION",
        sourceMessageId: message.id,
        uploadedByUserId: fixture.providerUserId,
        authorRole: "PRIMARY_PROVIDER",
        downloadPath: `/v1/media/${imageId}/download`,
      });
      expect(progressRead?.media[0]?.uploadedAt).toBeInstanceOf(Date);
      const progressList = await repository.listProgress({
        actorUserId: fixture.providerUserId,
        jobId: fixture.jobId,
        limit: 50,
      });
      expect(
        progressList?.items.find((item) => item.id === progressId)?.media[0]
          ?.mediaAssetId,
      ).toBe(imageId);

      const issueId = randomUUID();
      const issue = {
        actorUserId: fixture.providerUserId,
        commandId: issueId,
        jobId: fixture.jobId,
        kind: "PROBLEM" as const,
        body: "Na pracovisku vznikol problém, dôkazy sú priložené.",
        mediaAssetIds: [imageId, pdfId],
      };
      expect(await repository.createIssue(issue)).toMatchObject({
        status: "APPLIED",
        id: issueId,
      });
      expect(
        await repository.createIssue({
          ...issue,
          mediaAssetIds: [pdfId, imageId],
        }),
      ).toMatchObject({ status: "DEDUPLICATED", id: issueId });
      await expect(
        repository.createIssue({ ...issue, mediaAssetIds: [imageId] }),
      ).rejects.toBeInstanceOf(JobOperationalIdempotencyError);
      const issueRead = await repository.getIssue({
        actorUserId: fixture.customerUserId,
        jobId: fixture.jobId,
        issueId,
      });
      expect(issueRead?.media.map((item) => item.kind)).toEqual([
        "PHOTO",
        "DOCUMENT",
      ]);
      expect(issueRead?.media[1]?.contentType).toBe("application/pdf");
      expect(
        (
          await repository.listIssues({
            actorUserId: fixture.customerUserId,
            jobId: fixture.jobId,
            limit: 50,
          })
        )?.items.find((item) => item.id === issueId)?.media,
      ).toHaveLength(2);
      expect(
        await repository.getIssue({
          actorUserId: randomUUID(),
          jobId: fixture.jobId,
          issueId,
        }),
      ).toBeNull();

      await expect(
        tx.savepoint(
          async (sp) => sp`
      INSERT INTO job_progress_media (progress_update_id, media_asset_id, position)
      VALUES (${progressId}, ${pdfId}, 2)
    `,
        ),
      ).rejects.toThrow(/photos only/);
      await expect(
        tx.savepoint(
          async (sp) => sp`
      INSERT INTO job_issue_media (issue_id, media_asset_id, position)
      VALUES (${issueId}, ${processing.id}, 3)
    `,
        ),
      ).rejects.toThrow(/same-Job READY private clean media required/);
      await expect(
        tx.savepoint(
          async (sp) => sp`
      INSERT INTO job_issue_media (issue_id, media_asset_id, position)
      VALUES (${issueId}, ${randomUUID()}, 3)
    `,
        ),
      ).rejects.toThrow();
      await expect(
        tx.savepoint(
          async (sp) => sp`
      INSERT INTO job_issue_media (issue_id, media_asset_id, position)
      VALUES (${issueId}, ${imageId}, 3)
    `,
        ),
      ).rejects.toThrow();
      await expect(
        tx.savepoint(
          async (sp) => sp`
      INSERT INTO job_progress_media (progress_update_id, media_asset_id, position)
      VALUES (${progressId}, ${imageId}, 6)
    `,
        ),
      ).rejects.toThrow();
      await expect(
        tx.savepoint(
          async (sp) => sp`
      UPDATE job_progress_media SET position = 2
      WHERE progress_update_id = ${progressId} AND media_asset_id = ${imageId}
    `,
        ),
      ).rejects.toThrow(/immutable/);
      await expect(
        tx.savepoint(
          async (sp) => sp`
      DELETE FROM job_issue_media WHERE issue_id = ${issueId}
    `,
        ),
      ).rejects.toThrow(/immutable/);

      const delayedParentId = randomUUID();
      expect(
        await repository.createProgress({
          ...progress,
          commandId: delayedParentId,
          mediaAssetIds: [],
        }),
      ).toMatchObject({ status: "APPLIED" });
      await tx`UPDATE users SET account_state = 'SUSPENDED',
      account_state_changed_at = clock_timestamp(),
      updated_at = clock_timestamp() WHERE id = ${fixture.providerUserId}`;
      await expect(
        tx.savepoint(
          async (sp) => sp`
      INSERT INTO job_progress_media (progress_update_id, media_asset_id, position)
      VALUES (${delayedParentId}, ${imageId}, 1)
    `,
        ),
      ).rejects.toThrow(/active open Job author required/);
      throw rollback;
    }),
  ).rejects.toThrow(rollback.message);

  // A committed text record cannot acquire a media link in a later transaction.
  const repository = createJobOperationalRepository(sql);
  const lateId = randomUUID();
  expect(
    await repository.createProgress({
      actorUserId: fixture.providerUserId,
      commandId: lateId,
      jobId: fixture.jobId,
      body: "Samostatný textový záznam.",
    }),
  ).toMatchObject({ status: "APPLIED" });
  await expect(sql`INSERT INTO job_progress_media
    (progress_update_id, media_asset_id, position)
    VALUES (${lateId}, ${randomUUID()}, 1)`).rejects.toThrow(
    /creation transaction/,
  );
}

export async function makeMessage(
  tx: TransactionSql,
  fixture: Fixture,
): Promise<{ id: string; sequence: number }> {
  const commandId = randomUUID();
  const body = "Syntetická dokumentácia priebehu zákazky";
  const [command] = await tx<Array<{ resultingMessageId: string }>>`
    INSERT INTO conversation_message_commands
      (command_id, conversation_id, actor_user_id, body,
        resulting_message_id, payload_fingerprint, created_at)
    VALUES (${commandId}, ${fixture.conversationId}, ${fixture.providerUserId},
      ${body}, ${randomUUID()}, ${"a".repeat(64)}, clock_timestamp())
    RETURNING resulting_message_id AS "resultingMessageId"
  `;
  if (command === undefined)
    throw new Error("Operational media message command missing.");
  const [entry] = await tx<Array<{ id: string; sequence: number }>>`
    INSERT INTO conversation_timeline_entries
      (id, conversation_id, sequence, entry_kind, author_user_id, body,
        message_command_id, created_at)
    VALUES (${command.resultingMessageId}, ${fixture.conversationId},
      (SELECT coalesce(max(sequence), 0) + 1 FROM conversation_timeline_entries
       WHERE conversation_id = ${fixture.conversationId}),
      'HUMAN_MESSAGE', ${fixture.providerUserId}, ${body}, ${commandId}, clock_timestamp())
    RETURNING id, sequence::integer AS sequence
  `;
  if (entry === undefined)
    throw new Error("Operational media message missing.");
  return entry;
}

export async function makeReadyMedia(
  tx: TransactionSql,
  userId: string,
  messageId: string,
  sequence: number,
  kind: "IMAGE" | "DOCUMENT",
): Promise<string> {
  const isImage = kind === "IMAGE";
  const [asset] = await tx<Array<{ id: string }>>`
    INSERT INTO media_assets
      (owner_user_id, uploaded_by_user_id, kind, purpose,
        declared_content_type, display_filename, byte_size,
        provenance_entity_type, provenance_entity_id, provenance_entity_revision)
    VALUES (${userId}, ${userId}, ${kind},
      ${isImage ? "CHAT_IMAGE" : "CHAT_DOCUMENT"},
      ${isImage ? "image/jpeg" : "application/pdf"},
      ${isImage ? "priebeh.jpg" : "problem.pdf"}, 100,
      'CONVERSATION_MESSAGE', ${messageId}, ${sequence})
    RETURNING id
  `;
  if (asset === undefined) throw new Error("Operational media asset missing.");
  const hash = isImage ? "b".repeat(64) : "c".repeat(64);
  await tx`INSERT INTO media_asset_storage_objects
    (media_asset_id, role, storage_area, storage_key, content_type,
      byte_size, content_sha256)
    VALUES (${asset.id}, 'CANONICAL', 'private',
      ${`private/2026/09/${randomUUID()}`},
      ${isImage ? "image/webp" : "application/pdf"}, 100, ${hash})`;
  if (isImage) {
    await tx`UPDATE media_assets SET status = 'READY',
      ready_at = clock_timestamp(), status_changed_at = clock_timestamp(),
      updated_at = clock_timestamp(), canonical_width = 10,
      canonical_height = 10 WHERE id = ${asset.id}`;
  } else {
    await tx`UPDATE media_assets SET status = 'READY',
      ready_at = clock_timestamp(), status_changed_at = clock_timestamp(),
      updated_at = clock_timestamp(), document_page_count = 1,
      document_content_sha256 = ${hash}, malware_scan_verdict = 'CLEAN',
      malware_scanned_at = clock_timestamp(), malware_scanner_engine = 'test',
      malware_scanner_engine_version = '1', malware_signature_version = '1'
      WHERE id = ${asset.id}`;
  }
  return asset.id;
}
