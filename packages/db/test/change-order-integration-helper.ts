import { randomUUID } from "node:crypto";

import type { Sql } from "postgres";
import { expect } from "vitest";

import {
  createChangeOrderRepository,
  ChangeOrderIdempotencyError,
  type ChangeOrderTerms,
} from "../src/change-order-repository.js";
import { createJobDashboardRepository } from "../src/job-dashboard-repository.js";

const terms: ChangeOrderTerms = {
  title: "Zmena rozsahu prác",
  reason: "Dodatočný rozsah po obhliadke",
  changeDescription: "Pribudne oprava podkladu a termín sa posunie.",
  scopeAdded: ["Oprava podkladu"],
  scopeRemoved: [],
  scopeChanged: [],
  priceImpact: {
    mode: "FIXED_DELTA",
    amountCents: 12_000,
    vatStatus: "VAT_INCLUDED",
  },
  scheduleImpact: { mode: "DAYS", deltaDays: 2 },
};

/** Run while the shared accepted Job fixture is still CONFIRMED. */
export async function runChangeOrderIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const [job] = await sql<
    Array<{
      jobId: string;
      customerUserId: string;
      providerUserId: string;
      acceptedQuoteId: string;
      acceptedQuoteRevision: number;
    }>
  >`
    SELECT job.id AS "jobId", customer.owner_user_id AS "customerUserId",
      provider.owner_user_id AS "providerUserId",
      job.accepted_quote_id AS "acceptedQuoteId",
      job.accepted_quote_revision AS "acceptedQuoteRevision"
    FROM jobs job
    JOIN customer_profiles customer ON customer.id = job.customer_profile_id
    JOIN craftsman_profiles provider ON provider.id = job.primary_craftsman_profile_id
    JOIN current_job_states state ON state.job_id = job.id
    WHERE state.state = 'CONFIRMED'
    ORDER BY job.accepted_at DESC, job.id DESC LIMIT 1`;
  if (!job) throw new Error("Confirmed Change-order Job fixture missing.");
  const repository = createChangeOrderRepository(sql);
  const changeOrderId = randomUUID();
  const revisionId = randomUUID();
  const create = {
    actorUserId: job.customerUserId,
    commandId: changeOrderId,
    revisionId,
    jobId: job.jobId,
    terms,
  };
  expect(await repository.createDraft(create)).toMatchObject({
    status: "APPLIED",
    changeOrderId,
    revisionId,
    state: "DRAFT",
  });
  expect(
    await repository.createDraft({
      ...create,
      terms: { ...terms, scopeAdded: ["Oprava podkladu"] },
    }),
  ).toMatchObject({
    status: "DEDUPLICATED",
    state: "DRAFT",
  });
  await expect(
    repository.createDraft({
      ...create,
      terms: { ...terms, title: "Iná zmena" },
    }),
  ).rejects.toBeInstanceOf(ChangeOrderIdempotencyError);
  expect(
    await repository.getChangeOrder({
      actorUserId: job.providerUserId,
      jobId: job.jobId,
      changeOrderId,
    }),
  ).toBeNull();
  expect(
    await repository.getRevision({
      actorUserId: job.providerUserId,
      jobId: job.jobId,
      changeOrderId,
      revisionId,
    }),
  ).toBeNull();
  expect(
    (
      await repository.listChangeOrders({
        actorUserId: job.providerUserId,
        jobId: job.jobId,
      })
    )?.items.some((item) => item.changeOrderId === changeOrderId),
  ).toBe(false);

  const replacementId = randomUUID();
  const replacement = {
    actorUserId: job.customerUserId,
    commandId: replacementId,
    jobId: job.jobId,
    changeOrderId,
    expectedRevisionId: revisionId,
    terms: { ...terms, title: "Spresnená zmena rozsahu" },
  };
  expect(await repository.replaceDraft(replacement)).toMatchObject({
    status: "APPLIED",
    revisionId: replacementId,
    revisionNumber: 2,
    state: "DRAFT",
  });
  expect(
    await repository.getRevision({
      actorUserId: job.providerUserId,
      jobId: job.jobId,
      changeOrderId,
      revisionId,
    }),
  ).toBeNull();
  expect(
    (
      await repository.listRevisions({
        actorUserId: job.providerUserId,
        jobId: job.jobId,
        changeOrderId,
      })
    )?.items,
  ).toEqual([]);
  expect(await repository.replaceDraft(replacement)).toMatchObject({
    status: "DEDUPLICATED",
    state: "DRAFT",
  });
  expect(
    await repository.submitRevision({
      actorUserId: job.providerUserId,
      commandId: randomUUID(),
      jobId: job.jobId,
      changeOrderId,
      revisionId: replacementId,
      revisionNumber: 2,
    }),
  ).toEqual({ status: "NOT_FOUND" });
  expect(
    await repository.counterpropose({
      actorUserId: job.providerUserId,
      commandId: randomUUID(),
      jobId: job.jobId,
      changeOrderId,
      expectedRevisionId: replacementId,
      terms,
    }),
  ).toEqual({ status: "NOT_FOUND" });
  const submit = {
    actorUserId: job.customerUserId,
    commandId: randomUUID(),
    jobId: job.jobId,
    changeOrderId,
    revisionId: replacementId,
    revisionNumber: 2,
  };
  expect(await repository.submitRevision(submit)).toMatchObject({
    status: "APPLIED",
    state: "PROPOSED",
  });
  expect(await repository.submitRevision(submit)).toMatchObject({
    status: "DEDUPLICATED",
    state: "PROPOSED",
  });
  expect(
    (
      await repository.getRevision({
        actorUserId: job.providerUserId,
        jobId: job.jobId,
        changeOrderId,
        revisionNumber: 2,
      })
    )?.terms.title,
  ).toBe(replacement.terms.title);
  expect(
    await repository.getRevision({
      actorUserId: job.providerUserId,
      jobId: job.jobId,
      changeOrderId,
      revisionNumber: 1,
    }),
  ).toBeNull();
  await expect(sql`UPDATE change_order_revisions SET title = 'mutated'
    WHERE id = ${replacementId}`).rejects.toThrow(/immutable/);
  await expect(sql`DELETE FROM change_order_revision_actions
    WHERE id = ${submit.commandId}`).rejects.toThrow(/immutable/);
  await expect(sql`INSERT INTO change_order_revision_actions
    (id, revision_id, action_sequence, action, actor_user_id, command_intent_sha256)
    VALUES (${randomUUID()}, ${replacementId}, 2, 'APPROVE',
      ${job.customerUserId}, ${"a".repeat(64)})`).rejects.toThrow(
    /opposite party/,
  );

  const counterId = randomUUID();
  const counter = {
    actorUserId: job.providerUserId,
    commandId: counterId,
    jobId: job.jobId,
    changeOrderId,
    expectedRevisionId: replacementId,
    terms: {
      ...terms,
      title: "Protinávrh rozsahu",
      priceImpact: {
        mode: "ESTIMATE_DELTA" as const,
        amountCents: 15_000,
        basis: "Podľa skutočného rozsahu opravy",
        vatStatus: "VAT_INCLUDED" as const,
      },
    },
  };
  expect(await repository.counterpropose(counter)).toMatchObject({
    status: "APPLIED",
    revisionId: counterId,
    revisionNumber: 3,
    state: "PROPOSED",
  });
  expect(await repository.submitRevision(submit)).toMatchObject({
    status: "DEDUPLICATED",
    state: "PROPOSED",
  });
  expect(
    await repository.approveRevision({
      actorUserId: job.providerUserId,
      commandId: randomUUID(),
      jobId: job.jobId,
      changeOrderId,
      revisionId: replacementId,
      revisionNumber: 2,
    }),
  ).toEqual({ status: "STALE_STATE" });
  expect(
    (
      await repository.listRevisions({
        actorUserId: job.customerUserId,
        jobId: job.jobId,
        changeOrderId,
      })
    )?.items.map((item) => item.state),
  ).toEqual(["PROPOSED", "SUPERSEDED", "SUPERSEDED"]);

  const approval = {
    actorUserId: job.customerUserId,
    commandId: randomUUID(),
    jobId: job.jobId,
    changeOrderId,
    revisionId: counterId,
    revisionNumber: 3,
  };
  const simultaneous = await Promise.all([
    repository.approveRevision(approval),
    repository.rejectRevision({ ...approval, commandId: randomUUID() }),
  ]);
  expect(
    simultaneous.filter((result) => result.status === "APPLIED"),
  ).toHaveLength(1);
  expect(
    simultaneous.filter((result) => result.status === "STALE_STATE"),
  ).toHaveLength(1);
  const final = await repository.getRevision({
    actorUserId: job.customerUserId,
    jobId: job.jobId,
    changeOrderId,
    revisionId: counterId,
  });
  expect(["APPROVED", "REJECTED"]).toContain(final?.state);
  if (final?.state === "APPROVED") {
    expect(await repository.approveRevision(approval)).toMatchObject({
      status: "DEDUPLICATED",
      state: "APPROVED",
    });
  }
  const [baseline] = await sql<Array<{ quoteId: string; revision: number }>>`
    SELECT accepted_quote_id AS "quoteId", accepted_quote_revision AS revision
    FROM jobs WHERE id = ${job.jobId}`;
  expect(baseline).toEqual({
    quoteId: job.acceptedQuoteId,
    revision: job.acceptedQuoteRevision,
  });
  const notifications = await sql<
    Array<{ event_name: string; payload: unknown }>
  >`
    SELECT event_name, payload FROM domain_outbox_events
    WHERE entity_type = 'CHANGE_ORDER_REVISION'
      AND entity_id IN (${replacementId}, ${counterId})`;
  expect(
    notifications.some(
      (event) => event.event_name === "job.change_order.proposed",
    ),
  ).toBe(true);
  expect(
    notifications.some(
      (event) => event.event_name === "job.change_order.counterproposed",
    ),
  ).toBe(true);
  expect(JSON.stringify(notifications)).not.toContain("Oprava podkladu");
  expect(JSON.stringify(notifications)).not.toContain("15000");

  const deterministicChangeId = randomUUID();
  const deterministicRevisionId = randomUUID();
  expect(
    await repository.createDraft({
      actorUserId: job.providerUserId,
      commandId: deterministicChangeId,
      jobId: job.jobId,
      revisionId: deterministicRevisionId,
      terms,
    }),
  ).toMatchObject({ status: "APPLIED", state: "DRAFT" });
  expect(
    await repository.submitRevision({
      actorUserId: job.providerUserId,
      commandId: randomUUID(),
      jobId: job.jobId,
      changeOrderId: deterministicChangeId,
      revisionId: deterministicRevisionId,
      revisionNumber: 1,
    }),
  ).toMatchObject({ status: "APPLIED", state: "PROPOSED" });
  expect(
    await repository.approveRevision({
      actorUserId: job.customerUserId,
      commandId: randomUUID(),
      jobId: job.jobId,
      changeOrderId: deterministicChangeId,
      revisionId: deterministicRevisionId,
      revisionNumber: 1,
    }),
  ).toMatchObject({ status: "APPLIED", state: "APPROVED" });
  const dashboardRepository = createJobDashboardRepository(sql);
  for (const actorUserId of [job.customerUserId, job.providerUserId]) {
    const dashboard = await dashboardRepository.readForPrimaryParty({
      actorUserId,
      jobId: job.jobId,
    });
    expect(dashboard?.quote.quoteId).toBe(job.acceptedQuoteId);
    expect(dashboard?.quote.revision).toBe(job.acceptedQuoteRevision);
    expect(
      dashboard?.currentCommercialState.approvedChanges.some(
        (change) =>
          change.changeOrderId === deterministicChangeId &&
          change.revisionId === deterministicRevisionId &&
          change.terms.title === terms.title,
      ),
    ).toBe(true);
    expect(JSON.stringify(dashboard?.currentCommercialState)).not.toContain(
      "externalPdfMediaAssetId",
    );
  }
}
