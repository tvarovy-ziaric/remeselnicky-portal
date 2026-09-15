import { randomUUID } from "node:crypto";

import type { CustomerProfileId, JobRequestId, UserId } from "@portal/domain";
import type { Sql } from "postgres";
import { expect } from "vitest";

import { createJobRequestLifecycleRepository } from "../src/job-request-lifecycle-repository.js";
import { createJobRequestRepository } from "../src/job-request-repository.js";

/** Standalone R3-006 assertions; root wires this after the R3-005 fixture. */
export async function runJobRequestLifecycleIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const [fixture] = await sql<
    Array<{
      readonly actorUserId: UserId;
      readonly customerProfileId: CustomerProfileId;
      readonly jobRequestId: JobRequestId;
      readonly revision: number;
    }>
  >`
    SELECT owner.id AS "actorUserId",
      customer.id AS "customerProfileId",
      current.id AS "jobRequestId", current.revision
    FROM current_job_requests current
    JOIN customer_profiles customer ON customer.id = current.customer_profile_id
    JOIN users owner ON owner.id = customer.owner_user_id
    WHERE current.state::text = 'ACTIVE' AND owner.account_state = 'ACTIVE'
    ORDER BY current.created_at DESC, current.id DESC LIMIT 1
  `;
  if (fixture === undefined) throw new Error("R3-006 requires R3-005 fixture.");
  const lifecycle = createJobRequestLifecycleRepository(sql);
  const extendedCommand = randomUUID();
  const extended = await lifecycle.extendOwned({
    actorUserId: fixture.actorUserId,
    commandId: extendedCommand,
    expectedRevision: fixture.revision,
    jobRequestId: fixture.jobRequestId,
  });
  expect(extended).toMatchObject({
    jobRequest: { revision: fixture.revision + 1, state: "ACTIVE" },
    status: "APPLIED",
  });
  await expect(
    lifecycle.extendOwned({
      actorUserId: fixture.actorUserId,
      commandId: extendedCommand,
      expectedRevision: fixture.revision,
      jobRequestId: fixture.jobRequestId,
    }),
  ).resolves.toMatchObject({ status: "DEDUPLICATED" });

  const duplicateCommand = randomUUID();
  const duplicated = await lifecycle.duplicateOwned({
    actorUserId: fixture.actorUserId,
    commandId: duplicateCommand,
    sourceJobRequestId: fixture.jobRequestId,
  });
  if (!("jobRequestId" in duplicated)) {
    throw new Error("Expected duplicated R3-006 draft.");
  }
  expect(duplicated.status).toBe("APPLIED");
  expect(duplicated.sections.length).toBeGreaterThanOrEqual(2);
  expect(duplicated.jobRequestId).not.toBe(fixture.jobRequestId);
  await expect(
    lifecycle.duplicateOwned({
      actorUserId: fixture.actorUserId,
      commandId: duplicateCommand,
      sourceJobRequestId: fixture.jobRequestId,
    }),
  ).resolves.toMatchObject({
    jobRequestId: duplicated.jobRequestId,
    status: "DEDUPLICATED",
  });
  const [copiedHistory] = await sql<{ readonly count: number }[]>`
    SELECT count(*)::integer AS count FROM job_request_commands
    WHERE job_request_id = ${duplicated.jobRequestId}
  `;
  expect(copiedHistory?.count).toBe(duplicated.revision);

  await sql`
    UPDATE job_request_runtime_policy
    SET active_request_limit = 1, updated_at = clock_timestamp()
    WHERE singleton
  `;
  try {
    await expect(
      createJobRequestRepository(sql).activateOwned({
        actorUserId: fixture.actorUserId,
        commandId: randomUUID(),
        expectedRevision: duplicated.revision,
        jobRequestId: duplicated.jobRequestId,
      }),
    ).resolves.toEqual({ activeLimit: 1, status: "ACTIVE_LIMIT_REACHED" });
  } finally {
    await sql`
      UPDATE job_request_runtime_policy
      SET active_request_limit = 5, updated_at = clock_timestamp()
      WHERE singleton
    `;
  }

  const currentRevision = fixture.revision + 1;
  const cancelled = await lifecycle.cancelOwned({
    actorUserId: fixture.actorUserId,
    commandId: randomUUID(),
    expectedRevision: currentRevision,
    jobRequestId: fixture.jobRequestId,
    reason: "NO_LONGER_NEEDED",
  });
  expect(cancelled).toMatchObject({
    jobRequest: {
      cancellationReason: "NO_LONGER_NEEDED",
      state: "CANCELLED",
    },
    status: "APPLIED",
  });
  const activeInvitations = await sql<{ readonly count: number }[]>`
    SELECT count(*)::integer AS count FROM current_job_invitations
    WHERE job_request_id = ${fixture.jobRequestId}
      AND state IN ('PENDING', 'ENGAGED')
  `;
  expect(activeInvitations[0]?.count).toBe(0);
  const requestClosures = await sql<{ readonly count: number }[]>`
    SELECT count(*)::integer AS count FROM job_invitation_commands command
    JOIN job_invitations invitation ON invitation.id = command.invitation_id
    WHERE invitation.job_request_id = ${fixture.jobRequestId}
      AND command.command_kind = 'REQUEST_CLOSED'
  `;
  expect(requestClosures[0]?.count).toBeGreaterThan(0);
  await expect(
    lifecycle.reactivateOwned({
      actorUserId: fixture.actorUserId,
      commandId: randomUUID(),
      expectedRevision: currentRevision + 1,
      jobRequestId: fixture.jobRequestId,
    }),
  ).resolves.toEqual({ status: "INVALID_TRANSITION" });
  await expect(lifecycle.expireInactive()).resolves.toEqual([]);

  await expect(sql`
    UPDATE job_request_revisions SET state = 'ACTIVE'
    WHERE job_request_id = ${fixture.jobRequestId}
  `).rejects.toThrow(/append-only/u);
}
