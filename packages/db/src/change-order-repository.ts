import { createHash, randomUUID } from "node:crypto";

import type { Sql, TransactionSql } from "postgres";
import {
  createServerMediaEntityAccess,
  type MediaEntityAccessResolver,
  type PrivateMediaDeliverySnapshot,
} from "@portal/media";

type RootSql = Sql | TransactionSql;
export type ChangeOrderSide = "CUSTOMER" | "PRIMARY_PROVIDER";
export type ChangeOrderState =
  "DRAFT" | "PROPOSED" | "APPROVED" | "REJECTED" | "WITHDRAWN" | "SUPERSEDED";
export type ChangeOrderVatStatus =
  "VAT_INCLUDED" | "VAT_EXCLUDED" | "NOT_VAT_REGISTERED";
export type ChangeOrderPriceImpact =
  | Readonly<{ mode: "NONE" }>
  | Readonly<{
      mode: "FIXED_DELTA";
      amountCents: number;
      vatStatus: ChangeOrderVatStatus;
    }>
  | Readonly<{
      mode: "ESTIMATE_DELTA";
      amountCents: number;
      basis: string;
      vatStatus: ChangeOrderVatStatus;
    }>
  | Readonly<{
      mode: "RANGE_DELTA";
      minimumCents: number;
      maximumCents: number;
      basis: string;
      vatStatus: ChangeOrderVatStatus;
    }>;
export type ChangeOrderScheduleImpact =
  | Readonly<{ mode: "NONE" }>
  | Readonly<{ mode: "DAYS"; deltaDays: number }>
  | Readonly<{ mode: "DATE"; newDate: string }>
  | Readonly<{ mode: "RANGE"; startDate: string; endDate: string }>;
export interface ChangeOrderTerms {
  readonly title: string;
  readonly reason: string;
  readonly changeDescription: string;
  readonly scopeAdded: readonly string[];
  readonly scopeRemoved: readonly string[];
  readonly scopeChanged: readonly string[];
  readonly priceImpact: ChangeOrderPriceImpact;
  readonly scheduleImpact: ChangeOrderScheduleImpact;
  readonly materialResponsibility?: "PROVIDER" | "CUSTOMER" | "MIXED" | null;
  readonly warrantyChange?: string | null;
  readonly otherConditionChange?: string | null;
  readonly affectedMilestoneIds?: readonly string[];
  readonly externalPdfMediaAssetId?: string | null;
}
export interface CreateChangeOrderInput {
  readonly actorUserId: string;
  readonly commandId: string;
  readonly jobId: string;
  readonly revisionId: string;
  readonly terms: ChangeOrderTerms;
}
export interface ChangeOrderRevisionInput {
  readonly actorUserId: string;
  readonly commandId: string;
  readonly jobId: string;
  readonly changeOrderId: string;
  readonly expectedRevisionId: string;
  readonly terms: ChangeOrderTerms;
}
export interface ChangeOrderDecisionInput {
  readonly actorUserId: string;
  readonly commandId: string;
  readonly jobId: string;
  readonly changeOrderId: string;
  readonly revisionId: string;
  readonly revisionNumber: number;
}
export type ChangeOrderCommandResult =
  | Readonly<{
      status: "APPLIED" | "DEDUPLICATED";
      changeOrderId: string;
      revisionId: string;
      revisionNumber: number;
      state: ChangeOrderState;
      occurredAt: Date;
    }>
  | Readonly<{ status: "NOT_FOUND" | "STALE_STATE" }>;
export interface ChangeOrderRevision {
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly state: ChangeOrderState;
  readonly authoredByUserId: string;
  readonly authoredSide: ChangeOrderSide;
  readonly terms: ChangeOrderTerms;
  readonly pdfContentSha256: string | null;
  readonly createdAt: Date;
  readonly stateChangedAt: Date | null;
}
export interface ChangeOrderDetail {
  readonly changeOrderId: string;
  readonly jobId: string;
  readonly createdByUserId: string;
  readonly createdBySide: ChangeOrderSide;
  readonly createdAt: Date;
  readonly revisions: readonly ChangeOrderRevision[];
  readonly actions: readonly Readonly<{
    id: string;
    revisionId: string;
    sequence: number;
    action: string;
    actorUserId: string;
    supersededByRevisionId: string | null;
    occurredAt: Date;
  }>[];
}
export interface ChangeOrderSummary {
  readonly changeOrderId: string;
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly state: ChangeOrderState;
  readonly title: string;
  readonly authoredSide: ChangeOrderSide;
  readonly createdAt: Date;
}
export interface ChangeOrderPage {
  readonly items: readonly ChangeOrderSummary[];
  readonly nextCursor: Readonly<{
    createdAt: Date;
    changeOrderId: string;
  }> | null;
}
export interface ChangeOrderRevisionPage {
  readonly items: readonly ChangeOrderRevision[];
  readonly nextCursor: number | null;
}
export class ChangeOrderIdempotencyError extends Error {}

/** A future purpose-bound upload may create the asset; only a bound revision is deliverable. */
export function createChangeOrderDocumentMediaAccessResolver(
  sql: Sql,
): MediaEntityAccessResolver {
  return Object.freeze({
    async resolvePrivateMediaAccess(snapshot: PrivateMediaDeliverySnapshot) {
      if (
        snapshot.asset.purpose !== "CHANGE_ORDER_DOCUMENT" ||
        snapshot.asset.provenanceEntityType !== "CHANGE_ORDER_REVISION" ||
        !snapshot.asset.provenanceEntityId ||
        !snapshot.asset.provenanceEntityRevision
      )
        throw new Error("Unbound Change-order document.");
      const [row] = await sql<
        Array<{
          side: ChangeOrderSide;
          revisionId: string;
          revisionNumber: number;
          state: ChangeOrderState;
          stateChangedAt: Date | null;
          accountStateChangedAt: Date;
        }>
      >`
        SELECT change_order_actor_side(identity.job_id, ${snapshot.actor.userId}::uuid)::text AS side,
          revision.id AS "revisionId", revision.revision_number AS "revisionNumber",
          state.state::text AS state, state.state_changed_at AS "stateChangedAt",
          actor.account_state_changed_at AS "accountStateChangedAt"
        FROM change_order_revisions revision
        JOIN change_orders identity ON identity.id = revision.change_order_id
        JOIN current_change_order_revision_states state ON state.revision_id = revision.id
        JOIN users actor ON actor.id = ${snapshot.actor.userId} AND actor.account_state = 'ACTIVE'
        WHERE revision.id = ${snapshot.asset.provenanceEntityId}
          AND revision.revision_number = ${snapshot.asset.provenanceEntityRevision}
          AND revision.pdf_media_asset_id = ${snapshot.asset.id}
          AND (revision.authored_side = change_order_actor_side(identity.job_id, actor.id)
            OR EXISTS (SELECT 1 FROM change_order_revision_actions disclosed
              WHERE disclosed.revision_id = revision.id AND disclosed.action = 'PROPOSE'))`;
      if (!row?.side) throw new Error("Unbound Change-order document.");
      return createServerMediaEntityAccess({
        grants: [
          row.side === "CUSTOMER" ? "JOB_CUSTOMER" : "JOB_PRIMARY_PROVIDER",
        ],
        revision: [
          "change-order-document",
          row.revisionId,
          row.revisionNumber,
          row.state,
          row.stateChangedAt?.toISOString() ?? "draft",
          row.accountStateChangedAt.toISOString(),
          snapshot.asset.id,
        ].join(":"),
      });
    },
  });
}

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const control = /[\p{Cc}]/u;
const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
type NormalTerms = Required<ChangeOrderTerms>;
type Head = {
  revisionId: string;
  revisionNumber: number;
  state: ChangeOrderState;
  authoredSide: ChangeOrderSide;
};
type Party = { side: ChangeOrderSide; state: string };

export function createChangeOrderRepository(sql: RootSql) {
  async function createDraft(
    input: CreateChangeOrderInput,
  ): Promise<ChangeOrderCommandResult> {
    ids(input.actorUserId, input.commandId, input.jobId, input.revisionId);
    const terms = normalize(input.terms);
    const intent = fingerprint({
      kind: "CREATE",
      actorUserId: input.actorUserId,
      jobId: input.jobId,
      commandId: input.commandId,
      revisionId: input.revisionId,
      terms: canonicalTerms(terms),
    });
    return transaction(sql, async (tx) => {
      const party = await authorize(tx, input.actorUserId, input.jobId, true);
      if (!party) return { status: "NOT_FOUND" };
      await lockCommand(tx, input.commandId);
      const prior = await existing(tx, input.commandId);
      if (prior)
        return replay(
          prior,
          intent,
          input.actorUserId,
          input.jobId,
          input.commandId,
          input.revisionId,
        );
      if (!open(party.state)) return { status: "STALE_STATE" };
      if (terms.externalPdfMediaAssetId && party.side !== "PRIMARY_PROVIDER")
        return { status: "NOT_FOUND" };
      await tx`INSERT INTO change_orders (id, job_id, created_by_user_id, created_by_side)
        VALUES (${input.commandId}, ${input.jobId}, ${input.actorUserId}, ${party.side})`;
      const createdAt = await insertRevision(tx, {
        revisionId: input.revisionId,
        changeOrderId: input.commandId,
        revisionNumber: 1,
        commandId: input.commandId,
        actorUserId: input.actorUserId,
        party,
        terms,
        intent,
        creationState: "DRAFT",
      });
      return applied(input.commandId, input.revisionId, 1, "DRAFT", createdAt);
    });
  }

  async function replaceDraft(
    input: ChangeOrderRevisionInput,
  ): Promise<ChangeOrderCommandResult> {
    return revise(input, false);
  }
  async function counterpropose(
    input: ChangeOrderRevisionInput,
  ): Promise<ChangeOrderCommandResult> {
    return revise(input, true);
  }
  async function revise(
    input: ChangeOrderRevisionInput,
    submit: boolean,
  ): Promise<ChangeOrderCommandResult> {
    ids(
      input.actorUserId,
      input.commandId,
      input.jobId,
      input.changeOrderId,
      input.expectedRevisionId,
    );
    const terms = normalize(input.terms);
    const intent = fingerprint({
      kind: submit ? "COUNTERPROPOSE" : "REPLACE_DRAFT",
      actorUserId: input.actorUserId,
      jobId: input.jobId,
      changeOrderId: input.changeOrderId,
      expectedRevisionId: input.expectedRevisionId,
      commandId: input.commandId,
      terms: canonicalTerms(terms),
    });
    return transaction(sql, async (tx) => {
      const party = await authorize(tx, input.actorUserId, input.jobId, true);
      if (!party || !(await belongs(tx, input.jobId, input.changeOrderId)))
        return { status: "NOT_FOUND" };
      await lockCommand(tx, input.commandId);
      const prior = await existing(tx, input.commandId);
      if (prior)
        return replay(
          prior,
          intent,
          input.actorUserId,
          input.jobId,
          input.changeOrderId,
          input.commandId,
        );
      if (!open(party.state)) return { status: "STALE_STATE" };
      const head = await currentHead(tx, input.changeOrderId);
      if (head?.state === "DRAFT" && head.authoredSide !== party.side)
        return { status: "NOT_FOUND" };
      if (
        !head ||
        head.revisionId !== input.expectedRevisionId ||
        (submit
          ? head.state !== "PROPOSED" || party.side === head.authoredSide
          : head.state !== "DRAFT" || party.side !== head.authoredSide)
      )
        return { status: "STALE_STATE" };
      if (terms.externalPdfMediaAssetId && party.side !== "PRIMARY_PROVIDER")
        return { status: "NOT_FOUND" };
      const revisionNumber = head.revisionNumber + 1;
      const createdAt = await insertRevision(tx, {
        revisionId: input.commandId,
        changeOrderId: input.changeOrderId,
        revisionNumber,
        commandId: input.commandId,
        actorUserId: input.actorUserId,
        party,
        terms,
        intent,
        creationState: submit ? "PROPOSED" : "DRAFT",
      });
      if (submit) {
        await insertAction(
          tx,
          input.commandId,
          "PROPOSE",
          randomUUID(),
          input.actorUserId,
          fingerprint({
            kind: "COUNTERPROPOSE_SUBMIT",
            commandId: input.commandId,
          }),
        );
      }
      await insertAction(
        tx,
        head.revisionId,
        "SUPERSEDE",
        randomUUID(),
        input.actorUserId,
        fingerprint({
          kind: "SUPERSEDE",
          old: head.revisionId,
          successor: input.commandId,
        }),
        input.commandId,
      );
      return applied(
        input.changeOrderId,
        input.commandId,
        revisionNumber,
        submit ? "PROPOSED" : "DRAFT",
        createdAt,
      );
    });
  }

  async function decide(
    input: ChangeOrderDecisionInput,
    action: "PROPOSE" | "APPROVE" | "REJECT" | "WITHDRAW",
  ): Promise<ChangeOrderCommandResult> {
    ids(
      input.actorUserId,
      input.commandId,
      input.jobId,
      input.changeOrderId,
      input.revisionId,
    );
    if (!Number.isSafeInteger(input.revisionNumber) || input.revisionNumber < 1)
      throw new TypeError("Invalid revision number.");
    const intent = fingerprint({
      kind: action,
      actorUserId: input.actorUserId,
      jobId: input.jobId,
      changeOrderId: input.changeOrderId,
      revisionId: input.revisionId,
      revisionNumber: input.revisionNumber,
      commandId: input.commandId,
    });
    return transaction(sql, async (tx) => {
      const party = await authorize(tx, input.actorUserId, input.jobId, true);
      if (!party || !(await belongs(tx, input.jobId, input.changeOrderId)))
        return { status: "NOT_FOUND" };
      await lockCommand(tx, input.commandId);
      const prior = await existing(tx, input.commandId);
      if (prior)
        return replay(
          prior,
          intent,
          input.actorUserId,
          input.jobId,
          input.changeOrderId,
          input.revisionId,
        );
      if (!open(party.state)) return { status: "STALE_STATE" };
      const head = await currentHead(tx, input.changeOrderId);
      if (head?.state === "DRAFT" && head.authoredSide !== party.side)
        return { status: "NOT_FOUND" };
      if (
        !head ||
        head.revisionId !== input.revisionId ||
        head.revisionNumber !== input.revisionNumber ||
        (action === "PROPOSE"
          ? head.state !== "DRAFT" || party.side !== head.authoredSide
          : head.state !== "PROPOSED" ||
            (action === "WITHDRAW"
              ? party.side !== head.authoredSide
              : party.side === head.authoredSide))
      ) {
        return { status: "STALE_STATE" };
      }
      const occurredAt = await insertAction(
        tx,
        input.revisionId,
        action,
        input.commandId,
        input.actorUserId,
        intent,
      );
      const state =
        action === "PROPOSE"
          ? "PROPOSED"
          : action === "APPROVE"
            ? "APPROVED"
            : action === "REJECT"
              ? "REJECTED"
              : "WITHDRAWN";
      return applied(
        input.changeOrderId,
        input.revisionId,
        input.revisionNumber,
        state,
        occurredAt,
      );
    });
  }

  async function listChangeOrders(input: {
    actorUserId: string;
    jobId: string;
    limit?: number;
    cursor?: { createdAt: Date; changeOrderId: string } | null;
  }): Promise<ChangeOrderPage | null> {
    ids(input.actorUserId, input.jobId);
    const limit = input.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new TypeError("Invalid page size.");
    if (input.cursor) ids(input.cursor.changeOrderId);
    return transaction(sql, async (tx) => {
      const party = await authorize(tx, input.actorUserId, input.jobId, false);
      if (!party) return null;
      const rows = await tx<Array<ChangeOrderSummary>>`
        SELECT current.id AS "changeOrderId", revision.id AS "revisionId",
          revision.revision_number AS "revisionNumber", current.state::text AS state,
          revision.title, revision.authored_side::text AS "authoredSide",
          current.created_at AS "createdAt"
        FROM current_change_orders current
        JOIN change_order_revisions revision ON revision.id = current.revision_id
        WHERE current.job_id = ${input.jobId}
          AND (revision.authored_side = ${party.side}::change_order_side
            OR EXISTS (SELECT 1 FROM change_order_revision_actions disclosed
              WHERE disclosed.revision_id = revision.id AND disclosed.action = 'PROPOSE'))
          AND (${input.cursor?.createdAt ?? null}::timestamptz IS NULL
            OR (current.created_at, current.id) < (${input.cursor?.createdAt ?? null}::timestamptz, ${input.cursor?.changeOrderId ?? null}::uuid))
        ORDER BY current.created_at DESC, current.id DESC LIMIT ${limit + 1}`;
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      return {
        items,
        nextCursor:
          rows.length > limit && last
            ? { createdAt: last.createdAt, changeOrderId: last.changeOrderId }
            : null,
      };
    });
  }

  async function getChangeOrder(input: {
    actorUserId: string;
    jobId: string;
    changeOrderId: string;
  }): Promise<ChangeOrderDetail | null> {
    ids(input.actorUserId, input.jobId, input.changeOrderId);
    return transaction(sql, async (tx) => {
      const party = await authorize(tx, input.actorUserId, input.jobId, false);
      if (!party) return null;
      const [identity] = await tx<
        Array<{
          changeOrderId: string;
          jobId: string;
          createdByUserId: string;
          createdBySide: ChangeOrderSide;
          createdAt: Date;
        }>
      >`
        SELECT id AS "changeOrderId", job_id AS "jobId", created_by_user_id AS "createdByUserId",
          created_by_side::text AS "createdBySide", created_at AS "createdAt"
        FROM change_orders WHERE id = ${input.changeOrderId} AND job_id = ${input.jobId}`;
      if (!identity) return null;
      const rows = await tx<Array<RawRevision>>`
        SELECT revision.*, state.state::text AS state, state.state_changed_at AS "stateChangedAt"
        FROM change_order_revisions revision
        JOIN current_change_order_revision_states state ON state.revision_id = revision.id
        WHERE revision.change_order_id = ${input.changeOrderId}
          AND (revision.authored_side = ${party.side}::change_order_side
            OR EXISTS (SELECT 1 FROM change_order_revision_actions disclosed
              WHERE disclosed.revision_id = revision.id AND disclosed.action = 'PROPOSE'))
        ORDER BY revision.revision_number`;
      if (rows.length === 0) return null;
      const visibleIds = rows.map((row) => row.id);
      const actions = await tx<
        Array<{
          id: string;
          revisionId: string;
          sequence: number;
          action: string;
          actorUserId: string;
          supersededByRevisionId: string | null;
          occurredAt: Date;
        }>
      >`
        SELECT id, revision_id AS "revisionId", action_sequence AS sequence,
          action::text AS action, actor_user_id AS "actorUserId",
          superseded_by_revision_id AS "supersededByRevisionId",
          occurred_at AS "occurredAt"
        FROM change_order_revision_actions WHERE revision_id = ANY(${visibleIds}::uuid[])
        ORDER BY occurred_at, id`;
      return { ...identity, revisions: rows.map(mapRevision), actions };
    });
  }

  async function listRevisions(input: {
    actorUserId: string;
    jobId: string;
    changeOrderId: string;
    limit?: number;
    beforeRevisionNumber?: number | null;
  }): Promise<ChangeOrderRevisionPage | null> {
    ids(input.actorUserId, input.jobId, input.changeOrderId);
    const limit = input.limit ?? 20;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (input.beforeRevisionNumber != null &&
        (!Number.isInteger(input.beforeRevisionNumber) ||
          input.beforeRevisionNumber < 1))
    )
      throw new TypeError("Invalid revision page.");
    return transaction(sql, async (tx) => {
      const party = await authorize(tx, input.actorUserId, input.jobId, false);
      if (!party || !(await belongs(tx, input.jobId, input.changeOrderId)))
        return null;
      const rows = await tx<Array<RawRevision>>`
        SELECT revision.*, state.state::text AS state, state.state_changed_at AS "stateChangedAt"
        FROM change_order_revisions revision
        JOIN current_change_order_revision_states state ON state.revision_id = revision.id
        WHERE revision.change_order_id = ${input.changeOrderId}
          AND (${input.beforeRevisionNumber ?? null}::integer IS NULL
            OR revision.revision_number < ${input.beforeRevisionNumber ?? null}::integer)
          AND (revision.authored_side = ${party.side}::change_order_side
            OR EXISTS (SELECT 1 FROM change_order_revision_actions disclosed
              WHERE disclosed.revision_id = revision.id AND disclosed.action = 'PROPOSE'))
        ORDER BY revision.revision_number DESC LIMIT ${limit + 1}`;
      const items = rows.slice(0, limit).map(mapRevision);
      return {
        items,
        nextCursor:
          rows.length > limit ? (items.at(-1)?.revisionNumber ?? null) : null,
      };
    });
  }

  async function getRevision(input: {
    actorUserId: string;
    jobId: string;
    changeOrderId: string;
    revisionId?: string;
    revisionNumber?: number;
  }): Promise<ChangeOrderRevision | null> {
    ids(input.actorUserId, input.jobId, input.changeOrderId);
    if ((input.revisionId == null) === (input.revisionNumber == null))
      throw new TypeError("Specify exact revision identity.");
    if (input.revisionId) ids(input.revisionId);
    if (
      input.revisionNumber != null &&
      (!Number.isInteger(input.revisionNumber) || input.revisionNumber < 1)
    )
      throw new TypeError("Invalid revision number.");
    return transaction(sql, async (tx) => {
      const party = await authorize(tx, input.actorUserId, input.jobId, false);
      if (!party || !(await belongs(tx, input.jobId, input.changeOrderId)))
        return null;
      const [row] = await tx<Array<RawRevision>>`
        SELECT revision.*, state.state::text AS state, state.state_changed_at AS "stateChangedAt"
        FROM change_order_revisions revision
        JOIN current_change_order_revision_states state ON state.revision_id = revision.id
        WHERE revision.change_order_id = ${input.changeOrderId}
          AND (${input.revisionId ?? null}::uuid IS NULL OR revision.id = ${input.revisionId ?? null}::uuid)
          AND (${input.revisionNumber ?? null}::integer IS NULL OR revision.revision_number = ${input.revisionNumber ?? null}::integer)
          AND (revision.authored_side = ${party.side}::change_order_side
            OR EXISTS (SELECT 1 FROM change_order_revision_actions disclosed
              WHERE disclosed.revision_id = revision.id AND disclosed.action = 'PROPOSE'))`;
      return row ? mapRevision(row) : null;
    });
  }

  return Object.freeze({
    createDraft,
    replaceDraft,
    counterpropose,
    submitRevision: (input: ChangeOrderDecisionInput) =>
      decide(input, "PROPOSE"),
    approveRevision: (input: ChangeOrderDecisionInput) =>
      decide(input, "APPROVE"),
    rejectRevision: (input: ChangeOrderDecisionInput) =>
      decide(input, "REJECT"),
    withdrawRevision: (input: ChangeOrderDecisionInput) =>
      decide(input, "WITHDRAW"),
    listChangeOrders,
    getChangeOrder,
    listRevisions,
    getRevision,
  });
}

interface RawRevision {
  id: string;
  revision_number: number;
  state: ChangeOrderState;
  authored_by_user_id: string;
  authored_side: ChangeOrderSide;
  title: string;
  reason: string;
  change_description: string;
  scope_added: string[];
  scope_removed: string[];
  scope_changed: string[];
  price_impact_mode: ChangeOrderPriceImpact["mode"];
  delta_amount_cents: string | null;
  range_minimum_delta_cents: string | null;
  range_maximum_delta_cents: string | null;
  price_basis: string | null;
  vat_status: ChangeOrderVatStatus | null;
  schedule_impact_mode: ChangeOrderScheduleImpact["mode"];
  schedule_delta_days: number | null;
  schedule_new_date: string | null;
  schedule_range_start: string | null;
  schedule_range_end: string | null;
  material_responsibility: "PROVIDER" | "CUSTOMER" | "MIXED" | null;
  warranty_change: string | null;
  other_condition_change: string | null;
  affected_milestone_ids: string[];
  pdf_media_asset_id: string | null;
  pdf_content_sha256: string | null;
  created_at: Date;
  stateChangedAt: Date | null;
}
function mapRevision(row: RawRevision): ChangeOrderRevision {
  const priceImpact: ChangeOrderPriceImpact =
    row.price_impact_mode === "FIXED_DELTA"
      ? {
          mode: "FIXED_DELTA",
          amountCents: Number(row.delta_amount_cents),
          vatStatus: row.vat_status!,
        }
      : row.price_impact_mode === "ESTIMATE_DELTA"
        ? {
            mode: "ESTIMATE_DELTA",
            amountCents: Number(row.delta_amount_cents),
            basis: row.price_basis!,
            vatStatus: row.vat_status!,
          }
        : row.price_impact_mode === "RANGE_DELTA"
          ? {
              mode: "RANGE_DELTA",
              minimumCents: Number(row.range_minimum_delta_cents),
              maximumCents: Number(row.range_maximum_delta_cents),
              basis: row.price_basis!,
              vatStatus: row.vat_status!,
            }
          : { mode: "NONE" };
  const scheduleImpact: ChangeOrderScheduleImpact =
    row.schedule_impact_mode === "DAYS"
      ? { mode: "DAYS", deltaDays: row.schedule_delta_days! }
      : row.schedule_impact_mode === "DATE"
        ? { mode: "DATE", newDate: row.schedule_new_date! }
        : row.schedule_impact_mode === "RANGE"
          ? {
              mode: "RANGE",
              startDate: row.schedule_range_start!,
              endDate: row.schedule_range_end!,
            }
          : { mode: "NONE" };
  return {
    revisionId: row.id,
    revisionNumber: row.revision_number,
    state: row.state,
    authoredByUserId: row.authored_by_user_id,
    authoredSide: row.authored_side,
    terms: {
      title: row.title,
      reason: row.reason,
      changeDescription: row.change_description,
      scopeAdded: row.scope_added,
      scopeRemoved: row.scope_removed,
      scopeChanged: row.scope_changed,
      priceImpact,
      scheduleImpact,
      materialResponsibility: row.material_responsibility,
      warrantyChange: row.warranty_change,
      otherConditionChange: row.other_condition_change,
      affectedMilestoneIds: row.affected_milestone_ids,
      externalPdfMediaAssetId: row.pdf_media_asset_id,
    },
    pdfContentSha256: row.pdf_content_sha256,
    createdAt: row.created_at,
    stateChangedAt: row.stateChangedAt,
  };
}

async function insertRevision(
  tx: TransactionSql,
  input: {
    revisionId: string;
    changeOrderId: string;
    revisionNumber: number;
    commandId: string;
    actorUserId: string;
    party: Party;
    terms: NormalTerms;
    intent: string;
    creationState: "DRAFT" | "PROPOSED";
  },
): Promise<Date> {
  const terms = input.terms;
  const price = terms.priceImpact;
  const schedule = terms.scheduleImpact;
  const [row] = await tx<Array<{ createdAt: Date }>>`
    INSERT INTO change_order_revisions
      (id, change_order_id, revision_number, creation_command_id, command_intent_sha256,
        creation_state,
        authored_by_user_id, authored_side, title, reason, change_description,
        scope_added, scope_removed, scope_changed,
        price_impact_mode, delta_amount_cents, range_minimum_delta_cents,
        range_maximum_delta_cents, price_basis, vat_status,
        schedule_impact_mode, schedule_delta_days, schedule_new_date,
        schedule_range_start, schedule_range_end, material_responsibility,
        warranty_change, other_condition_change, affected_milestone_ids,
        document_mode, pdf_media_asset_id)
    VALUES (${input.revisionId}, ${input.changeOrderId}, ${input.revisionNumber},
      ${input.commandId}, ${input.intent}, ${input.creationState}, ${input.actorUserId}, ${input.party.side},
      ${terms.title}, ${terms.reason}, ${terms.changeDescription},
      ${[...terms.scopeAdded]}::text[], ${[...terms.scopeRemoved]}::text[], ${[...terms.scopeChanged]}::text[],
      ${price.mode}, ${"amountCents" in price ? price.amountCents : null},
      ${"minimumCents" in price ? price.minimumCents : null},
      ${"maximumCents" in price ? price.maximumCents : null},
      ${"basis" in price ? price.basis : null}, ${"vatStatus" in price ? price.vatStatus : null},
      ${schedule.mode}, ${"deltaDays" in schedule ? schedule.deltaDays : null},
      ${"newDate" in schedule ? schedule.newDate : null}::date,
      ${"startDate" in schedule ? schedule.startDate : null}::date,
      ${"endDate" in schedule ? schedule.endDate : null}::date,
      ${terms.materialResponsibility}, ${terms.warrantyChange}, ${terms.otherConditionChange},
      ${[...terms.affectedMilestoneIds]}::uuid[],
      ${terms.externalPdfMediaAssetId ? "EXTERNAL_PDF" : "STRUCTURED"},
      ${terms.externalPdfMediaAssetId}::uuid)
    RETURNING created_at AS "createdAt"`;
  if (!row) throw new Error("Change-order revision insert missing.");
  return row.createdAt;
}
async function insertAction(
  tx: TransactionSql,
  revisionId: string,
  action: "PROPOSE" | "APPROVE" | "REJECT" | "WITHDRAW" | "SUPERSEDE",
  commandId: string,
  actorUserId: string,
  intent: string,
  successorId: string | null = null,
): Promise<Date> {
  const [row] = await tx<Array<{ occurredAt: Date }>>`
    INSERT INTO change_order_revision_actions
      (id, revision_id, action_sequence, action, actor_user_id,
        command_intent_sha256, superseded_by_revision_id)
    VALUES (${commandId}, ${revisionId}, 1, ${action}, ${actorUserId},
      ${intent}, ${successorId}::uuid)
    RETURNING occurred_at AS "occurredAt"`;
  if (!row) throw new Error("Change-order action insert missing.");
  return row.occurredAt;
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
  const [party] = await tx<Array<Party>>`
    SELECT change_order_actor_side(${jobId}::uuid, ${actorUserId}::uuid)::text AS side,
      state.state::text AS state FROM jobs job
    JOIN current_job_states state ON state.job_id = job.id WHERE job.id = ${jobId}`;
  return party?.side ? party : null;
}
async function belongs(
  tx: TransactionSql,
  jobId: string,
  changeOrderId: string,
): Promise<boolean> {
  const [row] = await tx<Array<{ id: string }>>`
    SELECT id FROM change_orders WHERE id = ${changeOrderId} AND job_id = ${jobId}`;
  return !!row;
}
async function currentHead(
  tx: TransactionSql,
  changeOrderId: string,
): Promise<Head | null> {
  const [head] = await tx<Array<Head>>`
    SELECT current.revision_id AS "revisionId",
      current.revision_number AS "revisionNumber",
      current.state::text AS state,
      revision.authored_side::text AS "authoredSide"
    FROM current_change_orders current
    JOIN change_order_revisions revision ON revision.id = current.revision_id
    WHERE current.id = ${changeOrderId}`;
  return head ?? null;
}
async function lockCommand(
  tx: TransactionSql,
  commandId: string,
): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${commandId}::text, 51012))`;
}
type Existing = {
  actorUserId: string;
  jobId: string;
  changeOrderId: string;
  revisionId: string;
  revisionNumber: number;
  state: ChangeOrderState;
  intent: string;
  occurredAt: Date;
};
async function existing(
  tx: TransactionSql,
  commandId: string,
): Promise<Existing | null> {
  const rows = await tx<Array<Existing>>`
    SELECT revision.authored_by_user_id AS "actorUserId", identity.job_id AS "jobId",
      identity.id AS "changeOrderId", revision.id AS "revisionId",
      revision.revision_number AS "revisionNumber", revision.creation_state AS state,
      revision.command_intent_sha256 AS intent, revision.created_at AS "occurredAt"
    FROM change_order_revisions revision
    JOIN change_orders identity ON identity.id = revision.change_order_id
    WHERE revision.creation_command_id = ${commandId}
    UNION ALL
    SELECT action.actor_user_id AS "actorUserId", identity.job_id AS "jobId",
      identity.id AS "changeOrderId", revision.id AS "revisionId",
      revision.revision_number AS "revisionNumber", CASE action.action
        WHEN 'PROPOSE' THEN 'PROPOSED' WHEN 'APPROVE' THEN 'APPROVED'
        WHEN 'REJECT' THEN 'REJECTED' WHEN 'WITHDRAW' THEN 'WITHDRAWN'
        ELSE 'SUPERSEDED' END AS state,
      action.command_intent_sha256 AS intent, action.occurred_at AS "occurredAt"
    FROM change_order_revision_actions action
    JOIN change_order_revisions revision ON revision.id = action.revision_id
    JOIN change_orders identity ON identity.id = revision.change_order_id
    WHERE action.id = ${commandId}`;
  if (rows.length > 1)
    throw new ChangeOrderIdempotencyError("Command ID collision.");
  return rows[0] ?? null;
}
function replay(
  prior: Existing,
  intent: string,
  actorUserId: string,
  jobId: string,
  changeOrderId: string,
  revisionId: string,
): ChangeOrderCommandResult {
  if (
    prior.intent !== intent ||
    prior.actorUserId !== actorUserId ||
    prior.jobId !== jobId ||
    prior.changeOrderId !== changeOrderId ||
    prior.revisionId !== revisionId
  )
    throw new ChangeOrderIdempotencyError(
      "Command ID reused with different intent.",
    );
  return {
    status: "DEDUPLICATED",
    changeOrderId,
    revisionId,
    revisionNumber: prior.revisionNumber,
    state: prior.state,
    occurredAt: prior.occurredAt,
  };
}
function applied(
  changeOrderId: string,
  revisionId: string,
  revisionNumber: number,
  state: ChangeOrderState,
  occurredAt: Date,
): ChangeOrderCommandResult {
  return {
    status: "APPLIED",
    changeOrderId,
    revisionId,
    revisionNumber,
    state,
    occurredAt,
  };
}
function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function canonicalTerms(terms: NormalTerms): Record<string, unknown> {
  const price = terms.priceImpact;
  const schedule = terms.scheduleImpact;
  return {
    title: terms.title,
    reason: terms.reason,
    changeDescription: terms.changeDescription,
    scopeAdded: terms.scopeAdded,
    scopeRemoved: terms.scopeRemoved,
    scopeChanged: terms.scopeChanged,
    priceImpact:
      price.mode === "NONE"
        ? { mode: "NONE" }
        : price.mode === "RANGE_DELTA"
          ? {
              mode: price.mode,
              minimumCents: price.minimumCents,
              maximumCents: price.maximumCents,
              basis: price.basis,
              vatStatus: price.vatStatus,
            }
          : price.mode === "ESTIMATE_DELTA"
            ? {
                mode: price.mode,
                amountCents: price.amountCents,
                basis: price.basis,
                vatStatus: price.vatStatus,
              }
            : {
                mode: price.mode,
                amountCents: price.amountCents,
                vatStatus: price.vatStatus,
              },
    scheduleImpact:
      schedule.mode === "NONE"
        ? { mode: "NONE" }
        : schedule.mode === "DAYS"
          ? { mode: schedule.mode, deltaDays: schedule.deltaDays }
          : schedule.mode === "DATE"
            ? { mode: schedule.mode, newDate: schedule.newDate }
            : {
                mode: schedule.mode,
                startDate: schedule.startDate,
                endDate: schedule.endDate,
              },
    materialResponsibility: terms.materialResponsibility,
    warrantyChange: terms.warrantyChange,
    otherConditionChange: terms.otherConditionChange,
    affectedMilestoneIds: terms.affectedMilestoneIds,
    externalPdfMediaAssetId: terms.externalPdfMediaAssetId,
  };
}
function normalize(input: ChangeOrderTerms): NormalTerms {
  const title = bounded(input.title, 160);
  const reason = bounded(input.reason, 500);
  const changeDescription = bounded(input.changeDescription, 4000);
  const scopeAdded = lines(input.scopeAdded);
  const scopeRemoved = lines(input.scopeRemoved);
  const scopeChanged = lines(input.scopeChanged);
  const priceImpact = input.priceImpact;
  if (
    !priceImpact ||
    !["NONE", "FIXED_DELTA", "ESTIMATE_DELTA", "RANGE_DELTA"].includes(
      priceImpact.mode,
    )
  )
    throw new TypeError("Invalid price impact.");
  if (priceImpact.mode !== "NONE") {
    if (
      !["VAT_INCLUDED", "VAT_EXCLUDED", "NOT_VAT_REGISTERED"].includes(
        priceImpact.vatStatus,
      )
    )
      throw new TypeError("Invalid VAT status.");
    if (priceImpact.mode === "RANGE_DELTA") {
      cents(priceImpact.minimumCents);
      cents(priceImpact.maximumCents);
      if (
        priceImpact.minimumCents > priceImpact.maximumCents ||
        (priceImpact.minimumCents === 0 && priceImpact.maximumCents === 0)
      )
        throw new TypeError("Invalid price range.");
      bounded(priceImpact.basis, 500);
    } else {
      cents(priceImpact.amountCents);
      if (priceImpact.amountCents === 0)
        throw new TypeError("Zero price delta.");
      if (priceImpact.mode === "ESTIMATE_DELTA")
        bounded(priceImpact.basis, 500);
    }
  }
  const scheduleImpact = input.scheduleImpact;
  if (
    !scheduleImpact ||
    !["NONE", "DAYS", "DATE", "RANGE"].includes(scheduleImpact.mode)
  )
    throw new TypeError("Invalid schedule impact.");
  if (
    scheduleImpact.mode === "DAYS" &&
    (!Number.isInteger(scheduleImpact.deltaDays) ||
      scheduleImpact.deltaDays === 0 ||
      Math.abs(scheduleImpact.deltaDays) > 3650)
  )
    throw new TypeError("Invalid schedule days.");
  if (scheduleImpact.mode === "DATE") day(scheduleImpact.newDate);
  if (scheduleImpact.mode === "RANGE") {
    day(scheduleImpact.startDate);
    day(scheduleImpact.endDate);
    if (scheduleImpact.startDate > scheduleImpact.endDate)
      throw new TypeError("Invalid schedule range.");
  }
  const materialResponsibility = input.materialResponsibility ?? null;
  if (
    materialResponsibility &&
    !["PROVIDER", "CUSTOMER", "MIXED"].includes(materialResponsibility)
  )
    throw new TypeError("Invalid material responsibility.");
  const warrantyChange =
    input.warrantyChange == null ? null : bounded(input.warrantyChange, 1000);
  const otherConditionChange =
    input.otherConditionChange == null
      ? null
      : bounded(input.otherConditionChange, 1000);
  const affectedMilestoneIds = [...(input.affectedMilestoneIds ?? [])];
  if (
    affectedMilestoneIds.length > 50 ||
    new Set(affectedMilestoneIds).size !== affectedMilestoneIds.length
  )
    throw new TypeError("Invalid affected milestones.");
  ids(...affectedMilestoneIds);
  const externalPdfMediaAssetId = input.externalPdfMediaAssetId ?? null;
  if (externalPdfMediaAssetId) ids(externalPdfMediaAssetId);
  if (
    scopeAdded.length + scopeRemoved.length + scopeChanged.length === 0 &&
    priceImpact.mode === "NONE" &&
    scheduleImpact.mode === "NONE" &&
    !materialResponsibility &&
    !warrantyChange &&
    !otherConditionChange
  )
    throw new TypeError("Change order must change a term.");
  return {
    title,
    reason,
    changeDescription,
    scopeAdded,
    scopeRemoved,
    scopeChanged,
    priceImpact,
    scheduleImpact,
    materialResponsibility,
    warrantyChange,
    otherConditionChange,
    affectedMilestoneIds,
    externalPdfMediaAssetId,
  };
}
function lines(value: readonly string[]): string[] {
  if (!Array.isArray(value) || value.length > 50)
    throw new TypeError("Invalid scope lines.");
  return (value as readonly unknown[]).map((item) =>
    bounded(item as string, 500),
  );
}
function bounded(value: string, max: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > max ||
    value.trim() !== value ||
    control.test(value)
  )
    throw new TypeError("Invalid Change-order text.");
  return value;
}
function cents(value: number): void {
  if (!Number.isSafeInteger(value) || Math.abs(value) > 1_000_000_000_000)
    throw new TypeError("Invalid EUR cents.");
}
function day(value: string): void {
  const parsed =
    typeof value === "string" && datePattern.test(value)
      ? Date.parse(`${value}T00:00:00.000Z`)
      : NaN;
  if (
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString().slice(0, 10) !== value
  )
    throw new TypeError("Invalid date.");
}
function ids(...values: string[]): void {
  if (values.some((value) => typeof value !== "string" || !uuid.test(value)))
    throw new TypeError("Invalid Change-order identity.");
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
