import { randomUUID } from "node:crypto";

import type { Sql, TransactionSql } from "postgres";
import { expect } from "vitest";

import {
  createJobOperationalRepository,
  JobOperationalIdempotencyError,
} from "../src/job-operational-repository.js";

interface JobFixture {
  readonly id: string;
  readonly customerUserId: string;
  readonly providerUserId: string;
}

/** Run before the lifecycle helper cancels the shared confirmed-Job fixture. */
export async function runJobOperationalIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const [job] = await sql<JobFixture[]>`
    SELECT job.id, customer.owner_user_id AS "customerUserId",
      provider.owner_user_id AS "providerUserId"
    FROM jobs job
    JOIN customer_profiles customer ON customer.id = job.customer_profile_id
    JOIN craftsman_profiles provider
      ON provider.id = job.primary_craftsman_profile_id
    JOIN current_job_states state ON state.job_id = job.id
    WHERE state.state = 'CONFIRMED'
    ORDER BY job.accepted_at DESC, job.id DESC LIMIT 1
  `;
  if (job === undefined) throw new Error("Confirmed Job fixture missing.");
  const repository = createJobOperationalRepository(sql);
  const progressId = randomUUID();
  const progress = {
    actorUserId: job.providerUserId,
    commandId: progressId,
    jobId: job.id,
    body: "Práce na príprave podkladu pokračujú podľa plánu.",
  };
  expect(
    await repository.createProgress({
      ...progress,
      actorUserId: job.customerUserId,
    }),
  ).toEqual({ status: "NOT_FOUND" });
  const createdProgress = await repository.createProgress(progress);
  expect(createdProgress).toMatchObject({ status: "APPLIED", id: progressId });
  if (createdProgress.status === "APPLIED")
    expect(createdProgress.createdAt).toBeInstanceOf(Date);
  expect(await repository.createProgress(progress)).toMatchObject({
    status: "DEDUPLICATED",
    id: progressId,
  });
  await expect(
    repository.createProgress({ ...progress, body: "Iný priebeh." }),
  ).rejects.toBeInstanceOf(JobOperationalIdempotencyError);
  await expect(
    repository.createIssue({
      ...progress,
      kind: "PROBLEM",
      body: "Nedostatok materiálu na pracovisku.",
    }),
  ).rejects.toBeInstanceOf(JobOperationalIdempotencyError);
  expect(
    await repository.createIssue({
      ...progress,
      actorUserId: job.customerUserId,
      kind: "PROBLEM",
      body: "Nedostatok materiálu na pracovisku.",
    }),
  ).toEqual({ status: "NOT_FOUND" });
  expect(
    await repository.listProgress({
      actorUserId: randomUUID(),
      jobId: job.id,
      limit: 10,
    }),
  ).toBeNull();
  expect(
    await repository.getProgress({
      actorUserId: randomUUID(),
      jobId: job.id,
      updateId: progressId,
    }),
  ).toBeNull();

  const progressId2 = randomUUID();
  expect(
    await repository.createProgress({
      ...progress,
      commandId: progressId2,
      body: "Montáž pokračuje v dohodnutom poradí.",
    }),
  ).toMatchObject({ status: "APPLIED" });
  const firstPage = await repository.listProgress({
    actorUserId: job.customerUserId,
    jobId: job.id,
    limit: 1,
  });
  expect(firstPage).toMatchObject({
    canCreate: false,
    items: [
      expect.objectContaining({
        id: progressId2,
        jobId: job.id,
        acknowledgedAt: null,
      }),
    ],
  });
  expect(firstPage?.nextCursor?.id).toBe(progressId2);
  if (firstPage?.nextCursor === null || firstPage?.nextCursor === undefined)
    throw new Error("Second Job progress page missing.");
  const secondPage = await repository.listProgress({
    actorUserId: job.customerUserId,
    jobId: job.id,
    limit: 1,
    cursor: firstPage.nextCursor,
  });
  expect(secondPage?.items[0]?.id).toBe(progressId);
  expect(
    await repository.getProgress({
      actorUserId: job.customerUserId,
      jobId: job.id,
      updateId: progressId,
    }),
  ).toMatchObject({ body: progress.body });
  expect(
    await repository.getProgress({
      actorUserId: job.providerUserId,
      jobId: randomUUID(),
      updateId: progressId,
    }),
  ).toBeNull();

  const ackId = randomUUID();
  const ack = {
    actorUserId: job.customerUserId,
    commandId: ackId,
    jobId: job.id,
    updateId: progressId,
  };
  expect(
    await repository.acknowledgeProgress({
      ...ack,
      actorUserId: job.providerUserId,
    }),
  ).toEqual({ status: "NOT_FOUND" });
  const createdAck = await repository.acknowledgeProgress(ack);
  expect(createdAck).toMatchObject({ status: "APPLIED" });
  if (createdAck.status === "APPLIED")
    expect(createdAck.acknowledgedAt).toBeInstanceOf(Date);
  expect(await repository.acknowledgeProgress(ack)).toMatchObject({
    status: "DEDUPLICATED",
  });
  expect(
    await repository.acknowledgeProgress({ ...ack, commandId: randomUUID() }),
  ).toEqual({ status: "STALE_STATE" });
  expect(
    (
      await repository.getProgress({
        actorUserId: job.providerUserId,
        jobId: job.id,
        updateId: progressId,
      })
    )?.acknowledgedAt,
  ).toBeInstanceOf(Date);

  const issueId = randomUUID();
  const issue = {
    actorUserId: job.providerUserId,
    commandId: issueId,
    jobId: job.id,
    kind: "DELAY" as const,
    body: "Dodávka materiálu prišla neskôr, než sa očakávalo.",
  };
  expect(await repository.createIssue(issue)).toMatchObject({
    status: "APPLIED",
    id: issueId,
  });
  expect(await repository.createIssue(issue)).toMatchObject({
    status: "DEDUPLICATED",
  });
  await expect(
    repository.createIssue({ ...issue, kind: "WAITING" }),
  ).rejects.toBeInstanceOf(JobOperationalIdempotencyError);
  expect(
    await repository.listIssues({
      actorUserId: job.customerUserId,
      jobId: job.id,
      limit: 10,
    }),
  ).toMatchObject({
    canCreate: true,
    items: [
      expect.objectContaining({
        id: issueId,
        kind: "DELAY",
        authorRole: "PRIMARY_PROVIDER",
      }),
    ],
  });
  expect(
    await repository.getIssue({
      actorUserId: job.customerUserId,
      jobId: job.id,
      issueId,
    }),
  ).toMatchObject({ id: issueId });
  expect(
    await repository.getIssue({
      actorUserId: randomUUID(),
      jobId: job.id,
      issueId,
    }),
  ).toBeNull();

  const commentId = randomUUID();
  expect(
    await repository.getIssue({
      actorUserId: job.customerUserId,
      jobId: randomUUID(),
      issueId,
    }),
  ).toBeNull();
  const comment = {
    actorUserId: job.customerUserId,
    commandId: commentId,
    jobId: job.id,
    issueId,
    body: "Prosím, potvrďte nový predpokladaný termín.",
  };
  expect(await repository.addIssueComment(comment)).toMatchObject({
    status: "APPLIED",
    id: commentId,
  });
  expect(await repository.addIssueComment(comment)).toMatchObject({
    status: "DEDUPLICATED",
  });
  expect(
    await repository.listIssueComments({
      actorUserId: job.providerUserId,
      jobId: job.id,
      issueId,
      limit: 10,
    }),
  ).toMatchObject({
    canCreate: true,
    items: [expect.objectContaining({ id: commentId, authorRole: "CUSTOMER" })],
  });
  expect(
    await repository.listIssueComments({
      actorUserId: randomUUID(),
      jobId: job.id,
      issueId,
      limit: 10,
    }),
  ).toBeNull();

  const outbox = await sql<
    Array<{ eventName: string; payload: Record<string, unknown> }>
  >`
    SELECT event_name AS "eventName", payload FROM domain_outbox_events
    WHERE idempotency_key IN (${`job.progress.${progressId}`},
      ${`job.progress.${progressId2}`}, ${`job.issue.${issueId}`})
    ORDER BY event_name, idempotency_key
  `;
  expect(outbox).toHaveLength(3);
  expect(
    outbox.find((event) => event.eventName === "job.issue.created")?.payload,
  ).toEqual({
    recipient_user_id: job.customerUserId,
    issue_id: issueId,
    issue_kind: "DELAY",
  });
  expect(
    outbox.find((event) => event.payload.progress_update_id === progressId)
      ?.payload,
  ).toEqual({
    recipient_user_id: job.customerUserId,
    progress_update_id: progressId,
  });
  expect(JSON.stringify(outbox)).not.toContain(progress.body);
  expect(JSON.stringify(outbox)).not.toContain(issue.body);

  await expect(sql`INSERT INTO job_progress_updates
    (id, job_id, author_user_id, body) VALUES
    (${randomUUID()}, ${job.id}, ${job.customerUserId}, 'Nesprávny autor')`).rejects.toThrow();
  await expect(sql`INSERT INTO job_issues
    (id, job_id, author_user_id, author_role, kind, body) VALUES
    (${progressId}, ${job.id}, ${job.providerUserId}, 'PRIMARY_PROVIDER',
      'PROBLEM', 'Opakovane použitý command ID pri inom zázname')`).rejects.toThrow(
    /command ID collision/,
  );
  await expect(sql`INSERT INTO job_progress_acknowledgements
    (id, progress_update_id, customer_user_id) VALUES
    (${randomUUID()}, ${progressId2}, ${job.providerUserId})`).rejects.toThrow();
  await expect(sql`INSERT INTO job_issues
    (id, job_id, author_user_id, author_role, kind, body) VALUES
    (${randomUUID()}, ${job.id}, ${job.providerUserId}, 'CUSTOMER',
      'PROBLEM', 'Nesprávny autor problému')`).rejects.toThrow();
  await expect(sql`INSERT INTO job_issue_comments
    (id, issue_id, author_user_id, author_role, body) VALUES
    (${randomUUID()}, ${issueId}, ${job.providerUserId}, 'CUSTOMER',
      'Nesprávny autor komentára')`).rejects.toThrow();
  await expect(sql`UPDATE job_progress_updates SET body = 'Prepísané'
    WHERE id = ${progressId}`).rejects.toThrow();
  await expect(sql`DELETE FROM job_progress_acknowledgements
    WHERE id = ${ackId}`).rejects.toThrow();
  await expect(sql`UPDATE job_issues SET body = 'Prepísaný problém'
    WHERE id = ${issueId}`).rejects.toThrow();
  await expect(sql`DELETE FROM job_issue_comments
    WHERE id = ${commentId}`).rejects.toThrow();

  const inactiveRollback = new Error("rollback inactive operational test");
  await expect(
    sql.begin(async (tx: TransactionSql) => {
      await tx`UPDATE users SET account_state = 'SUSPENDED',
      account_state_changed_at = clock_timestamp(),
      updated_at = clock_timestamp() WHERE id = ${job.providerUserId}`;
      await expect(
        tx.savepoint(
          async (sp) => sp`
      INSERT INTO job_progress_updates (id, job_id, author_user_id, body)
      VALUES (${randomUUID()}, ${job.id}, ${job.providerUserId},
        'Neoprávnená aktualizácia počas pozastavenia účtu')
    `,
        ),
      ).rejects.toThrow(/active primary Job party required/);
      throw inactiveRollback;
    }),
  ).rejects.toThrow(inactiveRollback.message);

  const rollback = new Error("rollback cancelled operational test");
  await expect(
    sql.begin(async (tx: TransactionSql) => {
      await tx`INSERT INTO job_lifecycle_commands
      (command_id, job_id, actor_user_id, command_kind, expected_state,
       actor_role, reason, payload_fingerprint) VALUES
      (${randomUUID()}, ${job.id}, ${job.customerUserId}, 'CANCEL',
       'CONFIRMED', 'CUSTOMER', 'Zákazka bola ukončená pre integračný test.',
       ${"a".repeat(64)})`;
      await expect(
        tx.savepoint(
          async (sp) => sp`
        INSERT INTO job_issues
          (id, job_id, author_user_id, author_role, kind, body)
        VALUES (${randomUUID()}, ${job.id}, ${job.providerUserId},
          'PRIMARY_PROVIDER', 'WAITING',
          'Tento záznam po zrušení zákazky nesmie vzniknúť')
      `,
        ),
      ).rejects.toThrow(/Job execution is closed/);
      const local = createJobOperationalRepository(tx);
      expect(
        await local.createProgress({ ...progress, commandId: randomUUID() }),
      ).toEqual({ status: "STALE_STATE" });
      expect(
        await local.createIssue({ ...issue, commandId: randomUUID() }),
      ).toEqual({ status: "STALE_STATE" });
      expect(
        await local.addIssueComment({ ...comment, commandId: randomUUID() }),
      ).toEqual({ status: "STALE_STATE" });
      expect(
        await local.acknowledgeProgress({
          ...ack,
          commandId: randomUUID(),
          updateId: progressId2,
        }),
      ).toEqual({ status: "STALE_STATE" });
      expect(
        (
          await local.listProgress({
            actorUserId: job.customerUserId,
            jobId: job.id,
            limit: 10,
          })
        )?.canCreate,
      ).toBe(false);
      expect(
        (
          await local.listIssues({
            actorUserId: job.providerUserId,
            jobId: job.id,
            limit: 10,
          })
        )?.items[0]?.id,
      ).toBe(issueId);
      expect(
        await local.getIssue({
          actorUserId: job.customerUserId,
          jobId: job.id,
          issueId,
        }),
      ).toMatchObject({ id: issueId });
      throw rollback;
    }),
  ).rejects.toThrow(rollback.message);
}
