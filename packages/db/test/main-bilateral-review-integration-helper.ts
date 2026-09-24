import { randomUUID } from "node:crypto";

import type { Sql } from "postgres";
import { expect } from "vitest";

import { createJobCompletionRepository } from "../src/job-completion-repository.js";

const rollback = new Error("rollback main bilateral review assertions");

export async function runMainBilateralReviewIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  await expect(
    sql.begin(async (tx) => {
      const [job] = await tx<
        Array<{
          id: string;
          customerUserId: string;
          providerUserId: string;
          customerProfileId: string;
          providerProfileId: string;
        }>
      >`
        SELECT job.id, customer.owner_user_id AS "customerUserId",
          provider.owner_user_id AS "providerUserId",
          customer.id AS "customerProfileId",
          provider.id AS "providerProfileId"
        FROM jobs job
        JOIN current_job_states state ON state.job_id = job.id
        JOIN customer_profiles customer ON customer.id = job.customer_profile_id
        JOIN craftsman_profiles provider
          ON provider.id = job.primary_craftsman_profile_id
        JOIN current_searchable_craftsman_profiles searchable_provider
          ON searchable_provider.craftsman_profile_id = provider.id
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
        ORDER BY job.accepted_at DESC, job.id DESC LIMIT 1
      `;
      if (!job)
        throw new Error("Distinct active review parties fixture missing.");
      expect(
        await tx`SELECT job_id FROM job_main_review_opportunities WHERE job_id = ${job.id}`,
      ).toHaveLength(0);
      await tx`
        INSERT INTO job_lifecycle_commands (
          command_id, job_id, actor_user_id, command_kind, expected_state,
          actor_role, reason, payload_fingerprint
        ) VALUES (${randomUUID()}, ${job.id}, ${job.providerUserId},
          'START', 'CONFIRMED', 'PRIMARY_PROVIDER', NULL, ${"a".repeat(64)})
      `;
      const completion = createJobCompletionRepository(tx);
      const requestId = randomUUID();
      expect(
        await completion.request({
          actorUserId: job.providerUserId,
          commandId: requestId,
          jobId: job.id,
        }),
      ).toMatchObject({ status: "APPLIED", attemptId: requestId });
      expect(
        await tx`SELECT job_id FROM job_main_review_opportunities WHERE job_id = ${job.id}`,
      ).toHaveLength(0);
      expect(
        await completion.accept({
          actorUserId: job.customerUserId,
          commandId: randomUUID(),
          jobId: job.id,
          attemptId: requestId,
        }),
      ).toMatchObject({ status: "APPLIED", jobState: "COMPLETED" });
      const opportunities = await tx<
        Array<{
          direction: string;
          authorUserId: string;
          targetProfileId: string;
          acceptedProfessionCode: string;
          completedAt: Date;
          submissionDeadline: Date;
          completionKind: string;
        }>
      >`
        SELECT direction::text AS direction,
          author_user_id AS "authorUserId",
          target_profile_id AS "targetProfileId",
          accepted_profession_code AS "acceptedProfessionCode",
          completed_at AS "completedAt",
          submission_deadline AS "submissionDeadline",
          completion_kind AS "completionKind"
        FROM job_main_review_opportunities
        WHERE job_id = ${job.id}
        ORDER BY direction
      `;
      expect(opportunities.map((item) => item.direction)).toEqual([
        "CUSTOMER_TO_PROVIDER",
        "PROVIDER_TO_CUSTOMER",
      ]);
      expect(opportunities[0]).toMatchObject({
        authorUserId: job.customerUserId,
        targetProfileId: job.providerProfileId,
        completionKind: "CUSTOMER_ACCEPTED",
      });
      expect(opportunities[1]).toMatchObject({
        authorUserId: job.providerUserId,
        targetProfileId: job.customerProfileId,
      });
      expect(opportunities[0]?.submissionDeadline.valueOf()).toBeGreaterThan(
        opportunities[0]?.completedAt.valueOf() ?? 0,
      );
      expect(
        await tx`SELECT job_id FROM current_unlocked_job_main_reviews WHERE job_id = ${job.id}`,
      ).toHaveLength(0);

      const providerRatings = {
        agreement_payment_experience: 4,
        site_readiness: null,
        brief_clarity: null,
        communication: null,
        unplanned_changes: null,
        fairness: null,
      };
      const customerRatings = {
        work_quality: null,
        price_adherence: null,
        schedule_adherence: null,
        communication: null,
        cleanliness: null,
        problem_solving: null,
        would_hire_again: 5,
      };
      await expect(
        tx.savepoint(async (savepoint) => {
          await savepoint`
            INSERT INTO job_main_review_events (
              event_id, job_id, direction, version, actor_user_id,
              ratings, comment
            ) VALUES (${randomUUID()}, ${job.id}, 'PROVIDER_TO_CUSTOMER',
              1, ${job.customerUserId}, ${savepoint.json(providerRatings)}, NULL)
          `;
        }),
      ).rejects.toThrow("eligible completed Job review author required");
      await expect(
        tx.savepoint(async (savepoint) => {
          await savepoint`
            INSERT INTO job_main_review_events (
              event_id, job_id, direction, version, actor_user_id,
              ratings, comment
            ) VALUES (${randomUUID()}, ${job.id}, 'PROVIDER_TO_CUSTOMER',
              1, ${job.providerUserId}, ${savepoint.json({ ...providerRatings, fairness: 3, extra: 5 })}, NULL)
          `;
        }),
      ).rejects.toThrow(
        "exact substantive directional review ratings required",
      );
      await expect(
        tx.savepoint(async (savepoint) => {
          await savepoint`
            INSERT INTO job_main_review_events (
              event_id, job_id, direction, version, actor_user_id,
              ratings, comment
            ) VALUES (${randomUUID()}, ${job.id}, 'CUSTOMER_TO_PROVIDER',
              1, ${job.customerUserId},
              ${savepoint.json({ ...customerRatings, would_hire_again: null })},
              NULL)
          `;
        }),
      ).rejects.toThrow(
        "exact substantive directional review ratings required",
      );
      const providerFirstId = randomUUID();
      await tx`
        INSERT INTO job_main_review_events (
          event_id, job_id, direction, version, actor_user_id,
          ratings, comment
        ) VALUES (${providerFirstId}, ${job.id}, 'PROVIDER_TO_CUSTOMER',
          1, ${job.providerUserId}, ${tx.json(providerRatings)},
          'Vecná skúsenosť so spoluprácou.')
      `;
      expect(
        await tx`
          INSERT INTO job_main_review_events (
            event_id, job_id, direction, version, actor_user_id,
            ratings, comment
          ) VALUES (${providerFirstId}, ${job.id}, 'PROVIDER_TO_CUSTOMER',
            1, ${job.providerUserId}, ${tx.json(providerRatings)},
            'Vecná skúsenosť so spoluprácou.')
          RETURNING event_id
        `,
      ).toHaveLength(0);
      await expect(
        tx.savepoint(async (savepoint) => {
          await savepoint`
            INSERT INTO job_main_review_events (
              event_id, job_id, direction, version, actor_user_id,
              ratings, comment
            ) VALUES (${providerFirstId}, ${job.id}, 'PROVIDER_TO_CUSTOMER',
              1, ${job.providerUserId}, ${savepoint.json(providerRatings)},
              'Iný obsah pod rovnakým príkazom.')
          `;
        }),
      ).rejects.toThrow("review command identifier reuse conflict");
      expect(
        await tx`SELECT job_id FROM current_unlocked_job_main_reviews WHERE job_id = ${job.id}`,
      ).toHaveLength(0);
      const providerEditId = randomUUID();
      await tx`
        INSERT INTO job_main_review_events (
          event_id, job_id, direction, version, actor_user_id,
          ratings, comment
        ) VALUES (${providerEditId}, ${job.id}, 'PROVIDER_TO_CUSTOMER',
          2, ${job.providerUserId}, ${tx.json({ ...providerRatings, fairness: 4 })},
          'Upravená vecná skúsenosť.')
      `;
      expect(
        await tx`SELECT job_id FROM current_unlocked_job_main_reviews WHERE job_id = ${job.id}`,
      ).toHaveLength(0);
      const customerId = randomUUID();
      await tx`
        INSERT INTO job_main_review_events (
          event_id, job_id, direction, version, actor_user_id,
          ratings, comment
        ) VALUES (${customerId}, ${job.id}, 'CUSTOMER_TO_PROVIDER',
          1, ${job.customerUserId}, ${tx.json(customerRatings)}, NULL)
      `;
      const unlocked = await tx<
        Array<{
          direction: string;
          revisionId: string;
          targetProfileId: string;
        }>
      >`
        SELECT direction::text AS direction,
          revision_id AS "revisionId", target_profile_id AS "targetProfileId"
        FROM current_unlocked_job_main_reviews
        WHERE job_id = ${job.id} ORDER BY direction
      `;
      expect(unlocked).toEqual([
        {
          direction: "CUSTOMER_TO_PROVIDER",
          revisionId: customerId,
          targetProfileId: job.providerProfileId,
        },
        {
          direction: "PROVIDER_TO_CUSTOMER",
          revisionId: providerEditId,
          targetProfileId: job.customerProfileId,
        },
      ]);
      const customerOpportunity = opportunities[0];
      if (customerOpportunity === undefined) {
        throw new Error("Customer-to-provider review opportunity missing.");
      }
      const [reviewScore] = await tx<
        Array<{
          profileId: string;
          professionCode: string;
          reviewScore: string;
        }>
      >`
        SELECT craftsman_profile_id AS "profileId",
          profession_code AS "professionCode",
          review_score::text AS "reviewScore"
        FROM current_unlocked_provider_main_review_scores
        WHERE revision_id = ${customerId}
      `;
      expect(reviewScore).toEqual({
        profileId: job.providerProfileId,
        professionCode: customerOpportunity.acceptedProfessionCode,
        reviewScore: "5.00",
      });
      const [summary] = await tx<
        Array<{
          customerQualityAvailable: boolean;
          customerReviewCount: number;
          customerScore: string;
        }>
      >`
        SELECT customer_review_count AS "customerReviewCount",
          customer_score::text AS "customerScore",
          customer_quality_available AS "customerQualityAvailable"
        FROM current_searchable_trust_evidence_summaries
        WHERE craftsman_profile_id = ${job.providerProfileId}
      `;
      expect(summary).toEqual({
        customerQualityAvailable: true,
        customerReviewCount: 1,
        customerScore: "5.00",
      });
      const [professionSummary] = await tx<
        Array<{ customerReviewCount: number; customerScore: string }>
      >`
        SELECT customer_review_count AS "customerReviewCount",
          customer_score::text AS "customerScore"
        FROM current_searchable_profession_trust_evidence
        WHERE craftsman_profile_id = ${job.providerProfileId}
          AND profession_code = ${customerOpportunity.acceptedProfessionCode}
      `;
      expect(professionSummary).toEqual({
        customerReviewCount: 1,
        customerScore: "5.00",
      });
      const [searchSignal] = await tx<
        Array<{
          customerScore: string;
          reviewCount: number;
          reviewSampleSufficient: boolean;
        }>
      >`
        SELECT customer_score::text AS "customerScore",
          review_count AS "reviewCount",
          review_sample_sufficient AS "reviewSampleSufficient"
        FROM current_searchable_craftsman_trust_signals
        WHERE craftsman_profile_id = ${job.providerProfileId}
      `;
      expect(searchSignal).toEqual({
        customerScore: "5.00",
        reviewCount: 1,
        reviewSampleSufficient: false,
      });
      await expect(
        tx.savepoint(async (savepoint) => {
          await savepoint`
            INSERT INTO job_main_review_events (
              event_id, job_id, direction, version, actor_user_id,
              ratings, comment
            ) VALUES (${randomUUID()}, ${job.id}, 'PROVIDER_TO_CUSTOMER',
              3, ${job.providerUserId}, ${savepoint.json(providerRatings)}, NULL)
          `;
        }),
      ).rejects.toThrow("sealed review edit window closed or stale");
      await expect(
        tx.savepoint(async (savepoint) => {
          await savepoint`UPDATE job_main_review_events SET comment = 'changed'
            WHERE event_id = ${providerFirstId}`;
        }),
      ).rejects.toThrow("Job main review history is immutable");
      await expect(
        tx.savepoint(async (savepoint) => {
          await savepoint`DELETE FROM job_main_review_events
            WHERE event_id = ${providerEditId}`;
        }),
      ).rejects.toThrow("Job main review history is immutable");
      throw rollback;
    }),
  ).rejects.toBe(rollback);
}
