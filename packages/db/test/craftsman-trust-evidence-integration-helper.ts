import { randomUUID } from "node:crypto";

import type { CraftsmanProfileId, UserId } from "@portal/domain";
import type { Sql } from "postgres";
import { expect } from "vitest";

import { createCraftsmanPublicationRepository } from "../src/craftsman-publication-repository.js";
import { createCraftsmanTrustEvidenceRepository } from "../src/craftsman-trust-evidence-repository.js";
import { runCraftsmanDistanceIntegrationAssertions } from "./craftsman-distance-integration-helper.js";

interface Fixture {
  readonly ownerId: UserId;
  readonly profileId: CraftsmanProfileId;
  publicationRevision: number;
}

/** Standalone R2-008 live-PostgreSQL assertions; never wired by this owner. */
export async function runCraftsmanTrustEvidenceIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const existing = await sql<{ readonly profileId: string }[]>`
    SELECT craftsman_profile_id AS "profileId"
    FROM current_searchable_craftsman_profiles
  `;
  await runCraftsmanDistanceIntegrationAssertions(sql);
  const excludedIds = existing.map(({ profileId }) => profileId);
  const fixtures = await sql<Fixture[]>`
    SELECT searchable.craftsman_profile_id AS "profileId",
      profile.owner_user_id AS "ownerId",
      searchable.publication_revision AS "publicationRevision"
    FROM current_searchable_craftsman_profiles searchable
    JOIN craftsman_profiles profile
      ON profile.id = searchable.craftsman_profile_id
    WHERE NOT (searchable.craftsman_profile_id = ANY(${excludedIds}::uuid[]))
    ORDER BY searchable.craftsman_profile_id
  `;
  expect(fixtures).toHaveLength(3);
  const repository = createCraftsmanTrustEvidenceRepository(sql);
  const profileIds = fixtures.map(({ profileId }) => profileId);
  const summaries = await repository.listCurrent({ profileIds });
  expect(summaries).toHaveLength(3);
  expect(
    summaries.every(
      ({ confidence, professions, quality, volume }) =>
        quality.customerScore === null &&
        quality.customerQualityAvailable === false &&
        quality.supervisorQualityAvailable === false &&
        confidence.customerScore === "INSUFFICIENT_SAMPLE" &&
        confidence.supervisorEvidence === "INSUFFICIENT_SAMPLE" &&
        confidence.sourceDiversity === "INSUFFICIENT_SAMPLE" &&
        volume.customerReviewCount === 0 &&
        volume.supervisorEvaluationCount === 0 &&
        volume.verifiedJobCount === 0 &&
        volume.independentEvidenceSourceCount === 0 &&
        volume.approvedCredentialTypeCount === 0 &&
        volume.verifiedPortfolioProjectCount === 0 &&
        professions.length === 1,
    ),
  ).toBe(true);
  expect(summaries.map(({ profileId }) => profileId)).toEqual(
    [...profileIds].sort(),
  );

  const target = fixtures[0];
  if (target === undefined) throw new Error("Expected a trust fixture.");
  await assertVisibilityGates(sql, repository, target);
  await assertRawViewPrivacy(sql, profileIds);
}

async function assertVisibilityGates(
  sql: Sql,
  repository: ReturnType<typeof createCraftsmanTrustEvidenceRepository>,
  target: Fixture,
): Promise<void> {
  const publication = createCraftsmanPublicationRepository(sql);
  const hidden = await publication.setOwnerVisibility({
    actorUserId: target.ownerId,
    commandId: randomUUID(),
    craftsmanProfileId: target.profileId,
    expectedRevision: target.publicationRevision,
    visibility: "HIDDEN",
  });
  expect(hidden.status).toBe("APPLIED");
  if (hidden.status !== "APPLIED") throw new Error("Expected profile hide.");
  target.publicationRevision = hidden.publication.revision;
  try {
    await expect(
      repository.listCurrent({ profileIds: [target.profileId] }),
    ).resolves.toEqual([]);
  } finally {
    const restored = await publication.setOwnerVisibility({
      actorUserId: target.ownerId,
      commandId: randomUUID(),
      craftsmanProfileId: target.profileId,
      expectedRevision: target.publicationRevision,
      visibility: "PUBLIC",
    });
    expect(restored.status).toBe("APPLIED");
    if (restored.status === "APPLIED") {
      target.publicationRevision = restored.publication.revision;
    }
  }

  await setAccountState(sql, target.ownerId, "SUSPENDED");
  try {
    await expect(
      repository.listCurrent({ profileIds: [target.profileId] }),
    ).resolves.toEqual([]);
  } finally {
    await setAccountState(sql, target.ownerId, "ACTIVE");
  }
}

async function assertRawViewPrivacy(
  sql: Sql,
  profileIds: readonly CraftsmanProfileId[],
): Promise<void> {
  const summaries = await sql<Record<string, unknown>[]>`
    SELECT * FROM current_searchable_trust_evidence_summaries
    WHERE craftsman_profile_id = ANY(${profileIds}::uuid[])
    ORDER BY craftsman_profile_id
  `;
  expect(Object.keys(summaries[0] ?? {}).sort()).toEqual([
    "approved_credential_type_count",
    "craftsman_profile_id",
    "customer_quality_available",
    "customer_review_count",
    "customer_score",
    "customer_score_confidence",
    "independent_evidence_source_count",
    "source_diversity_confidence",
    "supervisor_evaluation_count",
    "supervisor_evidence_confidence",
    "supervisor_quality_available",
    "verified_job_count",
    "verified_portfolio_project_count",
  ]);
  const professions = await sql<Record<string, unknown>[]>`
    SELECT * FROM current_searchable_profession_trust_evidence
    WHERE craftsman_profile_id = ANY(${profileIds}::uuid[])
    ORDER BY craftsman_profile_id, profession_code
  `;
  expect(Object.keys(professions[0] ?? {}).sort()).toEqual([
    "approved_credential_type_count",
    "craftsman_profile_id",
    "customer_quality_available",
    "customer_review_count",
    "customer_score",
    "customer_score_confidence",
    "evidence_supported_level",
    "has_evidence_supported_skill",
    "has_evidence_supported_specialization",
    "independent_evidence_source_count",
    "profession_code",
    "source_diversity_confidence",
    "supervisor_evaluation_count",
    "supervisor_evidence_confidence",
    "supervisor_quality_available",
    "verified_job_count",
    "verified_portfolio_project_count",
  ]);
  expect(JSON.stringify({ professions, summaries })).not.toMatch(
    /owner|customer_name|reviewer|evaluator|review_body|comment|job_id|claim_id|project_id|credential_type_code|email|phone|address|storage|sha256|paid|founder|completeness|rank/iu,
  );
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
