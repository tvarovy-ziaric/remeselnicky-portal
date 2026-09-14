import { createHash, randomUUID } from "node:crypto";

import { createAdminAccessService } from "@portal/admin-auth";
import type {
  CredentialClaimId,
  CraftsmanProfessionId,
  CraftsmanProfileId,
  MunicipalityCode,
  UserId,
} from "@portal/domain";
import {
  createCredentialQualificationGate,
  createCredentialQualificationPolicyService,
  type CredentialQualificationPolicyEntrySeed,
} from "@portal/search";
import type { Sql } from "postgres";
import { expect } from "vitest";

import { createAdminAccessRepository } from "../src/admin-auth-repository.js";
import {
  createCredentialClaimRepository,
  createCredentialReviewService,
} from "../src/credential-claim-repository.js";
import { createCredentialQualificationRepository } from "../src/credential-qualification-repository.js";
import { createCraftsmanProfessionRepository } from "../src/craftsman-profession-repository.js";
import { createCraftsmanPublicationRepository } from "../src/craftsman-publication-repository.js";
import { createCraftsmanServiceAreaRepository } from "../src/craftsman-service-area-repository.js";

const codes = Object.freeze({
  approved: "test.r2006-approved",
  expired: "test.r2006-expired",
  mismatchedApproved: "test.r2006-other-approved",
  mismatchedTarget: "test.r2006-mismatch-target",
  optional: "test.r2006-optional",
  pending: "test.r2006-pending",
  rejected: "test.r2006-rejected",
  revoked: "test.r2006-revoked",
});
const unknownCredentialTypeCode = ["test.r2006", "unknown"].join("-");

interface AdminFixture {
  readonly rawSessionId: string;
  readonly sessionDigest: string;
  readonly userId: UserId;
}

interface ProfileFixture {
  readonly ownerId: UserId;
  readonly professionCode: string;
  readonly professionId: CraftsmanProfessionId;
  readonly profileId: CraftsmanProfileId;
  publicationRevision: number;
  readonly taxonomyReleaseId: string;
}

/** Standalone R2-006 live-PostgreSQL assertions; never wired by this owner. */
export async function runCredentialQualificationIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const taxonomy = await activeProfession(sql);
  const admin = await createAdmin(sql);
  const profile = await createPublicProfile(sql, admin, taxonomy);
  await installCredentialTypes(sql);

  const repository = createCredentialQualificationRepository(sql);
  const policy = createCredentialQualificationPolicyService({
    persistence: repository,
  });
  const releaseId = randomUUID();
  const activationId = randomUUID();
  await expect(
    policy.installRelease({
      entries: policyEntries(profile.professionCode),
      releaseId,
      reviewReference: "legal-review:R2-006-synthetic-only",
      supersedesReleaseId: null,
      taxonomyReleaseId: profile.taxonomyReleaseId,
      version: 1,
    }),
  ).resolves.toBe("CREATED");
  const activation = {
    activationId,
    actorReference: "deployment:R2-006-fixture",
    previousReleaseId: null,
    releaseId,
    reviewReference: "legal-review:R2-006-synthetic-only",
  } as const;
  const concurrentActivation = await Promise.all([
    policy.activateRelease(activation),
    policy.activateRelease(activation),
  ]);
  expect(concurrentActivation.sort()).toEqual([false, true]);
  await expect(policy.activateRelease(activation)).resolves.toBe(false);
  await expect(
    policy.activateRelease({
      ...activation,
      actorReference: "deployment:R2-006-conflict",
    }),
  ).rejects.toThrow(/conflicts/u);

  const gate = createCredentialQualificationGate(repository);
  await expectGate(gate, profile, codes.approved, false, "REQUIRED");
  await expectGate(gate, profile, codes.optional, true, "OPTIONAL", false);

  const claims = createCredentialClaimRepository(sql);
  const review = createCredentialReviewService({
    adminAccess: createAdminAccessService({
      challengeTtlMs: 60_000,
      mfaProvider: unusableMfaProvider,
      privilegedSessionTtlMs: 3_600_000,
      reauthenticationMaxAgeMs: 900_000,
      repository: createAdminAccessRepository(sql),
    }),
    repository: claims,
  });

  await createClaim(sql, profile, admin, codes.approved, "APPROVED", review);
  await createClaim(sql, profile, admin, codes.pending, "PENDING", review);
  await createClaim(sql, profile, admin, codes.rejected, "REJECTED", review);
  await createClaim(sql, profile, admin, codes.revoked, "REVOKED", review);
  await createClaim(
    sql,
    profile,
    admin,
    codes.expired,
    "APPROVED",
    review,
    "2000-01-01",
  );
  await createClaim(
    sql,
    profile,
    admin,
    codes.mismatchedApproved,
    "APPROVED",
    review,
  );

  await expectGate(gate, profile, codes.approved, true, "REQUIRED", true);
  for (const code of [
    codes.pending,
    codes.rejected,
    codes.revoked,
    codes.expired,
    codes.mismatchedTarget,
  ]) {
    await expectGate(gate, profile, code, false, "REQUIRED", false);
  }
  await expect(
    gate.evaluate({
      craftsmanProfileId: profile.profileId,
      credentialTypeCode: unknownCredentialTypeCode,
      professionCode: profile.professionCode,
    }),
  ).resolves.toEqual({ eligible: false, status: "UNAVAILABLE" });

  await assertPublicEligibilityGates(sql, gate, profile);
  await assertRawPolicyAndPrivacyGuards(sql, profile, releaseId, activationId);
}

async function createClaim(
  sql: Sql,
  profile: ProfileFixture,
  admin: AdminFixture,
  credentialTypeCode: string,
  finalState: "PENDING" | "APPROVED" | "REJECTED" | "REVOKED",
  review: ReturnType<typeof createCredentialReviewService>,
  expiresOn: string | null = null,
): Promise<void> {
  const claims = createCredentialClaimRepository(sql);
  const claimId = randomUUID() as CredentialClaimId;
  const created = await claims.create({
    actorUserId: profile.ownerId,
    claimId,
    commandId: randomUUID(),
    craftsmanProfessionId: profile.professionId,
    craftsmanProfileId: profile.profileId,
    credentialTypeCode,
    expiresOn,
  });
  expect(created.status).toBe("APPLIED");
  if (finalState === "PENDING") return;
  if (finalState === "REJECTED") {
    await expect(
      review.review({
        actorUserId: admin.userId,
        command: {
          claimId,
          commandId: randomUUID(),
          decision: "REJECT",
          expectedRevision: 1,
          reason: "Syntetický claim bol zamietnutý pre gate test.",
          reasonCategory: "INSUFFICIENT_EVIDENCE",
        },
        privilegedSessionId: admin.rawSessionId,
      }),
    ).resolves.toMatchObject({ status: "APPLIED" });
    return;
  }
  await expect(
    review.review({
      actorUserId: admin.userId,
      command: {
        claimId,
        commandId: randomUUID(),
        decision: "APPROVE",
        expectedRevision: 1,
      },
      privilegedSessionId: admin.rawSessionId,
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });
  if (finalState === "REVOKED") {
    await expect(
      review.review({
        actorUserId: admin.userId,
        command: {
          claimId,
          commandId: randomUUID(),
          decision: "REVOKE",
          expectedRevision: 2,
          reason: "Syntetický claim bol odvolaný pre gate test.",
          reasonCategory: "EXPIRED_OR_INVALID",
        },
        privilegedSessionId: admin.rawSessionId,
      }),
    ).resolves.toMatchObject({ status: "APPLIED" });
  }
}

async function expectGate(
  gate: ReturnType<typeof createCredentialQualificationGate>,
  profile: ProfileFixture,
  credentialTypeCode: string,
  eligible: boolean,
  requirement: "REQUIRED" | "OPTIONAL",
  currentApproved = false,
): Promise<void> {
  const result = await gate.evaluate({
    craftsmanProfileId: profile.profileId,
    credentialTypeCode,
    professionCode: profile.professionCode,
  });
  expect(result).toMatchObject({
    currentApproved,
    eligible,
    requirement,
    status: "OK",
  });
  expect(JSON.stringify(result)).not.toMatch(
    /claim|evidence|media|reviewer|reviewReason|storage|sha256|owner|userId/iu,
  );
}

async function assertPublicEligibilityGates(
  sql: Sql,
  gate: ReturnType<typeof createCredentialQualificationGate>,
  profile: ProfileFixture,
): Promise<void> {
  const publication = createCraftsmanPublicationRepository(sql);
  const hidden = await publication.setOwnerVisibility({
    actorUserId: profile.ownerId,
    commandId: randomUUID(),
    craftsmanProfileId: profile.profileId,
    expectedRevision: profile.publicationRevision,
    visibility: "HIDDEN",
  });
  expect(hidden.status).toBe("APPLIED");
  if (hidden.status !== "APPLIED") throw new Error("Expected profile hide.");
  profile.publicationRevision = hidden.publication.revision;
  await expect(
    gate.evaluate({
      craftsmanProfileId: profile.profileId,
      credentialTypeCode: codes.approved,
      professionCode: profile.professionCode,
    }),
  ).resolves.toEqual({ eligible: false, status: "UNAVAILABLE" });
  const shown = await publication.setOwnerVisibility({
    actorUserId: profile.ownerId,
    commandId: randomUUID(),
    craftsmanProfileId: profile.profileId,
    expectedRevision: profile.publicationRevision,
    visibility: "PUBLIC",
  });
  expect(shown.status).toBe("APPLIED");
  if (shown.status === "APPLIED")
    profile.publicationRevision = shown.publication.revision;

  await setAccountState(sql, profile.ownerId, "SUSPENDED");
  try {
    await expect(
      gate.evaluate({
        craftsmanProfileId: profile.profileId,
        credentialTypeCode: codes.approved,
        professionCode: profile.professionCode,
      }),
    ).resolves.toEqual({ eligible: false, status: "UNAVAILABLE" });
  } finally {
    await setAccountState(sql, profile.ownerId, "ACTIVE");
  }
}

async function assertRawPolicyAndPrivacyGuards(
  sql: Sql,
  profile: ProfileFixture,
  releaseId: string,
  activationId: string,
): Promise<void> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT * FROM evaluate_craftsman_credential_qualification(
      ${profile.profileId}, ${profile.professionCode}, ${codes.approved}
    )
  `;
  expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
    "current_approved",
    "eligibility",
    "reason_code",
    "requirement",
  ]);
  expect(JSON.stringify(rows)).not.toMatch(
    /claim|evidence|media|reviewer|storage|sha256|owner|user_id/iu,
  );

  await expect(sql`
    INSERT INTO credential_qualification_policy_entries (
      release_id, taxonomy_release_id, profession_code,
      credential_type_code, requirement
    ) VALUES (
      ${releaseId}, ${profile.taxonomyReleaseId}, ${profile.professionCode},
      ${codes.optional}, 'OPTIONAL'
    )
  `).rejects.toThrow(/atomically|sealed/u);
  await expect(sql`
    UPDATE credential_qualification_policy_activation_events
    SET review_reference = 'legal-review:R2-006-tampered'
    WHERE activation_id = ${activationId}
  `).rejects.toThrow(/append-only/u);

  await expect(
    sql.begin(async (transaction) => {
      const skippedRelease = randomUUID();
      await transaction`
        INSERT INTO credential_qualification_policy_releases (
          release_id, version, taxonomy_release_id, content_class,
          review_state, review_reference, supersedes_release_id, checksum_sha256
        ) VALUES (
          ${skippedRelease}, 3, ${profile.taxonomyReleaseId}, 'CANONICAL',
          'HUMAN_REVIEW_APPROVED', 'legal-review:R2-006-skipped',
          ${releaseId}, ${"a".repeat(64)}
        )
      `;
      await transaction`
        INSERT INTO credential_qualification_policy_entries (
          release_id, taxonomy_release_id, profession_code,
          credential_type_code, requirement
        ) VALUES (
          ${skippedRelease}, ${profile.taxonomyReleaseId},
          ${profile.professionCode}, ${codes.approved}, 'REQUIRED'
        )
      `;
      return transaction`
        INSERT INTO credential_qualification_policy_activation_events (
          activation_id, release_id, previous_release_id,
          actor_reference, review_reference
        ) VALUES (
          ${randomUUID()}, ${skippedRelease}, ${releaseId},
          'deployment:R2-006-skipped', 'legal-review:R2-006-skipped'
        )
      `;
    }),
  ).rejects.toThrow(/contiguous/u);

  await expect(
    sql.begin(async (transaction) => {
      const placeholderRelease = randomUUID();
      await transaction`
        INSERT INTO credential_qualification_policy_releases (
          release_id, version, taxonomy_release_id, content_class,
          review_state, supersedes_release_id, checksum_sha256
        ) VALUES (
          ${placeholderRelease}, 2, ${profile.taxonomyReleaseId}, 'PLACEHOLDER',
          'HUMAN_REVIEW_PENDING', ${releaseId}, ${"b".repeat(64)}
        )
      `;
      await transaction`
        INSERT INTO credential_qualification_policy_entries (
          release_id, taxonomy_release_id, profession_code,
          credential_type_code, requirement
        ) VALUES (
          ${placeholderRelease}, ${profile.taxonomyReleaseId},
          ${profile.professionCode}, ${codes.approved}, 'REQUIRED'
        )
      `;
      return transaction`
        INSERT INTO credential_qualification_policy_activation_events (
          activation_id, release_id, previous_release_id,
          actor_reference, review_reference
        ) VALUES (
          ${randomUUID()}, ${placeholderRelease}, ${releaseId},
          'deployment:R2-006-placeholder', 'legal-review:R2-006-placeholder'
        )
      `;
    }),
  ).rejects.toThrow(/expert-reviewed canonical/u);
}

function policyEntries(
  professionCode: string,
): readonly CredentialQualificationPolicyEntrySeed[] {
  return Object.freeze([
    ...Object.values(codes)
      .filter((code) => code !== codes.optional)
      .map((credentialTypeCode) => ({
        credentialTypeCode,
        professionCode,
        requirement: "REQUIRED" as const,
      })),
    {
      credentialTypeCode: codes.optional,
      professionCode,
      requirement: "OPTIONAL",
    },
  ]);
}

async function installCredentialTypes(sql: Sql): Promise<void> {
  for (const code of Object.values(codes)) {
    await sql`
      INSERT INTO credential_type_policies (
        code, evidence_requirement, source_reference
      ) VALUES (${code}, 'OPTIONAL', 'test:r2-006-synthetic')
    `;
  }
}

async function activeProfession(sql: Sql) {
  const [row] = await sql<
    { readonly professionCode: string; readonly releaseId: string }[]
  >`
    SELECT profession.profession_code AS "professionCode",
      profession.release_id AS "releaseId"
    FROM profession_taxonomy_activation_events activation
    JOIN profession_taxonomy_releases release
      ON release.release_id = activation.release_id
    JOIN taxonomy_professions profession
      ON profession.release_id = release.release_id
    WHERE release.content_class = 'CANONICAL'
      AND release.review_state = 'HUMAN_REVIEW_APPROVED'
      AND profession.state = 'ACTIVE'
    ORDER BY activation.activation_sequence DESC, profession.profession_code
    LIMIT 1
  `;
  if (row === undefined) throw new Error("R2-006 requires active taxonomy.");
  return row;
}

async function createPublicProfile(
  sql: Sql,
  admin: AdminFixture,
  taxonomy: Awaited<ReturnType<typeof activeProfession>>,
): Promise<ProfileFixture> {
  const ownerId = await createUser(sql);
  const [profile] = await sql<{ readonly id: CraftsmanProfileId }[]>`
    INSERT INTO craftsman_profiles (
      owner_user_id, profile_type, real_first_name, real_last_name, about,
      identity_verified_at, identity_verification_reference
    ) VALUES (
      ${ownerId}, 'INDIVIDUAL', 'Kvalifikovaný', 'Testovací',
      'Syntetický verejný profil pre credential qualification gate.',
      CURRENT_TIMESTAMP, ${`test:r2-006/${randomUUID()}`}
    ) RETURNING id
  `;
  if (profile === undefined) throw new Error("Expected R2-006 profile.");
  const professionId = randomUUID() as CraftsmanProfessionId;
  await expect(
    createCraftsmanProfessionRepository(sql).assign({
      actorUserId: ownerId,
      commandId: randomUUID(),
      craftsmanProfessionId: professionId,
      craftsmanProfileId: profile.id,
      declaredLevel: "ADVANCED",
      professionCode: taxonomy.professionCode,
      taxonomyReleaseId: taxonomy.releaseId,
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });
  const municipality = await createMunicipality(sql);
  await expect(
    createCraftsmanServiceAreaRepository(sql).replaceOwnedDraft({
      actorUserId: ownerId,
      baseMunicipalityCode: municipality,
      commandId: randomUUID(),
      craftsmanProfileId: profile.id,
      expectedRevision: 0,
      extraMunicipalityCodes: [],
      maximumRadiusKm: null,
      normalRadiusKm: 25,
      travelFeePolicy: null,
      travelFeeThresholdKm: null,
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });
  const publication = createCraftsmanPublicationRepository(sql);
  await publication.submitForReview({
    actorUserId: ownerId,
    commandId: randomUUID(),
    craftsmanProfileId: profile.id,
    expectedRevision: 0,
  });
  await publication.setOwnerVisibility({
    actorUserId: ownerId,
    commandId: randomUUID(),
    craftsmanProfileId: profile.id,
    expectedRevision: 1,
    visibility: "PUBLIC",
  });
  const approved = await publication.approve({
    actorSessionIdDigest: admin.sessionDigest,
    actorUserId: admin.userId,
    commandId: randomUUID(),
    correlationId: randomUUID(),
    craftsmanProfileId: profile.id,
    expectedRevision: 2,
    reason: "R2-006 synthetic qualification profile approval.",
  });
  if (approved.status !== "APPLIED")
    throw new Error("Expected profile approval.");
  return {
    ownerId,
    professionCode: taxonomy.professionCode,
    professionId,
    profileId: profile.id,
    publicationRevision: approved.publication.revision,
    taxonomyReleaseId: taxonomy.releaseId,
  };
}

async function createMunicipality(sql: Sql): Promise<MunicipalityCode> {
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const region = `TEST:R2006:R:${suffix}`;
  const district = `TEST:R2006:D:${suffix}`;
  const municipality = `TEST:R2006:M:${suffix}` as MunicipalityCode;
  await sql`
    INSERT INTO location_regions (code, name_sk, source_reference, source_revision)
    VALUES (${region}, 'Kvalifikačný kraj', 'test-fixture:R2-006', 'synthetic-v1')
  `;
  await sql`
    INSERT INTO location_districts (
      code, region_code, name_sk, source_reference, source_revision
    ) VALUES (
      ${district}, ${region}, 'Kvalifikačný okres',
      'test-fixture:R2-006', 'synthetic-v1'
    )
  `;
  await sql`
    INSERT INTO location_municipalities (
      code, district_code, name_sk, centroid, source_reference, source_revision
    ) VALUES (
      ${municipality}, ${district}, 'Kvalifikačná obec',
      ST_GeogFromText('SRID=4326;POINT(17.1 48.15)'),
      'test-fixture:R2-006', 'synthetic-v1'
    )
  `;
  return municipality;
}

async function createAdmin(sql: Sql): Promise<AdminFixture> {
  const userId = await createUser(sql);
  const rawSessionId = `r2-006-${randomUUID()}`;
  const sessionDigest = digest(rawSessionId);
  await sql`
    INSERT INTO auth_sessions (session_id_hash, user_id, expires_at)
    VALUES (${sessionDigest}, ${userId}, CURRENT_TIMESTAMP + interval '1 hour')
  `;
  await sql`
    INSERT INTO admin_role_grants (user_id, role, grant_source, reason)
    VALUES (${userId}, 'ADMIN', 'BOOTSTRAP', 'R2-006 test admin')
  `;
  const [factor] = await sql<{ readonly id: string }[]>`
    INSERT INTO admin_mfa_factors (user_id, kind, credential_reference)
    VALUES (${userId}, 'TOTP', ${`test:r2-006/${randomUUID()}`}) RETURNING id
  `;
  if (factor === undefined) throw new Error("Expected R2-006 admin factor.");
  await sql`
    INSERT INTO admin_privileged_sessions (
      session_id_hash, user_id, mfa_factor_id, mfa_authenticated_at,
      created_at, expires_at
    ) VALUES (
      ${sessionDigest}, ${userId}, ${factor.id}, CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + interval '1 hour'
    )
  `;
  return { rawSessionId, sessionDigest, userId };
}

async function createUser(sql: Sql): Promise<UserId> {
  const [row] = await sql<{ readonly id: UserId }[]>`
    INSERT INTO users DEFAULT VALUES RETURNING id
  `;
  if (row === undefined) throw new Error("Expected R2-006 user.");
  return row.id;
}

async function setAccountState(
  sql: Sql,
  userId: UserId,
  state: "ACTIVE" | "SUSPENDED",
): Promise<void> {
  await sql.begin(async (transaction) => {
    await transaction`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
    await transaction`
      UPDATE users SET account_state = ${state},
        account_state_changed_at = clock_timestamp(),
        updated_at = clock_timestamp()
      WHERE id = ${userId}
    `;
  });
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
