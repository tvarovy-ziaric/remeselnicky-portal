import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  char,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import {
  CONSENT_ACTION_VALUES,
  OPTIONAL_CONSENT_PURPOSE_VALUES,
  PRIVACY_DATA_DISPOSITION_VALUES,
  PRIVACY_DISPOSITION_STATE_VALUES,
  PRIVACY_POLICY_KIND_VALUES,
  PRIVACY_REQUEST_STATE_VALUES,
  PRIVACY_REQUEST_TYPE_VALUES,
  PRIVACY_REVIEW_STATE_VALUES,
  RETENTION_CATEGORY_VALUES,
  RETENTION_LAUNCH_STATE_VALUES,
} from "@portal/privacy";

import { auditEvents } from "./audit.js";
import { users } from "./user.js";

export const privacyPolicyKindEnum = pgEnum(
  "privacy_policy_kind",
  PRIVACY_POLICY_KIND_VALUES,
);
export const privacyReviewStateEnum = pgEnum(
  "privacy_review_state",
  PRIVACY_REVIEW_STATE_VALUES,
);
export const privacyOptionalConsentPurposeEnum = pgEnum(
  "privacy_optional_consent_purpose",
  OPTIONAL_CONSENT_PURPOSE_VALUES,
);
export const privacyConsentActionEnum = pgEnum(
  "privacy_consent_action",
  CONSENT_ACTION_VALUES,
);
export const privacyRetentionCategoryEnum = pgEnum(
  "privacy_retention_category",
  RETENTION_CATEGORY_VALUES,
);
export const privacyRetentionLaunchStateEnum = pgEnum(
  "privacy_retention_launch_state",
  RETENTION_LAUNCH_STATE_VALUES,
);
export const privacyRequestTypeEnum = pgEnum(
  "privacy_request_type",
  PRIVACY_REQUEST_TYPE_VALUES,
);
export const privacyRequestStateEnum = pgEnum(
  "privacy_request_state",
  PRIVACY_REQUEST_STATE_VALUES,
);
export const privacyDataDispositionEnum = pgEnum(
  "privacy_data_disposition",
  PRIVACY_DATA_DISPOSITION_VALUES,
);
export const privacyDispositionStateEnum = pgEnum(
  "privacy_disposition_state",
  PRIVACY_DISPOSITION_STATE_VALUES,
);
export const privacyDispositionJobStateEnum = pgEnum(
  "privacy_disposition_job_state",
  ["PENDING", "PROCESSING", "SUCCEEDED", "TERMINAL"],
);
export const privacyDispositionJobTerminalReasonEnum = pgEnum(
  "privacy_disposition_job_terminal_reason",
  ["NON_RETRYABLE", "RETRIES_EXHAUSTED"],
);

export const privacyPolicyVersions = pgTable(
  "privacy_policy_versions",
  {
    policyVersionId: uuid("policy_version_id").primaryKey(),
    policyKind: privacyPolicyKindEnum("policy_kind").notNull(),
    optionalConsentPurpose: privacyOptionalConsentPurposeEnum(
      "optional_consent_purpose",
    ),
    versionLabel: text("version_label").notNull(),
    contentSha256: char("content_sha256", { length: 64 }).notNull(),
    reviewState: privacyReviewStateEnum("review_state").notNull(),
    effectiveAt: timestamp("effective_at", {
      mode: "date",
      withTimezone: true,
    }),
    supersedesPolicyVersionId: uuid("supersedes_policy_version_id"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("privacy_policy_versions_kind_label_unique").on(
      table.policyKind,
      table.versionLabel,
    ),
    check(
      "privacy_policy_versions_hash_safe",
      sql`${table.contentSha256} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const privacyConsentPurposes = pgTable("privacy_consent_purposes", {
  purpose: privacyOptionalConsentPurposeEnum("purpose").primaryKey(),
  purposeCode: text("purpose_code").notNull().unique(),
  isGenuinelyOptional: boolean("is_genuinely_optional").notNull().default(true),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const privacyConsentEvents = pgTable(
  "privacy_consent_events",
  {
    eventId: uuid("event_id").primaryKey(),
    correlationId: uuid("correlation_id").notNull(),
    subjectUserId: uuid("subject_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    purpose: privacyOptionalConsentPurposeEnum("purpose").notNull(),
    action: privacyConsentActionEnum("action").notNull(),
    policyVersionId: uuid("policy_version_id")
      .notNull()
      .references(() => privacyPolicyVersions.policyVersionId, {
        onDelete: "restrict",
      }),
    revision: integer("revision").notNull(),
    occurredAt: timestamp("occurred_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("privacy_consent_events_subject_purpose_revision_unique").on(
      table.subjectUserId,
      table.purpose,
      table.revision,
    ),
    index("privacy_consent_events_current_idx").on(
      table.subjectUserId,
      table.purpose,
      table.revision,
    ),
  ],
);

export const privacyRetentionPolicyVersions = pgTable(
  "privacy_retention_policy_versions",
  {
    policyVersionId: uuid("policy_version_id").primaryKey(),
    category: privacyRetentionCategoryEnum("category").notNull(),
    version: integer("version").notNull(),
    durationDays: integer("duration_days"),
    legalReviewState: privacyReviewStateEnum("legal_review_state")
      .notNull()
      .default("UNRESOLVED"),
    launchState: privacyRetentionLaunchStateEnum("launch_state")
      .notNull()
      .default("BLOCKED"),
    rationaleCode: text("rationale_code").notNull(),
    supersedesPolicyVersionId: uuid("supersedes_policy_version_id"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("privacy_retention_policy_category_version_unique").on(
      table.category,
      table.version,
    ),
    index("privacy_retention_policy_current_idx").on(
      table.category,
      table.version,
    ),
  ],
);

export const privacyRequestCases = pgTable(
  "privacy_request_cases",
  {
    caseId: uuid("case_id").primaryKey(),
    subjectUserId: uuid("subject_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    requestType: privacyRequestTypeEnum("request_type").notNull(),
    receivedAt: timestamp("received_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("privacy_request_cases_subject_idx").on(
      table.subjectUserId,
      table.receivedAt,
      table.caseId,
    ),
  ],
);

export const privacyRequestEvents = pgTable(
  "privacy_request_events",
  {
    eventId: uuid("event_id").primaryKey(),
    correlationId: uuid("correlation_id").notNull(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => privacyRequestCases.caseId, { onDelete: "restrict" }),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    revision: integer("revision").notNull(),
    state: privacyRequestStateEnum("state").notNull(),
    deadlineAt: timestamp("deadline_at", {
      mode: "date",
      withTimezone: true,
    }),
    actionCode: text("action_code"),
    occurredAt: timestamp("occurred_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("privacy_request_events_case_revision_unique").on(
      table.caseId,
      table.revision,
    ),
    index("privacy_request_events_current_idx").on(
      table.caseId,
      table.revision,
    ),
  ],
);

export const privacyAccountClosureCommands = pgTable(
  "privacy_account_closure_commands",
  {
    commandId: uuid("command_id").primaryKey(),
    caseId: uuid("case_id")
      .notNull()
      .unique()
      .references(() => privacyRequestCases.caseId, { onDelete: "restrict" }),
    subjectUserId: uuid("subject_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    actorPrivilegedSessionHash: char("actor_privileged_session_hash", {
      length: 64,
    }).notNull(),
    expectedRequestRevision: integer("expected_request_revision").notNull(),
    expectedRequestState: privacyRequestStateEnum(
      "expected_request_state",
    ).notNull(),
    resultingRequestRevision: integer("resulting_request_revision").notNull(),
    reasonCode: text("reason_code").notNull(),
    reason: text("reason").notNull(),
    payloadFingerprint: char("payload_fingerprint", { length: 64 }).notNull(),
    occurredAt: timestamp("occurred_at", {
      mode: "date",
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "privacy_account_closure_revision_step",
      sql`${table.resultingRequestRevision} = ${table.expectedRequestRevision} + 1`,
    ),
  ],
);

export const privacyRequestAdminCommands = pgTable(
  "privacy_request_admin_commands",
  {
    commandId: uuid("command_id").primaryKey(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => privacyRequestCases.caseId, { onDelete: "restrict" }),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    actorPrivilegedSessionHash: char("actor_privileged_session_hash", {
      length: 64,
    }).notNull(),
    expectedRevision: integer("expected_revision").notNull(),
    expectedState: privacyRequestStateEnum("expected_state").notNull(),
    resultingRevision: integer("resulting_revision").notNull(),
    resultingState: privacyRequestStateEnum("resulting_state").notNull(),
    actionCode: text("action_code").notNull(),
    deadlineAt: timestamp("deadline_at", {
      mode: "date",
      withTimezone: true,
    }),
    reason: text("reason").notNull(),
    payloadFingerprint: char("payload_fingerprint", { length: 64 }).notNull(),
    occurredAt: timestamp("occurred_at", {
      mode: "date",
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "privacy_request_admin_revision_step",
      sql`${table.resultingRevision} = ${table.expectedRevision} + 1`,
    ),
  ],
);

export const privacyDataDispositionEvents = pgTable(
  "privacy_data_disposition_events",
  {
    eventId: uuid("event_id").primaryKey().defaultRandom(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => privacyRequestCases.caseId, { onDelete: "restrict" }),
    category: privacyRetentionCategoryEnum("category").notNull(),
    revision: integer("revision").notNull(),
    disposition: privacyDataDispositionEnum("disposition").notNull(),
    state: privacyDispositionStateEnum("state").notNull(),
    dispositionAdminCommandId: uuid("disposition_admin_command_id")
      .unique()
      .references(() => privacyDataDispositionAdminCommands.commandId, {
        onDelete: "restrict",
      }),
    policyVersionId: uuid("policy_version_id").references(
      () => privacyRetentionPolicyVersions.policyVersionId,
      { onDelete: "restrict" },
    ),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    actorSystemReference: text("actor_system_reference"),
    dispositionJobId: uuid("disposition_job_id"),
    actionCode: text("action_code").notNull(),
    occurredAt: timestamp("occurred_at", {
      mode: "date",
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("privacy_data_disposition_case_category_revision_unique").on(
      table.caseId,
      table.category,
      table.revision,
    ),
    index("privacy_data_disposition_case_idx").on(
      table.caseId,
      table.category,
      table.revision,
    ),
  ],
);

export const privacyDataDispositionAdminCommands = pgTable(
  "privacy_data_disposition_admin_commands",
  {
    commandId: uuid("command_id").primaryKey(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => privacyRequestCases.caseId, { onDelete: "restrict" }),
    category: privacyRetentionCategoryEnum("category").notNull(),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    actorPrivilegedSessionHash: char("actor_privileged_session_hash", {
      length: 64,
    }).notNull(),
    expectedRevision: integer("expected_revision").notNull(),
    expectedDisposition: privacyDataDispositionEnum(
      "expected_disposition",
    ).notNull(),
    expectedState: privacyDispositionStateEnum("expected_state").notNull(),
    resultingRevision: integer("resulting_revision").notNull(),
    resultingDisposition: privacyDataDispositionEnum(
      "resulting_disposition",
    ).notNull(),
    resultingState: privacyDispositionStateEnum("resulting_state").notNull(),
    policyVersionId: uuid("policy_version_id")
      .notNull()
      .references(() => privacyRetentionPolicyVersions.policyVersionId, {
        onDelete: "restrict",
      }),
    actionCode: text("action_code").notNull(),
    reason: text("reason").notNull(),
    payloadFingerprint: char("payload_fingerprint", { length: 64 }).notNull(),
    auditEventId: uuid("audit_event_id")
      .notNull()
      .references(() => auditEvents.eventId, { onDelete: "restrict" }),
    occurredAt: timestamp("occurred_at", {
      mode: "date",
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("privacy_data_disposition_admin_audit_event_unique").on(
      table.auditEventId,
    ),
    check(
      "privacy_disposition_admin_revision_step",
      sql`${table.resultingRevision} = ${table.expectedRevision} + 1`,
    ),
  ],
);

export const privacyRecoveryTombstones = pgTable(
  "privacy_recovery_tombstones",
  {
    tombstoneId: uuid("tombstone_id").primaryKey(),
    sourceDispositionEventId: uuid("source_disposition_event_id")
      .notNull()
      .unique()
      .references(() => privacyDataDispositionEvents.eventId, {
        onDelete: "restrict",
      }),
    caseId: uuid("case_id")
      .notNull()
      .references(() => privacyRequestCases.caseId, { onDelete: "restrict" }),
    subjectUserId: uuid("subject_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    category: privacyRetentionCategoryEnum("category").notNull(),
    disposition: privacyDataDispositionEnum("disposition").notNull(),
    policyVersionId: uuid("policy_version_id")
      .notNull()
      .references(() => privacyRetentionPolicyVersions.policyVersionId, {
        onDelete: "restrict",
      }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

export const privacyRecoveryTombstoneReceipts = pgTable(
  "privacy_recovery_tombstone_receipts",
  {
    tombstoneId: uuid("tombstone_id")
      .primaryKey()
      .references(() => privacyRecoveryTombstones.tombstoneId, {
        onDelete: "restrict",
      }),
    ledgerCode: text("ledger_code").notNull(),
    receiptDigest: char("receipt_digest", { length: 64 }).notNull().unique(),
    acknowledgedAt: timestamp("acknowledged_at", {
      mode: "date",
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
);

export const privacyDataDispositionJobs = pgTable(
  "privacy_data_disposition_jobs",
  {
    jobId: uuid("job_id").primaryKey(),
    sourceDispositionEventId: uuid("source_disposition_event_id")
      .notNull()
      .unique()
      .references(() => privacyDataDispositionEvents.eventId, {
        onDelete: "restrict",
      }),
    tombstoneId: uuid("tombstone_id")
      .notNull()
      .unique()
      .references(() => privacyRecoveryTombstones.tombstoneId, {
        onDelete: "restrict",
      }),
    caseId: uuid("case_id")
      .notNull()
      .references(() => privacyRequestCases.caseId, { onDelete: "restrict" }),
    subjectUserId: uuid("subject_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    category: privacyRetentionCategoryEnum("category").notNull(),
    disposition: privacyDataDispositionEnum("disposition").notNull(),
    policyVersionId: uuid("policy_version_id")
      .notNull()
      .references(() => privacyRetentionPolicyVersions.policyVersionId, {
        onDelete: "restrict",
      }),
    state: privacyDispositionJobStateEnum("state").notNull().default("PENDING"),
    attemptCount: integer("attempt_count").notNull().default(0),
    failedAttemptCount: integer("failed_attempt_count").notNull().default(0),
    retryCount: integer("retry_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(10),
    availableAt: timestamp("available_at", {
      mode: "date",
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", {
      mode: "date",
      withTimezone: true,
    }),
    lastErrorCode: text("last_error_code"),
    completedAt: timestamp("completed_at", {
      mode: "date",
      withTimezone: true,
    }),
    terminalReason: privacyDispositionJobTerminalReasonEnum("terminal_reason"),
    terminalRunId: text("terminal_run_id"),
    terminalAt: timestamp("terminal_at", {
      mode: "date",
      withTimezone: true,
    }),
    enqueuedAt: timestamp("enqueued_at", {
      mode: "date",
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("privacy_disposition_jobs_claim_idx").on(
      table.availableAt,
      table.enqueuedAt,
      table.jobId,
    ),
    index("privacy_disposition_jobs_reclaim_idx").on(
      table.leaseExpiresAt,
      table.jobId,
    ),
  ],
);

export type PrivacyPolicyVersionRecord =
  typeof privacyPolicyVersions.$inferSelect;
export type PrivacyConsentPurposeRecord =
  typeof privacyConsentPurposes.$inferSelect;
export type PrivacyConsentEventRecord =
  typeof privacyConsentEvents.$inferSelect;
export type PrivacyRetentionPolicyVersionRecord =
  typeof privacyRetentionPolicyVersions.$inferSelect;
export type PrivacyRequestCaseRecord = typeof privacyRequestCases.$inferSelect;
export type PrivacyRequestEventRecord =
  typeof privacyRequestEvents.$inferSelect;
export type PrivacyAccountClosureCommandRecord =
  typeof privacyAccountClosureCommands.$inferSelect;
export type PrivacyRequestAdminCommandRecord =
  typeof privacyRequestAdminCommands.$inferSelect;
export type PrivacyDataDispositionEventRecord =
  typeof privacyDataDispositionEvents.$inferSelect;
export type PrivacyDataDispositionAdminCommandRecord =
  typeof privacyDataDispositionAdminCommands.$inferSelect;
export type PrivacyRecoveryTombstoneRecord =
  typeof privacyRecoveryTombstones.$inferSelect;
export type PrivacyRecoveryTombstoneReceiptRecord =
  typeof privacyRecoveryTombstoneReceipts.$inferSelect;
export type PrivacyDataDispositionJobRecord =
  typeof privacyDataDispositionJobs.$inferSelect;
