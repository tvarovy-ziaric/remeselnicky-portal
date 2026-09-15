import { createHash } from "node:crypto";

import {
  JOB_REQUEST_MATERIAL_CHANGE_CATEGORIES,
  JobRequestVersionIdempotencyError,
  classifyJobRequestChange,
  normalizeJobRequestContentSection,
  type CustomerProfileId,
  type JobRequestActiveContentSnapshot,
  type JobRequestActiveContentVersion,
  type JobRequestContentSection,
  type JobRequestContentSectionKey,
  type JobRequestId,
  type JobRequestMaterialChangeCategory,
  type JobRequestVersionPersistence,
  type PersistReviseActiveJobRequestInput,
  type ReviseActiveJobRequestResult,
  type UserId,
} from "@portal/domain";
import type { Sql, TransactionSql } from "postgres";

interface CommandRow {
  readonly actorUserId: string;
  readonly customerProfileId: string;
  readonly intentFingerprint: string;
  readonly jobRequestId: string;
  readonly resultKind: "APPLIED" | "UNCHANGED";
  readonly resultingContentRevision: number;
  readonly sectionKey: string;
  readonly sectionPayloadFingerprint: string;
  readonly sectionSchemaVersion: number;
}

interface VersionRow {
  readonly categories: string[];
  readonly changedAt: Date;
  readonly contentRevision: number;
  readonly jobRequestId: string;
  readonly material: boolean;
  readonly visibleVersion: number;
}

interface SectionRow {
  readonly payload: unknown;
  readonly payloadFingerprint: string;
  readonly sectionKey: string;
  readonly sectionSchemaVersion: number;
}

export function createJobRequestVersionRepository(
  sql: Sql,
): JobRequestVersionPersistence {
  return Object.freeze({
    async readActiveOwned(input: {
      readonly actorUserId: UserId;
      readonly contentRevision?: number;
      readonly jobRequestId: JobRequestId;
    }) {
      assertUuid(input.actorUserId, "actorUserId");
      assertUuid(input.jobRequestId, "jobRequestId");
      if (
        input.contentRevision !== undefined &&
        (!Number.isSafeInteger(input.contentRevision) ||
          input.contentRevision < 1)
      ) {
        throw new TypeError("Invalid contentRevision.");
      }
      return sql.begin(async (transaction) => {
        const customerProfileId = await lockActiveActorCustomer(
          transaction,
          input.actorUserId,
        );
        if (customerProfileId === null) {
          return Object.freeze({ status: "ACCOUNT_NOT_ACTIVE" as const });
        }
        if (
          !(await lockOwnedActiveRequest(
            transaction,
            input.jobRequestId,
            customerProfileId,
          ))
        ) {
          return Object.freeze({ status: "NOT_FOUND" as const });
        }
        const snapshot = await selectSnapshot(
          transaction,
          input.jobRequestId,
          input.contentRevision,
        );
        return snapshot === null
          ? Object.freeze({ status: "NOT_FOUND" as const })
          : Object.freeze({ snapshot, status: "OK" as const });
      });
    },

    async reviseActiveOwned(
      input: PersistReviseActiveJobRequestInput,
    ): Promise<ReviseActiveJobRequestResult> {
      const section = validateSection(input.section);
      assertUuid(input.actorUserId, "actorUserId");
      assertUuid(input.commandId, "commandId");
      assertUuid(input.jobRequestId, "jobRequestId");
      if (
        !Number.isSafeInteger(input.expectedContentRevision) ||
        input.expectedContentRevision < 1
      ) {
        throw new TypeError("Invalid expectedContentRevision.");
      }
      return sql.begin(async (transaction) => {
        const customerProfileId = await lockActiveActorCustomer(
          transaction,
          input.actorUserId,
        );
        if (customerProfileId === null) {
          return Object.freeze({ status: "ACCOUNT_NOT_ACTIVE" as const });
        }
        await lockCommand(transaction, input.commandId);
        const sectionFingerprint = sha256(section.canonicalPayload);
        const intentFingerprint = fingerprint([
          "REVISE_ACTIVE",
          input.actorUserId,
          input.jobRequestId,
          String(input.expectedContentRevision),
          section.key,
          String(section.schemaVersion),
          sectionFingerprint,
        ]);
        const replay = await replayCommand(transaction, {
          actorUserId: input.actorUserId,
          commandId: input.commandId,
          customerProfileId,
          intentFingerprint,
          jobRequestId: input.jobRequestId,
          section,
          sectionFingerprint,
        });
        if (replay !== null) return replay;
        if (
          !(await lockOwnedActiveRequest(
            transaction,
            input.jobRequestId,
            customerProfileId,
          ))
        ) {
          return Object.freeze({ status: "NOT_FOUND" as const });
        }
        const current = await selectVersionForUpdate(
          transaction,
          input.jobRequestId,
        );
        if (current === null) {
          return Object.freeze({ status: "INVALID_TRANSITION" as const });
        }
        if (current.contentRevision !== input.expectedContentRevision) {
          return Object.freeze({
            currentContentRevision: current.contentRevision,
            status: "STALE_REVISION" as const,
          });
        }
        const previous = await selectSection(
          transaction,
          input.jobRequestId,
          current.contentRevision,
          section.key as JobRequestContentSectionKey,
        );
        const classification = classifyJobRequestChange(
          previous ??
            defaultSection(section.key as JobRequestContentSectionKey),
          section,
        );
        const resultKind = classification.changed ? "APPLIED" : "UNCHANGED";
        const resultingContentRevision = classification.changed
          ? current.contentRevision + 1
          : current.contentRevision;
        const resultingVisibleVersion =
          current.visibleVersion + (classification.material ? 1 : 0);
        await insertCommand(transaction, {
          actorUserId: input.actorUserId,
          commandId: input.commandId,
          customerProfileId,
          expectedContentRevision: input.expectedContentRevision,
          intentFingerprint,
          jobRequestId: input.jobRequestId,
          material: classification.material,
          categories: classification.categories,
          resultKind,
          resultingContentRevision,
          resultingVisibleVersion,
          section,
          sectionFingerprint,
        });
        if (classification.changed) {
          await transaction`
            INSERT INTO job_request_active_content_revisions (
              job_request_id, content_revision, visible_version,
              source_request_revision, command_id, material_change,
              change_categories, changed_at
            ) VALUES (
              ${input.jobRequestId}, ${resultingContentRevision},
              ${resultingVisibleVersion}, ${current.sourceRequestRevision},
              ${input.commandId}, ${classification.material},
              ${classification.categories}, clock_timestamp()
            )
          `;
          await transaction`
            INSERT INTO job_request_active_section_revisions (
              job_request_id, content_revision, command_id, section_key,
              section_schema_version, payload, payload_fingerprint, saved_at
            ) VALUES (
              ${input.jobRequestId}, ${resultingContentRevision},
              ${input.commandId}, ${section.key}, ${section.schemaVersion},
              ${transaction.json(section.payload as never)}, ${sectionFingerprint},
              clock_timestamp()
            )
          `;
        }
        const version = await selectVersion(
          transaction,
          input.jobRequestId,
          resultingContentRevision,
        );
        if (version === null) throw new Error("Active version effect missing.");
        return Object.freeze({ status: resultKind, version });
      });
    },
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

async function lockOwnedActiveRequest(
  sql: TransactionSql,
  jobRequestId: JobRequestId,
  customerProfileId: CustomerProfileId,
): Promise<boolean> {
  const rows = await sql`
    SELECT request.id
    FROM job_requests request
    JOIN current_job_requests current ON current.id = request.id
    WHERE request.id = ${jobRequestId}
      AND request.customer_profile_id = ${customerProfileId}
      AND current.state = 'ACTIVE'
    FOR UPDATE OF request
  `;
  return rows.length === 1;
}

async function lockCommand(
  sql: TransactionSql,
  commandId: string,
): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${commandId}, 39005))`;
}

async function replayCommand(
  sql: TransactionSql,
  input: {
    readonly actorUserId: UserId;
    readonly commandId: string;
    readonly customerProfileId: CustomerProfileId;
    readonly intentFingerprint: string;
    readonly jobRequestId: JobRequestId;
    readonly section: JobRequestContentSection;
    readonly sectionFingerprint: string;
  },
): Promise<ReviseActiveJobRequestResult | null> {
  const [row] = await sql<CommandRow[]>`
    SELECT actor_user_id AS "actorUserId",
      customer_profile_id AS "customerProfileId",
      intent_fingerprint AS "intentFingerprint",
      job_request_id AS "jobRequestId", result_kind AS "resultKind",
      resulting_content_revision AS "resultingContentRevision",
      section_key AS "sectionKey",
      section_payload_fingerprint AS "sectionPayloadFingerprint",
      section_schema_version AS "sectionSchemaVersion"
    FROM job_request_active_edit_commands WHERE command_id = ${input.commandId}
  `;
  if (row === undefined) return null;
  if (
    row.actorUserId !== input.actorUserId ||
    row.customerProfileId !== input.customerProfileId ||
    row.intentFingerprint !== input.intentFingerprint ||
    row.jobRequestId !== input.jobRequestId ||
    row.sectionKey !== input.section.key ||
    row.sectionPayloadFingerprint !== input.sectionFingerprint ||
    row.sectionSchemaVersion !== input.section.schemaVersion
  ) {
    throw new JobRequestVersionIdempotencyError(
      "Active job request command id was reused for another intent.",
    );
  }
  const version = await selectVersion(
    sql,
    input.jobRequestId,
    row.resultingContentRevision,
  );
  if (version === null) throw new Error("Active edit replay effect missing.");
  return Object.freeze({ status: "DEDUPLICATED" as const, version });
}

async function insertCommand(
  sql: TransactionSql,
  input: {
    readonly actorUserId: UserId;
    readonly commandId: string;
    readonly customerProfileId: CustomerProfileId;
    readonly expectedContentRevision: number;
    readonly intentFingerprint: string;
    readonly jobRequestId: JobRequestId;
    readonly material: boolean;
    readonly categories: readonly JobRequestMaterialChangeCategory[];
    readonly resultKind: "APPLIED" | "UNCHANGED";
    readonly resultingContentRevision: number;
    readonly resultingVisibleVersion: number;
    readonly section: JobRequestContentSection;
    readonly sectionFingerprint: string;
  },
): Promise<void> {
  await sql`
    INSERT INTO job_request_active_edit_commands (
      command_id, job_request_id, customer_profile_id, actor_user_id,
      expected_content_revision, resulting_content_revision,
      resulting_visible_version, section_key, section_schema_version,
      section_payload, section_payload_fingerprint, intent_fingerprint,
      result_kind, material_change, change_categories
    ) VALUES (
      ${input.commandId}, ${input.jobRequestId}, ${input.customerProfileId},
      ${input.actorUserId}, ${input.expectedContentRevision},
      ${input.resultingContentRevision}, ${input.resultingVisibleVersion},
      ${input.section.key}, ${input.section.schemaVersion},
      ${sql.json(input.section.payload as never)}, ${input.sectionFingerprint},
      ${input.intentFingerprint}, ${input.resultKind}, ${input.material},
      ${input.categories}
    )
  `;
}

async function selectVersionForUpdate(
  sql: TransactionSql,
  jobRequestId: JobRequestId,
): Promise<(VersionRow & { readonly sourceRequestRevision: number }) | null> {
  const [row] = await sql<
    Array<VersionRow & { readonly sourceRequestRevision: number }>
  >`
    SELECT job_request_id AS "jobRequestId",
      content_revision AS "contentRevision", visible_version AS "visibleVersion",
      source_request_revision AS "sourceRequestRevision",
      material_change AS material, change_categories AS categories,
      changed_at AS "changedAt"
    FROM job_request_active_content_revisions
    WHERE job_request_id = ${jobRequestId}
    ORDER BY content_revision DESC LIMIT 1 FOR UPDATE
  `;
  return row ?? null;
}

async function selectVersion(
  sql: TransactionSql,
  jobRequestId: JobRequestId,
  contentRevision: number,
): Promise<JobRequestActiveContentVersion | null> {
  const [row] = await sql<VersionRow[]>`
    SELECT job_request_id AS "jobRequestId",
      content_revision AS "contentRevision", visible_version AS "visibleVersion",
      material_change AS material, change_categories AS categories,
      changed_at AS "changedAt"
    FROM job_request_active_content_revisions
    WHERE job_request_id = ${jobRequestId}
      AND content_revision = ${contentRevision}
  `;
  return row === undefined ? null : toVersion(row);
}

async function selectSnapshot(
  sql: TransactionSql,
  jobRequestId: JobRequestId,
  requestedRevision?: number,
): Promise<JobRequestActiveContentSnapshot | null> {
  const versionRows =
    requestedRevision === undefined
      ? await sql<VersionRow[]>`
          SELECT job_request_id AS "jobRequestId",
            content_revision AS "contentRevision",
            visible_version AS "visibleVersion",
            material_change AS material, change_categories AS categories,
            changed_at AS "changedAt"
          FROM job_request_active_content_revisions
          WHERE job_request_id = ${jobRequestId}
          ORDER BY content_revision DESC LIMIT 1
        `
      : await sql<VersionRow[]>`
          SELECT job_request_id AS "jobRequestId",
            content_revision AS "contentRevision",
            visible_version AS "visibleVersion",
            material_change AS material, change_categories AS categories,
            changed_at AS "changedAt"
          FROM job_request_active_content_revisions
          WHERE job_request_id = ${jobRequestId}
            AND content_revision = ${requestedRevision}
          LIMIT 1
        `;
  const [versionRow] = versionRows;
  if (versionRow === undefined) return null;
  const sectionRows = await sql<SectionRow[]>`
    SELECT DISTINCT ON (section_key) section_key AS "sectionKey",
      section_schema_version AS "sectionSchemaVersion", payload,
      payload_fingerprint AS "payloadFingerprint"
    FROM job_request_active_section_revisions
    WHERE job_request_id = ${jobRequestId}
      AND content_revision <= ${versionRow.contentRevision}
    ORDER BY section_key, content_revision DESC
  `;
  return Object.freeze({
    sections: Object.freeze(sectionRows.map(toSection)),
    version: toVersion(versionRow),
  });
}

async function selectSection(
  sql: TransactionSql,
  jobRequestId: JobRequestId,
  contentRevision: number,
  sectionKey: JobRequestContentSectionKey,
): Promise<JobRequestContentSection | null> {
  const [row] = await sql<SectionRow[]>`
    SELECT section_key AS "sectionKey",
      section_schema_version AS "sectionSchemaVersion", payload,
      payload_fingerprint AS "payloadFingerprint"
    FROM job_request_active_section_revisions
    WHERE job_request_id = ${jobRequestId} AND section_key = ${sectionKey}
      AND content_revision <= ${contentRevision}
    ORDER BY content_revision DESC LIMIT 1
  `;
  return row === undefined ? null : toNormalizedSection(row);
}

function toVersion(row: VersionRow): JobRequestActiveContentVersion {
  assertUuid(row.jobRequestId, "jobRequestId");
  const categories = row.categories.map((value) => {
    const category = JOB_REQUEST_MATERIAL_CHANGE_CATEGORIES.find(
      (candidate) => candidate === value,
    );
    if (category === undefined) throw new Error("Corrupt change category.");
    return category;
  });
  if (
    !Number.isSafeInteger(row.contentRevision) ||
    row.contentRevision < 1 ||
    !Number.isSafeInteger(row.visibleVersion) ||
    row.visibleVersion < 1 ||
    !(row.changedAt instanceof Date) ||
    !Number.isFinite(row.changedAt.getTime()) ||
    row.material !== categories.length > 0
  ) {
    throw new Error("Corrupt active job request version.");
  }
  return Object.freeze({
    categories: Object.freeze(categories),
    changedAt: new Date(row.changedAt.getTime()),
    contentRevision: row.contentRevision,
    jobRequestId: row.jobRequestId as JobRequestId,
    material: row.material,
    visibleVersion: row.visibleVersion,
  });
}

function toSection(row: SectionRow) {
  const normalized = toNormalizedSection(row);
  return Object.freeze({
    key: normalized.key as JobRequestContentSectionKey,
    payload: normalized.payload,
    schemaVersion: normalized.schemaVersion,
  });
}

function toNormalizedSection(row: SectionRow): JobRequestContentSection {
  const section = normalizeJobRequestContentSection({
    key: row.sectionKey,
    payload: row.payload,
    schemaVersion: row.sectionSchemaVersion,
  });
  if (sha256(section.canonicalPayload) !== row.payloadFingerprint) {
    throw new Error("Corrupt active section fingerprint.");
  }
  return section;
}

function validateSection(
  section: PersistReviseActiveJobRequestInput["section"],
): JobRequestContentSection {
  const normalized = normalizeJobRequestContentSection(section);
  if (normalized.canonicalPayload !== section.canonicalPayload) {
    throw new TypeError("Active section canonical payload mismatch.");
  }
  return normalized;
}

function defaultSection(key: JobRequestContentSectionKey) {
  const payloads = {
    "request.budget": {
      currency: "EUR",
      maximumAmountCents: null,
      minimumAmountCents: null,
      mode: null,
    },
    "request.core": {
      description: null,
      primaryProfessionCode: null,
      relatedProfessionCodes: [],
      skillCodes: [],
      specializationCode: null,
      title: null,
    },
    "request.details": {
      approximateQuantity: null,
      customRequirements: null,
      materialResponsibility: null,
      siteInspection: null,
    },
    "request.location": {
      exactAddress: null,
      mapPin: null,
      municipalityCode: null,
      textClarification: null,
    },
    "request.media": { documentMediaAssetIds: [], photoMediaAssetIds: [] },
    "request.timing": {
      completionDeadline: null,
      endsOn: null,
      mode: null,
      startsOn: null,
    },
  } as const;
  return normalizeJobRequestContentSection({
    key,
    payload: payloads[key],
    schemaVersion: 1,
  });
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
