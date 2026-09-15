import { createHash, randomUUID } from "node:crypto";

import {
  assertActivateJobRequestInput,
  assertCreateJobRequestDraftInput,
  JOB_REQUEST_SUBMISSION_REQUIREMENTS,
  JobRequestIdempotencyError,
  type ActivateJobRequestInput,
  type CustomerProfileId,
  type JobRequest,
  type JobRequestCommandResult,
  type JobRequestId,
  type JobRequestPersistence,
  type JobRequestState,
  type JobRequestSubmissionRequirement,
  type PersistCreateJobRequestDraftInput,
  type UserId,
} from "@portal/domain";
import type { Sql, TransactionSql } from "postgres";

interface CommandRow {
  readonly actorUserId: string;
  readonly commandKind: "CREATE_DRAFT" | "ACTIVATE";
  readonly customerProfileId: string;
  readonly jobRequestId: string;
  readonly payloadFingerprint: string;
  readonly resultingRevision: number;
}

type CurrentRow = JobRequest;

export function createJobRequestRepository(sql: Sql): JobRequestPersistence {
  return Object.freeze({
    async activateOwned(
      input: ActivateJobRequestInput,
    ): Promise<JobRequestCommandResult> {
      assertActivateJobRequestInput(input);
      return sql.begin(async (transaction) => {
        const customerProfileId = await lockActiveActorCustomer(
          transaction,
          input.actorUserId,
        );
        if (customerProfileId === null) {
          return Object.freeze({ status: "ACCOUNT_NOT_ACTIVE" as const });
        }
        await lockCommand(transaction, input.commandId);
        const fingerprint = commandFingerprint("ACTIVATE", input);
        const replay = await replayCommand(transaction, {
          actorUserId: input.actorUserId,
          commandId: input.commandId,
          commandKind: "ACTIVATE",
          customerProfileId,
          fingerprint,
          jobRequestId: input.jobRequestId,
        });
        if (replay !== null) return replay;

        if (
          !(await lockOwnedRequest(
            transaction,
            input.jobRequestId,
            customerProfileId,
          ))
        ) {
          return Object.freeze({ status: "NOT_FOUND" as const });
        }
        const current = await selectCurrent(transaction, input.jobRequestId);
        if (current === null) {
          return Object.freeze({ status: "NOT_FOUND" as const });
        }
        if (current.revision !== input.expectedRevision) {
          return Object.freeze({ status: "STALE_REVISION" as const });
        }
        if (current.state !== "DRAFT") {
          return Object.freeze({ status: "INVALID_TRANSITION" as const });
        }
        const missing = await missingRequirements(
          transaction,
          input.jobRequestId,
          input.expectedRevision,
        );
        if (missing.length > 0) {
          return Object.freeze({
            missingRequirements: Object.freeze(missing),
            status: "NOT_READY" as const,
          });
        }
        const policy = await lockActiveLimit(transaction, customerProfileId);
        if (policy.count >= policy.limit) {
          return Object.freeze({
            activeLimit: policy.limit,
            status: "ACTIVE_LIMIT_REACHED" as const,
          });
        }

        await insertCommand(transaction, {
          actorUserId: input.actorUserId,
          commandId: input.commandId,
          commandKind: "ACTIVATE",
          customerProfileId,
          expectedRevision: input.expectedRevision,
          fingerprint,
          jobRequestId: input.jobRequestId,
          targetState: "ACTIVE",
        });
        await insertRevision(transaction, {
          commandId: input.commandId,
          jobRequestId: input.jobRequestId,
          revision: input.expectedRevision + 1,
          state: "ACTIVE",
        });
        return applied(
          transaction,
          input.jobRequestId,
          input.expectedRevision + 1,
        );
      });
    },

    async createDraftOwned(
      input: PersistCreateJobRequestDraftInput,
    ): Promise<JobRequestCommandResult> {
      assertCreateJobRequestDraftInput(input);
      assertUuid(input.customerProfileId, "customerProfileId");
      return sql.begin(async (transaction) => {
        if (
          !(await lockActiveCustomer(
            transaction,
            input.actorUserId,
            input.customerProfileId,
          ))
        ) {
          return Object.freeze({ status: "ACCOUNT_NOT_ACTIVE" as const });
        }
        await lockCommand(transaction, input.commandId);
        const fingerprint = commandFingerprint("CREATE_DRAFT", input);
        const replay = await replayCommand(transaction, {
          actorUserId: input.actorUserId,
          commandId: input.commandId,
          commandKind: "CREATE_DRAFT",
          customerProfileId: input.customerProfileId,
          fingerprint,
          jobRequestId: null,
        });
        if (replay !== null) return replay;

        const jobRequestId = randomUUID() as JobRequestId;
        await transaction`
          INSERT INTO job_requests (id, customer_profile_id)
          VALUES (${jobRequestId}, ${input.customerProfileId})
        `;
        await insertCommand(transaction, {
          actorUserId: input.actorUserId,
          commandId: input.commandId,
          commandKind: "CREATE_DRAFT",
          customerProfileId: input.customerProfileId,
          expectedRevision: 0,
          fingerprint,
          jobRequestId,
          targetState: "DRAFT",
        });
        await insertRevision(transaction, {
          commandId: input.commandId,
          jobRequestId,
          revision: 1,
          state: "DRAFT",
        });
        return applied(transaction, jobRequestId, 1);
      });
    },
  });
}

async function lockActiveLimit(
  sql: TransactionSql,
  customerProfileId: CustomerProfileId,
): Promise<{ readonly count: number; readonly limit: number }> {
  await sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${customerProfileId}::text, 40006)
    )
  `;
  const [row] = await sql<{ readonly count: number; readonly limit: number }[]>`
    SELECT policy.active_request_limit AS limit,
      count(current.id)::integer AS count
    FROM job_request_runtime_policy policy
    LEFT JOIN current_job_requests current
      ON current.customer_profile_id = ${customerProfileId}
     AND current.state::text = 'ACTIVE'
    GROUP BY policy.active_request_limit
  `;
  if (row === undefined) throw new Error("Job request runtime policy missing.");
  return row;
}

async function lockCommand(
  sql: TransactionSql,
  commandId: string,
): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${commandId}, 36001))`;
}

async function replayCommand(
  sql: TransactionSql,
  input: {
    readonly actorUserId: UserId;
    readonly commandId: string;
    readonly commandKind: "CREATE_DRAFT" | "ACTIVATE";
    readonly customerProfileId: CustomerProfileId;
    readonly fingerprint: string;
    readonly jobRequestId: JobRequestId | null;
  },
): Promise<JobRequestCommandResult | null> {
  const [row] = await sql<CommandRow[]>`
    SELECT command.actor_user_id AS "actorUserId",
      command.command_kind AS "commandKind",
      command.customer_profile_id AS "customerProfileId",
      command.job_request_id AS "jobRequestId",
      command.payload_fingerprint AS "payloadFingerprint",
      command.resulting_revision AS "resultingRevision"
    FROM job_request_commands command
    WHERE command.command_id = ${input.commandId}
  `;
  if (row === undefined) return null;
  if (
    row.actorUserId !== input.actorUserId ||
    row.commandKind !== input.commandKind ||
    row.customerProfileId !== input.customerProfileId ||
    (input.jobRequestId !== null && row.jobRequestId !== input.jobRequestId) ||
    row.payloadFingerprint !== input.fingerprint
  ) {
    throw new JobRequestIdempotencyError(
      "Job request command id was reused for a different intent.",
    );
  }
  const historical = await selectRevision(
    sql,
    row.jobRequestId as JobRequestId,
    row.resultingRevision,
  );
  if (historical === null)
    throw new Error("Job request command effect missing.");
  return Object.freeze({
    jobRequest: toRecord(historical),
    status: "DEDUPLICATED" as const,
  });
}

async function applied(
  sql: TransactionSql,
  jobRequestId: JobRequestId,
  revision: number,
): Promise<JobRequestCommandResult> {
  const row = await selectRevision(sql, jobRequestId, revision);
  if (row === null) throw new Error("Applied job request revision missing.");
  return Object.freeze({
    jobRequest: toRecord(row),
    status: "APPLIED" as const,
  });
}

async function selectCurrent(
  sql: TransactionSql,
  jobRequestId: JobRequestId,
): Promise<CurrentRow | null> {
  const [row] = await sql<CurrentRow[]>`
    SELECT current.id, current.customer_profile_id AS "customerProfileId",
      current.state, current.revision, current.created_at AS "createdAt",
      current.changed_at AS "changedAt", current.activated_at AS "activatedAt"
    FROM current_job_requests current WHERE current.id = ${jobRequestId}
  `;
  return row ?? null;
}

async function selectRevision(
  sql: TransactionSql,
  jobRequestId: JobRequestId,
  revision: number,
): Promise<CurrentRow | null> {
  const [row] = await sql<CurrentRow[]>`
    SELECT request.id, request.customer_profile_id AS "customerProfileId",
      stored.state, stored.revision, request.created_at AS "createdAt",
      stored.changed_at AS "changedAt", stored.activated_at AS "activatedAt"
    FROM job_requests request
    JOIN job_request_revisions stored ON stored.job_request_id = request.id
    WHERE request.id = ${jobRequestId} AND stored.revision = ${revision}
  `;
  return row ?? null;
}

async function missingRequirements(
  sql: TransactionSql,
  jobRequestId: JobRequestId,
  revision: number,
): Promise<JobRequestSubmissionRequirement[]> {
  const [row] = await sql<{ readonly missing: string[] }[]>`
    SELECT job_request_missing_submission_requirements(
      ${jobRequestId}, ${revision}
    )::text[] AS missing
  `;
  if (row === undefined) throw new Error("Submission readiness check missing.");
  return row.missing.map((item) => {
    const requirement = JOB_REQUEST_SUBMISSION_REQUIREMENTS.find(
      (candidate) => candidate === item,
    );
    if (requirement === undefined) {
      throw new Error("Unknown job request submission requirement.");
    }
    return requirement;
  });
}

async function lockActiveCustomer(
  sql: TransactionSql,
  actorUserId: UserId,
  customerProfileId: CustomerProfileId,
): Promise<boolean> {
  const rows = await sql`
    SELECT customer.id
    FROM users actor
    JOIN customer_profiles customer ON customer.owner_user_id = actor.id
    WHERE actor.id = ${actorUserId} AND actor.account_state = 'ACTIVE'
      AND customer.id = ${customerProfileId}
    FOR UPDATE OF actor, customer
  `;
  return rows.length === 1;
}

async function lockActiveActorCustomer(
  sql: TransactionSql,
  actorUserId: UserId,
): Promise<CustomerProfileId | null> {
  const [row] = await sql<{ readonly customerProfileId: string }[]>`
    SELECT customer.id AS "customerProfileId"
    FROM users actor
    JOIN customer_profiles customer ON customer.owner_user_id = actor.id
    WHERE actor.id = ${actorUserId} AND actor.account_state = 'ACTIVE'
    FOR UPDATE OF actor, customer
  `;
  return row === undefined
    ? null
    : (row.customerProfileId as CustomerProfileId);
}

async function lockOwnedRequest(
  sql: TransactionSql,
  jobRequestId: JobRequestId,
  customerProfileId: CustomerProfileId,
): Promise<boolean> {
  const rows = await sql`
    SELECT id FROM job_requests
    WHERE id = ${jobRequestId} AND customer_profile_id = ${customerProfileId}
    FOR UPDATE
  `;
  return rows.length === 1;
}

async function insertCommand(
  sql: TransactionSql,
  input: {
    readonly actorUserId: UserId;
    readonly commandId: string;
    readonly commandKind: "CREATE_DRAFT" | "ACTIVATE";
    readonly customerProfileId: CustomerProfileId;
    readonly expectedRevision: number;
    readonly fingerprint: string;
    readonly jobRequestId: JobRequestId;
    readonly targetState: JobRequestState;
  },
): Promise<void> {
  await sql`
    INSERT INTO job_request_commands (
      command_id, job_request_id, customer_profile_id, actor_user_id,
      command_kind, expected_revision, resulting_revision, target_state,
      submission_eligibility_revision, payload_fingerprint
    ) VALUES (
      ${input.commandId}, ${input.jobRequestId}, ${input.customerProfileId},
      ${input.actorUserId}, ${input.commandKind}, ${input.expectedRevision},
      ${input.expectedRevision + 1}, ${input.targetState},
      ${input.commandKind === "ACTIVATE" ? input.expectedRevision : null},
      ${input.fingerprint}
    )
  `;
}

async function insertRevision(
  sql: TransactionSql,
  input: {
    readonly commandId: string;
    readonly jobRequestId: JobRequestId;
    readonly revision: number;
    readonly state: JobRequestState;
  },
): Promise<void> {
  await sql`
    INSERT INTO job_request_revisions (
      job_request_id, revision, command_id, state, changed_at, activated_at
    ) VALUES (
      ${input.jobRequestId}, ${input.revision}, ${input.commandId},
      ${input.state}, clock_timestamp(),
      ${input.state === "ACTIVE" ? new Date(0) : null}
    )
  `;
}

function commandFingerprint(
  kind: "CREATE_DRAFT" | "ACTIVATE",
  input: {
    readonly actorUserId: UserId;
    readonly expectedRevision?: number;
    readonly jobRequestId?: JobRequestId;
  },
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        actorUserId: input.actorUserId,
        expectedRevision: input.expectedRevision ?? null,
        jobRequestId: input.jobRequestId ?? null,
        kind,
      }),
    )
    .digest("hex");
}

function toRecord(row: CurrentRow): JobRequest {
  return Object.freeze({
    activatedAt: row.activatedAt,
    changedAt: row.changedAt,
    createdAt: row.createdAt,
    customerProfileId: row.customerProfileId,
    id: row.id,
    revision: row.revision,
    state: row.state,
  });
}

function assertUuid(value: unknown, field: string): void {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    throw new TypeError(`Job request ${field} must be a UUID.`);
  }
}
