import { randomUUID } from "node:crypto";

import type { Sql, TransactionSql } from "postgres";

import { createJobMilestoneRepository } from "./job-milestone-repository.js";

type RootSql = Sql | TransactionSql;
type Decision = "ACCEPT" | "DECLINE";
type Role = "CUSTOMER" | "PRIMARY_PROVIDER" | "PARTICIPANT";
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const control = /[\p{Cc}]/u;
const day = /^\d{4}-\d{2}-\d{2}$/u;

export interface JobMilestoneProposalInput {
  readonly actorUserId: string;
  readonly commandId: string;
  readonly jobId: string;
  readonly targetMilestoneId?: string | null;
  readonly title: string;
  readonly description?: string | null;
  readonly plannedStartOn?: string | null;
  readonly plannedEndOn?: string | null;
}
export interface JobMilestoneDecisionInput {
  readonly actorUserId: string;
  readonly commandId: string;
  readonly jobId: string;
  readonly proposalId: string;
  readonly decision: Decision;
}
export interface JobMilestoneCommentInput {
  readonly actorUserId: string;
  readonly commandId: string;
  readonly jobId: string;
  readonly milestoneId: string;
  readonly body: string;
}
export interface JobMilestoneMediaInput {
  readonly actorUserId: string;
  readonly commandId: string;
  readonly jobId: string;
  readonly milestoneId: string;
  readonly mediaAssetId: string;
}
export type JobMilestoneContextResult =
  | Readonly<{
      status: "APPLIED" | "DEDUPLICATED";
      id: string;
      createdAt: Date;
      appliedMilestoneId?: string | null;
    }>
  | Readonly<{ status: "NOT_FOUND" | "STALE_STATE" }>;
export interface JobMilestoneProposal {
  readonly id: string;
  readonly jobId: string;
  readonly targetMilestoneId: string | null;
  readonly baselineEventId: string | null;
  readonly title: string;
  readonly description: string | null;
  readonly plannedStartOn: string | null;
  readonly plannedEndOn: string | null;
  readonly createdAt: Date;
  readonly decision: Decision | null;
  readonly decidedAt: Date | null;
  readonly appliedMilestoneId: string | null;
  readonly canDecide: boolean;
}
export interface JobMilestoneComment {
  readonly id: string;
  readonly milestoneId: string;
  readonly authorRole: Role;
  readonly body: string;
  readonly createdAt: Date;
}
export interface JobMilestoneMedia {
  readonly id: string;
  readonly milestoneId: string;
  readonly mediaAssetId: string;
  readonly kind: "PHOTO" | "DOCUMENT";
  readonly sourceMessageId: string;
  readonly uploadedByUserId: string;
  readonly uploadedAt: Date;
  readonly capturedAt: Date | null;
  readonly displayFilename: string | null;
  readonly contentType: string;
  readonly downloadPath: string;
  readonly linkedAt: Date;
}
export interface JobMilestoneContextPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: Readonly<{ createdAt: Date; id: string }> | null;
}
export class JobMilestoneContextIdempotencyError extends Error {}

interface Party {
  readonly role: Role;
  readonly state: string;
  readonly canPlan: boolean;
}
interface ProposalRow {
  readonly id: string;
  readonly jobId: string;
  readonly targetMilestoneId: string | null;
  readonly baselineEventId: string | null;
  readonly customerUserId: string;
  readonly title: string;
  readonly description: string | null;
  readonly plannedStartOn: string | null;
  readonly plannedEndOn: string | null;
  readonly createdAt: Date;
  readonly decision: Decision | null;
  readonly decidedAt: Date | null;
  readonly appliedMilestoneId: string | null;
}
interface ExistingCommand {
  readonly kind: "PROPOSAL" | "DECISION" | "COMMENT" | "MEDIA" | "CORE";
  readonly actorUserId: string;
  readonly jobId: string;
}

export function createJobMilestoneContextRepository(sql: RootSql) {
  return Object.freeze({
    async createProposal(
      input: JobMilestoneProposalInput,
    ): Promise<JobMilestoneContextResult> {
      validateIds(input.actorUserId, input.commandId, input.jobId);
      if (input.targetMilestoneId != null) validateIds(input.targetMilestoneId);
      const title = text(input.title, 160);
      const description = optionalText(input.description, 2000);
      const plannedStartOn = optionalDay(input.plannedStartOn);
      const plannedEndOn = optionalDay(input.plannedEndOn);
      validateRange(plannedStartOn, plannedEndOn);
      return transaction(sql, async (tx) => {
        const party = await authorize(tx, input.actorUserId, input.jobId, true);
        if (party?.role !== "CUSTOMER") return { status: "NOT_FOUND" };
        await lockCommand(tx, input.commandId);
        const prior = await existingCommand(tx, input.commandId);
        if (prior) {
          if (
            prior.actorUserId !== input.actorUserId ||
            prior.jobId !== input.jobId
          )
            return { status: "NOT_FOUND" };
          if (prior.kind !== "PROPOSAL") throw conflict();
          const row = await loadProposal(tx, input.jobId, input.commandId);
          if (
            !row ||
            row.targetMilestoneId !== (input.targetMilestoneId ?? null) ||
            row.title !== title ||
            row.description !== description ||
            row.plannedStartOn !== plannedStartOn ||
            row.plannedEndOn !== plannedEndOn
          )
            throw conflict();
          return {
            status: "DEDUPLICATED",
            id: row.id,
            createdAt: row.createdAt,
          };
        }
        if (!open(party.state)) return { status: "STALE_STATE" };
        const targetMilestoneId = input.targetMilestoneId ?? null;
        let baselineEventId: string | null = null;
        if (targetMilestoneId !== null) {
          const [current] = await tx<Array<{ eventId: string }>>`
            SELECT event_id AS "eventId" FROM current_job_milestones
            WHERE id = ${targetMilestoneId} AND job_id = ${input.jobId}
          `;
          if (!current) return { status: "NOT_FOUND" };
          baselineEventId = current.eventId;
        }
        const [created] = await tx<Array<{ createdAt: Date }>>`
          INSERT INTO job_milestone_proposals
            (id, job_id, target_milestone_id, baseline_event_id, customer_user_id,
              title, description, planned_start_date, planned_end_date)
          VALUES (${input.commandId}, ${input.jobId}, ${targetMilestoneId}::uuid,
            ${baselineEventId}::uuid, ${input.actorUserId}, ${title}, ${description},
            ${plannedStartOn}::date, ${plannedEndOn}::date)
          RETURNING created_at AS "createdAt"
        `;
        if (!created) throw new Error("Milestone proposal insert missing.");
        return {
          status: "APPLIED",
          id: input.commandId,
          createdAt: created.createdAt,
        };
      });
    },
    async decideProposal(
      input: JobMilestoneDecisionInput,
    ): Promise<JobMilestoneContextResult> {
      validateIds(
        input.actorUserId,
        input.commandId,
        input.jobId,
        input.proposalId,
      );
      if (!["ACCEPT", "DECLINE"].includes(input.decision))
        throw new TypeError("Invalid milestone proposal decision.");
      return transaction(sql, async (tx) => {
        const party = await authorize(tx, input.actorUserId, input.jobId, true);
        if (!party?.canPlan) return { status: "NOT_FOUND" };
        await lockCommand(tx, input.commandId);
        const prior = await existingCommand(tx, input.commandId);
        if (prior) {
          if (
            prior.actorUserId !== input.actorUserId ||
            prior.jobId !== input.jobId
          )
            return { status: "NOT_FOUND" };
          if (prior.kind !== "DECISION") throw conflict();
          const [row] = await tx<
            Array<{
              proposalId: string;
              decision: Decision;
              appliedMilestoneId: string | null;
              createdAt: Date;
            }>
          >`
            SELECT decision.proposal_id AS "proposalId", decision.decision::text AS decision,
              event.milestone_id AS "appliedMilestoneId", decision.decided_at AS "createdAt"
            FROM job_milestone_proposal_decisions decision
            LEFT JOIN job_milestone_events event ON event.event_id = decision.applied_event_id
            WHERE decision.id = ${input.commandId}
          `;
          if (
            !row ||
            row.proposalId !== input.proposalId ||
            row.decision !== input.decision
          )
            throw conflict();
          return {
            status: "DEDUPLICATED",
            id: input.commandId,
            createdAt: row.createdAt,
            appliedMilestoneId: row.appliedMilestoneId,
          };
        }
        if (!open(party.state)) return { status: "STALE_STATE" };
        const proposal = await loadProposal(tx, input.jobId, input.proposalId);
        if (!proposal) return { status: "NOT_FOUND" };
        if (proposal.decision !== null) return { status: "STALE_STATE" };
        let appliedEventId: string | null = null;
        let appliedMilestoneId: string | null = null;
        if (input.decision === "ACCEPT") {
          if (proposal.targetMilestoneId !== null) {
            const [current] = await tx<Array<{ eventId: string }>>`
              SELECT event_id AS "eventId" FROM current_job_milestones
              WHERE job_id = ${input.jobId} AND id = ${proposal.targetMilestoneId}
            `;
            if (!current || current.eventId !== proposal.baselineEventId)
              return { status: "STALE_STATE" };
          }
          appliedEventId = randomUUID();
          const plan = createJobMilestoneRepository(tx);
          const outcome =
            proposal.targetMilestoneId === null
              ? await plan.createMilestone({
                  actorUserId: input.actorUserId,
                  commandId: appliedEventId,
                  jobId: input.jobId,
                  title: proposal.title,
                  description: proposal.description,
                  plannedStartOn: proposal.plannedStartOn,
                  plannedEndOn: proposal.plannedEndOn,
                })
              : await plan.editMilestone({
                  actorUserId: input.actorUserId,
                  commandId: appliedEventId,
                  jobId: input.jobId,
                  milestoneId: proposal.targetMilestoneId,
                  title: proposal.title,
                  description: proposal.description,
                  plannedStartOn: proposal.plannedStartOn,
                  plannedEndOn: proposal.plannedEndOn,
                });
          if (outcome.status !== "APPLIED")
            return {
              status:
                outcome.status === "NOT_FOUND" ? "NOT_FOUND" : "STALE_STATE",
            };
          appliedMilestoneId = outcome.id;
        }
        const [created] = await tx<Array<{ createdAt: Date }>>`
          INSERT INTO job_milestone_proposal_decisions
            (id, proposal_id, actor_user_id, decision, applied_event_id)
          VALUES (${input.commandId}, ${input.proposalId}, ${input.actorUserId},
            ${input.decision}::job_milestone_proposal_decision, ${appliedEventId}::uuid)
          RETURNING decided_at AS "createdAt"
        `;
        if (!created)
          throw new Error("Milestone proposal decision insert missing.");
        return {
          status: "APPLIED",
          id: input.commandId,
          createdAt: created.createdAt,
          appliedMilestoneId,
        };
      });
    },
    async listProposals(
      input: ListInput,
    ): Promise<JobMilestoneContextPage<JobMilestoneProposal> | null> {
      validateList(input);
      return transaction(sql, async (tx) => {
        const party = await authorize(
          tx,
          input.actorUserId,
          input.jobId,
          false,
        );
        if (!party) return null;
        const rows = await tx<ProposalRow[]>`
          SELECT proposal.id, proposal.job_id AS "jobId",
            proposal.target_milestone_id AS "targetMilestoneId",
            proposal.baseline_event_id AS "baselineEventId",
            proposal.customer_user_id AS "customerUserId", proposal.title, proposal.description,
            proposal.planned_start_date::text AS "plannedStartOn",
            proposal.planned_end_date::text AS "plannedEndOn",
            proposal.created_at AS "createdAt", decision.decision::text AS decision,
            decision.decided_at AS "decidedAt", event.milestone_id AS "appliedMilestoneId"
          FROM job_milestone_proposals proposal
          LEFT JOIN job_milestone_proposal_decisions decision ON decision.proposal_id = proposal.id
          LEFT JOIN job_milestone_events event ON event.event_id = decision.applied_event_id
          WHERE proposal.job_id = ${input.jobId}
            AND (${input.cursor?.createdAt ?? null}::timestamptz IS NULL
              OR (proposal.created_at, proposal.id) <
                (${input.cursor?.createdAt ?? null}::timestamptz, ${input.cursor?.id ?? null}::uuid))
          ORDER BY proposal.created_at DESC, proposal.id DESC LIMIT ${input.limit + 1}
        `;
        return page(
          rows.map((row) => proposalItem(row, party)),
          input.limit,
          (row) => row.createdAt,
        );
      });
    },
    async getProposal(input: {
      readonly actorUserId: string;
      readonly jobId: string;
      readonly proposalId: string;
    }): Promise<JobMilestoneProposal | null> {
      validateIds(input.actorUserId, input.jobId, input.proposalId);
      return transaction(sql, async (tx) => {
        const party = await authorize(
          tx,
          input.actorUserId,
          input.jobId,
          false,
        );
        if (!party) return null;
        const row = await loadProposal(tx, input.jobId, input.proposalId);
        return row ? proposalItem(row, party) : null;
      });
    },
    async addComment(
      input: JobMilestoneCommentInput,
    ): Promise<JobMilestoneContextResult> {
      validateIds(
        input.actorUserId,
        input.commandId,
        input.jobId,
        input.milestoneId,
      );
      const body = text(input.body, 2000);
      return transaction(sql, async (tx) => {
        const party = await authorize(tx, input.actorUserId, input.jobId, true);
        if (!party) return { status: "NOT_FOUND" };
        await lockCommand(tx, input.commandId);
        const prior = await existingCommand(tx, input.commandId);
        if (prior) {
          if (
            prior.actorUserId !== input.actorUserId ||
            prior.jobId !== input.jobId
          )
            return { status: "NOT_FOUND" };
          if (prior.kind !== "COMMENT") throw conflict();
          const [row] = await tx<
            Array<{ milestoneId: string; body: string; createdAt: Date }>
          >`
            SELECT milestone_id AS "milestoneId", body, created_at AS "createdAt"
            FROM job_milestone_comments WHERE id = ${input.commandId}
          `;
          if (
            !row ||
            row.milestoneId !== input.milestoneId ||
            row.body !== body
          )
            throw conflict();
          return {
            status: "DEDUPLICATED",
            id: input.commandId,
            createdAt: row.createdAt,
          };
        }
        if (!open(party.state)) return { status: "STALE_STATE" };
        if (!(await milestoneExists(tx, input.jobId, input.milestoneId)))
          return { status: "NOT_FOUND" };
        const [row] = await tx<Array<{ createdAt: Date }>>`
          INSERT INTO job_milestone_comments (id, milestone_id, author_user_id, author_role, body)
          VALUES (${input.commandId}, ${input.milestoneId}, ${input.actorUserId},
            ${party.role}, ${body}) RETURNING created_at AS "createdAt"
        `;
        if (!row) throw new Error("Milestone comment insert missing.");
        return {
          status: "APPLIED",
          id: input.commandId,
          createdAt: row.createdAt,
        };
      });
    },
    async listComments(
      input: ListInput & { readonly milestoneId: string },
    ): Promise<JobMilestoneContextPage<JobMilestoneComment> | null> {
      validateList(input);
      validateIds(input.milestoneId);
      return transaction(sql, async (tx) => {
        if (
          !(await authorize(tx, input.actorUserId, input.jobId, false)) ||
          !(await milestoneExists(tx, input.jobId, input.milestoneId))
        )
          return null;
        const rows = await tx<JobMilestoneComment[]>`
          SELECT id, milestone_id AS "milestoneId", author_role AS "authorRole",
            body, created_at AS "createdAt"
          FROM job_milestone_comments WHERE milestone_id = ${input.milestoneId}
            AND (${input.cursor?.createdAt ?? null}::timestamptz IS NULL
              OR (created_at, id) < (${input.cursor?.createdAt ?? null}::timestamptz,
                ${input.cursor?.id ?? null}::uuid))
          ORDER BY created_at DESC, id DESC LIMIT ${input.limit + 1}
        `;
        return page(rows, input.limit, (row) => row.createdAt);
      });
    },
    async linkMedia(
      input: JobMilestoneMediaInput,
    ): Promise<JobMilestoneContextResult> {
      validateIds(
        input.actorUserId,
        input.commandId,
        input.jobId,
        input.milestoneId,
        input.mediaAssetId,
      );
      return transaction(sql, async (tx) => {
        const party = await authorize(tx, input.actorUserId, input.jobId, true);
        if (!party || !["CUSTOMER", "PRIMARY_PROVIDER"].includes(party.role))
          return { status: "NOT_FOUND" };
        await lockCommand(tx, input.commandId);
        const prior = await existingCommand(tx, input.commandId);
        if (prior) {
          if (
            prior.actorUserId !== input.actorUserId ||
            prior.jobId !== input.jobId
          )
            return { status: "NOT_FOUND" };
          if (prior.kind !== "MEDIA") throw conflict();
          const [row] = await tx<
            Array<{
              milestoneId: string;
              mediaAssetId: string;
              createdAt: Date;
            }>
          >`
            SELECT milestone_id AS "milestoneId", media_asset_id AS "mediaAssetId",
              linked_at AS "createdAt" FROM job_milestone_media WHERE id = ${input.commandId}
          `;
          if (
            !row ||
            row.milestoneId !== input.milestoneId ||
            row.mediaAssetId !== input.mediaAssetId
          )
            throw conflict();
          return {
            status: "DEDUPLICATED",
            id: input.commandId,
            createdAt: row.createdAt,
          };
        }
        if (!open(party.state)) return { status: "STALE_STATE" };
        if (
          !(await milestoneExists(tx, input.jobId, input.milestoneId)) ||
          !(await centralMediaAvailable(tx, input.jobId, input.mediaAssetId))
        )
          return { status: "NOT_FOUND" };
        const [duplicate] = await tx<Array<{ id: string }>>`
          SELECT id FROM job_milestone_media
          WHERE milestone_id = ${input.milestoneId} AND media_asset_id = ${input.mediaAssetId}
        `;
        if (duplicate) return { status: "STALE_STATE" };
        const [row] = await tx<Array<{ createdAt: Date }>>`
          INSERT INTO job_milestone_media (id, milestone_id, media_asset_id, linked_by_user_id)
          VALUES (${input.commandId}, ${input.milestoneId}, ${input.mediaAssetId}, ${input.actorUserId})
          RETURNING linked_at AS "createdAt"
        `;
        if (!row) throw new Error("Milestone media insert missing.");
        return {
          status: "APPLIED",
          id: input.commandId,
          createdAt: row.createdAt,
        };
      });
    },
    async listMedia(
      input: ListInput & { readonly milestoneId: string },
    ): Promise<JobMilestoneContextPage<JobMilestoneMedia> | null> {
      validateList(input);
      validateIds(input.milestoneId);
      return transaction(sql, async (tx) => {
        const party = await authorize(
          tx,
          input.actorUserId,
          input.jobId,
          false,
        );
        if (
          !party ||
          !["CUSTOMER", "PRIMARY_PROVIDER"].includes(party.role) ||
          !(await milestoneExists(tx, input.jobId, input.milestoneId))
        )
          return null;
        const rows = await tx<
          Array<
            Omit<JobMilestoneMedia, "kind" | "downloadPath"> & {
              mediaKind: "IMAGE" | "DOCUMENT";
            }
          >
        >`
          SELECT link.id, link.milestone_id AS "milestoneId",
            link.media_asset_id AS "mediaAssetId", media.media_kind::text AS "mediaKind",
            media.source_message_id AS "sourceMessageId", media.uploaded_by_user_id AS "uploadedByUserId",
            media.uploaded_at AS "uploadedAt", media.captured_at AS "capturedAt",
            asset.display_filename AS "displayFilename", canonical.content_type AS "contentType",
            link.linked_at AS "linkedAt"
          FROM job_milestone_media link
          JOIN job_conversation_media media ON media.job_id = ${input.jobId}
            AND media.media_asset_id = link.media_asset_id
          JOIN media_assets asset ON asset.id = link.media_asset_id AND asset.status = 'READY'
            AND (asset.kind = 'IMAGE' OR asset.malware_scan_verdict = 'CLEAN')
          JOIN media_asset_storage_objects canonical ON canonical.media_asset_id = asset.id
            AND canonical.role = 'CANONICAL' AND canonical.storage_area = 'private'
            AND canonical.revoked_at IS NULL
          WHERE link.milestone_id = ${input.milestoneId}
            AND ((media.media_kind = 'IMAGE' AND asset.kind = 'IMAGE')
              OR (media.media_kind = 'DOCUMENT' AND asset.kind = 'DOCUMENT'
                AND canonical.content_type = 'application/pdf'))
            AND (${input.cursor?.createdAt ?? null}::timestamptz IS NULL
              OR (link.linked_at, link.id) < (${input.cursor?.createdAt ?? null}::timestamptz,
                ${input.cursor?.id ?? null}::uuid))
          ORDER BY link.linked_at DESC, link.id DESC LIMIT ${input.limit + 1}
        `;
        return page(
          rows.map((row) => {
            const { mediaKind, ...rest } = row;
            return {
              ...rest,
              kind:
                mediaKind === "IMAGE"
                  ? ("PHOTO" as const)
                  : ("DOCUMENT" as const),
              downloadPath: `/v1/media/${row.mediaAssetId}/download`,
            };
          }),
          input.limit,
          (row) => row.linkedAt,
        );
      });
    },
  });
}

interface ListInput {
  readonly actorUserId: string;
  readonly jobId: string;
  readonly limit: number;
  readonly cursor?: Readonly<{ createdAt: Date; id: string }>;
}

async function authorize(
  tx: TransactionSql,
  actorUserId: string,
  jobId: string,
  write: boolean,
): Promise<Party | null> {
  if (write) {
    const [job] = await tx<
      Array<{ id: string }>
    >`SELECT id FROM jobs WHERE id = ${jobId} FOR UPDATE`;
    if (!job) return null;
    await tx`SELECT id FROM users WHERE id = ${actorUserId} FOR SHARE`;
    await tx`SELECT user_id FROM auth_credentials WHERE user_id = ${actorUserId} FOR SHARE`;
  }
  const [party] = await tx<Party[]>`
    SELECT job_milestone_actor_role(${jobId}::uuid, ${actorUserId}::uuid) AS role,
      state.state::text AS state,
      job_milestone_can_plan(${jobId}::uuid, ${actorUserId}::uuid) AS "canPlan"
    FROM jobs job JOIN current_job_states state ON state.job_id = job.id
    WHERE job.id = ${jobId}
  `;
  return party?.role ? party : null;
}
async function loadProposal(
  tx: TransactionSql,
  jobId: string,
  proposalId: string,
): Promise<ProposalRow | null> {
  const [row] = await tx<ProposalRow[]>`
    SELECT proposal.id, proposal.job_id AS "jobId",
      proposal.target_milestone_id AS "targetMilestoneId",
      proposal.baseline_event_id AS "baselineEventId",
      proposal.customer_user_id AS "customerUserId", proposal.title, proposal.description,
      proposal.planned_start_date::text AS "plannedStartOn",
      proposal.planned_end_date::text AS "plannedEndOn",
      proposal.created_at AS "createdAt", decision.decision::text AS decision,
      decision.decided_at AS "decidedAt", event.milestone_id AS "appliedMilestoneId"
    FROM job_milestone_proposals proposal
    LEFT JOIN job_milestone_proposal_decisions decision ON decision.proposal_id = proposal.id
    LEFT JOIN job_milestone_events event ON event.event_id = decision.applied_event_id
    WHERE proposal.job_id = ${jobId} AND proposal.id = ${proposalId}
  `;
  return row ?? null;
}
async function milestoneExists(
  tx: TransactionSql,
  jobId: string,
  milestoneId: string,
): Promise<boolean> {
  const [row] = await tx<Array<{ id: string }>>`
    SELECT id FROM current_job_milestones WHERE job_id = ${jobId} AND id = ${milestoneId}
  `;
  return row !== undefined;
}
async function centralMediaAvailable(
  tx: TransactionSql,
  jobId: string,
  mediaAssetId: string,
): Promise<boolean> {
  const [row] = await tx<Array<{ id: string }>>`
    SELECT media.media_asset_id AS id FROM job_conversation_media media
    JOIN media_assets asset ON asset.id = media.media_asset_id AND asset.status = 'READY'
      AND (asset.kind = 'IMAGE' OR asset.malware_scan_verdict = 'CLEAN')
    JOIN media_asset_storage_objects canonical ON canonical.media_asset_id = asset.id
      AND canonical.role = 'CANONICAL' AND canonical.storage_area = 'private'
      AND canonical.revoked_at IS NULL
    WHERE media.job_id = ${jobId} AND media.media_asset_id = ${mediaAssetId}
      AND ((media.media_kind = 'IMAGE' AND asset.kind = 'IMAGE')
        OR (media.media_kind = 'DOCUMENT' AND asset.kind = 'DOCUMENT'
          AND canonical.content_type = 'application/pdf'))
  `;
  return row !== undefined;
}
async function existingCommand(
  tx: TransactionSql,
  id: string,
): Promise<ExistingCommand | null> {
  const rows = await tx<ExistingCommand[]>`
    SELECT 'PROPOSAL' AS kind, customer_user_id AS "actorUserId", job_id AS "jobId"
      FROM job_milestone_proposals WHERE id = ${id}
    UNION ALL SELECT 'DECISION', decision.actor_user_id, proposal.job_id
      FROM job_milestone_proposal_decisions decision
      JOIN job_milestone_proposals proposal ON proposal.id = decision.proposal_id
      WHERE decision.id = ${id}
    UNION ALL SELECT 'COMMENT', comment.author_user_id, milestone.job_id
      FROM job_milestone_comments comment JOIN job_milestones milestone ON milestone.id = comment.milestone_id
      WHERE comment.id = ${id}
    UNION ALL SELECT 'MEDIA', media.linked_by_user_id, milestone.job_id
      FROM job_milestone_media media JOIN job_milestones milestone ON milestone.id = media.milestone_id
      WHERE media.id = ${id}
    UNION ALL SELECT 'CORE', event.actor_user_id, milestone.job_id
      FROM job_milestone_events event JOIN job_milestones milestone ON milestone.id = event.milestone_id
      WHERE event.event_id = ${id}
    UNION ALL SELECT 'CORE', ack.customer_user_id, milestone.job_id
      FROM job_milestone_acknowledgements ack JOIN job_milestones milestone ON milestone.id = ack.milestone_id
      WHERE ack.id = ${id}
  `;
  if (rows.length > 1) throw new Error("Milestone command ID collision.");
  return rows[0] ?? null;
}
function proposalItem(row: ProposalRow, party: Party): JobMilestoneProposal {
  return {
    id: row.id,
    jobId: row.jobId,
    targetMilestoneId: row.targetMilestoneId,
    baselineEventId: row.baselineEventId,
    title: row.title,
    description: row.description,
    plannedStartOn: row.plannedStartOn,
    plannedEndOn: row.plannedEndOn,
    createdAt: row.createdAt,
    decision: row.decision,
    decidedAt: row.decidedAt,
    appliedMilestoneId: row.appliedMilestoneId,
    canDecide: row.decision === null && party.canPlan && open(party.state),
  };
}
function page<T extends { readonly id: string }>(
  rows: readonly T[],
  limit: number,
  at: (row: T) => Date,
): JobMilestoneContextPage<T> {
  const items = rows.slice(0, limit);
  const last = rows.length > limit ? items.at(-1) : undefined;
  return {
    items,
    nextCursor: last ? { createdAt: at(last), id: last.id } : null,
  };
}
function validateList(input: ListInput): void {
  validateIds(input.actorUserId, input.jobId);
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 50 ||
    (input.cursor &&
      (!(input.cursor.createdAt instanceof Date) ||
        !Number.isFinite(input.cursor.createdAt.getTime()) ||
        !uuid.test(input.cursor.id)))
  )
    throw new TypeError("Invalid milestone context page.");
}
function validateIds(...ids: string[]): void {
  if (ids.some((id) => typeof id !== "string" || !uuid.test(id)))
    throw new TypeError("Invalid milestone context identity.");
}
function text(value: string, max: number): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < 1 ||
    value.length > max ||
    control.test(value)
  )
    throw new TypeError("Invalid milestone context text.");
  return value;
}
function optionalText(
  value: string | null | undefined,
  max: number,
): string | null {
  return value == null ? null : text(value, max);
}
function optionalDay(value: string | null | undefined): string | null {
  if (value == null) return null;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  if (
    !day.test(value) ||
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString().slice(0, 10) !== value
  )
    throw new TypeError("Invalid milestone context date.");
  return value;
}
function validateRange(start: string | null, end: string | null): void {
  if (start && end && start > end)
    throw new TypeError("Invalid milestone context date range.");
}
function conflict(): JobMilestoneContextIdempotencyError {
  return new JobMilestoneContextIdempotencyError(
    "Milestone context command ID was reused for another intent.",
  );
}
function open(state: string): boolean {
  return state === "CONFIRMED" || state === "IN_PROGRESS";
}
async function lockCommand(tx: TransactionSql, id: string): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${id}::text, 51011))`;
}
function transaction<T>(
  sql: RootSql,
  work: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return ("savepoint" in sql
    ? sql.savepoint(work)
    : sql.begin(work)) as unknown as Promise<T>;
}
