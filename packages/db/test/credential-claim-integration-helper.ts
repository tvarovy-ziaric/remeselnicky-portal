import { createHash, randomUUID } from "node:crypto";

import {
  createAdminAccessService,
  type PrivilegedActor,
} from "@portal/admin-auth";
import type {
  CredentialClaimId,
  CraftsmanProfessionId,
  CraftsmanProfileId,
  UserId,
} from "@portal/domain";
import type { ServerMediaProvenance } from "@portal/media";
import type { Sql } from "postgres";
import { expect } from "vitest";

import { createAdminAccessRepository } from "../src/admin-auth-repository.js";
import {
  createCredentialClaimRepository,
  createCredentialReviewService,
} from "../src/credential-claim-repository.js";
import { createCraftsmanProfessionRepository } from "../src/craftsman-profession-repository.js";
import { createMediaRepository } from "../src/media-repository.js";
import type { CreateProcessingMediaAssetInput } from "../src/media-repository.js";

/** Runs inside the one clean-migration integration test to avoid migration races. */
export async function runCredentialClaimIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const fixture = await createFixture(sql);
  const repository = createCredentialClaimRepository(sql);
  const claimId = randomUUID() as CredentialClaimId;
  const createCommand = {
    actorUserId: fixture.ownerId,
    claimId,
    commandId: randomUUID(),
    craftsmanProfessionId: fixture.professionId,
    craftsmanProfileId: fixture.profileId,
    credentialTypeCode: "test.required-license",
    expiresOn: "2032-12-31",
  } as const;

  const concurrentCreate = await Promise.all([
    repository.create(createCommand),
    repository.create(createCommand),
  ]);
  expect(concurrentCreate.map(({ status }) => status).sort()).toEqual([
    "APPLIED",
    "DEDUPLICATED",
  ]);
  const created = concurrentCreate.find(({ status }) => status === "APPLIED");
  if (created?.status !== "APPLIED")
    throw new Error("Expected credential claim creation.");
  expect(created.claim).toMatchObject({
    evidence: [],
    evidenceRequirement: "REQUIRED",
    state: "PENDING",
  });
  await expect(
    repository.prepareEvidenceUpload({
      actorUserId: fixture.nonOwnerId,
      claimId,
      craftsmanProfileId: fixture.profileId,
      expectedRevision: 1,
      mediaKind: "DOCUMENT",
    }),
  ).resolves.toEqual({ status: "PROFILE_UNAVAILABLE" });
  await expect(
    repository.prepareEvidenceUpload({
      actorUserId: fixture.ownerId,
      claimId,
      craftsmanProfileId: fixture.profileId,
      expectedRevision: 99,
      mediaKind: "DOCUMENT",
    }),
  ).resolves.toEqual({ status: "STALE_REVISION" });

  await expect(
    repository.create({
      ...createCommand,
      actorUserId: fixture.nonOwnerId,
      commandId: randomUUID(),
    }),
  ).resolves.toEqual({ status: "PROFILE_UNAVAILABLE" });

  const reviewService = createCredentialReviewService({
    adminAccess: createAdminAccessService({
      challengeTtlMs: 60_000,
      mfaProvider: unusableMfaProvider,
      privilegedSessionTtlMs: 3_600_000,
      reauthenticationMaxAgeMs: 900_000,
      repository: createAdminAccessRepository(sql),
    }),
    repository,
  });
  await expect(
    reviewService.review({
      actorUserId: fixture.adminId,
      command: {
        claimId,
        commandId: randomUUID(),
        decision: "APPROVE",
        expectedRevision: 1,
      },
      privilegedSessionId: fixture.adminSessionId,
    }),
  ).resolves.toEqual({ status: "REQUIRED_EVIDENCE_MISSING" });

  const uploadPreparation = await repository.prepareEvidenceUpload({
    actorUserId: fixture.ownerId,
    claimId,
    craftsmanProfileId: fixture.profileId,
    expectedRevision: 1,
    mediaKind: "DOCUMENT",
  });
  if (uploadPreparation.status !== "READY") {
    throw new Error("Expected trusted credential upload preparation.");
  }
  const mediaAssetId = await makeReadyCredentialDocument(sql, {
    ownerId: fixture.ownerId,
    provenance: uploadPreparation.provenance,
  });
  const attachCommand = {
    actorUserId: fixture.ownerId,
    claimId,
    commandId: randomUUID(),
    craftsmanProfileId: fixture.profileId,
    expectedRevision: 1,
    mediaAssetId,
  } as const;
  await expect(repository.attachEvidence(attachCommand)).resolves.toMatchObject(
    {
      claim: {
        evidence: [{ mediaAssetId, mediaKind: "DOCUMENT" }],
        revision: 2,
      },
      status: "APPLIED",
    },
  );
  await expect(repository.attachEvidence(attachCommand)).resolves.toMatchObject(
    {
      claim: { revision: 2 },
      status: "DEDUPLICATED",
    },
  );

  const approveCommand = {
    claimId,
    commandId: randomUUID(),
    decision: "APPROVE" as const,
    expectedRevision: 2,
  };
  const concurrentApproval = await Promise.all([
    reviewService.review({
      actorUserId: fixture.adminId,
      command: approveCommand,
      privilegedSessionId: fixture.adminSessionId,
    }),
    reviewService.review({
      actorUserId: fixture.adminId,
      command: approveCommand,
      privilegedSessionId: fixture.adminSessionId,
    }),
  ]);
  expect(concurrentApproval.map(({ status }) => status).sort()).toEqual([
    "APPLIED",
    "DEDUPLICATED",
  ]);
  const approved = concurrentApproval.find(
    ({ status }) => status === "APPLIED",
  );
  if (approved?.status !== "APPLIED")
    throw new Error("Expected credential approval.");
  expect(approved.claim).toMatchObject({ revision: 3, state: "APPROVED" });
  expect(approved.claim).not.toHaveProperty("payloadFingerprint");
  expect(approved.claim.evidence[0]).not.toHaveProperty("storageKey");
  await expect(
    repository.prepareEvidenceUpload({
      actorUserId: fixture.ownerId,
      claimId,
      craftsmanProfileId: fixture.profileId,
      expectedRevision: 3,
      mediaKind: "IMAGE",
    }),
  ).resolves.toEqual({ status: "CLAIM_NOT_PENDING" });

  await expect(
    reviewService.review({
      actorUserId: fixture.adminId,
      command: {
        claimId,
        commandId: randomUUID(),
        decision: "REVOKE",
        expectedRevision: 3,
        reason: "Platnosť oprávnenia bola manuálne odvolaná.",
        reasonCategory: "EXPIRED_OR_INVALID",
      },
      privilegedSessionId: fixture.adminSessionId,
    }),
  ).resolves.toMatchObject({
    claim: { revision: 4, state: "REVOKED" },
    status: "APPLIED",
  });

  const [counts] = await sql<
    {
      readonly auditCount: number;
      readonly decisionCount: number;
      readonly revisionCount: number;
    }[]
  >`
    SELECT
      (SELECT count(*)::integer FROM audit_events WHERE target_type = 'CREDENTIAL_CLAIM' AND target_id = ${claimId}) AS "auditCount",
      (SELECT count(*)::integer FROM credential_claim_decisions WHERE claim_id = ${claimId}) AS "decisionCount",
      (SELECT count(*)::integer FROM credential_claim_revisions WHERE claim_id = ${claimId}) AS "revisionCount"
  `;
  expect(counts).toEqual({ auditCount: 2, decisionCount: 2, revisionCount: 4 });

  await runRevokedEvidenceNegative(sql, fixture, reviewService);
  await runAttachRevocationRace(sql, fixture);
  await runRawSqlNegatives(sql, fixture, claimId, mediaAssetId);
  await runOwnerSuspensionRace(sql, fixture.professionTaxonomy);
  await runAdminRevocationRaces(sql, fixture, repository);
}

async function runAttachRevocationRace(
  sql: Sql,
  fixture: Awaited<ReturnType<typeof createFixture>>,
): Promise<void> {
  const repository = createCredentialClaimRepository(sql);
  const claimId = randomUUID() as CredentialClaimId;
  await repository.create({
    actorUserId: fixture.ownerId,
    claimId,
    commandId: randomUUID(),
    craftsmanProfessionId: fixture.professionId,
    craftsmanProfileId: fixture.profileId,
    credentialTypeCode: "test.required-license",
    expiresOn: null,
  });
  const preparation = await repository.prepareEvidenceUpload({
    actorUserId: fixture.ownerId,
    claimId,
    craftsmanProfileId: fixture.profileId,
    expectedRevision: 1,
    mediaKind: "DOCUMENT",
  });
  if (preparation.status !== "READY")
    throw new Error("Expected race upload preparation.");
  const mediaAssetId = await makeReadyCredentialDocument(sql, {
    ownerId: fixture.ownerId,
    provenance: preparation.provenance,
  });
  const [attach] = await Promise.all([
    repository.attachEvidence({
      actorUserId: fixture.ownerId,
      claimId,
      commandId: randomUUID(),
      craftsmanProfileId: fixture.profileId,
      expectedRevision: 1,
      mediaAssetId,
    }),
    sql.begin(async (transaction) => {
      await transaction`
        SELECT id FROM media_asset_storage_objects
        WHERE media_asset_id = ${mediaAssetId} AND role = 'CANONICAL' FOR UPDATE
      `;
      return transaction`
        UPDATE media_asset_storage_objects SET revoked_at = clock_timestamp()
        WHERE media_asset_id = ${mediaAssetId} AND role = 'CANONICAL'
      `;
    }),
  ]);
  expect(["APPLIED", "EVIDENCE_UNAVAILABLE"]).toContain(attach.status);
  if (attach.status === "APPLIED") {
    const [ordering] = await sql<
      { readonly attachedAt: Date; readonly revokedAt: Date }[]
    >`
      SELECT evidence.attached_at AS "attachedAt", object.revoked_at AS "revokedAt"
      FROM credential_claim_evidence evidence
      JOIN media_asset_storage_objects object ON object.media_asset_id = evidence.media_asset_id
      WHERE evidence.claim_id = ${claimId} AND object.role = 'CANONICAL'
    `;
    if (ordering === undefined)
      throw new Error("Expected attach race ordering.");
    expect(ordering.attachedAt.valueOf()).toBeLessThanOrEqual(
      ordering.revokedAt.valueOf(),
    );
  }
}

async function createFixture(sql: Sql) {
  const [professionTaxonomy] = await sql<
    { readonly professionCode: string; readonly releaseId: string }[]
  >`
    SELECT profession.profession_code AS "professionCode", profession.release_id AS "releaseId"
    FROM profession_taxonomy_activation_events activation
    JOIN taxonomy_professions profession ON profession.release_id = activation.release_id
    JOIN profession_taxonomy_releases release ON release.release_id = profession.release_id
    WHERE profession.state = 'ACTIVE' AND release.content_class = 'CANONICAL'
      AND release.review_state = 'HUMAN_REVIEW_APPROVED'
    ORDER BY activation.activation_sequence DESC, profession.profession_code LIMIT 1
  `;
  if (professionTaxonomy === undefined)
    throw new Error("Credential helper requires taxonomy fixture.");
  const [owner] = await sql<
    { readonly id: UserId }[]
  >`INSERT INTO users DEFAULT VALUES RETURNING id`;
  const [nonOwner] = await sql<
    { readonly id: UserId }[]
  >`INSERT INTO users DEFAULT VALUES RETURNING id`;
  const [admin] = await sql<
    { readonly id: UserId }[]
  >`INSERT INTO users DEFAULT VALUES RETURNING id`;
  if (owner === undefined || nonOwner === undefined || admin === undefined)
    throw new Error("Expected users.");
  const [profile] = await sql<{ readonly id: CraftsmanProfileId }[]>`
    INSERT INTO craftsman_profiles (owner_user_id, profile_type) VALUES (${owner.id}, 'INDIVIDUAL') RETURNING id
  `;
  if (profile === undefined) throw new Error("Expected profile.");
  const professionId = randomUUID() as CraftsmanProfessionId;
  await expect(
    createCraftsmanProfessionRepository(sql).assign({
      actorUserId: owner.id,
      commandId: randomUUID(),
      craftsmanProfessionId: professionId,
      craftsmanProfileId: profile.id,
      declaredLevel: "BEGINNER",
      professionCode: professionTaxonomy.professionCode,
      taxonomyReleaseId: professionTaxonomy.releaseId,
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });
  await sql`
    INSERT INTO credential_type_policies (code, evidence_requirement, source_reference)
    VALUES
      ('test.required-license', 'REQUIRED', 'test:r1-009-required'),
      ('test.optional-card', 'OPTIONAL', 'test:r1-009-optional')
  `;
  const adminSessionId = `credential-review-${randomUUID()}`;
  const sessionHash = digest(adminSessionId);
  const [factor] = await sql<{ readonly id: string }[]>`
    INSERT INTO admin_mfa_factors (user_id, kind, credential_reference)
    VALUES (${admin.id}, 'TOTP', ${`test:credential/${randomUUID()}`}) RETURNING id
  `;
  if (factor === undefined) throw new Error("Expected admin factor.");
  await sql`
    INSERT INTO auth_sessions (session_id_hash, user_id, expires_at)
    VALUES (${sessionHash}, ${admin.id}, clock_timestamp() + interval '1 hour')
  `;
  await sql`
    INSERT INTO admin_role_grants (user_id, role, grant_source, reason)
    VALUES (${admin.id}, 'ADMIN', 'BOOTSTRAP', 'Credential review integration fixture')
  `;
  await sql`
    INSERT INTO admin_privileged_sessions (
      session_id_hash, user_id, mfa_factor_id, mfa_authenticated_at, expires_at
    ) VALUES (
      ${sessionHash}, ${admin.id}, ${factor.id}, CURRENT_TIMESTAMP,
      clock_timestamp() + interval '1 hour'
    )
  `;
  return {
    adminId: admin.id,
    adminSessionId,
    nonOwnerId: nonOwner.id,
    ownerId: owner.id,
    professionId,
    professionTaxonomy,
    profileId: profile.id,
    sessionHash,
  };
}

async function makeReadyCredentialDocument(
  sql: Sql,
  input: {
    readonly ownerId: UserId;
    readonly provenance: ServerMediaProvenance;
  },
): Promise<string> {
  const media = createMediaRepository(sql);
  const asset = await media.createProcessingAsset({
    byteSize: 128,
    declaredContentType: "application/pdf",
    displayFilename: "credential.pdf",
    kind: "DOCUMENT",
    ownerUserId: input.ownerId,
    provenanceEntityId: input.provenance.entityId,
    provenanceEntityRevision: input.provenance.entityRevision,
    provenanceEntityType: input.provenance.entityType,
    purpose: "CREDENTIAL_DOCUMENT",
    storageObject: { area: "private", key: privateKey() },
    uploaderUserId: input.ownerId,
  });
  const contentHash = digest(`credential-content-${asset.id}`);
  await expect(
    media.completeDocumentProcessing({
      assetId: asset.id,
      canonical: {
        byteSize: 128,
        contentSha256: contentHash,
        contentType: "application/pdf",
        role: "CANONICAL",
        storageObject: { area: "private", key: privateKey() },
      },
      pageCount: 1,
      scan: {
        assurance: "ACTIVE",
        contentSha256: contentHash,
        engine: "test-scanner",
        engineVersion: "1.0.0",
        scannedAt: new Date(),
        signatureVersion: "20260914.1",
        verdict: "CLEAN",
      },
    }),
  ).resolves.toEqual({ transition: "UPDATED" });
  return asset.id;
}

async function runRevokedEvidenceNegative(
  sql: Sql,
  fixture: Awaited<ReturnType<typeof createFixture>>,
  reviewService: ReturnType<typeof createCredentialReviewService>,
): Promise<void> {
  const repository = createCredentialClaimRepository(sql);
  const claimId = randomUUID() as CredentialClaimId;
  await repository.create({
    actorUserId: fixture.ownerId,
    claimId,
    commandId: randomUUID(),
    craftsmanProfessionId: fixture.professionId,
    craftsmanProfileId: fixture.profileId,
    credentialTypeCode: "test.required-license",
    expiresOn: null,
  });
  const preparation = await repository.prepareEvidenceUpload({
    actorUserId: fixture.ownerId,
    claimId,
    craftsmanProfileId: fixture.profileId,
    expectedRevision: 1,
    mediaKind: "DOCUMENT",
  });
  if (preparation.status !== "READY")
    throw new Error("Expected upload preparation.");
  const mediaAssetId = await makeReadyCredentialDocument(sql, {
    ownerId: fixture.ownerId,
    provenance: preparation.provenance,
  });
  await repository.attachEvidence({
    actorUserId: fixture.ownerId,
    claimId,
    commandId: randomUUID(),
    craftsmanProfileId: fixture.profileId,
    expectedRevision: 1,
    mediaAssetId,
  });
  await sql`
    UPDATE media_asset_storage_objects SET revoked_at = clock_timestamp()
    WHERE media_asset_id = ${mediaAssetId} AND role = 'CANONICAL'
  `;
  await expect(
    reviewService.review({
      actorUserId: fixture.adminId,
      command: {
        claimId,
        commandId: randomUUID(),
        decision: "APPROVE",
        expectedRevision: 2,
      },
      privilegedSessionId: fixture.adminSessionId,
    }),
  ).resolves.toEqual({ status: "REQUIRED_EVIDENCE_MISSING" });
}

async function runRawSqlNegatives(
  sql: Sql,
  fixture: Awaited<ReturnType<typeof createFixture>>,
  claimId: CredentialClaimId,
  mediaAssetId: string,
): Promise<void> {
  await expect(
    sql`UPDATE credential_type_policies SET active = false WHERE code = 'test.required-license'`,
  ).rejects.toThrow(/server-installed and immutable/u);
  await expect(
    sql`DELETE FROM credential_claims WHERE id = ${claimId}`,
  ).rejects.toThrow(/history cannot be hard-deleted/u);
  await expect(
    sql`UPDATE credential_claim_decisions SET reason = 'Tampered decision' WHERE claim_id = ${claimId}`,
  ).rejects.toThrow(/decisions are append-only/u);
  await expect(sql`
    INSERT INTO credential_claim_commands (
      command_id, command_kind, claim_id, craftsman_profile_id, actor_user_id,
      actor_privileged_session_hash, expected_revision, reason_category, reason,
      payload_fingerprint, audit_event_id
    ) VALUES (
      ${randomUUID()}, 'REVOKE', ${claimId}, ${fixture.profileId}, ${fixture.nonOwnerId},
      ${"f".repeat(64)}, 4, 'OTHER', 'Unauthorized credential revocation',
      ${"a".repeat(64)}, ${randomUUID()}
    )
  `).rejects.toThrow(/MFA-backed credential review capability required/u);
  await expect(sql`
    UPDATE media_assets SET owner_user_id = ${fixture.nonOwnerId} WHERE id = ${mediaAssetId}
  `).rejects.toThrow(/identity and provenance are immutable/u);
}

async function runOwnerSuspensionRace(
  sql: Sql,
  taxonomy: { readonly professionCode: string; readonly releaseId: string },
): Promise<void> {
  const [owner] = await sql<
    { readonly id: UserId }[]
  >`INSERT INTO users DEFAULT VALUES RETURNING id`;
  if (owner === undefined) throw new Error("Expected race owner.");
  const [profile] = await sql<{ readonly id: CraftsmanProfileId }[]>`
    INSERT INTO craftsman_profiles (owner_user_id, profile_type) VALUES (${owner.id}, 'INDIVIDUAL') RETURNING id
  `;
  if (profile === undefined) throw new Error("Expected race profile.");
  const professionId = randomUUID() as CraftsmanProfessionId;
  await createCraftsmanProfessionRepository(sql).assign({
    actorUserId: owner.id,
    commandId: randomUUID(),
    craftsmanProfessionId: professionId,
    craftsmanProfileId: profile.id,
    declaredLevel: "BEGINNER",
    professionCode: taxonomy.professionCode,
    taxonomyReleaseId: taxonomy.releaseId,
  });
  const claimId = randomUUID() as CredentialClaimId;
  const [result] = await Promise.all([
    createCredentialClaimRepository(sql).create({
      actorUserId: owner.id,
      claimId,
      commandId: randomUUID(),
      craftsmanProfessionId: professionId,
      craftsmanProfileId: profile.id,
      credentialTypeCode: "test.required-license",
      expiresOn: null,
    }),
    sql.begin(async (transaction) => {
      await transaction`SELECT id FROM users WHERE id = ${owner.id} FOR UPDATE`;
      return transaction`
        UPDATE users SET account_state = 'SUSPENDED',
          account_state_changed_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE id = ${owner.id}
      `;
    }),
  ]);
  expect(["APPLIED", "PROFILE_UNAVAILABLE"]).toContain(result.status);
  await expect(
    createCredentialClaimRepository(sql).prepareEvidenceUpload({
      actorUserId: owner.id,
      claimId,
      craftsmanProfileId: profile.id,
      expectedRevision: 1,
      mediaKind: "DOCUMENT",
    }),
  ).resolves.toEqual({ status: "PROFILE_UNAVAILABLE" });
}

async function runAdminRevocationRaces(
  sql: Sql,
  fixture: Awaited<ReturnType<typeof createFixture>>,
  repository: ReturnType<typeof createCredentialClaimRepository>,
): Promise<void> {
  const actor: PrivilegedActor = {
    capabilities: new Set(["admin.credentials.review"]),
    mfaAuthenticatedAt: new Date(),
    roles: ["ADMIN"],
    userId: fixture.adminId,
  };
  const claimId = randomUUID() as CredentialClaimId;
  await repository.create({
    actorUserId: fixture.ownerId,
    claimId,
    commandId: randomUUID(),
    craftsmanProfessionId: fixture.professionId,
    craftsmanProfileId: fixture.profileId,
    credentialTypeCode: "test.optional-card",
    expiresOn: null,
  });
  const [review, , read] = await Promise.all([
    repository.reviewAuthorized({
      actor,
      command: {
        claimId,
        commandId: randomUUID(),
        decision: "APPROVE",
        expectedRevision: 1,
      },
      privilegedSessionIdHash: fixture.sessionHash,
    }),
    sql.begin(async (transaction) => {
      await transaction`
        SELECT id FROM admin_role_grants
        WHERE user_id = ${fixture.adminId} AND revoked_at IS NULL FOR UPDATE
      `;
      return transaction`
        UPDATE admin_role_grants SET revoked_at = clock_timestamp()
        WHERE user_id = ${fixture.adminId} AND revoked_at IS NULL
      `;
    }),
    repository.listPendingAuthorized({
      actor,
      privilegedSessionIdHash: fixture.sessionHash,
    }),
  ]);
  expect(["APPLIED", "CLAIM_UNAVAILABLE"]).toContain(review.status);
  expect(Array.isArray(read)).toBe(true);
  if (review.status === "APPLIED") {
    const [linearization] = await sql<
      { readonly decisionAt: Date; readonly revokedAt: Date }[]
    >`
      SELECT decision.occurred_at AS "decisionAt", role.revoked_at AS "revokedAt"
      FROM credential_claim_decisions decision
      JOIN admin_role_grants role ON role.user_id = ${fixture.adminId}
      WHERE decision.claim_id = ${claimId} AND role.revoked_at IS NOT NULL
    `;
    if (linearization === undefined)
      throw new Error("Expected review race timestamps.");
    expect(linearization.decisionAt.valueOf()).toBeLessThanOrEqual(
      linearization.revokedAt.valueOf(),
    );
  }
  await expect(
    repository.listPendingAuthorized({
      actor,
      privilegedSessionIdHash: fixture.sessionHash,
    }),
  ).resolves.toEqual([]);
}

const unusableMfaProvider = Object.freeze({
  begin(): Promise<never> {
    return Promise.reject(new Error("MFA fixture does not create challenges."));
  },
  verify(): Promise<boolean> {
    return Promise.resolve(false);
  },
});

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function privateKey(): CreateProcessingMediaAssetInput["storageObject"]["key"] {
  const now = new Date();
  return `private/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${randomUUID()}` as CreateProcessingMediaAssetInput["storageObject"]["key"];
}
