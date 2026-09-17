import { randomUUID } from "node:crypto";

import type { Sql } from "postgres";
import { expect } from "vitest";

import { createJobParticipantCapabilityRepository } from "../src/job-participant-capability-repository.js";
import { createJobCompletionRepository } from "../src/job-completion-repository.js";
import { createJobParticipationRepository } from "../src/job-participation-repository.js";

const rollback = new Error("rollback verified completion evidence assertions");

/** Completion must retain a departed worker's accepted, bilaterally evidenced work. */
export async function runVerifiedCompletionEvidenceIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  await expect(
    sql.begin(async (tx) => {
      const [fixture] = await tx<
        Array<{
          jobId: string;
          participantId: string;
          individualProfileId: string;
          participantUserId: string;
          providerUserId: string;
          providerProfileType: string;
          customerUserId: string;
          professionCode: string;
        }>
      >`
        SELECT job.id AS "jobId",
          participant.id AS "participantId",
          participant.craftsman_profile_id AS "individualProfileId",
          individual.owner_user_id AS "participantUserId",
          provider.owner_user_id AS "providerUserId",
          provider.profile_type::text AS "providerProfileType",
          customer.owner_user_id AS "customerUserId",
          capability.profession_code AS "professionCode"
        FROM current_job_participants participant
        JOIN jobs job ON job.id = participant.job_id
        JOIN current_job_states state ON state.job_id = job.id
        JOIN craftsman_profiles individual
          ON individual.id = participant.craftsman_profile_id
        JOIN current_searchable_craftsman_profiles searchable
          ON searchable.craftsman_profile_id = individual.id
        JOIN craftsman_profiles provider
          ON provider.id = job.primary_craftsman_profile_id
        JOIN customer_profiles customer ON customer.id = job.customer_profile_id
        JOIN confirmed_job_participant_capability_evidence capability
          ON capability.participant_id = participant.id
          AND capability.kind = 'PROFESSION'
        JOIN current_searchable_craftsman_professions advertised
          ON advertised.craftsman_profile_id = individual.id
          AND advertised.profession_code = capability.profession_code
        WHERE participant.state = 'LEFT'
          AND state.state = 'CONFIRMED'
          AND individual.profile_type = 'INDIVIDUAL'
        ORDER BY job.accepted_at DESC, participant.accepted_at DESC LIMIT 1
      `;
      if (!fixture)
        throw new Error("Confirmed profession participant fixture missing.");
      expect(
        await tx<Array<{ count: number }>>`
          SELECT count(*)::integer FROM completed_job_evidence_provenance
          WHERE job_id = ${fixture.jobId}
        `,
      ).toEqual([{ count: 0 }]);
      await tx`
          INSERT INTO job_lifecycle_commands (
            command_id, job_id, actor_user_id, command_kind, expected_state,
            actor_role, reason, payload_fingerprint
          ) VALUES (${randomUUID()}, ${fixture.jobId}, ${fixture.providerUserId},
            'START', 'CONFIRMED', 'PRIMARY_PROVIDER', NULL, ${"a".repeat(64)})
        `;
      const participation = createJobParticipationRepository(tx);
      const reinvited = await participation.invite({
        actorUserId: fixture.providerUserId,
        commandId: randomUUID(),
        jobId: fixture.jobId,
        craftsmanProfileId: fixture.individualProfileId,
      });
      expect(reinvited.status).toBe("APPLIED");
      if (!("participantId" in reinvited))
        throw new Error("Reinvited participant identity missing.");
      const activeParticipantId = reinvited.participantId;
      expect(
        await participation.decide({
          actorUserId: fixture.participantUserId,
          commandId: randomUUID(),
          participantId: activeParticipantId,
          decision: "ACCEPT",
        }),
      ).toMatchObject({ status: "APPLIED", state: "ACCEPTED" });
      const capabilityRepository = createJobParticipantCapabilityRepository(tx);
      const activeClaimId = randomUUID();
      expect(
        await capabilityRepository.propose({
          actorUserId: fixture.providerUserId,
          commandId: activeClaimId,
          participantId: activeParticipantId,
          kind: "PROFESSION",
          professionCode: fixture.professionCode,
        }),
      ).toMatchObject({ status: "APPLIED", claimId: activeClaimId });
      expect(
        await capabilityRepository.confirm({
          actorUserId: fixture.participantUserId,
          commandId: randomUUID(),
          participantId: activeParticipantId,
          claimId: activeClaimId,
        }),
      ).toMatchObject({ status: "APPLIED", claimId: activeClaimId });
      expect(
        await participation.decide({
          actorUserId: fixture.participantUserId,
          commandId: randomUUID(),
          participantId: activeParticipantId,
          decision: "LEAVE",
        }),
      ).toMatchObject({ status: "APPLIED", state: "LEFT" });
      const completion = createJobCompletionRepository(tx);
      const requestId = randomUUID();
      expect(
        await completion.request({
          actorUserId: fixture.providerUserId,
          commandId: requestId,
          jobId: fixture.jobId,
        }),
      ).toMatchObject({ status: "APPLIED", attemptId: requestId });
      const acceptanceId = randomUUID();
      expect(
        await completion.accept({
          actorUserId: fixture.customerUserId,
          commandId: acceptanceId,
          jobId: fixture.jobId,
          attemptId: requestId,
        }),
      ).toMatchObject({ status: "APPLIED", jobState: "COMPLETED" });
      const [source] = await tx<
        Array<{
          completionKind: string;
          completionDecisionId: string | null;
          adminCompletionCommandId: string | null;
        }>
      >`
        SELECT completion_kind AS "completionKind",
          completion_decision_id AS "completionDecisionId",
          admin_completion_command_id AS "adminCompletionCommandId"
        FROM completed_job_evidence_provenance WHERE job_id = ${fixture.jobId}
      `;
      expect(source).toEqual({
        completionKind: "CUSTOMER_ACCEPTED",
        completionDecisionId: acceptanceId,
        adminCompletionCommandId: null,
      });
      const [work] = await tx<
        Array<{
          participantId: string;
          individualProfileId: string;
          leftBeforeCompletion: boolean;
          endedAt: Date;
          completedAt: Date;
        }>
      >`
        SELECT participant_id AS "participantId",
          individual_profile_id AS "individualProfileId",
          left_before_completion AS "leftBeforeCompletion",
          participation_ended_at AS "endedAt", completed_at AS "completedAt"
        FROM verified_individual_completed_job_participation
        WHERE participant_id = ${activeParticipantId}
      `;
      expect(work).toMatchObject({
        participantId: activeParticipantId,
        individualProfileId: fixture.individualProfileId,
        leftBeforeCompletion: true,
      });
      expect(work?.endedAt.valueOf()).toBeLessThanOrEqual(
        work?.completedAt.valueOf() ?? 0,
      );
      const [prematureWork] = await tx`
        SELECT participant_id FROM verified_individual_completed_job_participation
        WHERE participant_id = ${fixture.participantId}
      `;
      expect(prematureWork).toBeUndefined();
      const [capability] = await tx<
        Array<{ claimId: string; professionCode: string }>
      >`
        SELECT claim_id AS "claimId", profession_code AS "professionCode"
        FROM verified_completed_job_capabilities
        WHERE participant_id = ${activeParticipantId} AND kind = 'PROFESSION'
      `;
      expect(capability).toEqual({
        claimId: activeClaimId,
        professionCode: fixture.professionCode,
      });
      const [volume] = await tx<
        Array<{ workCount: number; professionCount: number }>
      >`
        SELECT
          (SELECT count(DISTINCT job_id)::integer
            FROM completed_job_profile_evidence
            WHERE craftsman_profile_id = ${fixture.individualProfileId})
            AS "workCount",
          (SELECT count(DISTINCT job_id)::integer
            FROM completed_job_profession_evidence
            WHERE craftsman_profile_id = ${fixture.individualProfileId}
              AND profession_code = ${fixture.professionCode})
            AS "professionCount"
      `;
      expect(volume).toEqual({ workCount: 1, professionCount: 1 });
      const [publicSummary] = await tx<Array<{ verifiedJobCount: number }>>`
        SELECT verified_job_count AS "verifiedJobCount"
        FROM current_searchable_trust_evidence_summaries
        WHERE craftsman_profile_id = ${fixture.individualProfileId}
      `;
      expect(publicSummary?.verifiedJobCount).toBe(1);
      const [publicProfession] = await tx<Array<{ verifiedJobCount: number }>>`
        SELECT verified_job_count AS "verifiedJobCount"
        FROM current_searchable_profession_trust_evidence
        WHERE craftsman_profile_id = ${fixture.individualProfileId}
          AND profession_code = ${fixture.professionCode}
      `;
      expect(publicProfession?.verifiedJobCount).toBe(1);
      const [searchSignal] = await tx<Array<{ verifiedWorkCount: number }>>`
        SELECT verified_work_count AS "verifiedWorkCount"
        FROM current_searchable_craftsman_trust_signals
        WHERE craftsman_profile_id = ${fixture.individualProfileId}
      `;
      expect(searchSignal?.verifiedWorkCount).toBe(1);
      const [{ companyCount } = { companyCount: -1 }] = await tx<
        Array<{ companyCount: number }>
      >`
        SELECT count(*)::integer AS "companyCount"
        FROM verified_company_completed_jobs WHERE job_id = ${fixture.jobId}
      `;
      expect(companyCount).toBe(
        fixture.providerProfileType === "COMPANY" ? 1 : 0,
      );
      await expect(
        tx.savepoint(async (savepoint) => {
          await savepoint`
            INSERT INTO job_participant_events (
              event_id, participant_id, event_sequence, event_kind,
              actor_user_id, reason, payload_fingerprint
            ) VALUES (${randomUUID()}, ${activeParticipantId}, 3,
              'REMOVE', ${fixture.providerUserId},
              'Neskorá úprava účasti', ${"b".repeat(64)})
          `;
        }),
      ).rejects.toThrow("closed Job participation is immutable");
      await tx`SELECT id FROM users WHERE id = ${fixture.participantUserId} FOR UPDATE`;
      await tx`
        UPDATE users SET account_state = 'SUSPENDED',
          account_state_changed_at = clock_timestamp(),
          updated_at = clock_timestamp()
        WHERE id = ${fixture.participantUserId}
      `;
      expect(
        await tx`
          SELECT craftsman_profile_id FROM current_searchable_trust_evidence_summaries
          WHERE craftsman_profile_id = ${fixture.individualProfileId}
        `,
      ).toEqual([]);
      expect(
        await tx`
          SELECT craftsman_profile_id FROM current_searchable_profession_trust_evidence
          WHERE craftsman_profile_id = ${fixture.individualProfileId}
        `,
      ).toEqual([]);
      expect(
        await tx`
          SELECT craftsman_profile_id FROM current_searchable_craftsman_trust_signals
          WHERE craftsman_profile_id = ${fixture.individualProfileId}
        `,
      ).toEqual([]);
      throw rollback;
    }),
  ).rejects.toBe(rollback);
}
