import { randomUUID } from "node:crypto";

import type { Sql, TransactionSql } from "postgres";

type RootSql = Sql | TransactionSql;
export type JobMilestoneState = "PLANNED" | "IN_PROGRESS" | "DONE" | "SKIPPED";
export type JobMilestoneResponsibility = Readonly<{
  kind: "PARTICIPANT" | "WORK_GROUP";
  id: string;
}>;
export interface JobMilestoneCommand {
  readonly actorUserId: string;
  readonly commandId: string;
  readonly jobId: string;
  readonly milestoneId: string;
}
export interface CreateJobMilestoneInput {
  readonly actorUserId: string;
  readonly commandId: string;
  readonly jobId: string;
  readonly title: string;
  readonly description?: string | null;
  readonly plannedStartOn?: string | null;
  readonly plannedEndOn?: string | null;
  readonly acceptedStageLabel?: string | null;
  readonly responsibility?: JobMilestoneResponsibility | null;
}
export interface EditJobMilestoneInput extends JobMilestoneCommand {
  readonly title: string;
  readonly description: string | null;
  readonly plannedStartOn: string | null;
  readonly plannedEndOn: string | null;
}
export interface SetJobMilestoneStateInput extends JobMilestoneCommand {
  readonly state: JobMilestoneState;
}
export interface ReorderJobMilestoneInput extends JobMilestoneCommand {
  readonly afterMilestoneId: string | null;
}
export interface AssignJobMilestoneInput extends JobMilestoneCommand {
  readonly responsibility: JobMilestoneResponsibility | null;
}
export type JobMilestoneCommandResult =
  | Readonly<{
      status: "APPLIED" | "DEDUPLICATED";
      id: string;
      updatedAt: Date;
    }>
  | Readonly<{ status: "NOT_FOUND" | "STALE_STATE" }>;
export type JobMilestoneAckResult =
  | Readonly<{ status: "APPLIED" | "DEDUPLICATED"; acknowledgedAt: Date }>
  | Readonly<{ status: "NOT_FOUND" | "STALE_STATE" }>;
export interface JobMilestoneItem {
  readonly id: string;
  readonly jobId: string;
  readonly title: string;
  readonly description: string | null;
  readonly state: JobMilestoneState;
  readonly orderIndex: number;
  readonly originalPlannedStartOn: string | null;
  readonly originalPlannedEndOn: string | null;
  readonly currentPlannedStartOn: string | null;
  readonly currentPlannedEndOn: string | null;
  readonly acceptedStageLabel: string | null;
  readonly sourceQuoteId: string | null;
  readonly sourceQuoteRevision: number | null;
  readonly sourcePdfMediaAssetId: string | null;
  readonly responsibility: JobMilestoneResponsibility | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly acknowledgedAt: Date | null;
  readonly capabilities: Readonly<{
    canEdit: boolean;
    canSetState: boolean;
    canMarkDone: boolean;
    canReorder: boolean;
    canAssign: boolean;
    canAcknowledge: boolean;
  }>;
}
export interface JobMilestonePage {
  readonly items: readonly JobMilestoneItem[];
  readonly canCreate: boolean;
  readonly nextCursor: Readonly<{ afterOrder: number; afterId: string }> | null;
}
export interface JobMilestoneHistoryEvent {
  readonly eventId: string;
  readonly sequence: number;
  readonly kind: "CREATE" | "EDIT" | "STATE" | "REORDER" | "ASSIGN";
  readonly actorUserId: string;
  readonly title: string;
  readonly description: string | null;
  readonly plannedStartOn: string | null;
  readonly plannedEndOn: string | null;
  readonly state: JobMilestoneState;
  readonly orderKey: string;
  readonly responsibility: JobMilestoneResponsibility | null;
  readonly acceptedStageLabel: string | null;
  readonly sourceQuoteId: string | null;
  readonly sourceQuoteRevision: number | null;
  readonly sourcePdfMediaAssetId: string | null;
  readonly recordedAt: Date;
}
export class JobMilestoneIdempotencyError extends Error {}

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const control = /[\p{Cc}]/u;
const day = /^\d{4}-\d{2}-\d{2}$/u;
type Kind = JobMilestoneHistoryEvent["kind"];
interface Party {
  readonly role: "CUSTOMER" | "PRIMARY_PROVIDER" | "PARTICIPANT";
  readonly state: string;
  readonly canPlan: boolean;
}
interface Current {
  readonly id: string;
  readonly jobId: string;
  readonly eventSequence: number;
  readonly title: string;
  readonly description: string | null;
  readonly plannedStartDate: string | null;
  readonly plannedEndDate: string | null;
  readonly state: JobMilestoneState;
  readonly orderKey: string;
  readonly responsibleParticipantId: string | null;
  readonly responsibleWorkGroupId: string | null;
  readonly acceptedStageLabel: string | null;
  readonly acceptedQuoteId: string | null;
  readonly acceptedQuoteRevision: number | null;
  readonly acceptedPdfMediaAssetId: string | null;
}
interface Existing {
  readonly kind: Kind | "ACK";
  readonly actorUserId: string;
  readonly milestoneId: string;
  readonly jobId: string;
  readonly matches: boolean;
  readonly updatedAt: Date;
}

export function createJobMilestoneRepository(sql: RootSql) {
  return Object.freeze({
    async createMilestone(
      input: CreateJobMilestoneInput,
    ): Promise<JobMilestoneCommandResult> {
      validateIds(input.actorUserId, input.commandId, input.jobId);
      const title = bounded(input.title, 160, 1);
      const description = optionalText(input.description, 2000);
      const plannedStartOn = optionalDay(input.plannedStartOn);
      const plannedEndOn = optionalDay(input.plannedEndOn);
      validateRange(plannedStartOn, plannedEndOn);
      const acceptedStageLabel = optionalText(input.acceptedStageLabel, 160);
      validateResponsibility(input.responsibility ?? null);
      const responsibility = input.responsibility ?? null;
      const intent = {
        kind: "CREATE",
        title,
        description,
        plannedStartOn,
        plannedEndOn,
        acceptedStageLabel,
        responsibility,
      };
      return transaction(sql, async (tx) => {
        const party = await authorize(tx, input.actorUserId, input.jobId, true);
        if (!party?.canPlan) return { status: "NOT_FOUND" };
        if (acceptedStageLabel !== null && party.role !== "PRIMARY_PROVIDER")
          return { status: "NOT_FOUND" };
        await commandLock(tx, input.commandId);
        const prior = await existing(tx, input.commandId, intent);
        if (prior) return replay(prior, input, "CREATE");
        if (!open(party.state)) return { status: "STALE_STATE" };
        if (!(await responsibilityAvailable(tx, input.jobId, responsibility)))
          return { status: "NOT_FOUND" };
        const [source] = await tx<
          Array<{ quoteId: string; revision: number; pdfId: string | null }>
        >`
          SELECT job.accepted_quote_id AS "quoteId", job.accepted_quote_revision AS revision,
            snapshot.pdf_media_asset_id AS "pdfId"
          FROM jobs job JOIN job_agreement_snapshots snapshot ON snapshot.job_id = job.id
          WHERE job.id = ${input.jobId}
        `;
        if (!source) return { status: "NOT_FOUND" };
        const [tail] = await tx<Array<{ orderKey: string | null }>>`
          SELECT max(order_key)::text AS "orderKey" FROM current_job_milestones
          WHERE job_id = ${input.jobId}
        `;
        const orderKey = (
          BigInt(tail?.orderKey?.split(".")[0] ?? "-1") + 1n
        ).toString();
        const [identity] = await tx<Array<{ createdAt: Date }>>`
          INSERT INTO job_milestones (id, job_id, created_by_user_id)
          VALUES (${input.commandId}, ${input.jobId}, ${input.actorUserId})
          RETURNING created_at AS "createdAt"
        `;
        const [event] = await tx<Array<{ recordedAt: Date }>>`
          INSERT INTO job_milestone_events
            (event_id, milestone_id, event_sequence, kind, actor_user_id, intent,
              title, description, planned_start_date, planned_end_date, state, order_key,
              responsible_participant_id, responsible_work_group_id,
              accepted_stage_label, accepted_quote_id, accepted_quote_revision,
              accepted_pdf_media_asset_id)
          VALUES (${input.commandId}, ${input.commandId}, 1, 'CREATE', ${input.actorUserId},
            ${tx.json(intent)}, ${title}, ${description},
            ${plannedStartOn}::date, ${plannedEndOn}::date, 'PLANNED', ${orderKey}::numeric,
            ${responsibility?.kind === "PARTICIPANT" ? responsibility.id : null}::uuid,
            ${responsibility?.kind === "WORK_GROUP" ? responsibility.id : null}::uuid,
            ${acceptedStageLabel}, ${acceptedStageLabel ? source.quoteId : null}::uuid,
            ${acceptedStageLabel ? source.revision : null}::integer,
            ${acceptedStageLabel ? source.pdfId : null}::uuid)
          RETURNING recorded_at AS "recordedAt"
        `;
        if (!identity || !event) throw new Error("Milestone insert missing.");
        return {
          status: "APPLIED",
          id: input.commandId,
          updatedAt: event.recordedAt,
        };
      });
    },
    editMilestone(
      input: EditJobMilestoneInput,
    ): Promise<JobMilestoneCommandResult> {
      const title = bounded(input.title, 160, 1);
      const description = optionalText(input.description, 2000);
      const plannedStartOn = optionalDay(input.plannedStartOn);
      const plannedEndOn = optionalDay(input.plannedEndOn);
      validateRange(plannedStartOn, plannedEndOn);
      return mutate(
        sql,
        input,
        "EDIT",
        { title, description, plannedStartOn, plannedEndOn },
        (current) => ({
          ...current,
          title,
          description,
          plannedStartDate: plannedStartOn,
          plannedEndDate: plannedEndOn,
        }),
      );
    },
    setMilestoneState(
      input: SetJobMilestoneStateInput,
    ): Promise<JobMilestoneCommandResult> {
      if (!["PLANNED", "IN_PROGRESS", "DONE", "SKIPPED"].includes(input.state))
        throw new TypeError("Invalid milestone state.");
      return mutate(sql, input, "STATE", { state: input.state }, (current) => ({
        ...current,
        state: input.state,
      }));
    },
    reorderMilestone(
      input: ReorderJobMilestoneInput,
    ): Promise<JobMilestoneCommandResult> {
      if (input.afterMilestoneId !== null) validateIds(input.afterMilestoneId);
      return mutate(
        sql,
        input,
        "REORDER",
        { afterMilestoneId: input.afterMilestoneId },
        async (current, tx) => {
          if (input.afterMilestoneId === current.id)
            throw new JobMilestoneIdempotencyError(
              "Cannot reorder after itself.",
            );
          const rows = await tx<Array<{ id: string; orderKey: string }>>`
          SELECT id, order_key::text AS "orderKey" FROM current_job_milestones
          WHERE job_id = ${input.jobId} AND id <> ${current.id}
          ORDER BY order_key, id
        `;
          const afterIndex =
            input.afterMilestoneId === null
              ? -1
              : rows.findIndex((row) => row.id === input.afterMilestoneId);
          if (input.afterMilestoneId !== null && afterIndex < 0) return null;
          const index = afterIndex + 1;
          const lower =
            index === 0 ? null : (rows[index - 1]?.orderKey ?? null);
          const upper =
            index === rows.length ? null : (rows[index]?.orderKey ?? null);
          let orderKey = between(lower, upper);
          if (orderKey === null) {
            // Rare precision exhaustion is an operational reorder, not a cap.
            // Rebase every affected key through history-preserving events.
            for (const [position, row] of rows.entries()) {
              const prior = await loadCurrent(tx, input.jobId, row.id);
              if (!prior)
                throw new Error("Milestone reorder rebase lost a row.");
              const rebased = { ...prior, orderKey: String(position * 2) };
              if (prior.orderKey !== rebased.orderKey) {
                const rebaseId = randomUUID();
                await commandLock(tx, rebaseId);
                await insertEvent(
                  tx,
                  prior,
                  rebased,
                  "REORDER",
                  input.actorUserId,
                  rebaseId,
                  { kind: "REORDER", rebaseFor: input.commandId, position },
                );
              }
            }
            orderKey = between(
              index === 0 ? null : String((index - 1) * 2),
              index === rows.length ? null : String(index * 2),
            );
          }
          if (orderKey === null)
            throw new Error("Milestone ordering rebase failed.");
          return { ...current, orderKey };
        },
      );
    },
    assignMilestone(
      input: AssignJobMilestoneInput,
    ): Promise<JobMilestoneCommandResult> {
      validateResponsibility(input.responsibility);
      return mutate(
        sql,
        input,
        "ASSIGN",
        { responsibility: input.responsibility },
        async (current, tx) => {
          if (
            !(await responsibilityAvailable(
              tx,
              input.jobId,
              input.responsibility,
            ))
          )
            return null;
          return {
            ...current,
            responsibleParticipantId:
              input.responsibility?.kind === "PARTICIPANT"
                ? input.responsibility.id
                : null,
            responsibleWorkGroupId:
              input.responsibility?.kind === "WORK_GROUP"
                ? input.responsibility.id
                : null,
          };
        },
      );
    },
    async acknowledgeMilestone(
      input: JobMilestoneCommand,
    ): Promise<JobMilestoneAckResult> {
      validateIds(
        input.actorUserId,
        input.commandId,
        input.jobId,
        input.milestoneId,
      );
      const intent = { kind: "ACK", milestoneId: input.milestoneId };
      return transaction(sql, async (tx) => {
        const party = await authorize(tx, input.actorUserId, input.jobId, true);
        if (party?.role !== "CUSTOMER") return { status: "NOT_FOUND" };
        await commandLock(tx, input.commandId);
        const prior = await existing(tx, input.commandId, intent);
        if (prior) {
          if (
            prior.kind !== "ACK" ||
            prior.actorUserId !== input.actorUserId ||
            prior.jobId !== input.jobId ||
            prior.milestoneId !== input.milestoneId ||
            !prior.matches
          )
            throw conflict();
          return { status: "DEDUPLICATED", acknowledgedAt: prior.updatedAt };
        }
        if (!open(party.state)) return { status: "STALE_STATE" };
        const current = await loadCurrent(tx, input.jobId, input.milestoneId);
        if (!current) return { status: "NOT_FOUND" };
        const [already] = await tx<Array<{ id: string }>>`
          SELECT id FROM job_milestone_acknowledgements
          WHERE milestone_id = ${input.milestoneId} AND customer_user_id = ${input.actorUserId}
        `;
        if (already) return { status: "STALE_STATE" };
        const [row] = await tx<Array<{ acknowledgedAt: Date }>>`
          INSERT INTO job_milestone_acknowledgements (id, milestone_id, customer_user_id)
          VALUES (${input.commandId}, ${input.milestoneId}, ${input.actorUserId})
          RETURNING acknowledged_at AS "acknowledgedAt"
        `;
        if (!row) throw new Error("Milestone acknowledgement missing.");
        return { status: "APPLIED", acknowledgedAt: row.acknowledgedAt };
      });
    },
    async listMilestones(input: {
      readonly actorUserId: string;
      readonly jobId: string;
      readonly limit: number;
      readonly cursor?: Readonly<{ afterOrder: number; afterId: string }>;
    }): Promise<JobMilestonePage | null> {
      validateIds(input.actorUserId, input.jobId);
      if (
        !Number.isInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 20 ||
        (input.cursor &&
          (!Number.isSafeInteger(input.cursor.afterOrder) ||
            input.cursor.afterOrder < 0 ||
            !uuid.test(input.cursor.afterId)))
      )
        throw new TypeError("Invalid milestone page.");
      return transaction(sql, async (tx) => {
        const party = await authorize(
          tx,
          input.actorUserId,
          input.jobId,
          false,
        );
        if (!party) return null;
        const rows = await readRows(
          tx,
          input.jobId,
          input.cursor?.afterOrder ?? null,
          input.cursor?.afterId ?? null,
          input.limit + 1,
        );
        const items = rows.slice(0, input.limit).map((row) => item(row, party));
        const last = rows.length > input.limit ? items.at(-1) : undefined;
        return {
          items,
          canCreate: party.canPlan && open(party.state),
          nextCursor: last
            ? { afterOrder: last.orderIndex, afterId: last.id }
            : null,
        };
      });
    },
    async getMilestone(input: {
      readonly actorUserId: string;
      readonly jobId: string;
      readonly milestoneId: string;
    }): Promise<JobMilestoneItem | null> {
      validateIds(input.actorUserId, input.jobId, input.milestoneId);
      return transaction(sql, async (tx) => {
        const party = await authorize(
          tx,
          input.actorUserId,
          input.jobId,
          false,
        );
        if (!party) return null;
        const rows = await readRows(
          tx,
          input.jobId,
          null,
          null,
          null,
          input.milestoneId,
        );
        return rows[0] ? item(rows[0], party) : null;
      });
    },
    async listMilestoneHistory(input: {
      readonly actorUserId: string;
      readonly jobId: string;
      readonly milestoneId: string;
      readonly limit: number;
      readonly beforeSequence?: number;
    }): Promise<readonly JobMilestoneHistoryEvent[] | null> {
      validateIds(input.actorUserId, input.jobId, input.milestoneId);
      if (
        !Number.isInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 50 ||
        (input.beforeSequence !== undefined &&
          (!Number.isSafeInteger(input.beforeSequence) ||
            input.beforeSequence < 1))
      )
        throw new TypeError("Invalid milestone history page.");
      return transaction(sql, async (tx) => {
        if (!(await authorize(tx, input.actorUserId, input.jobId, false)))
          return null;
        if (!(await loadCurrent(tx, input.jobId, input.milestoneId)))
          return null;
        const rows = await tx<
          Array<
            Omit<JobMilestoneHistoryEvent, "responsibility"> & {
              responsibleParticipantId: string | null;
              responsibleWorkGroupId: string | null;
            }
          >
        >`
          SELECT event_id AS "eventId", event_sequence AS sequence, kind::text AS kind,
            actor_user_id AS "actorUserId", title, description,
            planned_start_date::text AS "plannedStartOn", planned_end_date::text AS "plannedEndOn",
            state::text AS state, order_key::text AS "orderKey",
            responsible_participant_id AS "responsibleParticipantId",
            responsible_work_group_id AS "responsibleWorkGroupId",
            accepted_stage_label AS "acceptedStageLabel",
            accepted_quote_id AS "sourceQuoteId",
            accepted_quote_revision AS "sourceQuoteRevision",
            accepted_pdf_media_asset_id AS "sourcePdfMediaAssetId",
            recorded_at AS "recordedAt"
          FROM job_milestone_events WHERE milestone_id = ${input.milestoneId}
            AND (${input.beforeSequence ?? null}::integer IS NULL OR event_sequence < ${input.beforeSequence ?? null})
          ORDER BY event_sequence DESC LIMIT ${input.limit}
        `;
        return rows.map((row) => ({
          ...row,
          responsibility: responsibility(row),
        }));
      });
    },
  });
}

async function mutate(
  sql: RootSql,
  input: JobMilestoneCommand,
  kind: Exclude<Kind, "CREATE">,
  payload: Record<string, unknown>,
  change: (
    current: Current,
    tx: TransactionSql,
  ) => Current | null | Promise<Current | null>,
): Promise<JobMilestoneCommandResult> {
  validateIds(
    input.actorUserId,
    input.commandId,
    input.jobId,
    input.milestoneId,
  );
  const intent = { kind, ...payload };
  return transaction(sql, async (tx) => {
    const party = await authorize(tx, input.actorUserId, input.jobId, true);
    if (!party?.canPlan) return { status: "NOT_FOUND" };
    await commandLock(tx, input.commandId);
    const prior = await existing(tx, input.commandId, intent);
    if (prior) return replay(prior, input, kind);
    if (!open(party.state)) return { status: "STALE_STATE" };
    const current = await loadCurrent(tx, input.jobId, input.milestoneId);
    if (!current) return { status: "NOT_FOUND" };
    if (
      kind === "STATE" &&
      (payload["state"] === "DONE" || payload["state"] === "SKIPPED") &&
      party.role !== "PRIMARY_PROVIDER"
    )
      return { status: "NOT_FOUND" };
    if (
      kind === "STATE" &&
      !canTransition(current.state, payload["state"] as JobMilestoneState)
    )
      return { status: "STALE_STATE" };
    const next = await change(current, tx);
    if (!next) return { status: "NOT_FOUND" };
    if (sameProjection(current, next)) return { status: "STALE_STATE" };
    const event = await insertEvent(
      tx,
      current,
      next,
      kind,
      input.actorUserId,
      input.commandId,
      intent,
    );
    return {
      status: "APPLIED",
      id: input.milestoneId,
      updatedAt: event.recordedAt,
    };
  });
}

async function insertEvent(
  tx: TransactionSql,
  current: Current,
  next: Current,
  kind: Exclude<Kind, "CREATE">,
  actorUserId: string,
  eventId: string,
  intent: Record<string, unknown>,
): Promise<{ recordedAt: Date }> {
  const [event] = await tx<Array<{ recordedAt: Date }>>`
      INSERT INTO job_milestone_events
        (event_id, milestone_id, event_sequence, kind, actor_user_id, intent,
          title, description, planned_start_date, planned_end_date, state, order_key,
          responsible_participant_id, responsible_work_group_id,
          accepted_stage_label, accepted_quote_id, accepted_quote_revision,
          accepted_pdf_media_asset_id)
      VALUES (${eventId}, ${current.id}, ${current.eventSequence + 1},
        ${kind}::job_milestone_event_kind, ${actorUserId}, ${tx.json(intent as never)},
        ${next.title}, ${next.description}, ${next.plannedStartDate}::date,
        ${next.plannedEndDate}::date, ${next.state}::job_milestone_state,
        ${next.orderKey}::numeric, ${next.responsibleParticipantId}::uuid,
        ${next.responsibleWorkGroupId}::uuid, ${next.acceptedStageLabel},
        ${next.acceptedQuoteId}::uuid, ${next.acceptedQuoteRevision}::integer,
        ${next.acceptedPdfMediaAssetId}::uuid)
      RETURNING recorded_at AS "recordedAt"
    `;
  if (!event) throw new Error("Milestone event insert missing.");
  return event;
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

async function commandLock(tx: TransactionSql, id: string): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${id}::text, 51011))`;
}
async function existing(
  tx: TransactionSql,
  id: string,
  intent: Record<string, unknown>,
): Promise<Existing | null> {
  const rows = await tx<Existing[]>`
    SELECT event.kind::text AS kind, event.actor_user_id AS "actorUserId",
      event.milestone_id AS "milestoneId", milestone.job_id AS "jobId",
      event.intent = ${tx.json(intent as never)} AS matches,
      event.recorded_at AS "updatedAt"
    FROM job_milestone_events event JOIN job_milestones milestone ON milestone.id = event.milestone_id
    WHERE event.event_id = ${id}
    UNION ALL
    SELECT 'ACK' AS kind, ack.customer_user_id AS "actorUserId",
      ack.milestone_id AS "milestoneId", milestone.job_id AS "jobId",
      (${tx.json(intent as never)} = jsonb_build_object('kind','ACK','milestoneId',ack.milestone_id::text)) AS matches,
      ack.acknowledged_at AS "updatedAt"
    FROM job_milestone_acknowledgements ack JOIN job_milestones milestone ON milestone.id = ack.milestone_id
    WHERE ack.id = ${id}
  `;
  if (rows.length > 1) throw new Error("Milestone command collision.");
  return rows[0] ?? null;
}
function replay(
  prior: Existing,
  input: {
    actorUserId: string;
    jobId: string;
    commandId: string;
    milestoneId?: string;
  },
  kind: Kind,
): JobMilestoneCommandResult {
  if (prior.actorUserId !== input.actorUserId || prior.jobId !== input.jobId)
    return { status: "NOT_FOUND" };
  const expectedId = input.milestoneId ?? input.commandId;
  if (prior.kind !== kind || prior.milestoneId !== expectedId || !prior.matches)
    throw conflict();
  return { status: "DEDUPLICATED", id: expectedId, updatedAt: prior.updatedAt };
}
function conflict(): JobMilestoneIdempotencyError {
  return new JobMilestoneIdempotencyError(
    "Milestone command ID was reused for another intent.",
  );
}
async function loadCurrent(
  tx: TransactionSql,
  jobId: string,
  milestoneId: string,
): Promise<Current | null> {
  const [row] = await tx<Current[]>`
    SELECT id, job_id AS "jobId", event_sequence AS "eventSequence", title, description,
      planned_start_date::text AS "plannedStartDate", planned_end_date::text AS "plannedEndDate",
      state::text AS state, order_key::text AS "orderKey",
      responsible_participant_id AS "responsibleParticipantId",
      responsible_work_group_id AS "responsibleWorkGroupId",
      accepted_stage_label AS "acceptedStageLabel", accepted_quote_id AS "acceptedQuoteId",
      accepted_quote_revision AS "acceptedQuoteRevision",
      accepted_pdf_media_asset_id AS "acceptedPdfMediaAssetId"
    FROM current_job_milestones WHERE job_id = ${jobId} AND id = ${milestoneId}
  `;
  return row ?? null;
}
async function responsibilityAvailable(
  tx: TransactionSql,
  jobId: string,
  value: JobMilestoneResponsibility | null,
): Promise<boolean> {
  if (value === null) return true;
  if (value.kind === "PARTICIPANT") {
    const [row] = await tx<Array<{ id: string }>>`
      SELECT id FROM current_job_participants
      WHERE id = ${value.id} AND job_id = ${jobId} AND state = 'ACCEPTED'
    `;
    return row !== undefined;
  }
  const [row] = await tx<Array<{ id: string }>>`
    SELECT id FROM job_work_groups WHERE id = ${value.id} AND job_id = ${jobId}
  `;
  return row !== undefined;
}
function sameProjection(a: Current, b: Current): boolean {
  return (
    a.title === b.title &&
    a.description === b.description &&
    a.plannedStartDate === b.plannedStartDate &&
    a.plannedEndDate === b.plannedEndDate &&
    a.state === b.state &&
    a.orderKey === b.orderKey &&
    a.responsibleParticipantId === b.responsibleParticipantId &&
    a.responsibleWorkGroupId === b.responsibleWorkGroupId
  );
}
function canTransition(
  from: JobMilestoneState,
  to: JobMilestoneState,
): boolean {
  return (
    (from === "PLANNED" && ["IN_PROGRESS", "DONE", "SKIPPED"].includes(to)) ||
    (from === "IN_PROGRESS" && ["PLANNED", "DONE", "SKIPPED"].includes(to))
  );
}

interface ReadRow extends Current {
  readonly orderIndex: number;
  readonly originalPlannedStartOn: string | null;
  readonly originalPlannedEndOn: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly acknowledgedAt: Date | null;
}
async function readRows(
  tx: TransactionSql,
  jobId: string,
  afterOrder: number | null,
  afterId: string | null,
  limit: number | null,
  milestoneId: string | null = null,
): Promise<ReadRow[]> {
  return tx<ReadRow[]>`
    WITH ordered AS (
      SELECT milestone.*, row_number() OVER (ORDER BY order_key, id)::integer - 1 AS "orderIndex"
      FROM current_job_milestones milestone WHERE job_id = ${jobId}
    )
    SELECT ordered.id, ordered.job_id AS "jobId", ordered.event_sequence AS "eventSequence",
      ordered.title, ordered.description, ordered.planned_start_date::text AS "plannedStartDate",
      ordered.planned_end_date::text AS "plannedEndDate", ordered.state::text AS state,
      ordered.order_key::text AS "orderKey", ordered."orderIndex",
      ordered.responsible_participant_id AS "responsibleParticipantId",
      ordered.responsible_work_group_id AS "responsibleWorkGroupId",
      ordered.accepted_stage_label AS "acceptedStageLabel",
      ordered.accepted_quote_id AS "acceptedQuoteId", ordered.accepted_quote_revision AS "acceptedQuoteRevision",
      ordered.accepted_pdf_media_asset_id AS "acceptedPdfMediaAssetId",
      first_event.planned_start_date::text AS "originalPlannedStartOn",
      first_event.planned_end_date::text AS "originalPlannedEndOn",
      ordered.created_at AS "createdAt", ordered.updated_at AS "updatedAt",
      ack.acknowledged_at AS "acknowledgedAt"
    FROM ordered
    JOIN job_milestone_events first_event ON first_event.milestone_id = ordered.id AND first_event.event_sequence = 1
    LEFT JOIN job_milestone_acknowledgements ack ON ack.milestone_id = ordered.id
    WHERE (${milestoneId}::uuid IS NULL OR ordered.id = ${milestoneId}::uuid)
      AND (${afterOrder}::integer IS NULL OR (ordered."orderIndex", ordered.id) > (${afterOrder}::integer, ${afterId}::uuid))
    ORDER BY ordered."orderIndex", ordered.id
    LIMIT ${limit}
  `;
}
function item(row: ReadRow, party: Party): JobMilestoneItem {
  const canPlan = party.canPlan && open(party.state);
  return {
    id: row.id,
    jobId: row.jobId,
    title: row.title,
    description: row.description,
    state: row.state,
    orderIndex: row.orderIndex,
    originalPlannedStartOn: row.originalPlannedStartOn,
    originalPlannedEndOn: row.originalPlannedEndOn,
    currentPlannedStartOn: row.plannedStartDate,
    currentPlannedEndOn: row.plannedEndDate,
    acceptedStageLabel: row.acceptedStageLabel,
    sourceQuoteId: row.acceptedQuoteId,
    sourceQuoteRevision: row.acceptedQuoteRevision,
    sourcePdfMediaAssetId: row.acceptedPdfMediaAssetId,
    responsibility: responsibility(row),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    acknowledgedAt: row.acknowledgedAt,
    capabilities: {
      canEdit: canPlan,
      canSetState: canPlan,
      canMarkDone: canPlan && party.role === "PRIMARY_PROVIDER",
      canReorder: canPlan,
      canAssign: canPlan,
      canAcknowledge:
        party.role === "CUSTOMER" && open(party.state) && !row.acknowledgedAt,
    },
  };
}
function responsibility(row: {
  responsibleParticipantId: string | null;
  responsibleWorkGroupId: string | null;
}): JobMilestoneResponsibility | null {
  if (row.responsibleParticipantId)
    return { kind: "PARTICIPANT", id: row.responsibleParticipantId };
  if (row.responsibleWorkGroupId)
    return { kind: "WORK_GROUP", id: row.responsibleWorkGroupId };
  return null;
}
function between(lower: string | null, upper: string | null): string | null {
  if (lower === null && upper === null) return "0";
  if (upper === null) return decimal(scaled(lower!) + 10n ** 20n);
  if (lower === null) return decimal(scaled(upper) - 10n ** 20n);
  const left = scaled(lower);
  const right = scaled(upper);
  if (right - left < 2n) return null;
  return decimal((left + right) / 2n);
}
function scaled(value: string): bigint {
  const negative = value.startsWith("-");
  const [whole = "0", fraction = ""] = (
    negative ? value.slice(1) : value
  ).split(".");
  const magnitude =
    BigInt(whole) * 10n ** 20n +
    BigInt((fraction + "0".repeat(20)).slice(0, 20));
  return negative ? -magnitude : magnitude;
}
function decimal(value: bigint): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const whole = magnitude / 10n ** 20n;
  const fraction = (magnitude % 10n ** 20n)
    .toString()
    .padStart(20, "0")
    .replace(/0+$/u, "");
  return `${negative ? "-" : ""}${fraction ? `${whole}.${fraction}` : whole.toString()}`;
}
function bounded(value: string, max: number, min: number): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < min ||
    value.length > max ||
    control.test(value)
  )
    throw new TypeError("Invalid milestone text.");
  return value;
}
function optionalText(
  value: string | null | undefined,
  max: number,
): string | null {
  return value == null ? null : bounded(value, max, 1);
}
function optionalDay(value: string | null | undefined): string | null {
  if (value == null) return null;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  if (
    !day.test(value) ||
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString().slice(0, 10) !== value
  )
    throw new TypeError("Invalid milestone date.");
  return value;
}
function validateRange(start: string | null, end: string | null): void {
  if (start && end && start > end)
    throw new TypeError("Invalid milestone date range.");
}
function validateIds(...ids: string[]): void {
  if (ids.some((id) => typeof id !== "string" || !uuid.test(id)))
    throw new TypeError("Invalid milestone identity.");
}
function validateResponsibility(
  value: JobMilestoneResponsibility | null,
): void {
  if (
    value !== null &&
    (!["PARTICIPANT", "WORK_GROUP"].includes(value.kind) ||
      !uuid.test(value.id))
  )
    throw new TypeError("Invalid milestone responsibility.");
}
function open(state: string): boolean {
  return state === "CONFIRMED" || state === "IN_PROGRESS";
}
async function transaction<T>(
  sql: RootSql,
  work: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return ("savepoint" in sql
    ? sql.savepoint(work)
    : sql.begin(work)) as unknown as Promise<T>;
}
