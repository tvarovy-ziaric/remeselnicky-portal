import { randomUUID } from "node:crypto";

import { expect } from "vitest";
import type { Sql } from "postgres";
import type { CreateProcessingMediaAssetInput } from "@portal/media";

import {
  createMediaProcessingQueue,
  createMediaRepository,
} from "../src/index.js";

const maximumDrainCount = 1_000;

export async function runMediaProcessingQueueIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const queue = createMediaProcessingQueue(sql, { leaseDurationMs: 30_000 });
  await drainExistingJobs(queue);

  const [owner] = await sql<{ id: string }[]>`
    INSERT INTO users DEFAULT VALUES
    RETURNING id
  `;
  expect(owner).toBeDefined();

  const media = createMediaRepository(sql);
  const image = await media.createProcessingAsset({
    byteSize: 3,
    declaredContentType: "image/jpeg",
    displayFilename: null,
    kind: "IMAGE",
    ownerUserId: owner!.id,
    provenanceEntityId: null,
    provenanceEntityRevision: null,
    provenanceEntityType: null,
    purpose: "PROFILE_IMAGE",
    storageObject: {
      area: "private",
      key: privateMediaKey(randomUUID()),
    },
    uploaderUserId: owner!.id,
  });

  const [captured] = await sql<
    {
      assetId: string;
      attemptCount: number;
      kind: string;
      maxAttempts: number;
      state: string;
    }[]
  >`
    SELECT asset_id AS "assetId", kind, state,
      attempt_count AS "attemptCount", max_attempts AS "maxAttempts"
    FROM media_processing_jobs
    WHERE asset_id = ${image.id}
  `;
  expect(captured).toEqual({
    assetId: image.id,
    attemptCount: 0,
    kind: "IMAGE",
    maxAttempts: 10,
    state: "PENDING",
  });

  await expect(
    queue.enqueue({
      correlationId: image.id,
      eventId: image.id,
      jobId: image.id,
      maxAttempts: 10,
      name: "media.image.canonicalize",
      payload: { assetId: image.id, kind: "IMAGE" },
    }),
  ).resolves.toEqual({ jobId: image.id, status: "duplicate" });

  const claims = await Promise.all([
    queue.take(Date.now()),
    queue.take(Date.now()),
  ]);
  const imageDelivery = claims.find((claim) => claim !== undefined);
  expect(imageDelivery).toMatchObject({
    attempt: 1,
    jobId: image.id,
    payload: { assetId: image.id, kind: "IMAGE" },
  });
  expect(claims.filter((claim) => claim !== undefined)).toHaveLength(1);

  await queue.retry(imageDelivery!, {
    availableAt: 0,
    errorCode: "STORAGE_UNAVAILABLE",
  });
  const retryDelivery = await queue.take(Date.now());
  expect(retryDelivery).toMatchObject({ attempt: 2, jobId: image.id });
  await expect(queue.acknowledge(imageDelivery!)).rejects.toThrow(
    /lost its active lease/u,
  );
  await queue.acknowledge(retryDelivery!);

  const document = await media.createProcessingAsset({
    byteSize: 128,
    declaredContentType: "application/pdf",
    displayFilename: null,
    kind: "DOCUMENT",
    ownerUserId: owner!.id,
    provenanceEntityId: null,
    provenanceEntityRevision: null,
    provenanceEntityType: null,
    purpose: "JOB_DOCUMENT",
    storageObject: {
      area: "private",
      key: privateMediaKey(randomUUID()),
    },
    uploaderUserId: owner!.id,
  });
  const documentDelivery = await queue.take(Date.now());
  expect(documentDelivery).toMatchObject({
    attempt: 1,
    jobId: document.id,
    payload: { assetId: document.id, kind: "DOCUMENT" },
  });
  await queue.moveToTerminal(documentDelivery!, {
    errorCode: "MALWARE_DETECTED",
    failedAt: 0,
    reason: "non_retryable",
    runId: "integration-media-processing",
  });
  await expect(queue.terminalFailures()).resolves.toEqual([
    expect.objectContaining({
      attempts: 1,
      errorCode: "MALWARE_DETECTED",
      jobId: document.id,
      reason: "non_retryable",
      runId: "integration-media-processing",
    }),
  ]);

  const columns = await sql<{ columnName: string }[]>`
    SELECT column_name AS "columnName"
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'media_processing_jobs'
    ORDER BY ordinal_position
  `;
  expect(columns.map(({ columnName }) => columnName)).toEqual([
    "asset_id",
    "kind",
    "state",
    "attempt_count",
    "failed_attempt_count",
    "retry_count",
    "max_attempts",
    "available_at",
    "lease_token",
    "lease_expires_at",
    "last_error_code",
    "completed_at",
    "terminal_reason",
    "terminal_run_id",
    "terminal_at",
    "enqueued_at",
    "updated_at",
  ]);
  expect(columns.map(({ columnName }) => columnName).join(" ")).not.toMatch(
    /filename|storage|hash|owner|uploader|content/iu,
  );

  await expect(sql`
    UPDATE media_processing_jobs
    SET kind = 'DOCUMENT'
    WHERE asset_id = ${image.id}
  `).rejects.toThrow(/identity is immutable/u);
  await expect(sql`
    UPDATE media_processing_jobs
    SET state = 'TERMINAL', failed_attempt_count = failed_attempt_count + 1,
      last_error_code = 'FORGED', terminal_reason = 'NON_RETRYABLE',
      terminal_run_id = 'forged'
    WHERE asset_id = ${image.id}
  `).rejects.toThrow(/invalid media processing job transition/u);
  await expect(sql`
    DELETE FROM media_processing_jobs
    WHERE asset_id = ${image.id}
  `).rejects.toThrow(/cannot be deleted/u);
}

async function drainExistingJobs(
  queue: ReturnType<typeof createMediaProcessingQueue>,
): Promise<void> {
  for (let count = 0; count < maximumDrainCount; count += 1) {
    const delivery = await queue.take(Date.now());
    if (delivery === undefined) return;
    await queue.acknowledge(delivery);
  }
  throw new Error("Media processing integration drain exceeded its bound");
}

function privateMediaKey(
  uuid: string,
): CreateProcessingMediaAssetInput["storageObject"]["key"] {
  return `private/2026/09/${uuid}` as CreateProcessingMediaAssetInput["storageObject"]["key"];
}
