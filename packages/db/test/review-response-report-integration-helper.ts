import { randomUUID } from "node:crypto";

import type { Sql } from "postgres";
import { expect } from "vitest";

import { createJobMainReviewRepository } from "../src/job-main-review-repository.js";
import { createReviewResponseReportRepository } from "../src/review-response-report-repository.js";

interface MainReviewFixture {
  readonly customerReviewId: string;
  readonly customerUserId: string;
  readonly jobId: string;
  readonly providerUserId: string;
}

interface SupervisorFixture {
  readonly evaluationId: string;
  readonly evaluatorUserId: string;
  readonly targetUserId: string;
}

const providerRatings = Object.freeze({
  agreement_payment_experience: 5 as const,
  brief_clarity: 4 as const,
  communication: 5 as const,
  fairness: 5 as const,
  site_readiness: null,
  unplanned_changes: null,
});

export async function runReviewResponseReportIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const [fixture] = await sql<MainReviewFixture[]>`
    SELECT job.id AS "jobId",
      customer.owner_user_id AS "customerUserId",
      provider.owner_user_id AS "providerUserId",
      customer_review.event_id AS "customerReviewId"
    FROM jobs job
    JOIN customer_profiles customer ON customer.id = job.customer_profile_id
    JOIN craftsman_profiles provider
      ON provider.id = job.primary_craftsman_profile_id
    JOIN job_main_review_events customer_review
      ON customer_review.job_id = job.id
      AND customer_review.direction = 'CUSTOMER_TO_PROVIDER'
      AND customer_review.version = 1
    WHERE NOT EXISTS (
      SELECT 1 FROM job_main_review_events provider_review
      WHERE provider_review.job_id = job.id
        AND provider_review.direction = 'PROVIDER_TO_CUSTOMER'
    )
    ORDER BY customer_review.recorded_at DESC, job.id DESC
    LIMIT 1
  `;
  if (fixture === undefined)
    throw new Error("Committed main-review response fixture missing.");

  const mainReviews = createJobMainReviewRepository(sql);
  expect(
    await mainReviews.submit({
      actorUserId: fixture.providerUserId,
      commandId: randomUUID(),
      expectedVersion: 0,
      jobId: fixture.jobId,
      ratings: providerRatings,
      comment: "Vecná skúsenosť so zákazníkom.",
    }),
  ).toMatchObject({ status: "APPLIED", version: 1 });

  const [unlocked] = await sql<
    Array<{
      readonly ratings: Record<string, unknown>;
      readonly revisionId: string;
    }>
  >`
    SELECT revision_id AS "revisionId", ratings
    FROM current_unlocked_job_main_reviews
    WHERE job_id = ${fixture.jobId}
      AND direction = 'CUSTOMER_TO_PROVIDER'
  `;
  expect(unlocked?.revisionId).toBe(fixture.customerReviewId);
  if (unlocked === undefined)
    throw new Error("Public customer review did not unlock.");

  const repository = createReviewResponseReportRepository(sql);
  const responseId = randomUUID();
  expect(
    await repository.submitResponse({
      actorUserId: fixture.customerUserId,
      body: "Neoprávnená odpoveď autora recenzie.",
      commandId: randomUUID(),
      expectedVersion: 0,
      reviewId: unlocked.revisionId,
    }),
  ).toEqual({ status: "NOT_FOUND" });
  expect(
    await repository.submitResponse({
      actorUserId: fixture.providerUserId,
      body: "Ďakujeme za vecnú spätnú väzbu.",
      commandId: responseId,
      expectedVersion: 0,
      reviewId: unlocked.revisionId,
    }),
  ).toMatchObject({
    responseId,
    revisionId: responseId,
    status: "APPLIED",
    version: 1,
  });
  await expect(
    repository.getResponseForOwner({
      actorUserId: fixture.providerUserId,
      reviewId: unlocked.revisionId,
    }),
  ).resolves.toMatchObject({
    body: "Ďakujeme za vecnú spätnú väzbu.",
    responseId,
    version: 1,
  });
  await expect(
    repository.getResponseForOwner({
      actorUserId: fixture.customerUserId,
      reviewId: unlocked.revisionId,
    }),
  ).resolves.toBeNull();

  const editId = randomUUID();
  expect(
    await repository.submitResponse({
      actorUserId: fixture.providerUserId,
      body: "Ďakujeme za spätnú väzbu a spresnenie.",
      commandId: editId,
      expectedVersion: 1,
      reviewId: unlocked.revisionId,
    }),
  ).toMatchObject({
    responseId,
    revisionId: editId,
    status: "APPLIED",
    version: 2,
  });

  const reviewReportId = randomUUID();
  expect(
    await repository.createReport({
      actorUserId: fixture.providerUserId,
      commandId: reviewReportId,
      details: "Komentár môže obsahovať nerelevantný osobný údaj.",
      reason: "PERSONAL_DATA_PRIVACY",
      targetId: unlocked.revisionId,
      targetType: "MAIN_REVIEW",
    }),
  ).toMatchObject({
    reportId: reviewReportId,
    state: "OPEN",
    status: "APPLIED",
  });
  expect(
    await repository.createReport({
      actorUserId: fixture.providerUserId,
      commandId: randomUUID(),
      reason: "OTHER",
      targetId: unlocked.revisionId,
      targetType: "MAIN_REVIEW",
    }),
  ).toEqual({ status: "ALREADY_REPORTED" });

  const responseReportId = randomUUID();
  expect(
    await repository.createReport({
      actorUserId: fixture.customerUserId,
      commandId: responseReportId,
      reason: "HARASSMENT_ABUSE",
      targetId: responseId,
      targetType: "REVIEW_RESPONSE",
    }),
  ).toMatchObject({
    reportId: responseReportId,
    state: "OPEN",
    status: "APPLIED",
  });

  const [supervisor] = await sql<SupervisorFixture[]>`
    SELECT evaluation.evaluation_id AS "evaluationId",
      evaluation.evaluator_user_id AS "evaluatorUserId",
      profile.owner_user_id AS "targetUserId"
    FROM job_supervisor_evaluations evaluation
    JOIN job_participants participant
      ON participant.id = evaluation.target_participant_id
    JOIN craftsman_profiles profile
      ON profile.id = participant.craftsman_profile_id
    WHERE profile.owner_user_id <> evaluation.evaluator_user_id
    ORDER BY evaluation.created_at DESC, evaluation.evaluation_id DESC
    LIMIT 1
  `;
  if (supervisor === undefined)
    throw new Error("Committed supervisor report fixture missing.");
  expect(
    await repository.createReport({
      actorUserId: supervisor.evaluatorUserId,
      commandId: randomUUID(),
      reason: "OTHER",
      targetId: supervisor.evaluationId,
      targetType: "SUPERVISOR_EVALUATION",
    }),
  ).toEqual({ status: "NOT_FOUND" });
  const supervisorReportId = randomUUID();
  expect(
    await repository.createReport({
      actorUserId: supervisor.targetUserId,
      commandId: supervisorReportId,
      details: "Hodnotenie nezodpovedá vykonanej úlohe.",
      reason: "IRRELEVANT_CONTENT",
      targetId: supervisor.evaluationId,
      targetType: "SUPERVISOR_EVALUATION",
    }),
  ).toMatchObject({
    reportId: supervisorReportId,
    state: "OPEN",
    status: "APPLIED",
  });

  const states = await sql<
    Array<{
      readonly reportId: string;
      readonly state: string;
      readonly version: number;
    }>
  >`
    SELECT report_id AS "reportId", state::text, state_version AS version
    FROM current_moderation_report_states
    WHERE report_id IN (${reviewReportId}, ${responseReportId}, ${supervisorReportId})
    ORDER BY report_id
  `;
  expect(states).toHaveLength(3);
  expect(
    states.every((state) => state.state === "OPEN" && state.version === 1),
  ).toBe(true);

  const [unchanged] = await sql<
    Array<{
      readonly responseVersions: number;
      readonly reviewRatings: Record<string, unknown>;
      readonly reviewVersions: number;
    }>
  >`
    SELECT
      (SELECT count(*)::integer FROM job_main_review_response_events event
        WHERE event.response_id = ${responseId}) AS "responseVersions",
      (SELECT ratings FROM current_unlocked_job_main_reviews review
        WHERE review.revision_id = ${unlocked.revisionId}) AS "reviewRatings",
      (SELECT count(*)::integer FROM job_main_review_events event
        WHERE event.job_id = ${fixture.jobId}
          AND event.direction = 'CUSTOMER_TO_PROVIDER') AS "reviewVersions"
  `;
  expect(unchanged).toEqual({
    responseVersions: 2,
    reviewRatings: unlocked.ratings,
    reviewVersions: 1,
  });

  await expect(
    sql.begin(async (tx) => {
      await tx`UPDATE job_main_review_response_events
        SET body = 'Prepísaná odpoveď' WHERE event_id = ${responseId}`;
    }),
  ).rejects.toThrow("Job main review response history is immutable");
  await expect(
    sql.begin(async (tx) => {
      await tx`DELETE FROM moderation_reports WHERE report_id = ${reviewReportId}`;
    }),
  ).rejects.toThrow("moderation report history is immutable");
}
