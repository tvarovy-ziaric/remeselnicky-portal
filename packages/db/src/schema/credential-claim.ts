import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  check,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import {
  CREDENTIAL_CLAIM_STATES,
  CREDENTIAL_EVIDENCE_REQUIREMENTS,
  CREDENTIAL_REVIEW_REASON_CATEGORIES,
} from "@portal/domain";

import { auditEvents } from "./audit.js";
import { craftsmanProfessions } from "./craftsman-profession.js";
import { craftsmanProfiles } from "./craftsman-profile.js";
import { mediaAssets, mediaKindEnum } from "./media.js";
import { users } from "./user.js";

export const CREDENTIAL_CLAIM_COMMAND_KINDS = [
  "CREATE",
  "ATTACH_EVIDENCE",
  "APPROVE",
  "REJECT",
  "REVOKE",
] as const;

export const credentialEvidenceRequirementEnum = pgEnum(
  "credential_evidence_requirement",
  CREDENTIAL_EVIDENCE_REQUIREMENTS,
);
export const credentialClaimStateEnum = pgEnum(
  "credential_claim_state",
  CREDENTIAL_CLAIM_STATES,
);
export const credentialClaimCommandKindEnum = pgEnum(
  "credential_claim_command_kind",
  CREDENTIAL_CLAIM_COMMAND_KINDS,
);
export const credentialReviewReasonCategoryEnum = pgEnum(
  "credential_review_reason_category",
  CREDENTIAL_REVIEW_REASON_CATEGORIES,
);

const timestampWithTimezone = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });

export const credentialTypePolicies = pgTable(
  "credential_type_policies",
  {
    code: text("code").primaryKey(),
    evidenceRequirement: credentialEvidenceRequirementEnum(
      "evidence_requirement",
    ).notNull(),
    active: boolean("active").notNull().default(true),
    sourceReference: text("source_reference").notNull(),
    installedAt: timestampWithTimezone("installed_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "credential_type_policy_code_safe",
      sql`length(${table.code}) BETWEEN 1 AND 64`,
    ),
  ],
);

export const credentialClaims = pgTable(
  "credential_claims",
  {
    id: uuid("id").primaryKey(),
    craftsmanProfileId: uuid("craftsman_profile_id")
      .notNull()
      .references(() => craftsmanProfiles.id, { onDelete: "restrict" }),
    craftsmanProfessionId: uuid("craftsman_profession_id")
      .notNull()
      .references(() => craftsmanProfessions.id, { onDelete: "restrict" }),
    credentialTypeCode: text("credential_type_code")
      .notNull()
      .references(() => credentialTypePolicies.code, { onDelete: "restrict" }),
    evidenceRequirement: credentialEvidenceRequirementEnum(
      "evidence_requirement",
    ).notNull(),
    expiresOn: date("expires_on"),
    state: credentialClaimStateEnum("state").notNull().default("PENDING"),
    revision: integer("revision").notNull().default(1),
    latestCommandId: uuid("latest_command_id").notNull(),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    updatedByUserId: uuid("updated_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    reviewedByUserId: uuid("reviewed_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    reviewReasonCategory: credentialReviewReasonCategoryEnum(
      "review_reason_category",
    ),
    reviewReason: text("review_reason"),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updated_at").notNull().defaultNow(),
    reviewedAt: timestampWithTimezone("reviewed_at"),
  },
  (table) => [
    index("credential_claims_owner_queue_idx").on(
      table.craftsmanProfileId,
      table.createdAt,
      table.id,
    ),
    index("credential_claims_pending_queue_idx").on(table.createdAt, table.id),
  ],
);

export const credentialClaimCommands = pgTable(
  "credential_claim_commands",
  {
    commandId: uuid("command_id").primaryKey(),
    commandKind: credentialClaimCommandKindEnum("command_kind").notNull(),
    claimId: uuid("claim_id")
      .notNull()
      .references(() => credentialClaims.id, { onDelete: "restrict" }),
    craftsmanProfileId: uuid("craftsman_profile_id")
      .notNull()
      .references(() => craftsmanProfiles.id, { onDelete: "restrict" }),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    actorPrivilegedSessionHash: char("actor_privileged_session_hash", {
      length: 64,
    }),
    expectedRevision: integer("expected_revision").notNull(),
    mediaAssetId: uuid("media_asset_id").references(() => mediaAssets.id, {
      onDelete: "restrict",
    }),
    reasonCategory: credentialReviewReasonCategoryEnum("reason_category"),
    reason: text("reason"),
    payloadFingerprint: char("payload_fingerprint", { length: 64 }).notNull(),
    auditEventId: uuid("audit_event_id").references(() => auditEvents.eventId, {
      onDelete: "restrict",
    }),
    occurredAt: timestampWithTimezone("occurred_at").notNull().defaultNow(),
  },
  (table) => [
    index("credential_claim_commands_claim_history_idx").on(
      table.claimId,
      table.occurredAt,
      table.commandId,
    ),
  ],
);

export const credentialClaimEvidence = pgTable(
  "credential_claim_evidence",
  {
    claimId: uuid("claim_id")
      .notNull()
      .references(() => credentialClaims.id, { onDelete: "restrict" }),
    mediaAssetId: uuid("media_asset_id")
      .notNull()
      .references(() => mediaAssets.id, { onDelete: "restrict" }),
    commandId: uuid("command_id")
      .notNull()
      .references(() => credentialClaimCommands.commandId, {
        onDelete: "restrict",
      }),
    attachedRevision: integer("attached_revision").notNull(),
    mediaKind: mediaKindEnum("media_kind").notNull(),
    attachedByUserId: uuid("attached_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    attachedAt: timestampWithTimezone("attached_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.claimId, table.attachedRevision] }),
    unique("credential_claim_evidence_asset_unique").on(table.mediaAssetId),
    unique("credential_claim_evidence_command_unique").on(table.commandId),
  ],
);

export const credentialClaimDecisions = pgTable(
  "credential_claim_decisions",
  {
    commandId: uuid("command_id")
      .primaryKey()
      .references(() => credentialClaimCommands.commandId, {
        onDelete: "restrict",
      }),
    claimId: uuid("claim_id")
      .notNull()
      .references(() => credentialClaims.id, { onDelete: "restrict" }),
    fromState: credentialClaimStateEnum("from_state").notNull(),
    toState: credentialClaimStateEnum("to_state").notNull(),
    revision: integer("revision").notNull(),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    reasonCategory: credentialReviewReasonCategoryEnum("reason_category"),
    reason: text("reason"),
    occurredAt: timestampWithTimezone("occurred_at").notNull().defaultNow(),
  },
  (table) => [
    unique("credential_claim_decisions_claim_revision_unique").on(
      table.claimId,
      table.revision,
    ),
  ],
);

export const credentialClaimRevisions = pgTable(
  "credential_claim_revisions",
  {
    claimId: uuid("claim_id")
      .notNull()
      .references(() => credentialClaims.id, { onDelete: "restrict" }),
    revision: integer("revision").notNull(),
    commandId: uuid("command_id")
      .notNull()
      .references(() => credentialClaimCommands.commandId, {
        onDelete: "restrict",
      }),
    craftsmanProfileId: uuid("craftsman_profile_id")
      .notNull()
      .references(() => craftsmanProfiles.id, { onDelete: "restrict" }),
    craftsmanProfessionId: uuid("craftsman_profession_id")
      .notNull()
      .references(() => craftsmanProfessions.id, { onDelete: "restrict" }),
    credentialTypeCode: text("credential_type_code").notNull(),
    evidenceRequirement: credentialEvidenceRequirementEnum(
      "evidence_requirement",
    ).notNull(),
    expiresOn: date("expires_on"),
    state: credentialClaimStateEnum("state").notNull(),
    evidenceCount: integer("evidence_count").notNull(),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    reviewedByUserId: uuid("reviewed_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    reviewReasonCategory: credentialReviewReasonCategoryEnum(
      "review_reason_category",
    ),
    reviewReason: text("review_reason"),
    createdAt: timestampWithTimezone("created_at").notNull(),
    updatedAt: timestampWithTimezone("updated_at").notNull(),
    reviewedAt: timestampWithTimezone("reviewed_at"),
    occurredAt: timestampWithTimezone("occurred_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.claimId, table.revision] }),
    unique("credential_claim_revisions_command_unique").on(table.commandId),
  ],
);

export type CredentialTypePolicyRecord =
  typeof credentialTypePolicies.$inferSelect;
export type CredentialClaimRecord = typeof credentialClaims.$inferSelect;
export type CredentialClaimCommandRecord =
  typeof credentialClaimCommands.$inferSelect;
export type CredentialClaimEvidenceRecord =
  typeof credentialClaimEvidence.$inferSelect;
export type CredentialClaimDecisionRecord =
  typeof credentialClaimDecisions.$inferSelect;
export type CredentialClaimRevisionRecord =
  typeof credentialClaimRevisions.$inferSelect;
