import { randomUUID } from "node:crypto";

import {
  normalizeJobRequestDraftSection,
  type CustomerProfileId,
  type UserId,
} from "@portal/domain";
import type { Sql } from "postgres";
import { expect } from "vitest";

import { createJobRequestDraftRepository } from "../src/job-request-draft-repository.js";
import { createJobRequestRepository } from "../src/job-request-repository.js";

/** Standalone R3-004 assertions; root wires this after migration 0038. */
export async function runJobRequestContentIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const [profession] = await sql<{ readonly code: string }[]>`
    SELECT profession_code AS code
    FROM current_profession_taxonomy
    WHERE state = 'ACTIVE'
    ORDER BY profession_code
    LIMIT 1
  `;
  const [municipality] = await sql<{ readonly code: string }[]>`
    SELECT code FROM location_municipalities
    WHERE active
    ORDER BY code
    LIMIT 1
  `;
  if (profession === undefined || municipality === undefined) {
    throw new Error("R3-004 requires governed taxonomy and location fixtures.");
  }

  const [owner] = await sql<{ readonly id: UserId }[]>`
    INSERT INTO users DEFAULT VALUES RETURNING id
  `;
  if (owner === undefined)
    throw new Error("Expected job-request content owner.");
  const [customer] = await sql<{ readonly id: CustomerProfileId }[]>`
    INSERT INTO customer_profiles (owner_user_id)
    VALUES (${owner.id}) RETURNING id
  `;
  if (customer === undefined) throw new Error("Expected customer profile.");

  const drafts = createJobRequestDraftRepository(sql);
  const requests = createJobRequestRepository(sql);
  const core = normalizeJobRequestDraftSection({
    key: "request.core",
    payload: {
      description: "Oprava zatekajúcej strechy",
      primaryProfessionCode: profession.code,
      relatedProfessionCodes: [],
      skillCodes: [],
      specializationCode: null,
      title: "Oprava strechy",
    },
    schemaVersion: 1,
  });
  const created = await drafts.createDraftWithInitialSectionOwned({
    actorUserId: owner.id,
    commandId: randomUUID(),
    customerProfileId: customer.id,
    section: core,
  });
  if (!("jobRequestId" in created) || created.status !== "APPLIED") {
    throw new Error("Expected request draft with initial content.");
  }
  const requestId = created.jobRequestId;

  const location = await drafts.autosaveOwned({
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
  if (!("revision" in location) || location.status !== "APPLIED") {
    throw new Error("Expected location autosave.");
  }

  await expect(
    drafts.autosaveOwned({
      actorUserId: owner.id,
      commandId: randomUUID(),
      expectedRevision: location.revision,
      jobRequestId: requestId,
      section: normalizeJobRequestDraftSection({
        key: "request.unreviewed",
        payload: { arbitrary: "payload" },
        schemaVersion: 1,
      }),
    }),
  ).rejects.toThrow(/section content is invalid/u);

  await expect(
    drafts.autosaveOwned({
      actorUserId: owner.id,
      commandId: randomUUID(),
      expectedRevision: location.revision,
      jobRequestId: requestId,
      section: normalizeJobRequestDraftSection({
        key: "request.location",
        payload: { municipalityCode: "SK-NOT-GOVERNED" },
        schemaVersion: 1,
      }),
    }),
  ).rejects.toThrow(/section content is invalid/u);

  const activated = await requests.activateOwned({
    actorUserId: owner.id,
    commandId: randomUUID(),
    expectedRevision: location.revision,
    jobRequestId: requestId,
  });
  expect(activated).toMatchObject({
    jobRequest: {
      id: requestId,
      revision: location.revision + 1,
      state: "ACTIVE",
    },
    status: "APPLIED",
  });

  await expect(
    drafts.autosaveOwned({
      actorUserId: owner.id,
      commandId: randomUUID(),
      expectedRevision: location.revision + 1,
      jobRequestId: requestId,
      section: core,
    }),
  ).resolves.toEqual({ status: "INVALID_STATE" });

  await assertRequiredFieldsRemainFailClosed({
    customerProfileId: customer.id,
    drafts,
    ownerUserId: owner.id,
    requests,
  });
}

async function assertRequiredFieldsRemainFailClosed(input: {
  readonly customerProfileId: CustomerProfileId;
  readonly drafts: ReturnType<typeof createJobRequestDraftRepository>;
  readonly ownerUserId: UserId;
  readonly requests: ReturnType<typeof createJobRequestRepository>;
}): Promise<void> {
  const created = await input.drafts.createDraftWithInitialSectionOwned({
    actorUserId: input.ownerUserId,
    commandId: randomUUID(),
    customerProfileId: input.customerProfileId,
    section: normalizeJobRequestDraftSection({
      key: "request.core",
      payload: { description: "Iba popis bez povinných výberov" },
      schemaVersion: 1,
    }),
  });
  if (!("jobRequestId" in created))
    throw new Error("Expected incomplete draft.");
  await expect(
    input.requests.activateOwned({
      actorUserId: input.ownerUserId,
      commandId: randomUUID(),
      expectedRevision: created.revision,
      jobRequestId: created.jobRequestId,
    }),
  ).resolves.toEqual({
    missingRequirements: ["PRIMARY_PROFESSION", "MUNICIPALITY"],
    status: "NOT_READY",
  });
}
