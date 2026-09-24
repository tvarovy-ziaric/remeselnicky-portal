import { randomUUID } from "node:crypto";

import type { Sql } from "postgres";
import { expect } from "vitest";

import { createJobCompletionRepository } from "../src/job-completion-repository.js";
import { createJobMainReviewRepository } from "../src/job-main-review-repository.js";

export async function runMainBilateralReviewCommittedRaceAssertions(
  sql: Sql,
): Promise<void> {
  const [job] = await sql<
    Array<{
      readonly customerUserId: string;
      readonly id: string;
      readonly providerUserId: string;
    }>
  >`
    SELECT job.id, customer.owner_user_id AS "customerUserId",
      provider.owner_user_id AS "providerUserId"
    FROM jobs job
    JOIN current_job_states state ON state.job_id = job.id
    JOIN customer_profiles customer ON customer.id = job.customer_profile_id
    JOIN craftsman_profiles provider
      ON provider.id = job.primary_craftsman_profile_id
    JOIN users customer_actor ON customer_actor.id = customer.owner_user_id
      AND customer_actor.account_state = 'ACTIVE'
    JOIN users provider_actor ON provider_actor.id = provider.owner_user_id
      AND provider_actor.account_state = 'ACTIVE'
    JOIN auth_credentials customer_credential
      ON customer_credential.user_id = customer_actor.id
      AND customer_credential.email_verified_at IS NOT NULL
      AND customer_credential.phone_verified_at IS NOT NULL
    JOIN auth_credentials provider_credential
      ON provider_credential.user_id = provider_actor.id
      AND provider_credential.email_verified_at IS NOT NULL
      AND provider_credential.phone_verified_at IS NOT NULL
    WHERE state.state = 'CONFIRMED'
      AND customer.owner_user_id <> provider.owner_user_id
      AND NOT EXISTS (
        SELECT 1 FROM job_completion_proposals proposal
        WHERE proposal.job_id = job.id
          AND NOT EXISTS (
            SELECT 1 FROM job_completion_proposal_decisions decision
            WHERE decision.proposal_id = proposal.id
          )
      )
    ORDER BY job.accepted_at DESC, job.id DESC
    LIMIT 1
  `;
  if (job === undefined)
    throw new Error("Committed review-race Job fixture missing.");

  await sql`
    INSERT INTO job_lifecycle_commands (
      command_id, job_id, actor_user_id, command_kind, expected_state,
      actor_role, reason, payload_fingerprint
    ) VALUES (
      ${randomUUID()}, ${job.id}, ${job.providerUserId}, 'START',
      'CONFIRMED', 'PRIMARY_PROVIDER', NULL, ${"d".repeat(64)}
    )
  `;
  const completion = createJobCompletionRepository(sql);
  const attemptId = randomUUID();
  expect(
    await completion.request({
      actorUserId: job.providerUserId,
      commandId: attemptId,
      jobId: job.id,
    }),
  ).toMatchObject({ attemptId, status: "APPLIED" });
  expect(
    await completion.accept({
      actorUserId: job.customerUserId,
      attemptId,
      commandId: randomUUID(),
      jobId: job.id,
    }),
  ).toMatchObject({ jobState: "COMPLETED", status: "APPLIED" });

  const ratings = {
    cleanliness: null,
    communication: 5 as const,
    price_adherence: null,
    problem_solving: null,
    schedule_adherence: null,
    work_quality: 5 as const,
    would_hire_again: 5 as const,
  };
  const winnerCommandId = randomUUID();
  let signalWinnerReady: () => void = () => undefined;
  let rejectWinnerReady: (error: unknown) => void = () => undefined;
  let releaseWinner: () => void = () => undefined;
  const winnerReady = new Promise<void>((resolve, reject) => {
    signalWinnerReady = resolve;
    rejectWinnerReady = reject;
  });
  const release = new Promise<void>((resolve) => {
    releaseWinner = resolve;
  });
  const winner = sql.begin(async (tx) => {
    try {
      const result = await createJobMainReviewRepository(tx).submit({
        actorUserId: job.customerUserId,
        commandId: winnerCommandId,
        expectedVersion: 0,
        jobId: job.id,
        ratings,
      });
      expect(result.status).toBe("APPLIED");
      signalWinnerReady();
      await release;
      return result;
    } catch (error) {
      rejectWinnerReady(error);
      throw error;
    }
  });
  await winnerReady;

  let signalLoserStarted: (pid: number) => void = () => undefined;
  const loserStarted = new Promise<number>((resolve) => {
    signalLoserStarted = resolve;
  });
  const loser = sql.begin(async (tx) => {
    const [connection] = await tx<Array<{ readonly pid: number }>>`
      SELECT pg_backend_pid() AS pid
    `;
    if (connection === undefined)
      throw new Error("Committed review-race connection missing.");
    signalLoserStarted(connection.pid);
    return createJobMainReviewRepository(tx).submit({
      actorUserId: job.customerUserId,
      commandId: randomUUID(),
      expectedVersion: 0,
      jobId: job.id,
      ratings: { ...ratings, communication: 4 },
    });
  });
  try {
    const loserPid = await Promise.race([
      loserStarted,
      loser.then(() => {
        throw new Error("Competing review ended before waiting for Job lock.");
      }),
    ]);
    await waitForJobLock(sql, loserPid);
  } finally {
    releaseWinner();
  }

  const [winningResult, losingResult] = await Promise.all([winner, loser]);
  expect(winningResult.status).toBe("APPLIED");
  expect(losingResult).toEqual({ status: "STALE_VERSION" });
  if (winningResult.status !== "APPLIED")
    throw new Error("Committed review-race winner was not persisted.");
  await expect(
    createJobMainReviewRepository(sql).submit({
      actorUserId: job.customerUserId,
      commandId: winnerCommandId,
      expectedVersion: 0,
      jobId: job.id,
      ratings,
    }),
  ).resolves.toMatchObject({
    revisionId: winningResult.revisionId,
    status: "DEDUPLICATED",
    version: 1,
  });
  const [effects] = await sql<
    Array<{ readonly eventCount: number; readonly maxVersion: number }>
  >`
    SELECT count(*)::integer AS "eventCount",
      max(version)::integer AS "maxVersion"
    FROM job_main_review_events
    WHERE job_id = ${job.id}
      AND direction = 'CUSTOMER_TO_PROVIDER'
  `;
  expect(effects).toEqual({ eventCount: 1, maxVersion: 1 });
}

async function waitForJobLock(sql: Sql, pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const [waiting] = await sql<Array<{ readonly blocked: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE pid = ${pid} AND wait_event_type = 'Lock'
          AND query LIKE '%jobs%FOR UPDATE%'
      ) AS blocked
    `;
    if (waiting?.blocked === true) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Competing review did not wait for the Job row lock.");
}
