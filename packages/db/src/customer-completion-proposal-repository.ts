import { createHash } from "node:crypto";

import type { Sql, TransactionSql } from "postgres";

type RootSql = Sql | TransactionSql;
type Decision = "AGREE" | "DISAGREE";
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface ProposeCompletionInput {
  readonly actorUserId: string;
  readonly commandId: string;
  readonly jobId: string;
  readonly note?: string | null;
}
export interface DecideCompletionProposalInput {
  readonly actorUserId: string;
  readonly commandId: string;
  readonly jobId: string;
  readonly proposalId: string;
  readonly reason?: string;
}
export interface CompletionProposal {
  readonly id: string;
  readonly proposalNumber: number;
  readonly proposedAt: Date;
  readonly note: string | null;
  readonly outcome: "PENDING" | Decision;
  readonly decidedAt: Date | null;
  readonly disagreementReason: string | null;
}
export type CompletionProposalResult =
  | Readonly<{
      status: "APPLIED" | "DEDUPLICATED";
      proposalId: string;
      recordedAt: Date;
    }>
  | Readonly<{ status: "NOT_FOUND" | "STALE_STATE" | "STALE_PROPOSAL" }>;

export class CompletionProposalIdempotencyError extends Error {}

interface ExistingCommand {
  readonly actorUserId: string;
  readonly jobId: string;
  readonly proposalId: string;
  readonly kind: "PROPOSE" | Decision;
  readonly payloadFingerprint: string;
  readonly recordedAt: Date;
}
interface ProposalRow {
  readonly id: string;
  readonly proposalNumber: number;
  readonly proposedAt: Date;
  readonly note: string | null;
  readonly decisionKind: Decision | null;
  readonly decidedAt: Date | null;
  readonly reason: string | null;
}

export function createCustomerCompletionProposalRepository(sql: RootSql) {
  async function propose(
    input: ProposeCompletionInput,
  ): Promise<CompletionProposalResult> {
    validateIdentity(input);
    const note = optionalNote(input.note);
    const fingerprint = hash({
      kind: "PROPOSE",
      jobId: input.jobId,
      actorUserId: input.actorUserId,
      note,
    });
    return transaction(sql, async (tx) => {
      if (!(await lockOwnedJob(tx, input, "CUSTOMER")))
        return { status: "NOT_FOUND" };
      const existing = await existingCommand(tx, input.commandId);
      if (existing) return replay(existing, input, "PROPOSE", fingerprint);
      if ((await jobState(tx, input.jobId)) !== "IN_PROGRESS")
        return { status: "STALE_STATE" };
      if (await pendingProposal(tx, input.jobId))
        return { status: "STALE_PROPOSAL" };
      const [{ nextNumber } = { nextNumber: 1 }] = await tx<
        Array<{ nextNumber: number }>
      >`
        SELECT (coalesce(max(proposal_number), 0) + 1)::integer AS "nextNumber"
        FROM job_completion_proposals WHERE job_id = ${input.jobId}
      `;
      const [created] = await tx<Array<{ recordedAt: Date }>>`
        INSERT INTO job_completion_proposals (
          id, job_id, proposal_number, customer_user_id, note, payload_fingerprint
        ) VALUES (${input.commandId}, ${input.jobId}, ${nextNumber},
          ${input.actorUserId}, ${note}, ${fingerprint})
        RETURNING proposed_at AS "recordedAt"
      `;
      if (!created) throw new Error("Customer proposal effect missing.");
      return Object.freeze({
        status: "APPLIED" as const,
        proposalId: input.commandId,
        recordedAt: created.recordedAt,
      });
    });
  }

  async function decide(
    kind: Decision,
    input: DecideCompletionProposalInput,
  ): Promise<CompletionProposalResult> {
    validateIdentity(input);
    if (!uuid.test(input.proposalId))
      throw new TypeError("Invalid customer proposal ID.");
    const reason = kind === "DISAGREE" ? requiredReason(input.reason) : null;
    if (kind === "AGREE" && input.reason !== undefined)
      throw new TypeError("Agreement cannot contain a disagreement reason.");
    const fingerprint = hash({
      kind,
      jobId: input.jobId,
      actorUserId: input.actorUserId,
      proposalId: input.proposalId,
      reason,
    });
    return transaction(sql, async (tx) => {
      if (!(await lockOwnedJob(tx, input, "PRIMARY_PROVIDER")))
        return { status: "NOT_FOUND" };
      const existing = await existingCommand(tx, input.commandId);
      if (existing) return replay(existing, input, kind, fingerprint);
      if ((await jobState(tx, input.jobId)) !== "IN_PROGRESS")
        return { status: "STALE_STATE" };
      const pending = await pendingProposal(tx, input.jobId);
      if (!pending || pending.id !== input.proposalId)
        return { status: "STALE_PROPOSAL" };
      const [created] = await tx<Array<{ recordedAt: Date }>>`
        INSERT INTO job_completion_proposal_decisions (
          id, proposal_id, kind, provider_user_id, reason, payload_fingerprint
        ) VALUES (${input.commandId}, ${input.proposalId}, ${kind},
          ${input.actorUserId}, ${reason}, ${fingerprint})
        RETURNING decided_at AS "recordedAt"
      `;
      if (!created) throw new Error("Proposal decision effect missing.");
      return Object.freeze({
        status: "APPLIED" as const,
        proposalId: input.proposalId,
        recordedAt: created.recordedAt,
      });
    });
  }

  async function list(input: {
    readonly actorUserId: string;
    readonly jobId: string;
  }): Promise<readonly CompletionProposal[] | null> {
    validateIdentity(input);
    return transaction(sql, async (tx) => {
      if (!(await lockOwnedJob(tx, input, "EITHER", false))) return null;
      const rows = await tx<ProposalRow[]>`
        SELECT proposal.id, proposal.proposal_number AS "proposalNumber",
          proposal.proposed_at AS "proposedAt", proposal.note,
          decision.kind::text AS "decisionKind",
          decision.decided_at AS "decidedAt", decision.reason
        FROM job_completion_proposals proposal
        LEFT JOIN job_completion_proposal_decisions decision
          ON decision.proposal_id = proposal.id
        WHERE proposal.job_id = ${input.jobId}
        ORDER BY proposal.proposal_number DESC
      `;
      return Object.freeze(
        rows.map((row) =>
          Object.freeze({
            id: row.id,
            proposalNumber: row.proposalNumber,
            proposedAt: row.proposedAt,
            note: row.note,
            outcome: row.decisionKind ?? "PENDING",
            decidedAt: row.decidedAt,
            disagreementReason:
              row.decisionKind === "DISAGREE" ? row.reason : null,
          }),
        ),
      );
    });
  }

  return Object.freeze({
    propose,
    agree: (input: DecideCompletionProposalInput) => decide("AGREE", input),
    disagree: (input: DecideCompletionProposalInput) =>
      decide("DISAGREE", input),
    list,
  });
}

export type CustomerCompletionProposalRepository = ReturnType<
  typeof createCustomerCompletionProposalRepository
>;

function validateIdentity(input: {
  readonly actorUserId: string;
  readonly jobId: string;
  readonly commandId?: string;
}): void {
  if (
    !uuid.test(input.actorUserId) ||
    !uuid.test(input.jobId) ||
    (input.commandId !== undefined && !uuid.test(input.commandId))
  )
    throw new TypeError("Invalid completion proposal identity.");
}
function optionalNote(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length < 1 ||
    value.length > 1000 ||
    control(value)
  )
    throw new TypeError("Invalid completion proposal note.");
  return value;
}
function requiredReason(value: unknown): string {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length < 8 ||
    value.length > 1000 ||
    control(value)
  )
    throw new TypeError("Invalid completion disagreement reason.");
  return value;
}
function control(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}
function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
async function lockOwnedJob(
  tx: TransactionSql,
  input: { readonly jobId: string; readonly actorUserId: string },
  role: "CUSTOMER" | "PRIMARY_PROVIDER" | "EITHER",
  lock = true,
): Promise<boolean> {
  const rows = await tx<Array<{ id: string }>>`
    SELECT job.id FROM jobs job
    JOIN customer_profiles customer ON customer.id = job.customer_profile_id
    JOIN craftsman_profiles provider ON provider.id = job.primary_craftsman_profile_id
    JOIN job_acceptance_events accepted ON accepted.job_id = job.id
    JOIN job_agreement_snapshots snapshot ON snapshot.job_id = job.id
    JOIN users actor ON actor.id = ${input.actorUserId} AND actor.account_state = 'ACTIVE'
    JOIN auth_credentials auth ON auth.user_id = actor.id
      AND auth.email_verified_at IS NOT NULL AND auth.phone_verified_at IS NOT NULL
    WHERE job.id = ${input.jobId}
      AND ((${role} IN ('CUSTOMER', 'EITHER') AND customer.owner_user_id = actor.id)
        OR (${role} IN ('PRIMARY_PROVIDER', 'EITHER') AND provider.owner_user_id = actor.id))
  `;
  if (!rows[0]) return false;
  if (lock) await tx`SELECT id FROM jobs WHERE id = ${input.jobId} FOR UPDATE`;
  else await tx`SELECT id FROM jobs WHERE id = ${input.jobId} FOR SHARE`;
  return true;
}
async function jobState(
  tx: TransactionSql,
  jobId: string,
): Promise<string | null> {
  const [row] = await tx<Array<{ state: string }>>`
    SELECT state::text FROM current_job_states WHERE job_id = ${jobId}
  `;
  return row?.state ?? null;
}
async function pendingProposal(
  tx: TransactionSql,
  jobId: string,
): Promise<{ id: string } | undefined> {
  const [row] = await tx<Array<{ id: string }>>`
    SELECT proposal.id FROM job_completion_proposals proposal
    LEFT JOIN job_completion_proposal_decisions decision
      ON decision.proposal_id = proposal.id
    WHERE proposal.job_id = ${jobId} AND decision.id IS NULL
    ORDER BY proposal.proposal_number DESC LIMIT 1
  `;
  return row;
}
async function existingCommand(
  tx: TransactionSql,
  commandId: string,
): Promise<ExistingCommand | undefined> {
  const [row] = await tx<ExistingCommand[]>`
    SELECT proposal.customer_user_id AS "actorUserId", proposal.job_id AS "jobId",
      proposal.id AS "proposalId", 'PROPOSE'::text AS kind,
      proposal.payload_fingerprint AS "payloadFingerprint",
      proposal.proposed_at AS "recordedAt"
    FROM job_completion_proposals proposal WHERE proposal.id = ${commandId}
    UNION ALL
    SELECT decision.provider_user_id, proposal.job_id, decision.proposal_id,
      decision.kind::text, decision.payload_fingerprint, decision.decided_at
    FROM job_completion_proposal_decisions decision
    JOIN job_completion_proposals proposal ON proposal.id = decision.proposal_id
    WHERE decision.id = ${commandId}
  `;
  return row;
}
function replay(
  existing: ExistingCommand,
  input: {
    readonly actorUserId: string;
    readonly jobId: string;
    readonly proposalId?: string;
  },
  kind: "PROPOSE" | Decision,
  fingerprint: string,
): CompletionProposalResult {
  if (existing.actorUserId !== input.actorUserId)
    return { status: "NOT_FOUND" };
  if (
    existing.jobId !== input.jobId ||
    existing.kind !== kind ||
    existing.payloadFingerprint !== fingerprint ||
    (input.proposalId !== undefined && existing.proposalId !== input.proposalId)
  )
    throw new CompletionProposalIdempotencyError(
      "Completion proposal command ID reused.",
    );
  return Object.freeze({
    status: "DEDUPLICATED",
    proposalId: existing.proposalId,
    recordedAt: existing.recordedAt,
  });
}
function transaction<T>(
  sql: RootSql,
  callback: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return ("savepoint" in sql
    ? sql.savepoint(callback)
    : sql.begin(callback)) as unknown as Promise<T>;
}
