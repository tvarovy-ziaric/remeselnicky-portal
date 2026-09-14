import { createHash, randomUUID } from "node:crypto";

import type { Sql } from "postgres";
import { expect } from "vitest";

import type { CustomerProfileId, JobRequestId, UserId } from "@portal/domain";

import { createJobRequestRepository } from "../src/job-request-repository.js";

/** Standalone R3-001 assertions; root wires this after migration 0036. */
export async function runJobRequestIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const [owner] = await sql<{ readonly id: UserId }[]>`
    INSERT INTO users DEFAULT VALUES RETURNING id
  `;
  if (owner === undefined) throw new Error("Expected job-request owner.");
  const [customer] = await sql<{ readonly id: CustomerProfileId }[]>`
    INSERT INTO customer_profiles (owner_user_id)
    VALUES (${owner.id}) RETURNING id
  `;
  if (customer === undefined) throw new Error("Expected customer profile.");

  const repository = createJobRequestRepository(sql);
  const createCommandId = randomUUID();
  const attempts = await Promise.all([
    repository.createDraftOwned({
      actorUserId: owner.id,
      commandId: createCommandId,
      customerProfileId: customer.id,
    }),
    repository.createDraftOwned({
      actorUserId: owner.id,
      commandId: createCommandId,
      customerProfileId: customer.id,
    }),
  ]);
  expect(attempts.map(({ status }) => status).sort()).toEqual([
    "APPLIED",
    "DEDUPLICATED",
  ]);
  const applied = attempts[0];
  if (!("jobRequest" in applied)) throw new Error("Expected persisted draft.");
  const requestId: JobRequestId = applied.jobRequest.id;

  const activationCommandId = randomUUID();
  const activationFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        actorUserId: owner.id,
        expectedRevision: 1,
        jobRequestId: requestId,
        kind: "ACTIVATE",
      }),
    )
    .digest("hex");
  await expect(sql`
    INSERT INTO job_request_commands (
      command_id, job_request_id, customer_profile_id, actor_user_id,
      command_kind, expected_revision, resulting_revision, target_state,
      submission_eligibility_revision, payload_fingerprint
    ) VALUES (
      ${activationCommandId}, ${requestId}, ${customer.id}, ${owner.id},
      'ACTIVATE', 1, 2, 'ACTIVE', 1, ${activationFingerprint}
    )
  `).rejects.toThrow(/submission requirements are not satisfied/u);

  await expect(
    repository.activateOwned({
      actorUserId: owner.id,
      commandId: randomUUID(),
      expectedRevision: 1,
      jobRequestId: requestId,
    }),
  ).resolves.toEqual({
    missingRequirements: ["PRIMARY_PROFESSION", "DESCRIPTION", "MUNICIPALITY"],
    status: "NOT_READY",
  });

  await expect(sql`
    UPDATE job_request_revisions SET state = 'ACTIVE'
    WHERE job_request_id = ${requestId} AND revision = 1
  `).rejects.toThrow(/append-only/u);
  await expect(
    sql`DELETE FROM job_requests WHERE id = ${requestId}`,
  ).rejects.toThrow(/append-only/u);

  await sql`
    UPDATE users
    SET account_state = 'SUSPENDED',
      account_state_changed_at = clock_timestamp(),
      updated_at = clock_timestamp()
    WHERE id = ${owner.id}
  `;
  await expect(
    repository.createDraftOwned({
      actorUserId: owner.id,
      commandId: createCommandId,
      customerProfileId: customer.id,
    }),
  ).resolves.toEqual({ status: "ACCOUNT_NOT_ACTIVE" });
}
