import type { Sql } from "postgres";
import { expect } from "vitest";

import { createJobRosterRepository } from "../src/job-roster-repository.js";

interface RosterJob {
  readonly id: string;
  readonly customerUserId: string;
  readonly providerUserId: string;
}

async function rosterJob(sql: Sql): Promise<RosterJob> {
  const [job] = await sql<RosterJob[]>`
    SELECT job.id,
      customer.owner_user_id AS "customerUserId",
      provider.owner_user_id AS "providerUserId"
    FROM jobs job
    JOIN customer_profiles customer ON customer.id = job.customer_profile_id
    JOIN craftsman_profiles provider
      ON provider.id = job.primary_craftsman_profile_id
    JOIN job_participants participant ON participant.job_id = job.id
    ORDER BY job.accepted_at DESC, job.id DESC LIMIT 1
  `;
  if (job === undefined) throw new Error("Job roster fixture missing.");
  return job;
}

export async function runJobRosterReadIntegrationAssertions(sql: Sql) {
  const job = await rosterJob(sql);
  const roster = createJobRosterRepository(sql);
  const customer = await roster.listForPrimaryParty({
    actorUserId: job.customerUserId,
    jobId: job.id,
    limit: 20,
  });
  expect(customer?.role).toBe("CUSTOMER");
  expect(customer?.participants).toHaveLength(1);
  expect(customer?.participants[0]?.state).toBe("LEFT");
  expect(customer?.participants[0]?.acceptedAt).toBeInstanceOf(Date);
  expect(customer?.participants[0]?.leftAt).toBeInstanceOf(Date);
  expect(
    customer?.participants[0]?.roles.map((role) => role.role).sort(),
  ).toEqual(["COORDINATOR", "LEAD", "MEMBER"]);
  expect(customer?.participants[0]?.roles.every((role) => !role.active)).toBe(
    true,
  );
  expect(customer?.participants[0]?.workGroups).toHaveLength(4);
  expect(
    customer?.participants[0]?.workGroups.every((group) => !group.active),
  ).toBe(true);
  expect(
    customer?.participants[0]?.workGroups.filter(
      (group) => group.crewName === "Skúšobná pracovná čata",
    ),
  ).toHaveLength(2);
  expect(
    customer?.participants[0]?.workGroups.filter(
      (group) => group.crewName === null,
    ),
  ).toHaveLength(2);

  const provider = await roster.listForPrimaryParty({
    actorUserId: job.providerUserId,
    jobId: job.id,
    limit: 1,
  });
  expect(provider?.role).toBe("PRIMARY_PROVIDER");
  expect(provider?.participants).toHaveLength(1);
  expect(provider?.participants[0]?.state).toBe("INVITED");
  expect(provider?.participants[0]?.roles).toEqual([]);
  expect(provider?.participants[0]?.workGroups).toEqual([]);
  expect(provider?.nextCursor).not.toBeNull();
  const next = await roster.listForPrimaryParty({
    actorUserId: job.providerUserId,
    jobId: job.id,
    cursor: provider!.nextCursor!,
    limit: 1,
  });
  expect(next?.participants.map((participant) => participant.state)).toEqual([
    "LEFT",
  ]);
  expect(next?.nextCursor).toBeNull();

  const [unrelated] = await sql<Array<{ id: string }>>`
    SELECT id FROM users WHERE account_state = 'ACTIVE'
      AND id <> ${job.customerUserId} AND id <> ${job.providerUserId}
    ORDER BY id LIMIT 1
  `;
  if (unrelated === undefined)
    throw new Error("Unrelated active user fixture missing.");
  await expect(
    roster.listForPrimaryParty({
      actorUserId: unrelated.id,
      jobId: job.id,
      limit: 20,
    }),
  ).resolves.toBeNull();
  await expect(
    roster.listForPrimaryParty({
      actorUserId: job.customerUserId,
      jobId: "86200000-0000-4000-8000-000000000099",
      limit: 20,
    }),
  ).resolves.toBeNull();
}

export async function runJobRosterCancelledReadIntegrationAssertions(sql: Sql) {
  const job = await rosterJob(sql);
  const [state] = await sql<Array<{ state: string }>>`
    SELECT state::text FROM current_job_states WHERE job_id = ${job.id}
  `;
  expect(state?.state).toBe("CANCELLED");
  const customer = await createJobRosterRepository(sql).listForPrimaryParty({
    actorUserId: job.customerUserId,
    jobId: job.id,
    limit: 20,
  });
  expect(customer?.participants[0]?.state).toBe("LEFT");
  expect(customer?.participants[0]?.roles.every((role) => !role.active)).toBe(
    true,
  );
  expect(
    customer?.participants[0]?.workGroups.every((group) => !group.active),
  ).toBe(true);
}
