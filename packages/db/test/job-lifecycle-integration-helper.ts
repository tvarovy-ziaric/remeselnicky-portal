import { createHash, randomUUID } from "node:crypto";

import type { Sql } from "postgres";
import { expect } from "vitest";

import { createJobLifecycleRepository } from "../src/job-lifecycle-repository.js";
import { createJobDashboardRepository } from "../src/job-dashboard-repository.js";

interface ConfirmedJob {
  readonly id: string;
  readonly customerUserId: string;
  readonly providerUserId: string;
}

const fingerprint = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export async function runJobLifecycleIntegrationAssertions(sql: Sql) {
  const [job] = await sql<ConfirmedJob[]>`
    SELECT job.id,
      customer.owner_user_id AS "customerUserId",
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

  const [initial] = await sql<Array<{ state: string; startedAt: Date | null }>>`
    SELECT state::text, started_at AS "startedAt"
    FROM current_job_states WHERE job_id = ${job.id}
  `;
  expect(initial).toMatchObject({ state: "CONFIRMED", startedAt: null });

  await expect(sql`
    INSERT INTO job_lifecycle_commands (
      command_id, job_id, actor_user_id, command_kind, expected_state,
      actor_role, reason, payload_fingerprint
    ) VALUES (
      ${randomUUID()}, ${job.id}, ${job.customerUserId}, 'START',
      'CONFIRMED', 'PRIMARY_PROVIDER', NULL, ${fingerprint("wrong actor")}
    )
  `).rejects.toThrow();

  const startId = randomUUID();
  const service = createJobLifecycleRepository(sql);
  const start = {
    actorUserId: job.providerUserId,
    commandId: startId,
    jobId: job.id,
  };
  expect(await service.start(start)).toMatchObject({
    state: "IN_PROGRESS",
    status: "APPLIED",
  });
  expect(await service.start(start)).toMatchObject({
    state: "IN_PROGRESS",
    status: "DEDUPLICATED",
  });
  expect(await service.start({ ...start, commandId: randomUUID() })).toEqual({
    status: "STALE_STATE",
  });
  const [started] = await sql<
    Array<{ state: string; startedAt: Date; startedByUserId: string }>
  >`
    SELECT state::text, started_at AS "startedAt",
      started_by_user_id AS "startedByUserId"
    FROM current_job_states WHERE job_id = ${job.id}
  `;
  expect(started?.state).toBe("IN_PROGRESS");
  expect(started?.startedAt).toBeInstanceOf(Date);
  expect(started?.startedByUserId).toBe(job.providerUserId);

  const reason = "Zákazník ukončil realizáciu po začatí prác.";
  const cancelId = randomUUID();
  const cancel = {
    actorUserId: job.customerUserId,
    commandId: cancelId,
    expectedState: "IN_PROGRESS" as const,
    jobId: job.id,
    reason,
  };
  expect(await service.cancel(cancel)).toMatchObject({
    state: "CANCELLED",
    status: "APPLIED",
  });
  expect(await service.cancel(cancel)).toMatchObject({
    state: "CANCELLED",
    status: "DEDUPLICATED",
  });
  await expect(
    service.cancel({ ...cancel, reason: `${reason} Iný text.` }),
  ).rejects.toThrow("reused for another intent");
  const [cancelled] = await sql<
    Array<{
      state: string;
      cancellationReason: string;
      cancelledByUserId: string;
    }>
  >`
    SELECT state::text, cancellation_reason AS "cancellationReason",
      cancelled_by_user_id AS "cancelledByUserId"
    FROM current_job_states WHERE job_id = ${job.id}
  `;
  expect(cancelled).toMatchObject({
    state: "CANCELLED",
    cancellationReason: reason,
    cancelledByUserId: job.customerUserId,
  });
  const dashboard = await createJobDashboardRepository(sql).readForPrimaryParty(
    {
      actorUserId: job.customerUserId,
      jobId: job.id,
    },
  );
  expect(dashboard?.state).toBe("CANCELLED");
  expect(dashboard?.timeline.at(-1)).toMatchObject({
    eventType: "JOB_CANCELLED",
    actorRole: "CUSTOMER",
    reason,
  });

  const events = await sql<
    Array<{
      eventType: string;
      actorRole: string | null;
      reason: string | null;
    }>
  >`
    SELECT event_type AS "eventType", actor_role AS "actorRole", reason
    FROM job_chronological_system_events WHERE job_id = ${job.id}
    ORDER BY occurred_at, event_order, event_id
  `;
  expect(events.map((event) => event.eventType)).toEqual([
    "JOB_CONFIRMED",
    "CONTACT_ADDRESS_UNLOCKED",
    "PARTICIPANT_JOINED",
    "PARTICIPANT_LEFT",
    "PARTICIPANT_JOINED",
    "PARTICIPANT_REMOVED",
    "PARTICIPANT_JOINED",
    "PARTICIPANT_LEFT",
    "PARTICIPANT_JOINED",
    "PARTICIPANT_JOINED",
    "PARTICIPANT_LEFT",
    "PARTICIPANT_LEFT",
    "JOB_STARTED",
    "JOB_CANCELLED",
  ]);
  expect(
    events
      .filter((event) => event.eventType.startsWith("PARTICIPANT_"))
      .every((event) => event.reason === null),
  ).toBe(true);
  expect(events.at(-1)).toMatchObject({
    actorRole: "CUSTOMER",
    reason,
  });

  const notices = await sql<
    Array<{ eventName: string; payload: Record<string, unknown> }>
  >`
    SELECT event_name AS "eventName", payload
    FROM domain_outbox_events
    WHERE idempotency_key IN (
      ${`job.lifecycle.${startId}`}, ${`job.lifecycle.${cancelId}`}
    ) ORDER BY occurred_at, event_name
  `;
  expect(notices.map((event) => event.eventName)).toEqual([
    "job.started",
    "job.cancelled",
  ]);
  expect(notices[0]?.payload).toEqual({
    job_state_revision: 1,
    recipient_user_id: job.customerUserId,
  });
  expect(notices[1]?.payload).toEqual({
    job_state_revision: 2,
    recipient_user_id: job.providerUserId,
  });
  expect(JSON.stringify(notices)).not.toContain(reason);

  await expect(sql`
    UPDATE job_lifecycle_commands SET reason = 'Changed reason'
    WHERE command_id = ${cancelId}
  `).rejects.toThrow();
  await expect(sql`
    DELETE FROM job_lifecycle_commands WHERE command_id = ${startId}
  `).rejects.toThrow();
  await expect(sql`
    INSERT INTO job_lifecycle_commands (
      command_id, job_id, actor_user_id, command_kind, expected_state,
      actor_role, reason, payload_fingerprint
    ) VALUES (
      ${randomUUID()}, ${job.id}, ${job.providerUserId}, 'START',
      'CONFIRMED', 'PRIMARY_PROVIDER', NULL, ${fingerprint("late start")}
    )
  `).rejects.toThrow();
}
