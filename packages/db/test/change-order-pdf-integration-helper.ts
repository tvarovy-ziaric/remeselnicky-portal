import { randomUUID } from "node:crypto";

import type { Sql } from "postgres";
import { expect } from "vitest";

import { createChangeOrderPdfUploadRepository } from "../src/change-order-pdf-upload-repository.js";
import {
  createChangeOrderDocumentMediaAccessResolver,
  createChangeOrderRepository,
} from "../src/change-order-repository.js";
import { createPrivateMediaDeliveryRepository } from "../src/media-delivery-repository.js";

/** Run before the shared Job fixture leaves CONFIRMED. */
export async function runChangeOrderPdfIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const [job] = await sql<
    Array<{ jobId: string; customerUserId: string; providerUserId: string }>
  >`
    SELECT job.id AS "jobId", customer.owner_user_id AS "customerUserId",
      provider.owner_user_id AS "providerUserId"
    FROM jobs job JOIN customer_profiles customer ON customer.id = job.customer_profile_id
    JOIN craftsman_profiles provider ON provider.id = job.primary_craftsman_profile_id
    JOIN current_job_states state ON state.job_id = job.id
    WHERE state.state = 'CONFIRMED' ORDER BY job.accepted_at DESC, job.id DESC LIMIT 1`;
  if (!job) throw new Error("Confirmed Change-order PDF fixture missing.");
  const uploads = createChangeOrderPdfUploadRepository(sql);
  const orders = createChangeOrderRepository(sql);
  const changeOrderId = randomUUID();
  const revisionId = randomUUID();
  const reservation = {
    actorUserId: job.providerUserId,
    commandId: changeOrderId,
    jobId: job.jobId,
    changeOrderId,
    revisionId,
    expectedRevisionId: null,
  };
  expect(
    await uploads.reserve({ ...reservation, actorUserId: job.customerUserId }),
  ).toEqual({ status: "NOT_FOUND" });
  expect(
    await uploads.prepareUpload({
      actorUserId: job.providerUserId,
      jobId: job.jobId,
      revisionId,
    }),
  ).toEqual({ status: "UPLOAD_UNAVAILABLE" });
  expect(await uploads.reserve(reservation)).toMatchObject({
    status: "AUTHORIZED",
    reservationId: changeOrderId,
    revisionNumber: 1,
  });
  expect(await uploads.reserve(reservation)).toMatchObject({
    status: "DEDUPLICATED",
  });
  const prepared = await uploads.prepareUpload({
    actorUserId: job.providerUserId,
    jobId: job.jobId,
    revisionId,
  });
  expect(prepared).toMatchObject({
    status: "AUTHORIZED",
    purpose: "CHANGE_ORDER_DOCUMENT",
    provenance: {
      entityId: revisionId,
      entityRevision: 1,
      entityType: "CHANGE_ORDER_REVISION",
    },
  });
  expect(
    await uploads.prepareUpload({
      actorUserId: job.customerUserId,
      jobId: job.jobId,
      revisionId,
    }),
  ).toEqual({ status: "UPLOAD_UNAVAILABLE" });
  await expect(sql`INSERT INTO media_assets
    (owner_user_id, uploaded_by_user_id, kind, purpose, declared_content_type,
      byte_size, provenance_entity_type, provenance_entity_id, provenance_entity_revision)
    VALUES (${job.customerUserId}, ${job.customerUserId}, 'DOCUMENT',
      'CHANGE_ORDER_DOCUMENT', 'application/pdf', 100,
      'CHANGE_ORDER_REVISION', ${revisionId}, 1)`).rejects.toThrow();
  const [asset] = await sql<Array<{ id: string }>>`
    INSERT INTO media_assets
      (owner_user_id, uploaded_by_user_id, kind, purpose, declared_content_type,
        byte_size, provenance_entity_type, provenance_entity_id, provenance_entity_revision)
    VALUES (${job.providerUserId}, ${job.providerUserId}, 'DOCUMENT',
      'CHANGE_ORDER_DOCUMENT', 'application/pdf', 100,
      'CHANGE_ORDER_REVISION', ${revisionId}, 1)
    RETURNING id`;
  if (!asset) throw new Error("Reserved Change-order PDF asset missing.");
  await sql`INSERT INTO media_asset_storage_objects
    (media_asset_id, role, storage_area, storage_key, content_type, byte_size)
    VALUES (${asset.id}, 'ORIGINAL_UPLOAD', 'private',
      ${`private/2026/09/${randomUUID()}`}, 'application/pdf', 100)`;
  expect(
    await uploads.readStatus({
      actorUserId: job.providerUserId,
      jobId: job.jobId,
      revisionId,
      mediaAssetId: asset.id,
    }),
  ).toMatchObject({
    status: "PROCESSING",
    canCreateRevision: false,
  });
  expect(
    await uploads.readStatus({
      actorUserId: job.customerUserId,
      jobId: job.jobId,
      revisionId,
      mediaAssetId: asset.id,
    }),
  ).toBeNull();
  expect(
    await uploads.readStatus({
      actorUserId: job.providerUserId,
      jobId: randomUUID(),
      revisionId,
      mediaAssetId: asset.id,
    }),
  ).toBeNull();
  expect(
    await uploads.readStatus({
      actorUserId: job.providerUserId,
      jobId: job.jobId,
      revisionId: randomUUID(),
      mediaAssetId: asset.id,
    }),
  ).toBeNull();
  expect(
    await uploads.readStatus({
      actorUserId: job.providerUserId,
      jobId: job.jobId,
      revisionId,
      mediaAssetId: randomUUID(),
    }),
  ).toBeNull();
  expect(
    await uploads.prepareUpload({
      actorUserId: job.providerUserId,
      jobId: job.jobId,
      revisionId,
    }),
  ).toEqual({ status: "UPLOAD_UNAVAILABLE" });
  await expect(sql`INSERT INTO media_assets
    (owner_user_id, uploaded_by_user_id, kind, purpose, declared_content_type,
      byte_size, provenance_entity_type, provenance_entity_id, provenance_entity_revision)
    VALUES (${job.providerUserId}, ${job.providerUserId}, 'DOCUMENT',
      'CHANGE_ORDER_DOCUMENT', 'application/pdf', 100,
      'CHANGE_ORDER_REVISION', ${revisionId}, 1)`).rejects.toThrow(/one-use/);
  const hash = "d".repeat(64);
  await sql`INSERT INTO media_asset_storage_objects
    (media_asset_id, role, storage_area, storage_key, content_type, byte_size,
      content_sha256) VALUES (${asset.id}, 'CANONICAL', 'private',
      ${`private/2026/09/${randomUUID()}`}, 'application/pdf', 100, ${hash})`;
  await sql`UPDATE media_assets SET status = 'READY',
    ready_at = clock_timestamp(), status_changed_at = clock_timestamp(),
    updated_at = clock_timestamp(), document_page_count = 1,
    document_content_sha256 = ${hash}, malware_scan_verdict = 'CLEAN',
    malware_scanned_at = clock_timestamp(), malware_scanner_engine = 'test',
    malware_scanner_engine_version = '1', malware_signature_version = '1'
    WHERE id = ${asset.id}`;
  expect(
    await uploads.readStatus({
      actorUserId: job.providerUserId,
      jobId: job.jobId,
      revisionId,
      mediaAssetId: asset.id,
    }),
  ).toMatchObject({
    status: "READY",
    canCreateRevision: true,
  });
  await expect(sql`UPDATE media_assets SET provenance_entity_id = ${randomUUID()}
    WHERE id = ${asset.id}`).rejects.toThrow(/immutable/);
  const terms = {
    title: "PDF dodatok k rozsahu",
    reason: "Dodatočné práce",
    changeDescription: "Rozsah a cena sú v PDF dodatku.",
    scopeAdded: ["Oprava podkladu"],
    scopeRemoved: [],
    scopeChanged: [],
    priceImpact: {
      mode: "FIXED_DELTA" as const,
      amountCents: 12000,
      vatStatus: "VAT_INCLUDED" as const,
    },
    scheduleImpact: { mode: "NONE" as const },
    externalPdfMediaAssetId: asset.id,
  };
  expect(
    await orders.createDraft({
      actorUserId: job.providerUserId,
      commandId: changeOrderId,
      jobId: job.jobId,
      revisionId,
      terms,
    }),
  ).toMatchObject({
    status: "APPLIED",
    state: "DRAFT",
  });
  expect(
    await uploads.readStatus({
      actorUserId: job.providerUserId,
      jobId: job.jobId,
      revisionId,
      mediaAssetId: asset.id,
    }),
  ).toMatchObject({
    status: "READY",
    canCreateRevision: false,
  });
  const customerRead = await orders.getRevision({
    actorUserId: job.customerUserId,
    jobId: job.jobId,
    changeOrderId,
    revisionId,
  });
  expect(customerRead).toBeNull();
  const snapshot = await createPrivateMediaDeliveryRepository(
    sql,
  ).loadPrivateDeliverySnapshot({
    actorUserId: job.customerUserId,
    mediaAssetId: asset.id,
  });
  if (!snapshot) throw new Error("Change-order PDF media snapshot missing.");
  await expect(
    createChangeOrderDocumentMediaAccessResolver(sql).resolvePrivateMediaAccess(
      snapshot,
    ),
  ).rejects.toThrow(/Unbound/);
  expect(
    await orders.submitRevision({
      actorUserId: job.providerUserId,
      commandId: randomUUID(),
      jobId: job.jobId,
      changeOrderId,
      revisionId,
      revisionNumber: 1,
    }),
  ).toMatchObject({ status: "APPLIED" });
  const access =
    await createChangeOrderDocumentMediaAccessResolver(
      sql,
    ).resolvePrivateMediaAccess(snapshot);
  expect(access.grants).toContain("JOB_CUSTOMER");
  expect(
    (
      await orders.getRevision({
        actorUserId: job.customerUserId,
        jobId: job.jobId,
        changeOrderId,
        revisionId,
      })
    )?.terms.externalPdfMediaAssetId,
  ).toBe(asset.id);

  // A provider may still inspect their bound upload, but a changed head
  // must make the old reserved asset ineligible for a new revision command.
  const staleOrderId = randomUUID();
  const staleBaseId = randomUUID();
  const structuredTerms = { ...terms, externalPdfMediaAssetId: null };
  expect(
    await orders.createDraft({
      actorUserId: job.providerUserId,
      commandId: staleOrderId,
      jobId: job.jobId,
      revisionId: staleBaseId,
      terms: structuredTerms,
    }),
  ).toMatchObject({ status: "APPLIED" });
  const staleFutureId = randomUUID();
  expect(
    await uploads.reserve({
      actorUserId: job.providerUserId,
      commandId: staleFutureId,
      jobId: job.jobId,
      changeOrderId: staleOrderId,
      revisionId: staleFutureId,
      expectedRevisionId: staleBaseId,
    }),
  ).toMatchObject({
    status: "AUTHORIZED",
    revisionNumber: 2,
  });
  const [staleAsset] = await sql<Array<{ id: string }>>`
    INSERT INTO media_assets
      (owner_user_id, uploaded_by_user_id, kind, purpose, declared_content_type,
        byte_size, provenance_entity_type, provenance_entity_id, provenance_entity_revision)
    VALUES (${job.providerUserId}, ${job.providerUserId}, 'DOCUMENT',
      'CHANGE_ORDER_DOCUMENT', 'application/pdf', 100,
      'CHANGE_ORDER_REVISION', ${staleFutureId}, 2)
    RETURNING id`;
  if (!staleAsset) throw new Error("Stale PDF asset missing.");
  await sql`INSERT INTO media_asset_storage_objects
    (media_asset_id, role, storage_area, storage_key, content_type, byte_size)
    VALUES (${staleAsset.id}, 'ORIGINAL_UPLOAD', 'private',
      ${`private/2026/09/${randomUUID()}`}, 'application/pdf', 100)`;
  await sql`INSERT INTO media_asset_storage_objects
    (media_asset_id, role, storage_area, storage_key, content_type, byte_size,
      content_sha256) VALUES (${staleAsset.id}, 'CANONICAL', 'private',
      ${`private/2026/09/${randomUUID()}`}, 'application/pdf', 100, ${hash})`;
  await sql`UPDATE media_assets SET status = 'READY',
    ready_at = clock_timestamp(), status_changed_at = clock_timestamp(),
    updated_at = clock_timestamp(), document_page_count = 1,
    document_content_sha256 = ${hash}, malware_scan_verdict = 'CLEAN',
    malware_scanned_at = clock_timestamp(), malware_scanner_engine = 'test',
    malware_scanner_engine_version = '1', malware_signature_version = '1'
    WHERE id = ${staleAsset.id}`;
  const staleRead = {
    actorUserId: job.providerUserId,
    jobId: job.jobId,
    revisionId: staleFutureId,
    mediaAssetId: staleAsset.id,
  };
  expect(await uploads.readStatus(staleRead)).toMatchObject({
    status: "READY",
    canCreateRevision: true,
  });
  expect(
    await orders.replaceDraft({
      actorUserId: job.providerUserId,
      commandId: randomUUID(),
      jobId: job.jobId,
      changeOrderId: staleOrderId,
      expectedRevisionId: staleBaseId,
      terms: { ...structuredTerms, title: "Nový koncept bez PDF" },
    }),
  ).toMatchObject({
    status: "APPLIED",
    state: "DRAFT",
  });
  expect(await uploads.readStatus(staleRead)).toMatchObject({
    status: "READY",
    canCreateRevision: false,
  });
}
