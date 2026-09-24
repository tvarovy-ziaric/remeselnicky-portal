import { createHash } from "node:crypto";

import type { PrivilegedActor } from "@portal/admin-auth";
import { auditActorFromPrivilegedActor } from "@portal/audit";
import type { Sql, TransactionSql } from "postgres";

import { createAuditRepository } from "./audit-repository.js";

type RootSql = Sql | TransactionSql;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const unsafeReason =
  /(?:[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|https?:\/\/|bearer\s+\S+|(?:\+?\d[\d ().-]{6,}\d))/iu;

export interface ForceCancelJobInput {
  readonly actor: PrivilegedActor;
  readonly privilegedSessionId: string;
  readonly commandId: string;
  readonly jobId: string;
  readonly expectedState: "CONFIRMED" | "IN_PROGRESS" | "COMPLETION_REQUESTED";
  readonly reason: string;
  readonly userFacingReason: string;
}

export type ForceCancelJobResult =
  | Readonly<{
      status: "APPLIED" | "DEDUPLICATED";
      commandId: string;
      recordedAt: Date;
    }>
  | Readonly<{ status: "NOT_FOUND" | "STALE_STATE" }>;

export class AdminJobCancellationIdempotencyError extends Error {}

export function createAdminJobCancellationRepository(sql: RootSql) {
  return Object.freeze({
    async forceCancel(
      input: ForceCancelJobInput,
    ): Promise<ForceCancelJobResult> {
      validate(input);
      auditActorFromPrivilegedActor(input.actor, "admin.jobs.correct");
      const fingerprint = digest(
        JSON.stringify({
          actorUserId: input.actor.userId,
          expectedState: input.expectedState,
          jobId: input.jobId,
          reason: input.reason,
          userFacingReason: input.userFacingReason,
        }),
      );
      return transaction(sql, async (tx) => {
        const [job] = await tx<Array<{ id: string; state: string }>>`
          SELECT job.id, state.state::text AS state FROM jobs job
          JOIN current_job_states state ON state.job_id = job.id
          JOIN job_acceptance_events accepted ON accepted.job_id = job.id
          JOIN job_agreement_snapshots snapshot ON snapshot.job_id = job.id
          WHERE job.id = ${input.jobId} FOR UPDATE OF job`;
        if (!job) return { status: "NOT_FOUND" };
        const [existing] = await tx<
          Array<{
            actorUserId: string;
            jobId: string;
            payloadFingerprint: string;
            recordedAt: Date;
          }>
        >`
          SELECT actor_user_id AS "actorUserId", job_id AS "jobId",
            payload_fingerprint AS "payloadFingerprint",
            recorded_at AS "recordedAt"
          FROM job_admin_cancellation_commands
          WHERE command_id = ${input.commandId}`;
        if (existing) {
          if (existing.actorUserId !== input.actor.userId)
            return { status: "NOT_FOUND" };
          if (
            existing.jobId !== input.jobId ||
            existing.payloadFingerprint !== fingerprint
          )
            throw new AdminJobCancellationIdempotencyError(
              "Administrative cancellation command ID reused.",
            );
          return {
            status: "DEDUPLICATED",
            commandId: input.commandId,
            recordedAt: existing.recordedAt,
          };
        }
        if (job.state !== input.expectedState) return { status: "STALE_STATE" };
        const auditEventId = auditId(input.commandId);
        const [inserted] = await tx<Array<{ recordedAt: Date }>>`
          INSERT INTO job_admin_cancellation_commands (
            command_id, job_id, actor_user_id, actor_privileged_session_hash,
            expected_state, reason, user_facing_reason,
            payload_fingerprint, audit_event_id
          ) VALUES (
            ${input.commandId}, ${input.jobId}, ${input.actor.userId},
            ${digest(input.privilegedSessionId)}, ${input.expectedState},
            ${input.reason}, ${input.userFacingReason}, ${fingerprint},
            ${auditEventId}
          ) RETURNING recorded_at AS "recordedAt"`;
        if (!inserted)
          throw new Error("Administrative cancellation effect missing.");
        await createAuditRepository(tx).append({
          action: "admin.job.force_cancelled",
          actor: auditActorFromPrivilegedActor(
            input.actor,
            "admin.jobs.correct",
          ),
          category: "PRIVILEGED_COMMAND",
          changes: {
            job_state: { before: input.expectedState, after: "CANCELLED" },
          },
          correlationId: input.commandId,
          eventId: auditEventId,
          reason: input.reason,
          target: { id: input.jobId, type: "JOB" },
        });
        return {
          status: "APPLIED",
          commandId: input.commandId,
          recordedAt: inserted.recordedAt,
        };
      });
    },
  });
}

function validate(input: ForceCancelJobInput): void {
  if (
    !uuid.test(input.commandId) ||
    !uuid.test(input.jobId) ||
    !uuid.test(input.actor.userId) ||
    !["CONFIRMED", "IN_PROGRESS", "COMPLETION_REQUESTED"].includes(
      input.expectedState,
    ) ||
    typeof input.privilegedSessionId !== "string" ||
    input.privilegedSessionId.length < 16 ||
    !bounded(input.reason, 8, 500) ||
    unsafeReason.test(input.reason) ||
    !bounded(input.userFacingReason, 8, 1000)
  )
    throw new TypeError("Invalid administrative cancellation command.");
}
function bounded(value: string, minimum: number, maximum: number): boolean {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length >= minimum &&
    value.length <= maximum &&
    !/[\p{Cc}]/u.test(value)
  );
}
function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function auditId(commandId: string): string {
  const hex = digest(`job-force-cancellation-audit:${commandId}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function transaction<T>(
  sql: RootSql,
  callback: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return ("savepoint" in sql
    ? sql.savepoint(callback)
    : sql.begin(callback)) as unknown as Promise<T>;
}
