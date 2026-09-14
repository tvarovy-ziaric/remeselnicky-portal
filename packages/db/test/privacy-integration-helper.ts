import { randomUUID } from "node:crypto";

import type { UserId } from "@portal/domain";
import type { Sql } from "postgres";
import { expect } from "vitest";

import { createPrivacyRepository } from "../src/index.js";

/** Runs inside the single clean-migration integration test to avoid migration races. */
export async function runPrivacyIntegrationAssertions(sql: Sql): Promise<void> {
  const [subject] = await sql<{ id: UserId }[]>`
    INSERT INTO users DEFAULT VALUES RETURNING id
  `;
  if (subject === undefined) throw new Error("Expected privacy test subject.");

  const repository = createPrivacyRepository(sql);
  const marketingPolicyId = randomUUID();
  const portfolioPolicyId = randomUUID();
  await sql`
    INSERT INTO privacy_policy_versions (
      policy_version_id,
      policy_kind,
      optional_consent_purpose,
      version_label,
      content_sha256,
      review_state,
      effective_at
    ) VALUES
      (
        ${marketingPolicyId},
        'OPTIONAL_CONSENT_TEXT',
        'MARKETING_EMAIL',
        ${`integration-marketing-${marketingPolicyId}`},
        ${"a".repeat(64)},
        'APPROVED',
        CURRENT_TIMESTAMP
      ),
      (
        ${portfolioPolicyId},
        'OPTIONAL_CONSENT_TEXT',
        'PORTFOLIO_PROPERTY_PHOTO_PUBLICATION',
        ${`integration-portfolio-${portfolioPolicyId}`},
        ${"b".repeat(64)},
        'APPROVED',
        CURRENT_TIMESTAMP
      )
  `;

  await expect(sql`
    INSERT INTO privacy_consent_events (
      event_id,
      correlation_id,
      subject_user_id,
      purpose,
      action,
      policy_version_id,
      revision
    ) VALUES (
      ${randomUUID()},
      ${randomUUID()},
      ${subject.id},
      'MARKETING_EMAIL',
      'GRANTED',
      ${portfolioPolicyId},
      1
    )
  `).rejects.toThrow(/optional consent policy is not approved and effective/u);

  await expect(sql`
    INSERT INTO privacy_consent_events (
      event_id,
      correlation_id,
      subject_user_id,
      purpose,
      action,
      policy_version_id,
      revision
    ) VALUES (
      ${randomUUID()},
      ${randomUUID()},
      ${subject.id},
      'MARKETING_EMAIL',
      'WITHDRAWN',
      ${marketingPolicyId},
      1
    )
  `).rejects.toThrow(/first consent event must be revision 1 GRANTED/u);

  const consentBase = {
    action: "GRANTED" as const,
    expectedRevision: 0,
    policyVersionId: marketingPolicyId,
    purpose: "MARKETING_EMAIL" as const,
    subjectUserId: subject.id,
  };
  const beforeConsent = new Date();
  const competingConsent = await Promise.all([
    repository.appendConsentEvent({
      ...consentBase,
      correlationId: randomUUID(),
      eventId: randomUUID(),
    }),
    repository.appendConsentEvent({
      ...consentBase,
      correlationId: randomUUID(),
      eventId: randomUUID(),
    }),
  ]);
  expect(competingConsent.map(({ status }) => status).sort()).toEqual([
    "APPENDED",
    "STALE",
  ]);
  const granted = competingConsent.find(
    (result) => result.status === "APPENDED",
  );
  if (granted?.status !== "APPENDED")
    throw new Error("Expected consent grant.");
  expect(granted.event.revision).toBe(1);
  expect(granted.event.occurredAt.valueOf()).toBeGreaterThanOrEqual(
    beforeConsent.valueOf(),
  );
  await expect(
    repository.appendConsentEvent({
      action: "WITHDRAWN",
      correlationId: randomUUID(),
      eventId: randomUUID(),
      expectedRevision: 1,
      policyVersionId: marketingPolicyId,
      purpose: "MARKETING_EMAIL",
      subjectUserId: subject.id,
    }),
  ).resolves.toMatchObject({ event: { revision: 2 }, status: "APPENDED" });
  await expect(sql`
    UPDATE privacy_consent_events
    SET action = 'GRANTED'
    WHERE event_id = ${granted.event.eventId}
  `).rejects.toThrow(/privacy history is append-only/u);

  const retentionSeedId = "12000000-0000-4000-8000-000000000017";
  const retentionRace = await Promise.allSettled([
    repository.appendRetentionPolicyVersion({
      category: "BACKUP",
      durationDays: null,
      launchState: "BLOCKED",
      legalReviewState: "UNRESOLVED",
      policyVersionId: randomUUID(),
      rationaleCode: "LEGAL_REVIEW_REQUIRED",
      supersedesPolicyVersionId: retentionSeedId,
      version: 2,
    }),
    repository.appendRetentionPolicyVersion({
      category: "BACKUP",
      durationDays: null,
      launchState: "BLOCKED",
      legalReviewState: "UNRESOLVED",
      policyVersionId: randomUUID(),
      rationaleCode: "LEGAL_REVIEW_REQUIRED",
      supersedesPolicyVersionId: retentionSeedId,
      version: 2,
    }),
  ]);
  expect(
    retentionRace.filter(({ status }) => status === "fulfilled"),
  ).toHaveLength(1);
  expect(
    retentionRace.filter(({ status }) => status === "rejected"),
  ).toHaveLength(1);

  const caseId = randomUUID();
  const beforeCase = new Date();
  const requestDraft = {
    caseId,
    correlationId: randomUUID(),
    eventId: randomUUID(),
    requestType: "ACCOUNT_CLOSURE",
    subjectUserId: subject.id,
  } as const;
  const competingOpen = await Promise.all([
    repository.createPrivacyRequestCase(requestDraft),
    repository.createPrivacyRequestCase(requestDraft),
  ]);
  expect(competingOpen.map(({ status }) => status).sort()).toEqual([
    "CREATED",
    "DEDUPLICATED",
  ]);
  const opened = competingOpen[0];
  if (opened === undefined) throw new Error("Expected privacy request case.");
  expect(opened.receivedAt.valueOf()).toBeGreaterThanOrEqual(
    beforeCase.valueOf(),
  );

  const requestRace = await Promise.all([
    repository.appendPrivacyRequestEvent({
      actionCode: "IDENTITY_VERIFIED",
      actorUserId: subject.id,
      caseId,
      correlationId: randomUUID(),
      deadlineAt: null,
      eventId: randomUUID(),
      expectedRevision: 1,
      state: "VERIFIED",
    }),
    repository.appendPrivacyRequestEvent({
      actionCode: "IDENTITY_VERIFIED",
      actorUserId: subject.id,
      caseId,
      correlationId: randomUUID(),
      deadlineAt: null,
      eventId: randomUUID(),
      expectedRevision: 1,
      state: "VERIFIED",
    }),
  ]);
  expect(requestRace.map(({ status }) => status).sort()).toEqual([
    "APPENDED",
    "STALE",
  ]);

  await expect(sql`
    INSERT INTO privacy_request_events (
      event_id,
      correlation_id,
      case_id,
      actor_user_id,
      revision,
      state,
      action_code
    ) VALUES (
      ${randomUUID()},
      ${randomUUID()},
      ${caseId},
      ${subject.id},
      4,
      'COMPLETED',
      'REQUEST_COMPLETED'
    )
  `).rejects.toThrow(/privacy request revisions must be contiguous/u);

  await sql`
    UPDATE users
    SET account_state = 'DEACTIVATED',
        account_state_changed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${subject.id}
  `;
  const [retained] = await sql<{ accountState: string; cases: number }[]>`
    SELECT
      users.account_state AS "accountState",
      count(privacy_request_cases.case_id)::integer AS cases
    FROM users
    LEFT JOIN privacy_request_cases
      ON privacy_request_cases.subject_user_id = users.id
    WHERE users.id = ${subject.id}
    GROUP BY users.id
  `;
  expect(retained).toEqual({ accountState: "DEACTIVATED", cases: 1 });
  await expect(
    sql`DELETE FROM users WHERE id = ${subject.id}`,
  ).rejects.toThrow();
}
