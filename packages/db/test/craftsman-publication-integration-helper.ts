import { createHash, randomUUID } from "node:crypto";

import type {
  CraftsmanProfessionId,
  CraftsmanProfileId,
  MunicipalityCode,
  UserId,
} from "@portal/domain";
import type { Sql } from "postgres";
import { expect } from "vitest";

import { createCraftsmanProfessionRepository } from "../src/craftsman-profession-repository.js";
import { createCraftsmanPublicationRepository } from "../src/craftsman-publication-repository.js";
import { createCraftsmanServiceAreaRepository } from "../src/craftsman-service-area-repository.js";

/** Runs inside the single clean-migration integration test. */
export async function runCraftsmanPublicationIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const owner = await createUser(sql);
  const profile = await createProfile(sql, owner, true);
  const profession = await addProfession(sql, owner, profile);
  const municipality = await addSyntheticMunicipality(sql);
  const serviceAreas = createCraftsmanServiceAreaRepository(sql);
  await expect(
    serviceAreas.replaceOwnedDraft({
      actorUserId: owner,
      baseMunicipalityCode: municipality,
      commandId: randomUUID(),
      craftsmanProfileId: profile,
      expectedRevision: 0,
      extraMunicipalityCodes: [],
      maximumRadiusKm: null,
      normalRadiusKm: 25,
      travelFeePolicy: null,
      travelFeeThresholdKm: null,
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });

  const admin = await createAdmin(sql);
  const repository = createCraftsmanPublicationRepository(sql);
  const submitted = await repository.submitForReview({
    actorUserId: owner,
    commandId: randomUUID(),
    craftsmanProfileId: profile,
    expectedRevision: 0,
  });
  expect(submitted).toMatchObject({
    publication: { reviewState: "PENDING" },
    status: "APPLIED",
  });
  const publicPreferenceInput = {
    actorUserId: owner,
    commandId: randomUUID(),
    craftsmanProfileId: profile,
    expectedRevision: 1,
    visibility: "PUBLIC" as const,
  };
  const publicPreference = await repository.setOwnerVisibility(
    publicPreferenceInput,
  );
  expect(publicPreference).toMatchObject({
    publication: { effectivelyPublic: false, ownerVisibility: "PUBLIC" },
  });
  const approvedCommand = adminInput(admin, profile, 2);
  const approved = await repository.approve(approvedCommand);
  expect(approved).toMatchObject({
    publication: { effectivelyPublic: true, reviewState: "APPROVED" },
    status: "APPLIED",
  });
  await expect(repository.approve(approvedCommand)).resolves.toMatchObject({
    publication: { revision: 3 },
    status: "DEDUPLICATED",
  });

  // Every required aggregate is evaluated live, not frozen at approval time.
  await sql`UPDATE craftsman_profiles SET about = NULL WHERE id = ${profile}`;
  await expect(
    repository.findOwned({ actorUserId: owner, craftsmanProfileId: profile }),
  ).resolves.toMatchObject({
    effectivelyPublic: false,
    reviewState: "APPROVED",
  });
  await sql`
    UPDATE craftsman_profiles SET about = 'Spoľahlivý testovací remeselník.'
    WHERE id = ${profile}
  `;
  await expect(
    repository.findOwned({ actorUserId: owner, craftsmanProfileId: profile }),
  ).resolves.toMatchObject({
    effectivelyPublic: true,
    reviewState: "APPROVED",
  });

  await sql`
    UPDATE users SET account_state = 'SUSPENDED',
      account_state_changed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ${owner}
  `;
  const [suspendedBoundary] = await sql<
    { readonly effectivelyPublic: boolean }[]
  >`
    SELECT effectively_public AS "effectivelyPublic"
    FROM current_craftsman_profile_publications
    WHERE craftsman_profile_id = ${profile}
  `;
  expect(suspendedBoundary?.effectivelyPublic).toBe(false);
  await expect(
    repository.setOwnerVisibility(publicPreferenceInput),
  ).resolves.toEqual({ status: "PROFILE_UNAVAILABLE" });
  await expect(
    repository.setOwnerVisibility({
      actorUserId: owner,
      commandId: randomUUID(),
      craftsmanProfileId: profile,
      expectedRevision: 3,
      visibility: "HIDDEN",
    }),
  ).resolves.toEqual({ status: "PROFILE_UNAVAILABLE" });
  await sql`
    UPDATE users SET account_state = 'ACTIVE',
      account_state_changed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ${owner}
  `;

  const professionRepository = createCraftsmanProfessionRepository(sql);
  await expect(
    professionRepository.deactivate({
      actorUserId: owner,
      commandId: randomUUID(),
      craftsmanProfessionId: profession,
      craftsmanProfileId: profile,
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });
  await expect(
    repository.findOwned({ actorUserId: owner, craftsmanProfileId: profile }),
  ).resolves.toMatchObject({ effectivelyPublic: false });
  await addProfession(sql, owner, profile);
  await expect(
    repository.findOwned({ actorUserId: owner, craftsmanProfileId: profile }),
  ).resolves.toMatchObject({
    effectivelyPublic: true,
    reviewState: "APPROVED",
  });

  await expect(
    serviceAreas.replaceOwnedDraft({
      actorUserId: owner,
      baseMunicipalityCode: null,
      commandId: randomUUID(),
      craftsmanProfileId: profile,
      expectedRevision: 1,
      extraMunicipalityCodes: [],
      maximumRadiusKm: null,
      normalRadiusKm: 25,
      travelFeePolicy: null,
      travelFeeThresholdKm: null,
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });
  await expect(
    repository.findOwned({ actorUserId: owner, craftsmanProfileId: profile }),
  ).resolves.toMatchObject({ effectivelyPublic: false });
  await expect(
    serviceAreas.replaceOwnedDraft({
      actorUserId: owner,
      baseMunicipalityCode: municipality,
      commandId: randomUUID(),
      craftsmanProfileId: profile,
      expectedRevision: 2,
      extraMunicipalityCodes: [],
      maximumRadiusKm: null,
      normalRadiusKm: null,
      travelFeePolicy: null,
      travelFeeThresholdKm: null,
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });
  await expect(
    repository.findOwned({ actorUserId: owner, craftsmanProfileId: profile }),
  ).resolves.toMatchObject({ effectivelyPublic: false });
  await expect(
    serviceAreas.replaceOwnedDraft({
      actorUserId: owner,
      baseMunicipalityCode: municipality,
      commandId: randomUUID(),
      craftsmanProfileId: profile,
      expectedRevision: 3,
      extraMunicipalityCodes: [],
      maximumRadiusKm: null,
      normalRadiusKm: 25,
      travelFeePolicy: null,
      travelFeeThresholdKm: null,
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });
  await expect(
    repository.findOwned({ actorUserId: owner, craftsmanProfileId: profile }),
  ).resolves.toMatchObject({
    effectivelyPublic: true,
    reviewState: "APPROVED",
  });

  await sql`
    UPDATE craftsman_profiles SET real_first_name = NULL, real_last_name = NULL
    WHERE id = ${profile}
  `;
  await expect(
    repository.findOwned({ actorUserId: owner, craftsmanProfileId: profile }),
  ).resolves.toMatchObject({ effectivelyPublic: false });
  await sql`
    UPDATE craftsman_profiles SET real_first_name = 'Ján', real_last_name = 'Testovací'
    WHERE id = ${profile}
  `;
  const identityReview = await repository.requireIdentityReview({
    commandId: randomUUID(),
    craftsmanProfileId: profile,
    expectedRevision: 3,
    reasonCode: "SENSITIVE_IDENTITY_CHANGED",
    ruleReference: "PROFILE.IDENTITY.REVIEW_V1",
  });
  expect(identityReview).toMatchObject({
    publication: { effectivelyPublic: false, reviewState: "PENDING" },
  });
  await expect(
    repository.approve(adminInput(admin, profile, 4)),
  ).resolves.toMatchObject({
    publication: { effectivelyPublic: true, reviewState: "APPROVED" },
  });

  const hidden = await repository.setModeration({
    ...adminInput(admin, profile, 5),
    moderationState: "HIDDEN",
    policyVersion: "MODERATION.2026-01",
    reasonCategory: "CONTENT_POLICY",
    reasonCode: "PROFILE_POLICY_REVIEW",
  });
  expect(hidden).toMatchObject({ publication: { moderationState: "HIDDEN" } });
  await expect(
    repository.setOwnerVisibility({
      actorUserId: owner,
      commandId: randomUUID(),
      craftsmanProfileId: profile,
      expectedRevision: 6,
      visibility: "PUBLIC",
    }),
  ).resolves.toMatchObject({
    publication: { effectivelyPublic: false, moderationState: "HIDDEN" },
    status: "UNCHANGED",
  });
  const restored = await repository.restoreModeration({
    ...adminInput(admin, profile, 6),
    policyVersion: "MODERATION.2026-01",
    reasonCategory: "CONTENT_POLICY",
    reasonCode: "PROFILE_POLICY_CLEARED",
  });
  expect(restored).toMatchObject({
    publication: { moderationState: "ALLOWED", ownerVisibility: "PUBLIC" },
  });

  // First moderation on revision zero exercises the default DRAFT/ALLOWED audit diff.
  const freshProfile = await createProfile(sql, await createUser(sql), false);
  const freshCompeting = await Promise.all([
    repository.setModeration({
      ...adminInput(admin, freshProfile, 0),
      moderationState: "RESTRICTED",
      policyVersion: "MODERATION.2026-01",
      reasonCategory: "TRUST_REVIEW",
      reasonCode: "MANUAL_REVIEW_REQUIRED",
    }),
    repository.setModeration({
      ...adminInput(admin, freshProfile, 0),
      moderationState: "HIDDEN",
      policyVersion: "MODERATION.2026-01",
      reasonCategory: "TRUST_REVIEW",
      reasonCode: "MANUAL_REVIEW_REQUIRED",
    }),
  ]);
  expect(freshCompeting.map(({ status }) => status).sort()).toEqual([
    "APPLIED",
    "STALE_REVISION",
  ]);
  const freshApplied = freshCompeting.find(
    ({ status }) => status === "APPLIED",
  );
  if (freshApplied?.status !== "APPLIED") {
    throw new Error("Expected one applied fresh-profile moderation.");
  }
  expect(freshApplied.publication).toMatchObject({ reviewState: "DRAFT" });
  await expect(
    repository.restoreModeration({
      ...adminInput(admin, freshProfile, 1),
      policyVersion: "MODERATION.2026-01",
      reasonCategory: "TRUST_REVIEW",
      reasonCode: "MANUAL_REVIEW_CLEARED",
    }),
  ).resolves.toMatchObject({ publication: { moderationState: "ALLOWED" } });

  const rejectOwner = await createUser(sql);
  const rejectProfile = await createProfile(sql, rejectOwner, true);
  await addProfession(sql, rejectOwner, rejectProfile);
  await expect(
    serviceAreas.replaceOwnedDraft({
      actorUserId: rejectOwner,
      baseMunicipalityCode: municipality,
      commandId: randomUUID(),
      craftsmanProfileId: rejectProfile,
      expectedRevision: 0,
      extraMunicipalityCodes: [],
      maximumRadiusKm: null,
      normalRadiusKm: 15,
      travelFeePolicy: null,
      travelFeeThresholdKm: null,
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });
  await expect(
    repository.submitForReview({
      actorUserId: rejectOwner,
      commandId: randomUUID(),
      craftsmanProfileId: rejectProfile,
      expectedRevision: 0,
    }),
  ).resolves.toMatchObject({ publication: { reviewState: "PENDING" } });
  await expect(
    repository.reject({
      ...adminInput(admin, rejectProfile, 1),
      reasonCode: "PROFILE_NEEDS_CLARIFICATION",
      userFacingReason: "Doplňte, prosím, jasnejší opis ponúkaných služieb.",
    }),
  ).resolves.toMatchObject({
    publication: {
      rejection: { reasonCode: "PROFILE_NEEDS_CLARIFICATION" },
      reviewState: "REJECTED",
    },
  });

  await exerciseRawSqlGuards(sql, owner, profile, admin);
  await sql`
    UPDATE admin_role_grants
    SET revoked_by_user_id = ${admin.userId}, revoked_at = CURRENT_TIMESTAMP
    WHERE user_id = ${admin.userId} AND revoked_at IS NULL
  `;
  await expect(repository.approve(approvedCommand)).resolves.toEqual({
    status: "ADMIN_AUTHORIZATION_REQUIRED",
  });
}

async function createUser(sql: Sql): Promise<UserId> {
  const [row] = await sql<{ readonly id: UserId }[]>`
    INSERT INTO users DEFAULT VALUES RETURNING id
  `;
  if (row === undefined) throw new Error("Expected publication user.");
  return row.id;
}

async function createProfile(
  sql: Sql,
  owner: UserId,
  complete: boolean,
): Promise<CraftsmanProfileId> {
  const [row] = await sql<{ readonly id: CraftsmanProfileId }[]>`
    INSERT INTO craftsman_profiles (
      owner_user_id, profile_type, real_first_name, real_last_name, about
    ) VALUES (
      ${owner}, 'INDIVIDUAL', ${complete ? "Ján" : null},
      ${complete ? "Testovací" : null},
      ${complete ? "Spoľahlivý testovací remeselník." : null}
    ) RETURNING id
  `;
  if (row === undefined) throw new Error("Expected publication profile.");
  return row.id;
}

async function addProfession(
  sql: Sql,
  owner: UserId,
  profile: CraftsmanProfileId,
): Promise<CraftsmanProfessionId> {
  const [candidate] = await sql<
    { readonly professionCode: string; readonly releaseId: string }[]
  >`
    SELECT profession.profession_code AS "professionCode",
      profession.release_id AS "releaseId"
    FROM profession_taxonomy_activation_events activation
    JOIN taxonomy_professions profession ON profession.release_id = activation.release_id
    WHERE profession.state = 'ACTIVE'
      AND NOT EXISTS (
        SELECT 1 FROM craftsman_professions assignment
        WHERE assignment.craftsman_profile_id = ${profile}
          AND assignment.profession_code = profession.profession_code
      )
    ORDER BY activation.activation_sequence DESC, profession.profession_code
    LIMIT 1
  `;
  if (candidate === undefined)
    throw new Error("Expected unused active profession.");
  const id = randomUUID() as CraftsmanProfessionId;
  await expect(
    createCraftsmanProfessionRepository(sql).assign({
      actorUserId: owner,
      commandId: randomUUID(),
      craftsmanProfessionId: id,
      craftsmanProfileId: profile,
      declaredLevel: "ADVANCED",
      professionCode: candidate.professionCode,
      taxonomyReleaseId: candidate.releaseId,
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });
  return id;
}

async function addSyntheticMunicipality(sql: Sql): Promise<MunicipalityCode> {
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const region = `TEST:R1010:R:${suffix}`;
  const district = `TEST:R1010:D:${suffix}`;
  const municipality = `TEST:R1010:M:${suffix}` as MunicipalityCode;
  await sql`
    INSERT INTO location_regions (code, name_sk, source_reference, source_revision)
    VALUES (${region}, 'Testovací kraj', 'test-fixture:R1-010', 'synthetic-v1')
  `;
  await sql`
    INSERT INTO location_districts (
      code, region_code, name_sk, source_reference, source_revision
    ) VALUES (
      ${district}, ${region}, 'Testovací okres',
      'test-fixture:R1-010', 'synthetic-v1'
    )
  `;
  await sql`
    INSERT INTO location_municipalities (
      code, district_code, name_sk, centroid, source_reference, source_revision
    ) VALUES (
      ${municipality}, ${district}, 'Testovacia obec',
      ST_GeogFromText('SRID=4326;POINT(17.1 48.15)'),
      'test-fixture:R1-010', 'synthetic-v1'
    )
  `;
  return municipality;
}

interface AdminFixture {
  readonly sessionDigest: string;
  readonly userId: UserId;
}

async function createAdmin(sql: Sql): Promise<AdminFixture> {
  const userId = await createUser(sql);
  const sessionDigest = createHash("sha256").update(randomUUID()).digest("hex");
  await sql`
    INSERT INTO auth_sessions (session_id_hash, user_id, expires_at)
    VALUES (${sessionDigest}, ${userId}, CURRENT_TIMESTAMP + interval '1 hour')
  `;
  await sql`
    INSERT INTO admin_role_grants (
      user_id, role, grant_source, reason
    ) VALUES (${userId}, 'ADMIN', 'BOOTSTRAP', 'Integration test admin role')
  `;
  const [factor] = await sql<{ readonly id: string }[]>`
    INSERT INTO admin_mfa_factors (user_id, kind, credential_reference)
    VALUES (${userId}, 'TOTP', ${`test:r1010/${randomUUID()}`})
    RETURNING id
  `;
  if (factor === undefined) throw new Error("Expected admin MFA factor.");
  await sql`
    INSERT INTO admin_privileged_sessions (
      session_id_hash, user_id, mfa_factor_id, mfa_authenticated_at,
      created_at, expires_at
    ) VALUES (
      ${sessionDigest}, ${userId}, ${factor.id}, CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + interval '1 hour'
    )
  `;
  return { sessionDigest, userId };
}

function adminInput(
  admin: AdminFixture,
  profile: CraftsmanProfileId,
  expectedRevision: number,
) {
  return {
    actorSessionIdDigest: admin.sessionDigest,
    actorUserId: admin.userId,
    commandId: randomUUID(),
    correlationId: randomUUID(),
    craftsmanProfileId: profile,
    expectedRevision,
    reason: "Explicit integration profile decision.",
  };
}

async function exerciseRawSqlGuards(
  sql: Sql,
  owner: UserId,
  profile: CraftsmanProfileId,
  admin: AdminFixture,
): Promise<void> {
  await expect(sql`
    UPDATE craftsman_profile_publication_revisions SET owner_visibility = 'HIDDEN'
    WHERE craftsman_profile_id = ${profile}
  `).rejects.toThrow(/append-only/u);
  await expect(sql`
    DELETE FROM craftsman_profile_publication_commands
    WHERE craftsman_profile_id = ${profile}
  `).rejects.toThrow(/append-only/u);
  await expect(
    sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO craftsman_profile_publication_commands (
          command_id, craftsman_profile_id, actor_kind, actor_user_id,
          command_kind, expected_revision, resulting_revision,
          review_state, owner_visibility, moderation_state, payload_fingerprint
        ) VALUES (
          ${randomUUID()}, ${profile}, 'OWNER', ${owner},
          'SET_OWNER_VISIBILITY', 7, 8, 'DRAFT', 'HIDDEN', 'ALLOWED',
          ${"a".repeat(64)}
        )
      `;
    }),
  ).rejects.toThrow(/revision effect|stale revision/u);
  await expect(
    sql.begin(async (transaction) => {
      const commandId = randomUUID();
      const correlationId = randomUUID();
      await transaction`
        INSERT INTO audit_events (
          event_id, correlation_id, category, actor_kind, actor_user_id,
          actor_capability, action_type, target_type, target_id, reason, changes
        ) VALUES (
          ${commandId}, ${correlationId}, 'PRIVILEGED_COMMAND',
          'AUTHENTICATED_USER', ${admin.userId}, 'admin.profiles.moderate',
          'admin.profile.restricted', 'CRAFTSMAN_PROFILE', ${profile},
          'Explicit raw SQL negative decision.',
          ${transaction.json({
            restriction_state: { after: "HIDDEN", before: "ALLOWED" },
          })}
        )
      `;
      await transaction`
        INSERT INTO craftsman_profile_publication_commands (
          command_id, craftsman_profile_id, actor_kind, actor_user_id,
          actor_capability, authorization_session_hash, correlation_id,
          audit_event_id, command_kind, expected_revision, resulting_revision,
          review_state, owner_visibility, moderation_state,
          command_reason_category, command_reason_code, command_policy_version,
          reason, payload_fingerprint
        ) VALUES (
          ${commandId}, ${profile}, 'ADMIN', ${admin.userId},
          'admin.profiles.moderate', ${admin.sessionDigest}, ${correlationId},
          ${commandId}, 'MODERATION_HIDE', 7, 8,
          'DRAFT', 'HIDDEN', 'ALLOWED', 'CONTENT_POLICY',
          'RAW_SQL_NEGATIVE', 'MODERATION.2026-01',
          'Explicit raw SQL negative decision.', ${"b".repeat(64)}
        )
      `;
      await transaction`
        INSERT INTO craftsman_profile_publication_revisions (
          craftsman_profile_id, command_id, revision,
          review_state, owner_visibility, moderation_state
        ) VALUES (${profile}, ${commandId}, 8, 'DRAFT', 'HIDDEN', 'ALLOWED')
      `;
    }),
  ).rejects.toThrow(/exact audit effect/u);
  await expect(
    sql.begin(async (transaction) => {
      const commandId = randomUUID();
      await transaction`
        INSERT INTO craftsman_profile_publication_commands (
          command_id, craftsman_profile_id, actor_kind, actor_system_reference,
          audit_event_id, command_kind, expected_revision, resulting_revision,
          review_state, owner_visibility, moderation_state,
          command_identity_reason_code, command_identity_rule_reference,
          payload_fingerprint
        ) VALUES (
          ${commandId}, ${profile}, 'SYSTEM', 'user-claim:identity-change',
          ${commandId}, 'IDENTITY_REVIEW_REQUIRED', 7, 8,
          'DRAFT', 'HIDDEN', 'ALLOWED', 'SENSITIVE_IDENTITY_CHANGED',
          'PROFILE.IDENTITY.REVIEW_V1', ${"c".repeat(64)}
        )
      `;
    }),
  ).rejects.toThrow(/trusted identity-review system hook/u);
  await expect(sql`
    INSERT INTO craftsman_profile_publication_revisions (
      craftsman_profile_id, command_id, revision,
      review_state, owner_visibility, moderation_state
    ) VALUES (
      ${profile}, ${randomUUID()}, 999, 'DRAFT', 'HIDDEN', 'ALLOWED'
    )
  `).rejects.toThrow(/foreign key|command provenance/u);
}
