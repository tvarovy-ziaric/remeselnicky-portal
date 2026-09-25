import { randomUUID } from "node:crypto";

import type { UserId } from "@portal/domain";
import type { Sql } from "postgres";
import { expect } from "vitest";

import { createJobDocumentationRepository } from "../src/job-documentation-repository.js";
import { createJobPropertyPhotoConsentRepository } from "../src/job-property-photo-consent-repository.js";

export async function runJobDocumentationIntegrationAssertions(sql: Sql) {
  const [job] = await sql<
    Array<{ id: string; customerUserId: string; providerUserId: string }>
  >`
    SELECT job.id, customer.owner_user_id AS "customerUserId",
      provider.owner_user_id AS "providerUserId"
    FROM jobs job
    JOIN customer_profiles customer ON customer.id = job.customer_profile_id
    JOIN craftsman_profiles provider
      ON provider.id = job.primary_craftsman_profile_id
    JOIN job_conversation_media image
      ON image.job_id = job.id AND image.media_kind = 'IMAGE'
    ORDER BY job.accepted_at DESC, job.id DESC LIMIT 1
  `;
  if (!job) throw new Error("Confirmed Job fixture missing.");
  const repository = createJobDocumentationRepository(sql);
  const customer = await repository.listForPrimaryParty({
    actorUserId: job.customerUserId,
    category: "ALL",
    jobId: job.id,
    limit: 20,
  });
  const provider = await repository.listForPrimaryParty({
    actorUserId: job.providerUserId,
    category: "DOCUMENT",
    jobId: job.id,
    limit: 20,
  });
  expect(customer).not.toBeNull();
  expect(provider).not.toBeNull();
  expect(Array.isArray(customer?.items)).toBe(true);
  expect(Array.isArray(provider?.items)).toBe(true);
  expect(
    customer?.items.every((item) => item.downloadPath.startsWith("/v1/media/")),
  ).toBe(true);

  const photo = customer?.items.find((item) => item.kind === "PHOTO");
  if (photo === undefined)
    throw new Error("Exact-Job photo consent fixture missing.");
  const [policy] = await sql<Array<{ readonly policyVersionId: string }>>`
    SELECT policy_version_id AS "policyVersionId"
    FROM privacy_policy_versions
    WHERE policy_kind = 'OPTIONAL_CONSENT_TEXT'
      AND optional_consent_purpose =
        'PORTFOLIO_PROPERTY_PHOTO_PUBLICATION'
      AND review_state = 'APPROVED'
      AND effective_at <= CURRENT_TIMESTAMP
    ORDER BY effective_at DESC, created_at DESC LIMIT 1
  `;
  if (policy === undefined)
    throw new Error("Approved property-photo policy fixture missing.");
  const consent = createJobPropertyPhotoConsentRepository(sql);
  const grant = {
    action: "GRANTED" as const,
    correlationId: randomUUID(),
    customerUserId: job.customerUserId as UserId,
    eventId: randomUUID(),
    expectedRevision: 0,
    jobId: job.id,
    mediaAssetId: photo.mediaAssetId,
    policyVersionId: policy.policyVersionId,
  };
  await expect(consent.appendDecision(grant)).resolves.toMatchObject({
    event: { action: "GRANTED", revision: 1 },
    status: "APPENDED",
  });
  await expect(consent.appendDecision(grant)).resolves.toMatchObject({
    event: { action: "GRANTED", revision: 1 },
    status: "DEDUPLICATED",
  });
  const [currentGrant] = await sql<Array<{ readonly granted: boolean }>>`
    SELECT job_property_photo_consent_is_current(
      ${job.id}::uuid, ${photo.mediaAssetId}::uuid,
      ${job.customerUserId}::uuid
    ) AS granted
  `;
  expect(currentGrant?.granted).toBe(true);

  const withdrawalEventId = randomUUID();
  await expect(
    consent.appendDecision({
      action: "WITHDRAWN",
      correlationId: randomUUID(),
      customerUserId: job.customerUserId as UserId,
      eventId: withdrawalEventId,
      expectedRevision: 1,
      jobId: job.id,
      mediaAssetId: photo.mediaAssetId,
      policyVersionId: policy.policyVersionId,
    }),
  ).resolves.toMatchObject({
    event: { action: "WITHDRAWN", revision: 2 },
    status: "APPENDED",
  });
  const [withdrawn] = await sql<
    Array<{ readonly granted: boolean; readonly privateObjectPresent: boolean }>
  >`
    SELECT job_property_photo_consent_is_current(
      ${job.id}::uuid, ${photo.mediaAssetId}::uuid,
      ${job.customerUserId}::uuid
    ) AS granted,
    EXISTS (
      SELECT 1 FROM media_asset_storage_objects object
      WHERE object.media_asset_id = ${photo.mediaAssetId}
        AND object.storage_area = 'private' AND object.revoked_at IS NULL
    ) AS "privateObjectPresent"
  `;
  expect(withdrawn).toEqual({ granted: false, privateObjectPresent: true });
  await expect(sql`
    UPDATE job_property_photo_consent_events
    SET action = 'GRANTED'
    WHERE event_id = ${withdrawalEventId}
  `).rejects.toThrow(/property-photo consent history is append-only/u);

  const [unrelated] = await sql<Array<{ id: string }>>`
    SELECT id FROM users
    WHERE id <> ${job.customerUserId} AND id <> ${job.providerUserId}
    ORDER BY id LIMIT 1
  `;
  if (!unrelated) throw new Error("Unrelated User fixture missing.");
  expect(
    await repository.listForPrimaryParty({
      actorUserId: unrelated.id,
      category: "ALL",
      jobId: job.id,
      limit: 20,
    }),
  ).toBeNull();
  expect(
    await consent.listForCustomerJob({
      customerUserId: unrelated.id as UserId,
      jobId: job.id,
    }),
  ).toBeNull();
}
