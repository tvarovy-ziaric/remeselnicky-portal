import { randomUUID } from "node:crypto";

import type { Sql } from "postgres";
import { expect } from "vitest";

import {
  JobRequestDraftIdempotencyError,
  normalizeJobRequestDraftSection,
  type CustomerProfileId,
  type UserId,
} from "@portal/domain";

import { createJobRequestDraftRepository } from "../src/job-request-draft-repository.js";

export async function runJobRequestDraftIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const repository = createJobRequestDraftRepository(sql);
  const owner = randomUUID() as UserId;
  const customer = randomUUID() as CustomerProfileId;
  const foreign = randomUUID() as UserId;
  const foreignCustomer = randomUUID() as CustomerProfileId;
  await sql`INSERT INTO users (id) VALUES (${owner}), (${foreign})`;
  await sql`
    INSERT INTO customer_profiles (id, owner_user_id)
    VALUES (${customer}, ${owner}), (${foreignCustomer}, ${foreign})
  `;

  const initial = normalizeJobRequestDraftSection({
    key: "request.basics",
    payload: { description: "Oprava strechy", urgency: "NORMAL" },
    schemaVersion: 1,
  });
  const createCommand = randomUUID();
  const created = await repository.createDraftWithInitialSectionOwned({
    actorUserId: owner,
    commandId: createCommand,
    customerProfileId: customer,
    section: initial,
  });
  expect(created).toMatchObject({ revision: 1, status: "APPLIED" });
  if (!("jobRequestId" in created)) {
    throw new Error("Expected an atomically created draft.");
  }
  const request = created.jobRequestId;
  await expect(
    repository.createDraftWithInitialSectionOwned({
      actorUserId: owner,
      commandId: createCommand,
      customerProfileId: customer,
      section: initial,
    }),
  ).resolves.toMatchObject({
    jobRequestId: request,
    originalStatus: "APPLIED",
    revision: 1,
    status: "DEDUPLICATED",
  });

  await expect(
    repository.recoverOwned({ actorUserId: owner, jobRequestId: request }),
  ).resolves.toMatchObject({
    draft: { id: request, revision: 1, sections: [{ key: "request.basics" }] },
    status: "OK",
  });

  const location = normalizeJobRequestDraftSection({
    key: "request.location",
    payload: { municipalityCode: "TEST:MUNICIPALITY:001" },
    schemaVersion: 1,
  });
  await expect(
    repository.autosaveOwned({
      actorUserId: owner,
      commandId: randomUUID(),
      expectedRevision: 1,
      jobRequestId: request,
      section: location,
    }),
  ).resolves.toMatchObject({ revision: 2, status: "APPLIED" });

  const unchangedCommand = randomUUID();
  await expect(
    repository.autosaveOwned({
      actorUserId: owner,
      commandId: unchangedCommand,
      expectedRevision: 2,
      jobRequestId: request,
      section: normalizeJobRequestDraftSection({
        key: "request.location",
        payload: { municipalityCode: "TEST:MUNICIPALITY:001" },
        schemaVersion: 1,
      }),
    }),
  ).resolves.toMatchObject({ revision: 2, status: "UNCHANGED" });
  const [unchangedEffects] = await sql<{ count: number }[]>`
    SELECT count(*)::integer AS count
    FROM job_request_revisions
    WHERE command_id = ${unchangedCommand}
  `;
  expect(unchangedEffects?.count).toBe(0);

  await expect(
    repository.autosaveOwned({
      actorUserId: owner,
      commandId: unchangedCommand,
      expectedRevision: 2,
      jobRequestId: request,
      section: normalizeJobRequestDraftSection({
        key: "request.location",
        payload: { municipalityCode: "TEST:MUNICIPALITY:999" },
        schemaVersion: 1,
      }),
    }),
  ).rejects.toBeInstanceOf(JobRequestDraftIdempotencyError);

  const race = await Promise.all([
    repository.autosaveOwned({
      actorUserId: owner,
      commandId: randomUUID(),
      expectedRevision: 2,
      jobRequestId: request,
      section: normalizeJobRequestDraftSection({
        key: "request.schedule",
        payload: { window: "FLEXIBLE" },
        schemaVersion: 1,
      }),
    }),
    repository.autosaveOwned({
      actorUserId: owner,
      commandId: randomUUID(),
      expectedRevision: 2,
      jobRequestId: request,
      section: normalizeJobRequestDraftSection({
        key: "request.materials",
        payload: { suppliedByCustomer: false },
        schemaVersion: 1,
      }),
    }),
  ]);
  expect(race.map(({ status }) => status).sort()).toEqual([
    "APPLIED",
    "STALE_REVISION",
  ]);

  const nearBoundary = normalizeJobRequestDraftSection({
    key: "request.boundary",
    payload: {
      a: "a".repeat(7_900),
      b: "b".repeat(7_900),
      c: "c".repeat(7_900),
      d: "d".repeat(7_900),
    },
    schemaVersion: 1,
  });
  const recovered = await repository.recoverOwned({
    actorUserId: owner,
    jobRequestId: request,
  });
  if (recovered.status !== "OK") throw new Error("Expected draft recovery.");
  await expect(
    repository.autosaveOwned({
      actorUserId: owner,
      commandId: randomUUID(),
      expectedRevision: recovered.draft.revision,
      jobRequestId: request,
      section: nearBoundary,
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });

  await expect(
    repository.recoverOwned({ actorUserId: foreign, jobRequestId: request }),
  ).resolves.toEqual({ status: "NOT_FOUND" });
  await sql`
    UPDATE users SET account_state = 'SUSPENDED',
      account_state_changed_at = clock_timestamp(),
      updated_at = clock_timestamp()
    WHERE id = ${owner}
  `;
  await expect(
    repository.recoverOwned({ actorUserId: owner, jobRequestId: request }),
  ).resolves.toEqual({ status: "ACCOUNT_NOT_ACTIVE" });
  await expect(repository.listRecentOwned(owner)).resolves.toEqual({
    status: "ACCOUNT_NOT_ACTIVE",
  });
  await sql`
    UPDATE users SET account_state = 'ACTIVE',
      account_state_changed_at = clock_timestamp(),
      updated_at = clock_timestamp()
    WHERE id = ${owner}
  `;

  await expect(
    sql`UPDATE job_request_draft_section_revisions SET payload = '{}'::jsonb
      WHERE job_request_id = ${request}`,
  ).rejects.toThrow();
  await expect(
    sql`DELETE FROM job_request_draft_section_revisions
      WHERE job_request_id = ${request}`,
  ).rejects.toThrow();
  const [deepPayload] = await sql<{ bounded: boolean }[]>`
    SELECT job_request_draft_json_is_bounded(
      '{"nested":{"too":{"deep":{"for":{"the":{"bounded":{"draft":{"transport":{"guard":true}}}}}}}}}'::jsonb
    ) AS bounded
  `;
  expect(deepPayload?.bounded).toBe(false);

  const [history] = await sql<{ count: number }[]>`
    SELECT count(*)::integer AS count
    FROM job_request_draft_section_revisions
    WHERE job_request_id = ${request}
  `;
  expect(history?.count).toBeGreaterThanOrEqual(4);
}
