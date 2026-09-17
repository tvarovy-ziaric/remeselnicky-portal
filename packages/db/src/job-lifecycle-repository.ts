import { createHash } from "node:crypto";

import type { Sql, TransactionSql } from "postgres";

type RootSql = Sql | TransactionSql;
type State = "CONFIRMED" | "IN_PROGRESS" | "CANCELLED";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface StartJobInput {
  readonly actorUserId: string;
  readonly commandId: string;
  readonly jobId: string;
}

export interface CancelJobInput extends StartJobInput {
  readonly expectedState: "CONFIRMED" | "IN_PROGRESS";
  readonly reason: string;
}

export type JobLifecycleResult =
  | Readonly<{
      recordedAt: Date;
      state: "IN_PROGRESS" | "CANCELLED";
      status: "APPLIED" | "DEDUPLICATED";
    }>
  | Readonly<{ status: "NOT_FOUND" | "STALE_STATE" }>;

export class JobLifecycleIdempotencyError extends Error {}

interface ExistingCommand {
  readonly actorUserId: string;
  readonly commandKind: "START" | "CANCEL";
  readonly expectedState: State;
  readonly jobId: string;
  readonly payloadFingerprint: string;
  readonly recordedAt: Date;
}

export function createJobLifecycleRepository(sql: RootSql) {
  const command = async (
    kind: "START" | "CANCEL",
    input: StartJobInput | CancelJobInput,
  ): Promise<JobLifecycleResult> => {
    validateInput(kind, input);
    const expectedState =
      kind === "START" ? "CONFIRMED" : (input as CancelJobInput).expectedState;
    const reason =
      kind === "START" ? null : (input as CancelJobInput).reason.trim();
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          actorUserId: input.actorUserId,
          expectedState,
          jobId: input.jobId,
          kind,
          reason,
        }),
      )
      .digest("hex");
    return transaction(sql, async (tx) => {
      await tx`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${input.commandId}::text, 51006)
        )
      `;
      const [owned] = await tx<Array<{ id: string }>>`
        SELECT job.id FROM jobs job
        JOIN customer_profiles customer
          ON customer.id = job.customer_profile_id
        JOIN craftsman_profiles provider
          ON provider.id = job.primary_craftsman_profile_id
        WHERE job.id = ${input.jobId}
          AND (
            provider.owner_user_id = ${input.actorUserId}
            OR (${kind} = 'CANCEL'
              AND customer.owner_user_id = ${input.actorUserId})
          )
      `;
      if (owned === undefined) return { status: "NOT_FOUND" };
      await tx`SELECT id FROM jobs WHERE id = ${input.jobId} FOR UPDATE`;
      await tx`SELECT id FROM users WHERE id = ${input.actorUserId} FOR SHARE`;
      await tx`
        SELECT user_id FROM auth_credentials
        WHERE user_id = ${input.actorUserId} FOR SHARE
      `;
      const [actor] = await tx<
        Array<{ role: "CUSTOMER" | "PRIMARY_PROVIDER" }>
      >`
        SELECT CASE
            WHEN ${kind} = 'START' THEN 'PRIMARY_PROVIDER'
            WHEN customer.owner_user_id = viewer.id THEN 'CUSTOMER'
            ELSE 'PRIMARY_PROVIDER'
          END AS role
        FROM jobs job
        JOIN customer_profiles customer
          ON customer.id = job.customer_profile_id
        JOIN craftsman_profiles provider
          ON provider.id = job.primary_craftsman_profile_id
        JOIN users viewer ON viewer.id = ${input.actorUserId}
        JOIN auth_credentials credentials
          ON credentials.user_id = viewer.id
        JOIN job_acceptance_events accepted ON accepted.job_id = job.id
        JOIN job_agreement_snapshots snapshot ON snapshot.job_id = job.id
        WHERE job.id = ${input.jobId}
          AND viewer.account_state = 'ACTIVE'
          AND credentials.email_verified_at IS NOT NULL
          AND credentials.phone_verified_at IS NOT NULL
          AND (
            provider.owner_user_id = viewer.id
            OR (${kind} = 'CANCEL'
              AND customer.owner_user_id = viewer.id)
          )
      `;
      if (actor === undefined) return { status: "NOT_FOUND" };
      const [existing] = await tx<ExistingCommand[]>`
        SELECT job_id AS "jobId", actor_user_id AS "actorUserId",
          command_kind::text AS "commandKind",
          expected_state::text AS "expectedState",
          payload_fingerprint AS "payloadFingerprint",
          recorded_at AS "recordedAt"
        FROM job_lifecycle_commands WHERE command_id = ${input.commandId}
      `;
      if (existing !== undefined) {
        if (existing.actorUserId !== input.actorUserId)
          return { status: "NOT_FOUND" };
        if (
          existing.jobId !== input.jobId ||
          existing.commandKind !== kind ||
          existing.expectedState !== expectedState ||
          existing.payloadFingerprint !== fingerprint
        )
          throw new JobLifecycleIdempotencyError(
            "Job lifecycle command ID was reused for another intent.",
          );
        return Object.freeze({
          recordedAt: existing.recordedAt,
          state: kind === "START" ? "IN_PROGRESS" : "CANCELLED",
          status: "DEDUPLICATED" as const,
        });
      }
      const [current] = await tx<Array<{ state: State }>>`
        SELECT state::text FROM current_job_states
        WHERE job_id = ${input.jobId}
      `;
      if (current === undefined) return { status: "NOT_FOUND" };
      if (current.state !== expectedState) return { status: "STALE_STATE" };
      const [inserted] = await tx<Array<{ recordedAt: Date }>>`
        INSERT INTO job_lifecycle_commands (
          command_id, job_id, actor_user_id, command_kind,
          expected_state, actor_role, reason, payload_fingerprint
        ) VALUES (
          ${input.commandId}, ${input.jobId}, ${input.actorUserId},
          ${kind}, ${expectedState}, ${actor.role}, ${reason}, ${fingerprint}
        ) RETURNING recorded_at AS "recordedAt"
      `;
      if (inserted === undefined)
        throw new Error("Job lifecycle command effect missing.");
      return Object.freeze({
        recordedAt: inserted.recordedAt,
        state: kind === "START" ? "IN_PROGRESS" : "CANCELLED",
        status: "APPLIED" as const,
      });
    });
  };
  return Object.freeze({
    start(input: StartJobInput): Promise<JobLifecycleResult> {
      return command("START", input);
    },
    cancel(input: CancelJobInput): Promise<JobLifecycleResult> {
      return command("CANCEL", input);
    },
  });
}

function validateInput(
  kind: "START" | "CANCEL",
  input: StartJobInput | CancelJobInput,
): void {
  if (
    !uuid.test(input.actorUserId) ||
    !uuid.test(input.commandId) ||
    !uuid.test(input.jobId)
  )
    throw new TypeError("Invalid Job lifecycle command.");
  if (kind === "CANCEL") {
    const cancel = input as CancelJobInput;
    if (
      (cancel.expectedState !== "CONFIRMED" &&
        cancel.expectedState !== "IN_PROGRESS") ||
      typeof cancel.reason !== "string" ||
      cancel.reason.trim().length < 8 ||
      cancel.reason.trim().length > 1000
    )
      throw new TypeError("Invalid Job cancellation command.");
  }
}

function transaction<T>(
  sql: RootSql,
  callback: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return ("savepoint" in sql
    ? sql.savepoint(callback)
    : sql.begin(callback)) as unknown as Promise<T>;
}
