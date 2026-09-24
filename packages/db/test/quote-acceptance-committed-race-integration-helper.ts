import { createHash, randomUUID } from "node:crypto";

import type { Sql } from "postgres";
import { expect } from "vitest";

import { createAdminAccessService } from "@portal/admin-auth";
import type {
  CredentialClaimId,
  JobRequestId,
  QuoteAcceptanceCommandInput,
  UserId,
} from "@portal/domain";
import {
  createCredentialQualificationPolicyService,
  type CredentialQualificationPolicyEntrySeed,
} from "@portal/search";

import { createCredentialQualificationRepository } from "../src/credential-qualification-repository.js";
import { createAdminAccessRepository } from "../src/admin-auth-repository.js";
import {
  createCredentialClaimRepository,
  createCredentialReviewService,
} from "../src/credential-claim-repository.js";
import { createJobInvitationRepository } from "../src/job-invitation-repository.js";
import { createJobRequestLifecycleRepository } from "../src/job-request-lifecycle-repository.js";
import { createJobRequestRepository } from "../src/job-request-repository.js";
import { createQuoteAcceptanceRepository } from "../src/quote-acceptance-repository.js";
import { createJobContactRepository } from "../src/job-contact-repository.js";
import { createJobDashboardRepository } from "../src/job-dashboard-repository.js";
import { createJobLocationClarificationRepository } from "../src/job-location-clarification-repository.js";
import { createQuoteRepository } from "../src/quote-repository.js";
import { createStructuredQuoteRepository } from "../src/quote-structured-repository.js";

interface Source {
  readonly actorUserId: string;
  readonly jobRequestId: string;
  readonly winningInvitationId: string;
}

export async function runQuoteAcceptanceCommittedRaceIntegrationAssertions(
  sql: Sql,
  source: Source,
  mode: "ASSERT_RACES" | "CREATE_CONFIRMED_FIXTURE" = "ASSERT_RACES",
): Promise<void> {
  const [provider] = await sql<
    Array<{ readonly ownerUserId: string; readonly profileId: string }>
  >`
    SELECT craftsman.owner_user_id AS "ownerUserId",
      craftsman.id AS "profileId"
    FROM current_job_request_active_sections core
    JOIN current_craftsman_professions profession
      ON profession.profession_code = core.payload ->> 'primaryProfessionCode'
      AND profession.state = 'ACTIVE'
    JOIN craftsman_profiles craftsman
      ON craftsman.id = profession.craftsman_profile_id
    JOIN current_searchable_craftsman_profiles searchable
      ON searchable.craftsman_profile_id = craftsman.id
    JOIN auth_credentials credentials
      ON credentials.user_id = craftsman.owner_user_id
      AND credentials.email_verified_at IS NOT NULL
      AND credentials.phone_verified_at IS NOT NULL
    WHERE core.job_request_id = ${source.jobRequestId}
      AND core.section_key = 'request.core'
      AND craftsman.owner_user_id <> ${source.actorUserId}
      AND NOT EXISTS (
        SELECT 1 FROM credential_claims claim
        WHERE claim.craftsman_profile_id = craftsman.id
          AND claim.credential_type_code = 'test.r2006-other-approved'
          AND claim.state = 'APPROVED'
      )
    ORDER BY craftsman.id LIMIT 1
  `;
  if (provider === undefined) throw new Error("Race provider fixture missing.");

  const duplicate = await createJobRequestLifecycleRepository(
    sql,
  ).duplicateOwned({
    actorUserId: source.actorUserId as UserId,
    commandId: randomUUID(),
    sourceJobRequestId: source.jobRequestId as JobRequestId,
  });
  if (!("jobRequestId" in duplicate))
    throw new Error(`Race request duplicate failed: ${duplicate.status}`);
  const jobRequestId = duplicate.jobRequestId;
  const active = await createJobRequestRepository(sql).activateOwned({
    actorUserId: source.actorUserId as UserId,
    commandId: randomUUID(),
    expectedRevision: duplicate.revision,
    jobRequestId,
  });
  if (active.status !== "APPLIED")
    throw new Error(`Race request activation failed: ${active.status}`);

  const invitations = createJobInvitationRepository(sql);
  const sent = await invitations.sendOwned({
    actorUserId: source.actorUserId as UserId,
    commandId: randomUUID(),
    craftsmanProfileId: provider.profileId as never,
    jobRequestId,
  });
  if (!("invitation" in sent))
    throw new Error(`Race invitation send failed: ${sent.status}`);
  const invitation = sent.invitation;
  const engaged = await invitations.respondOwned({
    action: "ENGAGE",
    actorUserId: provider.ownerUserId as UserId,
    commandId: randomUUID(),
    expectedRevision: invitation.revision,
    invitationId: invitation.id,
  });
  if (!("invitation" in engaged))
    throw new Error(`Race invitation engagement failed: ${engaged.status}`);
  const [conversation] = await sql<Array<{ readonly id: string }>>`
    SELECT id FROM conversations WHERE invitation_id = ${invitation.id}
  `;
  if (conversation === undefined)
    throw new Error("Race conversation fixture missing.");

  const quotes = createQuoteRepository(sql);
  const created = await quotes.createDraft({
    actorUserId: provider.ownerUserId as UserId,
    authoringMode: "PLATFORM_STRUCTURED",
    commandId: randomUUID(),
    conversationId: conversation.id as never,
    requestContentRevision: invitation.requestContentRevision,
    requestVisibleVersion: invitation.requestVisibleVersion,
  });
  if (!("quote" in created) || created.quote.currentDraft === null)
    throw new Error(`Race Quote draft failed: ${created.status}`);
  const quoteId = created.quote.id;
  const quoteRevision = created.quote.currentDraft.revision;
  const saved = await createStructuredQuoteRepository(sql).saveDraft({
    actorUserId: provider.ownerUserId as UserId,
    commandId: randomUUID(),
    content: {
      components: {
        labor: { amountCents: 100_000, description: "Montáž" },
      },
      conditionalOnInspection: false,
      currency: "EUR",
      depositMode: "NONE",
      estimatedDurationDays: 2,
      estimatedStartOn: "2099-02-01",
      excludedScope: ["Odvoz odpadu"],
      includedScope: ["Montáž"],
      materialResponsibility: "PROVIDER",
      priceBasis: "Celý uvedený rozsah",
      priceMode: "FIXED",
      summary: "Súbežné potvrdenie ponuky",
      title: "Test súbežného prijatia",
      totalAmountCents: 100_000,
      validUntil: new Date("2099-12-31T00:00:00.000Z"),
      vatStatus: "VAT_INCLUDED",
    },
    expectedContentRevision: 0,
    quoteId,
    quoteRevision,
  });
  if (saved.status !== "SAVED")
    throw new Error(`Race Quote content save failed: ${saved.status}`);
  const submitted = await quotes.submit({
    actorUserId: provider.ownerUserId as UserId,
    commandId: randomUUID(),
    expectedDraftStateRevision: created.quote.currentDraft.stateRevision,
    expectedSubmittedStateRevision: null,
    quoteId,
    revision: quoteRevision,
  });
  if (!("quote" in submitted) || submitted.quote.currentSubmitted === null)
    throw new Error(`Race Quote submit failed: ${submitted.status}`);

  const input = {
    actorUserId: source.actorUserId as UserId,
    explicitlyConfirmed: true as const,
    expectedQuoteStateRevision: submitted.quote.currentSubmitted.stateRevision,
    expectedRequestContentRevision: invitation.requestContentRevision,
    expectedRequestVisibleVersion: invitation.requestVisibleVersion,
    jobRequestId,
    quoteId,
    quoteRevision,
  };
  if (mode === "CREATE_CONFIRMED_FIXTURE") {
    const result = await createQuoteAcceptanceRepository(sql).accept({
      ...input,
      commandId: randomUUID(),
    });
    if (result.status !== "APPLIED")
      throw new Error(`Confirmed Job fixture failed: ${result.status}`);
    return;
  }
  await assertProviderSuspensionWinsRace(sql, provider.ownerUserId, input);
  await assertCredentialRevocationWinsRace(
    sql,
    provider.ownerUserId,
    provider.profileId,
    input,
  );
  await assertQualificationPolicyActivationWinsRace(
    sql,
    provider.profileId,
    input,
  );
  let signalReady: () => void = () => undefined;
  let rejectReady: (error: unknown) => void = () => undefined;
  let releaseWinner: () => void = () => undefined;
  const ready = new Promise<void>((resolve, reject) => {
    signalReady = resolve;
    rejectReady = reject;
  });
  const release = new Promise<void>((resolve) => {
    releaseWinner = resolve;
  });
  const winningCommandId = randomUUID();
  const winner = sql.begin(async (tx) => {
    try {
      const result = await createQuoteAcceptanceRepository(tx).accept({
        ...input,
        commandId: winningCommandId,
      });
      expect(result.status).toBe("APPLIED");
      signalReady();
      await release;
      return result;
    } catch (error) {
      rejectReady(error);
      throw error;
    }
  });
  await ready;
  let signalSecondStarted: (pid: number) => void = () => undefined;
  const secondStarted = new Promise<number>((resolve) => {
    signalSecondStarted = resolve;
  });
  const loser = sql.begin(async (tx) => {
    const [connection] = await tx<Array<{ readonly pid: number }>>`
      SELECT pg_backend_pid() AS pid
    `;
    if (connection === undefined) throw new Error("Race connection missing.");
    signalSecondStarted(connection.pid);
    return createQuoteAcceptanceRepository(tx).accept({
      ...input,
      commandId: randomUUID(),
    });
  });
  try {
    const loserPid = await Promise.race([
      secondStarted,
      loser.then(() => {
        throw new Error("Competing acceptance ended before taking the lock.");
      }),
    ]);
    await waitForAdvisoryLock(sql, loserPid);
  } finally {
    releaseWinner();
  }
  const [winningResult, losingResult] = await Promise.all([winner, loser]);
  expect(winningResult.status).toBe("APPLIED");
  expect(losingResult).toEqual({ status: "NOT_ACCEPTABLE" });
  if (winningResult.status !== "APPLIED")
    throw new Error("Committed Job identity missing.");
  await expect(
    createQuoteAcceptanceRepository(sql).accept({
      ...input,
      commandId: winningCommandId,
    }),
  ).resolves.toMatchObject({
    jobId: winningResult.jobId,
    status: "DEDUPLICATED",
  });
  const [effects] = await sql<
    Array<{
      readonly acceptanceEvents: number;
      readonly jobs: number;
      readonly agreementSnapshots: number;
      readonly qualificationSnapshots: number;
      readonly requestState: string;
    }>
  >`
    SELECT (SELECT count(*)::integer FROM jobs
      WHERE job_request_id = ${jobRequestId}) AS jobs,
      (SELECT count(*)::integer FROM job_acceptance_events
      WHERE job_request_id = ${jobRequestId}) AS "acceptanceEvents",
      (SELECT count(*)::integer FROM job_agreement_snapshots
      WHERE job_id = ${winningResult.jobId}) AS "agreementSnapshots",
      (SELECT count(*)::integer FROM job_qualification_snapshots
      WHERE job_id = ${winningResult.jobId}) AS "qualificationSnapshots",
      (SELECT state::text FROM current_job_requests
      WHERE id = ${jobRequestId}) AS "requestState"
  `;
  expect(effects).toEqual({
    acceptanceEvents: 1,
    jobs: 1,
    agreementSnapshots: 1,
    qualificationSnapshots: 1,
    requestState: "CONVERTED",
  });
  const listed = await createJobRequestLifecycleRepository(sql).listOwned(
    source.actorUserId as UserId,
  );
  expect(listed.status).toBe("OK");
  if (listed.status !== "OK")
    throw new Error("Confirmed request list was unavailable.");
  expect(listed.requests.find((item) => item.id === jobRequestId)?.state).toBe(
    "CONVERTED",
  );
  const dashboard = createJobDashboardRepository(sql);
  const customerJobs = await dashboard.listForPrimaryParty({
    actorUserId: source.actorUserId,
  });
  expect(customerJobs.some((job) => job.id === winningResult.jobId)).toBe(true);
  const providerJobs = await dashboard.listForPrimaryParty({
    actorUserId: provider.ownerUserId,
  });
  expect(providerJobs.find((job) => job.id === winningResult.jobId)?.role).toBe(
    "PRIMARY_PROVIDER",
  );
  const customerDashboard = await dashboard.readForPrimaryParty({
    actorUserId: source.actorUserId,
    jobId: winningResult.jobId,
  });
  const providerDashboard = await dashboard.readForPrimaryParty({
    actorUserId: provider.ownerUserId,
    jobId: winningResult.jobId,
  });
  expect(customerDashboard).not.toBeNull();
  expect(providerDashboard?.request).toEqual(customerDashboard?.request);
  expect(customerDashboard?.quote).toMatchObject({
    authoringMode: "PLATFORM_STRUCTURED",
    commercialContent: {
      includedScope: ["Montáž"],
      priceMode: "FIXED",
      totalAmountCents: 100_000,
    },
    quoteId,
    revision: quoteRevision,
  });
  expect(customerDashboard?.timeline.map((event) => event.eventType)).toEqual([
    "JOB_CONFIRMED",
    "CONTACT_ADDRESS_UNLOCKED",
  ]);
  await expect(
    dashboard.readForPrimaryParty({
      actorUserId: randomUUID(),
      jobId: winningResult.jobId,
    }),
  ).resolves.toBeNull();
  await assertJobLocationClarificationRace(
    sql,
    winningResult.jobId,
    source.actorUserId,
  );
}

async function assertJobLocationClarificationRace(
  sql: Sql,
  jobId: string,
  actorUserId: string,
): Promise<void> {
  const contacts = await createJobContactRepository(sql).readForPrimaryParty({
    actorUserId,
    jobId,
  });
  if (contacts === null)
    throw new Error("Committed Job location fixture is missing.");
  const before = contacts.workLocation;
  const location =
    before.exactAddress === null
      ? { ...before, exactAddress: "Syntetická 17" }
      : before.textClarification === null
        ? { ...before, textClarification: "Vstup cez bočnú bránu" }
        : before.mapPin === null
          ? { ...before, mapPin: { latitude: 48.15, longitude: 17.12 } }
          : (() => {
              throw new Error("Committed Job has no missing location detail.");
            })();
  const [current] = await sql<Array<{ readonly revision: number }>>`
    SELECT revision FROM current_job_locations WHERE job_id = ${jobId}
  `;
  if (current === undefined)
    throw new Error("Committed Job location revision is missing.");
  const input = {
    actorUserId,
    commandId: randomUUID(),
    expectedRevision: current.revision,
    jobId,
    location,
    reason: "Doplnenie pracovného miesta po prijatí zákazky",
  };
  let signalReady: () => void = () => undefined;
  let releaseWinner: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    signalReady = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseWinner = resolve;
  });
  const winner = sql.begin(async (tx) => {
    const result =
      await createJobLocationClarificationRepository(tx).clarify(input);
    expect(result.status).toBe("APPLIED");
    signalReady();
    await release;
    return result;
  });
  await ready;
  let signalSecondStarted: (pid: number) => void = () => undefined;
  const secondStarted = new Promise<number>((resolve) => {
    signalSecondStarted = resolve;
  });
  const loser = sql.begin(async (tx) => {
    const [connection] = await tx<Array<{ readonly pid: number }>>`
      SELECT pg_backend_pid() AS pid
    `;
    if (connection === undefined)
      throw new Error("Job location race connection missing.");
    signalSecondStarted(connection.pid);
    return createJobLocationClarificationRepository(tx).clarify({
      ...input,
      commandId: randomUUID(),
    });
  });
  try {
    const loserPid = await Promise.race([
      secondStarted,
      loser.then(() => {
        throw new Error("Competing Job location command ended before lock.");
      }),
    ]);
    const deadline = Date.now() + 3_000;
    let blocked = false;
    while (Date.now() < deadline) {
      const [waiting] = await sql<Array<{ readonly blocked: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity
          WHERE pid = ${loserPid} AND wait_event_type = 'Lock'
        ) AS blocked
      `;
      if (waiting?.blocked === true) {
        blocked = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(blocked).toBe(true);
  } finally {
    releaseWinner();
  }
  const [applied, stale] = await Promise.all([winner, loser]);
  expect(applied.status).toBe("APPLIED");
  expect(stale).toEqual({ status: "STALE_REVISION" });
  expect(
    await createJobLocationClarificationRepository(sql).clarify(input),
  ).toEqual({ ...applied, status: "DEDUPLICATED" });
  const [history] = await sql<Array<{ readonly count: number }>>`
    SELECT count(*)::integer AS count FROM job_location_revisions
    WHERE job_id = ${jobId}
  `;
  expect(history?.count).toBe(current.revision + 1);
  expect(
    (
      await createJobContactRepository(sql).readForPrimaryParty({
        actorUserId,
        jobId,
      })
    )?.workLocation,
  ).toEqual(location);
}

async function waitForAdvisoryLock(sql: Sql, pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const [waiting] = await sql<Array<{ readonly blocked: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE pid = ${pid} AND wait_event_type = 'Lock'
          AND wait_event = 'advisory'
      ) AS blocked
    `;
    if (waiting?.blocked === true) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Competing acceptance did not wait for request lock.");
}

async function assertProviderSuspensionWinsRace(
  sql: Sql,
  providerOwnerId: string,
  input: Omit<QuoteAcceptanceCommandInput, "commandId">,
): Promise<void> {
  let signalSuspended: () => void = () => undefined;
  let rejectSuspended: (error: unknown) => void = () => undefined;
  let releaseSuspension: () => void = () => undefined;
  const suspendedReady = new Promise<void>((resolve, reject) => {
    signalSuspended = resolve;
    rejectSuspended = reject;
  });
  const release = new Promise<void>((resolve) => {
    releaseSuspension = resolve;
  });
  const suspension = sql.begin(async (tx) => {
    try {
      await tx`
        UPDATE users SET account_state = 'SUSPENDED',
          account_state_changed_at = clock_timestamp(),
          updated_at = clock_timestamp()
        WHERE id = ${providerOwnerId}
      `;
      signalSuspended();
      await release;
    } catch (error) {
      rejectSuspended(error);
      throw error;
    }
  });
  await suspendedReady;
  let signalAttemptStarted: (pid: number) => void = () => undefined;
  const attemptStarted = new Promise<number>((resolve) => {
    signalAttemptStarted = resolve;
  });
  const attempt = sql.begin(async (tx) => {
    const [connection] = await tx<Array<{ readonly pid: number }>>`
      SELECT pg_backend_pid() AS pid
    `;
    if (connection === undefined)
      throw new Error("Suspension-race connection missing.");
    signalAttemptStarted(connection.pid);
    return createQuoteAcceptanceRepository(tx).accept({
      ...input,
      commandId: randomUUID(),
    });
  });
  try {
    const attemptPid = await Promise.race([
      attemptStarted,
      attempt.then(() => {
        throw new Error("Acceptance ended before provider lock wait.");
      }),
    ]);
    await waitForLock(sql, attemptPid);
  } finally {
    releaseSuspension();
  }
  await suspension;
  try {
    expect(await attempt).toEqual({ status: "NOT_ACCEPTABLE" });
    const [jobs] = await sql<Array<{ readonly count: number }>>`
      SELECT count(*)::integer AS count FROM jobs
      WHERE job_request_id = ${input.jobRequestId}
    `;
    expect(jobs?.count).toBe(0);
  } finally {
    await sql`
      UPDATE users SET account_state = 'ACTIVE',
        account_state_changed_at = clock_timestamp(),
        updated_at = clock_timestamp()
      WHERE id = ${providerOwnerId}
    `;
  }
}

async function waitForLock(sql: Sql, pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const [waiting] = await sql<Array<{ readonly blocked: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE pid = ${pid} AND wait_event_type = 'Lock'
      ) AS blocked
    `;
    if (waiting?.blocked === true) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Acceptance did not wait for provider account lock.");
}

async function assertQualificationPolicyActivationWinsRace(
  sql: Sql,
  providerProfileId: string,
  input: Omit<QuoteAcceptanceCommandInput, "commandId">,
): Promise<void> {
  const [request] = await sql<Array<{ readonly professionCode: string }>>`
    SELECT payload ->> 'primaryProfessionCode' AS "professionCode"
    FROM current_job_request_active_sections
    WHERE job_request_id = ${input.jobRequestId}
      AND section_key = 'request.core'
  `;
  if (request === undefined)
    throw new Error("Qualification race request profession missing.");
  const entries = await sql<CredentialQualificationPolicyEntrySeed[]>`
    SELECT profession_code AS "professionCode",
      credential_type_code AS "credentialTypeCode",
      requirement::text AS requirement
    FROM current_credential_qualification_policies
    ORDER BY profession_code, credential_type_code
  `;
  const targeted = entries.find(
    (entry) => entry.professionCode === request.professionCode,
  );
  if (targeted === undefined || targeted.requirement !== "OPTIONAL")
    throw new Error("Optional qualification policy fixture missing.");
  const [approved] = await sql<Array<{ readonly count: number }>>`
    SELECT count(*)::integer AS count FROM credential_claims claim
    WHERE claim.craftsman_profile_id = ${providerProfileId}
      AND claim.credential_type_code = ${targeted.credentialTypeCode}
      AND claim.state = 'APPROVED'
  `;
  expect(approved?.count).toBe(0);
  const [current] = await sql<
    Array<{
      readonly releaseId: string;
      readonly taxonomyReleaseId: string;
      readonly version: number;
    }>
  >`
    SELECT release.release_id AS "releaseId",
      release.taxonomy_release_id AS "taxonomyReleaseId", release.version
    FROM credential_qualification_policy_activation_events activation
    JOIN credential_qualification_policy_releases release
      ON release.release_id = activation.release_id
    ORDER BY activation.activation_sequence DESC LIMIT 1
  `;
  if (current === undefined)
    throw new Error("Qualification race active policy missing.");
  const requiredReleaseId = randomUUID();
  const service = createCredentialQualificationPolicyService({
    persistence: createCredentialQualificationRepository(sql),
  });
  await service.installRelease({
    entries: entries.map((entry) => ({
      ...entry,
      requirement:
        entry.professionCode === request.professionCode &&
        entry.credentialTypeCode === targeted.credentialTypeCode
          ? "REQUIRED"
          : entry.requirement,
    })),
    releaseId: requiredReleaseId,
    reviewReference: "test-review:R4-002-qualification-race",
    supersedesReleaseId: current.releaseId,
    taxonomyReleaseId: current.taxonomyReleaseId,
    version: current.version + 1,
  });
  let signalActivation: () => void = () => undefined;
  let rejectActivation: (error: unknown) => void = () => undefined;
  let releaseActivation: () => void = () => undefined;
  const activationReady = new Promise<void>((resolve, reject) => {
    signalActivation = resolve;
    rejectActivation = reject;
  });
  const release = new Promise<void>((resolve) => {
    releaseActivation = resolve;
  });
  const activation = sql.begin(async (tx) => {
    try {
      await tx`
        INSERT INTO credential_qualification_policy_activation_events (
          activation_id, release_id, previous_release_id,
          actor_reference, review_reference
        ) VALUES (
          ${randomUUID()}, ${requiredReleaseId}, ${current.releaseId},
          'test-deployment:R4-002-qualification-race',
          'test-review:R4-002-qualification-race'
        )
      `;
      signalActivation();
      await release;
    } catch (error) {
      rejectActivation(error);
      throw error;
    }
  });
  await activationReady;
  let signalAttemptStarted: (pid: number) => void = () => undefined;
  const attemptStarted = new Promise<number>((resolve) => {
    signalAttemptStarted = resolve;
  });
  const attempt = sql.begin(async (tx) => {
    const [connection] = await tx<Array<{ readonly pid: number }>>`
      SELECT pg_backend_pid() AS pid
    `;
    if (connection === undefined)
      throw new Error("Qualification-race connection missing.");
    signalAttemptStarted(connection.pid);
    return createQuoteAcceptanceRepository(tx).accept({
      ...input,
      commandId: randomUUID(),
    });
  });
  try {
    const attemptPid = await Promise.race([
      attemptStarted,
      attempt.then(() => {
        throw new Error("Acceptance ended before policy lock wait.");
      }),
    ]);
    await waitForLock(sql, attemptPid);
  } finally {
    releaseActivation();
  }
  await activation;
  try {
    expect(await attempt).toEqual({ status: "NOT_ACCEPTABLE" });
    const [jobs] = await sql<Array<{ readonly count: number }>>`
      SELECT count(*)::integer AS count FROM jobs
      WHERE job_request_id = ${input.jobRequestId}
    `;
    expect(jobs?.count).toBe(0);
  } finally {
    const restoredReleaseId = randomUUID();
    await service.installRelease({
      entries,
      releaseId: restoredReleaseId,
      reviewReference: "test-review:R4-002-qualification-restore",
      supersedesReleaseId: requiredReleaseId,
      taxonomyReleaseId: current.taxonomyReleaseId,
      version: current.version + 2,
    });
    await service.activateRelease({
      activationId: randomUUID(),
      actorReference: "test-deployment:R4-002-qualification-restore",
      previousReleaseId: requiredReleaseId,
      releaseId: restoredReleaseId,
      reviewReference: "test-review:R4-002-qualification-restore",
    });
  }
}

async function assertCredentialRevocationWinsRace(
  sql: Sql,
  providerOwnerId: string,
  providerProfileId: string,
  input: Omit<QuoteAcceptanceCommandInput, "commandId">,
): Promise<void> {
  const [profession] = await sql<
    Array<{ readonly code: string; readonly id: string }>
  >`
    SELECT profession.id, profession.profession_code AS code
    FROM current_craftsman_professions profession
    JOIN current_job_request_active_sections core
      ON core.job_request_id = ${input.jobRequestId}
      AND core.section_key = 'request.core'
      AND core.payload ->> 'primaryProfessionCode' = profession.profession_code
    WHERE profession.craftsman_profile_id = ${providerProfileId}
  `;
  if (profession === undefined)
    throw new Error("Credential-race provider profession missing.");
  const credentialTypeCode = "test.r2006-other-approved";
  const claimId = randomUUID() as CredentialClaimId;
  const claims = createCredentialClaimRepository(sql);
  const created = await claims.create({
    actorUserId: providerOwnerId as UserId,
    claimId,
    commandId: randomUUID(),
    craftsmanProfessionId: profession.id as never,
    craftsmanProfileId: providerProfileId as never,
    credentialTypeCode,
    expiresOn: null,
  });
  if (created.status !== "APPLIED")
    throw new Error(`Credential-race claim creation failed: ${created.status}`);

  const [admin] = await sql<Array<{ readonly id: UserId }>>`
    INSERT INTO users DEFAULT VALUES RETURNING id
  `;
  if (admin === undefined) throw new Error("Credential-race admin missing.");
  const privilegedSessionId = `r4-002-credential-${randomUUID()}`;
  const sessionHash = createHash("sha256")
    .update(privilegedSessionId)
    .digest("hex");
  await sql`
    INSERT INTO auth_sessions (session_id_hash, user_id, expires_at)
    VALUES (${sessionHash}, ${admin.id}, clock_timestamp() + interval '1 hour')
  `;
  await sql`
    INSERT INTO admin_role_grants (user_id, role, grant_source, reason)
    VALUES (${admin.id}, 'ADMIN', 'BOOTSTRAP', 'R4-002 synthetic credential race')
  `;
  const [factor] = await sql<Array<{ readonly id: string }>>`
    INSERT INTO admin_mfa_factors (user_id, kind, credential_reference)
    VALUES (${admin.id}, 'TOTP', ${`test:r4-002/${randomUUID()}`})
    RETURNING id
  `;
  if (factor === undefined)
    throw new Error("Credential-race admin MFA factor missing.");
  await sql`
    INSERT INTO admin_privileged_sessions (
      session_id_hash, user_id, mfa_factor_id, mfa_authenticated_at,
      created_at, expires_at
    ) VALUES (
      ${sessionHash}, ${admin.id}, ${factor.id}, clock_timestamp(),
      clock_timestamp(), clock_timestamp() + interval '1 hour'
    )
  `;
  const review = createCredentialReviewService({
    adminAccess: createAdminAccessService({
      challengeTtlMs: 60_000,
      mfaProvider: {
        begin: () => Promise.reject(new Error("Test MFA challenge unused.")),
        verify: () => Promise.resolve(false),
      },
      privilegedSessionTtlMs: 3_600_000,
      reauthenticationMaxAgeMs: 900_000,
      repository: createAdminAccessRepository(sql),
    }),
    repository: claims,
  });
  const approved = await review.review({
    actorUserId: admin.id,
    command: {
      claimId,
      commandId: randomUUID(),
      decision: "APPROVE",
      expectedRevision: 1,
    },
    privilegedSessionId,
  });
  if (approved.status !== "APPLIED")
    throw new Error(`Credential-race approval failed: ${approved.status}`);

  const entries = await sql<CredentialQualificationPolicyEntrySeed[]>`
    SELECT profession_code AS "professionCode",
      credential_type_code AS "credentialTypeCode",
      requirement::text AS requirement
    FROM current_credential_qualification_policies
    ORDER BY profession_code, credential_type_code
  `;
  if (
    entries.some(
      (entry) =>
        entry.professionCode === profession.code &&
        entry.credentialTypeCode === credentialTypeCode,
    )
  )
    throw new Error("Credential-race policy fixture already exists.");
  const [current] = await sql<
    Array<{
      readonly releaseId: string;
      readonly taxonomyReleaseId: string;
      readonly version: number;
    }>
  >`
    SELECT release.release_id AS "releaseId",
      release.taxonomy_release_id AS "taxonomyReleaseId", release.version
    FROM credential_qualification_policy_activation_events activation
    JOIN credential_qualification_policy_releases release
      ON release.release_id = activation.release_id
    ORDER BY activation.activation_sequence DESC LIMIT 1
  `;
  if (current === undefined)
    throw new Error("Credential-race active policy missing.");
  const requiredReleaseId = randomUUID();
  const service = createCredentialQualificationPolicyService({
    persistence: createCredentialQualificationRepository(sql),
  });
  await service.installRelease({
    entries: [
      ...entries,
      {
        credentialTypeCode,
        professionCode: profession.code,
        requirement: "REQUIRED",
      },
    ],
    releaseId: requiredReleaseId,
    reviewReference: "test-review:R4-002-revocation-race",
    supersedesReleaseId: current.releaseId,
    taxonomyReleaseId: current.taxonomyReleaseId,
    version: current.version + 1,
  });
  await service.activateRelease({
    activationId: randomUUID(),
    actorReference: "test-deployment:R4-002-revocation-race",
    previousReleaseId: current.releaseId,
    releaseId: requiredReleaseId,
    reviewReference: "test-review:R4-002-revocation-race",
  });

  let signalHeld: () => void = () => undefined;
  let rejectHeld: (error: unknown) => void = () => undefined;
  let releaseClaim: () => void = () => undefined;
  const heldReady = new Promise<void>((resolve, reject) => {
    signalHeld = resolve;
    rejectHeld = reject;
  });
  const release = new Promise<void>((resolve) => {
    releaseClaim = resolve;
  });
  const holder = sql.begin(async (tx) => {
    try {
      await tx`SELECT id FROM credential_claims WHERE id = ${claimId} FOR UPDATE`;
      signalHeld();
      await release;
    } catch (error) {
      rejectHeld(error);
      throw error;
    }
  });
  await heldReady;
  const revocation = review.review({
    actorUserId: admin.id,
    command: {
      claimId,
      commandId: randomUUID(),
      decision: "REVOKE",
      expectedRevision: 2,
      reason: "Syntetické odvolanie počas prijímania ponuky.",
      reasonCategory: "EXPIRED_OR_INVALID",
    },
    privilegedSessionId,
  });
  try {
    await Promise.race([
      waitForReviewLock(sql),
      revocation.then(() => {
        throw new Error("Revocation ended before claim lock wait.");
      }),
    ]);
    let signalAttemptStarted: (pid: number) => void = () => undefined;
    const attemptStarted = new Promise<number>((resolve) => {
      signalAttemptStarted = resolve;
    });
    const attempt = sql.begin(async (tx) => {
      const [connection] = await tx<Array<{ readonly pid: number }>>`
        SELECT pg_backend_pid() AS pid
      `;
      if (connection === undefined)
        throw new Error("Revocation-race acceptance connection missing.");
      signalAttemptStarted(connection.pid);
      return createQuoteAcceptanceRepository(tx).accept({
        ...input,
        commandId: randomUUID(),
      });
    });
    const attemptPid = await Promise.race([
      attemptStarted,
      attempt.then(() => {
        throw new Error("Acceptance ended before claim lock wait.");
      }),
    ]);
    await waitForClaimLock(sql, attemptPid);
    releaseClaim();
    await holder;
    expect(await revocation).toMatchObject({
      claim: { state: "REVOKED" },
      status: "APPLIED",
    });
    expect(await attempt).toEqual({ status: "NOT_ACCEPTABLE" });
    const [jobs] = await sql<Array<{ readonly count: number }>>`
      SELECT count(*)::integer AS count FROM jobs
      WHERE job_request_id = ${input.jobRequestId}
    `;
    expect(jobs?.count).toBe(0);
  } finally {
    releaseClaim();
    const restoredReleaseId = randomUUID();
    await service.installRelease({
      entries,
      releaseId: restoredReleaseId,
      reviewReference: "test-review:R4-002-revocation-restore",
      supersedesReleaseId: requiredReleaseId,
      taxonomyReleaseId: current.taxonomyReleaseId,
      version: current.version + 2,
    });
    await service.activateRelease({
      activationId: randomUUID(),
      actorReference: "test-deployment:R4-002-revocation-restore",
      previousReleaseId: requiredReleaseId,
      releaseId: restoredReleaseId,
      reviewReference: "test-review:R4-002-revocation-restore",
    });
  }
}

async function waitForReviewLock(sql: Sql): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const [waiting] = await sql<Array<{ readonly blocked: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock'
          AND query LIKE '%credential_claims%'
      ) AS blocked
    `;
    if (waiting?.blocked === true) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Credential revocation did not wait for the claim row.");
}

async function waitForClaimLock(sql: Sql, pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const [waiting] = await sql<Array<{ readonly blocked: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE pid = ${pid} AND wait_event_type = 'Lock'
          AND query LIKE '%credential_claims%'
      ) AS blocked
    `;
    if (waiting?.blocked === true) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Acceptance did not wait for credential claim row.");
}
