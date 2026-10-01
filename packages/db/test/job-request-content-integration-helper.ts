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
    WHERE is_active
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
  await verifyFixtureUser(sql, owner.id);

  const drafts = createJobRequestDraftRepository(sql);
  const requests = createJobRequestRepository(sql);
  // Historical schema v1 stays writable/readable during additive migration.
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

/** Runs after the managed v1 release is active, without disturbing older fixtures. */
export async function runJobRequestServiceContentIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const [service] = await sql<
    {
      readonly code: string;
      readonly primaryProfessionCode: string;
    }[]
  >`
    SELECT service_code AS code,
      primary_profession_code AS "primaryProfessionCode"
    FROM current_service_taxonomy
    WHERE state = 'ACTIVE'
    ORDER BY service_code
    LIMIT 1
  `;
  if (service === undefined) {
    throw new Error("Managed taxonomy service fixture is required.");
  }
  const [owner] = await sql<{ readonly id: UserId }[]>`
    INSERT INTO users DEFAULT VALUES RETURNING id
  `;
  if (owner === undefined) throw new Error("Expected service-content owner.");
  const [customer] = await sql<{ readonly id: CustomerProfileId }[]>`
    INSERT INTO customer_profiles (owner_user_id)
    VALUES (${owner.id}) RETURNING id
  `;
  if (customer === undefined)
    throw new Error("Expected service-content profile.");
  await verifyFixtureUser(sql, owner.id);

  const drafts = createJobRequestDraftRepository(sql);
  const serviceCore = normalizeJobRequestDraftSection({
    key: "request.core",
    payload: {
      description: "Montáž integračnej testovacej služby",
      primaryProfessionCode: service.primaryProfessionCode,
      primaryServiceCode: service.code,
      relatedProfessionCodes: [],
      skillCodes: [],
      specializationCode: null,
      title: "Integračná služba",
    },
    schemaVersion: 2,
  });
  const serviceDraft = await drafts.createDraftWithInitialSectionOwned({
    actorUserId: owner.id,
    commandId: randomUUID(),
    customerProfileId: customer.id,
    section: serviceCore,
  });
  if (!("jobRequestId" in serviceDraft)) {
    throw new Error("Expected v2 service draft.");
  }
  await expect(
    drafts.recoverOwned({
      actorUserId: owner.id,
      jobRequestId: serviceDraft.jobRequestId,
    }),
  ).resolves.toMatchObject({
    draft: {
      sections: [
        {
          payload: {
            primaryProfessionCode: service.primaryProfessionCode,
            primaryServiceCode: service.code,
          },
          schemaVersion: 2,
        },
      ],
    },
    status: "OK",
  });
  await expect(
    drafts.autosaveOwned({
      actorUserId: owner.id,
      commandId: randomUUID(),
      expectedRevision: serviceDraft.revision,
      jobRequestId: serviceDraft.jobRequestId,
      section: normalizeJobRequestDraftSection({
        ...serviceCore,
        payload: { ...serviceCore.payload, primaryServiceCode: "SERV:UNKNOWN" },
      }),
    }),
  ).rejects.toThrow(/section content is invalid/u);
}

async function verifyFixtureUser(sql: Sql, userId: UserId): Promise<void> {
  await sql`
    INSERT INTO auth_credentials (
      user_id, normalized_email, password_hash, email_verified_at,
      normalized_phone, phone_verified_at
    ) VALUES (
      ${userId}, ${`${userId}@example.test`},
      'test-fixture-password-hash', clock_timestamp(),
      '+4219' || lpad(
        (abs(hashtextextended(${userId}::text, 41007)) % 100000000)::text,
        8,
        '0'
      ),
      clock_timestamp()
    )
  `;
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
