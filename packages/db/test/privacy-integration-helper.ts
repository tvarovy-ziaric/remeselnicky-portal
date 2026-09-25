import { createHash, randomUUID } from "node:crypto";

import type { PrivilegedActor } from "@portal/admin-auth";
import type { UserId } from "@portal/domain";
import type { Sql } from "postgres";
import { expect } from "vitest";

import {
  createPrivacyDispositionQueue,
  createPrivacyNotificationDeliveryDispositionExecutor,
  createPrivacyOperationsRepository,
  createPrivacyRecoveryTombstoneStore,
  createPrivacyRepository,
  createPrivacySubjectExportRepository,
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

  await expect(
    operations.decideDataDisposition({
      actionCode: "ACCOUNT_CORE_RETAINED",
      actor: adminActor,
      caseId,
      category: "ACCOUNT_CORE",
      commandId: randomUUID(),
      disposition: "RETAIN",
      expectedDisposition: "REVIEW_REQUIRED",
      expectedRevision: 1,
      expectedState: "BLOCKED",
      policyVersionId: "12000000-0000-4000-8000-000000000001",
      privilegedSessionId: admin.privilegedSessionId,
      reason: "Unreviewed retention policy must fail closed.",
    }),
  ).rejects.toThrow(/executable reviewed retention policy required/u);

  const reviewedAccountPolicyId = randomUUID();
  await expect(
    repository.appendRetentionPolicyVersion({
      category: "ACCOUNT_CORE",
      durationDays: 30,
      launchState: "READY",
      legalReviewState: "APPROVED",
      policyVersionId: reviewedAccountPolicyId,
      rationaleCode: "SYNTHETIC_TEST_POLICY",
      supersedesPolicyVersionId: "12000000-0000-4000-8000-000000000001",
      version: 2,
    }),
  ).resolves.toMatchObject({ status: "APPENDED" });
  const dispositionCommandId = randomUUID();
  const dispositionDecision = {
    actionCode: "ACCOUNT_CORE_RETAINED",
    actor: adminActor,
    caseId,
    category: "ACCOUNT_CORE" as const,
    commandId: dispositionCommandId,
    disposition: "RETAIN" as const,
    expectedDisposition: "REVIEW_REQUIRED" as const,
    expectedRevision: 1,
    expectedState: "BLOCKED" as const,
    policyVersionId: reviewedAccountPolicyId,
    privilegedSessionId: admin.privilegedSessionId,
    reason: "Synthetic reviewed retention decision for integration proof.",
  };
  await expect(
    operations.decideDataDisposition(dispositionDecision),
  ).resolves.toMatchObject({
    disposition: {
      category: "ACCOUNT_CORE",
      disposition: "RETAIN",
      revision: 2,
      state: "COMPLETED",
    },
    status: "APPLIED",
  });
  await expect(
    operations.decideDataDisposition(dispositionDecision),
  ).resolves.toMatchObject({
    disposition: { revision: 2, state: "COMPLETED" },
    status: "DEDUPLICATED",
  });
  await expect(sql`
    UPDATE privacy_data_disposition_admin_commands
    SET reason = 'History rewrite attempt.'
    WHERE command_id = ${dispositionCommandId}
  `).rejects.toThrow(/privacy operational history is append-only/u);

  const reviewedDraftPolicyId = randomUUID();
  await expect(
    repository.appendRetentionPolicyVersion({
      category: "ABANDONED_DRAFT",
      durationDays: 1,
      launchState: "READY",
      legalReviewState: "APPROVED",
      policyVersionId: reviewedDraftPolicyId,
      rationaleCode: "SYNTHETIC_TEST_POLICY",
      supersedesPolicyVersionId: "12000000-0000-4000-8000-000000000002",
      version: 2,
    }),
  ).resolves.toMatchObject({ status: "APPENDED" });
  const destructiveCommandId = randomUUID();
  await expect(
    operations.decideDataDisposition({
      actionCode: "ABANDONED_DRAFT_DELETE_QUEUED",
      actor: adminActor,
      caseId,
      category: "ABANDONED_DRAFT",
      commandId: destructiveCommandId,
      disposition: "DELETE",
      expectedDisposition: "REVIEW_REQUIRED",
      expectedRevision: 1,
      expectedState: "BLOCKED",
      policyVersionId: reviewedDraftPolicyId,
      privilegedSessionId: admin.privilegedSessionId,
      reason: "Synthetic reviewed draft deletion decision for queue proof.",
    }),
  ).resolves.toMatchObject({
    disposition: { state: "READY" },
    status: "APPLIED",
  });

  const dispositionQueue = createPrivacyDispositionQueue(sql);
  const recoveryTombstones = createPrivacyRecoveryTombstoneStore(sql);
  await expect(dispositionQueue.take(Date.now())).resolves.toBeUndefined();
  await expect(recoveryTombstones.listPending()).resolves.toEqual([
    expect.objectContaining({
      category: "ABANDONED_DRAFT",
      disposition: "DELETE",
      subjectUserId: subject.id,
      tombstoneId: destructiveCommandId,
    }),
  ]);
  const syntheticReceipt = `synthetic-independent-ledger:${randomUUID()}`;
  await expect(
    recoveryTombstones.acknowledge({
      ledgerCode: "synthetic.integration",
      receipt: syntheticReceipt,
      tombstoneId: destructiveCommandId,
    }),
  ).resolves.toBe("ACKNOWLEDGED");
  await expect(
    recoveryTombstones.acknowledge({
      ledgerCode: "synthetic.integration",
      receipt: syntheticReceipt,
      tombstoneId: destructiveCommandId,
    }),
  ).resolves.toBe("DEDUPLICATED");
  const delivery = await dispositionQueue.take(Date.now());
  expect(delivery).toMatchObject({
    attempt: 1,
    jobId: destructiveCommandId,
    payload: {
      category: "ABANDONED_DRAFT",
      disposition: "DELETE",
      tombstoneId: destructiveCommandId,
    },
  });
  if (delivery === undefined)
    throw new Error("Expected acknowledged privacy disposition delivery.");
  await dispositionQueue.retry(delivery, {
    availableAt: Date.now() - 1_000,
    errorCode: "SYNTHETIC_EXECUTOR_UNAVAILABLE",
  });
  await expect(
    operations.listDispositions({
      actor: adminActor,
      caseId,
      privilegedSessionId: admin.privilegedSessionId,
    }),
  ).resolves.toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        category: "ABANDONED_DRAFT",
        disposition: "DELETE",
        state: "FAILED",
      }),
    ]),
  );
  const [storedReceipt] = await sql<Array<{ readonly receiptDigest: string }>>`
    SELECT receipt_digest AS "receiptDigest"
    FROM privacy_recovery_tombstone_receipts
    WHERE tombstone_id = ${destructiveCommandId}`;
  expect(storedReceipt?.receiptDigest).toBe(
    createHash("sha256").update(syntheticReceipt, "utf8").digest("hex"),
  );
  expect(storedReceipt?.receiptDigest).not.toBe(syntheticReceipt);

  const retryQueue = createPrivacyDispositionQueue(sql);
  for (let expectedAttempt = 2; expectedAttempt <= 9; expectedAttempt += 1) {
    const retryDelivery = await retryQueue.take(Date.now());
    expect(retryDelivery?.attempt).toBe(expectedAttempt);
    if (retryDelivery === undefined)
      throw new Error("Expected retryable privacy disposition delivery.");
    await retryQueue.retry(retryDelivery, {
      availableAt: Date.now() - 1_000,
      errorCode: "SYNTHETIC_EXECUTOR_UNAVAILABLE",
    });
  }
  const crashQueue = createPrivacyDispositionQueue(sql, {
    leaseDurationMs: 50,
  });
  const finalLease = await crashQueue.take(Date.now());
  expect(finalLease?.attempt).toBe(10);
  await sql`SELECT pg_sleep(0.1)`;
  await expect(crashQueue.take(Date.now())).resolves.toBeUndefined();
  await expect(crashQueue.terminalFailures()).resolves.toEqual([
    expect.objectContaining({
      attempts: 10,
      errorCode: "LEASE_EXPIRED",
      jobId: destructiveCommandId,
      reason: "retries_exhausted",
    }),
  ]);

  const notificationEventId = randomUUID();
  const notificationId = randomUUID();
  const notificationDeliveryId = randomUUID();
  await sql`
    INSERT INTO domain_outbox_events (
      event_id, idempotency_key, event_name, schema_version, occurred_at,
      entity_type, entity_id, payload, command_name, correlation_id
    ) VALUES (
      ${notificationEventId}, ${`privacy-test:${notificationEventId}`},
      'privacy.test.notification', 1, CURRENT_TIMESTAMP,
      'PRIVACY_REQUEST', ${caseId}, '{}'::jsonb,
      'privacy.test.notification', ${caseId}
    )`;
  await sql`
    INSERT INTO notifications (
      id, recipient_user_id, type, domain_event_id,
      event_idempotency_key, entity_type, entity_id, deep_link_path,
      priority, payload, requested_channels, delivery_channels
    ) VALUES (
      ${notificationId}, ${subject.id}, 'privacy.test',
      ${notificationEventId}, ${`privacy-test:${notificationId}`},
      'PRIVACY_REQUEST', ${caseId}, '/ucet/sukromie', 'INFO', '{}'::jsonb,
      ARRAY['IN_APP', 'EMAIL']::notification_channel[],
      ARRAY['IN_APP', 'EMAIL']::notification_channel[]
    )`;
  await sql`
    INSERT INTO notification_deliveries (
      id, notification_id, channel, idempotency_key
    ) VALUES (
      ${notificationDeliveryId}, ${notificationId}, 'EMAIL',
      ${`privacy-test:${notificationDeliveryId}`}
    )`;

  const notificationPolicyId = randomUUID();
  await expect(
    repository.appendRetentionPolicyVersion({
      category: "NOTIFICATION_DELIVERY",
      durationDays: 1,
      launchState: "READY",
      legalReviewState: "APPROVED",
      policyVersionId: notificationPolicyId,
      rationaleCode: "SYNTHETIC_TEST_POLICY",
      supersedesPolicyVersionId: "12000000-0000-4000-8000-000000000014",
      version: 2,
    }),
  ).resolves.toMatchObject({ status: "APPENDED" });
  const notificationDispositionCommandId = randomUUID();
  await expect(
    operations.decideDataDisposition({
      actionCode: "NOTIFICATION_DELIVERY_DELETE_QUEUED",
      actor: adminActor,
      caseId,
      category: "NOTIFICATION_DELIVERY",
      commandId: notificationDispositionCommandId,
      disposition: "DELETE",
      expectedDisposition: "REVIEW_REQUIRED",
      expectedRevision: 1,
      expectedState: "BLOCKED",
      policyVersionId: notificationPolicyId,
      privilegedSessionId: admin.privilegedSessionId,
      reason: "Synthetic reviewed notification delivery cleanup decision.",
    }),
  ).resolves.toMatchObject({
    disposition: { state: "READY" },
    status: "APPLIED",
  });
  await expect(
    recoveryTombstones.acknowledge({
      ledgerCode: "synthetic.integration",
      receipt: `synthetic-independent-ledger:${randomUUID()}`,
      tombstoneId: notificationDispositionCommandId,
    }),
  ).resolves.toBe("ACKNOWLEDGED");
  const notificationQueue = createPrivacyDispositionQueue(sql, {
    leaseDurationMs: 1_000,
  });
  const notificationDelivery = await notificationQueue.take(Date.now());
  expect(notificationDelivery).toMatchObject({
    attempt: 1,
    jobId: notificationDispositionCommandId,
    payload: { category: "NOTIFICATION_DELIVERY", disposition: "DELETE" },
  });
  if (notificationDelivery === undefined)
    throw new Error("Expected notification delivery disposition job.");
  const categoryExecutor =
    createPrivacyNotificationDeliveryDispositionExecutor(sql);
  const executionContext = {
    attempt: notificationDelivery.attempt,
    correlationId: notificationDelivery.correlationId,
    eventId: notificationDelivery.eventId,
    jobId: notificationDelivery.jobId,
    runId: "privacy-integration-run",
  };
  await expect(
    categoryExecutor.execute(notificationDelivery.payload, executionContext),
  ).resolves.toBeUndefined();
  await expect(
    categoryExecutor.execute(notificationDelivery.payload, executionContext),
  ).resolves.toBeUndefined();
  await sql`SELECT pg_sleep(1.1)`;
  await expect(notificationQueue.take(Date.now())).resolves.toBeUndefined();
  await expect(
    categoryExecutor.receipt(notificationDispositionCommandId),
  ).resolves.toMatchObject({
    affectedRecordCount: 1,
    category: "NOTIFICATION_DELIVERY",
    disposition: "DELETE",
    executionAttempt: 1,
  });
  const [notificationRetention] = await sql<
    Array<{ readonly deliveries: number; readonly notifications: number }>
  >`
    SELECT
      count(DISTINCT notification.id)::integer AS notifications,
      count(DISTINCT delivery.id)::integer AS deliveries
    FROM notifications notification
    LEFT JOIN notification_deliveries delivery
      ON delivery.notification_id = notification.id
    WHERE notification.id = ${notificationId}`;
  expect(notificationRetention).toEqual({ deliveries: 0, notifications: 1 });
  await expect(
    operations.listDispositions({
      actor: adminActor,
      caseId,
      privilegedSessionId: admin.privilegedSessionId,
    }),
  ).resolves.toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        category: "NOTIFICATION_DELIVERY",
        disposition: "DELETE",
        state: "COMPLETED",
      }),
    ]),
  );
  await expect(sql`
    UPDATE privacy_category_execution_receipts
    SET affected_record_count = 0
    WHERE job_id = ${notificationDispositionCommandId}
  `).rejects.toThrow(/privacy operational history is append-only/u);

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

  const [exportSubject] = await sql<{ readonly id: UserId }[]>`
    INSERT INTO users DEFAULT VALUES RETURNING id`;
  if (exportSubject === undefined)
    throw new Error("Expected privacy export subject.");
  await sql`
    INSERT INTO auth_credentials (
      user_id, normalized_email, password_hash, adult_attested_at,
      email_verified_at
    ) VALUES (
      ${exportSubject.id}, ${`privacy-export-${exportSubject.id}@example.test`},
      ${"synthetic-password-hash"}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )`;
  const exportCaseId = randomUUID();
  await expect(
    repository.createPrivacyRequestCase({
      caseId: exportCaseId,
      correlationId: randomUUID(),
      eventId: randomUUID(),
      requestType: "ACCESS",
      subjectUserId: exportSubject.id,
    }),
  ).resolves.toMatchObject({ status: "CREATED" });
  await expect(
    operations.transitionRequest({
      actionCode: "IDENTITY_VERIFIED",
      actor: adminActor,
      caseId: exportCaseId,
      commandId: randomUUID(),
      deadlineAt: null,
      expectedRevision: 1,
      expectedState: "RECEIVED",
      privilegedSessionId: admin.privilegedSessionId,
      reason: "Synthetic export identity was proportionately verified.",
      resultingState: "VERIFIED",
    }),
  ).resolves.toMatchObject({ status: "APPLIED" });
  const subjectExports = createPrivacySubjectExportRepository(sql);
  const exportResult = await subjectExports.createForSubject({
    caseId: exportCaseId,
    subjectUserId: exportSubject.id,
  });
  expect(exportResult).toMatchObject({
    document: {
      account: {
        email: `privacy-export-${exportSubject.id}@example.test`,
        userId: exportSubject.id,
      },
      exportCase: {
        caseId: exportCaseId,
        requestState: "VERIFIED",
        requestType: "ACCESS",
      },
      scope: { coverage: "BASE_BUNDLE_REQUIRES_CASE_REVIEW" },
    },
    status: "READY",
  });
  expect(JSON.stringify(exportResult)).not.toMatch(
    /synthetic-password-hash|session_id_hash|actorUserId|storageKey/iu,
  );
  await expect(
    subjectExports.createForSubject({
      caseId: exportCaseId,
      subjectUserId: subject.id,
    }),
  ).resolves.toEqual({ status: "NOT_FOUND" });

  const restoreNotificationEventId = randomUUID();
  const restoreNotificationId = randomUUID();
  const restoreDeliveryId = randomUUID();
  await sql`
    INSERT INTO domain_outbox_events (
      event_id, idempotency_key, event_name, schema_version, occurred_at,
      entity_type, entity_id, payload, command_name, correlation_id
    ) VALUES (
      ${restoreNotificationEventId},
      ${`privacy-restore-test:${restoreNotificationEventId}`},
      'privacy.restore.test.notification', 1, CURRENT_TIMESTAMP,
      'PRIVACY_REQUEST', ${exportCaseId}, '{}'::jsonb,
      'privacy.restore.test.notification', ${exportCaseId}
    )`;
  await sql`
    INSERT INTO notifications (
      id, recipient_user_id, type, domain_event_id,
      event_idempotency_key, entity_type, entity_id, deep_link_path,
      priority, payload, requested_channels, delivery_channels
    ) VALUES (
      ${restoreNotificationId}, ${exportSubject.id}, 'privacy.restore.test',
      ${restoreNotificationEventId},
      ${`privacy-restore-test:${restoreNotificationId}`},
      'PRIVACY_REQUEST', ${exportCaseId}, '/ucet/sukromie', 'INFO',
      '{}'::jsonb, ARRAY['IN_APP', 'EMAIL']::notification_channel[],
      ARRAY['IN_APP', 'EMAIL']::notification_channel[]
    )`;
  await sql`
    INSERT INTO notification_deliveries (
      id, notification_id, channel, idempotency_key
    ) VALUES (
      ${restoreDeliveryId}, ${restoreNotificationId}, 'EMAIL',
      ${`privacy-restore-test:${restoreDeliveryId}`}
    )`;

  const restoreTombstoneId = randomUUID();
  const restorePolicyVersionId = randomUUID();
  const restoreSourceCreatedAt = "2026-09-25T10:00:00.000Z";
  const restoreReceiptDigest = "d".repeat(64);
  const firstRestoreRunId = `restore-live-${randomUUID()}`;
  const firstReplay = await sql.begin(async (transaction) => {
    await transaction`
      SELECT run_id FROM begin_privacy_restore_reapplication(
        ${firstRestoreRunId}, 'integration.privacy-ledger', ${"e".repeat(64)}, 1
      )`;
    const [item] = await transaction<
      Array<{ readonly affectedCount: number; readonly outcome: string }>
    >`
      SELECT
        outcome::text AS outcome,
        affected_record_count::integer AS "affectedCount"
      FROM apply_privacy_restore_tombstone(
        ${firstRestoreRunId}, ${restoreTombstoneId}::uuid,
        ${restoreTombstoneId}::uuid, ${exportSubject.id}::uuid,
        'NOTIFICATION_DELIVERY'::privacy_retention_category,
        'DELETE'::privacy_data_disposition, ${restorePolicyVersionId}::uuid,
        ${restoreReceiptDigest}::char(64),
        ${restoreSourceCreatedAt}::timestamptz
      )`;
    const [completed] = await transaction<
      Array<{
        readonly alreadyApplied: number;
        readonly applied: number;
        readonly state: string;
      }>
    >`
      SELECT
        state::text AS state,
        records_applied::integer AS applied,
        records_already_applied::integer AS "alreadyApplied"
      FROM complete_privacy_restore_reapplication(${firstRestoreRunId})`;
    return { completed, item };
  });
  expect(firstReplay).toEqual({
    completed: { alreadyApplied: 0, applied: 1, state: "COMPLETED" },
    item: { affectedCount: 1, outcome: "APPLIED" },
  });
  const [restoreEffect] = await sql<
    Array<{ readonly deliveries: number; readonly notifications: number }>
  >`
    SELECT
      count(DISTINCT notification.id)::integer AS notifications,
      count(DISTINCT delivery.id)::integer AS deliveries
    FROM notifications notification
    LEFT JOIN notification_deliveries delivery
      ON delivery.notification_id = notification.id
    WHERE notification.id = ${restoreNotificationId}`;
  expect(restoreEffect).toEqual({ deliveries: 0, notifications: 1 });

  const secondRestoreRunId = `restore-live-${randomUUID()}`;
  const secondReplay = await sql.begin(async (transaction) => {
    await transaction`
      SELECT run_id FROM begin_privacy_restore_reapplication(
        ${secondRestoreRunId}, 'integration.privacy-ledger', ${"f".repeat(64)}, 1
      )`;
    const [item] = await transaction<
      Array<{ readonly affectedCount: number; readonly outcome: string }>
    >`
      SELECT
        outcome::text AS outcome,
        affected_record_count::integer AS "affectedCount"
      FROM apply_privacy_restore_tombstone(
        ${secondRestoreRunId}, ${restoreTombstoneId}::uuid,
        ${restoreTombstoneId}::uuid, ${exportSubject.id}::uuid,
        'NOTIFICATION_DELIVERY'::privacy_retention_category,
        'DELETE'::privacy_data_disposition, ${restorePolicyVersionId}::uuid,
        ${restoreReceiptDigest}::char(64),
        ${restoreSourceCreatedAt}::timestamptz
      )`;
    const [completed] = await transaction<
      Array<{
        readonly alreadyApplied: number;
        readonly applied: number;
        readonly state: string;
      }>
    >`
      SELECT
        state::text AS state,
        records_applied::integer AS applied,
        records_already_applied::integer AS "alreadyApplied"
      FROM complete_privacy_restore_reapplication(${secondRestoreRunId})`;
    return { completed, item };
  });
  expect(secondReplay).toEqual({
    completed: { alreadyApplied: 1, applied: 0, state: "COMPLETED" },
    item: { affectedCount: 0, outcome: "ALREADY_APPLIED" },
  });

  await expect(
    sql.begin(async (transaction) => {
      const incompleteRunId = `restore-live-${randomUUID()}`;
      await transaction`
        SELECT run_id FROM begin_privacy_restore_reapplication(
          ${incompleteRunId}, 'integration.privacy-ledger',
          ${"1".repeat(64)}, 1
        )`;
      await transaction`
        SELECT run_id FROM complete_privacy_restore_reapplication(
          ${incompleteRunId}
        )`;
    }),
  ).rejects.toThrow(/privacy restore run item count mismatch/u);

  await expect(
    sql.begin(async (transaction) => {
      const unsupportedRunId = `restore-live-${randomUUID()}`;
      const unsupportedTombstoneId = randomUUID();
      await transaction`
        SELECT run_id FROM begin_privacy_restore_reapplication(
          ${unsupportedRunId}, 'integration.privacy-ledger',
          ${"2".repeat(64)}, 1
        )`;
      await transaction`
        SELECT outcome FROM apply_privacy_restore_tombstone(
          ${unsupportedRunId}, ${unsupportedTombstoneId}::uuid,
          ${unsupportedTombstoneId}::uuid, ${exportSubject.id}::uuid,
          'ACCOUNT_CORE'::privacy_retention_category,
          'DELETE'::privacy_data_disposition, ${randomUUID()}::uuid,
          ${"3".repeat(64)}::char(64),
          ${restoreSourceCreatedAt}::timestamptz
        )`;
    }),
  ).rejects.toThrow(/unsupported privacy restore tombstone category/u);

  await expect(sql`
    UPDATE privacy_restore_reapplication_runs
    SET records_applied = 0
    WHERE run_id = ${firstRestoreRunId}
  `).rejects.toThrow(/invalid privacy restore run transition/u);
  await expect(sql`
    UPDATE privacy_restore_applied_tombstones
    SET affected_record_count = 0
    WHERE tombstone_id = ${restoreTombstoneId}
  `).rejects.toThrow(/privacy restore history is immutable/u);
}
