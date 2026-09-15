import { randomUUID } from "node:crypto";

import {
  normalizeJobRequestContentSection,
  normalizeJobRequestDraftSection,
  type CustomerProfileId,
  type JobRequestId,
  type UserId,
} from "@portal/domain";
import type { Sql } from "postgres";
import { expect } from "vitest";

import { createJobRequestDraftRepository } from "../src/job-request-draft-repository.js";
import { createJobRequestRepository } from "../src/job-request-repository.js";
import { createJobRequestVersionRepository } from "../src/job-request-version-repository.js";

/** Standalone R3-005 assertions; root wires this after migration 0039. */
export async function runJobRequestVersionIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const [profession] = await sql<{ readonly code: string }[]>`
    SELECT profession_code AS code FROM current_profession_taxonomy
    WHERE state = 'ACTIVE' ORDER BY profession_code LIMIT 1
  `;
  const [municipality] = await sql<{ readonly code: string }[]>`
    SELECT code FROM location_municipalities
    WHERE is_active ORDER BY code LIMIT 1
  `;
  if (profession === undefined || municipality === undefined) {
    throw new Error("R3-005 requires governed taxonomy/location fixtures.");
  }
  const [owner] = await sql<{ readonly id: UserId }[]>`
    INSERT INTO users DEFAULT VALUES RETURNING id
  `;
  if (owner === undefined) throw new Error("Expected R3-005 owner.");
  const [customer] = await sql<{ readonly id: CustomerProfileId }[]>`
    INSERT INTO customer_profiles (owner_user_id)
    VALUES (${owner.id}) RETURNING id
  `;
  if (customer === undefined) throw new Error("Expected R3-005 customer.");

  const drafts = createJobRequestDraftRepository(sql);
  const requests = createJobRequestRepository(sql);
  const versions = createJobRequestVersionRepository(sql);
  const core = normalizeJobRequestDraftSection({
    key: "request.core",
    payload: {
      description: "Oprava zatekajúcej strechy",
      primaryProfessionCode: profession.code,
      relatedProfessionCodes: [],
      skillCodes: [],
      specializationCode: null,
      title: "Strecha",
    },
    schemaVersion: 1,
  });
  const created = await drafts.createDraftWithInitialSectionOwned({
    actorUserId: owner.id,
    commandId: randomUUID(),
    customerProfileId: customer.id,
    section: core,
  });
  if (created.status !== "APPLIED" || !("jobRequestId" in created)) {
    throw new Error("Expected R3-005 draft.");
  }
  const requestId = created.jobRequestId;
  const located = await drafts.autosaveOwned({
    actorUserId: owner.id,
    commandId: randomUUID(),
    expectedRevision: created.revision,
    jobRequestId: requestId,
    section: normalizeJobRequestDraftSection({
      key: "request.location",
      payload: {
        exactAddress: null,
        mapPin: null,
        municipalityCode: municipality.code,
        textClarification: null,
      },
      schemaVersion: 1,
    }),
  });
  if (located.status !== "APPLIED") throw new Error("Expected location.");
  const activated = await requests.activateOwned({
    actorUserId: owner.id,
    commandId: randomUUID(),
    expectedRevision: located.revision,
    jobRequestId: requestId,
  });
  expect(activated.status).toBe("APPLIED");

  await expect(
    versions.readActiveOwned({
      actorUserId: owner.id,
      jobRequestId: requestId,
    }),
  ).resolves.toMatchObject({
    snapshot: {
      version: { contentRevision: 1, material: false, visibleVersion: 1 },
    },
    status: "OK",
  });

  const titleCommand = randomUUID();
  const titleEdit = await versions.reviseActiveOwned({
    actorUserId: owner.id,
    commandId: titleCommand,
    expectedContentRevision: 1,
    jobRequestId: requestId,
    section: normalizeJobRequestContentSection({
      key: "request.core",
      payload: { ...core.payload, title: "Oprava strechy" },
      schemaVersion: 1,
    }),
  });
  expect(titleEdit).toMatchObject({
    status: "APPLIED",
    version: { contentRevision: 2, material: false, visibleVersion: 1 },
  });
  await expect(
    versions.reviseActiveOwned({
      actorUserId: owner.id,
      commandId: titleCommand,
      expectedContentRevision: 1,
      jobRequestId: requestId,
      section: normalizeJobRequestContentSection({
        key: "request.core",
        payload: { ...core.payload, title: "Oprava strechy" },
        schemaVersion: 1,
      }),
    }),
  ).resolves.toMatchObject({ status: "DEDUPLICATED" });

  const material = await versions.reviseActiveOwned({
    actorUserId: owner.id,
    commandId: randomUUID(),
    expectedContentRevision: 2,
    jobRequestId: requestId,
    section: normalizeJobRequestContentSection({
      key: "request.core",
      payload: {
        ...core.payload,
        description: "Výmena celej strechy vrátane krovu",
        title: "Oprava strechy",
      },
      schemaVersion: 1,
    }),
  });
  expect(material).toMatchObject({
    status: "APPLIED",
    version: {
      categories: ["SCOPE"],
      contentRevision: 3,
      material: true,
      visibleVersion: 2,
    },
  });

  const historical = await versions.readActiveOwned({
    actorUserId: owner.id,
    contentRevision: 2,
    jobRequestId: requestId,
  });
  expect(historical.status).toBe("OK");
  if (historical.status !== "OK") throw new Error("Expected history.");
  expect(historical.snapshot.version).toMatchObject({
    contentRevision: 2,
    visibleVersion: 1,
  });
  const historicalCore = historical.snapshot.sections.find(
    ({ key }) => key === "request.core",
  );
  expect(historicalCore?.payload).toMatchObject({
    description: "Oprava zatekajúcej strechy",
    title: "Oprava strechy",
  });

  const competing = await Promise.all([
    reviseBudget(versions, owner.id, requestId, 3, "UP_TO", 100_000),
    reviseBudget(versions, owner.id, requestId, 3, "UP_TO", 200_000),
  ]);
  expect(competing.map(({ status }) => status).sort()).toEqual([
    "APPLIED",
    "STALE_REVISION",
  ]);

  await sql`UPDATE users SET account_state = 'SUSPENDED' WHERE id = ${owner.id}`;
  await expect(
    versions.reviseActiveOwned({
      actorUserId: owner.id,
      commandId: titleCommand,
      expectedContentRevision: 1,
      jobRequestId: requestId,
      section: normalizeJobRequestContentSection({
        key: "request.core",
        payload: { ...core.payload, title: "Oprava strechy" },
        schemaVersion: 1,
      }),
    }),
  ).resolves.toEqual({ status: "ACCOUNT_NOT_ACTIVE" });
  await sql`UPDATE users SET account_state = 'ACTIVE' WHERE id = ${owner.id}`;

  await expect(sql`
    UPDATE job_request_active_content_revisions SET visible_version = 99
    WHERE job_request_id = ${requestId} AND content_revision = 1
  `).rejects.toThrow(/append-only/u);
  await expect(
    sql.begin(async (tx) => {
      await tx`
      INSERT INTO job_request_active_edit_commands (
        command_id, job_request_id, customer_profile_id, actor_user_id,
        expected_content_revision, resulting_content_revision,
        resulting_visible_version, section_key, section_schema_version,
        section_payload, section_payload_fingerprint, intent_fingerprint,
        result_kind, material_change, change_categories
      ) VALUES (
        ${randomUUID()}, ${requestId}, ${customer.id}, ${owner.id}, 4, 5, 4,
        'request.core', 1, ${tx.json(core.payload)}, ${"0".repeat(64)},
        ${"1".repeat(64)}, 'APPLIED', false,
        ARRAY[]::job_request_material_change_category[]
      )
    `;
    }),
  ).rejects.toThrow(/classification|effect/u);
}

function reviseBudget(
  versions: ReturnType<typeof createJobRequestVersionRepository>,
  actorUserId: UserId,
  jobRequestId: JobRequestId,
  expectedContentRevision: number,
  mode: "UP_TO",
  maximumAmountCents: number,
) {
  return versions.reviseActiveOwned({
    actorUserId,
    commandId: randomUUID(),
    expectedContentRevision,
    jobRequestId,
    section: normalizeJobRequestContentSection({
      key: "request.budget",
      payload: {
        currency: "EUR",
        maximumAmountCents,
        minimumAmountCents: null,
        mode,
      },
      schemaVersion: 1,
    }),
  });
}
