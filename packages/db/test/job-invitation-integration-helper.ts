import { randomUUID } from "node:crypto";

import type {
  CraftsmanProfileId,
  CustomerProfileId,
  JobRequestId,
  UserId,
} from "@portal/domain";
import {
  createCredentialQualificationPolicyService,
  type CredentialQualificationPolicyEntrySeed,
} from "@portal/search";
import type { Sql } from "postgres";
import { expect } from "vitest";

import { createCredentialQualificationRepository } from "../src/credential-qualification-repository.js";
import { createJobInvitationRepository } from "../src/job-invitation-repository.js";

interface Target {
  readonly ownerUserId: UserId;
  readonly profileId: CraftsmanProfileId;
}

/** Standalone R3-007 assertions; root wires this before R3-006 cancels the fixture. */
export async function runJobInvitationIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const [request] = await sql<
    Array<{
      readonly actorUserId: UserId;
      readonly customerProfileId: CustomerProfileId;
      readonly id: JobRequestId;
      readonly primaryProfessionCode: string;
    }>
  >`
    SELECT owner.id AS "actorUserId", customer.id AS "customerProfileId",
      current.id, core.payload ->> 'primaryProfessionCode' AS "primaryProfessionCode"
    FROM current_job_requests current
    JOIN customer_profiles customer ON customer.id = current.customer_profile_id
    JOIN users owner ON owner.id = customer.owner_user_id
    JOIN current_job_request_active_sections core
      ON core.job_request_id = current.id AND core.section_key = 'request.core'
    WHERE current.state::text = 'ACTIVE' AND owner.account_state = 'ACTIVE'
    ORDER BY current.created_at DESC, current.id DESC LIMIT 1
  `;
  if (request === undefined)
    throw new Error("R3-007 requires an active request.");

  await makeRequestProfessionOptionalForFixture(
    sql,
    request.primaryProfessionCode,
  );

  const [target] = await sql<Target[]>`
    SELECT publication.craftsman_profile_id AS "profileId",
      profile.owner_user_id AS "ownerUserId"
    FROM current_craftsman_profile_publications publication
    JOIN craftsman_profiles profile
      ON profile.id = publication.craftsman_profile_id
    WHERE publication.effectively_public
      AND publication.owner_user_id <> ${request.actorUserId}
      AND NOT EXISTS (
        SELECT 1 FROM current_credential_qualification_policies policy
        WHERE policy.profession_code = ${request.primaryProfessionCode}
          AND policy.requirement = 'REQUIRED'
          AND NOT EXISTS (
            SELECT 1 FROM current_searchable_craftsman_credentials credential
            WHERE credential.craftsman_profile_id = publication.craftsman_profile_id
              AND credential.profession_code = policy.profession_code
              AND credential.credential_type_code = policy.credential_type_code
          )
      )
    ORDER BY publication.craftsman_profile_id LIMIT 1
  `;
  if (target === undefined) {
    throw new Error("R3-007 requires an eligible public craftsman fixture.");
  }
  await verifyFixtureUser(sql, request.actorUserId);
  await verifyFixtureUser(sql, target.ownerUserId);

  const repository = createJobInvitationRepository(sql);
  await sql`
    UPDATE job_invitation_runtime_policy SET active_invitation_limit = 1,
      updated_at = clock_timestamp() WHERE singleton
  `;
  try {
    const sendCommandId = randomUUID();
    const sent = await repository.sendOwned({
      actorUserId: request.actorUserId,
      commandId: sendCommandId,
      craftsmanProfileId: target.profileId,
      jobRequestId: request.id,
    });
    if (!("invitation" in sent)) throw new Error("Expected invitation.");
    const invitation = sent.invitation;
    expect(sent.status).toBe("APPLIED");
    expect(invitation).toMatchObject({
      craftsmanProfileId: target.profileId,
      revision: 1,
      state: "PENDING",
    });
    expect(invitation.requestContentRevision).toBeGreaterThan(0);
    expect(invitation.requestVisibleVersion).toBeGreaterThan(0);
    await expect(
      repository.sendOwned({
        actorUserId: request.actorUserId,
        commandId: sendCommandId,
        craftsmanProfileId: target.profileId,
        jobRequestId: request.id,
      }),
    ).resolves.toMatchObject({ status: "DEDUPLICATED" });
    await expect(
      repository.sendOwned({
        actorUserId: request.actorUserId,
        commandId: randomUUID(),
        craftsmanProfileId: target.profileId,
        jobRequestId: request.id,
      }),
    ).resolves.toEqual({ status: "ALREADY_INVITED" });

    await expect(sql`
      INSERT INTO job_invitations (
        id, job_request_id, customer_profile_id, craftsman_profile_id,
        request_content_revision, request_visible_version
      ) VALUES (
        ${randomUUID()}, ${request.id}, ${request.customerProfileId},
        ${target.profileId}, 1, 1
      )
    `).rejects.toThrow(/active invitation limit reached/u);

    await sql`
      UPDATE auth_credentials SET phone_verified_at = NULL,
        normalized_phone = NULL, updated_at = clock_timestamp()
      WHERE user_id = ${target.ownerUserId}
    `;
    await expect(
      repository.respondOwned({
        action: "ENGAGE",
        actorUserId: target.ownerUserId,
        commandId: randomUUID(),
        expectedRevision: 1,
        invitationId: invitation.id,
      }),
    ).resolves.toEqual({ status: "ACCOUNT_NOT_ELIGIBLE" });
    await verifyFixtureUser(sql, target.ownerUserId);

    await expect(
      sql.begin(async (transaction) => {
        const engageCommandId = randomUUID();
        await transaction`
          INSERT INTO job_invitation_commands (
            command_id, invitation_id, actor_user_id, command_kind,
            expected_revision, resulting_revision, target_state,
            system_initiated, payload_fingerprint
          ) VALUES (
            ${engageCommandId}, ${invitation.id}, ${target.ownerUserId},
            'ENGAGE', 1, 2, 'ENGAGED', false, ${"0".repeat(64)}
          )
        `;
        await transaction`
          INSERT INTO job_invitation_revisions (
            invitation_id, revision, command_id, state, changed_at, sent_at,
            expires_at, engaged_at
          ) VALUES (
            ${invitation.id}, 2, ${engageCommandId}, 'ENGAGED',
            clock_timestamp(), clock_timestamp(), clock_timestamp(), NULL
          )
        `;
        const [engaged] = await transaction<{ readonly state: string }[]>`
          SELECT state::text AS state FROM current_job_invitations
          WHERE id = ${invitation.id}
        `;
        expect(engaged?.state).toBe("ENGAGED");
        throw new Error("ROLLBACK_ENGAGEMENT_PROBE");
      }),
    ).rejects.toThrow("ROLLBACK_ENGAGEMENT_PROBE");

    await expect(sql`
      INSERT INTO job_invitation_commands (
        command_id, invitation_id, actor_user_id, command_kind,
        expected_revision, resulting_revision, target_state,
        system_initiated, payload_fingerprint
      ) VALUES (
        ${randomUUID()}, ${invitation.id}, ${request.actorUserId},
        'ENGAGE', 1, 2, 'ENGAGED', false, ${"0".repeat(64)}
      )
    `).rejects.toThrow(/invited craftsman actor required/u);
    await expect(sql`
      UPDATE job_invitation_revisions SET state = 'ENGAGED'
      WHERE invitation_id = ${invitation.id}
    `).rejects.toThrow(/append-only/u);
  } finally {
    await sql`
      UPDATE job_invitation_runtime_policy SET active_invitation_limit = 5,
        updated_at = clock_timestamp() WHERE singleton
    `;
  }
}

async function makeRequestProfessionOptionalForFixture(
  sql: Sql,
  professionCode: string,
): Promise<void> {
  const entries = await sql<CredentialQualificationPolicyEntrySeed[]>`
    SELECT profession_code AS "professionCode",
      credential_type_code AS "credentialTypeCode", requirement::text AS requirement
    FROM current_credential_qualification_policies
    ORDER BY profession_code, credential_type_code
  `;
  if (
    !entries.some(
      (entry) =>
        entry.professionCode === professionCode &&
        entry.requirement === "REQUIRED",
    )
  ) {
    return;
  }

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
    ORDER BY activation.activation_sequence DESC
    LIMIT 1
  `;
  if (current === undefined) {
    throw new Error("R3-007 requires a qualification policy fixture.");
  }

  const nextReleaseId = randomUUID();
  const policy = createCredentialQualificationPolicyService({
    persistence: createCredentialQualificationRepository(sql),
  });
  await policy.installRelease({
    entries: entries.map((entry) => ({
      ...entry,
      requirement:
        entry.professionCode === professionCode
          ? "OPTIONAL"
          : entry.requirement,
    })),
    releaseId: nextReleaseId,
    reviewReference: "test-review:R3-007-invitation-fixture",
    supersedesReleaseId: current.releaseId,
    taxonomyReleaseId: current.taxonomyReleaseId,
    version: current.version + 1,
  });
  await policy.activateRelease({
    activationId: randomUUID(),
    actorReference: "test-deployment:R3-007-invitation-fixture",
    previousReleaseId: current.releaseId,
    releaseId: nextReleaseId,
    reviewReference: "test-review:R3-007-invitation-fixture",
  });
}

async function verifyFixtureUser(sql: Sql, userId: UserId): Promise<void> {
  await sql`
    INSERT INTO auth_credentials (
      user_id, normalized_email, password_hash, email_verified_at,
      normalized_phone, phone_verified_at
    ) VALUES (
      ${userId}, ${`${userId}@example.test`},
      'test-fixture-password-hash', clock_timestamp(),
      '+4219' || lpad(
        (abs(hashtextextended(${userId}::text, 41007)) % 100000000)::text,
        8, '0'
      ), clock_timestamp()
    )
    ON CONFLICT (user_id) DO UPDATE SET
      email_verified_at = clock_timestamp(),
      normalized_phone = COALESCE(
        auth_credentials.normalized_phone, EXCLUDED.normalized_phone
      ),
      phone_verified_at = clock_timestamp(),
      updated_at = clock_timestamp()
  `;
}
