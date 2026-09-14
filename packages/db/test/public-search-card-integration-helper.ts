import { randomUUID } from "node:crypto";

import type {
  AdminCapability,
  AdminRole,
  PrivilegedActor,
} from "@portal/admin-auth";
import type {
  CredentialClaimId,
  CraftsmanProfileId,
  UserId,
} from "@portal/domain";
import {
  createCredentialQualificationPolicyService,
  createPublicSearchCardSearch,
} from "@portal/search";
import type { Sql } from "postgres";
import { expect } from "vitest";

import { createCredentialClaimRepository } from "../src/credential-claim-repository.js";
import { createCredentialQualificationRepository } from "../src/credential-qualification-repository.js";
import { createCraftsmanPublicationRepository } from "../src/craftsman-publication-repository.js";
import { createPublicSearchCardSource } from "../src/public-search-card-source.js";
import { runCredentialQualificationIntegrationAssertions } from "./credential-qualification-integration-helper.js";
import { runCraftsmanSearchReadModelIntegrationAssertions } from "./craftsman-search-read-model-integration-helper.js";

const requiredType = "test.r2006-approved";

interface Fixture {
  readonly actorUserId: UserId;
  readonly claimId: CredentialClaimId;
  readonly ownerId: UserId;
  readonly professionCode: string;
  readonly profileId: CraftsmanProfileId;
  readonly publicationRevision: number;
  readonly sessionHash: string;
  readonly taxonomyReleaseId: string;
}

/** Standalone live-PostgreSQL assertions for the R2-011 source and composer. */
export async function runPublicSearchCardIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  if (!(await hasFixture(sql)))
    await runCredentialQualificationIntegrationAssertions(sql);
  await runCraftsmanSearchReadModelIntegrationAssertions(sql);
  const fixture = await loadFixture(sql);
  await activateSingleRequiredPolicy(sql, fixture);
  const search = createPublicSearchCardSearch(
    createPublicSearchCardSource(sql),
  );
  await expectPresentAndPrivate(search, fixture);

  const publication = createCraftsmanPublicationRepository(sql);
  await expect(
    publication.setOwnerVisibility({
      actorUserId: fixture.ownerId,
      commandId: randomUUID(),
      craftsmanProfileId: fixture.profileId,
      expectedRevision: fixture.publicationRevision,
      visibility: "HIDDEN",
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });
  await expectAbsent(search, fixture);
  await expect(
    publication.setOwnerVisibility({
      actorUserId: fixture.ownerId,
      commandId: randomUUID(),
      craftsmanProfileId: fixture.profileId,
      expectedRevision: fixture.publicationRevision + 1,
      visibility: "PUBLIC",
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });

  await setOwnerState(sql, fixture.ownerId, "SUSPENDED");
  await expectAbsent(search, fixture);
  await setOwnerState(sql, fixture.ownerId, "ACTIVE");
  await expectPresentAndPrivate(search, fixture);

  const actor: PrivilegedActor = Object.freeze({
    capabilities: new Set<AdminCapability>(["admin.credentials.review"]),
    mfaAuthenticatedAt: new Date(),
    roles: Object.freeze<AdminRole[]>(["ADMIN"]),
    userId: fixture.actorUserId,
  });
  await expect(
    createCredentialClaimRepository(sql).reviewAuthorized({
      actor,
      command: {
        claimId: fixture.claimId,
        commandId: randomUUID(),
        decision: "REVOKE",
        expectedRevision: 2,
        reason: "Syntetické odvolanie pre verejný search gate.",
        reasonCategory: "EXPIRED_OR_INVALID",
      },
      privilegedSessionIdHash: fixture.sessionHash,
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });
  await expectAbsent(search, fixture);
}

async function hasFixture(sql: Sql): Promise<boolean> {
  const [row] = await sql<{ readonly available: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM credential_claims
      WHERE credential_type_code = ${requiredType} AND state = 'APPROVED') AS available
  `;
  return row?.available === true;
}

async function loadFixture(sql: Sql): Promise<Fixture> {
  const [row] = await sql<Fixture[]>`
    SELECT claim.id AS "claimId", claim.reviewed_by_user_id AS "actorUserId",
      claim.craftsman_profile_id AS "profileId", profile.owner_user_id AS "ownerId",
      profession.profession_code AS "professionCode",
      profession.taxonomy_release_id AS "taxonomyReleaseId",
      searchable.publication_revision AS "publicationRevision",
      command.actor_privileged_session_hash AS "sessionHash"
    FROM credential_claims claim
    JOIN craftsman_profiles profile ON profile.id = claim.craftsman_profile_id
    JOIN craftsman_professions profession ON profession.id = claim.craftsman_profession_id
    JOIN current_searchable_craftsman_profiles searchable
      ON searchable.craftsman_profile_id = claim.craftsman_profile_id
    JOIN credential_claim_commands command
      ON command.claim_id = claim.id AND command.command_kind = 'APPROVE'
    WHERE claim.credential_type_code = ${requiredType} AND claim.state = 'APPROVED'
    ORDER BY claim.created_at DESC LIMIT 1
  `;
  if (row === undefined) throw new Error("Expected approved R2-006 fixture.");
  return row;
}

async function activateSingleRequiredPolicy(
  sql: Sql,
  fixture: Fixture,
): Promise<void> {
  const [current] = await sql<
    { readonly releaseId: string; readonly version: number }[]
  >`
    SELECT release.release_id AS "releaseId", release.version
    FROM credential_qualification_policy_activation_events activation
    JOIN credential_qualification_policy_releases release ON release.release_id = activation.release_id
    ORDER BY activation.activation_sequence DESC LIMIT 1
  `;
  if (current === undefined)
    throw new Error("Expected current policy release.");
  const releaseId = randomUUID();
  const policy = createCredentialQualificationPolicyService({
    persistence: createCredentialQualificationRepository(sql),
  });
  await expect(
    policy.installRelease({
      entries: [
        {
          credentialTypeCode: requiredType,
          professionCode: fixture.professionCode,
          requirement: "REQUIRED",
        },
      ],
      releaseId,
      reviewReference: "legal-review:R2-011-synthetic-only",
      supersedesReleaseId: current.releaseId,
      taxonomyReleaseId: fixture.taxonomyReleaseId,
      version: current.version + 1,
    }),
  ).resolves.toBe("CREATED");
  await expect(
    policy.activateRelease({
      activationId: randomUUID(),
      actorReference: "deployment:R2-011-fixture",
      previousReleaseId: current.releaseId,
      releaseId,
      reviewReference: "legal-review:R2-011-synthetic-only",
    }),
  ).resolves.toBe(true);
}

async function expectPresentAndPrivate(
  search: ReturnType<typeof createPublicSearchCardSearch>,
  fixture: Fixture,
): Promise<void> {
  const result = await search.search({
    professionCode: fixture.professionCode,
  });
  expect(result.status).toBe("OK");
  if (result.status !== "OK") return;
  expect(result.page.items.map(({ profileId }) => profileId)).toContain(
    fixture.profileId,
  );
  expect(JSON.stringify(result.page)).not.toMatch(
    /email|phone|exact_address|latitude|longitude|rankingDistance|storage|sha256|credentialClaim|reviewer|admin/iu,
  );
}

async function expectAbsent(
  search: ReturnType<typeof createPublicSearchCardSearch>,
  fixture: Fixture,
): Promise<void> {
  const result = await search.search({
    professionCode: fixture.professionCode,
  });
  expect(result.status).toBe("OK");
  if (result.status === "OK") {
    expect(
      result.page.items.some(
        ({ profileId }) => profileId === fixture.profileId,
      ),
    ).toBe(false);
  }
}

async function setOwnerState(
  sql: Sql,
  ownerId: UserId,
  state: "ACTIVE" | "SUSPENDED",
): Promise<void> {
  await sql.begin(async (transaction) => {
    await transaction`SELECT id FROM users WHERE id = ${ownerId} FOR UPDATE`;
    await transaction`UPDATE users SET account_state = ${state},
      account_state_changed_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE id = ${ownerId}`;
  });
}
