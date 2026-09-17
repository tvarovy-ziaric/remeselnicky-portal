import { createHash } from "node:crypto";

import type { PrivilegedActor } from "@portal/admin-auth";
import { auditActorFromPrivilegedActor } from "@portal/audit";
import type { Sql, TransactionSql } from "postgres";

import { createAuditRepository } from "./audit-repository.js";

type RootSql = Sql | TransactionSql;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface ForceCompleteJobInput {
  readonly actor: PrivilegedActor;
  readonly privilegedSessionId: string;
  readonly commandId: string;
  readonly jobId: string;
  readonly expectedState: "IN_PROGRESS" | "COMPLETION_REQUESTED";
  readonly reason: string;
}

export type ForceCompleteJobResult =
  | Readonly<{
      status: "APPLIED" | "DEDUPLICATED";
      commandId: string;
      recordedAt: Date;
    }>
  | Readonly<{ status: "NOT_FOUND" | "STALE_STATE" }>;

export class AdminJobCompletionIdempotencyError extends Error {}

export function createAdminJobCompletionRepository(sql: RootSql) {
  return Object.freeze({
    async forceComplete(
      input: ForceCompleteJobInput,
    ): Promise<ForceCompleteJobResult> {
      if (
        !uuid.test(input.commandId) ||
        !uuid.test(input.jobId) ||
        !uuid.test(input.actor.userId) ||
        !["IN_PROGRESS", "COMPLETION_REQUESTED"].includes(
          input.expectedState,
        ) ||
        typeof input.reason !== "string" ||
        input.reason !== input.reason.trim() ||
        input.reason.length < 8 ||
        input.reason.length > 500 ||
        /[\p{Cc}]/u.test(input.reason) ||
        /(?:[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|https?:\/\/|bearer\s+\S+|(?:\+?\d[\d ().-]{6,}\d))/iu.test(
          input.reason,
        ) ||
        typeof input.privilegedSessionId !== "string" ||
        input.privilegedSessionId.length < 16
      )
        throw new TypeError("Invalid administrative completion command.");
      auditActorFromPrivilegedActor(input.actor, "admin.jobs.correct");
      const fingerprint = digest(
        JSON.stringify({
          jobId: input.jobId,
          actorUserId: input.actor.userId,
          expectedState: input.expectedState,
          reason: input.reason,
        }),
      );
      return transaction(sql, async (tx) => {
        const [job] = await tx<Array<{ id: string; state: string }>>`
          SELECT job.id, state.state::text AS state FROM jobs job
          JOIN current_job_states state ON state.job_id = job.id
          JOIN job_acceptance_events accepted ON accepted.job_id = job.id
          JOIN job_agreement_snapshots snapshot ON snapshot.job_id = job.id
          WHERE job.id = ${input.jobId} FOR UPDATE OF job
        `;
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
          FROM job_admin_completion_commands WHERE command_id = ${input.commandId}
        `;
        if (existing) {
          if (existing.actorUserId !== input.actor.userId)
            return { status: "NOT_FOUND" };
          if (
            existing.jobId !== input.jobId ||
            existing.payloadFingerprint !== fingerprint
          )
            throw new AdminJobCompletionIdempotencyError(
              "Administrative command ID reused.",
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
          INSERT INTO job_admin_completion_commands (
            command_id, job_id, actor_user_id, actor_privileged_session_hash,
            expected_state, reason, payload_fingerprint, audit_event_id
          ) VALUES (
            ${input.commandId}, ${input.jobId}, ${input.actor.userId},
            ${digest(input.privilegedSessionId)}, ${input.expectedState},
            ${input.reason}, ${fingerprint}, ${auditEventId}
          ) RETURNING recorded_at AS "recordedAt"
        `;
        if (!inserted)
          throw new Error("Administrative completion effect missing.");
        await createAuditRepository(tx).append({
          action: "admin.job.force_completed",
          actor: auditActorFromPrivilegedActor(
            input.actor,
            "admin.jobs.correct",
          ),
          category: "PRIVILEGED_COMMAND",
          changes: {
            job_state: { before: input.expectedState, after: "COMPLETED" },
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

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function auditId(commandId: string): string {
  const hex = digest(`job-force-completion-audit:${commandId}`);
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
