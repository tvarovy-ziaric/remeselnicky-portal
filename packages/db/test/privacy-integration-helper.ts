import { createHash, randomUUID } from "node:crypto";

import type { PrivilegedActor } from "@portal/admin-auth";
import type { UserId } from "@portal/domain";
import type { Sql } from "postgres";
import { expect } from "vitest";

import {
  createPrivacyOperationsRepository,
  createPrivacyRepository,
} from "../src/index.js";

/** Runs inside the single clean-migration integration test to avoid migration races. */
export async function runPrivacyIntegrationAssertions(
  sql: Sql,
  admin: {
    readonly adminId: UserId;
    readonly privilegedSessionId: string;
  },
): Promise<void> {
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

  const operations = createPrivacyOperationsRepository(sql);
  const adminActor: PrivilegedActor = {
    capabilities: new Set(["admin.privacy.manage"]),
    mfaAuthenticatedAt: new Date(),
    roles: ["ADMIN"],
    userId: admin.adminId,
  };
  await expect(
    operations.transitionRequest({
      actionCode: "REQUEST_REVIEW_STARTED",
      actor: adminActor,
      caseId,
      commandId: randomUUID(),
      deadlineAt: null,
      expectedRevision: 2,
      expectedState: "VERIFIED",
      privilegedSessionId: admin.privilegedSessionId,
      reason: "Verified account closure request entered review.",
      resultingState: "IN_REVIEW",
    }),
  ).resolves.toMatchObject({
    revision: 3,
    state: "IN_REVIEW",
    status: "APPLIED",
  });

  await expect(sql`
    INSERT INTO privacy_account_closure_commands (
      command_id, case_id, subject_user_id, actor_user_id,
      actor_privileged_session_hash, expected_request_revision,
      expected_request_state, resulting_request_revision,
      reason_code, reason, payload_fingerprint
    ) VALUES (
      ${randomUUID()}, ${caseId}, ${subject.id}, ${admin.adminId},
      ${"0".repeat(64)}, 3, 'IN_REVIEW', 4,
      'INVALID_MFA_ATTEMPT', 'Invalid session must fail closed.',
      ${"f".repeat(64)}
    )
  `).rejects.toThrow(/recent MFA(?:-backed privacy capability)? required/u);

  const subjectSessionDigest = createHash("sha256")
    .update(`privacy-subject-session-${randomUUID()}`, "utf8")
    .digest("hex");
  await sql`
    INSERT INTO auth_sessions (
      session_id_hash, user_id, payload, expires_at
    ) VALUES (
      ${subjectSessionDigest}, ${subject.id}, ${sql.json({})},
      CURRENT_TIMESTAMP + INTERVAL '30 minutes'
    )
  `;
  const closureCommandId = randomUUID();
  const closure = await operations.executeAccountClosure({
    actor: adminActor,
    caseId,
    commandId: closureCommandId,
    expectedRequestRevision: 3,
    expectedRequestState: "IN_REVIEW",
    privilegedSessionId: admin.privilegedSessionId,
    reason: "Verified request has no open marketplace obligations.",
    reasonCode: "VERIFIED_ACCOUNT_CLOSURE",
    subjectUserId: subject.id,
  });
  expect(closure).toMatchObject({
    requestRevision: 4,
    requestState: "ACTION_REQUIRED",
    status: "APPLIED",
  });
  if (closure.status !== "APPLIED")
    throw new Error("Expected applied account closure command.");
  expect(closure.dispositions).toHaveLength(17);
  expect(
    closure.dispositions.every(
      ({ disposition, policyVersionId, state }) =>
        disposition === "REVIEW_REQUIRED" &&
        policyVersionId === null &&
        state === "BLOCKED",
    ),
  ).toBe(true);

  const [closed] = await sql<
    Array<{
      readonly accountState: string;
      readonly cases: number;
      readonly requestRevision: number;
      readonly requestState: string;
      readonly revokedSessions: number;
    }>
  >`
    SELECT users.account_state::text AS "accountState",
      count(DISTINCT request.case_id)::integer AS cases,
      current_request.revision AS "requestRevision",
      current_request.state::text AS "requestState",
      count(DISTINCT session.session_id_hash)
        FILTER (WHERE session.revoked_at IS NOT NULL)::integer
        AS "revokedSessions"
    FROM users
    LEFT JOIN privacy_request_cases request
      ON request.subject_user_id = users.id
    LEFT JOIN current_privacy_request_cases current_request
      ON current_request.case_id = request.case_id
    LEFT JOIN auth_sessions session ON session.user_id = users.id
    WHERE users.id = ${subject.id}
    GROUP BY users.id, current_request.revision, current_request.state
  `;
  expect(closed).toEqual({
    accountState: "DEACTIVATED",
    cases: 1,
    requestRevision: 4,
    requestState: "ACTION_REQUIRED",
    revokedSessions: 1,
  });

  await expect(
    operations.transitionRequest({
      actionCode: "REQUEST_COMPLETED",
      actor: adminActor,
      caseId,
      commandId: randomUUID(),
      deadlineAt: null,
      expectedRevision: 4,
      expectedState: "ACTION_REQUIRED",
      privilegedSessionId: admin.privilegedSessionId,
      reason: "Completion must wait for every category disposition.",
      resultingState: "COMPLETED",
    }),
  ).rejects.toThrow(/all privacy category dispositions must complete/u);

  await expect(sql`
    UPDATE privacy_account_closure_commands
    SET reason = 'History rewrite attempt.'
    WHERE command_id = ${closureCommandId}
  `).rejects.toThrow(/privacy operational history is append-only/u);

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
