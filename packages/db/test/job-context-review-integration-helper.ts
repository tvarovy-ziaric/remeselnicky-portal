import { randomUUID } from "node:crypto";

import type { Sql } from "postgres";
import { expect } from "vitest";

import { createJobCompletionRepository } from "../src/job-completion-repository.js";
import {
  createJobContextReviewRepository,
  JobContextReviewIdempotencyError,
} from "../src/job-context-review-repository.js";
import { createJobParticipantCapabilityRepository } from "../src/job-participant-capability-repository.js";
import { createJobParticipationRepository } from "../src/job-participation-repository.js";
import { createJobWorkGroupCommandRepository } from "../src/job-work-group-command-repository.js";

const rollback = new Error("rollback Job context review assertions");

interface Fixture {
  readonly customerUserId: string;
  readonly jobId: string;
  readonly providerUserId: string;
  readonly targetProfileId: string;
  readonly targetUserId: string;
}

const participantRatings = Object.freeze({
  cleanliness: null,
  communication: 5,
  price_adherence: null,
  problem_solving: 4,
  schedule_adherence: null,
  work_quality: 5,
  would_hire_again: 5,
});

const groupRatings = Object.freeze({
  cleanliness: 5,
  communication: 4,
  coordination: 5,
  problem_solving: null,
  result_quality: 5,
  timing: 4,
});

export async function runJobContextReviewIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  await expect(
    sql.begin(async (tx) => {
      const [fixture] = await tx<Fixture[]>`
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
        JOIN craftsman_profiles target ON target.profile_type = 'INDIVIDUAL'
          AND target.owner_user_id <> customer.owner_user_id
          AND target.owner_user_id <> provider.owner_user_id
        JOIN current_searchable_craftsman_profiles searchable
          ON searchable.craftsman_profile_id = target.id
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
        ORDER BY job.accepted_at DESC, target.id
        LIMIT 1
      `;
      if (fixture === undefined)
        throw new Error("Job context review fixture missing.");

      const participation = createJobParticipationRepository(tx);
      const invitation = await participation.invite({
        actorUserId: fixture.providerUserId,
        commandId: randomUUID(),
        craftsmanProfileId: fixture.targetProfileId,
        jobId: fixture.jobId,
      });
      expect(invitation.status).toBe("APPLIED");
      if (!("participantId" in invitation))
        throw new Error("Job context review participant identity missing.");
      const participantId = invitation.participantId;
      expect(
        await participation.decide({
          actorUserId: fixture.targetUserId,
          commandId: randomUUID(),
          decision: "ACCEPT",
          participantId,
        }),
      ).toMatchObject({ state: "ACCEPTED", status: "APPLIED" });

      const [profession] = await tx<Array<{ readonly code: string }>>`
        SELECT profession_code AS code
        FROM current_searchable_craftsman_professions
        WHERE craftsman_profile_id = ${fixture.targetProfileId}
        ORDER BY profession_code LIMIT 1
      `;
      if (profession === undefined)
        throw new Error("Job context review profession fixture missing.");
      const capability = createJobParticipantCapabilityRepository(tx);
      const claimId = randomUUID();
      expect(
        await capability.propose({
          actorUserId: fixture.providerUserId,
          commandId: claimId,
          kind: "PROFESSION",
          participantId,
          professionCode: profession.code,
        }),
      ).toMatchObject({ claimId, status: "APPLIED" });
      expect(
        await capability.confirm({
          actorUserId: fixture.targetUserId,
          claimId,
          commandId: randomUUID(),
          participantId,
        }),
      ).toMatchObject({ claimId, status: "APPLIED" });

      const workGroups = createJobWorkGroupCommandRepository(tx);
      const groupId = randomUUID();
      expect(
        await workGroups.create({
          actorUserId: fixture.providerUserId,
          commandId: groupId,
          jobId: fixture.jobId,
          name: "Realizačný tím",
        }),
      ).toMatchObject({ status: "APPLIED", workGroupId: groupId });
      const assignmentId = randomUUID();
      expect(
        await workGroups.assign({
          actorUserId: fixture.providerUserId,
          commandId: assignmentId,
          participantId,
          workGroupId: groupId,
        }),
      ).toMatchObject({ assignmentId, status: "APPLIED" });

      await tx`
        INSERT INTO job_lifecycle_commands (
          command_id, job_id, actor_user_id, command_kind, expected_state,
          actor_role, reason, payload_fingerprint
        ) VALUES (${randomUUID()}, ${fixture.jobId},
          ${fixture.providerUserId}, 'START', 'CONFIRMED',
          'PRIMARY_PROVIDER', NULL, ${"e".repeat(64)})
      `;
      const completion = createJobCompletionRepository(tx);
      const attemptId = randomUUID();
      expect(
        await completion.request({
          actorUserId: fixture.providerUserId,
          commandId: attemptId,
          jobId: fixture.jobId,
        }),
      ).toMatchObject({ status: "APPLIED" });
      expect(
        await completion.accept({
          actorUserId: fixture.customerUserId,
          attemptId,
          commandId: randomUUID(),
          jobId: fixture.jobId,
        }),
      ).toMatchObject({ jobState: "COMPLETED", status: "APPLIED" });

      const repository = createJobContextReviewRepository(tx);
      const page = await repository.getForCustomer({
        actorUserId: fixture.customerUserId,
        jobId: fixture.jobId,
      });
      expect(page).toMatchObject({
        jobId: fixture.jobId,
        participants: [
          {
            participantId,
            review: null,
            targetKind: "PARTICIPANT",
            verifiedProfessionCodes: [profession.code],
            verifiedRoles: ["MEMBER"],
          },
        ],
        workGroups: [
          {
            members: [{ assignmentId, participantId }],
            name: "Realizačný tím",
            review: null,
            targetKind: "WORK_GROUP",
            workGroupId: groupId,
          },
        ],
      });
      expect(
        await repository.getForCustomer({
          actorUserId: fixture.providerUserId,
          jobId: fixture.jobId,
        }),
      ).toBeNull();
      expect(
        await repository.submit({
          actorUserId: fixture.customerUserId,
          commandId: randomUUID(),
          expectedVersion: 0,
          jobId: fixture.jobId,
          ratings: participantRatings,
          targetId: randomUUID(),
          targetKind: "PARTICIPANT",
        }),
      ).toEqual({ status: "NOT_FOUND" });

      await expect(
        tx.savepoint(async (savepoint) => {
          await savepoint`
            INSERT INTO job_context_reviews (
              review_id, create_command_id, job_id, target_kind,
              participant_id, author_user_id, completion_decision_id,
              completed_at, submission_deadline
            ) VALUES (${randomUUID()}, ${randomUUID()}, ${fixture.jobId},
              'PARTICIPANT', ${participantId}, ${fixture.providerUserId},
              ${attemptId}, clock_timestamp(), clock_timestamp() + interval '1 day')
          `;
        }),
      ).rejects.toThrow(
        "eligible verified completed-Job review target required",
      );
      await expect(
        tx.savepoint(async (savepoint) => {
          const reviewId = randomUUID();
          await savepoint`
            INSERT INTO job_context_reviews (
              review_id, create_command_id, job_id, target_kind,
              participant_id, author_user_id, completion_decision_id,
              completed_at, submission_deadline
            ) VALUES (${reviewId}, ${reviewId}, ${fixture.jobId},
              'PARTICIPANT', ${participantId}, ${fixture.customerUserId},
              ${attemptId}, clock_timestamp(), clock_timestamp() + interval '1 day')
          `;
          await savepoint`
            INSERT INTO job_context_review_revisions (
              event_id, review_id, version, actor_user_id, ratings
            ) VALUES (${reviewId}, ${reviewId}, 1, ${fixture.customerUserId},
              ${savepoint.json({
                ...participantRatings,
                work_quality: null,
                communication: null,
                problem_solving: null,
                would_hire_again: null,
              })})
          `;
        }),
      ).rejects.toThrow(
        "exact substantive target-specific review ratings required",
      );

      const participantCommandId = randomUUID();
      const first = await repository.submit({
        actorUserId: fixture.customerUserId,
        commandId: participantCommandId,
        expectedVersion: 0,
        jobId: fixture.jobId,
        ratings: participantRatings,
        targetId: participantId,
        targetKind: "PARTICIPANT",
      });
      expect(first).toMatchObject({ status: "APPLIED", version: 1 });
      expect(
        await repository.submit({
          actorUserId: fixture.customerUserId,
          commandId: participantCommandId,
          expectedVersion: 0,
          jobId: fixture.jobId,
          ratings: participantRatings,
          targetId: participantId,
          targetKind: "PARTICIPANT",
        }),
      ).toMatchObject({ status: "DEDUPLICATED", version: 1 });
      await expect(
        repository.submit({
          actorUserId: fixture.customerUserId,
          commandId: participantCommandId,
          expectedVersion: 0,
          jobId: fixture.jobId,
          ratings: { ...participantRatings, communication: 4 },
          targetId: participantId,
          targetKind: "PARTICIPANT",
        }),
      ).rejects.toThrow(JobContextReviewIdempotencyError);
      expect(
        await repository.submit({
          actorUserId: fixture.customerUserId,
          commandId: randomUUID(),
          expectedVersion: 0,
          jobId: fixture.jobId,
          ratings: participantRatings,
          targetId: participantId,
          targetKind: "PARTICIPANT",
        }),
      ).toEqual({ status: "STALE_VERSION" });
      expect(
        await repository.submit({
          actorUserId: fixture.customerUserId,
          commandId: randomUUID(),
          expectedVersion: 1,
          jobId: fixture.jobId,
          ratings: { ...participantRatings, communication: 4 },
          targetId: participantId,
          targetKind: "PARTICIPANT",
        }),
      ).toMatchObject({ status: "APPLIED", version: 2 });

      expect(
        await repository.submit({
          actorUserId: fixture.customerUserId,
          commandId: randomUUID(),
          expectedVersion: 0,
          jobId: fixture.jobId,
          ratings: groupRatings,
          targetId: groupId,
          targetKind: "WORK_GROUP",
        }),
      ).toMatchObject({ status: "APPLIED", version: 1 });
      const after = await repository.getForCustomer({
        actorUserId: fixture.customerUserId,
        jobId: fixture.jobId,
      });
      expect(after?.participants[0]?.review).toMatchObject({ version: 2 });
      expect(after?.workGroups[0]?.review).toMatchObject({ version: 1 });

      const [participantReview] = await tx<
        Array<{ readonly reviewId: string }>
      >`
        SELECT review_id AS "reviewId" FROM job_context_reviews
        WHERE job_id = ${fixture.jobId} AND participant_id = ${participantId}
      `;
      if (participantReview === undefined)
        throw new Error("Persisted participant review missing.");
      expect(
        await tx`
          SELECT claim_id FROM job_participant_review_capability_snapshots
          WHERE review_id = ${participantReview.reviewId}
        `,
      ).toHaveLength(1);
      expect(
        await tx`
          SELECT role FROM job_participant_review_role_snapshots
          WHERE review_id = ${participantReview.reviewId}
        `,
      ).toHaveLength(1);
      await expect(
        tx.savepoint(async (savepoint) => {
          await savepoint`
            INSERT INTO job_participant_review_capability_snapshots (
              review_id, claim_id, kind, profession_taxonomy_release_id,
              profession_code, proposed_by_user_id, proposed_at,
              confirmed_by_user_id, confirmed_at
            )
            SELECT ${participantReview.reviewId}, claim_id, kind,
              profession_taxonomy_release_id, 'TEST:FORGED',
              proposed_by_user_id, proposed_at, confirmed_by_user_id,
              confirmed_at
            FROM verified_completed_job_capabilities
            WHERE job_id = ${fixture.jobId} AND participant_id = ${participantId}
            LIMIT 1
          `;
        }),
      ).rejects.toThrow("exact verified completed-Job capability required");
      await expect(
        tx.savepoint(async (savepoint) => {
          await savepoint`
            UPDATE job_context_review_revisions SET comment = 'Prepísané'
            WHERE review_id = ${participantReview.reviewId}
          `;
        }),
      ).rejects.toThrow("Job context review history is immutable");
      const [groupReview] = await tx<Array<{ readonly reviewId: string }>>`
        SELECT review_id AS "reviewId" FROM job_context_reviews
        WHERE job_id = ${fixture.jobId} AND work_group_id = ${groupId}
      `;
      expect(
        await tx`
          SELECT assignment_id
          FROM job_work_group_review_assignment_snapshots
          WHERE review_id = ${groupReview?.reviewId ?? randomUUID()}
        `,
      ).toHaveLength(1);

      await tx`
        UPDATE auth_credentials SET phone_verified_at = NULL
        WHERE user_id = ${fixture.customerUserId}
      `;
      expect(
        await repository.getForCustomer({
          actorUserId: fixture.customerUserId,
          jobId: fixture.jobId,
        }),
      ).toBeNull();
      expect(
        await repository.submit({
          actorUserId: fixture.customerUserId,
          commandId: randomUUID(),
          expectedVersion: 2,
          jobId: fixture.jobId,
          ratings: participantRatings,
          targetId: participantId,
          targetKind: "PARTICIPANT",
        }),
      ).toEqual({ status: "NOT_FOUND" });
      throw rollback;
    }),
  ).rejects.toBe(rollback);
}
