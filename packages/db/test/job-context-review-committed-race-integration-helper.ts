import { randomUUID } from "node:crypto";

import type { Sql } from "postgres";
import { expect } from "vitest";

import { createJobCompletionRepository } from "../src/job-completion-repository.js";
import { createJobContextReviewRepository } from "../src/job-context-review-repository.js";
import { createJobParticipationRepository } from "../src/job-participation-repository.js";

interface Fixture {
  readonly customerUserId: string;
  readonly jobId: string;
  readonly providerUserId: string;
  readonly targetProfileId: string;
  readonly targetUserId: string;
}

const ratings = Object.freeze({
  cleanliness: null,
  communication: 5 as const,
  price_adherence: null,
  problem_solving: 4 as const,
  schedule_adherence: null,
  work_quality: 5 as const,
  would_hire_again: 5 as const,
});

export async function runJobContextReviewCommittedRaceAssertions(
  sql: Sql,
): Promise<void> {
  const [fixture] = await sql<Fixture[]>`
    SELECT job.id AS "jobId",
      customer.owner_user_id AS "customerUserId",
      provider.owner_user_id AS "providerUserId",
      target.id AS "targetProfileId",
      target.owner_user_id AS "targetUserId"
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
    JOIN craftsman_profiles target ON target.profile_type = 'INDIVIDUAL'
      AND target.owner_user_id <> customer.owner_user_id
      AND target.owner_user_id <> provider.owner_user_id
    JOIN users target_actor ON target_actor.id = target.owner_user_id
      AND target_actor.account_state = 'ACTIVE'
    JOIN auth_credentials target_credential
      ON target_credential.user_id = target_actor.id
      AND target_credential.email_verified_at IS NOT NULL
      AND target_credential.phone_verified_at IS NOT NULL
    WHERE state.state = 'CONFIRMED'
      AND customer.owner_user_id <> provider.owner_user_id
      AND NOT EXISTS (
        SELECT 1 FROM current_job_participants participant
        WHERE participant.job_id = job.id
          AND participant.craftsman_profile_id = target.id
          AND participant.state IN ('INVITED', 'ACCEPTED')
      )
      AND NOT EXISTS (
        SELECT 1 FROM job_completion_proposals proposal
        WHERE proposal.job_id = job.id
          AND NOT EXISTS (
            SELECT 1 FROM job_completion_proposal_decisions decision
            WHERE decision.proposal_id = proposal.id
          )
      )
    ORDER BY job.accepted_at DESC, job.id DESC, target.id
    LIMIT 1
  `;
  if (fixture === undefined)
    throw new Error("Committed context-review race fixture missing.");

  const participation = createJobParticipationRepository(sql);
  const invitation = await participation.invite({
    actorUserId: fixture.providerUserId,
    commandId: randomUUID(),
    craftsmanProfileId: fixture.targetProfileId,
    jobId: fixture.jobId,
  });
  expect(invitation.status).toBe("APPLIED");
  if (!("participantId" in invitation))
    throw new Error("Committed context-review participant identity missing.");
  const participantId = invitation.participantId;
  expect(
    await participation.decide({
      actorUserId: fixture.targetUserId,
      commandId: randomUUID(),
      decision: "ACCEPT",
      participantId,
    }),
  ).toMatchObject({ state: "ACCEPTED", status: "APPLIED" });

  await sql`
    INSERT INTO job_lifecycle_commands (
      command_id, job_id, actor_user_id, command_kind, expected_state,
      actor_role, reason, payload_fingerprint
    ) VALUES (
      ${randomUUID()}, ${fixture.jobId}, ${fixture.providerUserId}, 'START',
      'CONFIRMED', 'PRIMARY_PROVIDER', NULL, ${"f".repeat(64)}
    )
  `;
  const completion = createJobCompletionRepository(sql);
  const attemptId = randomUUID();
  expect(
    await completion.request({
      actorUserId: fixture.providerUserId,
      commandId: attemptId,
      jobId: fixture.jobId,
    }),
  ).toMatchObject({ attemptId, status: "APPLIED" });
  expect(
    await completion.accept({
      actorUserId: fixture.customerUserId,
      attemptId,
      commandId: randomUUID(),
      jobId: fixture.jobId,
    }),
  ).toMatchObject({ jobState: "COMPLETED", status: "APPLIED" });

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
      const result = await createJobContextReviewRepository(tx).submit({
        actorUserId: fixture.customerUserId,
        commandId: winnerCommandId,
        expectedVersion: 0,
        jobId: fixture.jobId,
        ratings,
        targetId: participantId,
        targetKind: "PARTICIPANT",
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
      throw new Error("Committed context-review race connection missing.");
    signalLoserStarted(connection.pid);
    return createJobContextReviewRepository(tx).submit({
      actorUserId: fixture.customerUserId,
      commandId: randomUUID(),
      expectedVersion: 0,
      jobId: fixture.jobId,
      ratings: { ...ratings, communication: 4 },
      targetId: participantId,
      targetKind: "PARTICIPANT",
    });
  });
  try {
    const loserPid = await Promise.race([
      loserStarted,
      loser.then(() => {
        throw new Error(
          "Competing context review ended before waiting for Job lock.",
        );
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
    throw new Error("Committed context-review race winner was not persisted.");
  await expect(
    createJobContextReviewRepository(sql).submit({
      actorUserId: fixture.customerUserId,
      commandId: winnerCommandId,
      expectedVersion: 0,
      jobId: fixture.jobId,
      ratings,
      targetId: participantId,
      targetKind: "PARTICIPANT",
    }),
  ).resolves.toMatchObject({
    revisionId: winningResult.revisionId,
    status: "DEDUPLICATED",
    targetId: participantId,
    targetKind: "PARTICIPANT",
    version: 1,
  });
  const [effects] = await sql<
    Array<{
      readonly eventCount: number;
      readonly maxVersion: number;
      readonly versionOneCount: number;
    }>
  >`
    SELECT count(*)::integer AS "eventCount",
      count(*) FILTER (WHERE revision.version = 1)::integer
        AS "versionOneCount",
      max(revision.version)::integer AS "maxVersion"
    FROM job_context_review_revisions revision
    JOIN job_context_reviews review ON review.review_id = revision.review_id
    WHERE review.job_id = ${fixture.jobId}
      AND review.target_kind = 'PARTICIPANT'
      AND review.participant_id = ${participantId}
  `;
  expect(effects).toEqual({
    eventCount: 1,
    maxVersion: 1,
    versionOneCount: 1,
  });
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
  throw new Error(
    "Competing context review did not wait for the Job row lock.",
  );
}
