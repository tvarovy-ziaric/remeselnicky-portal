import { createHash, randomUUID } from "node:crypto";

import {
  JOB_REQUEST_DRAFT_MAX_CURRENT_SECTIONS,
  JOB_REQUEST_DRAFT_RECENT_LIMIT,
  JobRequestDraftIdempotencyError,
  normalizeJobRequestDraftSection,
  type CustomerProfileId,
  type DraftJsonValue,
  type JobRequestDraftAutosaveResult,
  type JobRequestDraftListResult,
  type JobRequestDraftPersistence,
  type JobRequestDraftRecoveryResult,
  type JobRequestDraftSection,
  type JobRequestDraftSummary,
  type JobRequestId,
  type PersistAutosaveJobRequestDraftInput,
  type PersistCreateDraftWithInitialSectionInput,
  type UserId,
} from "@portal/domain";
import type { Sql, TransactionSql } from "postgres";

interface ActiveCustomerRow {
  readonly customerProfileId: string;
}

interface CommandRow {
  readonly actorUserId: string;
  readonly commandKind: "AUTOSAVE" | "CREATE_DRAFT_WITH_SECTION";
  readonly createdAt: Date;
  readonly customerProfileId: string;
  readonly draftPayloadFingerprint: string;
  readonly draftSectionKey: string;
  readonly draftSectionSchemaVersion: number;
  readonly jobRequestId: string;
  readonly payloadFingerprint: string;
  readonly resultKind: "APPLIED" | "UNCHANGED";
  readonly resultingRevision: number;
}

interface CurrentDraftRow {
  readonly changedAt: Date;
  readonly createdAt: Date;
  readonly revision: number;
  readonly state: "ACTIVE" | "DRAFT";
}

interface SectionRow {
  readonly payload: unknown;
  readonly payloadFingerprint: string;
  readonly requestRevision: number;
  readonly savedAt: Date;
  readonly sectionKey: string;
  readonly sectionSchemaVersion: number;
}

export function createJobRequestDraftRepository(
  sql: Sql,
): JobRequestDraftPersistence {
  return Object.freeze({
    async autosaveOwned(
      input: PersistAutosaveJobRequestDraftInput,
    ): Promise<JobRequestDraftAutosaveResult> {
      const section = validatePersistedSection(input.section);
      assertUuid(input.actorUserId, "actorUserId");
      assertUuid(input.commandId, "commandId");
      assertUuid(input.jobRequestId, "jobRequestId");
      if (
        !Number.isSafeInteger(input.expectedRevision) ||
        input.expectedRevision < 1
      ) {
        throw new TypeError("Invalid expectedRevision.");
      }
      return sql.begin(async (transaction) => {
        const customerProfileId = await lockActiveActorCustomer(
          transaction,
          input.actorUserId,
        );
        if (customerProfileId === null) return accountNotActive();
        await lockCommand(transaction, input.commandId);
        const payloadFingerprint = sha256(section.canonicalPayload);
        const intentFingerprint = autosaveIntentFingerprint(
          input,
          payloadFingerprint,
        );
        const replayResult = await replay(transaction, {
          actorUserId: input.actorUserId,
          commandId: input.commandId,
          commandKind: "AUTOSAVE",
          customerProfileId,
          draftPayloadFingerprint: payloadFingerprint,
          draftSectionKey: section.key,
          draftSectionSchemaVersion: section.schemaVersion,
          intentFingerprint,
          jobRequestId: input.jobRequestId,
        });
        if (replayResult !== null) return replayResult;

        const current = await lockOwnedCurrentDraft(
          transaction,
          input.jobRequestId,
          customerProfileId,
        );
        if (current === null) return notFound();
        if (current.revision !== input.expectedRevision) {
          return Object.freeze({
            currentRevision: current.revision,
            status: "STALE_REVISION" as const,
          });
        }
        if (current.state !== "DRAFT") {
          return Object.freeze({ status: "INVALID_STATE" as const });
        }

        const existing = await selectCurrentSection(
          transaction,
          input.jobRequestId,
          section.key,
        );
        const unchanged =
          existing !== null &&
          existing.sectionSchemaVersion === section.schemaVersion &&
          existing.payloadFingerprint === payloadFingerprint;
        if (!unchanged && existing === null) {
          const sectionCount = await countCurrentSections(
            transaction,
            input.jobRequestId,
          );
          if (sectionCount >= JOB_REQUEST_DRAFT_MAX_CURRENT_SECTIONS) {
            return Object.freeze({ status: "SECTION_LIMIT_REACHED" as const });
          }
        }

        const resultKind = unchanged ? "UNCHANGED" : "APPLIED";
        const resultingRevision = unchanged
          ? input.expectedRevision
          : input.expectedRevision + 1;
        const createdAt = await insertCommand(transaction, {
          actorUserId: input.actorUserId,
          commandId: input.commandId,
          commandKind: "AUTOSAVE",
          customerProfileId,
          draftPayloadFingerprint: payloadFingerprint,
          draftSectionKey: section.key,
          draftSectionSchemaVersion: section.schemaVersion,
          expectedRevision: input.expectedRevision,
          intentFingerprint,
          jobRequestId: input.jobRequestId,
          resultKind,
          resultingRevision,
        });
        if (!unchanged) {
          await insertDraftRevision(transaction, {
            commandId: input.commandId,
            jobRequestId: input.jobRequestId,
            revision: resultingRevision,
          });
          await insertSectionEffect(transaction, {
            commandId: input.commandId,
            jobRequestId: input.jobRequestId,
            payload: section.payload,
            payloadFingerprint,
            requestRevision: resultingRevision,
            sectionKey: section.key,
            sectionSchemaVersion: section.schemaVersion,
          });
        }
        return Object.freeze({
          jobRequestId: input.jobRequestId,
          revision: resultingRevision,
          savedAt: createdAt,
          status: resultKind,
        });
      });
    },

    async createDraftWithInitialSectionOwned(
      input: PersistCreateDraftWithInitialSectionInput,
    ): Promise<JobRequestDraftAutosaveResult> {
      const section = validatePersistedSection(input.section);
      assertUuid(input.actorUserId, "actorUserId");
      assertUuid(input.commandId, "commandId");
      assertUuid(input.customerProfileId, "customerProfileId");
      return sql.begin(async (transaction) => {
        if (
          !(await lockActiveCustomer(
            transaction,
            input.actorUserId,
            input.customerProfileId,
          ))
        ) {
          return accountNotActive();
        }
        await lockCommand(transaction, input.commandId);
        const payloadFingerprint = sha256(section.canonicalPayload);
        const intentFingerprint = createIntentFingerprint(
          input,
          payloadFingerprint,
        );
        const replayResult = await replay(transaction, {
          actorUserId: input.actorUserId,
          commandId: input.commandId,
          commandKind: "CREATE_DRAFT_WITH_SECTION",
          customerProfileId: input.customerProfileId,
          draftPayloadFingerprint: payloadFingerprint,
          draftSectionKey: section.key,
          draftSectionSchemaVersion: section.schemaVersion,
          intentFingerprint,
          jobRequestId: null,
        });
        if (replayResult !== null) return replayResult;

        const jobRequestId = randomUUID() as JobRequestId;
        await transaction`
          INSERT INTO job_requests (id, customer_profile_id)
          VALUES (${jobRequestId}, ${input.customerProfileId})
        `;
        const savedAt = await insertCommand(transaction, {
          actorUserId: input.actorUserId,
          commandId: input.commandId,
          commandKind: "CREATE_DRAFT_WITH_SECTION",
          customerProfileId: input.customerProfileId,
          draftPayloadFingerprint: payloadFingerprint,
          draftSectionKey: section.key,
          draftSectionSchemaVersion: section.schemaVersion,
          expectedRevision: 0,
          intentFingerprint,
          jobRequestId,
          resultKind: "APPLIED",
          resultingRevision: 1,
        });
        await insertDraftRevision(transaction, {
          commandId: input.commandId,
          jobRequestId,
          revision: 1,
        });
        await insertSectionEffect(transaction, {
          commandId: input.commandId,
          jobRequestId,
          payload: section.payload,
          payloadFingerprint,
          requestRevision: 1,
          sectionKey: section.key,
          sectionSchemaVersion: section.schemaVersion,
        });
        return Object.freeze({
          jobRequestId,
          revision: 1,
          savedAt,
          status: "APPLIED" as const,
        });
      });
    },

    async listRecentOwned(
      actorUserId: UserId,
    ): Promise<JobRequestDraftListResult> {
      assertUuid(actorUserId, "actorUserId");
      return sql.begin(async (transaction) => {
        if (!(await lockActiveActor(transaction, actorUserId))) {
          return accountNotActive();
        }
        const rows = await transaction<
          Array<{
            readonly changedAt: Date;
            readonly createdAt: Date;
            readonly id: string;
            readonly revision: number;
            readonly sectionCount: number;
          }>
        >`
          SELECT current.id, current.revision,
            current.created_at AS "createdAt",
            current.changed_at AS "changedAt",
            count(section.section_key)::integer AS "sectionCount"
          FROM current_job_requests current
          JOIN customer_profiles customer
            ON customer.id = current.customer_profile_id
          LEFT JOIN current_job_request_draft_sections section
            ON section.job_request_id = current.id
          WHERE customer.owner_user_id = ${actorUserId}
            AND current.state = 'DRAFT'
          GROUP BY current.id, current.revision, current.created_at,
            current.changed_at
          ORDER BY current.changed_at DESC, current.id
          LIMIT ${JOB_REQUEST_DRAFT_RECENT_LIMIT}
        `;
        return Object.freeze({
          drafts: Object.freeze(rows.map(toSummary)),
          status: "OK" as const,
        });
      });
    },

    async recoverOwned(input: {
      readonly actorUserId: UserId;
      readonly jobRequestId: JobRequestId;
    }): Promise<JobRequestDraftRecoveryResult> {
      assertUuid(input.actorUserId, "actorUserId");
      assertUuid(input.jobRequestId, "jobRequestId");
      return sql.begin(async (transaction) => {
        const customerProfileId = await lockActiveActorCustomer(
          transaction,
          input.actorUserId,
        );
        if (customerProfileId === null) return accountNotActive();
        const current = await lockOwnedCurrentDraft(
          transaction,
          input.jobRequestId,
          customerProfileId,
        );
        if (current === null || current.state !== "DRAFT") return notFound();
        const rows = await transaction<SectionRow[]>`
          SELECT section.request_revision AS "requestRevision",
            section.section_key AS "sectionKey",
            section.section_schema_version AS "sectionSchemaVersion",
            section.payload, section.payload_fingerprint AS "payloadFingerprint",
            section.saved_at AS "savedAt"
          FROM current_job_request_draft_sections section
          WHERE section.job_request_id = ${input.jobRequestId}
          ORDER BY section.section_key
          LIMIT ${JOB_REQUEST_DRAFT_MAX_CURRENT_SECTIONS + 1}
        `;
        if (rows.length > JOB_REQUEST_DRAFT_MAX_CURRENT_SECTIONS) {
          throw new Error("Corrupt job request draft section count.");
        }
        return Object.freeze({
          draft: Object.freeze({
            changedAt: assertDate(current.changedAt, "changedAt"),
            createdAt: assertDate(current.createdAt, "createdAt"),
            id: input.jobRequestId,
            revision: assertPositiveInteger(current.revision, "revision"),
            sections: Object.freeze(rows.map(toSection)),
          }),
          status: "OK" as const,
        });
      });
    },
  });
}

async function lockCommand(
  sql: TransactionSql,
  commandId: string,
): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${commandId}, 37002))`;
}

async function lockActiveActor(
  sql: TransactionSql,
  actorUserId: UserId,
): Promise<boolean> {
  const rows = await sql`
    SELECT id FROM users
    WHERE id = ${actorUserId} AND account_state = 'ACTIVE'
    FOR UPDATE
  `;
  return rows.length === 1;
}

async function lockActiveActorCustomer(
  sql: TransactionSql,
  actorUserId: UserId,
): Promise<CustomerProfileId | null> {
  const [row] = await sql<ActiveCustomerRow[]>`
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

async function lockOwnedCurrentDraft(
  sql: TransactionSql,
  jobRequestId: JobRequestId,
  customerProfileId: CustomerProfileId,
): Promise<CurrentDraftRow | null> {
  const locked = await sql`
    SELECT id FROM job_requests
    WHERE id = ${jobRequestId} AND customer_profile_id = ${customerProfileId}
    FOR UPDATE
  `;
  if (locked.length !== 1) return null;
  const [row] = await sql<CurrentDraftRow[]>`
    SELECT current.created_at AS "createdAt",
      current.changed_at AS "changedAt", current.revision, current.state
    FROM current_job_requests current
    WHERE current.id = ${jobRequestId}
  `;
  return row ?? null;
}

async function replay(
  sql: TransactionSql,
  input: {
    readonly actorUserId: UserId;
    readonly commandId: string;
    readonly commandKind: CommandRow["commandKind"];
    readonly customerProfileId: CustomerProfileId;
    readonly draftPayloadFingerprint: string;
    readonly draftSectionKey: string;
    readonly draftSectionSchemaVersion: number;
    readonly intentFingerprint: string;
    readonly jobRequestId: JobRequestId | null;
  },
): Promise<JobRequestDraftAutosaveResult | null> {
  const [row] = await sql<CommandRow[]>`
    SELECT actor_user_id AS "actorUserId", command_kind AS "commandKind",
      created_at AS "createdAt", customer_profile_id AS "customerProfileId",
      draft_payload_fingerprint AS "draftPayloadFingerprint",
      draft_section_key AS "draftSectionKey",
      draft_section_schema_version AS "draftSectionSchemaVersion",
      job_request_id AS "jobRequestId", payload_fingerprint AS "payloadFingerprint",
      result_kind AS "resultKind", resulting_revision AS "resultingRevision"
    FROM job_request_commands WHERE command_id = ${input.commandId}
  `;
  if (row === undefined) return null;
  if (
    row.actorUserId !== input.actorUserId ||
    row.commandKind !== input.commandKind ||
    row.customerProfileId !== input.customerProfileId ||
    (input.jobRequestId !== null && row.jobRequestId !== input.jobRequestId) ||
    row.draftPayloadFingerprint !== input.draftPayloadFingerprint ||
    row.draftSectionKey !== input.draftSectionKey ||
    row.draftSectionSchemaVersion !== input.draftSectionSchemaVersion ||
    row.payloadFingerprint !== input.intentFingerprint
  ) {
    throw new JobRequestDraftIdempotencyError(
      "Job request draft command id was reused for another intent.",
    );
  }
  return Object.freeze({
    jobRequestId: row.jobRequestId as JobRequestId,
    originalStatus: row.resultKind,
    revision: assertPositiveInteger(row.resultingRevision, "resultingRevision"),
    savedAt: assertDate(row.createdAt, "createdAt"),
    status: "DEDUPLICATED" as const,
  });
}

async function selectCurrentSection(
  sql: TransactionSql,
  jobRequestId: JobRequestId,
  sectionKey: string,
): Promise<SectionRow | null> {
  const [row] = await sql<SectionRow[]>`
    SELECT request_revision AS "requestRevision", section_key AS "sectionKey",
      section_schema_version AS "sectionSchemaVersion", payload,
      payload_fingerprint AS "payloadFingerprint", saved_at AS "savedAt"
    FROM current_job_request_draft_sections
    WHERE job_request_id = ${jobRequestId} AND section_key = ${sectionKey}
  `;
  return row ?? null;
}

async function countCurrentSections(
  sql: TransactionSql,
  jobRequestId: JobRequestId,
): Promise<number> {
  const [row] = await sql<{ readonly count: number }[]>`
    SELECT count(*)::integer AS count
    FROM current_job_request_draft_sections
    WHERE job_request_id = ${jobRequestId}
  `;
  if (row === undefined) throw new Error("Draft section count query failed.");
  return assertNonnegativeInteger(row.count, "sectionCount");
}

async function insertCommand(
  sql: TransactionSql,
  input: {
    readonly actorUserId: UserId;
    readonly commandId: string;
    readonly commandKind: CommandRow["commandKind"];
    readonly customerProfileId: CustomerProfileId;
    readonly draftPayloadFingerprint: string;
    readonly draftSectionKey: string;
    readonly draftSectionSchemaVersion: number;
    readonly expectedRevision: number;
    readonly intentFingerprint: string;
    readonly jobRequestId: JobRequestId;
    readonly resultKind: "APPLIED" | "UNCHANGED";
    readonly resultingRevision: number;
  },
): Promise<Date> {
  const [row] = await sql<{ readonly createdAt: Date }[]>`
    INSERT INTO job_request_commands (
      command_id, job_request_id, customer_profile_id, actor_user_id,
      command_kind, result_kind, expected_revision, resulting_revision,
      target_state, submission_eligibility_revision, draft_section_key,
      draft_section_schema_version, draft_payload_fingerprint,
      payload_fingerprint
    ) VALUES (
      ${input.commandId}, ${input.jobRequestId}, ${input.customerProfileId},
      ${input.actorUserId}, ${input.commandKind}, ${input.resultKind},
      ${input.expectedRevision}, ${input.resultingRevision}, 'DRAFT', NULL,
      ${input.draftSectionKey}, ${input.draftSectionSchemaVersion},
      ${input.draftPayloadFingerprint}, ${input.intentFingerprint}
    ) RETURNING created_at AS "createdAt"
  `;
  if (row === undefined) throw new Error("Draft command insert failed.");
  return assertDate(row.createdAt, "createdAt");
}

async function insertDraftRevision(
  sql: TransactionSql,
  input: {
    readonly commandId: string;
    readonly jobRequestId: JobRequestId;
    readonly revision: number;
  },
): Promise<void> {
  await sql`
    INSERT INTO job_request_revisions (
      job_request_id, revision, command_id, state, changed_at, activated_at
    ) VALUES (${input.jobRequestId}, ${input.revision}, ${input.commandId},
      'DRAFT', clock_timestamp(), NULL)
  `;
}

async function insertSectionEffect(
  sql: TransactionSql,
  input: {
    readonly commandId: string;
    readonly jobRequestId: JobRequestId;
    readonly payload: Readonly<Record<string, DraftJsonValue>>;
    readonly payloadFingerprint: string;
    readonly requestRevision: number;
    readonly sectionKey: string;
    readonly sectionSchemaVersion: number;
  },
): Promise<void> {
  await sql`
    INSERT INTO job_request_draft_section_revisions (
      command_id, job_request_id, request_revision, section_key,
      section_schema_version, payload, payload_fingerprint, saved_at
    ) VALUES (
      ${input.commandId}, ${input.jobRequestId}, ${input.requestRevision},
      ${input.sectionKey}, ${input.sectionSchemaVersion},
      ${sql.json(input.payload)}, ${input.payloadFingerprint}, clock_timestamp()
    )
  `;
}

function toSection(row: SectionRow): JobRequestDraftSection {
  const normalized = normalizeJobRequestDraftSection({
    key: row.sectionKey,
    payload: row.payload,
    schemaVersion: row.sectionSchemaVersion,
  });
  if (sha256(normalized.canonicalPayload) !== row.payloadFingerprint) {
    throw new Error("Corrupt job request draft payload fingerprint.");
  }
  return Object.freeze({
    key: normalized.key,
    payload: normalized.payload,
    savedAt: assertDate(row.savedAt, "savedAt"),
    schemaVersion: normalized.schemaVersion,
  });
}

function toSummary(row: {
  readonly changedAt: Date;
  readonly createdAt: Date;
  readonly id: string;
  readonly revision: number;
  readonly sectionCount: number;
}): JobRequestDraftSummary {
  assertUuid(row.id, "id");
  return Object.freeze({
    changedAt: assertDate(row.changedAt, "changedAt"),
    createdAt: assertDate(row.createdAt, "createdAt"),
    id: row.id as JobRequestId,
    revision: assertPositiveInteger(row.revision, "revision"),
    sectionCount: assertNonnegativeInteger(row.sectionCount, "sectionCount"),
  });
}

function validatePersistedSection(
  section: PersistAutosaveJobRequestDraftInput["section"],
): PersistAutosaveJobRequestDraftInput["section"] {
  const normalized = normalizeJobRequestDraftSection(section);
  if (normalized.canonicalPayload !== section.canonicalPayload) {
    throw new TypeError("Draft canonical payload mismatch.");
  }
  return normalized;
}

function autosaveIntentFingerprint(
  input: PersistAutosaveJobRequestDraftInput,
  payloadFingerprint: string,
): string {
  return fingerprint([
    "AUTOSAVE",
    input.actorUserId,
    input.jobRequestId,
    String(input.expectedRevision),
    input.section.key,
    String(input.section.schemaVersion),
    payloadFingerprint,
  ]);
}

function createIntentFingerprint(
  input: PersistCreateDraftWithInitialSectionInput,
  payloadFingerprint: string,
): string {
  return fingerprint([
    "CREATE_DRAFT_WITH_SECTION",
    input.actorUserId,
    input.customerProfileId,
    input.section.key,
    String(input.section.schemaVersion),
    payloadFingerprint,
  ]);
}

function fingerprint(parts: readonly string[]): string {
  return sha256(parts.map((part) => `${part.length}:${part}`).join("|"));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertUuid(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    throw new TypeError(`Invalid ${field}.`);
  }
}

function assertDate(value: unknown, field: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`Invalid ${field} from database.`);
  }
  return new Date(value.getTime());
}

function assertPositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`Invalid ${field} from database.`);
  }
  return Number(value);
}

function assertNonnegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`Invalid ${field} from database.`);
  }
  return Number(value);
}

function accountNotActive(): Readonly<{ status: "ACCOUNT_NOT_ACTIVE" }> {
  return Object.freeze({ status: "ACCOUNT_NOT_ACTIVE" });
}

function notFound(): Readonly<{ status: "NOT_FOUND" }> {
  return Object.freeze({ status: "NOT_FOUND" });
}
