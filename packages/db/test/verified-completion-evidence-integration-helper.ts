import { randomUUID } from "node:crypto";

import type { Sql } from "postgres";
import { expect } from "vitest";

import { createJobCompletionRepository } from "../src/job-completion-repository.js";

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
          jobState: string;
          participantId: string;
          individualProfileId: string;
          providerUserId: string;
          providerProfileType: string;
          customerUserId: string;
          claimId: string;
          professionCode: string;
        }>
      >`
        SELECT job.id AS "jobId", state.state::text AS "jobState",
          participant.id AS "participantId",
          participant.craftsman_profile_id AS "individualProfileId",
          provider.owner_user_id AS "providerUserId",
          provider.profile_type::text AS "providerProfileType",
          customer.owner_user_id AS "customerUserId",
          capability.claim_id AS "claimId",
          capability.profession_code AS "professionCode"
        FROM current_job_participants participant
        JOIN jobs job ON job.id = participant.job_id
        JOIN current_job_states state ON state.job_id = job.id
        JOIN craftsman_profiles individual
          ON individual.id = participant.craftsman_profile_id
        JOIN craftsman_profiles provider
          ON provider.id = job.primary_craftsman_profile_id
        JOIN customer_profiles customer ON customer.id = job.customer_profile_id
        JOIN confirmed_job_participant_capability_evidence capability
          ON capability.participant_id = participant.id
          AND capability.kind = 'PROFESSION'
        WHERE participant.state = 'LEFT'
          AND state.state IN ('CONFIRMED', 'IN_PROGRESS')
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
      if (fixture.jobState === "CONFIRMED") {
        await tx`
          INSERT INTO job_lifecycle_commands (
            command_id, job_id, actor_user_id, command_kind, expected_state,
            actor_role, reason, payload_fingerprint
          ) VALUES (${randomUUID()}, ${fixture.jobId}, ${fixture.providerUserId},
            'START', 'CONFIRMED', 'PRIMARY_PROVIDER', NULL, ${"a".repeat(64)})
        `;
      }
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
        WHERE participant_id = ${fixture.participantId}
      `;
      expect(work).toMatchObject({
        participantId: fixture.participantId,
        individualProfileId: fixture.individualProfileId,
        leftBeforeCompletion: true,
      });
      expect(work?.endedAt.valueOf()).toBeLessThanOrEqual(
        work?.completedAt.valueOf() ?? 0,
      );
      const [capability] = await tx<
        Array<{ claimId: string; professionCode: string }>
      >`
        SELECT claim_id AS "claimId", profession_code AS "professionCode"
        FROM verified_completed_job_capabilities
        WHERE participant_id = ${fixture.participantId} AND kind = 'PROFESSION'
      `;
      expect(capability).toEqual({
        claimId: fixture.claimId,
        professionCode: fixture.professionCode,
      });
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
            ) VALUES (${randomUUID()}, ${fixture.participantId}, 3,
              'REMOVE', ${fixture.providerUserId},
              'Neskorá úprava účasti', ${"b".repeat(64)})
          `;
        }),
      ).rejects.toThrow("closed Job participation is immutable");
      throw rollback;
    }),
  ).rejects.toBe(rollback);
}
