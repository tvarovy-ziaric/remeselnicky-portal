import { randomUUID } from "node:crypto";

import type { Sql } from "postgres";
import { expect } from "vitest";

import {
  createJobMilestoneContextRepository,
  JobMilestoneContextIdempotencyError,
} from "../src/job-milestone-context-repository.js";
import { createJobMilestoneRepository } from "../src/job-milestone-repository.js";
import {
  makeMessage,
  makeReadyMedia,
} from "./job-operational-media-integration-helper.js";

interface Fixture {
  readonly jobId: string;
  readonly conversationId: string;
  readonly customerUserId: string;
  readonly providerUserId: string;
}

/** Run while the shared Job fixture is still CONFIRMED. */
export async function runJobMilestoneContextIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const [job] = await sql<Fixture[]>`
    SELECT job.id AS "jobId", job.winning_conversation_id AS "conversationId",
      customer.owner_user_id AS "customerUserId",
      provider.owner_user_id AS "providerUserId"
    FROM jobs job
    JOIN customer_profiles customer ON customer.id = job.customer_profile_id
    JOIN craftsman_profiles provider ON provider.id = job.primary_craftsman_profile_id
    JOIN current_job_states state ON state.job_id = job.id
    WHERE state.state = 'CONFIRMED'
    ORDER BY job.accepted_at DESC, job.id DESC LIMIT 1
  `;
  if (!job) throw new Error("Confirmed milestone context Job fixture missing.");
  const repository = createJobMilestoneContextRepository(sql);
  const plan = createJobMilestoneRepository(sql);
  const proposalId = randomUUID();
  const propose = {
    actorUserId: job.customerUserId,
    commandId: proposalId,
    jobId: job.jobId,
    title: "Kontrola dokončenej etapy",
    description: "Organizačný návrh zákazníka.",
    plannedStartOn: "2026-10-01",
    plannedEndOn: "2026-10-02",
  };
  expect(
    await repository.createProposal({
      ...propose,
      actorUserId: job.providerUserId,
    }),
  ).toEqual({ status: "NOT_FOUND" });
  expect(await repository.createProposal(propose)).toMatchObject({
    status: "APPLIED",
    id: proposalId,
  });
  expect(await repository.createProposal(propose)).toMatchObject({
    status: "DEDUPLICATED",
    id: proposalId,
  });
  await expect(
    repository.createProposal({ ...propose, title: "Odlišný návrh" }),
  ).rejects.toBeInstanceOf(JobMilestoneContextIdempotencyError);
  expect(
    await repository.listProposals({
      actorUserId: randomUUID(),
      jobId: job.jobId,
      limit: 20,
    }),
  ).toBeNull();
  expect(
    (
      await repository.getProposal({
        actorUserId: job.providerUserId,
        jobId: job.jobId,
        proposalId,
      })
    )?.canDecide,
  ).toBe(true);
  expect(
    await repository.decideProposal({
      actorUserId: job.customerUserId,
      commandId: randomUUID(),
      jobId: job.jobId,
      proposalId,
      decision: "ACCEPT",
    }),
  ).toEqual({ status: "NOT_FOUND" });
  const decision = {
    actorUserId: job.providerUserId,
    commandId: randomUUID(),
    jobId: job.jobId,
    proposalId,
    decision: "ACCEPT" as const,
  };
  const accepted = await repository.decideProposal(decision);
  expect(accepted).toMatchObject({ status: "APPLIED", id: decision.commandId });
  if (accepted.status !== "APPLIED" || !accepted.appliedMilestoneId)
    throw new Error("Accepted proposal did not create a milestone.");
  const resulting = await plan.getMilestone({
    actorUserId: job.customerUserId,
    jobId: job.jobId,
    milestoneId: accepted.appliedMilestoneId,
  });
  expect(resulting).toMatchObject({
    title: propose.title,
    acceptedStageLabel: null,
    currentPlannedStartOn: propose.plannedStartOn,
  });
  expect(await repository.decideProposal(decision)).toMatchObject({
    status: "DEDUPLICATED",
    appliedMilestoneId: accepted.appliedMilestoneId,
  });
  expect(
    await repository.decideProposal({ ...decision, commandId: randomUUID() }),
  ).toEqual({ status: "STALE_STATE" });
  expect(
    (
      await repository.getProposal({
        actorUserId: job.customerUserId,
        jobId: job.jobId,
        proposalId,
      })
    )?.decision,
  ).toBe("ACCEPT");
  const [decisionEvent] = await sql<Array<{ sameTransaction: boolean }>>`
    SELECT plan.creation_txid = decision_row.creation_txid AS "sameTransaction"
    FROM job_milestone_proposal_decisions decision_row
    JOIN job_milestone_events plan ON plan.event_id = decision_row.applied_event_id
    WHERE decision_row.id = ${decision.commandId}
  `;
  expect(decisionEvent?.sameTransaction).toBe(true);

  const targetId = randomUUID();
  expect(
    await plan.createMilestone({
      actorUserId: job.providerUserId,
      commandId: targetId,
      jobId: job.jobId,
      title: "Pôvodný plán",
    }),
  ).toMatchObject({ status: "APPLIED" });
  const staleProposalId = randomUUID();
  expect(
    await repository.createProposal({
      ...propose,
      commandId: staleProposalId,
      targetMilestoneId: targetId,
      title: "Návrh po zmene",
    }),
  ).toMatchObject({ status: "APPLIED" });
  expect(
    await plan.editMilestone({
      actorUserId: job.providerUserId,
      commandId: randomUUID(),
      jobId: job.jobId,
      milestoneId: targetId,
      title: "Medzitým zmenený plán",
      description: null,
      plannedStartOn: null,
      plannedEndOn: null,
    }),
  ).toMatchObject({ status: "APPLIED" });
  expect(
    await repository.decideProposal({
      ...decision,
      commandId: randomUUID(),
      proposalId: staleProposalId,
    }),
  ).toEqual({ status: "STALE_STATE" });
  const changeProposalId = randomUUID();
  expect(
    await repository.createProposal({
      ...propose,
      commandId: changeProposalId,
      targetMilestoneId: targetId,
      title: "Výslovne prijatý návrh",
    }),
  ).toMatchObject({ status: "APPLIED" });
  const acceptedChange = await repository.decideProposal({
    ...decision,
    commandId: randomUUID(),
    proposalId: changeProposalId,
  });
  expect(acceptedChange).toMatchObject({
    status: "APPLIED",
    appliedMilestoneId: targetId,
  });
  expect(
    (
      await plan.getMilestone({
        actorUserId: job.customerUserId,
        jobId: job.jobId,
        milestoneId: targetId,
      })
    )?.title,
  ).toBe("Výslovne prijatý návrh");
  const declineProposalId = randomUUID();
  expect(
    await repository.createProposal({
      ...propose,
      commandId: declineProposalId,
      title: "Neprijatý návrh",
    }),
  ).toMatchObject({ status: "APPLIED" });
  expect(
    await repository.decideProposal({
      ...decision,
      commandId: randomUUID(),
      proposalId: declineProposalId,
      decision: "DECLINE",
    }),
  ).toMatchObject({ status: "APPLIED", appliedMilestoneId: null });
  const comment = {
    actorUserId: job.customerUserId,
    commandId: randomUUID(),
    jobId: job.jobId,
    milestoneId: targetId,
    body: "Nesúhlasím s termínom, prosím o vysvetlenie.",
  };
  expect(await repository.addComment(comment)).toMatchObject({
    status: "APPLIED",
  });
  expect(await repository.addComment(comment)).toMatchObject({
    status: "DEDUPLICATED",
  });
  expect(
    (
      await repository.listComments({
        actorUserId: job.providerUserId,
        jobId: job.jobId,
        milestoneId: targetId,
        limit: 20,
      })
    )?.items[0],
  ).toMatchObject({
    id: comment.commandId,
    authorRole: "CUSTOMER",
    body: comment.body,
  });
  expect(
    await repository.addComment({
      ...comment,
      commandId: randomUUID(),
      milestoneId: randomUUID(),
    }),
  ).toEqual({ status: "NOT_FOUND" });
  await expect(sql`UPDATE job_milestone_comments SET body = 'Prepísané'
    WHERE id = ${comment.commandId}`).rejects.toThrow();
  await expect(
    sql`DELETE FROM job_milestone_proposals WHERE id = ${proposalId}`,
  ).rejects.toThrow();
  await expect(sql`INSERT INTO job_milestone_proposal_decisions
    (id, proposal_id, actor_user_id, decision, applied_event_id)
    VALUES (${randomUUID()}, ${staleProposalId}, ${job.providerUserId}, 'ACCEPT',
      ${targetId})`).rejects.toThrow();

  const message = await sql.begin(async (tx) => makeMessage(tx, job));
  const photoId = await sql.begin(async (tx) =>
    makeReadyMedia(
      tx,
      job.providerUserId,
      message.id,
      message.sequence,
      "IMAGE",
    ),
  );
  const pdfId = await sql.begin(async (tx) =>
    makeReadyMedia(
      tx,
      job.providerUserId,
      message.id,
      message.sequence,
      "DOCUMENT",
    ),
  );
  const link = {
    actorUserId: job.providerUserId,
    commandId: randomUUID(),
    jobId: job.jobId,
    milestoneId: targetId,
    mediaAssetId: photoId,
  };
  expect(await repository.linkMedia(link)).toMatchObject({ status: "APPLIED" });
  expect(await repository.linkMedia(link)).toMatchObject({
    status: "DEDUPLICATED",
  });
  expect(
    await repository.linkMedia({ ...link, commandId: randomUUID() }),
  ).toEqual({ status: "STALE_STATE" });
  expect(
    await repository.linkMedia({
      ...link,
      commandId: randomUUID(),
      mediaAssetId: randomUUID(),
    }),
  ).toEqual({ status: "NOT_FOUND" });
  expect(
    await repository.linkMedia({
      ...link,
      commandId: randomUUID(),
      actorUserId: job.customerUserId,
      mediaAssetId: pdfId,
    }),
  ).toMatchObject({ status: "APPLIED" });
  const media = await repository.listMedia({
    actorUserId: job.customerUserId,
    jobId: job.jobId,
    milestoneId: targetId,
    limit: 20,
  });
  expect(media?.items.map((item) => item.mediaAssetId).sort()).toEqual(
    [photoId, pdfId].sort(),
  );
  expect(media?.items.map((item) => item.kind).sort()).toEqual([
    "DOCUMENT",
    "PHOTO",
  ]);
  expect(
    await repository.listMedia({
      actorUserId: randomUUID(),
      jobId: job.jobId,
      milestoneId: targetId,
      limit: 20,
    }),
  ).toBeNull();
  const [outsider] = await sql<Array<{ id: string }>>`
    SELECT actor.id FROM users actor
    JOIN auth_credentials credentials ON credentials.user_id = actor.id
    WHERE actor.id NOT IN (${job.customerUserId}, ${job.providerUserId})
      AND actor.account_state = 'ACTIVE'
      AND credentials.email_verified_at IS NOT NULL
      AND credentials.phone_verified_at IS NOT NULL
      AND job_milestone_actor_role(${job.jobId}::uuid, actor.id) IS NULL
    LIMIT 1
  `;
  if (outsider) {
    await expect(sql`INSERT INTO job_milestone_proposals
      (id, job_id, customer_user_id, title)
      VALUES (${randomUUID()}, ${job.jobId}, ${outsider.id}, 'Nepovolený návrh')`).rejects.toThrow();
    await expect(sql`INSERT INTO job_milestone_comments
      (id, milestone_id, author_user_id, author_role, body)
      VALUES (${randomUUID()}, ${targetId}, ${outsider.id}, 'CUSTOMER',
        'Nepovolený komentár')`).rejects.toThrow();
    await expect(sql`INSERT INTO job_milestone_media
      (id, milestone_id, media_asset_id, linked_by_user_id)
      VALUES (${randomUUID()}, ${targetId}, ${photoId}, ${outsider.id})`).rejects.toThrow();
  }
  await expect(sql`UPDATE job_milestone_media SET media_asset_id = ${randomUUID()}
    WHERE id = ${link.commandId}`).rejects.toThrow();
  const [jobState] = await sql<Array<{ state: string }>>`
    SELECT state::text AS state FROM current_job_states WHERE job_id = ${job.jobId}
  `;
  expect(jobState?.state).toBe("CONFIRMED");
}
