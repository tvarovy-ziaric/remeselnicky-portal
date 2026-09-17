import { randomUUID } from "node:crypto";

import type { Sql } from "postgres";
import { expect } from "vitest";

import {
  createJobMilestoneRepository,
  JobMilestoneIdempotencyError,
} from "../src/job-milestone-repository.js";

interface Fixture {
  readonly id: string;
  readonly customerUserId: string;
  readonly providerUserId: string;
  readonly quoteId: string;
  readonly quoteRevision: number;
}

/** Call before the shared Job fixture is cancelled. */
export async function runJobMilestoneIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const [job] = await sql<Fixture[]>`
    SELECT job.id, customer.owner_user_id AS "customerUserId",
      provider.owner_user_id AS "providerUserId", job.accepted_quote_id AS "quoteId",
      job.accepted_quote_revision AS "quoteRevision"
    FROM jobs job
    JOIN customer_profiles customer ON customer.id = job.customer_profile_id
    JOIN craftsman_profiles provider ON provider.id = job.primary_craftsman_profile_id
    JOIN current_job_states state ON state.job_id = job.id
    WHERE state.state = 'CONFIRMED' ORDER BY job.accepted_at DESC LIMIT 1
  `;
  if (!job) throw new Error("Confirmed milestone Job fixture missing.");
  const repository = createJobMilestoneRepository(sql);
  const [unknownPlanner] = await sql<Array<{ allowed: boolean }>>`
    SELECT job_milestone_can_plan(${job.id}::uuid, ${randomUUID()}::uuid) AS allowed
  `;
  expect(unknownPlanner?.allowed).toBe(false);
  const milestoneId = randomUUID();
  const create = {
    actorUserId: job.providerUserId,
    commandId: milestoneId,
    jobId: job.id,
    title: "Príprava podkladu",
    description: "Organizačná etapa realizácie.",
    plannedStartOn: "2026-09-18",
    plannedEndOn: "2026-09-19",
  };
  expect(
    await repository.createMilestone({
      ...create,
      commandId: randomUUID(),
      responsibility: { kind: "PARTICIPANT", id: randomUUID() },
    }),
  ).toEqual({ status: "NOT_FOUND" });
  expect(
    await repository.createMilestone({
      ...create,
      actorUserId: job.customerUserId,
    }),
  ).toEqual({ status: "NOT_FOUND" });
  expect(await repository.createMilestone(create)).toMatchObject({
    status: "APPLIED",
    id: milestoneId,
  });
  expect(await repository.createMilestone(create)).toMatchObject({
    status: "DEDUPLICATED",
    id: milestoneId,
  });
  await expect(
    repository.createMilestone({ ...create, title: "Iný názov" }),
  ).rejects.toBeInstanceOf(JobMilestoneIdempotencyError);
  expect(
    await repository.listMilestones({
      actorUserId: randomUUID(),
      jobId: job.id,
      limit: 20,
    }),
  ).toBeNull();
  expect(
    await repository.getMilestone({
      actorUserId: job.customerUserId,
      jobId: randomUUID(),
      milestoneId,
    }),
  ).toBeNull();
  const initial = await repository.getMilestone({
    actorUserId: job.customerUserId,
    jobId: job.id,
    milestoneId,
  });
  expect(initial).toMatchObject({
    title: create.title,
    state: "PLANNED",
    originalPlannedStartOn: create.plannedStartOn,
    currentPlannedStartOn: create.plannedStartOn,
    sourceQuoteId: null,
    acknowledgedAt: null,
  });
  expect(initial?.capabilities.canEdit).toBe(false);
  const edit = {
    actorUserId: job.providerUserId,
    commandId: randomUUID(),
    jobId: job.id,
    milestoneId,
    title: "Príprava a úprava podkladu",
    description: null,
    plannedStartOn: "2026-09-20",
    plannedEndOn: "2026-09-21",
  };
  expect(await repository.editMilestone(edit)).toMatchObject({
    status: "APPLIED",
  });
  expect(
    await repository.assignMilestone({
      actorUserId: job.providerUserId,
      commandId: randomUUID(),
      jobId: job.id,
      milestoneId,
      responsibility: { kind: "WORK_GROUP", id: randomUUID() },
    }),
  ).toEqual({ status: "NOT_FOUND" });
  expect(await repository.editMilestone(edit)).toMatchObject({
    status: "DEDUPLICATED",
  });
  const changed = await repository.getMilestone({
    actorUserId: job.customerUserId,
    jobId: job.id,
    milestoneId,
  });
  expect(changed).toMatchObject({
    originalPlannedStartOn: "2026-09-18",
    currentPlannedStartOn: "2026-09-20",
  });
  const ack = {
    actorUserId: job.customerUserId,
    commandId: randomUUID(),
    jobId: job.id,
    milestoneId,
  };
  expect(
    await repository.acknowledgeMilestone({
      ...ack,
      actorUserId: job.providerUserId,
    }),
  ).toEqual({ status: "NOT_FOUND" });
  expect(await repository.acknowledgeMilestone(ack)).toMatchObject({
    status: "APPLIED",
  });
  expect(await repository.acknowledgeMilestone(ack)).toMatchObject({
    status: "DEDUPLICATED",
  });
  expect(
    await repository.acknowledgeMilestone({ ...ack, commandId: randomUUID() }),
  ).toEqual({ status: "STALE_STATE" });
  const state = {
    actorUserId: job.providerUserId,
    commandId: randomUUID(),
    jobId: job.id,
    milestoneId,
    state: "DONE" as const,
  };
  expect(
    await repository.setMilestoneState({
      ...state,
      actorUserId: job.customerUserId,
    }),
  ).toEqual({ status: "NOT_FOUND" });
  expect(await repository.setMilestoneState(state)).toMatchObject({
    status: "APPLIED",
  });
  expect(await repository.setMilestoneState(state)).toMatchObject({
    status: "DEDUPLICATED",
  });
  expect(
    await repository.setMilestoneState({
      ...state,
      commandId: randomUUID(),
      state: "PLANNED",
    }),
  ).toEqual({ status: "STALE_STATE" });
  expect(
    (
      await repository.getMilestone({
        actorUserId: job.providerUserId,
        jobId: job.id,
        milestoneId,
      })
    )?.state,
  ).toBe("DONE");
  const history = await repository.listMilestoneHistory({
    actorUserId: job.customerUserId,
    jobId: job.id,
    milestoneId,
    limit: 20,
  });
  expect(history?.map((event) => event.kind)).toEqual([
    "STATE",
    "EDIT",
    "CREATE",
  ]);
  expect(
    await repository.listMilestoneHistory({
      actorUserId: randomUUID(),
      jobId: job.id,
      milestoneId,
      limit: 20,
    }),
  ).toBeNull();
  await expect(
    sql`UPDATE job_milestone_events SET title = 'Prepísané' WHERE event_id = ${milestoneId}`,
  ).rejects.toThrow();
  await expect(
    sql`DELETE FROM job_milestones WHERE id = ${milestoneId}`,
  ).rejects.toThrow();
  await expect(sql`INSERT INTO job_milestones (id, job_id, created_by_user_id)
    VALUES (${randomUUID()}, ${job.id}, ${job.providerUserId})`).rejects.toThrow();
  await expect(sql`INSERT INTO job_milestone_events
    (event_id, milestone_id, event_sequence, kind, actor_user_id, intent, title, state, order_key)
    VALUES (${randomUUID()}, ${milestoneId}, 100, 'STATE', ${job.customerUserId}, '{"kind":"STATE"}'::jsonb,
      'Podvrhnutý stav', 'DONE', 1)`).rejects.toThrow();
  const [outsider] = await sql<Array<{ id: string }>>`
    SELECT actor.id FROM users actor
    JOIN auth_credentials credentials ON credentials.user_id = actor.id
    WHERE actor.id NOT IN (${job.customerUserId}, ${job.providerUserId})
      AND actor.account_state = 'ACTIVE'
      AND credentials.email_verified_at IS NOT NULL
      AND credentials.phone_verified_at IS NOT NULL
      AND job_milestone_actor_role(${job.id}::uuid, actor.id) IS NULL
    LIMIT 1
  `;
  if (outsider) {
    await expect(sql`INSERT INTO job_milestones (id, job_id, created_by_user_id)
      VALUES (${randomUUID()}, ${job.id}, ${outsider.id})`).rejects.toThrow();
    await expect(sql`INSERT INTO job_milestone_acknowledgements
      (id, milestone_id, customer_user_id)
      VALUES (${randomUUID()}, ${milestoneId}, ${outsider.id})`).rejects.toThrow();
  }
  const stageId = randomUUID();
  const stageInput = {
    ...create,
    commandId: stageId,
    title: "Etapa z prijatej ponuky",
    acceptedStageLabel: "Etapa uvedená v prijatej ponuke",
  };
  const concurrent = await Promise.all([
    repository.createMilestone(stageInput),
    repository.createMilestone(stageInput),
  ]);
  expect(concurrent.map((result) => result.status).sort()).toEqual([
    "APPLIED",
    "DEDUPLICATED",
  ]);
  expect(
    await repository.getMilestone({
      actorUserId: job.customerUserId,
      jobId: job.id,
      milestoneId: stageId,
    }),
  ).toMatchObject({
    sourceQuoteId: job.quoteId,
    sourceQuoteRevision: job.quoteRevision,
  });
  const secondId = randomUUID();
  expect(
    await repository.createMilestone({
      ...create,
      commandId: secondId,
      title: "Kontrola",
    }),
  ).toMatchObject({ status: "APPLIED" });
  expect(
    await repository.reorderMilestone({
      actorUserId: job.providerUserId,
      commandId: randomUUID(),
      jobId: job.id,
      milestoneId: secondId,
      afterMilestoneId: null,
    }),
  ).toMatchObject({ status: "APPLIED" });
  const page = await repository.listMilestones({
    actorUserId: job.customerUserId,
    jobId: job.id,
    limit: 1,
  });
  expect(page?.items[0]?.id).toBe(secondId);
  expect(page?.nextCursor?.afterOrder).toBe(0);
  if (!page?.nextCursor) throw new Error("Milestone cursor missing.");
  expect(
    (
      await repository.listMilestones({
        actorUserId: job.customerUserId,
        jobId: job.id,
        limit: 20,
        cursor: page.nextCursor,
      })
    )?.items.length,
  ).toBeGreaterThanOrEqual(2);
  const [snapshot] = await sql<
    Array<{ state: string }>
  >`SELECT state FROM current_job_states WHERE job_id = ${job.id}`;
  expect(snapshot?.state).toBe("CONFIRMED");
}
