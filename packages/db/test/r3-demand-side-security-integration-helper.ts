import { randomUUID } from "node:crypto";

import type {
  ConversationId,
  ConversationMessageId,
  CraftsmanProfileId,
  JobInvitationId,
  JobRequestId,
  QuoteId,
  UserId,
} from "@portal/domain";
import { createPrivateMediaDeliveryService } from "@portal/media";
import {
  createCredentialQualificationPolicyService,
  type CredentialQualificationPolicyEntrySeed,
} from "@portal/search";
import {
  verifyR3DatabaseSecurityMatrix,
  type R3DatabaseBoundaryProbeEvidence,
  type R3DatabaseBoundaryProbeResult,
  type R3DatabaseSecurityCase,
  type R3DatabaseSecurityMatrixAdapter,
  type R3SecurityActor,
  type R3StageOneSecurityReport,
} from "@portal/testing";
import type { Sql } from "postgres";
import {
  createConversationAttachmentMediaAccessResolver,
  createConversationAttachmentUploadAuthorization,
} from "../src/conversation-attachment-repository.js";
import { createConversationChatRepository } from "../src/conversation-chat-repository.js";
import { createConversationRepository } from "../src/conversation-repository.js";
import { createCredentialQualificationRepository } from "../src/credential-qualification-repository.js";
import { createExternalPdfQuoteRepository } from "../src/quote-external-pdf-repository.js";
import { createJobInvitationRepository } from "../src/job-invitation-repository.js";
import { createMediaRepository } from "../src/media-repository.js";
import { createPrivateMediaDeliveryRepository } from "../src/media-delivery-repository.js";
import { createQuoteComparisonRepository } from "../src/quote-comparison-repository.js";
import { createQuoteDocumentMediaAccessResolver } from "../src/quote-external-pdf-repository.js";
import { createQuoteRepository } from "../src/quote-repository.js";
import { createStructuredQuoteRepository } from "../src/quote-structured-repository.js";

interface SourceConversation {
  readonly competitorConversationId: ConversationId;
  readonly competitorInvitationId: JobInvitationId;
  readonly competitorProviderOwnerId: UserId;
  readonly customerOwnerId: UserId;
  readonly jobRequestId: JobRequestId;
  readonly primaryProfessionCode: string;
  readonly requestContentRevision: number;
  readonly requestVisibleVersion: number;
}

interface FixtureActors {
  readonly adminRoleOnlyId: UserId;
  readonly competingProviderId: UserId;
  readonly customerOwnerId: UserId;
  readonly foreignCustomerId: UserId;
  readonly providerOwnerId: UserId;
  readonly superadminRoleOnlyId: UserId;
  readonly uninvitedProviderId: UserId;
  readonly unrelatedCombinedId: UserId;
}

interface SecurityFixture {
  readonly actors: FixtureActors;
  readonly chatAssetId: string;
  readonly chatStorageKey: string;
  readonly competitorMarkers: readonly string[];
  readonly competitorConversationId: ConversationId;
  readonly competitorInvitationId: JobInvitationId;
  readonly conversationId: ConversationId;
  readonly externalRevision: number;
  readonly invitationId: JobInvitationId;
  readonly jobRequestId: JobRequestId;
  readonly messageBody: string;
  readonly messageId: ConversationMessageId;
  readonly privateMarkers: readonly string[];
  readonly quoteId: QuoteId;
  readonly quotePdfCurrentAssetId: string;
  readonly quotePdfReplacedAssetId: string;
  readonly structuredRevision: number;
  readonly unknownId: string;
}

interface ProbeTarget {
  readonly chatAssetId: string;
  readonly conversationId: ConversationId;
  readonly externalRevision: number;
  readonly invitationId: JobInvitationId;
  readonly jobRequestId: JobRequestId;
  readonly quoteId: QuoteId;
  readonly quotePdfCurrentAssetId: string;
  readonly quotePdfReplacedAssetId: string;
  readonly structuredRevision: number;
}

interface ActorRow {
  readonly id: UserId;
}

interface TargetProviderRow {
  readonly invitationId: JobInvitationId | null;
  readonly invitationRevision: number | null;
  readonly invitationState: "ENGAGED" | "PENDING" | null;
  readonly ownerUserId: UserId;
  readonly profileId: CraftsmanProfileId;
  readonly requestContentRevision: number | null;
  readonly requestVisibleVersion: number | null;
}

const fixedClock = new Date("2099-01-01T00:00:00.000Z");

/**
 * Standalone Stage-1 R3-022 evidence. The root migration runner may call this
 * after R3 Quote/media fixtures and before R3-019 closes writable invitations.
 * It is intentionally for a disposable integration database. Repositories own
 * their transactions, so its append-only fixture is not described as rollback
 * clean evidence.
 */
export async function runR3DemandSideSecurityIntegrationAssertions(
  sql: Sql,
): Promise<R3StageOneSecurityReport> {
  const fixture = await createSecurityFixture(sql);
  return verifyR3DatabaseSecurityMatrix(
    createLiveDatabaseAdapter(sql, fixture),
  );
}

function createLiveDatabaseAdapter(
  sql: Sql,
  fixture: SecurityFixture,
): R3DatabaseSecurityMatrixAdapter {
  return Object.freeze({
    competitorMarkers: fixture.competitorMarkers,
    privateMarkers: fixture.privateMarkers,
    async probe(testCase: R3DatabaseSecurityCase) {
      const unsupportedReason = unsupportedLiveCase(testCase);
      if (unsupportedReason !== null) {
        return Object.freeze({
          evaluation: "NOT_EVALUATED" as const,
          reason: unsupportedReason,
        });
      }
      const actorUserId = actorId(fixture.actors, testCase.actor);
      const suspend = suspendedActor(testCase.actor);
      if (suspend !== null)
        await setAccountState(sql, actorUserId, "SUSPENDED");
      try {
        return await probeSurface(sql, fixture, testCase, actorUserId);
      } finally {
        if (suspend !== null) await setAccountState(sql, actorUserId, "ACTIVE");
      }
    },
  });
}

function unsupportedLiveCase(testCase: R3DatabaseSecurityCase): string | null {
  if (
    testCase.state === "TERMINAL_LINEAGE" ||
    testCase.state === "PROVIDER_DRAFT"
  ) {
    return "The Stage-1 adapter preserves its writable submitted lineage; terminal and draft races remain standalone DB helpers.";
  }
  if (
    testCase.target === "UNKNOWN_UUID" ||
    testCase.target === "WRONG_KIND_UUID"
  ) {
    return null;
  }
  if (testCase.target === "FOREIGN_REQUEST") {
    return "The Stage-1 seed has no second foreign request lineage.";
  }
  if (
    testCase.target === "COMPETITOR_SAME_REQUEST" &&
    ![
      "CONVERSATION",
      "CONVERSATION_TIMELINE",
      "CONVERSATION_WRITE",
      "INVITATION_DETAIL",
      "QUOTE_COMPARISON",
    ].includes(testCase.surface)
  ) {
    return "The pre-existing competitor lineage has no guaranteed matching media and Quote fixture.";
  }
  return null;
}

function targetFixture(
  fixture: SecurityFixture,
  testCase: R3DatabaseSecurityCase,
): ProbeTarget {
  if (testCase.target === "EXACT_OWN") return fixture;
  if (testCase.target === "COMPETITOR_SAME_REQUEST") {
    return Object.freeze({
      ...fixture,
      conversationId: fixture.competitorConversationId,
      invitationId: fixture.competitorInvitationId,
    });
  }
  const targetId =
    testCase.target === "UNKNOWN_UUID" ? fixture.unknownId : fixture.messageId;
  return Object.freeze({
    chatAssetId: targetId,
    conversationId: targetId as ConversationId,
    externalRevision: fixture.externalRevision,
    invitationId: targetId as JobInvitationId,
    jobRequestId: targetId as JobRequestId,
    quoteId: targetId as QuoteId,
    quotePdfCurrentAssetId: targetId,
    quotePdfReplacedAssetId: targetId,
    structuredRevision: fixture.structuredRevision,
  });
}

async function probeSurface(
  sql: Sql,
  fixture: SecurityFixture,
  testCase: R3DatabaseSecurityCase,
  actorUserId: UserId,
): Promise<R3DatabaseBoundaryProbeEvidence> {
  const target = targetFixture(fixture, testCase);
  switch (testCase.surface) {
    case "INVITATION_DETAIL":
      return readResult(
        await createJobInvitationRepository(sql).readOwned({
          actorUserId,
          invitationId: target.invitationId,
        }),
      );
    case "CONVERSATION":
      return readResult(
        await createConversationRepository(sql).readOwned({
          actorUserId,
          conversationId: target.conversationId,
        }),
      );
    case "CONVERSATION_TIMELINE":
      return readResult(
        await createConversationChatRepository(sql).readTimeline({
          actorUserId,
          conversationId: target.conversationId,
        }),
      );
    case "CONVERSATION_WRITE":
      return probeConversationWrite(sql, target.conversationId, actorUserId);
    case "CHAT_ATTACHMENT":
      return downloadResult(
        await chatDelivery(sql).handleDownload({
          actorUserId,
          mediaAssetId: target.chatAssetId,
        }),
      );
    case "QUOTE_CORE":
      return readResult(
        await createQuoteRepository(sql).readOwned({
          actorUserId,
          quoteId: target.quoteId,
        }),
      );
    case "QUOTE_STRUCTURED_REVISION":
      return readResult(
        await createStructuredQuoteRepository(sql).readOwned({
          actorUserId,
          quoteId: target.quoteId,
          quoteRevision: target.structuredRevision,
        }),
      );
    case "QUOTE_EXTERNAL_REVISION":
      return readResult(
        await createExternalPdfQuoteRepository(sql).readOwned({
          actorUserId,
          quoteId: target.quoteId,
          quoteRevision: target.externalRevision,
        }),
      );
    case "QUOTE_COMPARISON":
      return readResult(
        await createQuoteComparisonRepository(sql).readCurrent({
          actorUserId,
          jobRequestId: target.jobRequestId,
        }),
      );
    case "QUOTE_PDF_CURRENT":
      return downloadResult(
        await quoteDelivery(sql).handleDownload({
          actorUserId,
          mediaAssetId: target.quotePdfCurrentAssetId,
        }),
      );
    case "QUOTE_PDF_REPLACED":
      return downloadResult(
        await quoteDelivery(sql).handleDownload({
          actorUserId,
          mediaAssetId: target.quotePdfReplacedAssetId,
        }),
      );
  }
}

async function probeConversationWrite(
  sql: Sql,
  conversationId: ConversationId,
  actorUserId: UserId,
): Promise<R3DatabaseBoundaryProbeResult> {
  const before = await timelineEntryCount(sql, conversationId);
  const result = await createConversationChatRepository(sql).sendMessage({
    actorUserId,
    body: "Izolovaný R3-022 command probe",
    commandId: randomUUID(),
    conversationId,
  });
  const after = await timelineEntryCount(sql, conversationId);
  if (result.status === "SENT" || result.status === "DEDUPLICATED") {
    return Object.freeze({
      evaluation: "EVALUATED" as const,
      allowed: true,
      effectCountAfter: after,
      effectCountBefore: before,
      outcome: "APPLIED" as const,
      payload: result,
    });
  }
  if (result.status !== "NOT_FOUND") {
    throw new Error(
      `Unexpected R3 conversation probe result: ${result.status}`,
    );
  }
  return Object.freeze({
    evaluation: "EVALUATED" as const,
    allowed: false,
    effectCountAfter: after,
    effectCountBefore: before,
    outcome: "NOT_FOUND" as const,
    payload: { code: "NOT_FOUND" },
  });
}

function readResult(value: unknown): R3DatabaseBoundaryProbeResult {
  return value === null || value === undefined
    ? Object.freeze({
        evaluation: "EVALUATED" as const,
        allowed: false,
        outcome: "NOT_FOUND" as const,
        payload: { code: "NOT_FOUND" },
      })
    : Object.freeze({
        evaluation: "EVALUATED" as const,
        allowed: true,
        outcome: "FOUND" as const,
        payload: value,
      });
}

function downloadResult(value: {
  readonly body?: unknown;
  readonly headers: Readonly<Record<string, string>>;
  readonly statusCode: number;
}): R3DatabaseBoundaryProbeResult {
  if (value.statusCode === 303) {
    if (
      value.headers["cache-control"] !== "private, no-store" ||
      value.headers["referrer-policy"] !== "no-referrer" ||
      typeof value.headers.location !== "string" ||
      !value.headers.location.startsWith("https://objects.example.test/")
    ) {
      throw new Error("R3 private-media grant had unsafe response headers.");
    }
    return Object.freeze({
      evaluation: "EVALUATED" as const,
      allowed: true,
      outcome: "GRANTED" as const,
      payload: { statusCode: value.statusCode },
    });
  }
  if (value.statusCode !== 404) {
    throw new Error(`Unexpected R3 private-media status: ${value.statusCode}`);
  }
  if (value.headers["cache-control"] !== "private, no-store") {
    throw new Error("R3 private-media denial was cacheable.");
  }
  return Object.freeze({
    evaluation: "EVALUATED" as const,
    allowed: false,
    outcome: "NOT_FOUND" as const,
    payload: value.body ?? { code: "NOT_FOUND" },
  });
}

function chatDelivery(sql: Sql) {
  return createPrivateMediaDeliveryService({
    applicationOrigin: "https://portal.example.test",
    clock: () => fixedClock,
    entityAccess: createConversationAttachmentMediaAccessResolver(sql),
    repository: createPrivateMediaDeliveryRepository(sql),
    storage: privateStorage(),
  });
}

function quoteDelivery(sql: Sql) {
  return createPrivateMediaDeliveryService({
    applicationOrigin: "https://portal.example.test",
    clock: () => fixedClock,
    entityAccess: createQuoteDocumentMediaAccessResolver(sql),
    repository: createPrivateMediaDeliveryRepository(sql),
    storage: privateStorage(),
  });
}

function privateStorage() {
  return {
    createPrivateDownload: () =>
      Promise.resolve({
        expiresAt: new Date(fixedClock.valueOf() + 30_000),
        url: new URL("https://objects.example.test/r3-022-grant"),
      }),
    readPrivateForProcessing: () => Promise.reject(new Error("unused")),
    revokePublicDerivative: () => Promise.reject(new Error("unused")),
    storePrivate: () => Promise.reject(new Error("unused")),
    storePublicDerivative: () => Promise.reject(new Error("unused")),
  };
}

async function createSecurityFixture(sql: Sql): Promise<SecurityFixture> {
  const { source, target } = await findSecurityLineage(sql);
  await ensureVerifiedCredentials(sql, source.customerOwnerId);
  await ensureVerifiedCredentials(sql, target.ownerUserId);

  const invitations = createJobInvitationRepository(sql);
  const pendingInvitation =
    target.invitationId === null
      ? await invitations.sendOwned({
          actorUserId: source.customerOwnerId,
          commandId: randomUUID(),
          craftsmanProfileId: target.profileId,
          jobRequestId: source.jobRequestId,
        })
      : null;
  if (pendingInvitation !== null && !("invitation" in pendingInvitation)) {
    throw new Error(
      `R3-022 target invitation failed: ${pendingInvitation.status}`,
    );
  }
  const invitationId =
    target.invitationId ??
    (pendingInvitation !== null && "invitation" in pendingInvitation
      ? pendingInvitation.invitation.id
      : null);
  const invitationRevision =
    target.invitationRevision ??
    (pendingInvitation !== null && "invitation" in pendingInvitation
      ? pendingInvitation.invitation.revision
      : null);
  if (invitationId === null || invitationRevision === null) {
    throw new Error("R3-022 target invitation identity is missing.");
  }
  const engagement =
    target.invitationState === "ENGAGED"
      ? null
      : await invitations.respondOwned({
          action: "ENGAGE",
          actorUserId: target.ownerUserId,
          commandId: randomUUID(),
          expectedRevision: invitationRevision,
          invitationId,
        });
  if (engagement !== null && !("invitation" in engagement)) {
    throw new Error(`R3-022 target engagement failed: ${engagement.status}`);
  }
  const requestContentRevision =
    target.requestContentRevision ??
    (pendingInvitation !== null && "invitation" in pendingInvitation
      ? pendingInvitation.invitation.requestContentRevision
      : null);
  const requestVisibleVersion =
    target.requestVisibleVersion ??
    (pendingInvitation !== null && "invitation" in pendingInvitation
      ? pendingInvitation.invitation.requestVisibleVersion
      : null);
  if (requestContentRevision === null || requestVisibleVersion === null) {
    throw new Error("R3-022 target request provenance is missing.");
  }
  const [conversation] = await sql<{ readonly id: ConversationId }[]>`
    SELECT id FROM conversations WHERE invitation_id = ${invitationId}
  `;
  if (conversation === undefined) {
    throw new Error("R3-022 target conversation was not created.");
  }

  const messageBody = `R3-022 private message ${randomUUID()}`;
  const sentMessage = await createConversationChatRepository(sql).sendMessage({
    actorUserId: target.ownerUserId,
    body: messageBody,
    commandId: randomUUID(),
    conversationId: conversation.id,
  });
  if (!("entry" in sentMessage)) {
    throw new Error(`R3-022 source message failed: ${sentMessage.status}`);
  }
  const chatMedia = await createReadyChatImage(
    sql,
    target.ownerUserId,
    conversation.id,
    sentMessage.entry.id,
  );

  const quoteFixture = await createQuoteHistory(sql, {
    conversationId: conversation.id,
    customerOwnerId: source.customerOwnerId,
    providerOwnerId: target.ownerUserId,
    requestContentRevision,
    requestVisibleVersion,
  });
  const actors = await findBoundaryActors(sql, {
    competingProviderId: source.competitorProviderOwnerId,
    customerOwnerId: source.customerOwnerId,
    providerOwnerId: target.ownerUserId,
    targetCraftsmanProfileId: target.profileId,
  });
  const competitorQuoteMarker = await competitorQuoteId(
    sql,
    source.competitorConversationId,
  );
  const competitorMarkers = Object.freeze(
    [
      source.competitorProviderOwnerId,
      source.competitorConversationId,
      ...(competitorQuoteMarker === null ? [] : [competitorQuoteMarker]),
    ].map(String),
  );
  const privateMarkers = Object.freeze([
    messageBody,
    conversation.id,
    sentMessage.entry.id,
    quoteFixture.quoteId,
    chatMedia.assetId,
    chatMedia.storageKey,
    quoteFixture.currentPdfAssetId,
    quoteFixture.replacedPdfAssetId,
  ]);
  return Object.freeze({
    actors,
    chatAssetId: chatMedia.assetId,
    chatStorageKey: chatMedia.storageKey,
    competitorMarkers,
    competitorConversationId: source.competitorConversationId,
    competitorInvitationId: source.competitorInvitationId,
    conversationId: conversation.id,
    externalRevision: quoteFixture.externalRevision,
    invitationId,
    jobRequestId: source.jobRequestId,
    messageBody,
    messageId: sentMessage.entry.id,
    privateMarkers,
    quoteId: quoteFixture.quoteId,
    quotePdfCurrentAssetId: quoteFixture.currentPdfAssetId,
    quotePdfReplacedAssetId: quoteFixture.replacedPdfAssetId,
    structuredRevision: quoteFixture.structuredRevision,
    unknownId: randomUUID(),
  });
}

async function findSecurityLineage(sql: Sql): Promise<{
  readonly source: SourceConversation;
  readonly target: TargetProviderRow;
}> {
  const sources = await sql<SourceConversation[]>`
    SELECT conversation.id AS "competitorConversationId",
      conversation.invitation_id AS "competitorInvitationId",
      craftsman.owner_user_id AS "competitorProviderOwnerId",
      customer.owner_user_id AS "customerOwnerId",
      conversation.job_request_id AS "jobRequestId",
      core.payload ->> 'primaryProfessionCode' AS "primaryProfessionCode",
      content.content_revision AS "requestContentRevision",
      content.visible_version AS "requestVisibleVersion"
    FROM current_conversations conversation
    JOIN customer_profiles customer
      ON customer.id = conversation.customer_profile_id
    JOIN craftsman_profiles craftsman
      ON craftsman.id = conversation.craftsman_profile_id
    JOIN users customer_actor ON customer_actor.id = customer.owner_user_id
      AND customer_actor.account_state = 'ACTIVE'
    JOIN users provider_actor ON provider_actor.id = craftsman.owner_user_id
      AND provider_actor.account_state = 'ACTIVE'
    JOIN current_job_requests request ON request.id = conversation.job_request_id
      AND request.state = 'ACTIVE'
    JOIN current_job_request_active_content_versions content
      ON content.job_request_id = request.id
    JOIN current_job_request_active_sections core
      ON core.job_request_id = request.id
      AND core.section_key = 'request.core'
    WHERE conversation.access_state = 'WRITABLE'
      AND conversation.invitation_state = 'ENGAGED'
    ORDER BY conversation.created_at DESC, conversation.id DESC
  `;
  for (const source of sources) {
    await makeRequestProfessionOptionalForFixture(
      sql,
      source.primaryProfessionCode,
    );
    const target = await findTargetProvider(sql, source);
    if (target !== null) return Object.freeze({ source, target });
  }
  throw new Error(
    "R3-022 requires an ACTIVE request with two isolated provider lineages.",
  );
}

async function findTargetProvider(
  sql: Sql,
  source: SourceConversation,
): Promise<TargetProviderRow | null> {
  const [row] = await sql<TargetProviderRow[]>`
    WITH candidates AS (
      SELECT invitation.craftsman_profile_id AS "profileId",
        profile.owner_user_id AS "ownerUserId",
        invitation.id AS "invitationId", invitation.revision AS "invitationRevision",
        invitation.state::text AS "invitationState",
        invitation.request_content_revision AS "requestContentRevision",
        invitation.request_visible_version AS "requestVisibleVersion", 0 AS priority
      FROM current_job_invitations invitation
      JOIN craftsman_profiles profile
        ON profile.id = invitation.craftsman_profile_id
      JOIN users actor ON actor.id = profile.owner_user_id
        AND actor.account_state = 'ACTIVE'
      WHERE invitation.job_request_id = ${source.jobRequestId}
        AND invitation.state IN ('PENDING', 'ENGAGED')
        AND profile.owner_user_id NOT IN (
          ${source.customerOwnerId}, ${source.competitorProviderOwnerId}
        )
      UNION ALL
      SELECT publication.craftsman_profile_id, profile.owner_user_id,
        NULL::uuid, NULL::integer, NULL::text, NULL::integer, NULL::integer, 1
      FROM current_craftsman_profile_publications publication
      JOIN craftsman_profiles profile
        ON profile.id = publication.craftsman_profile_id
      JOIN users actor ON actor.id = profile.owner_user_id
        AND actor.account_state = 'ACTIVE'
      JOIN current_job_request_active_sections core
        ON core.job_request_id = ${source.jobRequestId}
        AND core.section_key = 'request.core'
      CROSS JOIN job_invitation_runtime_policy runtime_policy
      WHERE publication.effectively_public
        AND profile.owner_user_id NOT IN (
          ${source.customerOwnerId}, ${source.competitorProviderOwnerId}
        )
        AND (
          SELECT count(*) FROM current_job_invitations active_invitation
          WHERE active_invitation.job_request_id = ${source.jobRequestId}
            AND active_invitation.state IN ('PENDING', 'ENGAGED')
        ) < runtime_policy.active_invitation_limit
        AND NOT EXISTS (
          SELECT 1 FROM job_invitations existing
          WHERE existing.job_request_id = ${source.jobRequestId}
            AND existing.craftsman_profile_id = profile.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM current_credential_qualification_policies policy
          WHERE policy.profession_code = core.payload ->> 'primaryProfessionCode'
            AND policy.requirement = 'REQUIRED'
            AND NOT EXISTS (
              SELECT 1 FROM current_searchable_craftsman_credentials qualified
              WHERE qualified.craftsman_profile_id = profile.id
                AND qualified.profession_code = policy.profession_code
                AND qualified.credential_type_code = policy.credential_type_code
            )
        )
    )
    SELECT "profileId", "ownerUserId", "invitationId", "invitationRevision",
      "invitationState", "requestContentRevision", "requestVisibleVersion"
    FROM candidates
    ORDER BY priority, "profileId"
    LIMIT 1
  `;
  return row ?? null;
}

async function findBoundaryActors(
  sql: Sql,
  fixed: Pick<
    FixtureActors,
    "competingProviderId" | "customerOwnerId" | "providerOwnerId"
  > & { readonly targetCraftsmanProfileId: CraftsmanProfileId },
): Promise<FixtureActors> {
  const [foreignCustomer] = await sql<ActorRow[]>`
    SELECT owner.id
    FROM customer_profiles customer
    JOIN users owner ON owner.id = customer.owner_user_id
      AND owner.account_state = 'ACTIVE'
    WHERE owner.id NOT IN (
      ${fixed.competingProviderId}, ${fixed.customerOwnerId},
      ${fixed.providerOwnerId}
    )
    ORDER BY owner.id LIMIT 1
  `;
  const [uninvitedProvider] = await sql<ActorRow[]>`
    SELECT owner.id
    FROM craftsman_profiles craftsman
    JOIN users owner ON owner.id = craftsman.owner_user_id
      AND owner.account_state = 'ACTIVE'
    WHERE craftsman.id <> ${fixed.targetCraftsmanProfileId}
      AND owner.id NOT IN (
        ${fixed.competingProviderId}, ${fixed.customerOwnerId}, ${fixed.providerOwnerId}
      )
    ORDER BY owner.id LIMIT 1
  `;
  const [combined] = await sql<ActorRow[]>`
    SELECT owner.id
    FROM users owner
    JOIN customer_profiles customer ON customer.owner_user_id = owner.id
    JOIN craftsman_profiles craftsman ON craftsman.owner_user_id = owner.id
    WHERE owner.account_state = 'ACTIVE'
      AND owner.id NOT IN (
        ${fixed.competingProviderId}, ${fixed.customerOwnerId},
        ${fixed.providerOwnerId}
      )
    ORDER BY owner.id LIMIT 1
  `;
  const [admin] = await sql<ActorRow[]>`
    SELECT owner.id FROM users owner
    JOIN admin_role_grants role_grant ON role_grant.user_id = owner.id
      AND role_grant.role = 'ADMIN' AND role_grant.revoked_at IS NULL
    WHERE owner.account_state = 'ACTIVE'
      AND owner.id NOT IN (
        ${fixed.competingProviderId}, ${fixed.customerOwnerId},
        ${fixed.providerOwnerId}
      )
    ORDER BY owner.id LIMIT 1
  `;
  const [superadmin] = await sql<ActorRow[]>`
    SELECT owner.id FROM users owner
    JOIN admin_role_grants role_grant ON role_grant.user_id = owner.id
      AND role_grant.role = 'SUPER_ADMIN' AND role_grant.revoked_at IS NULL
    WHERE owner.account_state = 'ACTIVE'
      AND owner.id NOT IN (
        ${fixed.competingProviderId}, ${fixed.customerOwnerId},
        ${fixed.providerOwnerId}
      )
    ORDER BY owner.id LIMIT 1
  `;
  if (
    foreignCustomer === undefined ||
    uninvitedProvider === undefined ||
    combined === undefined ||
    admin === undefined ||
    superadmin === undefined
  ) {
    throw new Error(
      "R3-022 requires foreign-customer, uninvited-provider, combined, ADMIN and SUPER_ADMIN fixtures.",
    );
  }
  return Object.freeze({
    adminRoleOnlyId: admin.id,
    competingProviderId: fixed.competingProviderId,
    customerOwnerId: fixed.customerOwnerId,
    foreignCustomerId: foreignCustomer.id,
    providerOwnerId: fixed.providerOwnerId,
    superadminRoleOnlyId: superadmin.id,
    uninvitedProviderId: uninvitedProvider.id,
    unrelatedCombinedId: combined.id,
  });
}

function actorId(actors: FixtureActors, actor: R3SecurityActor): UserId {
  switch (actor) {
    case "CUSTOMER_OWNER":
    case "SUSPENDED_CUSTOMER_OWNER":
      return actors.customerOwnerId;
    case "PROVIDER_OWNER":
    case "SUSPENDED_PROVIDER_OWNER":
      return actors.providerOwnerId;
    case "COMPETING_PROVIDER":
      return actors.competingProviderId;
    case "UNRELATED_CUSTOMER":
      return actors.foreignCustomerId;
    case "UNINVITED_PROVIDER":
      return actors.uninvitedProviderId;
    case "UNRELATED_COMBINED":
      return actors.unrelatedCombinedId;
    case "ADMIN_ROLE_ONLY":
      return actors.adminRoleOnlyId;
    case "SUPERADMIN_ROLE_ONLY":
      return actors.superadminRoleOnlyId;
  }
}

function suspendedActor(
  actor: R3SecurityActor,
): "CUSTOMER" | "PROVIDER" | null {
  if (actor === "SUSPENDED_CUSTOMER_OWNER") return "CUSTOMER";
  if (actor === "SUSPENDED_PROVIDER_OWNER") return "PROVIDER";
  return null;
}

async function setAccountState(
  sql: Sql,
  actorUserId: UserId,
  state: "ACTIVE" | "SUSPENDED",
): Promise<void> {
  await sql`
    UPDATE users SET account_state = ${state},
      account_state_changed_at = clock_timestamp(), updated_at = clock_timestamp()
    WHERE id = ${actorUserId}
  `;
}

async function timelineEntryCount(
  sql: Sql,
  conversationId: ConversationId,
): Promise<number> {
  const [row] = await sql<Array<{ readonly count: number }>>`
    SELECT count(*)::integer AS count FROM conversation_timeline_entries
    WHERE conversation_id = ${conversationId}
  `;
  if (row === undefined) throw new Error("Missing R3 timeline count.");
  return row.count;
}

async function competitorQuoteId(
  sql: Sql,
  conversationId: ConversationId,
): Promise<string | null> {
  const [row] = await sql<Array<{ readonly id: string }>>`
    SELECT id FROM quotes WHERE conversation_id = ${conversationId}
    ORDER BY created_at DESC LIMIT 1
  `;
  return row?.id ?? null;
}

async function ensureVerifiedCredentials(
  sql: Sql,
  userId: UserId,
): Promise<void> {
  await sql`
    INSERT INTO auth_credentials (
      user_id, normalized_email, password_hash, email_verified_at,
      normalized_phone, phone_verified_at
    ) VALUES (
      ${userId}, ${`${userId}@r3-022.example.test`},
      'r3-022-test-password-hash', clock_timestamp(),
      '+4218' || lpad(
        (abs(hashtextextended(${userId}::text, 3022)) % 100000000)::text,
        8, '0'
      ), clock_timestamp()
    ) ON CONFLICT (user_id) DO UPDATE SET
      email_verified_at = clock_timestamp(),
      normalized_phone = COALESCE(
        auth_credentials.normalized_phone, EXCLUDED.normalized_phone
      ),
      phone_verified_at = clock_timestamp(), updated_at = clock_timestamp()
  `;
}

async function makeRequestProfessionOptionalForFixture(
  sql: Sql,
  professionCode: string,
): Promise<void> {
  const entries = await sql<CredentialQualificationPolicyEntrySeed[]>`
    SELECT profession_code AS "professionCode",
      credential_type_code AS "credentialTypeCode", requirement::text AS requirement
    FROM current_credential_qualification_policies
    ORDER BY profession_code, credential_type_code
  `;
  if (
    !entries.some(
      (entry) =>
        entry.professionCode === professionCode &&
        entry.requirement === "REQUIRED",
    )
  ) {
    return;
  }
  const [current] = await sql<
    Array<{
      readonly releaseId: string;
      readonly taxonomyReleaseId: string;
      readonly version: number;
    }>
  >`
    SELECT release.release_id AS "releaseId",
      release.taxonomy_release_id AS "taxonomyReleaseId", release.version
    FROM credential_qualification_policy_activation_events activation
    JOIN credential_qualification_policy_releases release
      ON release.release_id = activation.release_id
    ORDER BY activation.activation_sequence DESC
    LIMIT 1
  `;
  if (current === undefined) {
    throw new Error("R3-022 requires a qualification policy fixture.");
  }
  const nextReleaseId = randomUUID();
  const policy = createCredentialQualificationPolicyService({
    persistence: createCredentialQualificationRepository(sql),
  });
  await policy.installRelease({
    entries: entries.map((entry) => ({
      ...entry,
      requirement:
        entry.professionCode === professionCode
          ? "OPTIONAL"
          : entry.requirement,
    })),
    releaseId: nextReleaseId,
    reviewReference: "test-review:R3-022-security-fixture",
    supersedesReleaseId: current.releaseId,
    taxonomyReleaseId: current.taxonomyReleaseId,
    version: current.version + 1,
  });
  await policy.activateRelease({
    activationId: randomUUID(),
    actorReference: "test-deployment:R3-022-security-fixture",
    previousReleaseId: current.releaseId,
    releaseId: nextReleaseId,
    reviewReference: "test-review:R3-022-security-fixture",
  });
}

async function createReadyChatImage(
  sql: Sql,
  ownerUserId: UserId,
  conversationId: ConversationId,
  messageId: ConversationMessageId,
): Promise<{ readonly assetId: string; readonly storageKey: string }> {
  const prepared = await createConversationAttachmentUploadAuthorization(
    sql,
  ).prepareUpload({
    actorUserId: ownerUserId,
    conversationId,
    mediaKind: "IMAGE",
    messageId,
  });
  if (prepared.status !== "AUTHORIZED") {
    throw new Error("R3-022 chat attachment was not authorized.");
  }
  const originalStorageKey = `private/2099/01/${randomUUID()}`;
  const processing = await createMediaRepository(sql).createProcessingAsset({
    byteSize: 3,
    declaredContentType: "image/jpeg",
    displayFilename: null,
    kind: "IMAGE",
    ownerUserId,
    provenanceEntityId: prepared.provenance.entityId,
    provenanceEntityRevision: prepared.provenance.entityRevision,
    provenanceEntityType: prepared.provenance.entityType,
    purpose: "CHAT_IMAGE",
    storageObject: {
      area: "private",
      key: originalStorageKey as never,
    },
    uploaderUserId: ownerUserId,
  });
  const canonicalStorageKey = `private/2099/01/${randomUUID()}`;
  await sql`
    INSERT INTO media_asset_storage_objects (
      media_asset_id, role, storage_area, storage_key, content_type,
      byte_size, content_sha256
    ) VALUES (
      ${processing.id}, 'CANONICAL', 'private', ${canonicalStorageKey},
      'image/webp', 3, ${"b".repeat(64)}
    )
  `;
  await sql`
    UPDATE media_assets SET status = 'READY', ready_at = clock_timestamp(),
      status_changed_at = clock_timestamp(), updated_at = clock_timestamp(),
      canonical_width = 10, canonical_height = 10
    WHERE id = ${processing.id}
  `;
  return Object.freeze({
    assetId: processing.id,
    storageKey: canonicalStorageKey,
  });
}

async function createQuoteHistory(
  sql: Sql,
  input: {
    readonly conversationId: ConversationId;
    readonly customerOwnerId: UserId;
    readonly providerOwnerId: UserId;
    readonly requestContentRevision: number;
    readonly requestVisibleVersion: number;
  },
): Promise<{
  readonly currentPdfAssetId: string;
  readonly externalRevision: number;
  readonly quoteId: QuoteId;
  readonly replacedPdfAssetId: string;
  readonly structuredRevision: number;
}> {
  const quotes = createQuoteRepository(sql);
  const created = await quotes.createDraft({
    actorUserId: input.providerOwnerId,
    authoringMode: "PLATFORM_STRUCTURED",
    commandId: randomUUID(),
    conversationId: input.conversationId,
    requestContentRevision: input.requestContentRevision,
    requestVisibleVersion: input.requestVisibleVersion,
  });
  if (!("quote" in created) || created.quote.currentDraft === null) {
    throw new Error(`R3-022 structured draft failed: ${created.status}`);
  }
  const quoteId = created.quote.id;
  const structuredRevision = created.quote.currentDraft.revision;
  const structured = createStructuredQuoteRepository(sql);
  const saved = await structured.saveDraft({
    actorUserId: input.providerOwnerId,
    commandId: randomUUID(),
    content: structuredContent(),
    expectedContentRevision: 0,
    quoteId,
    quoteRevision: structuredRevision,
  });
  if (saved.status !== "SAVED") {
    throw new Error(`R3-022 structured save failed: ${saved.status}`);
  }
  const submitted = await quotes.submit({
    actorUserId: input.providerOwnerId,
    commandId: randomUUID(),
    expectedDraftStateRevision: created.quote.currentDraft.stateRevision,
    expectedSubmittedStateRevision: null,
    quoteId,
    revision: structuredRevision,
  });
  if (!("quote" in submitted) || submitted.status !== "APPLIED") {
    throw new Error(`R3-022 structured submit failed: ${submitted.status}`);
  }
  const revision = await quotes.createRevision({
    actorUserId: input.providerOwnerId,
    authoringMode: "EXTERNAL_PDF",
    commandId: randomUUID(),
    expectedSubmittedStateRevision:
      submitted.quote.currentSubmitted?.stateRevision ?? 0,
    quoteId,
    requestContentRevision: input.requestContentRevision,
    requestVisibleVersion: input.requestVisibleVersion,
  });
  if (!("quote" in revision) || revision.quote.currentDraft === null) {
    throw new Error(`R3-022 external revision failed: ${revision.status}`);
  }
  const externalRevision = revision.quote.currentDraft.revision;
  const replacedPdfAssetId = await createReadyQuotePdf(
    sql,
    input.providerOwnerId,
    quoteId,
    externalRevision,
    "c",
  );
  const currentPdfAssetId = await createReadyQuotePdf(
    sql,
    input.providerOwnerId,
    quoteId,
    externalRevision,
    "d",
  );
  const external = createExternalPdfQuoteRepository(sql);
  const first = await external.saveDraft(
    externalContentInput(
      input.providerOwnerId,
      quoteId,
      externalRevision,
      replacedPdfAssetId,
      0,
    ),
  );
  if (first.status !== "SAVED") {
    throw new Error(`R3-022 first external save failed: ${first.status}`);
  }
  const second = await external.saveDraft(
    externalContentInput(
      input.providerOwnerId,
      quoteId,
      externalRevision,
      currentPdfAssetId,
      first.revision.contentRevision,
    ),
  );
  if (second.status !== "SAVED") {
    throw new Error(
      `R3-022 replacement external save failed: ${second.status}`,
    );
  }
  const externalSubmitted = await quotes.submit({
    actorUserId: input.providerOwnerId,
    commandId: randomUUID(),
    expectedDraftStateRevision: revision.quote.currentDraft.stateRevision,
    expectedSubmittedStateRevision:
      revision.quote.currentSubmitted?.stateRevision ?? null,
    quoteId,
    revision: externalRevision,
  });
  if (externalSubmitted.status !== "APPLIED") {
    throw new Error(
      `R3-022 external submit failed: ${externalSubmitted.status}`,
    );
  }
  return Object.freeze({
    currentPdfAssetId,
    externalRevision,
    quoteId,
    replacedPdfAssetId,
    structuredRevision,
  });
}

function structuredContent() {
  return {
    components: {
      labor: { amountCents: 100_000, description: "R3-022 montáž" },
      material: { amountCents: 40_000, description: "R3-022 materiál" },
      transport: { amountCents: 5_000, description: "R3-022 doprava" },
    },
    conditionalOnInspection: false,
    currency: "EUR" as const,
    depositMode: "NONE" as const,
    estimatedDurationDays: 5,
    estimatedStartOn: "2099-02-01",
    excludedScope: ["R3-022 odvoz odpadu"],
    includedScope: ["R3-022 montáž"],
    materialResponsibility: "MIXED" as const,
    priceBasis: "R3-022 cena za uvedený rozsah",
    priceMode: "FIXED" as const,
    summary: "R3-022 privátna structured ponuka",
    title: "R3-022 privátny názov",
    totalAmountCents: 145_000,
    validUntil: new Date("2099-12-31T00:00:00.000Z"),
    vatStatus: "VAT_INCLUDED" as const,
  };
}

function externalContentInput(
  actorUserId: UserId,
  quoteId: QuoteId,
  quoteRevision: number,
  pdfAssetId: string,
  expectedContentRevision: number,
) {
  return {
    actorUserId,
    commandId: randomUUID(),
    envelope: {
      currency: "EUR" as const,
      priceMode: "FIXED" as const,
      providerConfirmedSummaryMatchesPdf: true as const,
      totalAmountCents: 146_000,
      validUntil: new Date("2099-12-31T00:00:00.000Z"),
      vatStatus: "VAT_INCLUDED" as const,
    },
    expectedContentRevision,
    pdfAssetId,
    quoteId,
    quoteRevision,
  };
}

async function createReadyQuotePdf(
  sql: Sql,
  ownerUserId: UserId,
  quoteId: QuoteId,
  quoteRevision: number,
  hashCharacter: string,
): Promise<string> {
  const assetId = randomUUID();
  const hash = hashCharacter.repeat(64);
  await sql`
    INSERT INTO media_assets (
      id, owner_user_id, uploaded_by_user_id, kind, purpose, status,
      declared_content_type, byte_size, provenance_entity_type,
      provenance_entity_id, provenance_entity_revision
    ) VALUES (
      ${assetId}, ${ownerUserId}, ${ownerUserId}, 'DOCUMENT',
      'QUOTE_DOCUMENT', 'PROCESSING', 'application/pdf', 100,
      'QUOTE_REVISION', ${quoteId}, ${quoteRevision}
    )
  `;
  await sql`
    INSERT INTO media_asset_storage_objects (
      media_asset_id, role, storage_area, storage_key, content_type,
      byte_size, content_sha256
    ) VALUES (
      ${assetId}, 'CANONICAL', 'private',
      ${`private/2099/01/${randomUUID()}`}, 'application/pdf', 100, ${hash}
    )
  `;
  await sql`
    UPDATE media_assets SET status = 'READY', ready_at = clock_timestamp(),
      status_changed_at = clock_timestamp(), updated_at = clock_timestamp(),
      document_page_count = 1, document_content_sha256 = ${hash},
      malware_scan_verdict = 'CLEAN', malware_scanned_at = clock_timestamp(),
      malware_scanner_engine = 'r3-022-test',
      malware_scanner_engine_version = '1', malware_signature_version = '1'
    WHERE id = ${assetId}
  `;
  return assetId;
}
