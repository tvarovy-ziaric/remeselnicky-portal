import { randomUUID } from "node:crypto";

import {
  createMemoryAnalyticsTransport,
  createR3AnalyticsProcessor,
  createTrustedAnalyticsPublisher,
} from "@portal/analytics";
import type { QuoteId, UserId } from "@portal/domain";
import type { Sql, TransactionSql } from "postgres";
import { expect } from "vitest";

import {
  createR3AnalyticsLeaseStore,
  createR3AnalyticsObservationRepository,
} from "../src/r3-analytics-repository.js";
import { createQuoteRepository } from "../src/quote-repository.js";

export async function runR3AnalyticsIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const [subject] = await sql<{ userId: string }[]>`
    SELECT id AS "userId" FROM users ORDER BY created_at, id LIMIT 1
  `;
  expect(subject).toBeDefined();
  if (subject === undefined) return;
  const [sourceCount] = await sql<{ count: number }[]>`
    SELECT count(*)::integer AS count FROM domain_outbox_events
    WHERE event_name LIKE 'r3.analytics.%'
  `;
  expect(sourceCount?.count).toBeGreaterThan(0);
  await createCommittedQuoteRejectionEffect(sql);
  await assertExistingSourceCoverage(sql);
  await assertDeclineEffectInRollback(sql);
  const unsafe = await sql<{ eventName: string }[]>`
    SELECT event_name AS "eventName" FROM domain_outbox_events
    WHERE event_name LIKE 'r3.analytics.%'
      AND payload::text ~* '(body|address|storage|email|phone|filename|sha256|message_id|media_asset_id|hash)'
  `;
  expect(unsafe).toEqual([]);

  await sql`
    INSERT INTO user_analytics_traffic_classification_events (
      user_id, revision, traffic_class
    ) VALUES (
      ${subject.userId},
      coalesce((SELECT max(revision) + 1
        FROM user_analytics_traffic_classification_events
        WHERE user_id = ${subject.userId}), 1),
      'TEST'
    )
  `;
  const occurredAt = new Date("2026-09-15T18:00:00.000Z");
  const key = `r3-analytics:integration:${randomUUID()}`;
  const [first] = await sql<{ id: string }[]>`
    SELECT insert_exact_r3_analytics_source_event(
      ${key}, 'r3.analytics.job_request_started', ${occurredAt},
      'JOB_REQUEST', ${randomUUID()},
      r3_analytics_subject_payload(${subject.userId}, 'CUSTOMER', 'USER',
        jsonb_build_object('job_request_id', ${randomUUID()}::text)),
      'integration.analytics', ${randomUUID()}
    ) AS id
  `;
  expect(first?.id).toMatch(/^[0-9a-f-]{36}$/u);
  if (first === undefined) throw new Error("analytics source fixture missing");
  const [stored] = await sql<{ trafficClass: string }[]>`
    SELECT payload ->> 'traffic_class' AS "trafficClass"
    FROM domain_outbox_events WHERE event_id = ${first.id}
  `;
  expect(stored?.trafficClass).toBe("TEST");

  const replay = await sql<{ id: string }[]>`
    SELECT insert_exact_r3_analytics_source_event(
      ${key}, event_name, occurred_at, entity_type, entity_id, payload,
      command_name, correlation_id
    ) AS id
    FROM domain_outbox_events WHERE event_id = ${first.id}
  `;
  expect(replay[0]?.id).toBe(first.id);
  await expect(
    sql.begin(async (tx) => {
      await tx`
        SELECT insert_exact_r3_analytics_source_event(
          ${key}, 'r3.analytics.job_request_started', ${occurredAt},
          'JOB_REQUEST', ${randomUUID()}, '{}'::jsonb,
          'integration.analytics', ${randomUUID()}
        )
      `;
    }),
  ).rejects.toThrow(/idempotency key collision/u);

  // Analytics remains independently claimable after another consumer has
  // completed the global outbox row.
  await sql`
    UPDATE domain_outbox_events
    SET status = 'PUBLISHED', published_at = GREATEST(clock_timestamp(), occurred_at),
      lease_token = NULL, lease_expires_at = NULL, last_error_code = NULL,
      updated_at = clock_timestamp()
    WHERE event_id = ${first.id}
  `;

  await sql`
    UPDATE r3_analytics_event_deliveries
    SET state = 'TERMINAL_SKIPPED', last_error_code = 'TEST_ISOLATION',
      terminal_at = clock_timestamp(), updated_at = clock_timestamp()
    WHERE source_event_id <> ${first.id} AND state = 'PENDING'
  `;
  const transport = createMemoryAnalyticsTransport("staging");
  const processor = createR3AnalyticsProcessor({
    backoffMs: () => 1,
    leaseDurationMs: 30_000,
    publisher: createTrustedAnalyticsPublisher({
      appVersion: "r3-integration",
      environment: "staging",
      platform: "WEB",
      transport,
    }),
    store: createR3AnalyticsLeaseStore(sql),
  });
  await expect(processor.processNext()).resolves.toMatchObject({
    eventId: first.id,
    status: "DELIVERED",
  });
  expect(transport.events()[0]).toMatchObject({
    event_id: first.id,
    event_name: "job_request_started",
    schema_version: 1,
  });
  const effects = await sql<{ count: number }[]>`
    SELECT count(*)::integer AS count FROM outbox_consumer_effects
    WHERE consumer_name = 'analytics.r3-funnel' AND event_id = ${first.id}
  `;
  expect(effects[0]?.count).toBe(1);

  await assertVersionedReplayAndTransientRetry(sql, subject.userId);

  const malformedId = randomUUID();
  await sql`
    INSERT INTO domain_outbox_events (
      event_id, idempotency_key, event_name, schema_version, occurred_at,
      entity_type, entity_id, payload, command_name, correlation_id, available_at
    ) VALUES (
      ${malformedId}, ${`r3-analytics:malformed:${malformedId}`},
      'r3.analytics.job_request_started', 1, clock_timestamp(),
      'JOB_REQUEST', ${randomUUID()}, '{}'::jsonb,
      'integration.analytics', ${malformedId}, clock_timestamp()
    )
  `;
  await sql`
    INSERT INTO r3_analytics_event_deliveries (
      source_event_id, available_at
    ) VALUES (${malformedId}, clock_timestamp())
  `;
  await expect(processor.processNext()).resolves.toMatchObject({
    eventId: malformedId,
    status: "TERMINAL",
  });
  const [malformed] = await sql<{ state: string }[]>`
    SELECT state FROM r3_analytics_event_deliveries
    WHERE source_event_id = ${malformedId}
  `;
  expect(malformed?.state).toBe("TERMINAL_INVALID");

  await assertInvitationViewAuthorization(sql);
  await assertConsentedObservation(sql);
}

async function createCommittedQuoteRejectionEffect(sql: Sql): Promise<void> {
  const [target] = await sql<
    Array<{
      readonly customerOwnerId: UserId;
      readonly quoteId: QuoteId;
      readonly quoteRevision: number;
      readonly stateRevision: number;
    }>
  >`
    SELECT customer.owner_user_id AS "customerOwnerId",
      state.quote_id AS "quoteId", state.revision AS "quoteRevision",
      state.state_revision AS "stateRevision"
    FROM current_quote_revision_states state
    JOIN quotes quote ON quote.id = state.quote_id
    JOIN current_job_invitations invitation
      ON invitation.id = quote.invitation_id
      AND invitation.state = 'ENGAGED'
    JOIN current_conversations conversation
      ON conversation.id = quote.conversation_id
      AND conversation.access_state = 'WRITABLE'
    JOIN job_invitations identity ON identity.id = invitation.id
    JOIN customer_profiles customer
      ON customer.id = identity.customer_profile_id
    JOIN users owner ON owner.id = customer.owner_user_id
      AND owner.account_state = 'ACTIVE'
    WHERE state.state = 'SUBMITTED'
    ORDER BY state.changed_at, state.quote_id
    LIMIT 1
  `;
  if (target === undefined) {
    throw new Error("R3 analytics Quote rejection fixture is unavailable.");
  }
  const result = await createQuoteRepository(sql).reject({
    actorUserId: target.customerOwnerId,
    commandId: randomUUID(),
    expectedStateRevision: target.stateRevision,
    quoteId: target.quoteId,
    rejectionReason: null,
    revision: target.quoteRevision,
  });
  expect(result.status).toBe("APPLIED");
}

export async function runR3AnalyticsPostLifecycleAssertions(
  sql: Sql,
): Promise<void> {
  const rows = await sql<{ eventName: string }[]>`
    SELECT DISTINCT event_name AS "eventName"
    FROM domain_outbox_events
    WHERE event_name IN (
      'r3.analytics.job_request_cancelled',
      'r3.analytics.invitation_withdrawn'
    )
    ORDER BY event_name
  `;
  expect(rows.map((row) => row.eventName)).toEqual([
    "r3.analytics.invitation_withdrawn",
    "r3.analytics.job_request_cancelled",
  ]);
}

async function assertExistingSourceCoverage(sql: Sql): Promise<void> {
  const required = [
    "r3.analytics.conversation_attachment_ready",
    "r3.analytics.conversation_bilateral_participation_reached",
    "r3.analytics.conversation_first_message_sent",
    "r3.analytics.invitation_engaged",
    "r3.analytics.invitation_not_selected",
    "r3.analytics.invitation_received",
    "r3.analytics.invitation_sent",
    "r3.analytics.job_request_materially_revised",
    "r3.analytics.job_request_started",
    "r3.analytics.job_request_submitted_v2",
    "r3.analytics.quote_draft_created",
    "r3.analytics.quote_expired",
    "r3.analytics.quote_rejected",
    "r3.analytics.quote_revision_submitted",
    "r3.analytics.quote_submitted_v2",
    "r3.analytics.quote_withdrawn",
  ] as const;
  const rows = await sql<{ eventName: string }[]>`
    SELECT DISTINCT event_name AS "eventName"
    FROM domain_outbox_events
    WHERE event_name = ANY(${sql.array([...required])})
    ORDER BY event_name
  `;
  expect(rows.map((row) => row.eventName)).toEqual([...required]);
  const missingDelivery = await sql<{ eventId: string }[]>`
    SELECT source.event_id AS "eventId"
    FROM domain_outbox_events source
    LEFT JOIN r3_analytics_event_deliveries delivery
      ON delivery.source_event_id = source.event_id
    WHERE source.event_name = ANY(${sql.array([...required])})
      AND delivery.source_event_id IS NULL
  `;
  expect(missingDelivery).toEqual([]);
}

async function assertDeclineEffectInRollback(sql: Sql): Promise<void> {
  const marker = "ROLLBACK_R3_ANALYTICS_DECLINE_PROBE";
  await expect(
    sql.begin(async (tx) => {
      const [target] = await tx<
        {
          invitationId: string;
          providerOwnerId: string;
          revision: number;
        }[]
      >`
        SELECT invitation.id AS "invitationId",
          craftsman.owner_user_id AS "providerOwnerId", current.revision
        FROM current_job_invitations current
        JOIN job_invitations invitation ON invitation.id = current.id
        JOIN craftsman_profiles craftsman
          ON craftsman.id = invitation.craftsman_profile_id
        JOIN users provider ON provider.id = craftsman.owner_user_id
          AND provider.account_state = 'ACTIVE'
        JOIN auth_credentials credential
          ON credential.user_id = provider.id
          AND credential.email_verified_at IS NOT NULL
          AND credential.phone_verified_at IS NOT NULL
        WHERE current.state = 'PENDING'
        ORDER BY invitation.created_at, invitation.id
        LIMIT 1
      `;
      expect(target).toBeDefined();
      if (target === undefined) {
        throw new Error("pending invitation decline fixture is missing");
      }
      const commandId = randomUUID();
      await tx`
        INSERT INTO job_invitation_commands (
          command_id, invitation_id, actor_user_id, command_kind,
          expected_revision, resulting_revision, target_state,
          system_initiated, decline_reason, decline_note, payload_fingerprint
        ) VALUES (
          ${commandId}, ${target.invitationId}, ${target.providerOwnerId},
          'DECLINE', ${target.revision}, ${target.revision + 1}, 'DECLINED',
          false, 'TIMING', NULL, ${"0".repeat(64)}
        )
      `;
      await tx`
        INSERT INTO job_invitation_revisions (
          invitation_id, revision, command_id, state, changed_at, sent_at,
          expires_at, engaged_at, decline_reason, decline_note
        ) VALUES (
          ${target.invitationId}, ${target.revision + 1}, ${commandId},
          'DECLINED', clock_timestamp(), clock_timestamp(), clock_timestamp(),
          NULL, 'TIMING', NULL
        )
      `;
      const [effect] = await tx<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM domain_outbox_events
        WHERE event_name = 'r3.analytics.invitation_declined'
          AND correlation_id = ${commandId}
          AND payload ->> 'decline_reason_category' = 'TIMING'
      `;
      expect(effect?.count).toBe(1);
      throw new Error(marker);
    }),
  ).rejects.toThrow(marker);
}

async function assertConsentedObservation(sql: Sql): Promise<void> {
  const [target] = await sql<
    {
      actorUserId: string;
      jobRequestId: string;
      quoteId: string;
      quoteRevision: number;
    }[]
  >`
    SELECT customer.owner_user_id AS "actorUserId",
      invitation.job_request_id AS "jobRequestId", quote.id AS "quoteId",
      submitted.revision AS "quoteRevision"
    FROM current_submitted_quotes submitted
    JOIN quotes quote ON quote.id = submitted.quote_id
    JOIN job_invitations invitation ON invitation.id = quote.invitation_id
    JOIN customer_profiles customer ON customer.id = invitation.customer_profile_id
    JOIN users actor ON actor.id = customer.owner_user_id
      AND actor.account_state = 'ACTIVE'
    WHERE quote_revision_authoring_is_eligible(
      submitted.quote_id, submitted.revision, submitted.authoring_mode)
    LIMIT 1
  `;
  if (target === undefined) return;
  const [policy] = await sql<{ policyVersionId: string }[]>`
    SELECT policy_version_id AS "policyVersionId"
    FROM privacy_policy_versions
    WHERE policy_kind = 'OPTIONAL_CONSENT_TEXT'
      AND optional_consent_purpose = 'NON_ESSENTIAL_ANALYTICS'
      AND review_state = 'APPROVED'
      AND effective_at <= CURRENT_TIMESTAMP
    ORDER BY effective_at DESC, created_at DESC, policy_version_id DESC LIMIT 1
  `;
  if (policy === undefined) return;
  const [consent] = await sql<{ action: string; revision: number }[]>`
    SELECT action, revision FROM privacy_consent_events
    WHERE subject_user_id = ${target.actorUserId}
      AND purpose = 'NON_ESSENTIAL_ANALYTICS'
    ORDER BY revision DESC LIMIT 1
  `;
  if (consent?.action !== "GRANTED") {
    await sql`
      INSERT INTO privacy_consent_events (
        event_id, correlation_id, subject_user_id, purpose, action,
        policy_version_id, revision
      ) VALUES (
        ${randomUUID()}, ${randomUUID()}, ${target.actorUserId},
        'NON_ESSENTIAL_ANALYTICS', 'GRANTED', ${policy.policyVersionId},
        ${consent === undefined ? 1 : consent.revision + 1}
      )
    `;
  }
  const commandId = randomUUID();
  const repository = createR3AnalyticsObservationRepository(sql);
  const input = {
    actorUserId: target.actorUserId,
    commandId,
    jobRequestId: target.jobRequestId,
    kind: "QUOTE_COMPARISON_OPENED" as const,
  };
  const observationLocked = deferred<void>();
  const releaseObservation = deferred<void>();
  const observationFirst = sql.begin(async (tx) => {
    await tx`
      SELECT pg_advisory_xact_lock(
        hashtext(${target.actorUserId}), hashtext('NON_ESSENTIAL_ANALYTICS'))
    `;
    const result =
      await createR3AnalyticsObservationRepository(tx).record(input);
    observationLocked.resolve(undefined);
    await releaseObservation.promise;
    return result;
  });
  await observationLocked.promise;
  const withdrawalPid = deferred<number>();
  const withdrawalAfterObservation = sql.begin(async (tx) => {
    withdrawalPid.resolve(await backendPid(tx));
    await insertConsent(
      tx,
      target.actorUserId,
      policy.policyVersionId,
      "WITHDRAWN",
      (consent?.revision ?? 0) + (consent?.action === "GRANTED" ? 1 : 2),
    );
  });
  await waitUntilLockBlocked(sql, await withdrawalPid.promise);
  releaseObservation.resolve(undefined);
  await expect(observationFirst).resolves.toBe("RECORDED");
  await withdrawalAfterObservation;
  await expect(repository.record(input)).resolves.toBe("RECORDED");
  const [observation] = await sql<{ count: number }[]>`
    SELECT count(*)::integer AS count FROM domain_outbox_events
    WHERE correlation_id = ${commandId}
      AND event_name = 'r3.analytics.quote_comparison_opened'
  `;
  expect(observation?.count).toBe(1);

  const [capturedCount] = await sql<{ available: number; expected: number }[]>`
    SELECT (event.payload ->> 'available_quote_count')::integer AS available,
      (SELECT LEAST(count(*), 5)::integer
       FROM current_submitted_quotes current_quote
       JOIN quotes current_identity ON current_identity.id = current_quote.quote_id
       JOIN job_invitations current_invitation
         ON current_invitation.id = current_identity.invitation_id
       WHERE current_invitation.job_request_id = ${target.jobRequestId}
         AND quote_revision_authoring_is_eligible(
           current_quote.quote_id, current_quote.revision,
           current_quote.authoring_mode)
         AND (quote_revision_valid_until(
             current_quote.quote_id, current_quote.revision,
             current_quote.authoring_mode) IS NULL
           OR quote_revision_valid_until(
             current_quote.quote_id, current_quote.revision,
             current_quote.authoring_mode) > clock_timestamp())) AS expected
    FROM domain_outbox_events event
    WHERE event.correlation_id = ${commandId}
  `;
  expect(capturedCount?.available).toBe(capturedCount?.expected);

  const [withdrawn] = await sql<{ action: string; revision: number }[]>`
    SELECT action, revision FROM privacy_consent_events
    WHERE subject_user_id = ${target.actorUserId}
      AND purpose = 'NON_ESSENTIAL_ANALYTICS'
    ORDER BY revision DESC LIMIT 1
  `;
  expect(withdrawn?.action).toBe("WITHDRAWN");
  if (withdrawn === undefined) return;
  await insertConsent(
    sql,
    target.actorUserId,
    policy.policyVersionId,
    "GRANTED",
    withdrawn.revision + 1,
  );

  const withdrawnCommandId = randomUUID();
  const withdrawalLocked = deferred<void>();
  const releaseWithdrawal = deferred<void>();
  const withdrawalFirst = sql.begin(async (tx) => {
    await insertConsent(
      tx,
      target.actorUserId,
      policy.policyVersionId,
      "WITHDRAWN",
      withdrawn.revision + 2,
    );
    withdrawalLocked.resolve(undefined);
    await releaseWithdrawal.promise;
  });
  await withdrawalLocked.promise;
  const observationPid = deferred<number>();
  const observationAfterWithdrawal = sql.begin(async (tx) => {
    observationPid.resolve(await backendPid(tx));
    return createR3AnalyticsObservationRepository(tx).record({
      actorUserId: target.actorUserId,
      commandId: withdrawnCommandId,
      jobRequestId: target.jobRequestId,
      kind: "QUOTE_VIEWED",
      quoteId: target.quoteId,
      quoteRevision: target.quoteRevision,
    });
  });
  await waitUntilLockBlocked(sql, await observationPid.promise);
  releaseWithdrawal.resolve(undefined);
  await withdrawalFirst;
  await expect(observationAfterWithdrawal).resolves.toBe("NOT_AVAILABLE");
  const [withdrawnEffect] = await sql<{ count: number }[]>`
    SELECT count(*)::integer AS count FROM domain_outbox_events
    WHERE correlation_id = ${withdrawnCommandId}
  `;
  expect(withdrawnEffect?.count).toBe(0);

  const afterWithdrawalId = randomUUID();
  const afterWithdrawal = await repository.record({
    actorUserId: target.actorUserId,
    commandId: afterWithdrawalId,
    jobRequestId: target.jobRequestId,
    kind: "QUOTE_VIEWED",
    quoteId: target.quoteId,
    quoteRevision: target.quoteRevision,
  });
  expect(["UNCHANGED", "NOT_AVAILABLE"]).toContain(afterWithdrawal);
  const [afterWithdrawalEffect] = await sql<{ count: number }[]>`
    SELECT count(*)::integer AS count FROM domain_outbox_events
    WHERE correlation_id = ${afterWithdrawalId}
  `;
  expect(afterWithdrawalEffect?.count).toBe(0);

  await assertRevokedExternalPdfDenied(sql, repository);
}

async function assertInvitationViewAuthorization(sql: Sql): Promise<void> {
  const [target] = await sql<
    {
      customerOwnerId: string;
      invitationId: string;
      jobRequestId: string;
      providerOwnerId: string;
    }[]
  >`
    SELECT customer.owner_user_id AS "customerOwnerId",
      invitation.id AS "invitationId",
      invitation.job_request_id AS "jobRequestId",
      craftsman.owner_user_id AS "providerOwnerId"
    FROM job_invitations invitation
    JOIN craftsman_profiles craftsman
      ON craftsman.id = invitation.craftsman_profile_id
    JOIN customer_profiles customer
      ON customer.id = invitation.customer_profile_id
    JOIN users provider ON provider.id = craftsman.owner_user_id
      AND provider.account_state = 'ACTIVE'
    JOIN users customer_user ON customer_user.id = customer.owner_user_id
      AND customer_user.account_state = 'ACTIVE'
    ORDER BY invitation.created_at, invitation.id
    LIMIT 1
  `;
  expect(target).toBeDefined();
  if (target === undefined) {
    throw new Error("invitation analytics fixture is missing");
  }
  const [policy] = await sql<{ policyVersionId: string }[]>`
    SELECT policy_version_id AS "policyVersionId"
    FROM privacy_policy_versions
    WHERE policy_kind = 'OPTIONAL_CONSENT_TEXT'
      AND optional_consent_purpose = 'NON_ESSENTIAL_ANALYTICS'
      AND review_state = 'APPROVED'
      AND effective_at <= CURRENT_TIMESTAMP
    ORDER BY effective_at DESC, created_at DESC, policy_version_id DESC LIMIT 1
  `;
  expect(policy).toBeDefined();
  if (policy === undefined) {
    throw new Error("analytics consent policy fixture is missing");
  }
  await ensureConsentState(
    sql,
    target.providerOwnerId,
    policy.policyVersionId,
    "WITHDRAWN",
  );
  const repository = createR3AnalyticsObservationRepository(sql);
  const deniedId = randomUUID();
  const providerInput = {
    actorUserId: target.providerOwnerId,
    commandId: deniedId,
    invitationId: target.invitationId,
    jobRequestId: target.jobRequestId,
    kind: "INVITATION_VIEWED" as const,
  };
  await expect(repository.record(providerInput)).resolves.toBe("NOT_AVAILABLE");
  await ensureConsentState(
    sql,
    target.providerOwnerId,
    policy.policyVersionId,
    "GRANTED",
  );
  const recordedId = randomUUID();
  await expect(
    repository.record({ ...providerInput, commandId: recordedId }),
  ).resolves.toBe("RECORDED");
  await ensureConsentState(
    sql,
    target.customerOwnerId,
    policy.policyVersionId,
    "GRANTED",
  );
  const outsiderId = randomUUID();
  await expect(
    repository.record({
      ...providerInput,
      actorUserId: target.customerOwnerId,
      commandId: outsiderId,
    }),
  ).resolves.toBe("NOT_AVAILABLE");
  const rows = await sql<{ correlationId: string }[]>`
    SELECT correlation_id AS "correlationId" FROM domain_outbox_events
    WHERE correlation_id IN (${deniedId}, ${recordedId}, ${outsiderId})
      AND event_name = 'r3.analytics.invitation_viewed'
  `;
  expect(rows.map((row) => row.correlationId)).toEqual([recordedId]);
}

async function assertVersionedReplayAndTransientRetry(
  sql: Sql,
  subjectUserId: string,
): Promise<void> {
  const requestId = randomUUID();
  const quoteId = randomUUID();
  const v1Id = randomUUID();
  const v2Id = randomUUID();
  const now = new Date();
  await sql`
    SELECT insert_exact_r3_analytics_source_event(
      ${`r3-analytics:integration:v1:${v1Id}`},
      'r3.analytics.quote_submitted', ${now}, 'QUOTE', ${quoteId},
      r3_analytics_subject_payload(${subjectUserId}, 'CRAFTSMAN', 'USER',
        jsonb_build_object('job_request_id', ${requestId}::text,
          'quote_id', ${quoteId}::text)),
      'integration.analytics', ${v1Id}, ${v1Id})
  `;
  await sql`
    SELECT insert_exact_r3_analytics_source_event(
      ${`r3-analytics:integration:v2:${v2Id}`},
      'r3.analytics.quote_submitted_v2', ${new Date(now.getTime() + 1)},
      'QUOTE_REVISION', ${`${quoteId}:1`},
      r3_analytics_subject_payload(${subjectUserId}, 'CRAFTSMAN', 'USER',
        jsonb_build_object('authoring_mode', 'PLATFORM_STRUCTURED',
          'job_request_id', ${requestId}::text, 'price_mode', 'FIXED',
          'quote_id', ${quoteId}::text, 'quote_revision', 1)),
      'integration.analytics', ${v2Id}, ${v2Id})
  `;
  const transport = createMemoryAnalyticsTransport("staging");
  const processor = createR3AnalyticsProcessor({
    backoffMs: () => 1,
    leaseDurationMs: 30_000,
    publisher: createTrustedAnalyticsPublisher({
      appVersion: "r3-integration",
      environment: "staging",
      platform: "WEB",
      transport,
    }),
    store: createR3AnalyticsLeaseStore(sql),
  });
  await expect(processor.processNext()).resolves.toMatchObject({
    status: "DELIVERED",
  });
  await expect(processor.processNext()).resolves.toMatchObject({
    status: "DELIVERED",
  });
  expect(
    transport
      .events()
      .map((event) => [event.event_name, event.schema_version])
      .sort(),
  ).toEqual([
    ["quote_submitted", 1],
    ["quote_submitted", 2],
  ]);
  await sql`
    UPDATE domain_outbox_events
    SET status = 'PUBLISHED', published_at = GREATEST(clock_timestamp(), occurred_at),
      lease_token = NULL, lease_expires_at = NULL, last_error_code = NULL,
      updated_at = clock_timestamp()
    WHERE event_id = ${v1Id}
  `;
  const [analyticsFirst] = await sql<{ state: string }[]>`
    SELECT state FROM r3_analytics_event_deliveries
    WHERE source_event_id = ${v1Id}
  `;
  expect(analyticsFirst?.state).toBe("DELIVERED");

  const retryId = randomUUID();
  await sql`
    SELECT insert_exact_r3_analytics_source_event(
      ${`r3-analytics:integration:retry:${retryId}`},
      'r3.analytics.job_request_started', clock_timestamp(),
      'JOB_REQUEST', ${requestId},
      r3_analytics_subject_payload(${subjectUserId}, 'CUSTOMER', 'USER',
        jsonb_build_object('job_request_id', ${requestId}::text)),
      'integration.analytics', ${retryId}, ${retryId})
  `;
  const deliveredIds: string[] = [];
  let unavailable = true;
  const retryProcessor = createR3AnalyticsProcessor({
    backoffMs: () => 1,
    leaseDurationMs: 30_000,
    publisher: createTrustedAnalyticsPublisher({
      appVersion: "r3-integration",
      environment: "staging",
      platform: "WEB",
      transport: {
        deliver(event) {
          deliveredIds.push(event.event_id);
          if (unavailable) {
            unavailable = false;
            return Promise.reject(new Error("test transport unavailable"));
          }
          return Promise.resolve();
        },
        environment: "staging",
        kind: "TEST",
      },
    }),
    store: createR3AnalyticsLeaseStore(sql),
  });
  await expect(retryProcessor.processNext()).resolves.toMatchObject({
    eventId: retryId,
    status: "RETRY_SCHEDULED",
  });
  await sql`
    UPDATE r3_analytics_event_deliveries
    SET available_at = clock_timestamp()
    WHERE source_event_id = ${retryId} AND state = 'PENDING'
  `;
  await expect(retryProcessor.processNext()).resolves.toMatchObject({
    eventId: retryId,
    status: "DELIVERED",
  });
  expect(deliveredIds).toEqual([retryId, retryId]);
}

async function assertRevokedExternalPdfDenied(
  sql: Sql,
  repository: ReturnType<typeof createR3AnalyticsObservationRepository>,
): Promise<void> {
  const [revoked] = await sql<
    {
      actorUserId: string;
      eligible: boolean;
      jobRequestId: string;
      quoteId: string;
      quoteRevision: number;
    }[]
  >`
    SELECT customer.owner_user_id AS "actorUserId",
      quote_revision_authoring_is_eligible(
        content.quote_id, content.quote_revision,
        'EXTERNAL_PDF'::quote_authoring_mode) AS eligible,
      invitation.job_request_id AS "jobRequestId", quote.id AS "quoteId",
      content.quote_revision AS "quoteRevision"
    FROM current_quote_external_pdf_content content
    JOIN quote_external_pdf_documents document
      ON document.quote_id = content.quote_id
      AND document.quote_revision = content.quote_revision
      AND document.pdf_media_asset_id = content.pdf_media_asset_id
    JOIN media_assets asset ON asset.id = document.pdf_media_asset_id
    JOIN media_asset_storage_objects canonical
      ON canonical.media_asset_id = asset.id
      AND canonical.role = 'CANONICAL'
      AND canonical.revoked_at IS NOT NULL
    JOIN quotes quote ON quote.id = content.quote_id
    JOIN job_invitations invitation ON invitation.id = quote.invitation_id
    JOIN customer_profiles customer ON customer.id = invitation.customer_profile_id
    LIMIT 1
  `;
  expect(revoked).toBeDefined();
  if (revoked === undefined) {
    throw new Error("revoked external PDF fixture is missing");
  }
  expect(revoked.eligible).toBe(false);
  const [policy] = await sql<{ policyVersionId: string }[]>`
    SELECT policy_version_id AS "policyVersionId"
    FROM privacy_policy_versions
    WHERE policy_kind = 'OPTIONAL_CONSENT_TEXT'
      AND optional_consent_purpose = 'NON_ESSENTIAL_ANALYTICS'
      AND review_state = 'APPROVED'
      AND effective_at <= CURRENT_TIMESTAMP
    ORDER BY effective_at DESC, created_at DESC, policy_version_id DESC LIMIT 1
  `;
  expect(policy).toBeDefined();
  if (policy === undefined) {
    throw new Error("analytics consent policy fixture is missing");
  }
  await ensureConsentState(
    sql,
    revoked.actorUserId,
    policy.policyVersionId,
    "GRANTED",
  );
  const commandId = randomUUID();
  await expect(
    repository.record({
      actorUserId: revoked.actorUserId,
      commandId,
      jobRequestId: revoked.jobRequestId,
      kind: "QUOTE_COMPARISON_PDF_OPENED",
      quoteId: revoked.quoteId,
      quoteRevision: revoked.quoteRevision,
    }),
  ).resolves.toBe("NOT_AVAILABLE");
  const [effect] = await sql<{ count: number }[]>`
    SELECT count(*)::integer AS count FROM domain_outbox_events
    WHERE correlation_id = ${commandId}
  `;
  expect(effect?.count).toBe(0);
}

async function insertConsent(
  sql: Sql | TransactionSql,
  actorUserId: string,
  policyVersionId: string,
  action: "GRANTED" | "WITHDRAWN",
  revision: number,
): Promise<void> {
  await sql`
    INSERT INTO privacy_consent_events (
      event_id, correlation_id, subject_user_id, purpose, action,
      policy_version_id, revision
    ) VALUES (
      ${randomUUID()}, ${randomUUID()}, ${actorUserId},
      'NON_ESSENTIAL_ANALYTICS', ${action}, ${policyVersionId}, ${revision}
    )
  `;
}

async function ensureConsentState(
  sql: Sql,
  actorUserId: string,
  policyVersionId: string,
  action: "GRANTED" | "WITHDRAWN",
): Promise<void> {
  const [latest] = await sql<{ action: string; revision: number }[]>`
    SELECT action, revision FROM privacy_consent_events
    WHERE subject_user_id = ${actorUserId}
      AND purpose = 'NON_ESSENTIAL_ANALYTICS'
    ORDER BY revision DESC LIMIT 1
  `;
  if (latest?.action === action) return;
  if (latest === undefined && action === "WITHDRAWN") {
    await insertConsent(sql, actorUserId, policyVersionId, "GRANTED", 1);
    await insertConsent(sql, actorUserId, policyVersionId, "WITHDRAWN", 2);
    return;
  }
  await insertConsent(
    sql,
    actorUserId,
    policyVersionId,
    action,
    (latest?.revision ?? 0) + 1,
  );
}

async function backendPid(sql: TransactionSql): Promise<number> {
  const [row] = await sql<{ pid: number }[]>`
    SELECT pg_backend_pid()::integer AS pid
  `;
  if (row === undefined) throw new Error("analytics backend pid missing");
  return row.pid;
}

async function waitUntilLockBlocked(sql: Sql, pid: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [row] = await sql<{ waitEventType: string | null }[]>`
      SELECT wait_event_type AS "waitEventType"
      FROM pg_stat_activity WHERE pid = ${pid}
    `;
    if (row?.waitEventType === "Lock") return;
    await sql`SELECT pg_sleep(0.01)`;
  }
  throw new Error(`Analytics backend ${pid} did not reach lock barrier.`);
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
