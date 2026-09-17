import { createHash, randomUUID } from "node:crypto";

import type { Sql } from "postgres";
import { expect } from "vitest";

import { createJobParticipationRepository } from "../src/job-participation-repository.js";
import { createJobParticipationDetailRepository } from "../src/job-participation-detail-repository.js";
import { createJobWorkGroupCommandRepository } from "../src/job-work-group-command-repository.js";

interface JobFixture {
  readonly id: string;
  readonly customerUserId: string;
  readonly providerProfileId: string;
  readonly providerUserId: string;
}

const fingerprint = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export async function runJobRosterIdentityIntegrationAssertions(sql: Sql) {
  const [job] = await sql<JobFixture[]>`
    SELECT job.id,
      customer.owner_user_id AS "customerUserId",
      provider.id AS "providerProfileId",
      provider.owner_user_id AS "providerUserId"
    FROM jobs job
    JOIN current_job_states state ON state.job_id = job.id
    JOIN customer_profiles customer ON customer.id = job.customer_profile_id
    JOIN craftsman_profiles provider
      ON provider.id = job.primary_craftsman_profile_id
    WHERE state.state = 'CONFIRMED'
      AND provider.profile_type = 'INDIVIDUAL'
    ORDER BY job.accepted_at DESC, job.id DESC LIMIT 1
  `;
  if (!job)
    throw new Error("Confirmed individual-provider Job fixture missing.");

  const crewId = randomUUID();
  await sql`
    INSERT INTO crews (
      id, founder_craftsman_profile_id, created_by_user_id, name
    ) VALUES (
      ${crewId}, ${job.providerProfileId}, ${job.providerUserId},
      'Skúšobná pracovná čata'
    )
  `;
  await assertCrewMembership(sql, job, crewId);
  const participation = createJobParticipationRepository(sql);
  const invitationCommandId = randomUUID();
  const invitation = await participation.invite({
    actorUserId: job.providerUserId,
    commandId: invitationCommandId,
    jobId: job.id,
    craftsmanProfileId: job.providerProfileId,
  });
  expect(invitation.status).toBe("APPLIED");
  if (!("participantId" in invitation))
    throw new Error("Job invitation result missing identity.");
  const participantId = invitation.participantId;
  const detail = createJobParticipationDetailRepository(sql);
  const participantInviteDetail = await detail.getForViewer({
    actorUserId: job.providerUserId,
    participantId,
  });
  expect(participantInviteDetail).toMatchObject({
    participantId,
    viewerRole: "PARTICIPANT",
    state: "INVITED",
    canDecide: true,
  });
  expect(
    await detail.getForViewer({
      actorUserId: job.customerUserId,
      participantId,
    }),
  ).toBeNull();
  expect(
    await participation.invite({
      actorUserId: job.providerUserId,
      commandId: invitationCommandId,
      jobId: job.id,
      craftsmanProfileId: job.providerProfileId,
    }),
  ).toMatchObject({ status: "DEDUPLICATED", participantId });
  expect(
    await participation.invite({
      actorUserId: job.providerUserId,
      commandId: randomUUID(),
      jobId: job.id,
      craftsmanProfileId: job.providerProfileId,
    }),
  ).toEqual({ status: "ALREADY_INVITED" });
  expect(
    await participation.invite({
      actorUserId: job.customerUserId,
      commandId: randomUUID(),
      jobId: job.id,
      craftsmanProfileId: job.providerProfileId,
    }),
  ).toEqual({ status: "NOT_FOUND" });
  const inbox = await participation.listPendingForInvitee({
    actorUserId: job.providerUserId,
    limit: 20,
  });
  expect(inbox.items.some((item) => item.participantId === participantId)).toBe(
    true,
  );
  const customerInbox = await participation.listPendingForInvitee({
    actorUserId: job.customerUserId,
    limit: 20,
  });
  expect(
    customerInbox.items.some((item) => item.participantId === participantId),
  ).toBe(false);
  const [invited] = await sql<
    Array<{ state: string; verifiedParticipation: boolean }>
  >`
    SELECT state, verified_participation AS "verifiedParticipation"
    FROM current_job_participants WHERE id = ${participantId}
  `;
  expect(invited).toEqual({ state: "INVITED", verifiedParticipation: false });
  await expect(sql`
    INSERT INTO job_participant_events (
      event_id, participant_id, event_sequence, event_kind,
      actor_user_id, payload_fingerprint
    ) VALUES (
      ${randomUUID()}, ${participantId}, 1, 'ACCEPT',
      ${job.customerUserId}, ${fingerprint("wrong acceptance actor")}
    )
  `).rejects.toThrow();
  const acceptedEventId = randomUUID();
  expect(
    await participation.decide({
      actorUserId: job.providerUserId,
      commandId: acceptedEventId,
      participantId,
      decision: "ACCEPT",
    }),
  ).toMatchObject({ status: "APPLIED", state: "ACCEPTED" });
  expect(
    await participation.decide({
      actorUserId: job.providerUserId,
      commandId: acceptedEventId,
      participantId,
      decision: "ACCEPT",
    }),
  ).toMatchObject({ status: "DEDUPLICATED", state: "ACCEPTED" });
  expect(
    (
      await participation.listPendingForInvitee({
        actorUserId: job.providerUserId,
        limit: 20,
      })
    ).items.some((item) => item.participantId === participantId),
  ).toBe(false);
  expect(
    await participation.decide({
      actorUserId: job.customerUserId,
      commandId: randomUUID(),
      participantId,
      decision: "REMOVE",
      reason: "Neoprávnené ukončenie",
    }),
  ).toEqual({ status: "NOT_FOUND" });
  const [accepted] = await sql<
    Array<{
      acceptedAt: Date;
      leftAt: Date | null;
      state: string;
      verifiedParticipation: boolean;
    }>
  >`
    SELECT accepted_at AS "acceptedAt", left_at AS "leftAt", state,
      verified_participation AS "verifiedParticipation"
    FROM current_job_participants WHERE id = ${participantId}
  `;
  expect(accepted?.acceptedAt).toBeInstanceOf(Date);
  expect(accepted).toMatchObject({
    leftAt: null,
    state: "ACCEPTED",
    verifiedParticipation: true,
  });
  expect(
    await detail.getForViewer({
      actorUserId: job.customerUserId,
      participantId,
    }),
  ).toMatchObject({
    participantId,
    viewerRole: "CUSTOMER",
    state: "ACCEPTED",
    canDecide: false,
    canLeave: false,
  });
  const [memberRole] = await sql<Array<{ active: boolean; role: string }>>`
    SELECT active, role FROM job_participant_role_intervals
    WHERE participant_id = ${participantId} AND role = 'MEMBER'
  `;
  expect(memberRole).toEqual({ active: true, role: "MEMBER" });
  const leadEventId = randomUUID();
  const leadCommand = {
    actorUserId: job.providerUserId,
    commandId: leadEventId,
    participantId,
    role: "LEAD" as const,
    action: "ASSIGN" as const,
  };
  expect(await participation.changeRole(leadCommand)).toMatchObject({
    status: "APPLIED",
    role: "LEAD",
    active: true,
  });
  expect(await participation.changeRole(leadCommand)).toMatchObject({
    status: "DEDUPLICATED",
    role: "LEAD",
    active: true,
  });
  await expect(
    participation.changeRole({ ...leadCommand, role: "COORDINATOR" }),
  ).rejects.toThrow();
  expect(
    await participation.changeRole({
      ...leadCommand,
      actorUserId: job.customerUserId,
      commandId: randomUUID(),
    }),
  ).toEqual({ status: "NOT_FOUND" });
  expect(
    await participation.changeRole({ ...leadCommand, commandId: randomUUID() }),
  ).toEqual({ status: "STALE_STATE" });
  await sql`
    INSERT INTO job_participant_role_events (
      event_id, participant_id, role, role_sequence, action,
      actor_user_id, payload_fingerprint
    ) VALUES (
      ${randomUUID()}, ${participantId}, 'COORDINATOR', 1, 'ASSIGN',
      ${job.providerUserId}, ${fingerprint("assign coordinator")}
    )
  `;
  const activeRoles = await sql<Array<{ role: string }>>`
    SELECT role FROM job_participant_role_intervals
    WHERE participant_id = ${participantId} AND active
    ORDER BY role
  `;
  expect(activeRoles.map((row) => row.role)).toEqual([
    "COORDINATOR",
    "LEAD",
    "MEMBER",
  ]);
  await expect(sql`
    INSERT INTO job_participant_role_events (
      event_id, participant_id, role, role_sequence, action,
      actor_user_id, payload_fingerprint
    ) VALUES (
      ${randomUUID()}, ${participantId}, 'LEAD', 2, 'ASSIGN',
      ${job.providerUserId}, ${fingerprint("duplicate lead")}
    )
  `).rejects.toThrow();
  await expect(sql`
    INSERT INTO job_participant_role_events (
      event_id, participant_id, role, role_sequence, action,
      actor_user_id, payload_fingerprint
    ) VALUES (
      ${randomUUID()}, ${participantId}, 'LEAD', 2, 'REVOKE',
      ${job.customerUserId}, ${fingerprint("wrong role actor")}
    )
  `).rejects.toThrow();
  const revokeLead = {
    ...leadCommand,
    commandId: randomUUID(),
    action: "REVOKE" as const,
  };
  expect(await participation.changeRole(revokeLead)).toMatchObject({
    status: "APPLIED",
    role: "LEAD",
    active: false,
  });
  expect(await participation.changeRole(revokeLead)).toMatchObject({
    status: "DEDUPLICATED",
    role: "LEAD",
    active: false,
  });
  expect(
    await participation.changeRole({ ...revokeLead, commandId: randomUUID() }),
  ).toEqual({ status: "STALE_STATE" });
  const [revokedLead] = await sql<Array<{ active: boolean; endedAt: Date }>>`
    SELECT active, ended_at AS "endedAt"
    FROM job_participant_role_intervals
    WHERE assignment_event_id = ${leadEventId}
  `;
  expect(revokedLead?.active).toBe(false);
  expect(revokedLead?.endedAt).toBeInstanceOf(Date);
  await expect(sql`
    UPDATE job_participant_role_events SET action = 'REVOKE'
    WHERE event_id = ${leadEventId}
  `).rejects.toThrow();
  const workGroups = createJobWorkGroupCommandRepository(sql);
  const groupCommand = {
    actorUserId: job.providerUserId,
    commandId: randomUUID(),
    jobId: job.id,
    name: "Skúšobná montážna skupina",
  };
  const createdGroup = await workGroups.create(groupCommand);
  expect(createdGroup).toMatchObject({ status: "APPLIED" });
  if (!("workGroupId" in createdGroup))
    throw new Error("Work-group command identity missing.");
  const commandGroupId = createdGroup.workGroupId;
  expect(await workGroups.create(groupCommand)).toMatchObject({
    status: "DEDUPLICATED",
    workGroupId: commandGroupId,
  });
  expect(
    await workGroups.create({
      ...groupCommand,
      commandId: randomUUID(),
      actorUserId: job.customerUserId,
    }),
  ).toEqual({ status: "NOT_FOUND" });
  const customerGroups = await workGroups.listForPrimaryParty({
    actorUserId: job.customerUserId,
    jobId: job.id,
    limit: 20,
  });
  expect(
    customerGroups?.groups.some((group) => group.id === commandGroupId),
  ).toBe(true);
  const [unassigned] = await sql<Array<{ count: number }>>`
    SELECT count(*)::integer AS count
    FROM job_work_group_assignments
    WHERE work_group_id = ${commandGroupId}
  `;
  expect(unassigned?.count).toBe(0);
  const assignCommand = {
    actorUserId: job.providerUserId,
    commandId: randomUUID(),
    workGroupId: commandGroupId,
    participantId,
  };
  const assigned = await workGroups.assign(assignCommand);
  expect(assigned).toMatchObject({ status: "APPLIED" });
  if (!("assignmentId" in assigned))
    throw new Error("Work-group assignment identity missing.");
  expect(await workGroups.assign(assignCommand)).toMatchObject({
    status: "DEDUPLICATED",
    assignmentId: assigned.assignmentId,
  });
  expect(
    await workGroups.assign({ ...assignCommand, commandId: randomUUID() }),
  ).toEqual({ status: "STALE_STATE" });
  expect(
    await workGroups.assign({
      ...assignCommand,
      commandId: randomUUID(),
      actorUserId: job.customerUserId,
    }),
  ).toEqual({ status: "NOT_FOUND" });
  const leaveGroup = {
    actorUserId: job.providerUserId,
    assignmentId: assigned.assignmentId,
    commandId: randomUUID(),
    action: "LEAVE" as const,
  };
  expect(await workGroups.depart(leaveGroup)).toMatchObject({
    status: "APPLIED",
  });
  expect(await workGroups.depart(leaveGroup)).toMatchObject({
    status: "DEDUPLICATED",
  });
  expect(
    await workGroups.depart({ ...leaveGroup, commandId: randomUUID() }),
  ).toEqual({ status: "STALE_STATE" });
  const reassigned = await workGroups.assign({
    ...assignCommand,
    commandId: randomUUID(),
  });
  expect(reassigned).toMatchObject({ status: "APPLIED" });
  if (!("assignmentId" in reassigned))
    throw new Error("Work-group reassignment identity missing.");
  const removedGroupMember = await workGroups.depart({
    actorUserId: job.providerUserId,
    assignmentId: reassigned.assignmentId,
    commandId: randomUUID(),
    action: "REMOVE",
    reason: "Zmena rozdelenia pracovných skupín",
  });
  expect(removedGroupMember).toMatchObject({ status: "APPLIED" });
  const groupHistory = await sql<Array<{ active: boolean; sequence: number }>>`
    SELECT active, assignment_sequence AS sequence
    FROM current_job_work_group_assignments
    WHERE work_group_id = ${commandGroupId} AND participant_id = ${participantId}
    ORDER BY assignment_sequence
  `;
  expect(groupHistory).toEqual([
    { active: false, sequence: 1 },
    { active: false, sequence: 2 },
  ]);
  const groupId = randomUUID();
  await sql`
    INSERT INTO job_work_groups (
      id, job_id, crew_id, name, created_by_user_id
    ) VALUES (
      ${groupId}, ${job.id}, ${crewId}, 'Montážna skupina',
      ${job.providerUserId}
    )
  `;
  const firstAssignmentId = randomUUID();
  await sql`
    INSERT INTO job_work_group_assignments (
      id, job_id, work_group_id, participant_id,
      assignment_sequence, assigned_by_user_id
    ) VALUES (
      ${firstAssignmentId}, ${job.id}, ${groupId}, ${participantId},
      1, ${job.providerUserId}
    )
  `;
  await expect(sql`
    INSERT INTO job_work_group_assignments (
      id, job_id, work_group_id, participant_id,
      assignment_sequence, assigned_by_user_id
    ) VALUES (
      ${randomUUID()}, ${job.id}, ${groupId}, ${participantId},
      2, ${job.customerUserId}
    )
  `).rejects.toThrow();
  await expect(sql`
    INSERT INTO job_work_group_assignments (
      id, job_id, work_group_id, participant_id,
      assignment_sequence, assigned_by_user_id
    ) VALUES (
      ${randomUUID()}, ${job.id}, ${groupId}, ${participantId},
      2, ${job.providerUserId}
    )
  `).rejects.toThrow();
  await expect(sql`
    INSERT INTO job_work_group_departure_events (
      event_id, assignment_id, event_kind, actor_user_id,
      payload_fingerprint
    ) VALUES (
      ${randomUUID()}, ${firstAssignmentId}, 'LEAVE',
      ${job.customerUserId}, ${fingerprint("wrong group departure")}
    )
  `).rejects.toThrow();
  await sql`
    INSERT INTO job_work_group_departure_events (
      event_id, assignment_id, event_kind, actor_user_id,
      payload_fingerprint
    ) VALUES (
      ${randomUUID()}, ${firstAssignmentId}, 'LEAVE',
      ${job.providerUserId}, ${fingerprint("left first group interval")}
    )
  `;
  const secondAssignmentId = randomUUID();
  await sql`
    INSERT INTO job_work_group_assignments (
      id, job_id, work_group_id, participant_id,
      assignment_sequence, assigned_by_user_id
    ) VALUES (
      ${secondAssignmentId}, ${job.id}, ${groupId}, ${participantId},
      2, ${job.providerUserId}
    )
  `;
  const assignments = await sql<
    Array<{ active: boolean; assignmentSequence: number; endedAt: Date | null }>
  >`
    SELECT active, assignment_sequence AS "assignmentSequence",
      ended_at AS "endedAt"
    FROM current_job_work_group_assignments
    WHERE work_group_id = ${groupId} AND participant_id = ${participantId}
    ORDER BY assignment_sequence
  `;
  expect(assignments[0]?.endedAt).toBeInstanceOf(Date);
  expect(assignments).toMatchObject([
    { active: false, assignmentSequence: 1 },
    { active: true, assignmentSequence: 2, endedAt: null },
  ]);
  await expect(sql`
    INSERT INTO job_participant_events (
      event_id, participant_id, event_sequence, event_kind,
      actor_user_id, payload_fingerprint
    ) VALUES (
      ${randomUUID()}, ${participantId}, 3, 'LEAVE',
      ${job.providerUserId}, ${fingerprint("skipped event sequence")}
    )
  `).rejects.toThrow();
  await expect(sql`
    INSERT INTO job_participant_events (
      event_id, participant_id, event_sequence, event_kind,
      actor_user_id, payload_fingerprint
    ) VALUES (
      ${randomUUID()}, ${participantId}, 2, 'REMOVE',
      ${job.customerUserId}, ${fingerprint("wrong removal actor")}
    )
  `).rejects.toThrow();
  await sql`
    INSERT INTO job_participant_events (
      event_id, participant_id, event_sequence, event_kind,
      actor_user_id, payload_fingerprint
    ) VALUES (
      ${randomUUID()}, ${participantId}, 2, 'LEAVE',
      ${job.providerUserId}, ${fingerprint("participant left")}
    )
  `;
  const [left] = await sql<
    Array<{
      acceptedAt: Date;
      leftAt: Date;
      state: string;
      verifiedParticipation: boolean;
    }>
  >`
    SELECT accepted_at AS "acceptedAt", left_at AS "leftAt", state,
      verified_participation AS "verifiedParticipation"
    FROM current_job_participants WHERE id = ${participantId}
  `;
  expect(left?.leftAt).toBeInstanceOf(Date);
  expect(left).toMatchObject({
    acceptedAt: accepted?.acceptedAt,
    state: "LEFT",
    verifiedParticipation: true,
  });
  const rolesAfterLeave = await sql<Array<{ active: boolean; role: string }>>`
    SELECT active, role FROM job_participant_role_intervals
    WHERE participant_id = ${participantId} ORDER BY role
  `;
  expect(rolesAfterLeave).toEqual([
    { active: false, role: "COORDINATOR" },
    { active: false, role: "LEAD" },
    { active: false, role: "MEMBER" },
  ]);
  const [endedGroupAssignment] = await sql<
    Array<{ active: boolean; endedAt: Date }>
  >`
    SELECT active, ended_at AS "endedAt"
    FROM current_job_work_group_assignments
    WHERE id = ${secondAssignmentId}
  `;
  expect(endedGroupAssignment).toEqual({
    active: false,
    endedAt: left?.leftAt,
  });
  await expect(sql`
    INSERT INTO job_work_group_assignments (
      id, job_id, work_group_id, participant_id,
      assignment_sequence, assigned_by_user_id
    ) VALUES (
      ${randomUUID()}, ${job.id}, ${groupId}, ${participantId},
      3, ${job.providerUserId}
    )
  `).rejects.toThrow();
  await expect(sql`
    INSERT INTO job_participant_events (
      event_id, participant_id, event_sequence, event_kind,
      actor_user_id, reason, payload_fingerprint
    ) VALUES (
      ${randomUUID()}, ${participantId}, 3, 'REMOVE',
      ${job.providerUserId}, 'Nemožno znova ukončiť',
      ${fingerprint("already left")}
    )
  `).rejects.toThrow();
  await expect(sql`
    UPDATE job_participant_events SET event_kind = 'DECLINE'
    WHERE event_id = ${acceptedEventId}
  `).rejects.toThrow();
  await expect(sql`
    DELETE FROM job_participant_events WHERE event_id = ${acceptedEventId}
  `).rejects.toThrow();

  const pendingParticipantId = randomUUID();
  await sql`
    INSERT INTO job_participants (
      id, job_id, craftsman_profile_id, invitation_sequence,
      invited_by_user_id
    ) VALUES (
      ${pendingParticipantId}, ${job.id}, ${job.providerProfileId}, 2,
      ${job.providerUserId}
    )
  `;
  await expect(sql`
    INSERT INTO job_work_group_assignments (
      id, job_id, work_group_id, participant_id,
      assignment_sequence, assigned_by_user_id
    ) VALUES (
      ${randomUUID()}, ${job.id}, ${groupId}, ${pendingParticipantId},
      1, ${job.providerUserId}
    )
  `).rejects.toThrow();
  const [stored] = await sql<
    Array<{ crewId: string; jobId: string; profileId: string }>
  >`
    SELECT group_row.crew_id AS "crewId", participant.job_id AS "jobId",
      participant.craftsman_profile_id AS "profileId"
    FROM job_work_groups group_row
    JOIN job_participants participant
      ON participant.job_id = group_row.job_id
    WHERE group_row.id = ${groupId} AND participant.id = ${participantId}
  `;
  expect(stored).toEqual({
    crewId,
    jobId: job.id,
    profileId: job.providerProfileId,
  });

  await expect(sql`
    INSERT INTO crews (
      id, founder_craftsman_profile_id, created_by_user_id, name
    ) VALUES (
      ${randomUUID()}, ${job.providerProfileId}, ${job.customerUserId},
      'Neoprávnená čata'
    )
  `).rejects.toThrow();
  await expect(sql`
    INSERT INTO job_participants (
      id, job_id, craftsman_profile_id, invitation_sequence,
      invited_by_user_id
    ) VALUES (
      ${randomUUID()}, ${job.id}, ${job.providerProfileId}, 3,
      ${job.providerUserId}
    )
  `).rejects.toThrow();
  await expect(sql`
    INSERT INTO job_participants (
      id, job_id, craftsman_profile_id, invitation_sequence,
      invited_by_user_id
    ) VALUES (
      ${randomUUID()}, ${job.id}, ${job.providerProfileId}, 3,
      ${job.customerUserId}
    )
  `).rejects.toThrow();
  await expect(sql`
    INSERT INTO job_participants (
      id, job_id, craftsman_profile_id, invitation_sequence,
      invited_by_user_id
    ) VALUES (
      ${randomUUID()}, ${job.id}, ${job.providerProfileId}, 4,
      ${job.providerUserId}
    )
  `).rejects.toThrow();
  await expect(sql`
    INSERT INTO job_work_groups (
      id, job_id, crew_id, name, created_by_user_id
    ) VALUES (
      ${randomUUID()}, ${job.id}, ${crewId}, 'Cudzia skupina',
      ${job.customerUserId}
    )
  `).rejects.toThrow();
  await expect(sql`
    UPDATE job_participants SET invitation_sequence = 2
    WHERE id = ${participantId}
  `).rejects.toThrow();
  await expect(sql`
    DELETE FROM job_work_groups WHERE id = ${groupId}
  `).rejects.toThrow();
  await expect(sql`
    UPDATE job_work_group_assignments SET assignment_sequence = 3
    WHERE id = ${firstAssignmentId}
  `).rejects.toThrow();
  await expect(sql`
    DELETE FROM job_work_group_departure_events
    WHERE assignment_id = ${firstAssignmentId}
  `).rejects.toThrow();
}

async function assertCrewMembership(sql: Sql, job: JobFixture, crewId: string) {
  const invitationId = randomUUID();
  await sql`
    INSERT INTO crew_membership_invitations (
      id, crew_id, craftsman_profile_id, invitation_sequence,
      invited_by_user_id
    ) VALUES (
      ${invitationId}, ${crewId}, ${job.providerProfileId}, 1,
      ${job.providerUserId}
    )
  `;
  const [invited] = await sql<Array<{ active: boolean; state: string }>>`
    SELECT active, state FROM current_crew_memberships
    WHERE id = ${invitationId}
  `;
  expect(invited).toEqual({ active: false, state: "INVITED" });
  await expect(sql`
    INSERT INTO crew_membership_events (
      event_id, invitation_id, event_sequence, event_kind,
      actor_user_id, payload_fingerprint
    ) VALUES (
      ${randomUUID()}, ${invitationId}, 1, 'ACCEPT',
      ${job.customerUserId}, ${fingerprint("wrong Crew acceptance")}
    )
  `).rejects.toThrow();
  const acceptanceEventId = randomUUID();
  await sql`
    INSERT INTO crew_membership_events (
      event_id, invitation_id, event_sequence, event_kind,
      actor_user_id, payload_fingerprint
    ) VALUES (
      ${acceptanceEventId}, ${invitationId}, 1, 'ACCEPT',
      ${job.providerUserId}, ${fingerprint("accepted Crew membership")}
    )
  `;
  const [accepted] = await sql<
    Array<{ acceptedAt: Date; active: boolean; state: string }>
  >`
    SELECT accepted_at AS "acceptedAt", active, state
    FROM current_crew_memberships WHERE id = ${invitationId}
  `;
  expect(accepted?.acceptedAt).toBeInstanceOf(Date);
  expect(accepted).toMatchObject({
    active: true,
    state: "ACCEPTED",
  });
  const [participantCount] = await sql<Array<{ total: number }>>`
    SELECT count(*)::integer AS total FROM job_participants
    WHERE job_id = ${job.id}
  `;
  expect(participantCount?.total).toBe(0);
  await expect(sql`
    INSERT INTO crew_membership_invitations (
      id, crew_id, craftsman_profile_id, invitation_sequence,
      invited_by_user_id
    ) VALUES (
      ${randomUUID()}, ${crewId}, ${job.providerProfileId}, 2,
      ${job.providerUserId}
    )
  `).rejects.toThrow();
  await sql`
    INSERT INTO crew_membership_events (
      event_id, invitation_id, event_sequence, event_kind,
      actor_user_id, payload_fingerprint
    ) VALUES (
      ${randomUUID()}, ${invitationId}, 2, 'LEAVE',
      ${job.providerUserId}, ${fingerprint("left Crew")}
    )
  `;
  const [left] = await sql<
    Array<{ active: boolean; leftAt: Date; state: string }>
  >`
    SELECT active, left_at AS "leftAt", state
    FROM current_crew_memberships WHERE id = ${invitationId}
  `;
  expect(left?.leftAt).toBeInstanceOf(Date);
  expect(left).toMatchObject({
    active: false,
    state: "LEFT",
  });
  await sql`
    INSERT INTO crew_membership_invitations (
      id, crew_id, craftsman_profile_id, invitation_sequence,
      invited_by_user_id
    ) VALUES (
      ${randomUUID()}, ${crewId}, ${job.providerProfileId}, 2,
      ${job.providerUserId}
    )
  `;
  await expect(sql`
    UPDATE crew_membership_events SET event_kind = 'DECLINE'
    WHERE event_id = ${acceptanceEventId}
  `).rejects.toThrow();
  await expect(sql`
    DELETE FROM crew_membership_invitations WHERE id = ${invitationId}
  `).rejects.toThrow();
}

export async function runJobRosterCancelledIntegrationAssertions(sql: Sql) {
  const [cancelled] = await sql<
    Array<{ id: string; providerProfileId: string; providerUserId: string }>
  >`
    SELECT job.id, provider.id AS "providerProfileId",
      provider.owner_user_id AS "providerUserId"
    FROM jobs job
    JOIN current_job_states state ON state.job_id = job.id
    JOIN craftsman_profiles provider
      ON provider.id = job.primary_craftsman_profile_id
    WHERE state.state = 'CANCELLED'
      AND provider.profile_type = 'INDIVIDUAL'
    ORDER BY job.accepted_at DESC LIMIT 1
  `;
  if (!cancelled) throw new Error("Cancelled individual-provider Job missing.");
  const [pending] = await sql<Array<{ id: string }>>`
    SELECT id FROM current_job_participants
    WHERE job_id = ${cancelled.id} AND state = 'INVITED'
    ORDER BY invited_at DESC LIMIT 1
  `;
  if (!pending) throw new Error("Pending Job participant fixture missing.");
  await expect(sql`
    INSERT INTO job_participant_events (
      event_id, participant_id, event_sequence, event_kind,
      actor_user_id, payload_fingerprint
    ) VALUES (
      ${randomUUID()}, ${pending.id}, 1, 'ACCEPT',
      ${cancelled.providerUserId}, ${fingerprint("cancelled Job acceptance")}
    )
  `).rejects.toThrow();
  await expect(sql`
    INSERT INTO job_participants (
      id, job_id, craftsman_profile_id, invitation_sequence,
      invited_by_user_id
    ) VALUES (
      ${randomUUID()}, ${cancelled.id}, ${cancelled.providerProfileId}, 3,
      ${cancelled.providerUserId}
    )
  `).rejects.toThrow();
  await expect(sql`
    INSERT INTO job_work_groups (
      id, job_id, name, created_by_user_id
    ) VALUES (
      ${randomUUID()}, ${cancelled.id}, 'Po zrušení',
      ${cancelled.providerUserId}
    )
  `).rejects.toThrow();
}
