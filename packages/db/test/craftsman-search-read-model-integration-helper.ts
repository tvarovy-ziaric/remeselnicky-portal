import type { CraftsmanProfileId, UserId } from "@portal/domain";
import type { Sql } from "postgres";
import { expect } from "vitest";

import { createCraftsmanPublicationRepository } from "../src/craftsman-publication-repository.js";
import { createCraftsmanSearchReadModelRepository } from "../src/craftsman-search-read-model-repository.js";
import { runCraftsmanPublicationIntegrationAssertions } from "./craftsman-publication-integration-helper.js";

interface CandidateFixture {
  readonly ownerUserId: UserId;
  readonly profileId: CraftsmanProfileId;
  readonly publicationRevision: number;
}

/** Standalone live-PostgreSQL assertions for migration 0029 and its reader. */
export async function runCraftsmanSearchReadModelIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const existing = await sql<{ readonly profileId: string }[]>`
    SELECT craftsman_profile_id AS "profileId"
    FROM current_searchable_craftsman_profiles
  `;
  await runCraftsmanPublicationIntegrationAssertions(sql);
  const excludedIds = existing.map(({ profileId }) => profileId);
  const [fixture] = await sql<CandidateFixture[]>`
    SELECT searchable.craftsman_profile_id AS "profileId",
      profile.owner_user_id AS "ownerUserId",
      searchable.publication_revision AS "publicationRevision"
    FROM current_searchable_craftsman_profiles searchable
    JOIN craftsman_profiles profile ON profile.id = searchable.craftsman_profile_id
    WHERE NOT (searchable.craftsman_profile_id = ANY(${excludedIds}::uuid[]))
    ORDER BY searchable.craftsman_profile_id
    LIMIT 1
  `;
  if (fixture === undefined) {
    throw new Error("Expected a standalone searchable craftsman fixture.");
  }

  const repository = createCraftsmanSearchReadModelRepository(sql);
  const initial = await repository.search({ identityQuery: "jan testovaci" });
  expect(initial.items.map(({ profileId }) => profileId)).toContain(
    fixture.profileId,
  );
  const [count] = await sql<{ readonly value: number }[]>`
    SELECT count(*)::integer AS value
    FROM current_searchable_craftsman_profiles
    WHERE craftsman_profile_id = ${fixture.profileId}
  `;
  expect(count?.value).toBe(1);

  const publication = createCraftsmanPublicationRepository(sql);
  await expect(
    publication.setOwnerVisibility({
      actorUserId: fixture.ownerUserId,
      commandId: randomUUID(),
      craftsmanProfileId: fixture.profileId,
      expectedRevision: fixture.publicationRevision,
      visibility: "HIDDEN",
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });
  expect(
    (await repository.search({ identityQuery: "jan testovaci" })).items.some(
      ({ profileId }) => profileId === fixture.profileId,
    ),
  ).toBe(false);

  await expect(
    publication.setOwnerVisibility({
      actorUserId: fixture.ownerUserId,
      commandId: randomUUID(),
      craftsmanProfileId: fixture.profileId,
      expectedRevision: fixture.publicationRevision + 1,
      visibility: "PUBLIC",
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });

  const race = repository.search({ identityQuery: "jan testovaci" });
  await sql`
    UPDATE users
    SET account_state = 'SUSPENDED', account_state_changed_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${fixture.ownerUserId}
  `;
  // The concurrent snapshot may linearize before suspension, but every later
  // search must observe the fail-closed ACTIVE-owner boundary.
  await race;
  expect(
    (await repository.search({ identityQuery: "jan testovaci" })).items.some(
      ({ profileId }) => profileId === fixture.profileId,
    ),
  ).toBe(false);
  await sql`
    UPDATE users
    SET account_state = 'ACTIVE', account_state_changed_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${fixture.ownerUserId}
  `;
  expect(
    (await repository.search({ identityQuery: "jan testovaci" })).items.some(
      ({ profileId }) => profileId === fixture.profileId,
    ),
  ).toBe(true);

  const columns = await sql<{ readonly columnName: string }[]>`
    SELECT column_name AS "columnName"
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name LIKE 'current_searchable_craftsman_%'
  `;
  expect(columns.map(({ columnName }) => columnName).join(" ")).not.toMatch(
    /owner_user|email|phone|address|centroid|latitude|longitude|storage|sha256|customer_name|credential_claim_id|starts_at|ends_at/iu,
  );
  await expect(sql`
    UPDATE current_searchable_craftsman_profiles
    SET primary_name = 'Spoofed'
    WHERE craftsman_profile_id = ${fixture.profileId}
  `).rejects.toThrow();
}
import { randomUUID } from "node:crypto";
