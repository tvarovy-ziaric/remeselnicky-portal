import { randomUUID } from "node:crypto";

import type { Sql } from "postgres";
import { expect } from "vitest";

import { createMediaRepository } from "../src/media-repository.js";
import {
  createDisputeEvidenceMediaAccessResolver,
  createJobDisputeRepository,
} from "../src/job-dispute-repository.js";
import { createPrivateMediaDeliveryRepository } from "../src/media-delivery-repository.js";

interface Fixture {
  readonly jobId: string;
  readonly customerUserId: string;
  readonly providerUserId: string;
  readonly mediaAssetId: string;
  readonly state: string;
}

export async function runJobDisputeIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const [fixture] = await sql<Fixture[]>`
    SELECT job.id AS "jobId",
      customer.owner_user_id AS "customerUserId",
      provider.owner_user_id AS "providerUserId",
      media.media_asset_id AS "mediaAssetId",
      state.state::text
    FROM jobs job
    JOIN customer_profiles customer ON customer.id = job.customer_profile_id
    JOIN craftsman_profiles provider
      ON provider.id = job.primary_craftsman_profile_id
    JOIN users customer_actor ON customer_actor.id = customer.owner_user_id
      AND customer_actor.account_state = 'ACTIVE'
    JOIN auth_credentials customer_credential
      ON customer_credential.user_id = customer_actor.id
      AND customer_credential.email_verified_at IS NOT NULL
      AND customer_credential.phone_verified_at IS NOT NULL
    JOIN users provider_actor ON provider_actor.id = provider.owner_user_id
      AND provider_actor.account_state = 'ACTIVE'
    JOIN auth_credentials provider_credential
      ON provider_credential.user_id = provider_actor.id
      AND provider_credential.email_verified_at IS NOT NULL
      AND provider_credential.phone_verified_at IS NOT NULL
    JOIN current_job_states state ON state.job_id = job.id
    JOIN job_conversation_media media ON media.job_id = job.id
    JOIN media_assets asset ON asset.id = media.media_asset_id
      AND asset.status = 'READY'
      AND (asset.kind = 'IMAGE' OR asset.malware_scan_verdict = 'CLEAN')
    JOIN media_asset_storage_objects canonical
      ON canonical.media_asset_id = asset.id
      AND canonical.role = 'CANONICAL'
      AND canonical.storage_area = 'private'
      AND canonical.revoked_at IS NULL
    WHERE NOT EXISTS (
      SELECT 1 FROM dispute_cases existing WHERE existing.job_id = job.id
    )
    ORDER BY job.accepted_at DESC, media.chronological_at DESC
    LIMIT 1`;
  if (!fixture) throw new Error("Committed dispute Job/media fixture missing.");

  const [foreign] = await sql<Array<{ userId: string }>>`
    SELECT actor.id AS "userId" FROM users actor
    JOIN auth_credentials credential ON credential.user_id = actor.id
      AND credential.email_verified_at IS NOT NULL
      AND credential.phone_verified_at IS NOT NULL
    WHERE actor.account_state = 'ACTIVE'
      AND actor.id NOT IN (${fixture.customerUserId}, ${fixture.providerUserId})
    ORDER BY actor.created_at
    LIMIT 1`;
  if (!foreign) throw new Error("Foreign verified dispute actor missing.");

  const repository = createJobDisputeRepository(sql);
  const disputeId = randomUUID();
  const openInput = {
    actorUserId: fixture.customerUserId,
    commandId: disputeId,
    jobId: fixture.jobId,
    category: "QUALITY_DEFECT" as const,
    description: "Výsledok má viditeľnú vadu, ktorú treba spoločne preveriť.",
    desiredResolution: "Oprava vady v dohodnutom termíne.",
  };
  await expect(repository.openCase(openInput)).resolves.toMatchObject({
    status: "APPLIED",
    id: disputeId,
    disputeId,
  });
  await expect(repository.openCase(openInput)).resolves.toMatchObject({
    status: "DEDUPLICATED",
    id: disputeId,
    disputeId,
  });
  await expect(
    repository.openCase({ ...openInput, desiredResolution: "Iná požiadavka." }),
  ).rejects.toThrow("different intent");
  await expect(
    repository.openCase({
      ...openInput,
      actorUserId: foreign.userId,
      commandId: randomUUID(),
    }),
  ).resolves.toEqual({ status: "NOT_FOUND" });

  await expect(
    repository.listCases({
      actorUserId: fixture.providerUserId,
      jobId: fixture.jobId,
    }),
  ).resolves.toContainEqual(
    expect.objectContaining({
      id: disputeId,
      category: "QUALITY_DEFECT",
      state: "OPEN",
      viewerRole: "PRIMARY_PROVIDER",
      canAddContent: true,
    }),
  );
  await expect(
    repository.listCases({
      actorUserId: foreign.userId,
      jobId: fixture.jobId,
    }),
  ).resolves.toBeNull();

  const statementId = randomUUID();
  await expect(
    repository.addStatement({
      actorUserId: fixture.providerUserId,
      commandId: statementId,
      jobId: fixture.jobId,
      disputeId,
      kind: "STATEMENT",
      body: "Vadu preveríme a navrhneme konkrétny termín opravy.",
    }),
  ).resolves.toMatchObject({ status: "APPLIED", id: statementId });

  const existingEvidenceId = randomUUID();
  await expect(
    repository.addEvidence({
      actorUserId: fixture.customerUserId,
      commandId: existingEvidenceId,
      jobId: fixture.jobId,
      disputeId,
      source: "EXISTING_JOB_EVIDENCE",
      mediaAssetId: fixture.mediaAssetId,
      description: "Pôvodná fotografia alebo dokumentácia z tejto zákazky.",
    }),
  ).resolves.toMatchObject({ status: "APPLIED", id: existingEvidenceId });
  await expect(
    repository.addEvidence({
      actorUserId: fixture.providerUserId,
      commandId: randomUUID(),
      jobId: fixture.jobId,
      disputeId,
      source: "EXISTING_JOB_EVIDENCE",
      mediaAssetId: fixture.mediaAssetId,
      description: "Duplicitný dôkaz.",
    }),
  ).resolves.toEqual({ status: "DUPLICATE_EVIDENCE" });

  await expect(
    repository.prepareEvidenceUpload({
      actorUserId: fixture.customerUserId,
      jobId: fixture.jobId,
      disputeId,
    }),
  ).resolves.toMatchObject({
    status: "AUTHORIZED",
    purpose: "DISPUTE_EVIDENCE",
  });
  await expect(
    repository.prepareEvidenceUpload({
      actorUserId: foreign.userId,
      jobId: fixture.jobId,
      disputeId,
    }),
  ).resolves.toEqual({ status: "UPLOAD_UNAVAILABLE" });

  const media = createMediaRepository(sql);
  const uploaded = await media.createProcessingAsset({
    ownerUserId: fixture.customerUserId,
    uploaderUserId: fixture.customerUserId,
    kind: "IMAGE",
    purpose: "DISPUTE_EVIDENCE",
    declaredContentType: "image/jpeg",
    displayFilename: "detail-vady.jpg",
    byteSize: 3,
    provenanceEntityType: "DISPUTE_CASE",
    provenanceEntityId: disputeId,
    provenanceEntityRevision: null,
    storageObject: { area: "private", key: privateKey(randomUUID()) },
  });
  await media.completeImageProcessing({
    assetId: uploaded.id,
    capturedAt: null,
    canonicalWidth: 20,
    canonicalHeight: 20,
    derivatives: [
      {
        role: "CANONICAL",
        contentType: "image/webp",
        byteSize: 2,
        contentSha256: "a".repeat(64),
        storageObject: { area: "private", key: privateKey(randomUUID()) },
      },
      {
        role: "THUMBNAIL",
        contentType: "image/webp",
        byteSize: 1,
        contentSha256: "b".repeat(64),
        storageObject: { area: "private", key: privateKey(randomUUID()) },
      },
    ],
  });
  await expect(
    repository.getEvidenceUploadStatus({
      actorUserId: fixture.customerUserId,
      jobId: fixture.jobId,
      disputeId,
      mediaAssetId: uploaded.id,
    }),
  ).resolves.toEqual({ status: "READY", canBind: true });
  const uploadedEvidenceId = randomUUID();
  await expect(
    repository.addEvidence({
      actorUserId: fixture.customerUserId,
      commandId: uploadedEvidenceId,
      jobId: fixture.jobId,
      disputeId,
      source: "NEW_UPLOAD",
      mediaAssetId: uploaded.id,
      description: "Nová detailná fotografia vady pre tento spor.",
    }),
  ).resolves.toMatchObject({ status: "APPLIED", id: uploadedEvidenceId });
  await expect(
    repository.getEvidenceUploadStatus({
      actorUserId: fixture.customerUserId,
      jobId: fixture.jobId,
      disputeId,
      mediaAssetId: uploaded.id,
    }),
  ).resolves.toEqual({ status: "READY", canBind: false });

  const detail = await repository.getCase({
    actorUserId: fixture.providerUserId,
    jobId: fixture.jobId,
    disputeId,
  });
  expect(detail).toMatchObject({
    id: disputeId,
    state: "OPEN",
    commercialBaseline: {
      jobDashboardPath: `/zakazky/${fixture.jobId}`,
    },
  });
  expect(detail?.statements).toContainEqual(
    expect.objectContaining({
      id: statementId,
      authorRole: "PRIMARY_PROVIDER",
    }),
  );
  expect(detail?.evidence).toHaveLength(2);
  expect(detail?.jobTimeline.length).toBeGreaterThanOrEqual(2);

  const delivery = createPrivateMediaDeliveryRepository(sql);
  const providerSnapshot = await delivery.loadPrivateDeliverySnapshot({
    actorUserId: fixture.providerUserId,
    mediaAssetId: uploaded.id,
  });
  const foreignSnapshot = await delivery.loadPrivateDeliverySnapshot({
    actorUserId: foreign.userId,
    mediaAssetId: uploaded.id,
  });
  if (!providerSnapshot || !foreignSnapshot)
    throw new Error("Dispute media delivery snapshots missing.");
  const resolver = createDisputeEvidenceMediaAccessResolver(sql);
  await expect(
    resolver.resolvePrivateMediaAccess(providerSnapshot),
  ).resolves.toMatchObject({
    grants: ["DISPUTE_CASE_MEMBER"],
  });
  await expect(
    resolver.resolvePrivateMediaAccess(foreignSnapshot),
  ).resolves.toMatchObject({
    grants: [],
  });

  const [notification] = await sql<
    Array<{ payload: Record<string, unknown>; eventName: string }>
  >`
    SELECT event_name AS "eventName", payload
    FROM domain_outbox_events
    WHERE idempotency_key = ${`dispute:${disputeId}:opened:${fixture.providerUserId}`}`;
  expect(notification?.eventName).toBe("job.dispute.opened");
  expect(notification?.payload).toEqual({
    recipient_user_id: fixture.providerUserId,
    job_id: fixture.jobId,
    dispute_id: disputeId,
  });
  expect(JSON.stringify(notification?.payload)).not.toMatch(
    /vadu|oprava|description|resolution/iu,
  );

  const [unchanged] = await sql<
    Array<{ state: string; snapshotCount: number }>
  >`
    SELECT state.state::text,
      (SELECT count(*)::integer FROM job_agreement_snapshots snapshot
        WHERE snapshot.job_id = job.id) AS "snapshotCount"
    FROM jobs job
    JOIN current_job_states state ON state.job_id = job.id
    WHERE job.id = ${fixture.jobId}`;
  expect(unchanged).toEqual({ state: fixture.state, snapshotCount: 1 });

  await expect(
    sql`UPDATE dispute_cases SET description = 'Prepísaný spor'
      WHERE id = ${disputeId}`,
  ).rejects.toThrow("Dispute case history is immutable");
  await expect(
    sql`UPDATE dispute_case_statements SET body = 'Prepísané vyjadrenie'
      WHERE id = ${statementId}`,
  ).rejects.toThrow("Dispute case history is immutable");
  await expect(
    sql`INSERT INTO dispute_case_state_events
      (event_id, dispute_id, event_sequence, action, from_state, to_state,
        actor_user_id, actor_role, occurred_at)
      VALUES (${randomUUID()}, ${disputeId}, 2, 'OPEN', 'OPEN', 'OPEN',
        ${fixture.customerUserId}, 'CUSTOMER', clock_timestamp())`,
  ).rejects.toThrow("initial dispute state must derive from case creation");
}

function privateKey(id: string) {
  return `private/2026/09/${id}` as never;
}
