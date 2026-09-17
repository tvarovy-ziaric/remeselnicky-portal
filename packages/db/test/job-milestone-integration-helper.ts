import { randomUUID } from "node:crypto";

import type { Sql } from "postgres";
import { expect } from "vitest";

import {
  createJobMilestoneRepository,
  JobMilestoneIdempotencyError,
} from "../src/job-milestone-repository.js";
import { createChangeOrderRepository } from "../src/change-order-repository.js";

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
  await assertChangeOrderProvenance(sql, job, stageId, secondId);
}

async function assertChangeOrderProvenance(
  sql: Sql,
  job: Fixture,
  stageId: string,
  unrelatedMilestoneId: string,
): Promise<void> {
  const milestones = createJobMilestoneRepository(sql);
  const changes = createChangeOrderRepository(sql);
  const changeOrderId = randomUUID();
  const revisionId = randomUUID();
  const terms = {
    title: "Schválená zmena etapy",
    reason: "Spresnený postup po obhliadke",
    changeDescription: "Etapa potrebuje iný harmonogram.",
    scopeAdded: [] as string[],
    scopeRemoved: [] as string[],
    scopeChanged: ["Spresnený pracovný postup"],
    priceImpact: { mode: "NONE" as const },
    scheduleImpact: { mode: "DAYS" as const, deltaDays: 2 },
    affectedMilestoneIds: [stageId],
  };
  expect(
    await changes.createDraft({
      actorUserId: job.customerUserId,
      commandId: changeOrderId,
      revisionId,
      jobId: job.id,
      terms,
    }),
  ).toMatchObject({ status: "APPLIED", state: "DRAFT" });
  const createLinked = {
    actorUserId: job.providerUserId,
    commandId: randomUUID(),
    jobId: job.id,
    title: "Nová vykonávacia etapa",
    sourceChangeOrderRevisionId: revisionId,
  };
  expect(await milestones.createMilestone(createLinked)).toEqual({
    status: "NOT_FOUND",
  });
  const stage = await milestones.getMilestone({
    actorUserId: job.providerUserId,
    jobId: job.id,
    milestoneId: stageId,
  });
  if (!stage) throw new Error("Milestone provenance fixture missing.");
  const edit = {
    actorUserId: job.providerUserId,
    commandId: randomUUID(),
    jobId: job.id,
    milestoneId: stageId,
    title: `${stage.title} – aktualizácia`,
    description: stage.description,
    plannedStartOn: stage.currentPlannedStartOn,
    plannedEndOn: stage.currentPlannedEndOn,
    sourceChangeOrderRevisionId: revisionId,
  };
  expect(await milestones.editMilestone(edit)).toEqual({ status: "NOT_FOUND" });
  expect(
    await changes.submitRevision({
      actorUserId: job.customerUserId,
      commandId: randomUUID(),
      jobId: job.id,
      changeOrderId,
      revisionId,
      revisionNumber: 1,
    }),
  ).toMatchObject({ status: "APPLIED", state: "PROPOSED" });
  expect(
    await changes.approveRevision({
      actorUserId: job.providerUserId,
      commandId: randomUUID(),
      jobId: job.id,
      changeOrderId,
      revisionId,
      revisionNumber: 1,
    }),
  ).toMatchObject({ status: "APPLIED", state: "APPROVED" });
  expect(await milestones.editMilestone(edit)).toMatchObject({
    status: "APPLIED",
  });
  expect(await milestones.editMilestone(edit)).toMatchObject({
    status: "DEDUPLICATED",
  });
  expect(
    await milestones.getMilestone({
      actorUserId: job.customerUserId,
      jobId: job.id,
      milestoneId: stageId,
    }),
  ).toMatchObject({
    sourceQuoteId: job.quoteId,
    sourceQuoteRevision: job.quoteRevision,
    sourceChangeOrderRevisionId: revisionId,
  });
  const unrelated = await milestones.getMilestone({
    actorUserId: job.providerUserId,
    jobId: job.id,
    milestoneId: unrelatedMilestoneId,
  });
  if (!unrelated) throw new Error("Unrelated milestone fixture missing.");
  expect(
    await milestones.editMilestone({
      actorUserId: job.providerUserId,
      commandId: randomUUID(),
      jobId: job.id,
      milestoneId: unrelatedMilestoneId,
      title: unrelated.title,
      description: unrelated.description,
      plannedStartOn: unrelated.currentPlannedStartOn,
      plannedEndOn: unrelated.currentPlannedEndOn,
      sourceChangeOrderRevisionId: revisionId,
    }),
  ).toEqual({ status: "NOT_FOUND" });
  expect(await milestones.createMilestone(createLinked)).toMatchObject({
    status: "APPLIED",
    id: createLinked.commandId,
  });
  expect(
    await milestones.getMilestone({
      actorUserId: job.customerUserId,
      jobId: job.id,
      milestoneId: createLinked.commandId,
    }),
  ).toMatchObject({
    sourceQuoteId: null,
    sourceChangeOrderRevisionId: revisionId,
  });
  expect(
    (
      await milestones.listMilestoneHistory({
        actorUserId: job.customerUserId,
        jobId: job.id,
        milestoneId: stageId,
        limit: 20,
      })
    )?.map((event) => event.sourceChangeOrderRevisionId),
  ).toEqual([revisionId, null]);
  await expect(sql`
    UPDATE job_milestone_events SET source_change_order_revision_id = NULL
    WHERE event_id = ${edit.commandId}
  `).rejects.toThrow(/immutable/);
  await expect(sql`
    INSERT INTO job_milestone_events
      (event_id, milestone_id, event_sequence, kind, actor_user_id, intent,
       title, description, planned_start_date, planned_end_date, state, order_key,
       accepted_stage_label, accepted_quote_id, accepted_quote_revision,
       accepted_pdf_media_asset_id, source_change_order_revision_id)
    SELECT ${randomUUID()}, current.id, current.event_sequence + 1, 'EDIT',
      ${job.providerUserId}, '{"kind":"EDIT"}'::jsonb,
      current.title, current.description, current.planned_start_date,
      current.planned_end_date, current.state, current.order_key,
      current.accepted_stage_label, current.accepted_quote_id,
      current.accepted_quote_revision, current.accepted_pdf_media_asset_id,
      ${revisionId}::uuid
    FROM current_job_milestones current WHERE current.id = ${unrelatedMilestoneId}
  `).rejects.toThrow(/did not identify edited milestone/);
}
