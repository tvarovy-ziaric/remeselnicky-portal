import { createHash, randomUUID } from "node:crypto";

import {
  JOB_REQUEST_DEFAULT_ACTIVE_LIMIT,
  JOB_REQUEST_SUBMISSION_REQUIREMENTS,
  JobRequestLifecycleIdempotencyError,
  assertDuplicateJobRequestInput,
  assertCancelJobRequestInput,
  assertJobRequestLifecycleCommandInput,
  normalizeJobRequestContentSection,
  type CancelJobRequestInput,
  type CustomerProfileId,
  type DraftJsonValue,
  type DuplicateJobRequestInput,
  type DuplicateJobRequestResult,
  type JobRequestContentSection,
  type JobRequestCancellationReason,
  type JobRequestId,
  type JobRequestLifecycleCommandInput,
  type JobRequestLifecycleCommandResult,
  type JobRequestLifecyclePersistence,
  type JobRequestLifecycleListResult,
  type JobRequestLifecycleRecord,
  type JobRequestState,
  type JobRequestSubmissionRequirement,
  type UserId,
} from "@portal/domain";
import type { Sql, TransactionSql } from "postgres";

type OwnerKind = "CANCEL" | "EXTEND" | "REACTIVATE";

interface CommandRow {
  readonly actorUserId: string | null;
  readonly cancellationReason: string | null;
  readonly commandKind: string;
  readonly customerProfileId: string;
  readonly jobRequestId: string;
  readonly payloadFingerprint: string;
  readonly resultingRevision: number;
}

interface CurrentRow {
  readonly activatedAt: Date | null;
  readonly cancellationReason: string | null;
  readonly changedAt: Date;
  readonly createdAt: Date;
  readonly customerProfileId: string;
  readonly expiresAt: Date | null;
  readonly id: string;
  readonly revision: number;
  readonly state: string;
  readonly warningAt: Date | null;
}

export function createJobRequestLifecycleRepository(
  sql: Sql,
): JobRequestLifecyclePersistence {
  return Object.freeze({
    cancelOwned(input: CancelJobRequestInput) {
      assertCancelJobRequestInput(input);
      return executeOwned(sql, "CANCEL", input, input.reason);
    },
    duplicateOwned(input: DuplicateJobRequestInput) {
      assertDuplicateJobRequestInput(input);
      return duplicateOwned(sql, input);
    },
    async expireInactive(): Promise<readonly JobRequestId[]> {
      return sql.begin(async (transaction) => {
        const candidates = await transaction<
          Array<{
            readonly customerProfileId: CustomerProfileId;
            readonly id: JobRequestId;
            readonly revision: number;
          }>
        >`
          SELECT status.job_request_id AS id,
            status.customer_profile_id AS "customerProfileId",
            status.revision
          FROM current_job_request_operational_status status
          JOIN customer_profiles customer
            ON customer.id = status.customer_profile_id
          WHERE status.state::text = 'ACTIVE'
            AND status.expires_at <= clock_timestamp()
          ORDER BY status.expires_at, status.job_request_id
          LIMIT 100 FOR UPDATE OF customer SKIP LOCKED
        `;
        const expired: JobRequestId[] = [];
        for (const candidate of candidates) {
          const commandId = randomUUID();
          const fingerprint = commandFingerprint("EXPIRE", {
            actorUserId: null,
            cancellationReason: null,
            expectedRevision: candidate.revision,
            jobRequestId: candidate.id,
          });
          await insertCommand(transaction, {
            actorUserId: null,
            cancellationReason: null,
            commandId,
            commandKind: "EXPIRE",
            customerProfileId: candidate.customerProfileId,
            expectedRevision: candidate.revision,
            fingerprint,
            jobRequestId: candidate.id,
            systemInitiated: true,
            targetState: "EXPIRED",
          });
          await insertRevision(transaction, {
            commandId,
            jobRequestId: candidate.id,
            revision: candidate.revision + 1,
            state: "EXPIRED",
          });
          expired.push(candidate.id);
        }
        return Object.freeze(expired);
      });
    },
    extendOwned(input: JobRequestLifecycleCommandInput) {
      assertJobRequestLifecycleCommandInput(input);
      return executeOwned(sql, "EXTEND", input, null);
    },
    async listOwned(
      actorUserId: UserId,
    ): Promise<JobRequestLifecycleListResult> {
      return sql.begin(async (transaction) => {
        const customerProfileId = await lockActiveActorCustomer(
          transaction,
          actorUserId,
        );
        if (customerProfileId === null) {
          return Object.freeze({ status: "ACCOUNT_NOT_ACTIVE" as const });
        }
        const rows = await transaction<CurrentRow[]>`
          SELECT status.job_request_id AS id,
            status.customer_profile_id AS "customerProfileId",
            status.state::text AS state, status.revision,
            request.created_at AS "createdAt",
            status.changed_at AS "changedAt",
            status.activated_at AS "activatedAt",
            status.expires_at AS "expiresAt",
            status.warning_at AS "warningAt",
            status.cancellation_reason::text AS "cancellationReason"
          FROM current_job_request_operational_status status
          JOIN job_requests request ON request.id = status.job_request_id
          WHERE status.customer_profile_id = ${customerProfileId}
          ORDER BY status.changed_at DESC, status.job_request_id DESC
          LIMIT 100
        `;
        return Object.freeze({
          requests: Object.freeze(rows.map(toRecord)),
          status: "OK" as const,
        });
      });
    },
    reactivateOwned(input: JobRequestLifecycleCommandInput) {
      assertJobRequestLifecycleCommandInput(input);
      return executeOwned(sql, "REACTIVATE", input, null);
    },
  });
}

async function duplicateOwned(
  sql: Sql,
  input: DuplicateJobRequestInput,
): Promise<DuplicateJobRequestResult> {
  return sql.begin(async (transaction) => {
    const customerProfileId = await lockActiveActorCustomer(
      transaction,
      input.actorUserId,
    );
    if (customerProfileId === null) {
      return Object.freeze({ status: "ACCOUNT_NOT_ACTIVE" as const });
    }
    await lockCommand(transaction, input.commandId);
    const intentFingerprint = duplicateFingerprint(input);
    const replay = await replayDuplicate(transaction, {
      ...input,
      customerProfileId,
      intentFingerprint,
    });
    if (replay !== null) return replay;
    if (
      !(await lockOwnedRequest(
        transaction,
        input.sourceJobRequestId,
        customerProfileId,
      ))
    ) {
      return Object.freeze({ status: "NOT_FOUND" as const });
    }
    const source = await selectCurrent(transaction, input.sourceJobRequestId);
    if (source === null) return Object.freeze({ status: "NOT_FOUND" as const });
    const sections = await selectCopyableSections(
      transaction,
      input.sourceJobRequestId,
      source.state,
    );
    const newJobRequestId = randomUUID() as JobRequestId;
    await transaction`
      INSERT INTO job_requests (id, customer_profile_id)
      VALUES (${newJobRequestId}, ${customerProfileId})
    `;
    if (sections.length === 0) {
      await insertDraftCreation(transaction, {
        actorUserId: input.actorUserId,
        commandId: input.commandId,
        customerProfileId,
        intentFingerprint,
        jobRequestId: newJobRequestId,
        section: null,
      });
      await insertRevision(transaction, {
        commandId: input.commandId,
        jobRequestId: newJobRequestId,
        revision: 1,
        state: "DRAFT",
      });
    } else {
      let revision = 1;
      const [first, ...remaining] = sections;
      if (first === undefined) throw new Error("Duplicate section missing.");
      await insertDraftCreation(transaction, {
        actorUserId: input.actorUserId,
        commandId: input.commandId,
        customerProfileId,
        intentFingerprint,
        jobRequestId: newJobRequestId,
        section: first,
      });
      await insertRevision(transaction, {
        commandId: input.commandId,
        jobRequestId: newJobRequestId,
        revision,
        state: "DRAFT",
      });
      await insertDraftSection(
        transaction,
        input.commandId,
        newJobRequestId,
        revision,
        first,
      );
      for (const section of remaining) {
        const commandId = randomUUID();
        const payloadFingerprint = sha256(section.canonicalPayload);
        const sectionIntent = sha256(
          JSON.stringify({
            duplicateCommandId: input.commandId,
            key: section.key,
            payloadFingerprint,
            schemaVersion: section.schemaVersion,
          }),
        );
        await insertDraftAutosave(transaction, {
          actorUserId: input.actorUserId,
          commandId,
          customerProfileId,
          expectedRevision: revision,
          intentFingerprint: sectionIntent,
          jobRequestId: newJobRequestId,
          payloadFingerprint,
          section,
        });
        revision += 1;
        await insertRevision(transaction, {
          commandId,
          jobRequestId: newJobRequestId,
          revision,
          state: "DRAFT",
        });
        await insertDraftSection(
          transaction,
          commandId,
          newJobRequestId,
          revision,
          section,
        );
      }
    }
    return loadDuplicateResult(transaction, newJobRequestId, "APPLIED");
  });
}

async function executeOwned(
  sql: Sql,
  kind: OwnerKind,
  input: JobRequestLifecycleCommandInput,
  cancellationReason: JobRequestCancellationReason | null,
): Promise<JobRequestLifecycleCommandResult> {
  return sql.begin(async (transaction) => {
    const customerProfileId = await lockActiveActorCustomer(
      transaction,
      input.actorUserId,
    );
    if (customerProfileId === null) {
      return Object.freeze({ status: "ACCOUNT_NOT_ACTIVE" as const });
    }
    await lockCommand(transaction, input.commandId);
    const fingerprint = commandFingerprint(kind, {
      actorUserId: input.actorUserId,
      cancellationReason,
      expectedRevision: input.expectedRevision,
      jobRequestId: input.jobRequestId,
    });
    const replay = await replayCommand(transaction, {
      actorUserId: input.actorUserId,
      cancellationReason,
      commandId: input.commandId,
      commandKind: kind,
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
    if (current === null)
      return Object.freeze({ status: "NOT_FOUND" as const });
    if (current.revision !== input.expectedRevision) {
      return Object.freeze({
        currentRevision: current.revision,
        status: "STALE_REVISION" as const,
      });
    }
    const expectedState = kind === "REACTIVATE" ? "EXPIRED" : "ACTIVE";
    if (current.state !== expectedState) {
      return Object.freeze({ status: "INVALID_TRANSITION" as const });
    }
    let submissionEligibilityRevision: number | null = null;
    if (kind === "REACTIVATE") {
      const readiness = await activeReadiness(transaction, input.jobRequestId);
      if (readiness.missing.length > 0) {
        return Object.freeze({ status: "NOT_READY" as const });
      }
      submissionEligibilityRevision = readiness.contentRevision;
      const policy = await lockActiveLimit(transaction, customerProfileId);
      if (policy.count >= policy.limit) {
        return Object.freeze({
          activeLimit: policy.limit,
          status: "ACTIVE_LIMIT_REACHED" as const,
        });
      }
    }
    if (kind === "EXTEND") {
      const [expiry] = await transaction<{ readonly eligible: boolean }[]>`
        SELECT clock_timestamp() < job_request_effective_expires_at(
          ${input.jobRequestId}
        ) AS eligible
      `;
      if (expiry?.eligible !== true) {
        return Object.freeze({ status: "INVALID_TRANSITION" as const });
      }
    }
    const targetState: JobRequestState =
      kind === "CANCEL" ? "CANCELLED" : "ACTIVE";
    await insertCommand(transaction, {
      actorUserId: input.actorUserId,
      cancellationReason,
      commandId: input.commandId,
      commandKind: kind,
      customerProfileId,
      expectedRevision: input.expectedRevision,
      fingerprint,
      jobRequestId: input.jobRequestId,
      systemInitiated: false,
      submissionEligibilityRevision,
      targetState,
    });
    await insertRevision(transaction, {
      commandId: input.commandId,
      jobRequestId: input.jobRequestId,
      revision: input.expectedRevision + 1,
      state: targetState,
    });
    const applied = await selectRevision(
      transaction,
      input.jobRequestId,
      input.expectedRevision + 1,
    );
    if (applied === null) throw new Error("Lifecycle command effect missing.");
    return Object.freeze({ jobRequest: applied, status: "APPLIED" as const });
  });
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

async function lockCommand(sql: TransactionSql, commandId: string) {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${commandId}, 40006))`;
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

async function activeReadiness(
  sql: TransactionSql,
  jobRequestId: JobRequestId,
): Promise<{
  readonly contentRevision: number;
  readonly missing: readonly JobRequestSubmissionRequirement[];
}> {
  const [row] = await sql<
    { readonly contentRevision: number; readonly missing: string[] }[]
  >`
    SELECT active.content_revision AS "contentRevision",
      job_request_active_missing_submission_requirements(
        ${jobRequestId}, active.content_revision
      )::text[] AS missing
    FROM current_job_request_active_content_versions active
    WHERE active.job_request_id = ${jobRequestId}
  `;
  if (row === undefined) throw new Error("Active readiness query failed.");
  const missing = row.missing.map((value) => {
    const item = JOB_REQUEST_SUBMISSION_REQUIREMENTS.find(
      (candidate) => candidate === value,
    );
    if (item === undefined) throw new Error("Unknown readiness requirement.");
    return item;
  });
  return Object.freeze({
    contentRevision: row.contentRevision,
    missing: Object.freeze(missing),
  });
}

async function replayCommand(
  sql: TransactionSql,
  input: {
    readonly actorUserId: UserId;
    readonly cancellationReason: JobRequestCancellationReason | null;
    readonly commandId: string;
    readonly commandKind: OwnerKind;
    readonly customerProfileId: CustomerProfileId;
    readonly fingerprint: string;
    readonly jobRequestId: JobRequestId;
    readonly submissionEligibilityRevision?: number | null;
  },
): Promise<JobRequestLifecycleCommandResult | null> {
  const [row] = await sql<CommandRow[]>`
    SELECT actor_user_id AS "actorUserId",
      cancellation_reason AS "cancellationReason",
      command_kind::text AS "commandKind",
      customer_profile_id AS "customerProfileId",
      job_request_id AS "jobRequestId",
      payload_fingerprint AS "payloadFingerprint",
      resulting_revision AS "resultingRevision"
    FROM job_request_commands WHERE command_id = ${input.commandId}
  `;
  if (row === undefined) return null;
  if (
    row.actorUserId !== input.actorUserId ||
    row.cancellationReason !== input.cancellationReason ||
    row.commandKind !== input.commandKind ||
    row.customerProfileId !== input.customerProfileId ||
    row.jobRequestId !== input.jobRequestId ||
    row.payloadFingerprint !== input.fingerprint
  ) {
    throw new JobRequestLifecycleIdempotencyError(
      "Job request lifecycle command id was reused for another intent.",
    );
  }
  const historical = await selectRevision(
    sql,
    input.jobRequestId,
    row.resultingRevision,
  );
  if (historical === null) throw new Error("Lifecycle replay effect missing.");
  return Object.freeze({
    jobRequest: historical,
    status: "DEDUPLICATED" as const,
  });
}

async function replayDuplicate(
  sql: TransactionSql,
  input: DuplicateJobRequestInput & {
    readonly customerProfileId: CustomerProfileId;
    readonly intentFingerprint: string;
  },
): Promise<DuplicateJobRequestResult | null> {
  const [row] = await sql<CommandRow[]>`
    SELECT actor_user_id AS "actorUserId",
      cancellation_reason AS "cancellationReason",
      command_kind::text AS "commandKind",
      customer_profile_id AS "customerProfileId",
      job_request_id AS "jobRequestId",
      payload_fingerprint AS "payloadFingerprint",
      resulting_revision AS "resultingRevision"
    FROM job_request_commands WHERE command_id = ${input.commandId}
  `;
  if (row === undefined) return null;
  if (
    row.actorUserId !== input.actorUserId ||
    row.customerProfileId !== input.customerProfileId ||
    !["CREATE_DRAFT", "CREATE_DRAFT_WITH_SECTION"].includes(row.commandKind) ||
    row.payloadFingerprint !== input.intentFingerprint
  ) {
    throw new JobRequestLifecycleIdempotencyError(
      "Job request duplicate command id was reused for another intent.",
    );
  }
  return loadDuplicateResult(
    sql,
    row.jobRequestId as JobRequestId,
    "DEDUPLICATED",
  );
}

async function selectCopyableSections(
  sql: TransactionSql,
  jobRequestId: JobRequestId,
  state: string,
): Promise<readonly JobRequestContentSection[]> {
  const rows =
    state === "DRAFT"
      ? await sql<
          Array<{
            readonly payload: unknown;
            readonly sectionKey: string;
            readonly sectionSchemaVersion: number;
          }>
        >`
          SELECT payload, section_key AS "sectionKey",
            section_schema_version AS "sectionSchemaVersion"
          FROM current_job_request_draft_sections
          WHERE job_request_id = ${jobRequestId}
          ORDER BY section_key
        `
      : await sql<
          Array<{
            readonly payload: unknown;
            readonly sectionKey: string;
            readonly sectionSchemaVersion: number;
          }>
        >`
          SELECT payload, section_key AS "sectionKey",
            section_schema_version AS "sectionSchemaVersion"
          FROM current_job_request_active_sections
          WHERE job_request_id = ${jobRequestId}
          ORDER BY section_key
        `;
  return Object.freeze(
    rows.map((row) => {
      const payload =
        row.sectionKey === "request.media"
          ? { documentMediaAssetIds: [], photoMediaAssetIds: [] }
          : row.payload;
      return normalizeJobRequestContentSection({
        key: row.sectionKey,
        payload,
        schemaVersion: row.sectionSchemaVersion,
      });
    }),
  );
}

async function insertDraftCreation(
  sql: TransactionSql,
  input: {
    readonly actorUserId: UserId;
    readonly commandId: string;
    readonly customerProfileId: CustomerProfileId;
    readonly intentFingerprint: string;
    readonly jobRequestId: JobRequestId;
    readonly section: JobRequestContentSection | null;
  },
): Promise<void> {
  const payloadFingerprint =
    input.section === null ? null : sha256(input.section.canonicalPayload);
  await sql`
    INSERT INTO job_request_commands (
      command_id, job_request_id, customer_profile_id, actor_user_id,
      command_kind, result_kind, expected_revision, resulting_revision,
      target_state, submission_eligibility_revision, draft_section_key,
      draft_section_schema_version, draft_payload_fingerprint,
      payload_fingerprint
    ) VALUES (
      ${input.commandId}, ${input.jobRequestId}, ${input.customerProfileId},
      ${input.actorUserId},
      ${input.section === null ? "CREATE_DRAFT" : "CREATE_DRAFT_WITH_SECTION"},
      'APPLIED', 0, 1, 'DRAFT', NULL,
      ${input.section?.key ?? null}, ${input.section?.schemaVersion ?? null},
      ${payloadFingerprint}, ${input.intentFingerprint}
    )
  `;
}

async function insertDraftAutosave(
  sql: TransactionSql,
  input: {
    readonly actorUserId: UserId;
    readonly commandId: string;
    readonly customerProfileId: CustomerProfileId;
    readonly expectedRevision: number;
    readonly intentFingerprint: string;
    readonly jobRequestId: JobRequestId;
    readonly payloadFingerprint: string;
    readonly section: JobRequestContentSection;
  },
): Promise<void> {
  await sql`
    INSERT INTO job_request_commands (
      command_id, job_request_id, customer_profile_id, actor_user_id,
      command_kind, result_kind, expected_revision, resulting_revision,
      target_state, submission_eligibility_revision, draft_section_key,
      draft_section_schema_version, draft_payload_fingerprint,
      payload_fingerprint
    ) VALUES (
      ${input.commandId}, ${input.jobRequestId}, ${input.customerProfileId},
      ${input.actorUserId}, 'AUTOSAVE', 'APPLIED', ${input.expectedRevision},
      ${input.expectedRevision + 1}, 'DRAFT', NULL, ${input.section.key},
      ${input.section.schemaVersion}, ${input.payloadFingerprint},
      ${input.intentFingerprint}
    )
  `;
}

async function insertDraftSection(
  sql: TransactionSql,
  commandId: string,
  jobRequestId: JobRequestId,
  revision: number,
  section: JobRequestContentSection,
): Promise<void> {
  await sql`
    INSERT INTO job_request_draft_section_revisions (
      command_id, job_request_id, request_revision, section_key,
      section_schema_version, payload, payload_fingerprint, saved_at
    ) VALUES (
      ${commandId}, ${jobRequestId}, ${revision}, ${section.key},
      ${section.schemaVersion},
      ${sql.json(
        section.payload as unknown as Readonly<Record<string, DraftJsonValue>>,
      )},
      ${sha256(section.canonicalPayload)}, clock_timestamp()
    )
  `;
}

async function loadDuplicateResult(
  sql: TransactionSql,
  jobRequestId: JobRequestId,
  status: "APPLIED" | "DEDUPLICATED",
): Promise<DuplicateJobRequestResult> {
  const [current] = await sql<{ readonly revision: number }[]>`
    SELECT revision FROM current_job_requests
    WHERE id = ${jobRequestId} AND state::text = 'DRAFT'
  `;
  if (current === undefined || !Number.isSafeInteger(current.revision)) {
    throw new Error("Duplicated job request draft missing.");
  }
  const sections = await selectCopyableSections(sql, jobRequestId, "DRAFT");
  return Object.freeze({
    jobRequestId,
    revision: current.revision,
    sections,
    status,
  });
}

async function insertCommand(
  sql: TransactionSql,
  input: {
    readonly actorUserId: UserId | null;
    readonly cancellationReason: JobRequestCancellationReason | null;
    readonly commandId: string;
    readonly commandKind: OwnerKind | "EXPIRE";
    readonly customerProfileId: CustomerProfileId;
    readonly expectedRevision: number;
    readonly fingerprint: string;
    readonly jobRequestId: JobRequestId;
    readonly systemInitiated: boolean;
    readonly submissionEligibilityRevision?: number | null;
    readonly targetState: JobRequestState;
  },
) {
  await sql`
    INSERT INTO job_request_commands (
      command_id, job_request_id, customer_profile_id, actor_user_id,
      command_kind, result_kind, expected_revision, resulting_revision,
      target_state, submission_eligibility_revision, payload_fingerprint,
      system_initiated, cancellation_reason
    ) VALUES (
      ${input.commandId}, ${input.jobRequestId}, ${input.customerProfileId},
      ${input.actorUserId}, ${input.commandKind}, 'APPLIED',
      ${input.expectedRevision}, ${input.expectedRevision + 1},
      ${input.targetState},
      ${input.submissionEligibilityRevision ?? null},
      ${input.fingerprint}, ${input.systemInitiated},
      ${input.cancellationReason}
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
) {
  await sql`
    INSERT INTO job_request_revisions (
      job_request_id, revision, command_id, state, changed_at, activated_at,
      expires_at, cancellation_reason
    ) VALUES (
      ${input.jobRequestId}, ${input.revision}, ${input.commandId},
      ${input.state}, clock_timestamp(), NULL, NULL, NULL
    )
  `;
}

async function selectCurrent(sql: TransactionSql, jobRequestId: JobRequestId) {
  const [row] = await sql<CurrentRow[]>`
    SELECT current.id, current.customer_profile_id AS "customerProfileId",
      current.state::text AS state, current.revision,
      current.created_at AS "createdAt", current.changed_at AS "changedAt",
      current.activated_at AS "activatedAt",
      current.expires_at AS "expiresAt",
      current.cancellation_reason AS "cancellationReason"
    FROM current_job_requests current WHERE current.id = ${jobRequestId}
  `;
  return row ?? null;
}

async function selectRevision(
  sql: TransactionSql,
  jobRequestId: JobRequestId,
  revision: number,
): Promise<JobRequestLifecycleRecord | null> {
  const [row] = await sql<CurrentRow[]>`
    SELECT request.id, request.customer_profile_id AS "customerProfileId",
      stored.state::text AS state, stored.revision,
      request.created_at AS "createdAt", stored.changed_at AS "changedAt",
      stored.activated_at AS "activatedAt", stored.expires_at AS "expiresAt",
      stored.cancellation_reason AS "cancellationReason",
      CASE WHEN stored.state::text = 'ACTIVE'
        THEN stored.expires_at - make_interval(days => policy.warning_lead_days)
        ELSE NULL END AS "warningAt"
    FROM job_requests request
    JOIN job_request_revisions stored ON stored.job_request_id = request.id
    CROSS JOIN job_request_runtime_policy policy
    WHERE request.id = ${jobRequestId} AND stored.revision = ${revision}
  `;
  return row === undefined ? null : toRecord(row);
}

function toRecord(row: CurrentRow): JobRequestLifecycleRecord {
  if (
    !["ACTIVE", "CANCELLED", "DRAFT", "EXPIRED"].includes(row.state) ||
    !(row.createdAt instanceof Date) ||
    !(row.changedAt instanceof Date) ||
    (row.activatedAt !== null && !(row.activatedAt instanceof Date)) ||
    (row.expiresAt !== null && !(row.expiresAt instanceof Date)) ||
    (row.warningAt !== null && !(row.warningAt instanceof Date)) ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1
  ) {
    throw new Error("Corrupt job request lifecycle row.");
  }
  return Object.freeze({
    activatedAt: row.activatedAt,
    cancellationReason:
      row.cancellationReason as JobRequestCancellationReason | null,
    changedAt: row.changedAt,
    createdAt: row.createdAt,
    customerProfileId: row.customerProfileId as CustomerProfileId,
    expiresAt: row.expiresAt,
    id: row.id as JobRequestId,
    revision: row.revision,
    state: row.state as JobRequestState,
    warningAt: row.warningAt,
  });
}

function commandFingerprint(
  kind: OwnerKind | "EXPIRE",
  input: {
    readonly actorUserId: UserId | null;
    readonly cancellationReason: JobRequestCancellationReason | null;
    readonly expectedRevision: number;
    readonly jobRequestId: JobRequestId;
  },
) {
  return createHash("sha256")
    .update(JSON.stringify({ kind, ...input }), "utf8")
    .digest("hex");
}

function duplicateFingerprint(input: DuplicateJobRequestInput): string {
  return sha256(
    JSON.stringify({
      actorUserId: input.actorUserId,
      kind: "DUPLICATE",
      sourceJobRequestId: input.sourceJobRequestId,
    }),
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export const JOB_REQUEST_RUNTIME_POLICY_DEFAULT = Object.freeze({
  activeLimit: JOB_REQUEST_DEFAULT_ACTIVE_LIMIT,
});
