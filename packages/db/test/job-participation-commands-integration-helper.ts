import { randomUUID } from "node:crypto";

import type { Sql } from "postgres";
import { expect } from "vitest";

import {
  createJobParticipationRepository,
  JobParticipationIdempotencyError,
} from "../src/job-participation-repository.js";

interface Fixture {
  readonly jobId: string;
  readonly participantId: string;
  readonly profileId: string;
  readonly providerUserId: string;
  readonly customerUserId: string;
  readonly targetUserId: string;
}

export async function runJobParticipationCommandsIntegrationAssertions(
  sql: Sql,
) {
  const [fixture] = await sql<Fixture[]>`
    SELECT job.id AS "jobId", participant.id AS "participantId",
      participant.craftsman_profile_id AS "profileId",
      provider.owner_user_id AS "providerUserId",
      customer.owner_user_id AS "customerUserId",
      invitee.owner_user_id AS "targetUserId"
    FROM current_job_participants participant
    JOIN jobs job ON job.id = participant.job_id
    JOIN current_job_states state ON state.job_id = job.id
    JOIN customer_profiles customer ON customer.id = job.customer_profile_id
    JOIN craftsman_profiles provider
      ON provider.id = job.primary_craftsman_profile_id
    JOIN craftsman_profiles invitee
      ON invitee.id = participant.craftsman_profile_id
    WHERE participant.state = 'INVITED' AND state.state = 'CONFIRMED'
    ORDER BY job.accepted_at DESC, participant.invited_at DESC LIMIT 1
  `;
  if (!fixture) throw new Error("Pending Job participation fixture missing.");
  const service = createJobParticipationRepository(sql);

  const declineCommandId = randomUUID();
  const decline = {
    actorUserId: fixture.providerUserId,
    commandId: declineCommandId,
    participantId: fixture.participantId,
    decision: "DECLINE" as const,
  };
  expect(await service.decide(decline)).toMatchObject({
    status: "APPLIED",
    state: "DECLINED",
  });
  expect(await service.decide(decline)).toMatchObject({
    status: "DEDUPLICATED",
    state: "DECLINED",
  });
  const declinedNotices = await sql<
    Array<{ eventName: string; payload: Record<string, unknown> }>
  >`
    SELECT event_name AS "eventName", payload
    FROM domain_outbox_events
    WHERE entity_type = 'JOB_PARTICIPANT'
      AND entity_id = ${fixture.participantId}
      AND idempotency_key LIKE ${`%:event:${declineCommandId}:%`}
  `;
  expect(declinedNotices).toEqual([
    {
      eventName: "job_participant.declined",
      payload: {
        job_id: fixture.jobId,
        participant_id: fixture.participantId,
        participation_revision: 1,
        recipient_user_id: fixture.providerUserId,
      },
    },
  ]);
  const [pendingCustomerLeak] = await sql<Array<{ idempotencyKey: string }>>`
    SELECT idempotency_key AS "idempotencyKey"
    FROM domain_outbox_events
    WHERE entity_type = 'JOB_PARTICIPANT'
      AND entity_id = ${fixture.participantId}
      AND payload->>'recipient_user_id' = ${fixture.customerUserId}
    LIMIT 1
  `;
  expect(pendingCustomerLeak).toBeUndefined();
  await expect(
    service.decide({ ...decline, decision: "ACCEPT" }),
  ).rejects.toThrow(JobParticipationIdempotencyError);
  expect(
    await service.decide({
      ...decline,
      commandId: randomUUID(),
      decision: "ACCEPT",
    }),
  ).toEqual({ status: "STALE_STATE" });

  const invitationCommandId = randomUUID();
  const invite = {
    actorUserId: fixture.providerUserId,
    commandId: invitationCommandId,
    jobId: fixture.jobId,
    craftsmanProfileId: fixture.profileId,
  };
  const renewed = await service.invite(invite);
  expect(renewed.status).toBe("APPLIED");
  if (!("participantId" in renewed))
    throw new Error("Reinvitation identity missing.");
  expect(await service.invite(invite)).toMatchObject({
    status: "DEDUPLICATED",
    participantId: renewed.participantId,
  });
  await expect(
    service.invite({ ...invite, craftsmanProfileId: randomUUID() }),
  ).rejects.toThrow(JobParticipationIdempotencyError);
  expect(await service.invite({ ...invite, commandId: randomUUID() })).toEqual({
    status: "ALREADY_INVITED",
  });
  expect(
    await service.decide({
      actorUserId: fixture.customerUserId,
      commandId: randomUUID(),
      participantId: renewed.participantId,
      decision: "ACCEPT",
    }),
  ).toEqual({ status: "NOT_FOUND" });
  expect(
    await service.decide({
      actorUserId: fixture.providerUserId,
      commandId: randomUUID(),
      participantId: renewed.participantId,
      decision: "ACCEPT",
    }),
  ).toMatchObject({ status: "APPLIED", state: "ACCEPTED" });
  const removeCommandId = randomUUID();
  const remove = {
    actorUserId: fixture.providerUserId,
    commandId: removeCommandId,
    participantId: renewed.participantId,
    decision: "REMOVE" as const,
    reason: "Účasť ukončil hlavný poskytovateľ",
  };
  expect(await service.decide(remove)).toMatchObject({
    status: "APPLIED",
    state: "REMOVED",
  });
  expect(await service.decide(remove)).toMatchObject({
    status: "DEDUPLICATED",
    state: "REMOVED",
  });
  const outbox = await sql<
    Array<{
      eventName: string;
      idempotencyKey: string;
      payload: Record<string, unknown>;
    }>
  >`
    SELECT event_name AS "eventName",
      idempotency_key AS "idempotencyKey", payload
    FROM domain_outbox_events
    WHERE entity_type = 'JOB_PARTICIPANT'
      AND entity_id = ${renewed.participantId}
    ORDER BY event_name, idempotency_key
  `;
  expect(outbox.map((event) => event.eventName)).toEqual(
    [
      "job_participant.accepted",
      "job_participant.invited",
      "job_participant.joined",
      "job_participant.removed",
      "job_participant.departed",
    ].sort(),
  );
  expect(new Set(outbox.map((event) => event.idempotencyKey)).size).toBe(5);
  expect(
    outbox.every(
      (event) =>
        event.payload["job_id"] === fixture.jobId &&
        event.payload["participant_id"] === renewed.participantId &&
        Number.isSafeInteger(event.payload["participation_revision"]),
    ),
  ).toBe(true);
  expect(
    outbox.find((event) => event.eventName === "job_participant.invited")
      ?.payload["recipient_user_id"],
  ).toBe(fixture.targetUserId);
  expect(
    outbox.find((event) => event.eventName === "job_participant.joined")
      ?.payload["recipient_user_id"],
  ).toBe(fixture.customerUserId);
  expect(
    outbox.find((event) => event.eventName === "job_participant.departed")
      ?.payload["recipient_user_id"],
  ).toBe(fixture.customerUserId);
  expect(
    outbox.find((event) => event.eventName === "job_participant.accepted")
      ?.payload["recipient_user_id"],
  ).toBe(fixture.providerUserId);
  expect(
    outbox.find((event) => event.eventName === "job_participant.removed")
      ?.payload["recipient_user_id"],
  ).toBe(fixture.targetUserId);
  expect(JSON.stringify(outbox)).not.toContain(remove.reason);
  expect(JSON.stringify(outbox)).not.toMatch(/address|contact|phone|email/iu);
  const [removed] = await sql<
    Array<{ state: string; acceptedAt: Date; leftAt: Date; verified: boolean }>
  >`
    SELECT state, accepted_at AS "acceptedAt",
      left_at AS "leftAt", verified_participation AS verified
    FROM current_job_participants WHERE id = ${renewed.participantId}
  `;
  expect(removed).toMatchObject({ state: "REMOVED", verified: true });
  expect(removed?.acceptedAt).toBeInstanceOf(Date);
  expect(removed?.leftAt).toBeInstanceOf(Date);

  const next = await service.invite({ ...invite, commandId: randomUUID() });
  expect(next.status).toBe("APPLIED");
  if (!("participantId" in next))
    throw new Error("Third invitation identity missing.");
  expect(
    await service.decide({
      actorUserId: fixture.providerUserId,
      commandId: randomUUID(),
      participantId: next.participantId,
      decision: "ACCEPT",
    }),
  ).toMatchObject({ status: "APPLIED", state: "ACCEPTED" });
  const leaveCommandId = randomUUID();
  const leave = {
    actorUserId: fixture.providerUserId,
    commandId: leaveCommandId,
    participantId: next.participantId,
    decision: "LEAVE" as const,
    reason: "Účasť som ukončil po práci",
  };
  expect(await service.decide(leave)).toMatchObject({
    status: "APPLIED",
    state: "LEFT",
  });
  expect(await service.decide(leave)).toMatchObject({
    status: "DEDUPLICATED",
    state: "LEFT",
  });
  const leftNotices = await sql<
    Array<{ eventName: string; payload: Record<string, unknown> }>
  >`
    SELECT event_name AS "eventName", payload
    FROM domain_outbox_events
    WHERE entity_type = 'JOB_PARTICIPANT'
      AND entity_id = ${next.participantId}
      AND idempotency_key LIKE ${`%:event:${leaveCommandId}:%`}
    ORDER BY event_name
  `;
  expect(leftNotices.map((event) => event.eventName)).toEqual([
    "job_participant.departed",
    "job_participant.left",
  ]);
  expect(
    leftNotices.map((event) => event.payload["recipient_user_id"]),
  ).toEqual([fixture.customerUserId, fixture.providerUserId]);
  expect(JSON.stringify(leftNotices)).not.toContain(leave.reason);
  expect(
    await service.invite({ ...invite, commandId: randomUUID() }),
  ).toMatchObject({ status: "APPLIED" });
  const ownHistory = await service.listOwnHistory({
    actorUserId: fixture.providerUserId,
    limit: 20,
  });
  expect(ownHistory.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        participantId: fixture.participantId,
        state: "DECLINED",
        acceptedAt: null,
        leftAt: null,
      }),
    ]),
  );
  const removedHistory = ownHistory.items.find(
    (item) => item.participantId === renewed.participantId,
  );
  expect(removedHistory?.state).toBe("REMOVED");
  expect(removedHistory?.acceptedAt).toBeInstanceOf(Date);
  expect(removedHistory?.leftAt).toBeInstanceOf(Date);
  const leftHistory = ownHistory.items.find(
    (item) => item.participantId === next.participantId,
  );
  expect(leftHistory?.state).toBe("LEFT");
  expect(leftHistory?.acceptedAt).toBeInstanceOf(Date);
  expect(leftHistory?.leftAt).toBeInstanceOf(Date);
  expect(ownHistory.items.every((item) => item.jobId === fixture.jobId)).toBe(
    true,
  );
  expect(
    (
      await service.listOwnHistory({
        actorUserId: fixture.customerUserId,
        limit: 20,
      })
    ).items.some((item) => item.jobId === fixture.jobId),
  ).toBe(false);
  expect(
    (
      await service.listOwnHistory({
        actorUserId: fixture.providerUserId,
        limit: 1,
      })
    ).nextCursor,
  ).not.toBeNull();
  const timeline = await sql<Array<{ eventType: string }>>`
    SELECT event_type AS "eventType"
    FROM job_chronological_system_events
    WHERE job_id = ${fixture.jobId}
      AND event_type LIKE 'PARTICIPANT_%'
    ORDER BY occurred_at, event_order, event_id
  `;
  expect(
    timeline.filter((event) => event.eventType === "PARTICIPANT_JOINED"),
  ).toHaveLength(3);
  expect(
    timeline.filter((event) => event.eventType === "PARTICIPANT_LEFT"),
  ).toHaveLength(2);
  expect(
    timeline.filter((event) => event.eventType === "PARTICIPANT_REMOVED"),
  ).toHaveLength(1);
  expect(
    timeline.every((event) => event.eventType !== "PARTICIPANT_DECLINED"),
  ).toBe(true);
}
