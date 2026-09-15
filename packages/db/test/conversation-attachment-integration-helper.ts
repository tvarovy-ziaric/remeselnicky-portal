import { randomUUID } from "node:crypto";

import type {
  ConversationId,
  ConversationMessageId,
  CraftsmanProfileId,
  JobInvitationId,
  JobRequestId,
  UserId,
} from "@portal/domain";
import {
  createServerMediaProvenance,
  createPrivateMediaDeliveryService,
  type ServerMediaProvenance,
} from "@portal/media";
import type { Sql } from "postgres";
import { expect } from "vitest";

import {
  createConversationAttachmentMediaAccessResolver,
  createConversationAttachmentUploadAuthorization,
} from "../src/conversation-attachment-repository.js";
import { createConversationChatRepository } from "../src/conversation-chat-repository.js";
import { createJobInvitationRepository } from "../src/job-invitation-repository.js";
import { createMediaRepository } from "../src/media-repository.js";
import { createPrivateMediaDeliveryRepository } from "../src/media-delivery-repository.js";

interface Fixture {
  readonly conversationId: ConversationId;
  readonly customerOwnerId: UserId;
  readonly craftsmanOwnerId: UserId;
  readonly invitationId: JobInvitationId;
  readonly messageId: ConversationMessageId;
  readonly messageSequence: number;
}

export async function runConversationAttachmentIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const fixture = await createWritableFixture(sql);
  const authorization = createConversationAttachmentUploadAuthorization(sql);
  const prepared = await authorization.prepareUpload({
    actorUserId: fixture.customerOwnerId,
    conversationId: fixture.conversationId,
    mediaKind: "PDF",
    messageId: fixture.messageId,
  });
  if (prepared.status !== "AUTHORIZED") {
    throw new Error("Expected exact conversation attachment authorization.");
  }
  expect(prepared.provenance).toMatchObject({
    entityId: fixture.messageId,
    entityRevision: fixture.messageSequence,
    entityType: "CONVERSATION_MESSAGE",
  });

  const processingDocument = await createProcessing(sql, prepared.provenance, {
    kind: "DOCUMENT",
    ownerId: fixture.customerOwnerId,
    purpose: "CHAT_DOCUMENT",
  });
  const timeline = await createConversationChatRepository(sql).readTimeline({
    actorUserId: fixture.craftsmanOwnerId,
    conversationId: fixture.conversationId,
  });
  expect(timeline?.entries.at(-1)?.attachments).toContainEqual(
    expect.objectContaining({
      assetId: processingDocument.id,
      kind: "PDF",
      status: "PROCESSING",
    }),
  );

  await rawProvenanceNegatives(sql, fixture);
  const readyWithCapture = await assertBoundsAndReadyChronology(sql, fixture);
  const suspensionFixture = await assertSuspensionRace(sql);
  await assertCloseRaces(sql, suspensionFixture);

  const invitations = createJobInvitationRepository(sql);
  const [current] = await sql<{ readonly revision: number }[]>`
    SELECT revision FROM current_job_invitations
    WHERE id = ${fixture.invitationId}
  `;
  if (current === undefined) throw new Error("Missing invitation revision.");
  const closed = await invitations.closeOwned({
    action: "STOP_CONSIDERING",
    actorUserId: fixture.customerOwnerId,
    commandId: randomUUID(),
    expectedRevision: current.revision,
    invitationId: fixture.invitationId,
  });
  expect(closed).toMatchObject({ status: "APPLIED" });

  const privateDelivery = createPrivateMediaDeliveryService({
    applicationOrigin: "https://portal.example.test",
    clock: () => new Date("2026-09-15T12:00:00Z"),
    entityAccess: createConversationAttachmentMediaAccessResolver(sql),
    repository: createPrivateMediaDeliveryRepository(sql),
    storage: {
      createPrivateDownload: () =>
        Promise.resolve({
          expiresAt: new Date("2026-09-15T12:00:45Z"),
          url: new URL("https://objects.example.test/private-grant"),
        }),
      readPrivateForProcessing: () => Promise.reject(new Error("unused")),
      revokePublicDerivative: () => Promise.reject(new Error("unused")),
      storePrivate: () => Promise.reject(new Error("unused")),
      storePublicDerivative: () => Promise.reject(new Error("unused")),
    },
  });
  await expect(
    privateDelivery.handleDownload({
      actorUserId: fixture.craftsmanOwnerId,
      mediaAssetId: readyWithCapture,
    }),
  ).resolves.toMatchObject({ statusCode: 303 });
  await expect(
    privateDelivery.handleDownload({
      actorUserId: fixture.craftsmanOwnerId,
      mediaAssetId: processingDocument.id,
    }),
  ).resolves.toMatchObject({ statusCode: 404 });
  const outsiderId = randomUUID() as UserId;
  await sql`INSERT INTO users (id) VALUES (${outsiderId})`;
  await expect(
    privateDelivery.handleDownload({
      actorUserId: outsiderId,
      mediaAssetId: readyWithCapture,
    }),
  ).resolves.toMatchObject({ statusCode: 404 });
  await sql`
    UPDATE media_asset_storage_objects SET revoked_at = clock_timestamp()
    WHERE media_asset_id = ${readyWithCapture} AND role = 'CANONICAL'
  `;
  const revokedCandidates = await sql`
    SELECT media_asset_id FROM conversation_job_media_candidates
    WHERE media_asset_id = ${readyWithCapture}
  `;
  expect(revokedCandidates).toEqual([]);
  await expect(
    privateDelivery.handleDownload({
      actorUserId: fixture.craftsmanOwnerId,
      mediaAssetId: readyWithCapture,
    }),
  ).resolves.toMatchObject({ statusCode: 404 });
}

async function rawProvenanceNegatives(sql: Sql, fixture: Fixture) {
  for (const entityType of [null, "JOB"] as const) {
    await expect(sql`
      INSERT INTO media_assets (
        owner_user_id, uploaded_by_user_id, kind, purpose,
        declared_content_type, byte_size, provenance_entity_type,
        provenance_entity_id, provenance_entity_revision
      ) VALUES (
        ${fixture.customerOwnerId}, ${fixture.customerOwnerId}, 'IMAGE',
        'CHAT_IMAGE', 'image/jpeg', 3, ${entityType}, ${fixture.messageId},
        ${fixture.messageSequence}
      )
    `).rejects.toThrow(/exact purpose and message provenance/u);
  }
  await expect(sql`
    INSERT INTO media_assets (
      owner_user_id, uploaded_by_user_id, kind, purpose,
      declared_content_type, byte_size, provenance_entity_type,
      provenance_entity_id, provenance_entity_revision
    ) VALUES (
      ${fixture.craftsmanOwnerId}, ${fixture.customerOwnerId}, 'IMAGE',
      'CHAT_IMAGE', 'image/jpeg', 3, 'CONVERSATION_MESSAGE',
      ${fixture.messageId}, ${fixture.messageSequence}
    )
  `).rejects.toThrow(/active writable message author/u);
}

async function assertBoundsAndReadyChronology(sql: Sql, fixture: Fixture) {
  const provenance = messageProvenance(fixture);
  const images: Array<Awaited<ReturnType<typeof createProcessing>>> = [];
  for (let index = 0; index < 5; index += 1) {
    images.push(
      await createProcessing(sql, provenance, {
        kind: "IMAGE",
        ownerId: fixture.customerOwnerId,
        purpose: "CHAT_IMAGE",
      }),
    );
  }
  await expect(
    createProcessing(sql, provenance, {
      kind: "IMAGE",
      ownerId: fixture.customerOwnerId,
      purpose: "CHAT_IMAGE",
    }),
  ).rejects.toThrow(/technical limit/u);
  for (let index = 0; index < 4; index += 1) {
    await createProcessing(sql, provenance, {
      kind: "DOCUMENT",
      ownerId: fixture.customerOwnerId,
      purpose: "CHAT_DOCUMENT",
    });
  }
  await expect(
    createProcessing(sql, provenance, {
      kind: "DOCUMENT",
      ownerId: fixture.customerOwnerId,
      purpose: "CHAT_DOCUMENT",
    }),
  ).rejects.toThrow(/technical limit/u);

  const capturedAt = new Date("2026-08-01T09:00:00Z");
  await makeReadyImage(sql, images[0]!.id, capturedAt);
  await makeReadyImage(sql, images[1]!.id, null);
  const candidates = await sql<
    Array<{
      readonly chronologicalAt: Date;
      readonly mediaAssetId: string;
    }>
  >`
    SELECT media_asset_id AS "mediaAssetId",
      chronological_at AS "chronologicalAt"
    FROM conversation_job_media_candidates
    WHERE media_asset_id = ANY(${[images[0]!.id, images[1]!.id]}::uuid[])
    ORDER BY media_asset_id
  `;
  expect(candidates).toHaveLength(2);
  expect(
    candidates.find((row) => row.mediaAssetId === images[0]!.id)
      ?.chronologicalAt,
  ).toEqual(capturedAt);
  expect(
    candidates.find((row) => row.mediaAssetId === images[1]!.id)
      ?.chronologicalAt,
  ).toEqual(images[1]!.createdAt);
  await expect(sql`
    UPDATE media_assets SET provenance_entity_id = ${randomUUID()}
    WHERE id = ${images[0]!.id}
  `).rejects.toThrow(/immutable/u);
  await expect(
    sql`DELETE FROM media_assets WHERE id = ${images[0]!.id}`,
  ).rejects.toThrow(/append-only/u);
  return images[0]!.id;
}

async function assertSuspensionRace(sql: Sql) {
  const fixture = await createWritableFixture(sql);
  const provenance = messageProvenance(fixture);
  const [created, suspension] = await Promise.allSettled([
    createProcessing(sql, provenance, {
      kind: "IMAGE",
      ownerId: fixture.customerOwnerId,
      purpose: "CHAT_IMAGE",
    }),
    sql.begin(async (transaction) => {
      await transaction`
        SELECT id FROM users WHERE id = ${fixture.customerOwnerId} FOR UPDATE
      `;
      return transaction`
        UPDATE users SET account_state = 'SUSPENDED',
          account_state_changed_at = clock_timestamp(),
          updated_at = clock_timestamp()
        WHERE id = ${fixture.customerOwnerId}
      `;
    }),
  ]);
  if (suspension.status === "rejected") throw suspension.reason;
  const [state] = await sql<{ readonly changedAt: Date }[]>`
    SELECT account_state_changed_at AS "changedAt" FROM users
    WHERE id = ${fixture.customerOwnerId}
  `;
  if (state === undefined) throw new Error("Missing suspension race state.");
  if (created.status === "fulfilled") {
    expect(created.value.createdAt.valueOf()).toBeLessThanOrEqual(
      state.changedAt.valueOf(),
    );
  } else {
    expect(String(created.reason)).toMatch(/active writable message author/u);
  }
  await expect(
    createConversationAttachmentUploadAuthorization(sql).prepareUpload({
      actorUserId: fixture.customerOwnerId,
      conversationId: fixture.conversationId,
      mediaKind: "IMAGE",
      messageId: fixture.messageId,
    }),
  ).resolves.toEqual({ status: "UPLOAD_UNAVAILABLE" });
  await sql`
    UPDATE users SET account_state = 'ACTIVE',
      account_state_changed_at = clock_timestamp(), updated_at = clock_timestamp()
    WHERE id = ${fixture.customerOwnerId}
  `;
  return fixture;
}

async function assertCloseRaces(sql: Sql, fixture: Fixture) {
  const chat = createConversationChatRepository(sql);
  const invitations = createJobInvitationRepository(sql);
  const [message, attachment, close] = await Promise.allSettled([
    chat.sendMessage({
      actorUserId: fixture.customerOwnerId,
      body: "Správa súperiaca s uzavretím",
      commandId: randomUUID(),
      conversationId: fixture.conversationId,
    }),
    createProcessing(sql, messageProvenance(fixture), {
      kind: "DOCUMENT",
      ownerId: fixture.customerOwnerId,
      purpose: "CHAT_DOCUMENT",
    }),
    invitations.closeOwned({
      action: "STOP_CONSIDERING",
      actorUserId: fixture.customerOwnerId,
      commandId: randomUUID(),
      expectedRevision: 2,
      invitationId: fixture.invitationId,
    }),
  ]);
  if (close.status !== "fulfilled" || !("invitation" in close.value)) {
    if (close.status === "rejected") throw close.reason;
    throw new Error("Expected terminal invitation race effect.");
  }
  expect(close.value.status).toBe("APPLIED");
  const terminalAt = close.value.invitation.changedAt.valueOf();
  if (message.status === "rejected") throw message.reason;
  if (
    message.value.status === "SENT" ||
    message.value.status === "DEDUPLICATED"
  ) {
    expect(message.value.entry.createdAt.valueOf()).toBeLessThanOrEqual(
      terminalAt,
    );
  } else {
    expect(message.value.status).toBe("READ_ONLY");
  }
  if (attachment.status === "fulfilled") {
    expect(attachment.value.createdAt.valueOf()).toBeLessThanOrEqual(
      terminalAt,
    );
  } else {
    expect(String(attachment.reason)).toMatch(
      /active writable message author/u,
    );
  }
  await expect(
    createConversationAttachmentUploadAuthorization(sql).prepareUpload({
      actorUserId: fixture.customerOwnerId,
      conversationId: fixture.conversationId,
      mediaKind: "PDF",
      messageId: fixture.messageId,
    }),
  ).resolves.toEqual({ status: "UPLOAD_UNAVAILABLE" });
}

async function createWritableFixture(sql: Sql): Promise<Fixture> {
  const [source] = await sql<
    Array<{
      readonly customerOwnerId: UserId;
      readonly jobRequestId: JobRequestId;
      readonly primaryProfessionCode: string;
    }>
  >`
    SELECT owner.id AS "customerOwnerId", request.id AS "jobRequestId",
      core.payload ->> 'primaryProfessionCode' AS "primaryProfessionCode"
    FROM current_job_requests request
    JOIN customer_profiles customer ON customer.id = request.customer_profile_id
    JOIN users owner ON owner.id = customer.owner_user_id
    JOIN current_job_request_active_sections core
      ON core.job_request_id = request.id AND core.section_key = 'request.core'
    WHERE request.state::text = 'ACTIVE' AND owner.account_state = 'ACTIVE'
    ORDER BY request.created_at DESC, request.id DESC LIMIT 1
  `;
  if (source === undefined) throw new Error("Missing active request fixture.");
  const [target] = await sql<
    Array<{
      readonly ownerUserId: UserId;
      readonly profileId: CraftsmanProfileId;
    }>
  >`
    SELECT publication.craftsman_profile_id AS "profileId",
      profile.owner_user_id AS "ownerUserId"
    FROM current_craftsman_profile_publications publication
    JOIN craftsman_profiles profile
      ON profile.id = publication.craftsman_profile_id
    WHERE publication.effectively_public
      AND publication.owner_user_id <> ${source.customerOwnerId}
      AND NOT EXISTS (
        SELECT 1 FROM job_invitations existing
        WHERE existing.job_request_id = ${source.jobRequestId}
          AND existing.craftsman_profile_id = publication.craftsman_profile_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM current_credential_qualification_policies policy
        WHERE policy.profession_code = ${source.primaryProfessionCode}
          AND policy.requirement = 'REQUIRED'
          AND NOT EXISTS (
            SELECT 1 FROM current_searchable_craftsman_credentials credential
            WHERE credential.craftsman_profile_id = publication.craftsman_profile_id
              AND credential.profession_code = policy.profession_code
              AND credential.credential_type_code = policy.credential_type_code
          )
      )
    ORDER BY publication.craftsman_profile_id LIMIT 1
  `;
  if (target === undefined) {
    throw new Error("Missing additional eligible craftsman fixture.");
  }
  await verifyUser(sql, source.customerOwnerId);
  await verifyUser(sql, target.ownerUserId);
  const invitations = createJobInvitationRepository(sql);
  const sent = await invitations.sendOwned({
    actorUserId: source.customerOwnerId,
    commandId: randomUUID(),
    craftsmanProfileId: target.profileId,
    jobRequestId: source.jobRequestId,
  });
  if (!("invitation" in sent))
    throw new Error(`Invitation failed: ${sent.status}`);
  const engaged = await invitations.respondOwned({
    action: "ENGAGE",
    actorUserId: target.ownerUserId,
    commandId: randomUUID(),
    expectedRevision: sent.invitation.revision,
    invitationId: sent.invitation.id,
  });
  if (!("invitation" in engaged)) throw new Error("Engagement failed.");
  const [conversation] = await sql<{ readonly id: ConversationId }[]>`
    SELECT id FROM conversations WHERE invitation_id = ${engaged.invitation.id}
  `;
  if (conversation === undefined) throw new Error("Conversation missing.");
  const sentMessage = await createConversationChatRepository(sql).sendMessage({
    actorUserId: source.customerOwnerId,
    body: "Prílohy k tejto správe",
    commandId: randomUUID(),
    conversationId: conversation.id,
  });
  if (!("entry" in sentMessage)) throw new Error("Source message missing.");
  return {
    conversationId: conversation.id,
    craftsmanOwnerId: target.ownerUserId,
    customerOwnerId: source.customerOwnerId,
    invitationId: engaged.invitation.id,
    messageId: sentMessage.entry.id,
    messageSequence: sentMessage.entry.sequence,
  };
}

async function verifyUser(sql: Sql, userId: UserId) {
  await sql`
    INSERT INTO auth_credentials (
      user_id, normalized_email, password_hash, email_verified_at,
      normalized_phone, phone_verified_at
    ) VALUES (
      ${userId}, ${`${userId}@example.test`}, 'test-fixture-password-hash',
      clock_timestamp(), '+4219' || lpad(
        (abs(hashtextextended(${userId}::text, 46013)) % 100000000)::text,
        8, '0'
      ), clock_timestamp()
    ) ON CONFLICT (user_id) DO UPDATE SET
      email_verified_at = clock_timestamp(),
      normalized_phone = COALESCE(auth_credentials.normalized_phone,
        EXCLUDED.normalized_phone),
      phone_verified_at = clock_timestamp(), updated_at = clock_timestamp()
  `;
}

function messageProvenance(fixture: Fixture): ServerMediaProvenance {
  return createServerMediaProvenance({
    entityId: fixture.messageId,
    entityRevision: fixture.messageSequence,
    entityType: "CONVERSATION_MESSAGE",
  });
}

async function createProcessing(
  sql: Sql,
  provenance: ServerMediaProvenance,
  input: {
    readonly kind: "DOCUMENT" | "IMAGE";
    readonly ownerId: UserId;
    readonly purpose: "CHAT_DOCUMENT" | "CHAT_IMAGE";
  },
) {
  return createMediaRepository(sql).createProcessingAsset({
    byteSize: 3,
    declaredContentType:
      input.kind === "IMAGE" ? "image/jpeg" : "application/pdf",
    displayFilename: null,
    kind: input.kind,
    ownerUserId: input.ownerId,
    provenanceEntityId: provenance.entityId,
    provenanceEntityRevision: provenance.entityRevision,
    provenanceEntityType: provenance.entityType,
    purpose: input.purpose,
    storageObject: {
      area: "private",
      key: `private/2026/09/${randomUUID()}` as never,
    },
    uploaderUserId: input.ownerId,
  });
}

async function makeReadyImage(
  sql: Sql,
  mediaAssetId: string,
  capturedAt: Date | null,
) {
  await sql`
    INSERT INTO media_asset_storage_objects (
      media_asset_id, role, storage_area, storage_key, content_type,
      byte_size, content_sha256
    ) VALUES (
      ${mediaAssetId}, 'CANONICAL', 'private',
      ${`private/2026/09/${randomUUID()}`}, 'image/webp', 3, ${"a".repeat(64)}
    )
  `;
  await sql`
    UPDATE media_assets SET status = 'READY', ready_at = clock_timestamp(),
      status_changed_at = clock_timestamp(), updated_at = clock_timestamp(),
      canonical_width = 10, canonical_height = 10,
      captured_at = ${capturedAt}
    WHERE id = ${mediaAssetId}
  `;
}
