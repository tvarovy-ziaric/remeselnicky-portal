import { randomUUID } from "node:crypto";

import type { Sql } from "postgres";
import { expect } from "vitest";

import { createJobCompletionRepository } from "../src/job-completion-repository.js";
import { createJobParticipantCapabilityRepository } from "../src/job-participant-capability-repository.js";
import { createJobParticipationRepository } from "../src/job-participation-repository.js";
import { createJobSupervisorEvaluationRepository } from "../src/job-supervisor-evaluation-repository.js";

const rollback = new Error("rollback Job supervisor evaluation assertions");

const ratings = Object.freeze({
  collaboration: 5,
  competence_quality: 5,
  independence: null,
  problem_solving: 4,
  productivity: 4,
  reliability: 5,
  would_take_into_crew_again: 5,
});

interface Fixture {
  readonly customerUserId: string;
  readonly jobId: string;
  readonly providerUserId: string;
  readonly targetProfileId: string;
  readonly targetUserId: string;
}

interface Candidate {
  readonly profileId: string;
  readonly userId: string;
}

export async function runJobSupervisorEvaluationIntegrationAssertions(
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
        throw new Error("Job supervisor evaluation fixture missing.");

      const participation = createJobParticipationRepository(tx);
      const invited = await participation.invite({
        actorUserId: fixture.providerUserId,
        commandId: randomUUID(),
        craftsmanProfileId: fixture.targetProfileId,
        jobId: fixture.jobId,
      });
      if (!("participantId" in invited))
        throw new Error("Supervisor target participant missing.");
      const participantId = invited.participantId;
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
        throw new Error("Supervisor target profession missing.");
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

      const candidates = await tx<Candidate[]>`
        SELECT profile.id AS "profileId", profile.owner_user_id AS "userId"
        FROM craftsman_profiles profile
        JOIN users actor ON actor.id = profile.owner_user_id
          AND actor.account_state = 'ACTIVE'
        JOIN auth_credentials credential ON credential.user_id = actor.id
          AND credential.email_verified_at IS NOT NULL
          AND credential.phone_verified_at IS NOT NULL
        WHERE profile.profile_type = 'INDIVIDUAL'
          AND profile.id <> ${fixture.targetProfileId}
          AND profile.owner_user_id NOT IN (
            ${fixture.customerUserId}, ${fixture.providerUserId},
            ${fixture.targetUserId}
          )
          AND NOT EXISTS (
            SELECT 1 FROM current_job_participants participant
            WHERE participant.job_id = ${fixture.jobId}
              AND participant.craftsman_profile_id = profile.id
              AND participant.state IN ('INVITED', 'ACCEPTED')
          )
        ORDER BY profile.id LIMIT 3
      `;
      if (candidates.length !== 3)
        throw new Error("Supervisor relationship candidates missing.");
      const accepted = new Map<string, string>();
      for (const candidate of candidates) {
        const extra = await participation.invite({
          actorUserId: fixture.providerUserId,
          commandId: randomUUID(),
          craftsmanProfileId: candidate.profileId,
          jobId: fixture.jobId,
        });
        if (!("participantId" in extra))
          throw new Error("Supervisor evaluator participant missing.");
        expect(
          await participation.decide({
            actorUserId: candidate.userId,
            commandId: randomUUID(),
            decision: "ACCEPT",
            participantId: extra.participantId,
          }),
        ).toMatchObject({ state: "ACCEPTED", status: "APPLIED" });
        accepted.set(candidate.userId, extra.participantId);
      }
      const [coordinator, lead, unconfirmed] = candidates;
      if (
        coordinator === undefined ||
        lead === undefined ||
        unconfirmed === undefined
      )
        throw new Error("Supervisor role fixtures missing.");
      const coordinatorParticipantId = accepted.get(coordinator.userId);
      const leadParticipantId = accepted.get(lead.userId);
      const unconfirmedParticipantId = accepted.get(unconfirmed.userId);
      if (
        coordinatorParticipantId === undefined ||
        leadParticipantId === undefined ||
        unconfirmedParticipantId === undefined
      )
        throw new Error("Supervisor accepted role fixtures missing.");

      const coordinatorAssignmentId = randomUUID();
      expect(
        await participation.changeRole({
          action: "ASSIGN",
          actorUserId: fixture.providerUserId,
          commandId: coordinatorAssignmentId,
          participantId: coordinatorParticipantId,
          role: "COORDINATOR",
        }),
      ).toMatchObject({ role: "COORDINATOR", status: "APPLIED" });
      await tx`
        INSERT INTO job_participant_role_decisions (
          decision_id, assignment_event_id, actor_user_id,
          decision_kind, reason, payload_fingerprint
        ) VALUES (${randomUUID()}, ${coordinatorAssignmentId},
          ${coordinator.userId}, 'CONFIRM', NULL, ${"c".repeat(64)})
      `;
      const leadAssignmentId = randomUUID();
      expect(
        await participation.changeRole({
          action: "ASSIGN",
          actorUserId: fixture.providerUserId,
          commandId: leadAssignmentId,
          participantId: leadParticipantId,
          role: "LEAD",
        }),
      ).toMatchObject({ role: "LEAD", status: "APPLIED" });
      await tx`
        INSERT INTO job_participant_role_decisions (
          decision_id, assignment_event_id, actor_user_id,
          decision_kind, reason, payload_fingerprint
        ) VALUES (${randomUUID()}, ${leadAssignmentId},
          ${lead.userId}, 'CONFIRM', NULL, ${"d".repeat(64)})
      `;
      expect(
        await participation.changeRole({
          action: "ASSIGN",
          actorUserId: fixture.providerUserId,
          commandId: randomUUID(),
          participantId: unconfirmedParticipantId,
          role: "SITE_MANAGER",
        }),
      ).toMatchObject({ role: "SITE_MANAGER", status: "APPLIED" });

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

      const repository = createJobSupervisorEvaluationRepository(tx);
      const providerPage = await repository.getForEvaluator({
        actorUserId: fixture.providerUserId,
        jobId: fixture.jobId,
      });
      expect(providerPage?.jobId).toBe(fixture.jobId);
      expect(
        providerPage?.targets.find(
          (target) => target.targetParticipantId === participantId,
        ),
      ).toMatchObject({
        evaluation: null,
        relationshipKind: "PRIMARY_CONTRACTOR",
        targetParticipantId: participantId,
        verifiedProfessionCodes: [profession.code],
        verifiedRoles: ["MEMBER"],
      });
      expect(
        await repository.getForEvaluator({
          actorUserId: fixture.customerUserId,
          jobId: fixture.jobId,
        }),
      ).toBeNull();
      const coordinatorPage = await repository.getForEvaluator({
        actorUserId: coordinator.userId,
        jobId: fixture.jobId,
      });
      expect(coordinatorPage?.targets).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            relationshipKind: "COORDINATOR",
            targetParticipantId: participantId,
          }),
        ]),
      );
      expect(
        await repository.getForEvaluator({
          actorUserId: fixture.targetUserId,
          jobId: fixture.jobId,
        }),
      ).toBeNull();
      expect(
        await repository.getForEvaluator({
          actorUserId: lead.userId,
          jobId: fixture.jobId,
        }),
      ).toBeNull();
      expect(
        await repository.getForEvaluator({
          actorUserId: unconfirmed.userId,
          jobId: fixture.jobId,
        }),
      ).toBeNull();
      for (const denied of [
        {
          actorUserId: fixture.targetUserId,
          targetParticipantId: coordinatorParticipantId,
        },
        {
          actorUserId: lead.userId,
          targetParticipantId: participantId,
        },
        {
          actorUserId: unconfirmed.userId,
          targetParticipantId: participantId,
        },
        {
          actorUserId: coordinator.userId,
          targetParticipantId: coordinatorParticipantId,
        },
      ]) {
        expect(
          await repository.submit({
            actorUserId: denied.actorUserId,
            commandId: randomUUID(),
            expectedVersion: 0,
            jobId: fixture.jobId,
            targetParticipantId: denied.targetParticipantId,
            ratings,
          }),
        ).toEqual({ status: "NOT_FOUND" });
      }

      const coordinatorEvaluationId = randomUUID();
      expect(
        await repository.submit({
          actorUserId: coordinator.userId,
          commandId: coordinatorEvaluationId,
          expectedVersion: 0,
          jobId: fixture.jobId,
          targetParticipantId: participantId,
          ratings,
          comment: "Potvrdené koordinátorom.",
        }),
      ).toMatchObject({
        evaluationId: coordinatorEvaluationId,
        status: "APPLIED",
        version: 1,
      });

      const commandId = randomUUID();
      const applied = await repository.submit({
        actorUserId: fixture.providerUserId,
        commandId,
        expectedVersion: 0,
        jobId: fixture.jobId,
        targetParticipantId: participantId,
        ratings,
        comment: "Technicky spoľahlivá realizácia.",
      });
      expect(applied).toMatchObject({
        evaluationId: commandId,
        revisionId: commandId,
        status: "APPLIED",
        version: 1,
      });
      expect(
        await repository.submit({
          actorUserId: fixture.providerUserId,
          commandId,
          expectedVersion: 0,
          jobId: fixture.jobId,
          targetParticipantId: participantId,
          ratings,
          comment: "Technicky spoľahlivá realizácia.",
        }),
      ).toMatchObject({ status: "DEDUPLICATED" });

      const received = await repository.getReceivedForTarget({
        actorUserId: fixture.targetUserId,
        jobId: fixture.jobId,
      });
      expect(received?.evaluations).toHaveLength(2);
      expect(
        received?.evaluations.every((item) =>
          /\S/u.test(item.evaluatorDisplayName),
        ),
      ).toBe(true);
      expect(received?.jobId).toBe(fixture.jobId);
      expect(
        received?.evaluations.find(
          (evaluation) => evaluation.evaluationId === commandId,
        ),
      ).toMatchObject({
        evaluationId: commandId,
        verifiedProfessionCodes: [profession.code],
        content: {
          comment: "Technicky spoľahlivá realizácia.",
          version: 1,
        },
      });
      expect(
        await repository.getById({
          actorUserId: fixture.customerUserId,
          evaluationId: commandId,
          jobId: fixture.jobId,
        }),
      ).toBeNull();
      expect(
        await repository.getById({
          actorUserId: fixture.providerUserId,
          evaluationId: commandId,
          jobId: fixture.jobId,
        }),
      ).toMatchObject({ evaluationId: commandId });

      expect(
        await tx`
          SELECT claim_id
          FROM job_supervisor_evaluation_profession_snapshots
          WHERE evaluation_id = ${commandId}
        `,
      ).toHaveLength(1);
      expect(
        await tx`
          SELECT role FROM job_supervisor_evaluation_role_snapshots
          WHERE evaluation_id = ${commandId}
        `,
      ).toEqual([{ role: "MEMBER" }]);
      const outbox = await tx<
        Array<{ readonly payload: Record<string, unknown> }>
      >`
        SELECT payload FROM domain_outbox_events
        WHERE idempotency_key = ${`job:${fixture.jobId}:supervisor-evaluation:${commandId}:visible`}
      `;
      expect(outbox).toHaveLength(1);
      expect(outbox[0]?.payload).toEqual({
        evaluation_id: commandId,
        job_id: fixture.jobId,
        recipient_user_id: fixture.targetUserId,
      });
      expect(JSON.stringify(outbox)).not.toContain("ratings");
      expect(JSON.stringify(outbox)).not.toContain("comment");

      const editCommandId = randomUUID();
      expect(
        await repository.submit({
          actorUserId: fixture.providerUserId,
          commandId: editCommandId,
          expectedVersion: 1,
          jobId: fixture.jobId,
          targetParticipantId: participantId,
          ratings: { ...ratings, reliability: 4 },
          comment: "Spresnené technické hodnotenie.",
        }),
      ).toMatchObject({ status: "APPLIED", version: 2 });
      expect(
        await tx`
          SELECT event_id FROM domain_outbox_events
          WHERE idempotency_key = ${`job:${fixture.jobId}:supervisor-evaluation:${commandId}:visible`}
        `,
      ).toHaveLength(1);

      await expect(
        tx.savepoint(async (savepoint) => {
          await savepoint`
            UPDATE job_supervisor_evaluation_revisions
            SET comment = 'Prepísané' WHERE evaluation_id = ${commandId}
          `;
        }),
      ).rejects.toThrow("Job supervisor evaluation history is immutable");
      await expect(
        tx.savepoint(async (savepoint) => {
          await savepoint`
            INSERT INTO job_supervisor_evaluation_profession_snapshots (
              evaluation_id, claim_id, profession_taxonomy_release_id,
              profession_code, proposed_by_user_id, proposed_at,
              confirmed_by_user_id, confirmed_at
            )
            SELECT ${commandId}, claim_id, profession_taxonomy_release_id,
              'TEST:FORGED', proposed_by_user_id, proposed_at,
              confirmed_by_user_id, confirmed_at
            FROM verified_completed_job_capabilities
            WHERE job_id = ${fixture.jobId}
              AND participant_id = ${participantId}
            LIMIT 1
          `;
        }),
      ).rejects.toThrow("exact verified target profession required");

      throw rollback;
    }),
  ).rejects.toBe(rollback);
}
