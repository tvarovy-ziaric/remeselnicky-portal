import { randomUUID } from "node:crypto";

import type { Sql } from "postgres";
import { expect } from "vitest";

import {
  PLACEHOLDER_ALPHA_TAXONOMY,
  prepareProfessionTaxonomyRelease,
  type ProfessionTaxonomyReleaseSeed,
} from "@portal/taxonomy";

import { createProfessionTaxonomyRepository } from "../src/taxonomy-repository.js";

export async function runTaxonomyIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const repository = createProfessionTaxonomyRepository(sql);
  const concurrentInstall = await Promise.all([
    repository.installRelease(PLACEHOLDER_ALPHA_TAXONOMY),
    repository.installRelease(PLACEHOLDER_ALPHA_TAXONOMY),
  ]);
  expect(concurrentInstall.sort()).toEqual(["CREATED", "UNCHANGED"]);
  await expect(repository.listCurrentProfessions()).resolves.toEqual([]);
  await expect(
    repository.activateRelease({
      activationId: randomUUID(),
      actorReference: "system:integration-taxonomy",
      previousReleaseId: null,
      releaseId: PLACEHOLDER_ALPHA_TAXONOMY.releaseId,
      reviewReference: "review:integration/placeholder",
    }),
  ).rejects.toThrow(/approved canonical governance/u);

  await expect(sql`
    INSERT INTO taxonomy_professions (
      release_id, profession_code, slug, label_sk, state
    ) VALUES (
      ${PLACEHOLDER_ALPHA_TAXONOMY.releaseId},
      'TEST:LATE_ENTRY',
      'oneskoreny-zapis',
      'Oneskorený zápis',
      'ACTIVE'
    )
  `).rejects.toThrow(/sealed/u);

  const second = canonicalRelease({
    releaseId: "00000000-0000-4000-8000-000000001302",
    supersedesReleaseId: PLACEHOLDER_ALPHA_TAXONOMY.releaseId,
    version: 2,
  });
  await expect(repository.installRelease(second)).resolves.toBe("CREATED");
  const [futureTimestamp] = await sql<{ readonly occurredAt: Date }[]>`
    INSERT INTO profession_taxonomy_activation_events (
      activation_id, release_id, previous_release_id,
      actor_reference, review_reference, occurred_at
    ) VALUES (
      ${randomUUID()}, ${second.releaseId}, NULL,
      'system:integration-taxonomy', ${second.reviewReference},
      '2999-01-01T00:00:00Z'
    )
    RETURNING occurred_at AS "occurredAt"
  `;
  expect(futureTimestamp?.occurredAt.getUTCFullYear()).toBeLessThan(2999);

  const third = canonicalRelease({
    releaseId: "00000000-0000-4000-8000-000000001303",
    supersedesReleaseId: second.releaseId,
    version: 3,
  });
  await expect(repository.installRelease(third)).resolves.toBe("CREATED");
  const [pastTimestamp] = await sql<{ readonly occurredAt: Date }[]>`
    INSERT INTO profession_taxonomy_activation_events (
      activation_id, release_id, previous_release_id,
      actor_reference, review_reference, occurred_at
    ) VALUES (
      ${randomUUID()}, ${third.releaseId}, ${second.releaseId},
      'system:integration-taxonomy', ${third.reviewReference},
      '1900-01-01T00:00:00Z'
    )
    RETURNING occurred_at AS "occurredAt"
  `;
  expect(pastTimestamp?.occurredAt.getUTCFullYear()).toBeGreaterThan(2000);
  await expect(repository.listCurrentProfessions()).resolves.toEqual([
    expect.objectContaining({
      code: "PROF:INTEGRATION_SAFE",
      releaseVersion: 3,
      state: "ACTIVE",
    }),
  ]);

  await expect(sql`
    UPDATE taxonomy_professions
    SET label_sk = 'Prepísaná história'
    WHERE release_id = ${third.releaseId}
  `).rejects.toThrow(/append-only/u);

  await expect(
    installInvalidRelease(sql, third.releaseId, "DUPLICATE_SLUG"),
  ).rejects.toThrow(/taxonomy_professions_release_id_slug_key/u);
  await expect(
    installInvalidRelease(sql, third.releaseId, "INVALID_HIERARCHY"),
  ).rejects.toThrow(/taxonomy_specializations_profession_fkey/u);

  const cyclicReleaseId = "00000000-0000-4000-8000-000000001304";
  await installCyclicRelease(sql, cyclicReleaseId, third.releaseId);
  await expect(sql`
    INSERT INTO profession_taxonomy_activation_events (
      activation_id, release_id, previous_release_id,
      actor_reference, review_reference
    ) VALUES (
      ${randomUUID()}, ${cyclicReleaseId}, ${third.releaseId},
      'system:integration-taxonomy', 'review:integration/approved-4'
    )
  `).rejects.toThrow(/replacement cycle/u);
}

function canonicalRelease(input: {
  readonly releaseId: string;
  readonly supersedesReleaseId: string;
  readonly version: number;
}) {
  return prepareProfessionTaxonomyRelease({
    aliases: [],
    capabilityCriteria: [
      {
        code: "CAP:INTEGRATION_SAFE",
        descriptionSk:
          "Testovacie kritérium bez odborného alebo právneho tvrdenia.",
        labelSk: "Testovacia schopnosť",
        level: "ADVANCED",
        professionCode: "PROF:INTEGRATION_SAFE",
        state: "ACTIVE",
      },
    ],
    contentClass: "CANONICAL",
    professions: [
      {
        code: "PROF:INTEGRATION_SAFE",
        labelSk: "Integračné testovacie remeslo",
        replacedByCode: null,
        slug: "integracne-testovacie-remeslo",
        state: "ACTIVE",
      },
    ],
    releaseId: input.releaseId,
    reviewReference: `review:integration/approved-${input.version}`,
    reviewState: "HUMAN_REVIEW_APPROVED",
    specializations: [],
    supersedesReleaseId: input.supersedesReleaseId,
    version: input.version,
  } satisfies ProfessionTaxonomyReleaseSeed);
}

async function installInvalidRelease(
  sql: Sql,
  supersedesReleaseId: string,
  kind: "DUPLICATE_SLUG" | "INVALID_HIERARCHY",
): Promise<void> {
  await sql.begin(async (transaction) => {
    const releaseId = randomUUID();
    await transaction`
      INSERT INTO profession_taxonomy_releases (
        release_id, version, content_class, review_state,
        review_reference, supersedes_release_id, checksum_sha256
      ) VALUES (
        ${releaseId}, 4, 'CANONICAL', 'HUMAN_REVIEW_APPROVED',
        'review:integration/invalid-4', ${supersedesReleaseId}, ${"c".repeat(64)}
      )
    `;
    await transaction`
      INSERT INTO taxonomy_professions (
        release_id, profession_code, slug, label_sk, state
      ) VALUES (
        ${releaseId}, 'PROF:ONE', 'rovnaky-slug', 'Prvé testovacie remeslo', 'ACTIVE'
      )
    `;
    if (kind === "DUPLICATE_SLUG") {
      await transaction`
        INSERT INTO taxonomy_professions (
          release_id, profession_code, slug, label_sk, state
        ) VALUES (
          ${releaseId}, 'PROF:TWO', 'rovnaky-slug', 'Druhé testovacie remeslo', 'ACTIVE'
        )
      `;
    } else {
      await transaction`
        INSERT INTO taxonomy_specializations (
          release_id, specialization_code, profession_code,
          slug, label_sk, state
        ) VALUES (
          ${releaseId}, 'SPEC:ORPHAN', 'PROF:MISSING',
          'osirotena-specializacia', 'Osirotená špecializácia', 'ACTIVE'
        )
      `;
    }
  });
}

async function installCyclicRelease(
  sql: Sql,
  releaseId: string,
  supersedesReleaseId: string,
): Promise<void> {
  await sql.begin(async (transaction) => {
    await transaction`
      INSERT INTO profession_taxonomy_releases (
        release_id, version, content_class, review_state,
        review_reference, supersedes_release_id, checksum_sha256
      ) VALUES (
        ${releaseId}, 4, 'CANONICAL', 'HUMAN_REVIEW_APPROVED',
        'review:integration/approved-4', ${supersedesReleaseId}, ${"d".repeat(64)}
      )
    `;
    await transaction`
      INSERT INTO taxonomy_professions (
        release_id, profession_code, slug, label_sk, state, replaced_by_code
      ) VALUES
        (${releaseId}, 'PROF:CYCLE_A', 'cyklus-a', 'Cyklus A', 'DEPRECATED', 'PROF:CYCLE_B'),
        (${releaseId}, 'PROF:CYCLE_B', 'cyklus-b', 'Cyklus B', 'DEPRECATED', 'PROF:CYCLE_A')
    `;
  });
}
