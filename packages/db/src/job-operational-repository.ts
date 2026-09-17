import type { Sql, TransactionSql } from "postgres";

import type { JobDocumentationItem } from "./job-documentation-repository.js";

type RootSql = Sql | TransactionSql;
type Role = "CUSTOMER" | "PRIMARY_PROVIDER";
type State =
  | "CONFIRMED"
  | "IN_PROGRESS"
  | "COMPLETION_REQUESTED"
  | "COMPLETED"
  | "CANCELLED";
export type JobIssueKind = "PROBLEM" | "DELAY" | "WAITING";
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface JobOperationalCursor {
  readonly createdAt: Date;
  readonly id: string;
}
export interface JobOperationalCreateInput {
  readonly actorUserId: string;
  readonly commandId: string;
  readonly jobId: string;
  readonly body: string;
  readonly mediaAssetIds?: readonly string[];
}
export interface JobOperationalListInput {
  readonly actorUserId: string;
  readonly jobId: string;
  readonly limit: number;
  readonly cursor?: JobOperationalCursor;
}
export interface JobIssueInput extends JobOperationalCreateInput {
  readonly kind: JobIssueKind;
}
export interface JobIssueCommentInput {
  readonly actorUserId: string;
  readonly commandId: string;
  readonly jobId: string;
  readonly issueId: string;
  readonly body: string;
}
export interface JobIssueCommentListInput {
  readonly actorUserId: string;
  readonly jobId: string;
  readonly issueId: string;
  readonly limit: number;
  readonly cursor?: JobOperationalCursor;
}
export interface JobProgressAcknowledgeInput {
  readonly actorUserId: string;
  readonly commandId: string;
  readonly jobId: string;
  readonly updateId: string;
}
export type JobOperationalCreateResult =
  | Readonly<{
      status: "APPLIED" | "DEDUPLICATED";
      id: string;
      createdAt: Date;
    }>
  | Readonly<{ status: "NOT_FOUND" | "STALE_STATE" }>;
export type JobProgressAcknowledgeResult =
  | Readonly<{ status: "APPLIED" | "DEDUPLICATED"; acknowledgedAt: Date }>
  | Readonly<{ status: "NOT_FOUND" | "STALE_STATE" }>;
export interface JobProgressItem {
  readonly id: string;
  readonly jobId: string;
  readonly authorDisplayName: string;
  readonly body: string;
  readonly createdAt: Date;
  readonly acknowledgedAt: Date | null;
  readonly media: readonly JobDocumentationItem[];
}
export interface JobIssueItem {
  readonly id: string;
  readonly jobId: string;
  readonly authorDisplayName: string;
  readonly authorRole: Role;
  readonly kind: JobIssueKind;
  readonly body: string;
  readonly createdAt: Date;
  readonly media: readonly JobDocumentationItem[];
}
export interface JobIssueCommentItem {
  readonly id: string;
  readonly authorDisplayName: string;
  readonly authorRole: Role;
  readonly body: string;
  readonly createdAt: Date;
}
export interface JobOperationalPage<T> {
  readonly items: readonly T[];
  readonly canCreate: boolean;
  readonly nextCursor: JobOperationalCursor | null;
}
export class JobOperationalIdempotencyError extends Error {}

interface Party {
  readonly role: Role;
  readonly state: State;
}
interface CommandReference {
  readonly kind: "PROGRESS" | "ACK" | "ISSUE" | "COMMENT";
  readonly actorUserId: string;
}
interface ExistingProgress {
  readonly id: string;
  readonly jobId: string;
  readonly authorUserId: string;
  readonly body: string;
  readonly createdAt: Date;
}
interface ExistingIssue extends ExistingProgress {
  readonly kind: JobIssueKind;
}
interface ExistingComment {
  readonly id: string;
  readonly issueId: string;
  readonly authorUserId: string;
  readonly body: string;
  readonly createdAt: Date;
}
interface ExistingAck {
  readonly progressUpdateId: string;
  readonly customerUserId: string;
  readonly acknowledgedAt: Date;
}
type ProgressRow = Omit<JobProgressItem, "media">;
type IssueRow = Omit<JobIssueItem, "media">;
interface LinkedMediaRow {
  readonly parentId: string;
  readonly position: number;
  readonly mediaAssetId: string;
  readonly mediaKind: "IMAGE" | "DOCUMENT";
  readonly sourceMessageId: string;
  readonly uploadedByUserId: string;
  readonly authorRole: Role;
  readonly uploadedAt: Date;
  readonly capturedAt: Date | null;
  readonly chronologicalAt: Date;
  readonly displayFilename: string | null;
  readonly contentType: string;
}

export function createJobOperationalRepository(sql: RootSql) {
  return Object.freeze({
    async createProgress(
      input: JobOperationalCreateInput,
    ): Promise<JobOperationalCreateResult> {
      validateCreate(input, 1);
      return transaction(sql, async (tx) => {
        const party = await authorizeJob(
          tx,
          input.actorUserId,
          input.jobId,
          true,
        );
        if (party?.role !== "PRIMARY_PROVIDER") return { status: "NOT_FOUND" };
        await lockCommand(tx, input.commandId);
        const reference = await existingCommand(tx, input.commandId);
        if (reference !== null) {
          if (reference.actorUserId !== input.actorUserId)
            return { status: "NOT_FOUND" };
          if (reference.kind !== "PROGRESS") throw conflict();
          const [row] = await tx<ExistingProgress[]>`
            SELECT id, job_id AS "jobId", author_user_id AS "authorUserId",
              body, created_at AS "createdAt"
            FROM job_progress_updates WHERE id = ${input.commandId}
          `;
          if (row === undefined || row.authorUserId !== input.actorUserId)
            return { status: "NOT_FOUND" };
          if (row.jobId !== input.jobId || row.body !== input.body.trim())
            throw conflict();
          if (
            !(await mediaSetMatches(
              tx,
              "PROGRESS",
              row.id,
              input.mediaAssetIds ?? [],
            ))
          )
            throw conflict();
          return Object.freeze({
            status: "DEDUPLICATED" as const,
            id: row.id,
            createdAt: row.createdAt,
          });
        }
        if (!open(party.state)) return { status: "STALE_STATE" };
        if (
          !(await mediaAvailable(
            tx,
            input.jobId,
            input.mediaAssetIds ?? [],
            "PROGRESS",
          ))
        )
          return { status: "NOT_FOUND" };
        const [row] = await tx<Array<{ id: string; createdAt: Date }>>`
          INSERT INTO job_progress_updates (id, job_id, author_user_id, body)
          VALUES (${input.commandId}, ${input.jobId}, ${input.actorUserId}, ${input.body.trim()})
          RETURNING id, created_at AS "createdAt"
        `;
        if (row === undefined) throw new Error("Job progress insert missing.");
        await linkMedia(tx, "PROGRESS", row.id, input.mediaAssetIds ?? []);
        return Object.freeze({ status: "APPLIED" as const, ...row });
      });
    },
    async listProgress(
      input: JobOperationalListInput,
    ): Promise<JobOperationalPage<JobProgressItem> | null> {
      validateList(input);
      return transaction(sql, async (tx) => {
        const party = await authorizeJob(
          tx,
          input.actorUserId,
          input.jobId,
          false,
        );
        if (party === null) return null;
        const beforeAt = input.cursor?.createdAt ?? null;
        const beforeId = input.cursor?.id ?? null;
        const rows = await tx<ProgressRow[]>`
          SELECT progress.id, progress.job_id AS "jobId",
            CASE WHEN provider.profile_type = 'COMPANY'
              THEN provider.official_company_name
              ELSE coalesce(provider.nickname,
                provider.real_first_name || ' ' || provider.real_last_name,
                'Remeselník ' || left(provider.id::text, 8))
              END AS "authorDisplayName",
            progress.body, progress.created_at AS "createdAt",
            ack.acknowledged_at AS "acknowledgedAt"
          FROM job_progress_updates progress
          JOIN jobs job ON job.id = progress.job_id
          JOIN craftsman_profiles provider
            ON provider.id = job.primary_craftsman_profile_id
          LEFT JOIN job_progress_acknowledgements ack
            ON ack.progress_update_id = progress.id
          WHERE progress.job_id = ${input.jobId}
            AND (${beforeAt}::timestamptz IS NULL
              OR (progress.created_at, progress.id) <
                (${beforeAt}::timestamptz, ${beforeId}::uuid))
          ORDER BY progress.created_at DESC, progress.id DESC
          LIMIT ${input.limit + 1}
        `;
        const enriched = await enrichMedia(tx, "PROGRESS", rows, input.jobId);
        return page(
          enriched,
          input.limit,
          party.role === "PRIMARY_PROVIDER" && open(party.state),
        );
      });
    },
    async getProgress(input: {
      readonly actorUserId: string;
      readonly jobId: string;
      readonly updateId: string;
    }): Promise<JobProgressItem | null> {
      validateUuids(input.actorUserId, input.jobId, input.updateId);
      return transaction(sql, async (tx) => {
        if (
          (await authorizeJob(tx, input.actorUserId, input.jobId, false)) ===
          null
        )
          return null;
        const [row] = await tx<ProgressRow[]>`
          SELECT progress.id, progress.job_id AS "jobId",
            CASE WHEN provider.profile_type = 'COMPANY'
              THEN provider.official_company_name
              ELSE coalesce(provider.nickname,
                provider.real_first_name || ' ' || provider.real_last_name,
                'Remeselník ' || left(provider.id::text, 8))
              END AS "authorDisplayName",
            progress.body, progress.created_at AS "createdAt",
            ack.acknowledged_at AS "acknowledgedAt"
          FROM job_progress_updates progress
          JOIN jobs job ON job.id = progress.job_id
          JOIN craftsman_profiles provider
            ON provider.id = job.primary_craftsman_profile_id
          LEFT JOIN job_progress_acknowledgements ack
            ON ack.progress_update_id = progress.id
          WHERE progress.job_id = ${input.jobId} AND progress.id = ${input.updateId}
        `;
        if (row === undefined) return null;
        const [item] = await enrichMedia(tx, "PROGRESS", [row], input.jobId);
        return item ?? null;
      });
    },
    async acknowledgeProgress(
      input: JobProgressAcknowledgeInput,
    ): Promise<JobProgressAcknowledgeResult> {
      validateUuids(
        input.actorUserId,
        input.commandId,
        input.jobId,
        input.updateId,
      );
      return transaction(sql, async (tx) => {
        const [progress] = await tx<Array<{ jobId: string }>>`
          SELECT job_id AS "jobId" FROM job_progress_updates
          WHERE id = ${input.updateId} AND job_id = ${input.jobId}
        `;
        if (progress === undefined) return { status: "NOT_FOUND" };
        const party = await authorizeJob(
          tx,
          input.actorUserId,
          progress.jobId,
          true,
        );
        if (party?.role !== "CUSTOMER") return { status: "NOT_FOUND" };
        await lockCommand(tx, input.commandId);
        const reference = await existingCommand(tx, input.commandId);
        if (reference !== null) {
          if (reference.actorUserId !== input.actorUserId)
            return { status: "NOT_FOUND" };
          if (reference.kind !== "ACK") throw conflict();
          const [row] = await tx<ExistingAck[]>`
            SELECT progress_update_id AS "progressUpdateId",
              customer_user_id AS "customerUserId",
              acknowledged_at AS "acknowledgedAt"
            FROM job_progress_acknowledgements WHERE id = ${input.commandId}
          `;
          if (row === undefined || row.customerUserId !== input.actorUserId)
            return { status: "NOT_FOUND" };
          if (row.progressUpdateId !== input.updateId) throw conflict();
          return Object.freeze({
            status: "DEDUPLICATED" as const,
            acknowledgedAt: row.acknowledgedAt,
          });
        }
        if (!open(party.state)) return { status: "STALE_STATE" };
        const [prior] = await tx<Array<{ id: string }>>`
          SELECT id FROM job_progress_acknowledgements
          WHERE progress_update_id = ${input.updateId}
            AND customer_user_id = ${input.actorUserId}
        `;
        if (prior !== undefined) return { status: "STALE_STATE" };
        const [row] = await tx<Array<{ acknowledgedAt: Date }>>`
          INSERT INTO job_progress_acknowledgements
            (id, progress_update_id, customer_user_id)
          VALUES (${input.commandId}, ${input.updateId}, ${input.actorUserId})
          RETURNING acknowledged_at AS "acknowledgedAt"
        `;
        if (row === undefined)
          throw new Error("Job progress acknowledgement missing.");
        return Object.freeze({
          status: "APPLIED" as const,
          acknowledgedAt: row.acknowledgedAt,
        });
      });
    },
    async createIssue(
      input: JobIssueInput,
    ): Promise<JobOperationalCreateResult> {
      validateCreate(input, 8);
      if (!["PROBLEM", "DELAY", "WAITING"].includes(input.kind))
        throw new TypeError("Invalid Job Issue kind.");
      return transaction(sql, async (tx) => {
        const party = await authorizeJob(
          tx,
          input.actorUserId,
          input.jobId,
          true,
        );
        if (party === null) return { status: "NOT_FOUND" };
        await lockCommand(tx, input.commandId);
        const reference = await existingCommand(tx, input.commandId);
        if (reference !== null) {
          if (reference.actorUserId !== input.actorUserId)
            return { status: "NOT_FOUND" };
          if (reference.kind !== "ISSUE") throw conflict();
          const [row] = await tx<ExistingIssue[]>`
            SELECT id, job_id AS "jobId", author_user_id AS "authorUserId",
              kind::text, body, created_at AS "createdAt"
            FROM job_issues WHERE id = ${input.commandId}
          `;
          if (row === undefined || row.authorUserId !== input.actorUserId)
            return { status: "NOT_FOUND" };
          if (
            row.jobId !== input.jobId ||
            row.body !== input.body.trim() ||
            row.kind !== input.kind
          )
            throw conflict();
          if (
            !(await mediaSetMatches(
              tx,
              "ISSUE",
              row.id,
              input.mediaAssetIds ?? [],
            ))
          )
            throw conflict();
          return Object.freeze({
            status: "DEDUPLICATED" as const,
            id: row.id,
            createdAt: row.createdAt,
          });
        }
        if (!open(party.state)) return { status: "STALE_STATE" };
        if (
          !(await mediaAvailable(
            tx,
            input.jobId,
            input.mediaAssetIds ?? [],
            "ISSUE",
          ))
        )
          return { status: "NOT_FOUND" };
        const [row] = await tx<Array<{ id: string; createdAt: Date }>>`
          INSERT INTO job_issues
            (id, job_id, author_user_id, author_role, kind, body)
          VALUES (${input.commandId}, ${input.jobId}, ${input.actorUserId},
            ${party.role}, ${input.kind}, ${input.body.trim()})
          RETURNING id, created_at AS "createdAt"
        `;
        if (row === undefined) throw new Error("Job Issue insert missing.");
        await linkMedia(tx, "ISSUE", row.id, input.mediaAssetIds ?? []);
        return Object.freeze({ status: "APPLIED" as const, ...row });
      });
    },
    async listIssues(
      input: JobOperationalListInput,
    ): Promise<JobOperationalPage<JobIssueItem> | null> {
      validateList(input);
      return transaction(sql, async (tx) => {
        const party = await authorizeJob(
          tx,
          input.actorUserId,
          input.jobId,
          false,
        );
        if (party === null) return null;
        const beforeAt = input.cursor?.createdAt ?? null;
        const beforeId = input.cursor?.id ?? null;
        const rows = await tx<IssueRow[]>`
          SELECT issue.id, issue.job_id AS "jobId", issue.author_role AS "authorRole",
            CASE WHEN issue.author_role = 'CUSTOMER'
              THEN 'Konto ' || left(issue.author_user_id::text, 8)
              WHEN provider.profile_type = 'COMPANY'
              THEN provider.official_company_name
              ELSE coalesce(provider.nickname,
                provider.real_first_name || ' ' || provider.real_last_name,
                'Remeselník ' || left(provider.id::text, 8))
              END AS "authorDisplayName",
            issue.kind::text, issue.body, issue.created_at AS "createdAt"
          FROM job_issues issue
          JOIN jobs job ON job.id = issue.job_id
          JOIN craftsman_profiles provider
            ON provider.id = job.primary_craftsman_profile_id
          WHERE issue.job_id = ${input.jobId}
            AND (${beforeAt}::timestamptz IS NULL
              OR (issue.created_at, issue.id) <
                (${beforeAt}::timestamptz, ${beforeId}::uuid))
          ORDER BY issue.created_at DESC, issue.id DESC
          LIMIT ${input.limit + 1}
        `;
        const enriched = await enrichMedia(tx, "ISSUE", rows, input.jobId);
        return page(enriched, input.limit, open(party.state));
      });
    },
    async getIssue(input: {
      readonly actorUserId: string;
      readonly jobId: string;
      readonly issueId: string;
    }): Promise<JobIssueItem | null> {
      validateUuids(input.actorUserId, input.jobId, input.issueId);
      return transaction(sql, async (tx) => {
        if (
          (await authorizeJob(tx, input.actorUserId, input.jobId, false)) ===
          null
        )
          return null;
        const [row] = await tx<IssueRow[]>`
          SELECT issue.id, issue.job_id AS "jobId", issue.author_role AS "authorRole",
            CASE WHEN issue.author_role = 'CUSTOMER'
              THEN 'Konto ' || left(issue.author_user_id::text, 8)
              WHEN provider.profile_type = 'COMPANY'
              THEN provider.official_company_name
              ELSE coalesce(provider.nickname,
                provider.real_first_name || ' ' || provider.real_last_name,
                'Remeselník ' || left(provider.id::text, 8))
              END AS "authorDisplayName",
            issue.kind::text, issue.body, issue.created_at AS "createdAt"
          FROM job_issues issue
          JOIN jobs job ON job.id = issue.job_id
          JOIN craftsman_profiles provider
            ON provider.id = job.primary_craftsman_profile_id
          WHERE issue.job_id = ${input.jobId} AND issue.id = ${input.issueId}
        `;
        if (row === undefined) return null;
        const [item] = await enrichMedia(tx, "ISSUE", [row], input.jobId);
        return item ?? null;
      });
    },
    async addIssueComment(
      input: JobIssueCommentInput,
    ): Promise<JobOperationalCreateResult> {
      validateUuids(
        input.actorUserId,
        input.commandId,
        input.jobId,
        input.issueId,
      );
      validateBody(input.body, 1);
      return transaction(sql, async (tx) => {
        const [issue] = await tx<Array<{ jobId: string }>>`
          SELECT job_id AS "jobId" FROM job_issues
          WHERE id = ${input.issueId} AND job_id = ${input.jobId}
        `;
        if (issue === undefined) return { status: "NOT_FOUND" };
        const party = await authorizeJob(
          tx,
          input.actorUserId,
          issue.jobId,
          true,
        );
        if (party === null) return { status: "NOT_FOUND" };
        await lockCommand(tx, input.commandId);
        const reference = await existingCommand(tx, input.commandId);
        if (reference !== null) {
          if (reference.actorUserId !== input.actorUserId)
            return { status: "NOT_FOUND" };
          if (reference.kind !== "COMMENT") throw conflict();
          const [row] = await tx<ExistingComment[]>`
            SELECT id, issue_id AS "issueId", author_user_id AS "authorUserId",
              body, created_at AS "createdAt"
            FROM job_issue_comments WHERE id = ${input.commandId}
          `;
          if (row === undefined || row.authorUserId !== input.actorUserId)
            return { status: "NOT_FOUND" };
          if (row.issueId !== input.issueId || row.body !== input.body.trim())
            throw conflict();
          return Object.freeze({
            status: "DEDUPLICATED" as const,
            id: row.id,
            createdAt: row.createdAt,
          });
        }
        if (!open(party.state)) return { status: "STALE_STATE" };
        const [row] = await tx<Array<{ id: string; createdAt: Date }>>`
          INSERT INTO job_issue_comments
            (id, issue_id, author_user_id, author_role, body)
          VALUES (${input.commandId}, ${input.issueId}, ${input.actorUserId},
            ${party.role}, ${input.body.trim()})
          RETURNING id, created_at AS "createdAt"
        `;
        if (row === undefined)
          throw new Error("Job Issue comment insert missing.");
        return Object.freeze({ status: "APPLIED" as const, ...row });
      });
    },
    async listIssueComments(
      input: JobIssueCommentListInput,
    ): Promise<JobOperationalPage<JobIssueCommentItem> | null> {
      validateUuids(input.actorUserId, input.jobId, input.issueId);
      validatePage(input.limit, input.cursor);
      return transaction(sql, async (tx) => {
        const [issue] = await tx<Array<{ jobId: string }>>`
          SELECT job_id AS "jobId" FROM job_issues
          WHERE id = ${input.issueId} AND job_id = ${input.jobId}
        `;
        if (issue === undefined) return null;
        const party = await authorizeJob(
          tx,
          input.actorUserId,
          issue.jobId,
          false,
        );
        if (party === null) return null;
        const beforeAt = input.cursor?.createdAt ?? null;
        const beforeId = input.cursor?.id ?? null;
        const rows = await tx<JobIssueCommentItem[]>`
          SELECT comment.id, comment.author_role AS "authorRole",
            CASE WHEN comment.author_role = 'CUSTOMER'
              THEN 'Konto ' || left(comment.author_user_id::text, 8)
              WHEN provider.profile_type = 'COMPANY'
              THEN provider.official_company_name
              ELSE coalesce(provider.nickname,
                provider.real_first_name || ' ' || provider.real_last_name,
                'Remeselník ' || left(provider.id::text, 8))
              END AS "authorDisplayName",
            comment.body, comment.created_at AS "createdAt"
          FROM job_issue_comments comment
          JOIN job_issues issue ON issue.id = comment.issue_id
          JOIN jobs job ON job.id = issue.job_id
          JOIN craftsman_profiles provider
            ON provider.id = job.primary_craftsman_profile_id
          WHERE comment.issue_id = ${input.issueId}
            AND (${beforeAt}::timestamptz IS NULL
              OR (comment.created_at, comment.id) <
                (${beforeAt}::timestamptz, ${beforeId}::uuid))
          ORDER BY comment.created_at DESC, comment.id DESC
          LIMIT ${input.limit + 1}
        `;
        return page(rows, input.limit, open(party.state));
      });
    },
  });
}

async function authorizeJob(
  tx: TransactionSql,
  actorUserId: string,
  jobId: string,
  write: boolean,
): Promise<Party | null> {
  if (write) {
    const [job] = await tx<Array<{ id: string }>>`
      SELECT id FROM jobs WHERE id = ${jobId} FOR UPDATE
    `;
    if (job === undefined) return null;
    await tx`SELECT id FROM users WHERE id = ${actorUserId} FOR SHARE`;
    await tx`SELECT user_id FROM auth_credentials WHERE user_id = ${actorUserId} FOR SHARE`;
  }
  const [party] = await tx<Party[]>`
    SELECT CASE WHEN customer.owner_user_id = viewer.id
        THEN 'CUSTOMER' ELSE 'PRIMARY_PROVIDER' END AS role,
      state.state::text AS state
    FROM jobs job
    JOIN customer_profiles customer ON customer.id = job.customer_profile_id
    JOIN craftsman_profiles provider
      ON provider.id = job.primary_craftsman_profile_id
    JOIN current_job_states state ON state.job_id = job.id
    JOIN job_acceptance_events accepted ON accepted.job_id = job.id
    JOIN job_agreement_snapshots snapshot ON snapshot.job_id = job.id
    JOIN users viewer ON viewer.id = ${actorUserId}
    JOIN auth_credentials credentials ON credentials.user_id = viewer.id
    WHERE job.id = ${jobId} AND viewer.account_state = 'ACTIVE'
      AND credentials.email_verified_at IS NOT NULL
      AND credentials.phone_verified_at IS NOT NULL
      AND (customer.owner_user_id = viewer.id
        OR provider.owner_user_id = viewer.id)
  `;
  if (party === undefined) return null;
  if (
    !["CUSTOMER", "PRIMARY_PROVIDER"].includes(party.role) ||
    ![
      "CONFIRMED",
      "IN_PROGRESS",
      "COMPLETION_REQUESTED",
      "COMPLETED",
      "CANCELLED",
    ].includes(party.state)
  )
    throw new Error("Invalid Job operational party projection.");
  return party;
}

async function lockCommand(tx: TransactionSql, id: string): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${id}::text, 51010))`;
}
async function existingCommand(
  tx: TransactionSql,
  id: string,
): Promise<CommandReference | null> {
  const rows = await tx<CommandReference[]>`
    SELECT 'PROGRESS' AS kind, author_user_id AS "actorUserId"
      FROM job_progress_updates WHERE id = ${id}
    UNION ALL SELECT 'ACK' AS kind, customer_user_id AS "actorUserId"
      FROM job_progress_acknowledgements WHERE id = ${id}
    UNION ALL SELECT 'ISSUE' AS kind, author_user_id AS "actorUserId"
      FROM job_issues WHERE id = ${id}
    UNION ALL SELECT 'COMMENT' AS kind, author_user_id AS "actorUserId"
      FROM job_issue_comments WHERE id = ${id}
  `;
  if (rows.length > 1) throw new Error("Job operational command ID collision.");
  return rows[0] ?? null;
}
function conflict(): JobOperationalIdempotencyError {
  return new JobOperationalIdempotencyError(
    "Job operational command ID was reused for another intent.",
  );
}
function open(state: State): boolean {
  return state === "CONFIRMED" || state === "IN_PROGRESS";
}
function page<T extends { readonly id: string; readonly createdAt: Date }>(
  rows: readonly T[],
  limit: number,
  canCreate: boolean,
): JobOperationalPage<T> {
  const items = rows.slice(0, limit);
  const last = rows.length > limit ? items.at(-1) : undefined;
  return Object.freeze({
    items: Object.freeze(items),
    canCreate,
    nextCursor:
      last === undefined
        ? null
        : Object.freeze({ createdAt: last.createdAt, id: last.id }),
  });
}
function validateUuids(...values: string[]): void {
  if (values.some((value) => !uuid.test(value)))
    throw new TypeError("Invalid Job operational identifier.");
}
function validateBody(body: string, min: number): void {
  if (
    typeof body !== "string" ||
    body.trim().length < min ||
    body.trim().length > 2000 ||
    [...body].some((character) => {
      const code = character.codePointAt(0);
      return code !== undefined && (code < 32 || code === 127);
    })
  )
    throw new TypeError("Invalid Job operational body.");
}
function validateCreate(input: JobOperationalCreateInput, min: number): void {
  validateUuids(input.actorUserId, input.commandId, input.jobId);
  validateBody(input.body, min);
  validateMediaIds(input.mediaAssetIds);
}
function validateMediaIds(ids?: readonly string[]): void {
  if (ids === undefined) return;
  if (!Array.isArray(ids) || ids.length > 5 || new Set(ids).size !== ids.length)
    throw new TypeError("Invalid Job operational media selection.");
  for (const id of ids) {
    if (typeof id !== "string" || !uuid.test(id))
      throw new TypeError("Invalid Job operational media selection.");
  }
}

async function mediaSetMatches(
  tx: TransactionSql,
  kind: "PROGRESS" | "ISSUE",
  parentId: string,
  selected: readonly string[],
): Promise<boolean> {
  const rows = await tx<Array<{ mediaAssetId: string }>>`
    SELECT media_asset_id AS "mediaAssetId" FROM job_progress_media
      WHERE ${kind} = 'PROGRESS' AND progress_update_id = ${parentId}
    UNION ALL
    SELECT media_asset_id AS "mediaAssetId" FROM job_issue_media
      WHERE ${kind} = 'ISSUE' AND issue_id = ${parentId}
  `;
  const selectedSorted = [...selected].sort();
  return (
    rows.length === selected.length &&
    rows
      .map((row) => row.mediaAssetId)
      .sort()
      .every((id, index) => id === selectedSorted[index])
  );
}

async function mediaAvailable(
  tx: TransactionSql,
  jobId: string,
  selected: readonly string[],
  kind: "PROGRESS" | "ISSUE",
): Promise<boolean> {
  if (selected.length === 0) return true;
  const rows = await tx<Array<{ mediaAssetId: string; mediaKind: string }>>`
    SELECT media.media_asset_id AS "mediaAssetId",
      media.media_kind::text AS "mediaKind"
    FROM job_conversation_media media
    JOIN media_assets asset ON asset.id = media.media_asset_id
      AND asset.status = 'READY'
      AND (asset.kind = 'IMAGE' OR asset.malware_scan_verdict = 'CLEAN')
    JOIN media_asset_storage_objects canonical
      ON canonical.media_asset_id = asset.id
      AND canonical.role = 'CANONICAL'
      AND canonical.storage_area = 'private'
      AND canonical.revoked_at IS NULL
    WHERE media.job_id = ${jobId}
      AND media.media_asset_id = ANY(${selected}::uuid[])
      AND ((media.media_kind = 'IMAGE' AND asset.kind = 'IMAGE')
        OR (media.media_kind = 'DOCUMENT' AND asset.kind = 'DOCUMENT'
          AND canonical.content_type = 'application/pdf'))
  `;
  return (
    rows.length === selected.length &&
    rows.every((row) => kind === "ISSUE" || row.mediaKind === "IMAGE")
  );
}

async function linkMedia(
  tx: TransactionSql,
  kind: "PROGRESS" | "ISSUE",
  parentId: string,
  selected: readonly string[],
): Promise<void> {
  for (const [index, mediaAssetId] of selected.entries()) {
    if (kind === "PROGRESS") {
      await tx`INSERT INTO job_progress_media
        (progress_update_id, media_asset_id, position)
        VALUES (${parentId}, ${mediaAssetId}, ${index + 1})`;
    } else {
      await tx`INSERT INTO job_issue_media
        (issue_id, media_asset_id, position)
        VALUES (${parentId}, ${mediaAssetId}, ${index + 1})`;
    }
  }
}

async function enrichMedia<R extends { readonly id: string }>(
  tx: TransactionSql,
  kind: "PROGRESS" | "ISSUE",
  rows: readonly R[],
  jobId: string,
): Promise<
  readonly (R & { readonly media: readonly JobDocumentationItem[] })[]
> {
  if (rows.length === 0) return Object.freeze([]);
  const ids = rows.map((row) => row.id);
  const links = await tx<LinkedMediaRow[]>`
    WITH links AS (
      SELECT progress_update_id AS parent_id, media_asset_id, position,
        'PROGRESS' AS parent_kind
      FROM job_progress_media WHERE progress_update_id = ANY(${ids}::uuid[])
      UNION ALL
      SELECT issue_id AS parent_id, media_asset_id, position,
        'ISSUE' AS parent_kind
      FROM job_issue_media WHERE issue_id = ANY(${ids}::uuid[])
    )
    SELECT links.parent_id AS "parentId", links.position,
      media.media_asset_id AS "mediaAssetId",
      media.media_kind::text AS "mediaKind",
      media.source_message_id AS "sourceMessageId",
      media.uploaded_by_user_id AS "uploadedByUserId",
      CASE WHEN customer.owner_user_id = media.uploaded_by_user_id
        THEN 'CUSTOMER' ELSE 'PRIMARY_PROVIDER' END AS "authorRole",
      media.uploaded_at AS "uploadedAt", media.captured_at AS "capturedAt",
      media.chronological_at AS "chronologicalAt",
      asset.display_filename AS "displayFilename",
      canonical.content_type AS "contentType"
    FROM links
    JOIN job_conversation_media media ON media.job_id = ${jobId}
      AND media.media_asset_id = links.media_asset_id
    JOIN jobs job ON job.id = media.job_id
    JOIN customer_profiles customer ON customer.id = job.customer_profile_id
    JOIN craftsman_profiles provider
      ON provider.id = job.primary_craftsman_profile_id
    JOIN media_assets asset ON asset.id = media.media_asset_id
      AND asset.status = 'READY'
      AND (asset.kind = 'IMAGE' OR asset.malware_scan_verdict = 'CLEAN')
    JOIN media_asset_storage_objects canonical
      ON canonical.media_asset_id = asset.id
      AND canonical.role = 'CANONICAL'
      AND canonical.storage_area = 'private'
      AND canonical.revoked_at IS NULL
    WHERE links.parent_kind = ${kind}
      AND (media.uploaded_by_user_id = customer.owner_user_id
        OR media.uploaded_by_user_id = provider.owner_user_id)
      AND ((media.media_kind = 'IMAGE' AND asset.kind = 'IMAGE')
        OR (media.media_kind = 'DOCUMENT' AND asset.kind = 'DOCUMENT'
          AND canonical.content_type = 'application/pdf'))
    ORDER BY links.parent_id, links.position
  `;
  const grouped = new Map<string, JobDocumentationItem[]>();
  for (const link of links) {
    if (
      !uuid.test(link.parentId) ||
      !uuid.test(link.mediaAssetId) ||
      !uuid.test(link.sourceMessageId) ||
      !uuid.test(link.uploadedByUserId) ||
      !Number.isInteger(link.position) ||
      link.position < 1 ||
      link.position > 5 ||
      !["IMAGE", "DOCUMENT"].includes(link.mediaKind) ||
      !["CUSTOMER", "PRIMARY_PROVIDER"].includes(link.authorRole) ||
      !(link.uploadedAt instanceof Date) ||
      !(link.chronologicalAt instanceof Date) ||
      (link.capturedAt !== null && !(link.capturedAt instanceof Date)) ||
      typeof link.contentType !== "string"
    )
      throw new Error("Invalid Job operational media provenance.");
    const item: JobDocumentationItem = Object.freeze({
      mediaAssetId: link.mediaAssetId,
      kind: link.mediaKind === "IMAGE" ? "PHOTO" : "DOCUMENT",
      source: "WINNING_CONVERSATION",
      sourceMessageId: link.sourceMessageId,
      uploadedByUserId: link.uploadedByUserId,
      authorRole: link.authorRole,
      uploadedAt: link.uploadedAt,
      capturedAt: link.capturedAt,
      chronologicalAt: link.chronologicalAt,
      displayFilename: link.displayFilename,
      contentType: link.contentType,
      downloadPath: `/v1/media/${link.mediaAssetId}/download`,
    });
    const group = grouped.get(link.parentId) ?? [];
    group.push(item);
    grouped.set(link.parentId, group);
  }
  return Object.freeze(
    rows.map((row) =>
      Object.freeze({
        ...row,
        media: Object.freeze(grouped.get(row.id) ?? []),
      }),
    ),
  );
}
function validatePage(limit: number, cursor?: JobOperationalCursor): void {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 50 ||
    (cursor !== undefined &&
      (!uuid.test(cursor.id) ||
        !(cursor.createdAt instanceof Date) ||
        !Number.isFinite(cursor.createdAt.getTime())))
  )
    throw new TypeError("Invalid Job operational page.");
}
function validateList(input: JobOperationalListInput): void {
  validateUuids(input.actorUserId, input.jobId);
  validatePage(input.limit, input.cursor);
}
function transaction<T>(
  sql: RootSql,
  callback: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return ("savepoint" in sql
    ? sql.savepoint(callback)
    : sql.begin(callback)) as unknown as Promise<T>;
}
