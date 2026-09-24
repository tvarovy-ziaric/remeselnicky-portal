import { createHash, randomUUID } from "node:crypto";

import type { PrivilegedActor } from "@portal/admin-auth";
import type { UserId } from "@portal/domain";
import type { Sql } from "postgres";
import { expect } from "vitest";

import { createAdminDisputeRepository } from "../src/admin-dispute-repository.js";
import { createAdminJobCancellationRepository } from "../src/admin-job-cancellation-repository.js";
import { createJobDisputeRepository } from "../src/job-dispute-repository.js";

export async function runAdminDisputeIntegrationAssertions(
  sql: Sql,
  input: { readonly adminId: UserId; readonly privilegedSessionId: string },
): Promise<void> {
  const actor: PrivilegedActor = {
    capabilities: new Set(["admin.disputes.manage", "admin.jobs.correct"]),
    mfaAuthenticatedAt: new Date(),
    roles: ["ADMIN"],
    userId: input.adminId,
  };
  const [fixture] = await sql<
    Array<{
      disputeId: string;
      jobId: string;
      customerUserId: string;
      providerUserId: string;
    }>
  >`
    SELECT dispute.id AS "disputeId", dispute.job_id AS "jobId",
      customer.owner_user_id AS "customerUserId",
      provider.owner_user_id AS "providerUserId"
    FROM current_dispute_cases dispute
    JOIN jobs job ON job.id = dispute.job_id
    JOIN customer_profiles customer ON customer.id = job.customer_profile_id
    JOIN craftsman_profiles provider ON provider.id = job.primary_craftsman_profile_id
    WHERE dispute.state = 'OPEN'
    ORDER BY dispute.created_at DESC LIMIT 1`;
  if (!fixture)
    throw new Error("Open dispute fixture required for admin workflow.");

  const repository = createAdminDisputeRepository(sql);
  const base = {
    actor,
    privilegedSessionId: input.privilegedSessionId,
    disputeId: fixture.disputeId,
    reason: "Syntetické preverenie administratívneho prípadu.",
  };
  const reviewId = randomUUID();
  await expect(
    repository.startReview({
      ...base,
      commandId: reviewId,
      expectedState: "OPEN",
    }),
  ).resolves.toMatchObject({ status: "APPLIED", state: "UNDER_REVIEW" });
  await expect(
    repository.startReview({
      ...base,
      commandId: reviewId,
      expectedState: "OPEN",
    }),
  ).resolves.toMatchObject({ status: "DEDUPLICATED", state: "UNDER_REVIEW" });

  const requestId = randomUUID();
  await expect(
    repository.requestInformation({
      ...base,
      commandId: requestId,
      expectedState: "UNDER_REVIEW",
      recipient: "PRIMARY_PROVIDER",
      requestText: "Doplňte fotografiu opraveného detailu.",
      replyDeadline: new Date(Date.now() + 86_400_000),
    }),
  ).resolves.toMatchObject({ status: "APPLIED", state: "WAITING_FOR_PARTY" });
  const noteId = randomUUID();
  await expect(
    repository.addInternalNote({
      ...base,
      commandId: noteId,
      expectedState: "WAITING_FOR_PARTY",
      note: "Súkromná poznámka pre oprávnený administratívny tím.",
    }),
  ).resolves.toMatchObject({ status: "APPLIED", state: "WAITING_FOR_PARTY" });
  const outcomeId = randomUUID();
  await expect(
    repository.recordOutcome({
      ...base,
      commandId: outcomeId,
      expectedState: "WAITING_FOR_PARTY",
      category: "OPERATIONAL_ADMIN_RESOLUTION",
      basis: "ADMINISTRATIVE_CLOSURE",
      summary: "Odporúčaná je zdokumentovaná oprava bez zmeny prijatej dohody.",
    }),
  ).resolves.toMatchObject({ status: "APPLIED", state: "RESOLVED" });
  const closeId = randomUUID();
  await expect(
    repository.close({
      ...base,
      commandId: closeId,
      expectedState: "RESOLVED",
    }),
  ).resolves.toMatchObject({ status: "APPLIED", state: "CLOSED" });
  const reopenId = randomUUID();
  await expect(
    repository.reopen({
      ...base,
      commandId: reopenId,
      expectedState: "CLOSED",
    }),
  ).resolves.toMatchObject({ status: "APPLIED", state: "UNDER_REVIEW" });

  await expect(
    repository.startReview({
      ...base,
      commandId: randomUUID(),
      expectedState: "OPEN",
    }),
  ).resolves.toEqual({ status: "STALE_STATE" });
  const adminDetail = await repository.getCase({
    actor,
    privilegedSessionId: input.privilegedSessionId,
    disputeId: fixture.disputeId,
    accessId: randomUUID(),
    reason: "Preverenie súkromnej komunikácie k otvorenému prípadu.",
  });
  expect(adminDetail).toMatchObject({
    state: "UNDER_REVIEW",
    informationRequests: [expect.objectContaining({ id: requestId })],
    internalNotes: [expect.objectContaining({ id: noteId })],
    outcomes: [expect.objectContaining({ id: outcomeId })],
  });
  expect(adminDetail?.conversation.length).toBeGreaterThan(0);
  const partyDetail = await createJobDisputeRepository(sql).getCase({
    actorUserId: fixture.providerUserId,
    jobId: fixture.jobId,
    disputeId: fixture.disputeId,
  });
  expect(partyDetail).toMatchObject({
    adminRequests: [expect.objectContaining({ id: requestId })],
    outcome: expect.objectContaining({ id: outcomeId }),
  });
  expect(JSON.stringify(partyDetail)).not.toContain(
    "Súkromná poznámka pre oprávnený administratívny tím.",
  );

  const unauditedId = randomUUID();
  await expect(
    sql.begin(async (tx) => {
      await tx`
        INSERT INTO dispute_case_admin_commands (
          command_id, dispute_id, action, actor_user_id,
          actor_privileged_session_hash, expected_state, reason,
          internal_note, payload_fingerprint, audit_event_id
        ) VALUES (
          ${unauditedId}, ${fixture.disputeId}, 'ADD_INTERNAL_NOTE',
          ${input.adminId}, ${digest(input.privilegedSessionId)}, 'UNDER_REVIEW',
          'Syntetický príkaz bez povinného auditu.', 'Tento zápis sa musí vrátiť.',
          ${"a".repeat(64)}, ${randomUUID()}
        )`;
    }),
  ).rejects.toThrow(/audit event required/iu);

  const [job] = await sql<Array<{ jobId: string; state: string }>>`
    SELECT job.id AS "jobId", state.state::text
    FROM jobs job JOIN current_job_states state ON state.job_id = job.id
    JOIN customer_profiles customer ON customer.id = job.customer_profile_id
    JOIN craftsman_profiles provider ON provider.id = job.primary_craftsman_profile_id
    WHERE state.state IN ('CONFIRMED', 'IN_PROGRESS', 'COMPLETION_REQUESTED')
      AND ${input.adminId} NOT IN (customer.owner_user_id, provider.owner_user_id)
    ORDER BY job.accepted_at DESC LIMIT 1`;
  if (!job) throw new Error("Eligible Job required for admin cancellation.");
  const cancellation = createAdminJobCancellationRepository(sql);
  const cancellationId = randomUUID();
  const cancellationInput = {
    actor,
    privilegedSessionId: input.privilegedSessionId,
    commandId: cancellationId,
    jobId: job.jobId,
    expectedState: job.state as
      "CONFIRMED" | "IN_PROGRESS" | "COMPLETION_REQUESTED",
    reason: "Syntetické administratívne zrušenie po preverení prípadu.",
    userFacingReason:
      "Zákazka bola administratívne zrušená po preverení prípadu.",
  };
  await expect(
    cancellation.forceCancel(cancellationInput),
  ).resolves.toMatchObject({
    status: "APPLIED",
  });
  await expect(
    cancellation.forceCancel(cancellationInput),
  ).resolves.toMatchObject({
    status: "DEDUPLICATED",
  });
  await expect(
    sql<{ state: string }[]>`
      SELECT state::text FROM current_job_states WHERE job_id = ${job.jobId}`,
  ).resolves.toEqual([{ state: "CANCELLED" }]);
  const [auditCount] = await sql<Array<{ count: number }>>`
    SELECT count(*)::integer AS count FROM audit_events
    WHERE correlation_id IN (${reviewId}, ${requestId}, ${noteId}, ${outcomeId},
      ${closeId}, ${reopenId}, ${cancellationId})`;
  expect(auditCount?.count).toBe(7);
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
