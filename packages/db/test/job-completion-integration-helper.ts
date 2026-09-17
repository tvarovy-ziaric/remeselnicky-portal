import { randomUUID } from "node:crypto";

import type { Sql } from "postgres";
import { expect } from "vitest";

import {
  createJobCompletionRepository,
  JobCompletionIdempotencyError,
} from "../src/job-completion-repository.js";
import {
  CompletionProposalIdempotencyError,
  createCustomerCompletionProposalRepository,
} from "../src/customer-completion-proposal-repository.js";

const rollback = new Error("rollback isolated completion assertions");

/** Exercises the complete handover cycle and rolls it back to preserve other fixtures. */
export async function runJobCompletionIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  await expect(
    sql.begin(async (tx) => {
      const [job] = await tx<
        Array<{ id: string; customerUserId: string; providerUserId: string }>
      >`
      SELECT job.id, customer.owner_user_id AS "customerUserId",
        provider.owner_user_id AS "providerUserId"
      FROM jobs job
      JOIN customer_profiles customer ON customer.id = job.customer_profile_id
      JOIN craftsman_profiles provider ON provider.id = job.primary_craftsman_profile_id
      JOIN current_job_states state ON state.job_id = job.id
      WHERE state.state = 'CONFIRMED'
      ORDER BY job.accepted_at DESC, job.id DESC LIMIT 1
    `;
      if (!job) throw new Error("Confirmed completion Job fixture missing.");
      const startId = randomUUID();
      await tx`
      INSERT INTO job_lifecycle_commands (
        command_id, job_id, actor_user_id, command_kind, expected_state,
        actor_role, reason, payload_fingerprint
      ) VALUES (${startId}, ${job.id}, ${job.providerUserId}, 'START',
        'CONFIRMED', 'PRIMARY_PROVIDER', NULL, ${"a".repeat(64)})
    `;
      const repository = createJobCompletionRepository(tx);
      const proposals = createCustomerCompletionProposalRepository(tx);
      expect(
        await proposals.list({ actorUserId: randomUUID(), jobId: job.id }),
      ).toBeNull();
      expect(
        await proposals.propose({
          actorUserId: job.providerUserId,
          commandId: randomUUID(),
          jobId: job.id,
        }),
      ).toEqual({ status: "NOT_FOUND" });
      const proposalId = randomUUID();
      const proposed = {
        actorUserId: job.customerUserId,
        commandId: proposalId,
        jobId: job.id,
        note: "Práce sa javia ako dokončené.",
      };
      expect(await proposals.propose(proposed)).toMatchObject({
        status: "APPLIED",
        proposalId,
      });
      expect(await proposals.propose(proposed)).toMatchObject({
        status: "DEDUPLICATED",
        proposalId,
      });
      await expect(
        proposals.propose({ ...proposed, note: "Iný obsah návrhu." }),
      ).rejects.toBeInstanceOf(CompletionProposalIdempotencyError);
      expect(
        await proposals.propose({
          ...proposed,
          commandId: randomUUID(),
        }),
      ).toEqual({ status: "STALE_PROPOSAL" });
      expect(
        await proposals.list({ actorUserId: job.providerUserId, jobId: job.id }),
      ).toMatchObject([{ id: proposalId, outcome: "PENDING" }]);
      await expect(
        repository.request({
          actorUserId: job.providerUserId,
          commandId: randomUUID(),
          jobId: job.id,
        }),
      ).rejects.toThrow("resolve customer completion proposal first");
      expect(
        await proposals.agree({
          actorUserId: job.customerUserId,
          commandId: randomUUID(),
          jobId: job.id,
          proposalId,
        }),
      ).toEqual({ status: "NOT_FOUND" });
      const disagreementId = randomUUID();
      const disagreement = {
        actorUserId: job.providerUserId,
        commandId: disagreementId,
        jobId: job.id,
        proposalId,
        reason: "Ešte treba dokončiť odovzdanie.",
      };
      expect(await proposals.disagree(disagreement)).toMatchObject({
        status: "APPLIED",
        proposalId,
      });
      expect(await proposals.disagree(disagreement)).toMatchObject({
        status: "DEDUPLICATED",
        proposalId,
      });
      expect(
        await proposals.list({ actorUserId: job.customerUserId, jobId: job.id }),
      ).toMatchObject([{ id: proposalId, outcome: "DISAGREE" }]);
      const secondProposalId = randomUUID();
      expect(
        await proposals.propose({
          actorUserId: job.customerUserId,
          commandId: secondProposalId,
          jobId: job.id,
        }),
      ).toMatchObject({ status: "APPLIED", proposalId: secondProposalId });
      expect(
        await proposals.agree({
          actorUserId: job.providerUserId,
          commandId: randomUUID(),
          jobId: job.id,
          proposalId,
        }),
      ).toEqual({ status: "STALE_PROPOSAL" });
      const agreementId = randomUUID();
      expect(
        await proposals.agree({
          actorUserId: job.providerUserId,
          commandId: agreementId,
          jobId: job.id,
          proposalId: secondProposalId,
        }),
      ).toMatchObject({ status: "APPLIED", proposalId: secondProposalId });
      const [stateAfterAgreement] = await tx<Array<{ state: string }>>`
        SELECT state::text FROM current_job_states WHERE job_id = ${job.id}
      `;
      expect(stateAfterAgreement?.state).toBe("IN_PROGRESS");
      const proposalNotices = await tx<Array<{ eventName: string; payload: unknown }>>`
        SELECT event_name AS "eventName", payload FROM domain_outbox_events
        WHERE idempotency_key IN (
          ${`job.completion.proposal.${proposalId}`},
          ${`job.completion.proposal.${disagreementId}`},
          ${`job.completion.proposal.${secondProposalId}`},
          ${`job.completion.proposal.${agreementId}`})
      `;
      expect(proposalNotices.map((notice) => notice.eventName).sort()).toEqual([
        "job.completion.proposal_agreed",
        "job.completion.proposal_disagreed",
        "job.completion.proposed",
        "job.completion.proposed",
      ]);
      expect(JSON.stringify(proposalNotices)).not.toContain(proposed.note);
      expect(JSON.stringify(proposalNotices)).not.toContain(disagreement.reason);
      await expect(
        tx.savepoint(async (savepoint) => {
          await savepoint`DELETE FROM job_completion_proposals WHERE id = ${proposalId}`;
        }),
      ).rejects.toThrow("immutable");
      expect(
        await repository.list({ actorUserId: randomUUID(), jobId: job.id }),
      ).toBeNull();
      expect(
        await repository.request({
          actorUserId: job.customerUserId,
          commandId: randomUUID(),
          jobId: job.id,
        }),
      ).toEqual({ status: "NOT_FOUND" });
      await expect(
        repository.request({
          actorUserId: job.providerUserId,
          commandId: randomUUID(),
          jobId: job.id,
          finalMediaAssetIds: [randomUUID()],
        }),
      ).rejects.toThrow("same-Job READY private provider media required");
      await expect(
        repository.request({
          actorUserId: job.providerUserId,
          commandId: randomUUID(),
          jobId: job.id,
          physicalWorkFinishedOn: "2026-02-30",
        }),
      ).rejects.toThrow("Invalid physical work-finished date");
      await expect(
        tx.savepoint(async (savepoint) => {
          await savepoint`
        INSERT INTO job_completion_attempts (
          id, job_id, attempt_number, requested_by_user_id, payload_fingerprint
        ) VALUES (${randomUUID()}, ${job.id}, 1,
          ${job.customerUserId}, ${"b".repeat(64)})
      `;
        }),
      ).rejects.toThrow("active primary provider");
      const firstId = randomUUID();
      const first = {
        actorUserId: job.providerUserId,
        commandId: firstId,
        jobId: job.id,
        note: "Práce sú dokončené.",
      };
      expect(await repository.request(first)).toMatchObject({
        status: "APPLIED",
        jobState: "COMPLETION_REQUESTED",
        attemptId: firstId,
      });
      expect(await repository.request(first)).toMatchObject({
        status: "DEDUPLICATED",
      });
      await expect(
        repository.request({ ...first, note: "Iný odovzdávací text." }),
      ).rejects.toBeInstanceOf(JobCompletionIdempotencyError);
      expect(
        await repository.request({ ...first, commandId: randomUUID() }),
      ).toEqual({ status: "STALE_STATE" });
      expect(
        (
          await repository.list({
            actorUserId: job.customerUserId,
            jobId: job.id,
          })
        )?.attempts[0],
      ).toMatchObject({
        id: firstId,
        attemptNumber: 1,
        outcome: "PENDING",
        note: "Práce sú dokončené.",
      });
      expect(
        await repository.accept({
          actorUserId: job.providerUserId,
          commandId: randomUUID(),
          jobId: job.id,
          attemptId: firstId,
        }),
      ).toEqual({ status: "NOT_FOUND" });
      await expect(
        tx.savepoint(async (savepoint) => {
          await savepoint`
        INSERT INTO job_completion_decisions (
          id, attempt_id, kind, actor_user_id, payload_fingerprint
        ) VALUES (${randomUUID()}, ${firstId}, 'ACCEPT',
          ${job.providerUserId}, ${"c".repeat(64)})
      `;
        }),
      ).rejects.toThrow("exact pending completion attempt");
      expect(
        await repository.reject({
          actorUserId: job.customerUserId,
          commandId: randomUUID(),
          jobId: job.id,
          attemptId: randomUUID(),
          category: "DEFECT",
          reason: "Chýba oprava poškodeného miesta.",
        }),
      ).toEqual({ status: "STALE_ATTEMPT" });
      const rejectId = randomUUID();
      const rejection = {
        actorUserId: job.customerUserId,
        commandId: rejectId,
        jobId: job.id,
        attemptId: firstId,
        category: "DEFECT" as const,
        reason: "Chýba oprava poškodeného miesta.",
      };
      expect(await repository.reject(rejection)).toMatchObject({
        status: "APPLIED",
        jobState: "IN_PROGRESS",
        attemptId: firstId,
      });
      expect(await repository.reject(rejection)).toMatchObject({
        status: "DEDUPLICATED",
        jobState: "IN_PROGRESS",
      });
      expect(
        await repository.accept({
          actorUserId: job.customerUserId,
          commandId: randomUUID(),
          jobId: job.id,
          attemptId: firstId,
        }),
      ).toEqual({ status: "STALE_STATE" });
      const secondId = randomUUID();
      expect(
        await repository.request({
          actorUserId: job.providerUserId,
          commandId: secondId,
          jobId: job.id,
        }),
      ).toMatchObject({ status: "APPLIED" });
      expect(
        await repository.withdraw({
          actorUserId: job.providerUserId,
          commandId: randomUUID(),
          jobId: job.id,
          attemptId: secondId,
          reason: "Potrebujeme odsúhlasiť novú zmenu rozsahu.",
        }),
      ).toMatchObject({ status: "APPLIED", jobState: "IN_PROGRESS" });
      const thirdId = randomUUID();
      expect(
        await repository.request({
          actorUserId: job.providerUserId,
          commandId: thirdId,
          jobId: job.id,
          physicalWorkFinishedOn: "2026-09-17",
        }),
      ).toMatchObject({ status: "APPLIED", attemptId: thirdId });
      const acceptId = randomUUID();
      expect(
        await repository.accept({
          actorUserId: job.customerUserId,
          commandId: acceptId,
          jobId: job.id,
          attemptId: thirdId,
        }),
      ).toMatchObject({ status: "APPLIED", jobState: "COMPLETED" });
      const history = await repository.list({
        actorUserId: job.providerUserId,
        jobId: job.id,
      });
      expect(history?.jobState).toBe("COMPLETED");
      expect(history?.attempts.map((attempt) => attempt.outcome)).toEqual([
        "ACCEPTED",
        "WITHDRAWN",
        "REJECTED",
      ]);
      expect(history?.attempts[0]?.physicalWorkFinishedOn).toBe("2026-09-17");
      expect(history?.attempts[0]?.decidedAt).toBeInstanceOf(Date);
      const [state] = await tx<Array<{ state: string }>>`
      SELECT state::text FROM current_job_states WHERE job_id = ${job.id}
    `;
      expect(state?.state).toBe("COMPLETED");
      expect(
        await repository.request({
          actorUserId: job.providerUserId,
          commandId: randomUUID(),
          jobId: job.id,
        }),
      ).toEqual({ status: "STALE_STATE" });
      const notices = await tx<
        Array<{ eventName: string; payload: Record<string, unknown> }>
      >`
      SELECT event_name AS "eventName", payload FROM domain_outbox_events
      WHERE idempotency_key IN (
        ${`job.completion.${firstId}`}, ${`job.completion.${rejectId}`},
        ${`job.completion.${acceptId}`})
      ORDER BY occurred_at
    `;
      expect(notices.map((notice) => notice.eventName)).toEqual([
        "job.completion.requested",
        "job.completion.rejected",
        "job.completion.accepted",
      ]);
      expect(JSON.stringify(notices)).not.toContain(rejection.reason);
      await expect(
        tx.savepoint(async (savepoint) => {
          await savepoint`UPDATE job_completion_attempts SET note = NULL WHERE id = ${firstId}`;
        }),
      ).rejects.toThrow("immutable");
      await expect(
        tx.savepoint(async (savepoint) => {
          await savepoint`DELETE FROM job_completion_decisions WHERE id = ${acceptId}`;
        }),
      ).rejects.toThrow("immutable");
      throw rollback;
    }),
  ).rejects.toBe(rollback);
}
