import { randomUUID } from "node:crypto";

import type { Sql } from "postgres";
import { expect } from "vitest";

import {
  createJobParticipantCapabilityRepository,
  JobParticipantCapabilityIdempotencyError,
} from "../src/job-participant-capability-repository.js";
import { createJobParticipationRepository } from "../src/job-participation-repository.js";

interface Fixture {
  readonly jobId: string;
  readonly providerUserId: string;
  readonly customerUserId: string;
  readonly targetProfileId: string;
  readonly targetUserId: string;
}

export async function runJobParticipantCapabilityIntegrationAssertions(
  sql: Sql,
) {
  const [fixture] = await sql<Fixture[]>`
    SELECT job.id AS "jobId", provider.owner_user_id AS "providerUserId",
      customer.owner_user_id AS "customerUserId",
      target.id AS "targetProfileId", target.owner_user_id AS "targetUserId"
    FROM jobs job
    JOIN current_job_states state ON state.job_id = job.id
    JOIN customer_profiles customer ON customer.id = job.customer_profile_id
    JOIN craftsman_profiles provider ON provider.id = job.primary_craftsman_profile_id
    JOIN craftsman_profiles target ON target.profile_type = 'INDIVIDUAL'
      AND target.owner_user_id <> provider.owner_user_id
    JOIN current_searchable_craftsman_profiles searchable
      ON searchable.craftsman_profile_id = target.id
    JOIN users target_owner ON target_owner.id = target.owner_user_id
    JOIN auth_credentials target_credential ON target_credential.user_id = target_owner.id
    WHERE state.state = 'CONFIRMED'
      AND target_owner.account_state = 'ACTIVE'
      AND target_credential.email_verified_at IS NOT NULL
      AND target_credential.phone_verified_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM current_job_participants participant
        WHERE participant.job_id = job.id
          AND participant.craftsman_profile_id = target.id
          AND participant.state IN ('INVITED', 'ACCEPTED')
      )
    ORDER BY job.accepted_at DESC, target.id LIMIT 1
  `;
  if (!fixture)
    throw new Error("Two-party active Job capability fixture missing.");
  const participation = createJobParticipationRepository(sql);
  const capability = createJobParticipantCapabilityRepository(sql);
  const invite = await participation.invite({
    actorUserId: fixture.providerUserId,
    commandId: randomUUID(),
    jobId: fixture.jobId,
    craftsmanProfileId: fixture.targetProfileId,
  });
  expect(invite.status).toBe("APPLIED");
  if (!("participantId" in invite))
    throw new Error("Capability invite identity missing.");
  const participantId = invite.participantId;
  expect(
    await capability.propose({
      actorUserId: fixture.providerUserId,
      commandId: randomUUID(),
      participantId,
      kind: "CUSTOM_SKILL",
      customSkillText: "Ručné omietanie",
    }),
  ).toEqual({ status: "STALE_STATE" });
  await expect(sql`
    INSERT INTO job_participant_capability_claims (
      id, participant_id, kind, custom_skill_text, proposed_by_user_id
    ) VALUES (${randomUUID()}, ${participantId}, 'CUSTOM_SKILL',
      'Ručné omietanie', ${fixture.providerUserId})
  `).rejects.toThrow();
  expect(
    (
      await sql<Array<{ total: number }>>`
    SELECT count(*)::integer AS total FROM confirmed_job_participant_capability_evidence
    WHERE participant_id = ${participantId}
  `
    )[0]?.total,
  ).toBe(0);
  expect(
    await participation.decide({
      actorUserId: fixture.targetUserId,
      commandId: randomUUID(),
      participantId,
      decision: "ACCEPT",
    }),
  ).toMatchObject({ status: "APPLIED", state: "ACCEPTED" });

  const [profession] = await sql<Array<{ code: string }>>`
    SELECT profession_code AS code FROM current_profession_taxonomy
    WHERE state = 'ACTIVE' ORDER BY profession_code LIMIT 1
  `;
  if (!profession)
    throw new Error("Active profession taxonomy fixture missing.");
  const professionCommandId = randomUUID();
  const professionInput = {
    actorUserId: fixture.providerUserId,
    commandId: professionCommandId,
    participantId,
    kind: "PROFESSION" as const,
    professionCode: profession.code,
  };
  expect(await capability.propose(professionInput)).toMatchObject({
    status: "APPLIED",
    claimId: professionCommandId,
    claimStatus: "PROPOSED",
  });
  expect(await capability.propose(professionInput)).toMatchObject({
    status: "DEDUPLICATED",
    claimId: professionCommandId,
  });
  await expect(
    capability.propose({ ...professionInput, professionCode: "TEST:OTHER" }),
  ).rejects.toThrow(JobParticipantCapabilityIdempotencyError);
  expect(
    await capability.propose({ ...professionInput, commandId: randomUUID() }),
  ).toEqual({ status: "STALE_STATE" });
  expect(
    await capability.confirm({
      actorUserId: fixture.providerUserId,
      commandId: randomUUID(),
      participantId,
      claimId: professionCommandId,
    }),
  ).toEqual({ status: "NOT_FOUND" });
  expect(
    (
      await sql<Array<{ total: number }>>`
    SELECT count(*)::integer AS total FROM confirmed_job_participant_capability_evidence
    WHERE participant_id = ${participantId}
  `
    )[0]?.total,
  ).toBe(0);
  await expect(sql`
    INSERT INTO job_participant_capability_confirmations (
      event_id, claim_id, confirmed_by_user_id
    ) VALUES (${randomUUID()}, ${professionCommandId}, ${fixture.customerUserId})
  `).rejects.toThrow();
  const confirmCommandId = randomUUID();
  const confirmationInput = {
    actorUserId: fixture.targetUserId,
    commandId: confirmCommandId,
    participantId,
    claimId: professionCommandId,
  };
  expect(await capability.confirm(confirmationInput)).toMatchObject({
    status: "APPLIED",
    claimStatus: "CONFIRMED",
    claimId: professionCommandId,
  });
  expect(await capability.confirm(confirmationInput)).toMatchObject({
    status: "DEDUPLICATED",
    claimId: professionCommandId,
  });
  expect(
    await capability.confirm({ ...confirmationInput, commandId: randomUUID() }),
  ).toEqual({ status: "STALE_STATE" });
  expect(
    await capability.list({
      actorUserId: fixture.customerUserId,
      participantId,
      limit: 20,
    }),
  ).toBeNull();
  const listed = await capability.list({
    actorUserId: fixture.targetUserId,
    participantId,
    limit: 20,
  });
  expect(listed).toMatchObject({
    canAct: true,
    items: [
      {
        claimId: professionCommandId,
        kind: "PROFESSION",
        professionCode: profession.code,
        status: "CONFIRMED",
        proposedByUserId: fixture.providerUserId,
        confirmedByUserId: fixture.targetUserId,
      },
    ],
  });
  expect(listed?.items[0]?.professionTaxonomyReleaseId).toMatch(
    /^[0-9a-f-]{36}$/i,
  );

  const [skill] = await sql<Array<{ code: string }>>`
    SELECT skill_code AS code FROM current_skill_catalog
    WHERE state = 'ACTIVE' ORDER BY skill_code LIMIT 1
  `;
  if (!skill) throw new Error("Active skill catalog fixture missing.");
  const skillClaimId = randomUUID();
  expect(
    await capability.propose({
      actorUserId: fixture.targetUserId,
      commandId: skillClaimId,
      participantId,
      kind: "CANONICAL_SKILL",
      skillCode: skill.code,
    }),
  ).toMatchObject({
    status: "APPLIED",
    claimId: skillClaimId,
  });
  expect(
    await capability.confirm({
      actorUserId: fixture.providerUserId,
      commandId: randomUUID(),
      participantId,
      claimId: skillClaimId,
    }),
  ).toMatchObject({ status: "APPLIED", claimId: skillClaimId });
  const customClaimId = randomUUID();
  expect(
    await capability.propose({
      actorUserId: fixture.targetUserId,
      commandId: customClaimId,
      participantId,
      kind: "CUSTOM_SKILL",
      customSkillText: "Ručné omietanie",
    }),
  ).toMatchObject({
    status: "APPLIED",
    claimId: customClaimId,
  });
  expect(
    await capability.confirm({
      actorUserId: fixture.providerUserId,
      commandId: randomUUID(),
      participantId,
      claimId: customClaimId,
    }),
  ).toMatchObject({ status: "APPLIED", claimId: customClaimId });
  expect(
    (
      await sql<Array<{ total: number }>>`
    SELECT count(*)::integer AS total FROM confirmed_job_participant_capability_evidence
    WHERE participant_id = ${participantId}
  `
    )[0]?.total,
  ).toBe(3);

  const [leadProfile] = await sql<Array<{ profileId: string; userId: string }>>`
    SELECT profile.id AS "profileId", profile.owner_user_id AS "userId"
    FROM craftsman_profiles profile
    JOIN users owner ON owner.id = profile.owner_user_id
    JOIN auth_credentials credential ON credential.user_id = owner.id
    WHERE profile.profile_type = 'INDIVIDUAL'
      AND profile.owner_user_id NOT IN (
        ${fixture.providerUserId}, ${fixture.targetUserId})
      AND owner.account_state = 'ACTIVE'
      AND credential.email_verified_at IS NOT NULL
      AND credential.phone_verified_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM current_job_participants existing
        WHERE existing.job_id = ${fixture.jobId}
          AND existing.craftsman_profile_id = profile.id
          AND existing.state IN ('INVITED', 'ACCEPTED')
      )
    ORDER BY profile.id LIMIT 1
  `;
  if (!leadProfile) throw new Error("Distinct lead fixture missing.");
  const leadInvite = await participation.invite({
    actorUserId: fixture.providerUserId,
    commandId: randomUUID(),
    jobId: fixture.jobId,
    craftsmanProfileId: leadProfile.profileId,
  });
  expect(leadInvite.status).toBe("APPLIED");
  if (!("participantId" in leadInvite))
    throw new Error("Lead invitation identity missing.");
  const leadParticipantId = leadInvite.participantId;
  expect(
    await participation.decide({
      actorUserId: leadProfile.userId,
      commandId: randomUUID(),
      participantId: leadParticipantId,
      decision: "ACCEPT",
    }),
  ).toMatchObject({ status: "APPLIED" });
  const leadClaimId = randomUUID();
  expect(
    await capability.propose({
      actorUserId: fixture.targetUserId,
      commandId: leadClaimId,
      participantId,
      kind: "CUSTOM_SKILL",
      customSkillText: "Presné meranie",
    }),
  ).toMatchObject({ status: "APPLIED" });
  expect(
    await capability.confirm({
      actorUserId: leadProfile.userId,
      commandId: randomUUID(),
      participantId,
      claimId: leadClaimId,
    }),
  ).toEqual({ status: "NOT_FOUND" });
  const assignLead = await participation.changeRole({
    actorUserId: fixture.providerUserId,
    commandId: randomUUID(),
    participantId: leadParticipantId,
    role: "LEAD",
    action: "ASSIGN",
  });
  expect(assignLead.status).toBe("APPLIED");
  const leadView = await capability.list({
    actorUserId: leadProfile.userId,
    participantId,
    limit: 20,
  });
  expect(leadView).toMatchObject({ canAct: true, canPropose: false });
  expect(
    leadView?.items.find((item) => item.claimId === leadClaimId)?.canConfirm,
  ).toBe(true);
  expect(
    await capability.propose({
      actorUserId: leadProfile.userId,
      commandId: randomUUID(),
      participantId,
      kind: "CUSTOM_SKILL",
      customSkillText: "Vlastná práca",
    }),
  ).toEqual({ status: "NOT_FOUND" });
  expect(
    await capability.confirm({
      actorUserId: leadProfile.userId,
      commandId: randomUUID(),
      participantId,
      claimId: leadClaimId,
    }),
  ).toMatchObject({ status: "APPLIED" });
  expect(
    await participation.changeRole({
      actorUserId: fixture.providerUserId,
      commandId: randomUUID(),
      participantId: leadParticipantId,
      role: "LEAD",
      action: "REVOKE",
    }),
  ).toMatchObject({ status: "APPLIED" });
  const revokedClaimId = randomUUID();
  expect(
    await capability.propose({
      actorUserId: fixture.targetUserId,
      commandId: revokedClaimId,
      participantId,
      kind: "CUSTOM_SKILL",
      customSkillText: "Suchá výstavba",
    }),
  ).toMatchObject({ status: "APPLIED" });
  expect(
    await capability.confirm({
      actorUserId: leadProfile.userId,
      commandId: randomUUID(),
      participantId,
      claimId: revokedClaimId,
    }),
  ).toEqual({ status: "NOT_FOUND" });
  await expect(sql`
    INSERT INTO job_participant_capability_confirmations (
      event_id, claim_id, confirmed_by_user_id
    ) VALUES (${randomUUID()}, ${revokedClaimId}, ${leadProfile.userId})
  `).rejects.toThrow();
  expect(
    await capability.list({
      actorUserId: leadProfile.userId,
      participantId,
      limit: 20,
    }),
  ).toBeNull();
  expect(
    await participation.changeRole({
      actorUserId: fixture.providerUserId,
      commandId: randomUUID(),
      participantId: leadParticipantId,
      role: "SITE_MANAGER",
      action: "ASSIGN",
    }),
  ).toMatchObject({ status: "APPLIED" });
  expect(
    await capability.confirm({
      actorUserId: leadProfile.userId,
      commandId: randomUUID(),
      participantId,
      claimId: revokedClaimId,
    }),
  ).toMatchObject({ status: "APPLIED" });
  expect(
    await participation.changeRole({
      actorUserId: fixture.providerUserId,
      commandId: randomUUID(),
      participantId: leadParticipantId,
      role: "SITE_MANAGER",
      action: "REVOKE",
    }),
  ).toMatchObject({ status: "APPLIED" });
  expect(
    await participation.decide({
      actorUserId: leadProfile.userId,
      commandId: randomUUID(),
      participantId: leadParticipantId,
      decision: "LEAVE",
    }),
  ).toMatchObject({ status: "APPLIED" });
  await expect(sql`
    UPDATE job_participant_capability_claims
    SET custom_skill_text = 'Zmenené' WHERE id = ${customClaimId}
  `).rejects.toThrow();
  await expect(sql`
    DELETE FROM job_participant_capability_confirmations
    WHERE claim_id = ${customClaimId}
  `).rejects.toThrow();
  await expect(sql`
    INSERT INTO job_participant_capability_claims (
      id, participant_id, kind, custom_skill_text, proposed_by_user_id
    ) VALUES (${randomUUID()}, ${participantId}, 'CUSTOM_SKILL',
      'Ručné omietanie', ${fixture.customerUserId})
  `).rejects.toThrow();
  await expect(sql`
    INSERT INTO job_participant_capability_claims (
      id, participant_id, kind, profession_taxonomy_release_id,
      profession_code, proposed_by_user_id
    ) SELECT ${randomUUID()}, ${participantId}, 'PROFESSION',
      profession_taxonomy_release_id, profession_code, ${fixture.providerUserId}
    FROM job_participant_capability_claims WHERE id = ${professionCommandId}
  `).rejects.toThrow();

  expect(
    await participation.decide({
      actorUserId: fixture.targetUserId,
      commandId: randomUUID(),
      participantId,
      decision: "LEAVE",
    }),
  ).toMatchObject({ status: "APPLIED", state: "LEFT" });
  expect(
    (
      await capability.list({
        actorUserId: fixture.targetUserId,
        participantId,
        limit: 20,
      })
    )?.canAct,
  ).toBe(false);
  expect(
    await capability.propose({
      actorUserId: fixture.targetUserId,
      commandId: randomUUID(),
      participantId,
      kind: "CUSTOM_SKILL",
      customSkillText: "Murovanie",
    }),
  ).toEqual({ status: "STALE_STATE" });
  expect(
    (
      await sql<Array<{ total: number }>>`
    SELECT count(*)::integer AS total FROM confirmed_job_participant_capability_evidence
    WHERE participant_id = ${participantId}
  `
    )[0]?.total,
  ).toBe(5);
}
